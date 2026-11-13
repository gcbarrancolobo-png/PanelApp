import { db } from './db';
import {
  integrityPayload, legacyRecords, sealLegacyRecords, sha256, stableStringify, uuid, validateSealedChain,
  type IntegrityLog,
} from './chain';

export type { IntegrityLog } from './chain';
export { stableStringify, verifyLocalChain } from './chain';

export type SyncIdentity = { id: string; name: string; token: string; profile: Record<string, unknown>; updatedAt: string };

export async function getDeviceId() {
  const stored = await db.settings.get('deviceId');
  if (stored?.value) return String(stored.value);
  const id = uuid();
  await db.settings.put({ key: 'deviceId', value: id });
  return id;
}

export async function getSyncIdentity(name: string, profile: Record<string, unknown>): Promise<SyncIdentity> {
  const existing = await db.syncProfiles.where('name').equals(name).first() || await db.syncProfiles.toCollection().first();
  const identity: SyncIdentity = existing || { id: uuid(), name, token: uuid(), profile: {}, updatedAt: '' };
  const suppliedDate = typeof profile.updatedAt === 'string' ? profile.updatedAt : '';
  const sameProfile = stableStringify(existing?.profile || {}) === stableStringify(profile);
  const profileIsNewer = !existing || (suppliedDate ? suppliedDate > existing.updatedAt : !sameProfile);
  const next = {
    ...identity,
    name,
    profile: profileIsNewer ? profile : (identity.profile || profile),
    updatedAt: profileIsNewer ? (suppliedDate || new Date().toISOString()) : identity.updatedAt,
  };
  await db.syncProfiles.put(next);
  return next;
}

export async function importSyncIdentity(file: File, establishmentName: string) {
  const parsed = JSON.parse(await file.text()) as Partial<SyncIdentity>;
  if (!parsed.id || !parsed.token || parsed.name !== establishmentName) {
    throw new Error('El archivo de vinculación no corresponde al nombre de este establecimiento.');
  }
  const localLogs = await db.logs.where('establishment').equals(establishmentName).toArray();
  if (localLogs.some(record => record.establishmentId && record.establishmentId !== parsed.id)) {
    throw new Error('Este equipo ya tiene una cadena propia de bitácoras. Vincúlelo antes de crear registros para conservar sus sellos.');
  }
  const current = await db.syncProfiles.get(parsed.id);
  await db.syncProfiles.clear();
  await db.syncProfiles.put({ ...current, ...parsed, name: establishmentName });
}

export async function sealExistingLogs(establishmentName: string, identity: SyncIdentity, deviceId: string) {
  const allRecords = await db.logs.toArray();
  const records = allRecords.filter(record => record.establishmentId === identity.id ||
    (!record.establishmentId && record.establishment === establishmentName));
  for (const record of records) if (record.establishment !== establishmentName) await db.logs.update(record.id, { establishment: establishmentName });

  const foreignUnsealed = records.filter(record => record.deviceId && record.deviceId !== deviceId && !record.hash);
  if (foreignUnsealed.length) throw new Error('Hay registros de otro dispositivo sin sello. Sincroniza este equipo antes de continuar.');

  const ownRecords = records.filter(record => !record.deviceId || record.deviceId === deviceId) as IntegrityLog[];
  const head = await validateSealedChain(ownRecords, identity.id, deviceId);
  const legacy = legacyRecords(ownRecords, deviceId);
  const sealed = await sealLegacyRecords(legacy, identity.id, deviceId, head.previousHash, head.chainIndex);
  for (let index = 0; index < legacy.length; index++) {
    const record = legacy[index];
    const next = sealed.sealed[index];
    await db.logs.update(record.id, { ...next, establishment: establishmentName, syncStatus: 'pending', legacySealed: true });
  }
  return { previousHash: sealed.previousHash, chainIndex: sealed.chainIndex, migrated: legacy.length };
}

export async function sealNewLog(record: Omit<IntegrityLog, 'recordId' | 'establishmentId' | 'deviceId' | 'chainIndex' | 'previousHash' | 'hash'>, identity: SyncIdentity, deviceId: string, previousHash: string | null, chainIndex: number): Promise<IntegrityLog> {
  const sealed: IntegrityLog = {
    ...record, recordId: uuid(), establishmentId: identity.id, deviceId,
    chainIndex: chainIndex + 1, previousHash, hash: '',
  };
  sealed.hash = await sha256(integrityPayload(sealed));
  return sealed;
}

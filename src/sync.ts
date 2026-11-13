import { db } from './db';
import { getDeviceId, getSyncIdentity, sealExistingLogs, stableStringify, verifyLocalChain, type IntegrityLog } from './integrity';

export async function syncEstablishment(name: string, profile: Record<string, unknown>, onProfile?: (profile: Record<string, unknown>, updatedAt: string) => void) {
  const identity = await getSyncIdentity(name, profile);
  const deviceId = await getDeviceId();
  const sealed = await sealExistingLogs(name, identity, deviceId);
  const localRecords = await db.logs.where('establishmentId').equals(identity.id).toArray();
  const byDevice = localRecords.filter(record => record.deviceId === deviceId) as IntegrityLog[];
  if (!await verifyLocalChain(byDevice)) throw new Error('La cadena local no es consistente. No se enviaron registros.');
  const pending = byDevice.filter(record => record.syncStatus !== 'synced').sort((a, b) => a.chainIndex - b.chainIndex).slice(0, 200);
  const localAudits = await db.audits.where('establishment').equals(name).toArray();
  const entities = [];
  for (const audit of localAudits) {
    const recordId = audit.recordId || crypto.randomUUID();
    const updatedAt = audit.updatedAt || audit.createdAt || new Date().toISOString();
    if (!audit.recordId || !audit.updatedAt) await db.audits.update(audit.id, { recordId, updatedAt });
    const { id: localId, ...payload } = audit;
    entities.push({ type: 'audit', key: recordId, updatedAt, payload: { ...payload, recordId } });
  }
  const accepted = new Set<string>();
  let lots: any[] = [];
  let recordsToUpload = pending;
  let entitiesToUpload = entities;
  let known = new Set(localRecords.map(record => record.recordId).filter(Boolean));
  let page = 0;
  let hasMore = true;
  let profileConflict = false;
  let entityConflicts: any[] = [];
  while (hasMore && page < 20) {
    const response = await fetch('/api/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ establishment: identity, deviceId, records: recordsToUpload, entities: entitiesToUpload, knownRecordIds: [...known] }),
      signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'No se pudo sincronizar. Los registros siguen guardados en este equipo.');
    for (const id of result.accepted || []) accepted.add(id);
    lots = result.lots || lots;
    if (Array.isArray(result.entityConflicts) && result.entityConflicts.length) entityConflicts = [...entityConflicts, ...result.entityConflicts];
    const syncedAt = new Date().toISOString();
    await db.transaction('rw', db.logs, db.syncProfiles, db.profiles, db.audits, async () => {
      for (const record of recordsToUpload) {
        if (accepted.has(record.recordId)) await db.logs.update(record.id, { syncStatus: 'synced', syncedAt });
      }
      for (const remote of result.logs || []) {
        if (!remote?.recordId || !remote.hash) continue;
        const existing = await db.logs.where('recordId').equals(remote.recordId).first();
        if (existing && existing.hash !== remote.hash) throw new Error('Un registro local y uno sincronizado tienen el mismo ID con sellos distintos.');
        if (!existing) {
          const { id: remoteId, ...payload } = remote;
          await db.logs.add({ ...payload, establishment: name, syncStatus: 'synced', syncedAt });
          known.add(remote.recordId);
        }
      }
      for (const lot of lots) {
        const lotLogs = await db.logs.where('establishmentId').equals(identity.id).filter(record => record.data?.lote === lot.code).toArray();
        for (const record of lotLogs) await db.logs.update(record.id, { publicCode: lot.public_code, syncedAt: record.syncedAt || syncedAt });
      }
      for (const entity of result.entities || []) {
        if (entity.type !== 'audit' || !entity.payload || !entity.key) continue;
        const existing = await db.audits.where('recordId').equals(entity.key).first();
        const payload = { ...entity.payload, establishment: name, updatedAt: entity.updatedAt, syncDeviceId: entity.deviceId };
        delete payload.id;
        if (!existing) await db.audits.add(payload);
        else if (entity.updatedAt > (existing.updatedAt || existing.createdAt || '') || (entity.updatedAt === (existing.updatedAt || existing.createdAt || '') && entity.deviceId > (existing.syncDeviceId || ''))) await db.audits.update(existing.id, payload);
      }
      if (result.profile && typeof result.profile === 'object' && typeof result.profileUpdatedAt === 'string') {
        const localProfileDate = typeof profile.updatedAt === 'string' ? profile.updatedAt : '';
        if (result.profileUpdatedAt > localProfileDate || (result.profileUpdatedAt === localProfileDate && result.profileDeviceId > deviceId)) {
          if (stableStringify(result.profile) !== stableStringify(profile)) profileConflict = true;
          const updated = { ...identity, profile: result.profile, updatedAt: result.profileUpdatedAt };
          await db.syncProfiles.put(updated);
          await db.profiles.put({ id: 1, ...result.profile, updatedAt: result.profileUpdatedAt });
          onProfile?.(result.profile, result.profileUpdatedAt);
        }
      }
    });
    hasMore = Boolean(result.hasMoreLogs);
    recordsToUpload = [];
    entitiesToUpload = [];
    page++;
  }
  const remaining = await db.logs.where('establishmentId').equals(identity.id).filter(record => record.deviceId === deviceId && record.syncStatus !== 'synced').count();
  return {
    syncedCount: accepted.size,
    pendingCount: remaining,
    moreRemote: hasMore,
    lots,
    migrated: sealed.migrated,
    profileConflict,
    entityConflicts,
  };
}

export function downloadLinkFile(identity: { id: string; name: string; token: string; profile?: Record<string, unknown>; updatedAt?: string }) {
  const blob = new Blob([JSON.stringify({ id: identity.id, name: identity.name, token: identity.token, profile: identity.profile, updatedAt: identity.updatedAt }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'panelapp-vinculo-privado.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadLotCsv(code: string, records: any[]) {
  const rows = [['Fecha', 'Tipo de registro', 'Lote de panela', 'Datos', 'Sello SHA-256', 'Estado de sincronización']];
  for (const record of records) {
    const details = Object.entries(record.data || {}).filter(([, value]) => value !== '' && value !== undefined)
      .map(([key, value]) => `${key}: ${String(value)}`).join(' | ');
    rows.push([record.date || '', record.type || '', code, details, record.hash || '', record.syncStatus === 'synced' ? 'Sincronizado' : 'Local']);
  }
  const csv = `\uFEFF${rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lote-${code.replace(/[^a-z0-9_-]/gi, '_')}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

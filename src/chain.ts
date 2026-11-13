export type IntegrityLog = {
  id?: number; recordId: string; establishmentId: string; deviceId: string; chainIndex: number;
  createdAt: string; date: string; type: string; data: Record<string, unknown>;
  previousId?: number | null; correctsId?: number | null; correctsRecordId?: string | null; originVoiceId?: number | null;
  previousHash: string | null; hash: string;
  syncStatus?: string; establishment?: string; legacySealed?: boolean;
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
}

export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function integrityPayload(log: IntegrityLog) {
  return {
    recordId: log.recordId, establishmentId: log.establishmentId, deviceId: log.deviceId,
    chainIndex: log.chainIndex, createdAt: log.createdAt, date: log.date, type: log.type,
    data: log.data, previousId: log.previousId ?? null, correctsId: log.correctsId ?? null, correctsRecordId: log.correctsRecordId ?? null,
    originVoiceId: log.originVoiceId ?? null, previousHash: log.previousHash ?? null,
  };
}

export async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isSealed(record: IntegrityLog) {
  return Boolean(record.hash || record.recordId || record.chainIndex);
}

function sortByChain(records: IntegrityLog[]) {
  return [...records].sort((a, b) => Number(a.chainIndex) - Number(b.chainIndex) || Number(a.id) - Number(b.id));
}

function sortByCreatedAt(records: IntegrityLog[]) {
  return [...records].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || Number(a.id) - Number(b.id));
}

export async function validateSealedChain(records: IntegrityLog[], establishmentId: string, deviceId: string) {
  const sealed = sortByChain(records.filter(isSealed));
  let previousHash: string | null = null;
  let chainIndex = 0;
  for (const record of sealed) {
    if (!record.hash || !record.recordId || !record.chainIndex) throw new Error('Un registro tiene un sello incompleto y requiere revisión.');
    if (record.establishmentId !== establishmentId || record.deviceId !== deviceId) {
      throw new Error('Un registro sellado pertenece a otro dispositivo y no puede continuar esta cadena.');
    }
    if (record.chainIndex !== chainIndex + 1 || (record.previousHash ?? null) !== previousHash) {
      throw new Error('La cadena local de sellos tiene un salto. No se modificó ningún registro.');
    }
    if (await sha256(integrityPayload(record)) !== record.hash) {
      throw new Error('Un sello local no coincide con su contenido. Revise el registro antes de sincronizar.');
    }
    previousHash = record.hash;
    chainIndex = record.chainIndex;
  }
  return { previousHash, chainIndex };
}

export function legacyRecords(records: IntegrityLog[], deviceId: string) {
  return sortByCreatedAt(records.filter(record => (!record.deviceId || record.deviceId === deviceId) && !isSealed(record)));
}

export async function sealLegacyRecords(records: IntegrityLog[], establishmentId: string, deviceId: string, previousHash: string | null, chainIndex: number) {
  const sealed: IntegrityLog[] = [];
  let headHash = previousHash;
  let headIndex = chainIndex;
  for (const record of records) {
    const next: IntegrityLog = {
      ...record, recordId: uuid(), establishmentId, deviceId,
      chainIndex: headIndex + 1, previousHash: headHash, hash: '',
    };
    next.hash = await sha256(integrityPayload(next));
    sealed.push(next);
    headHash = next.hash;
    headIndex = next.chainIndex;
  }
  return { sealed, previousHash: headHash, chainIndex: headIndex };
}

export async function verifyLocalChain(records: IntegrityLog[]) {
  const sorted = sortByChain(records);
  let previousHash: string | null = null;
  for (let index = 0; index < sorted.length; index++) {
    const record = sorted[index];
    if (record.chainIndex !== index + 1 || record.previousHash !== previousHash || await sha256(integrityPayload(record)) !== record.hash) return false;
    previousHash = record.hash;
  }
  return true;
}

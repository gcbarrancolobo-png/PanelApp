import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'data');
await mkdir(dataDir, { recursive: true });

const remoteUrl = (process.env.PANELAPP_DB_URL || '').trim();
const authToken = (process.env.PANELAPP_DB_AUTH_TOKEN || '').trim();
const isRemote = Boolean(remoteUrl);

let database;
if (isRemote) {
  database = createClient({ url: remoteUrl, authToken: authToken || undefined });
} else {
  const dbPath = resolve(process.env.PANELAPP_DB_PATH || resolve(dataDir, 'panelapp.sqlite'));
  await mkdir(dirname(dbPath), { recursive: true });
  database = createClient({ url: pathToFileURL(dbPath).href });
  for (const pragma of ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON']) {
    try { await database.execute(pragma); } catch (error) { console.warn(`No se pudo aplicar ${pragma}:`, error.message); }
  }
}

await database.batch([
  `CREATE TABLE IF NOT EXISTS establishments (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
    profile_json TEXT NOT NULL DEFAULT '{}', profile_updated_at TEXT NOT NULL DEFAULT '', profile_device_id TEXT NOT NULL DEFAULT '',
    checkpoint_payload TEXT NOT NULL DEFAULT '[]', checkpoint_signature TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS log_records (
    record_id TEXT PRIMARY KEY, establishment_id TEXT NOT NULL REFERENCES establishments(id),
    device_id TEXT NOT NULL, chain_index INTEGER NOT NULL, hash TEXT NOT NULL,
    previous_hash TEXT, payload_json TEXT NOT NULL, synced_at TEXT NOT NULL,
    UNIQUE(establishment_id, device_id, chain_index)
  )`,
  'CREATE INDEX IF NOT EXISTS log_records_establishment ON log_records(establishment_id)',
  `CREATE TABLE IF NOT EXISTS lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, establishment_id TEXT NOT NULL REFERENCES establishments(id),
    code TEXT NOT NULL, public_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    UNIQUE(establishment_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS synced_entities (
    establishment_id TEXT NOT NULL REFERENCES establishments(id), entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY(establishment_id,entity_type,entity_key)
  )`,
  `CREATE TABLE IF NOT EXISTS pending_references (
    target_record_id TEXT PRIMARY KEY, establishment_id TEXT NOT NULL REFERENCES establishments(id),
    source_record_id TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
], 'write');
try { await database.execute("ALTER TABLE establishments ADD COLUMN profile_device_id TEXT NOT NULL DEFAULT ''"); } catch {}

const privateKeyPath = process.env.PANELAPP_SIGNING_KEY_PATH || resolve(dataDir, '.panelapp-signing-private.pem');

async function loadSigningKey() {
  const envKey = (process.env.PANELAPP_SIGNING_KEY || '').trim();
  if (envKey) return createPrivateKey(envKey.replace(/\\n/g, '\n'));
  if (!isRemote) {
    try { return createPrivateKey(await readFile(privateKeyPath)); } catch {}
  }
  const stored = (await database.execute({ sql: 'SELECT value FROM app_settings WHERE key = ?', args: ['signing_private_key'] })).rows[0];
  if (stored?.value) return createPrivateKey(String(stored.value));
  const pair = generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await database.execute({
    sql: 'INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
    args: ['signing_private_key', pem, new Date().toISOString()],
  });
  const persisted = (await database.execute({ sql: 'SELECT value FROM app_settings WHERE key = ?', args: ['signing_private_key'] })).rows[0]?.value;
  if (!isRemote) await writeFile(privateKeyPath, pem, { flag: 'wx' }).catch(() => {});
  return createPrivateKey(String(persisted || pem));
}

const signingPrivateKey = await loadSigningKey();
const signingPublicKey = createPublicKey(signingPrivateKey);

async function all(executor, sql, args = []) {
  return (await executor.execute({ sql, args })).rows;
}
async function get(executor, sql, args = []) {
  return (await executor.execute({ sql, args })).rows[0];
}
async function run(executor, sql, args = []) {
  return executor.execute({ sql, args });
}

function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? 'null' : stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
function digest(value) { return createHash('sha256').update(stableStringify(value)).digest('hex'); }
function tokenDigest(token) { return createHash('sha256').update(String(token)).digest('hex'); }
const logTypes = new Set(['cosecha', 'molienda', 'limpieza', 'plagas', 'tanque_agua', 'capacitacion', 'analisis_agua', 'analisis_laboratorio', 'mantenimiento', 'despacho', 'insumos_agricolas']);
const uuidPattern = /^[a-f0-9-]{20,80}$/i;
const hashPattern = /^[a-f0-9]{64}$/i;
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isUuid(value) { return typeof value === 'string' && uuidPattern.test(value); }
function isHash(value) { return typeof value === 'string' && hashPattern.test(value); }
function isIsoDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value); }
function isDateTime(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function payloadFor(record) {
  return {
    recordId: record.recordId, establishmentId: record.establishmentId, deviceId: record.deviceId,
    chainIndex: record.chainIndex, createdAt: record.createdAt, date: record.date, type: record.type,
    data: record.data, previousId: record.previousId ?? null, correctsId: record.correctsId ?? null, correctsRecordId: record.correctsRecordId ?? null,
    originVoiceId: record.originVoiceId ?? null, previousHash: record.previousHash ?? null,
  };
}
function recordFromRow(row) { return JSON.parse(row.payload_json); }
async function checkpointFor(establishmentId, executor) {
  const rows = await all(executor, 'SELECT device_id, chain_index, hash FROM log_records WHERE establishment_id = ? ORDER BY device_id, chain_index DESC', [establishmentId]);
  const seen = new Set();
  const heads = rows.filter(row => !seen.has(row.device_id) && seen.add(row.device_id)).map(row => ({ deviceId: row.device_id, chainIndex: row.chain_index, hash: row.hash }));
  const payload = stableStringify(heads);
  const signature = sign(null, Buffer.from(payload), signingPrivateKey).toString('base64');
  await run(executor, 'UPDATE establishments SET checkpoint_payload = ?, checkpoint_signature = ?, updated_at = ? WHERE id = ?', [payload, signature, new Date().toISOString(), establishmentId]);
  return { payload, signature };
}

export async function syncRecords(input) {
  const establishment = input?.establishment;
  const deviceId = input?.deviceId;
  const records = Array.isArray(input?.records) ? input.records : [];
  const entities = Array.isArray(input?.entities) ? input.entities : [];
  const knownRecordIds = new Set(Array.isArray(input?.knownRecordIds) ? input.knownRecordIds.filter(value => typeof value === 'string').slice(0, 20_000) : []);
  if (!establishment || typeof establishment.id !== 'string' || typeof establishment.name !== 'string' ||
      typeof establishment.token !== 'string' || establishment.token.length < 20 || typeof deviceId !== 'string' ||
      !/^[a-f0-9-]{20,80}$/i.test(establishment.id) || !/^[a-f0-9-]{20,80}$/i.test(deviceId) || records.length > 200 || entities.length > 500) {
    return { status: 400, body: { error: 'Datos de sincronización incompletos o inválidos.' } };
  }
  const id = establishment.id;
  const now = new Date().toISOString();
  const tokenHash = tokenDigest(establishment.token);
  const current = await get(database, 'SELECT * FROM establishments WHERE id = ?', [id]);
  if (current && current.token_hash !== tokenHash) return { status: 403, body: { error: 'El código de vinculación no es válido para este establecimiento.' } };
  const incomingProfileDate = String(establishment.updatedAt || '');
  const incomingProfileObject = establishment.profile && typeof establishment.profile === 'object' ? establishment.profile : {};
  const incomingProfile = JSON.stringify(incomingProfileObject);
  const incomingProfileStable = stableStringify(incomingProfileObject);
  const accepted = [];
  const conflicts = [];
  const entityConflicts = [];
  let profileConflict = false;
  let profileResolution = 'none';
  let tx;
  try {
    tx = await database.transaction('write');
    if (!current) {
      await run(tx, 'INSERT INTO establishments (id,name,token_hash,profile_json,profile_updated_at,profile_device_id,updated_at) VALUES (?,?,?,?,?,?,?)',
        [id, establishment.name.slice(0, 180), tokenHash, incomingProfile, incomingProfileDate, deviceId, now]);
      profileResolution = 'client';
    } else if (incomingProfileDate > current.profile_updated_at || (incomingProfileDate === current.profile_updated_at && deviceId > (current.profile_device_id || ''))) {
      await run(tx, 'UPDATE establishments SET name=?,profile_json=?,profile_updated_at=?,profile_device_id=?,updated_at=? WHERE id=?',
        [establishment.name.slice(0, 180), incomingProfile, incomingProfileDate, deviceId, now, id]);
      profileResolution = 'client';
    } else if (incomingProfileStable !== stableStringify(JSON.parse(current.profile_json))) {
      profileConflict = true;
      profileResolution = 'server';
    }
    records.sort((a, b) => Number(a.chainIndex) - Number(b.chainIndex));
    for (const record of records) {
      const duplicate = await get(tx, 'SELECT hash, establishment_id FROM log_records WHERE record_id = ?', [record.recordId]);
      if (duplicate) {
        if (duplicate.establishment_id !== id) throw new Error('El identificador del registro ya existe en otro establecimiento.');
        if (duplicate.hash !== record.hash) throw new Error('Un identificador ya sincronizado trae otro sello.');
        accepted.push(record.recordId);
        continue;
      }
      if (!isPlainObject(record.data) || !isIsoDate(record.date) || !isDateTime(record.createdAt) || !logTypes.has(record.type)) {
        throw new Error('Un registro tiene un tipo, fecha o contenido inválido.');
      }
      if (record.establishmentId !== id || record.deviceId !== deviceId || !Number.isInteger(record.chainIndex) ||
          record.chainIndex < 1 || !isUuid(record.recordId) ||
          !isHash(record.hash) || (record.previousHash !== null && !isHash(record.previousHash))) {
        throw new Error('Un registro tiene campos o sello inválidos.');
      }
      if (record.correctsRecordId !== undefined && record.correctsRecordId !== null) {
        if (!isUuid(record.correctsRecordId) || record.correctsRecordId === record.recordId) {
          throw new Error('La corrección apunta a un identificador inválido.');
        }
        const corrected = await get(tx, 'SELECT establishment_id FROM log_records WHERE record_id=?', [record.correctsRecordId]);
        if (corrected && corrected.establishment_id !== id) throw new Error('La corrección apunta a un registro de otro establecimiento.');
        if (!corrected) {
          const pending = await get(tx, 'SELECT establishment_id,source_record_id FROM pending_references WHERE target_record_id=?', [record.correctsRecordId]);
          if (pending && pending.establishment_id !== id) throw new Error('La corrección apunta a un registro pendiente de otro establecimiento.');
          if (!pending) await run(tx, 'INSERT OR IGNORE INTO pending_references (target_record_id,establishment_id,source_record_id,created_at) VALUES (?,?,?,?)', [record.correctsRecordId, id, record.recordId, now]);
        }
      }
      const pendingReference = await get(tx, 'SELECT establishment_id,source_record_id FROM pending_references WHERE target_record_id=?', [record.recordId]);
      if (pendingReference && pendingReference.establishment_id !== id) throw new Error('Un registro pendiente de corrección pertenece a otro establecimiento.');
      if (pendingReference) await run(tx, 'DELETE FROM pending_references WHERE target_record_id=?', [record.recordId]);
      const head = await get(tx, 'SELECT chain_index, hash FROM log_records WHERE establishment_id = ? AND device_id = ? ORDER BY chain_index DESC LIMIT 1', [id, deviceId]);
      const expectedIndex = (head?.chain_index || 0) + 1;
      const expectedPrevious = head?.hash || null;
      if (record.chainIndex !== expectedIndex || (record.previousHash ?? null) !== expectedPrevious) {
        conflicts.push({ recordId: record.recordId, expectedChainIndex: expectedIndex });
        throw Object.assign(new Error('La cadena llegó incompleta o fuera de orden. Sincroniza primero los registros pendientes anteriores.'), { status: 409 });
      }
      if (digest(payloadFor(record)) !== record.hash) throw new Error('El sello de un registro no coincide con su contenido.');
      await run(tx, `INSERT INTO log_records
        (record_id,establishment_id,device_id,chain_index,hash,previous_hash,payload_json,synced_at) VALUES (?,?,?,?,?,?,?,?)`,
        [record.recordId, id, deviceId, record.chainIndex, record.hash, record.previousHash, JSON.stringify(record), now]);
      accepted.push(record.recordId);
      if (record.type === 'molienda' && typeof record.data?.lote === 'string' && record.data.lote.trim()) {
        await run(tx, 'INSERT OR IGNORE INTO lots (establishment_id,code,public_code,created_at) VALUES (?,?,?,?)',
          [id, record.data.lote.trim().slice(0, 100), cryptoRandomId(), record.createdAt || now]);
      }
    }
    for (const entity of entities) {
      if (!entity || typeof entity.type !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(entity.type) ||
          typeof entity.key !== 'string' || !entity.key || entity.key.length > 160 ||
          typeof entity.updatedAt !== 'string' || !entity.payload || typeof entity.payload !== 'object') {
        throw new Error('Un cambio sincronizable tiene campos inválidos.');
      }
      const existing = await get(tx, 'SELECT updated_at,device_id,payload_json FROM synced_entities WHERE establishment_id=? AND entity_type=? AND entity_key=?', [id, entity.type, entity.key]);
      if (!existing || entity.updatedAt > existing.updated_at || (entity.updatedAt === existing.updated_at && deviceId > existing.device_id)) {
        await run(tx, `INSERT INTO synced_entities (establishment_id,entity_type,entity_key,updated_at,device_id,payload_json)
          VALUES (?,?,?,?,?,?) ON CONFLICT(establishment_id,entity_type,entity_key) DO UPDATE SET
          updated_at=excluded.updated_at,device_id=excluded.device_id,payload_json=excluded.payload_json
          WHERE excluded.updated_at > synced_entities.updated_at OR
          (excluded.updated_at = synced_entities.updated_at AND excluded.device_id > synced_entities.device_id)`,
          [id, entity.type, entity.key, entity.updatedAt, deviceId, JSON.stringify(entity.payload)]);
      } else if (stableStringify(entity.payload) !== stableStringify(JSON.parse(existing.payload_json))) {
        entityConflicts.push({ type: entity.type, key: entity.key, serverUpdatedAt: existing.updated_at, serverDeviceId: existing.device_id });
      }
    }
    const stored = await get(tx, 'SELECT profile_json, profile_updated_at, profile_device_id FROM establishments WHERE id=?', [id]);
    const checkpoint = await checkpointFor(id, tx);
    await tx.commit();
    const lots = await all(database, 'SELECT code,public_code FROM lots WHERE establishment_id=? ORDER BY created_at DESC', [id]);
    const syncedEntities = (await all(database, 'SELECT entity_type,entity_key,updated_at,device_id,payload_json FROM synced_entities WHERE establishment_id=?', [id]))
      .map(entity => ({ type: entity.entity_type, key: entity.entity_key, updatedAt: entity.updated_at, deviceId: entity.device_id, payload: JSON.parse(entity.payload_json) }));
    const allLogs = (await all(database, 'SELECT * FROM log_records WHERE establishment_id=? ORDER BY device_id,chain_index', [id])).map(recordFromRow);
    const missingLogs = allLogs.filter(record => !knownRecordIds.has(record.recordId));
    const pendingCorrections = (await all(database, 'SELECT target_record_id FROM pending_references WHERE establishment_id=? ORDER BY created_at', [id])).map(row => row.target_record_id);
    return { status: 200, body: {
      accepted, conflicts, profile: JSON.parse(stored.profile_json), profileUpdatedAt: stored.profile_updated_at, profileDeviceId: stored.profile_device_id,
      profileConflict, profileResolution, entityConflicts, pendingCorrections,
      entities: syncedEntities, logs: missingLogs.slice(0, 500), hasMoreLogs: missingLogs.length > 500,
      lots, checkpoint,
    } };
  } catch (error) {
    if (tx) { try { await tx.rollback(); } catch {} }
    return { status: error.status || 400, body: { error: error.message || 'No se pudo guardar la sincronización.', conflicts, entityConflicts } };
  }
}

function cryptoRandomId() {
  return globalThis.crypto.randomUUID();
}

const publicFields = {
  cosecha: ['lote_cana', 'cantidad_kg'],
  molienda: ['lote', 'lote_cana_origen', 'cana_kg', 'panela_kg', 'aditivos'],
  analisis_laboratorio: ['lote', 'presentacion', 'humedad_pct', 'cenizas_pct', 'azucares_reductores_pct', 'azucares_no_reductores_pct', 'so2', 'colorantes', 'plomo_mgkg', 'arsenico_mgkg'],
  despacho: ['lote', 'cantidad_kg'],
};
function publicProjection(record) {
  const allowed = publicFields[record.type] || [];
  const data = Object.fromEntries(allowed.filter(key => record.data?.[key] !== undefined && record.data[key] !== '').map(key => [key, record.data[key]]));
  return { type: record.type, date: record.date, data, seal: record.hash, chainIndex: record.chainIndex, correctionOf: record.correctsRecordId ?? null };
}

export async function verifyPublicLot(publicCode) {
  if (!/^[a-f0-9-]{20,80}$/i.test(publicCode)) return { status: 404, body: { error: 'No se encontró este código de verificación.' } };
  const lot = await get(database, 'SELECT establishment_id,code,created_at FROM lots WHERE public_code=?', [publicCode]);
  if (!lot) return { status: 404, body: { error: 'No se encontró este código de verificación.' } };
  const establishment = await get(database, 'SELECT checkpoint_payload,checkpoint_signature FROM establishments WHERE id=?', [lot.establishment_id]);
  if (!establishment) return { status: 404, body: { error: 'El lote no tiene un comprobante de sincronización.' } };
  const rows = await all(database, 'SELECT * FROM log_records WHERE establishment_id=? ORDER BY device_id,chain_index', [lot.establishment_id]);
  const allRecords = rows.map(recordFromRow);
  let hashesConsistent = true;
  const previousByDevice = new Map();
  const indexByDevice = new Map();
  for (const record of allRecords) {
    const previousHash = previousByDevice.get(record.deviceId) || null;
    const chainIndex = indexByDevice.get(record.deviceId) || 0;
    if (record.chainIndex !== chainIndex + 1 || (record.previousHash ?? null) !== previousHash || digest(payloadFor(record)) !== record.hash) hashesConsistent = false;
    previousByDevice.set(record.deviceId, record.hash);
    indexByDevice.set(record.deviceId, record.chainIndex);
  }
  const heads = [...previousByDevice.entries()].map(([deviceId, hash]) => ({ deviceId, chainIndex: indexByDevice.get(deviceId), hash })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const computedCheckpoint = stableStringify(heads);
  let signatureValid = false;
  try {
    signatureValid = Boolean(establishment.checkpoint_signature) && computedCheckpoint === establishment.checkpoint_payload && verify(null, Buffer.from(computedCheckpoint), signingPublicKey, Buffer.from(establishment.checkpoint_signature, 'base64'));
  } catch {}
  const milling = allRecords.filter(record => record.type === 'molienda' && record.data?.lote === lot.code);
  const origins = new Set(milling.flatMap(record => String(record.data?.lote_cana_origen || '').split(/[;,]/).map(item => item.trim()).filter(Boolean)));
  const linked = allRecords.filter(record => record.type === 'cosecha' && origins.has(String(record.data?.lote_cana || '').trim()));
  const related = [...new Set([...milling, ...linked, ...allRecords.filter(record => ['analisis_laboratorio', 'despacho'].includes(record.type) && record.data?.lote === lot.code)])]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.chainIndex - b.chainIndex);
  const checkpointHash = createHash('sha256').update(String(establishment.checkpoint_payload)).digest('hex');
  return {
    status: 200,
    body: {
      lotCode: lot.code, createdAt: lot.created_at, records: related.map(publicProjection),
      integrity: {
        hashesConsistent, serverCheckpointValid: signatureValid, verifiedAt: new Date().toISOString(),
        checkpoint: { algorithm: 'ed25519', signature: establishment.checkpoint_signature, payloadHash: checkpointHash, devices: heads.length },
      },
    },
  };
}

export function getSqliteStatus() { return { database: isRemote ? 'turso' : 'libsql-local', ready: true }; }
export async function closeDatabase() {
  try { database.close(); } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  integrityPayload, legacyRecords, sealLegacyRecords, sha256, validateSealedChain, verifyLocalChain,
} from '../src/chain.ts';

const workdir = await mkdtemp(join(tmpdir(), 'panelapp-phase5-'));
const dbPath = join(workdir, 'phase5.sqlite');
process.env.PANELAPP_DB_PATH = dbPath;
process.env.PANELAPP_SIGNING_KEY_PATH = join(workdir, 'phase5-signing-key.pem');

const { syncRecords, verifyPublicLot, closeDatabase } = await import('./traceability.mjs');

test.after(async () => {
  await closeDatabase();
  for (let attempt = 0; attempt < 10; attempt++) {
    try { await rm(workdir, { recursive: true, force: true }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
});

function makeIdentity(name) {
  return {
    id: randomUUID(), name, token: `${randomUUID()}${randomUUID()}`,
    profile: { nombre: name, tipo_establecimiento: 'trapiche' },
    updatedAt: new Date().toISOString(),
  };
}

function makeRecord(type, data, overrides = {}) {
  return {
    createdAt: '2026-11-10T12:00:00.000Z', date: '2026-11-10', type, data,
    previousId: null, correctsId: null, correctsRecordId: null, originVoiceId: null,
    ...overrides,
  };
}

async function buildChain({ establishmentId, deviceId, records, startIndex = 1, previousHash = null }) {
  let chainIndex = startIndex;
  let head = previousHash;
  const sealed = [];
  for (const record of records) {
    const next = {
      ...record, recordId: record.recordId || randomUUID(), establishmentId, deviceId,
      chainIndex, previousHash: head, hash: '',
    };
    next.hash = await sha256(integrityPayload(next));
    sealed.push(next);
    head = next.hash;
    chainIndex++;
  }
  return sealed;
}

async function createLot(name, lotCode, caneCode) {
  const establishment = makeIdentity(name);
  const deviceId = randomUUID();
  const records = await buildChain({
    establishmentId: establishment.id, deviceId, records: [
      makeRecord('cosecha', { lote_cana: caneCode, cantidad_kg: 500, responsable: 'Responsable privado' }),
      makeRecord('molienda', { lote: lotCode, lote_cana_origen: caneCode, cana_kg: 500, panela_kg: 50, aditivos: 'ninguno', responsable: 'Responsable privado' }),
      makeRecord('analisis_laboratorio', { lote: lotCode, presentacion: 'bloque', humedad_pct: 8, laboratorio: 'Laboratorio privado' }),
      makeRecord('despacho', { lote: lotCode, cantidad_kg: 20, comprador: 'Comprador privado', responsable: 'Responsable privado' }),
    ],
  });
  const result = await syncRecords({ establishment, deviceId, records, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  const lot = result.body.lots.find(item => item.code === lotCode);
  assert.ok(lot?.public_code, 'el servidor debe asignar un código público al lote');
  return { establishment, deviceId, records, publicCode: lot.public_code };
}

test('flujo completo: lote offline, sincronización, QR y verificación pública', async () => {
  const { publicCode } = await createLot('Trapiche Flujo', 'L-100', 'C-100');
  const verification = await verifyPublicLot(publicCode);
  assert.equal(verification.status, 200);
  assert.equal(verification.body.integrity.hashesConsistent, true);
  assert.equal(verification.body.integrity.serverCheckpointValid, true);
  assert.equal(verification.body.integrity.checkpoint.algorithm, 'ed25519');
  assert.equal(verification.body.records.length, 4);
  const raw = JSON.stringify(verification.body);
  assert.ok(raw.includes('C-100'));
  assert.ok(!raw.includes('Responsable privado'));
  assert.ok(!raw.includes('Comprador privado'));
  assert.ok(!raw.includes('Laboratorio privado'));
});

test('la verificación detecta contenido alterado y comprobante inválido', async () => {
  const { establishment, records, publicCode } = await createLot('Trapiche Alterado', 'L-200', 'C-200');
  const external = new DatabaseSync(dbPath);
  try {
    const altered = { ...records[1], data: { ...records[1].data, panela_kg: 9999 } };
    external.prepare('UPDATE log_records SET payload_json=? WHERE record_id=?').run(JSON.stringify(altered), records[1].recordId);
  } finally {
    external.close();
  }
  let verification = await verifyPublicLot(publicCode);
  assert.equal(verification.body.integrity.hashesConsistent, false);
  assert.equal(verification.body.integrity.serverCheckpointValid, true);

  const external2 = new DatabaseSync(dbPath);
  try {
    const alteredHead = { ...records[3], hash: '0'.repeat(64) };
    external2.prepare('UPDATE log_records SET payload_json=? WHERE record_id=?').run(JSON.stringify(alteredHead), records[3].recordId);
  } finally {
    external2.close();
  }
  verification = await verifyPublicLot(publicCode);
  assert.equal(verification.body.integrity.hashesConsistent, false);
  assert.equal(verification.body.integrity.serverCheckpointValid, false);
  assert.equal(verification.status, 200);
});

test('una corrección conserva intacto el registro original', async () => {
  const { establishment, deviceId, records, publicCode } = await createLot('Trapiche Corrección', 'L-300', 'C-300');
  const original = records[1];
  const correction = (await buildChain({
    establishmentId: establishment.id, deviceId,
    records: [makeRecord('molienda', { ...original.data, panela_kg: 55 }, { correctsId: 1, correctsRecordId: original.recordId })],
    startIndex: records.length + 1, previousHash: records.at(-1).hash,
  }))[0];
  const result = await syncRecords({ establishment, deviceId, records: [correction], entities: [], knownRecordIds: records.map(item => item.recordId) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.accepted, [correction.recordId]);

  const external = new DatabaseSync(dbPath);
  try {
    const storedOriginal = JSON.parse(external.prepare('SELECT payload_json FROM log_records WHERE record_id=?').get(original.recordId).payload_json);
    const storedCorrection = JSON.parse(external.prepare('SELECT payload_json FROM log_records WHERE record_id=?').get(correction.recordId).payload_json);
    assert.deepEqual(storedOriginal.data, original.data);
    assert.equal(storedCorrection.correctsRecordId, original.recordId);
  } finally {
    external.close();
  }

  const verification = await verifyPublicLot(publicCode);
  const publicOriginal = verification.body.records.find(item => item.seal === original.hash);
  const publicCorrection = verification.body.records.find(item => item.seal === correction.hash);
  assert.equal(publicOriginal.data.panela_kg, 50);
  assert.equal(publicCorrection.data.panela_kg, 55);
  assert.equal(publicCorrection.correctionOf, original.recordId);
});

test('la sincronización fuera de orden se rechaza y no deja datos parciales', async () => {
  const establishment = makeIdentity('Trapiche Orden');
  const deviceId = randomUUID();
  const records = await buildChain({
    establishmentId: establishment.id, deviceId, records: [
      makeRecord('limpieza', { area: 'A' }),
      makeRecord('limpieza', { area: 'B' }),
      makeRecord('limpieza', { area: 'C' }),
    ],
  });
  const partial = await syncRecords({ establishment, deviceId, records: [records[0], records[2]], entities: [], knownRecordIds: [] });
  assert.equal(partial.status, 409);
  assert.match(partial.body.error, /cadena/i);

  const external = new DatabaseSync(dbPath);
  try {
    assert.equal(external.prepare('SELECT COUNT(*) AS total FROM log_records WHERE establishment_id=?').get(establishment.id).total, 0);
    assert.equal(external.prepare('SELECT id FROM establishments WHERE id=?').get(establishment.id), undefined);
  } finally {
    external.close();
  }

  const complete = await syncRecords({ establishment, deviceId, records, entities: [], knownRecordIds: [] });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.accepted.length, 3);
});

test('una corrección no puede apuntar a otro establecimiento', async () => {
  const other = await createLot('Trapiche Ajeno', 'L-400', 'C-400');
  const establishment = makeIdentity('Trapiche Propio');
  const deviceId = randomUUID();
  const cross = await buildChain({
    establishmentId: establishment.id, deviceId,
    records: [makeRecord('molienda', { lote: 'L-401', cana_kg: 1, panela_kg: 1 }, { correctsRecordId: other.records[1].recordId })],
  });
  const result = await syncRecords({ establishment, deviceId, records: cross, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /otro establecimiento/i);
});

test('una corrección huérfana se acepta y queda pendiente hasta que llegue su original', async () => {
  const establishment = makeIdentity('Trapiche Huérfano');
  const deviceId = randomUUID();
  const missing = randomUUID();
  const records = await buildChain({
    establishmentId: establishment.id, deviceId,
    records: [makeRecord('molienda', { lote: 'L-500', cana_kg: 1, panela_kg: 1 }, { correctsRecordId: missing })],
  });
  const result = await syncRecords({ establishment, deviceId, records, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pendingCorrections, [missing]);
});

test('un registro posterior no puede resolver una corrección pendiente de otro establecimiento', async () => {
  const establishmentB = makeIdentity('Trapiche Pendiente B');
  const deviceB = randomUUID();
  const targetId = randomUUID();
  const correction = await buildChain({
    establishmentId: establishmentB.id, deviceId: deviceB,
    records: [makeRecord('molienda', { lote: 'L-600', cana_kg: 1, panela_kg: 1 }, { correctsRecordId: targetId })],
  });
  let result = await syncRecords({ establishment: establishmentB, deviceId: deviceB, records: correction, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pendingCorrections, [targetId]);

  const establishmentA = makeIdentity('Trapiche Pendiente A');
  const deviceA = randomUUID();
  const target = await buildChain({
    establishmentId: establishmentA.id, deviceId: deviceA,
    records: [makeRecord('molienda', { lote: 'L-601', cana_kg: 1, panela_kg: 1 }, { recordId: targetId })],
  });
  result = await syncRecords({ establishment: establishmentA, deviceId: deviceA, records: target, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /pendiente de corrección pertenece a otro establecimiento/i);
});

test('perfil y auditorías concurrentes se resuelven por el cambio más reciente', async () => {
  const establishment = makeIdentity('Trapiche Concurrencia');
  const deviceA = randomUUID();
  const deviceB = randomUUID();
  const t1 = '2026-11-10T10:00:00.000Z';
  const t2 = '2026-11-10T11:00:00.000Z';
  const t3 = '2026-11-10T12:00:00.000Z';
  const profileA = { nombre: 'Trapiche Concurrencia', version: 'A' };
  const profileB = { nombre: 'Trapiche Concurrencia', version: 'B' };

  let result = await syncRecords({ establishment: { ...establishment, profile: profileA, updatedAt: t2 }, deviceId: deviceA, records: [], entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.equal(result.body.profile.version, 'A');

  result = await syncRecords({ establishment: { ...establishment, profile: profileB, updatedAt: t1 }, deviceId: deviceB, records: [], entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.equal(result.body.profileConflict, true);
  assert.equal(result.body.profileResolution, 'server');
  assert.equal(result.body.profile.version, 'A');

  result = await syncRecords({ establishment: { ...establishment, profile: profileB, updatedAt: t3 }, deviceId: deviceB, records: [], entities: [], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.equal(result.body.profileConflict, false);
  assert.equal(result.body.profile.version, 'B');

  const key = randomUUID();
  result = await syncRecords({ establishment: { ...establishment, profile: profileB, updatedAt: t3 }, deviceId: deviceA, records: [], entities: [{ type: 'audit', key, updatedAt: t2, payload: { answer: 'A' } }], knownRecordIds: [] });
  assert.equal(result.status, 200);
  result = await syncRecords({ establishment: { ...establishment, profile: profileB, updatedAt: t3 }, deviceId: deviceB, records: [], entities: [{ type: 'audit', key, updatedAt: t1, payload: { answer: 'B' } }], knownRecordIds: [] });
  assert.equal(result.status, 200);
  assert.equal(result.body.entityConflicts.length, 1);
  assert.deepEqual(result.body.entities.find(item => item.key === key).payload, { answer: 'A' });
});

test('la resincronización de los mismos registros es idempotente y no duplica datos', async () => {
  const { establishment, deviceId, records } = await createLot('Trapiche Idempotente', 'L-700', 'C-700');
  const again = await syncRecords({ establishment, deviceId, records, entities: [], knownRecordIds: records.map(item => item.recordId) });
  assert.equal(again.status, 200);
  assert.deepEqual([...again.body.accepted].sort(), records.map(item => item.recordId).sort());
  const external = new DatabaseSync(dbPath);
  try {
    assert.equal(external.prepare('SELECT COUNT(*) AS total FROM log_records WHERE establishment_id=?').get(establishment.id).total, records.length);
  } finally {
    external.close();
  }
});

test('un registro ya sincronizado no puede volver con otro sello', async () => {
  const { establishment, deviceId, records } = await createLot('Trapiche Inmutable', 'L-800', 'C-800');
  const tampered = records.map((item, index) => (index === 1 ? { ...item, hash: 'f'.repeat(64) } : item));
  const result = await syncRecords({ establishment, deviceId, records: tampered, entities: [], knownRecordIds: [] });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /otro sello/i);
});

test('las bitácoras antiguas se sellan después del último eslabón sin romper la cadena', async () => {
  const establishmentId = randomUUID();
  const deviceId = randomUUID();
  const sealed = await buildChain({
    establishmentId, deviceId, records: [
      makeRecord('limpieza', { area: 'A' }),
      makeRecord('limpieza', { area: 'B' }),
    ],
  });
  const legacy = [
    { id: 10, createdAt: '2026-01-01T00:00:00.000Z', date: '2026-01-01', type: 'capacitacion', data: { tema: 'vieja' }, establishment: 'Trapiche' },
    { id: 11, createdAt: '2026-01-02T00:00:00.000Z', date: '2026-01-02', type: 'capacitacion', data: { tema: 'vieja 2' }, establishment: 'Trapiche' },
  ];
  const head = await validateSealedChain([...sealed, ...legacy], establishmentId, deviceId);
  assert.equal(head.chainIndex, 2);
  const pending = legacyRecords([...sealed, ...legacy], deviceId);
  assert.equal(pending.length, 2);
  const migrated = await sealLegacyRecords(pending, establishmentId, deviceId, head.previousHash, head.chainIndex);
  assert.equal(migrated.sealed[0].chainIndex, 3);
  assert.equal(migrated.sealed[0].previousHash, sealed[1].hash);
  assert.equal(migrated.sealed[1].chainIndex, 4);
  assert.equal(await verifyLocalChain([...sealed, ...migrated.sealed]), true);

  const tampered = [{ ...sealed[0], data: { area: 'alterada' } }, sealed[1]];
  await assert.rejects(() => validateSealedChain(tampered, establishmentId, deviceId), /sello local no coincide/i);
});

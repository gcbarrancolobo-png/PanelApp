import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChecklist } from '../src/checklist.ts';
import { applies, score, gapOrder } from '../src/scoring.ts';
import { buildAlerts } from '../src/alerts.ts';
import { buildDemoRecords } from '../src/demo.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const checklist = JSON.parse(readFileSync(join(root, 'data/checklists/checklist_panela.json'), 'utf8'));
const dataset = JSON.parse(readFileSync(join(root, 'data/sinteticos/fincas_demo_panela.json'), 'utf8'));
const fincas = dataset.fincas;
// Réplica del perfil vacío de la app (src/main.tsx, emptyProfile): las banderas
// no declaradas en el perfil de una finca son false en la aplicación real.
const baseProfile = {
  nombre: '', departamento: '', municipio: '', tipo_establecimiento: 'trapiche',
  cultiva_cana: false, exporta: false, panela_saborizada: false, elabora_panela_granulada: false,
  vende_a_granel: false, reenvasa: false, declara_100_natural: false,
  comercializa_panela_de_terceros: false, capta_agua_fuente: false,
  vierte_aguas_residuales: false, usa_biomasa: false, usa_lenia: false,
  expende_directamente: false,
};
const profileOf = finca => ({ ...baseProfile, nombre: finca.nombre, ...finca.perfil });

const computeResult = finca => score(checklist, profileOf(finca), finca.respuestas_auditoria || {});
const computeGaps = finca => checklist.requisitos
  .filter(r => (finca.respuestas_auditoria?.[r.id] === 'no_cumple' || finca.respuestas_auditoria?.[r.id] === 'parcial') && applies(r, profileOf(finca), finca.respuestas_auditoria || {}))
  .sort(gapOrder).map(r => r.id);

test('checklist activo válido y dataset con 5 fincas deterministas', () => {
  assert.equal(validateChecklist(checklist), null);
  assert.equal(fincas.length, 5);
  for (const finca of fincas) {
    assert.ok(finca.id && finca.nombre, 'cada finca necesita id y nombre');
    assert.ok(finca.respuestas_auditoria && typeof finca.respuestas_auditoria === 'object');
    assert.ok(finca.resultado_esperado && typeof finca.resultado_esperado === 'object');
  }
});

test('puntaje del motor coincide con resultado_esperado en cada finca', () => {
  const diffs = [];
  for (const finca of fincas) {
    const result = computeResult(finca);
    for (const [module, levels] of Object.entries(finca.resultado_esperado)) {
      for (const [key, value] of Object.entries(levels)) {
        const actual = result[module]?.[key] ?? null;
        const ok = key === 'preparado' ? actual === value : Math.abs((actual ?? 0) - value) < 1e-9;
        if (!ok) diffs.push(`${finca.id} ${module}.${key}: motor=${actual} esperado=${value}`);
      }
    }
  }
  assert.deepEqual(diffs, [], 'desviaciones motor vs dataset');
});

test('los módulos calculados coinciden con los módulos esperados', () => {
  for (const finca of fincas) {
    const result = computeResult(finca);
    const scored = Object.entries(result).filter(([, levels]) => levels.critica !== null || levels.mayor !== null || levels.menor !== null).map(([m]) => m);
    assert.deepEqual(scored.sort(), [...Object.keys(finca.resultado_esperado)].sort(), `${finca.id}: módulos con respuestas`);
  }
});

test('brechas: cada brecha tiene respuesta parcial/no_cumple, aplica y está ordenada por criticidad', () => {
  const order = ['critica', 'mayor', 'menor'];
  for (const finca of fincas) {
    const gaps = computeGaps(finca);
    const answers = finca.respuestas_auditoria || {};
    const profile = profileOf(finca);
    const byId = new Map(checklist.requisitos.map(r => [r.id, r]));
    for (const id of gaps) {
      const r = byId.get(id);
      assert.ok(r, `${finca.id}: brecha ${id} no existe en el checklist`);
      assert.ok(answers[id] === 'no_cumple' || answers[id] === 'parcial');
      assert.ok(applies(r, profile, answers), `${finca.id}: ${id} debe aplicar al perfil`);
    }
    const levels = gaps.map(id => order.indexOf(byId.get(id).criticidad));
    assert.deepEqual([...levels].sort((a, b) => a - b), levels, `${finca.id}: brechas ordenadas por criticidad`);
  }
});

test('regla calculada incumple_infraestructura solo aplica con respuestas INF/SNT/EQU/SAL no_cumple', () => {
  const r = checklist.requisitos.find(x => x.aplica_si?.calculado === 'incumple_infraestructura');
  assert.ok(r, 'el checklist debe tener requisitos con calculado=incumple_infraestructura');
  const profile = { tipo_establecimiento: 'trapiche' };
  assert.equal(applies(r, profile, {}), false);
  assert.equal(applies(r, profile, { 'BPM-01': 'no_cumple' }), false, 'otras categorías no activan la regla');
  assert.equal(applies(r, profile, { 'INF-01': 'no_cumple' }), true);
  assert.equal(applies(r, profile, { 'SNT-01': 'no_cumple' }), true);
  assert.equal(applies(r, profile, { 'EQU-01': 'no_cumple' }), true);
  assert.equal(applies(r, profile, { 'SAL-01': 'no_cumple' }), true);
  assert.equal(applies(r, profile, { 'INF-01': 'parcial' }), false);
});

test('el motor es determinista: dos ejecuciones producen el mismo resultado', () => {
  for (const finca of fincas) {
    assert.deepEqual(computeResult(finca), computeResult(finca), `${finca.id}: determinismo`);
    assert.deepEqual(computeGaps(finca), computeGaps(finca), `${finca.id}: determinismo de brechas`);
  }
});

test('alertas esperadas de T4 se generan con los registros de la bitácora demo', () => {
  const t4 = fincas.find(f => f.id === 'T4');
  assert.ok(t4, 'debe existir la finca T4');
  const now = Date.parse('2026-11-10T12:00:00Z');
  const logs = buildDemoRecords(t4.bitacora, t4.nombre, false);
  const alerts = buildAlerts(logs, checklist.requisitos, checklist.metadata.reglas_alerta, t4.perfil.tipo_establecimiento, now);
  for (const expected of t4.alertas_esperadas || []) {
    // Identificamos la alerta por requisito + un dato del detalle esperado
    // (fecha, insumo entre comillas o valor numérico del análisis).
    const tokens = [expected.fecha];
    const quoted = expected.detalle.match(/"(.*?)"/);
    if (quoted) tokens.push(quoted[1]);
    const number = expected.detalle.match(/\d+(?:\.\d+)?/);
    if (number) tokens.push(number[0]);
    const hit = alerts.find(a => a.requirementId === expected.requisito && tokens.some(token => a.detail.includes(token) || a.title.includes(token)));
    assert.ok(hit, `alerta esperada no generada: ${expected.requisito} (${expected.detalle})`);
    if (quoted) assert.ok(hit.detail.includes(quoted[1]) || hit.title.includes(quoted[1]), `la alerta debe mencionar «${quoted[1]}»`);
  }
});

test('las alertas del demo son deterministas con la misma fecha de referencia', () => {
  const t4 = fincas.find(f => f.id === 'T4');
  const now = Date.parse('2026-11-10T12:00:00Z');
  const logs = buildDemoRecords(t4.bitacora, t4.nombre, false);
  const a = buildAlerts(logs, checklist.requisitos, checklist.metadata.reglas_alerta, 'trapiche', now);
  const b = buildAlerts(logs, checklist.requisitos, checklist.metadata.reglas_alerta, 'trapiche', now);
  assert.deepEqual(a, b);
});

test('el build no contiene URLs locales hardcodeadas (servible desde una URL pública)', () => {
  const dist = join(root, 'dist');
  assert.ok(existsSync(dist), 'Ejecuta npm run build antes de los tests');
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(js|css)$/.test(entry.name)) files.push(path);
    }
  };
  walk(join(dist, 'assets'));
  assert.ok(files.length, 'dist/assets está vacío');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/https?:\/\/(localhost|127\.0\.0\.1)/.test(text), `${file} contiene una URL local hardcodeada`);
  }
});

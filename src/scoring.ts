import type { Checklist, Requirement } from './checklist';

export type ScoreLevel = { critica: number | null; mayor: number | null; menor: number | null; preparado?: boolean };
export type ScoreResult = Record<string, ScoreLevel>;
export type ScoringProfile = Record<string, unknown>;

const criticalityOrder = ['critica', 'mayor', 'menor'];

export function gapOrder(r: Requirement, s: Requirement) {
  return criticalityOrder.indexOf(r.criticidad) - criticalityOrder.indexOf(s.criticidad);
}

export function applies(r: Requirement, p: ScoringProfile, answers: Record<string, string>) {
  const c = r.aplica_si || {};
  for (const [k, v] of Object.entries(c)) {
    if (k === 'calculado') {
      if (v === 'incumple_infraestructura') {
        const bad = Object.entries(answers).some(([id, a]) => /^(INF|SNT|EQU|SAL)-/.test(id) && a === 'no_cumple');
        if (!bad) return false;
      }
      continue;
    }
    const actual = k === 'tipo_establecimiento' ? p.tipo_establecimiento : (p as Record<string, unknown>)[k];
    if (actual !== v) return false;
  }
  return true;
}

export function isBrecha(r: Requirement, answers: Record<string, string>) {
  return applies(r, {}, answers) && (answers[r.id] === 'no_cumple' || answers[r.id] === 'parcial');
}

export function score(checklist: Checklist, p: ScoringProfile, answers: Record<string, string>): ScoreResult {
  const result: any = { obligatorio: {}, ambiental: {}, BPA_voluntario: {} };
  for (const module of Object.keys(result)) for (const level of ['critica', 'mayor', 'menor']) {
    const rs = checklist.requisitos.filter(r => applies(r, p, answers) && r.criticidad === level && (module === 'ambiental'
      ? r.modulo === 'ambiental'
      : module === 'BPA_voluntario'
        ? r.caracter === 'voluntario_certificacion_BPA'
        : r.modulo !== 'ambiental' && r.caracter !== 'voluntario_certificacion_BPA'));
    const rated = rs.filter(r => ['cumple', 'parcial', 'no_cumple'].includes(answers[r.id]));
    const pts = rated.reduce((s, r) => s + (answers[r.id] === 'cumple' ? 1 : answers[r.id] === 'parcial' ? .5 : 0), 0);
    result[module][level] = rated.length ? Math.round(pts / rated.length * 1000) / 10 : null;
  }
  for (const m of ['obligatorio', 'BPA_voluntario']) {
    const s = result[m];
    s.preparado = s.critica === 100 && s.mayor !== null && s.mayor >= 80 && s.menor !== null && s.menor >= 60;
  }
  return result;
}

export function gaps(checklist: Checklist, p: ScoringProfile, answers: Record<string, string>) {
  return checklist.requisitos
    .filter(r => (answers[r.id] === 'no_cumple' || answers[r.id] === 'parcial') && applies(r, p, answers))
    .sort(gapOrder);
}

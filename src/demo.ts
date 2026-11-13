import type { LogType } from './logbooks.ts';

export type DemoLog = {
  id: number;
  type: LogType;
  date: string;
  data: Record<string, any>;
  establishment: string;
  createdAt: string;
  sample: true;
  [key: string]: unknown;
};

const knownTypes = ['limpieza', 'analisis_laboratorio', 'molienda', 'despacho', 'capacitacion'];

export function buildDemoRecords(demoRecords: any[] | undefined, establishment: string, granulada: boolean): DemoLog[] {
  return (demoRecords || []).map((x: any, i: number) => {
    const type = (knownTypes.includes(x.tipo) ? x.tipo : null) as LogType | null;
    if (!type) return null;
    const d = { ...x, fecha: x.fecha, presentacion: granulada ? 'granulada' : 'bloque' };
    if (Array.isArray(x.aditivos)) d.aditivos = x.aditivos.map((a: any) => `${a.nombre}${a.cantidad_g ? ` ${a.cantidad_g} g` : ''}`).join('; ');
    return { ...x, id: -(i + 1), type, date: x.fecha, data: d, establishment, createdAt: `${x.fecha}T12:00:00.000Z`, sample: true };
  }).filter(Boolean) as DemoLog[];
}

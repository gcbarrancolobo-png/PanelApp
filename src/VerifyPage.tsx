import { useEffect, useState } from 'react';
import { CheckCircle2, CircleHelp, ShieldCheck, XCircle } from 'lucide-react';

type Verification = {
  lotCode: string;
  createdAt: string;
  records: { type: string; date: string; data: Record<string, unknown>; seal: string; chainIndex: number; correctionOf: string | null }[];
  integrity: {
    hashesConsistent: boolean; serverCheckpointValid: boolean; verifiedAt: string;
    checkpoint?: { algorithm: string; signature: string; payloadHash: string; devices: number };
  };
};
const publicLabels: Record<string, string> = {
  lote: 'Lote de panela', lote_cana_origen: 'Caña de origen', lote_cana: 'Lote de caña',
  cana_kg: 'Caña procesada (kg)', panela_kg: 'Panela producida (kg)', cantidad_kg: 'Cantidad (kg)',
  presentacion: 'Presentación', humedad_pct: 'Humedad (%)', cenizas_pct: 'Cenizas (%)',
  azucares_reductores_pct: 'Azúcares reductores (%)', azucares_no_reductores_pct: 'Azúcares no reductores (%)',
  so2: 'SO₂', colorantes: 'Colorantes', plomo_mgkg: 'Plomo (mg/kg)', arsenico_mgkg: 'Arsénico (mg/kg)', aditivos: 'Aditivos',
};

export default function VerifyPage({ code, notice }: { code: string; notice: string }) {
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    fetch(`/api/verify/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(20_000) })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'No se pudo verificar el lote.'); return data; })
      .then(data => { if (active) setResult(data); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'No se pudo consultar la verificación.'); });
    return () => { active = false; };
  }, [code]);
  const hashesOk = Boolean(result?.integrity.hashesConsistent);
  const signatureOk = Boolean(result?.integrity.serverCheckpointValid);
  const valid = hashesOk && signatureOk;
  return <div className="public-verification"><header><ShieldCheck/><b>PanelApp · Verificación de lote</b></header><main><span className="eyebrow">TRAZABILIDAD PÚBLICA</span><h1>{result ? `Lote ${result.lotCode}` : 'Verificar lote'}</h1>
    {error && <article className="error"><CircleHelp/><b>No se pudo verificar</b><p>{error}</p></article>}
    {!result && !error && <p role="status">Consultando la ficha pública…</p>}
    {result && <><article className={`verification-status ${valid?'verified':'unverified'}`}>{valid?<CheckCircle2/>:<XCircle/>}<div><b>{valid?'Cadena de sellos y comprobante válidos':'No se pudo confirmar la integridad'}</b><p>{valid?'Los registros sincronizados coinciden con los sellos guardados por el servidor y el comprobante firmado es válido.':'Hay registros modificados, incompletos, un comprobante que no coincide o una firma inválida.'}</p></div></article><p>Verificado el {new Date(result.integrity.verifiedAt).toLocaleString('es-CO')} · {result.records.length} registro(s) relacionado(s).</p>
    <section className="content-card integrity-checks"><h2>Comprobaciones de integridad</h2><ul><li>{hashesOk?<CheckCircle2/>:<XCircle/>}<span><b>Cadenas SHA-256:</b> {hashesOk?'cada sello coincide con su contenido y con el registro anterior.':'no coinciden; algún registro fue alterado o está incompleto.'}</span></li><li>{signatureOk?<CheckCircle2/>:<XCircle/>}<span><b>Comprobante firmado por el servidor:</b> {signatureOk?`firma ${result.integrity.checkpoint?.algorithm||'Ed25519'} válida.`:'firma inválida, ausente o el comprobante no coincide con los registros.'}</span></li></ul>{result.integrity.checkpoint?.payloadHash&&<p className="privacy-note">Huella del comprobante: {result.integrity.checkpoint.payloadHash}</p>}</section>
    <section className="public-records">{result.records.map((record,index)=><article key={`${record.seal}-${index}`}><div className="question-meta"><b>{record.type.replace(/_/g,' ')}</b><span>{record.date}</span><small>Secuencia {record.chainIndex}</small></div><dl>{Object.entries(record.data).map(([key,value])=><div key={key}><dt>{publicLabels[key]||key}</dt><dd>{String(value)}</dd></div>)}</dl>{record.correctionOf&&<small>Corrige el registro {String(record.correctionOf).slice(0,8)}…</small>}<small>Sello SHA-256: {record.seal}</small></article>)}</section></>}
    <div className="notice"><ShieldCheck/><span>{notice}</span></div><p className="privacy-note">Esta página muestra solo datos seleccionados para trazabilidad. La verificación de integridad no equivale a una certificación sanitaria.</p>
  </main><footer>PanelApp · Proyecto académico</footer></div>;
}

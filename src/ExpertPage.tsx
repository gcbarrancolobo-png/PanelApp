import { useEffect, useMemo, useState } from 'react';
import { Check, FileJson2, Save, Search, Upload, Volume2 } from 'lucide-react';
import { db } from './db';
import { validateChecklist, type Checklist } from './checklist';

type Props = { checklist: Checklist; readOnly: boolean; read: (text: string) => void; onChecklistChange: (checklist: Checklist) => void };
type Review = { id?: number; requirementId: string; status: 'pendiente' | 'validado'; observation: string; author: string; createdAt: string };

export default function ExpertPage({ checklist, readOnly, read, onChecklistChange }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(checklist.requisitos[0]?.id || '');
  const [author, setAuthor] = useState(() => localStorage.getItem('panelapp-validator-author') || '');
  const [status, setStatus] = useState<'pendiente' | 'validado'>('pendiente');
  const [observation, setObservation] = useState('');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [message, setMessage] = useState('');
  const selected = checklist.requisitos.find(requirement => requirement.id === selectedId);
  const filtered = useMemo(() => checklist.requisitos.filter(requirement => !query || `${requirement.id} ${requirement.categoria} ${requirement.pregunta_al_productor}`.toLowerCase().includes(query.toLowerCase())), [checklist, query]);
  const latestById = useMemo(() => {
    const latest = new Map<string, Review>();
    for (const review of reviews) if (!latest.has(review.requirementId)) latest.set(review.requirementId, review);
    return latest;
  }, [reviews]);

  useEffect(() => {
    db.expertReviews.orderBy('createdAt').reverse().toArray().then(setReviews);
    db.checklistVersions.orderBy('createdAt').reverse().limit(10).toArray().then(setVersions);
  }, []);
  useEffect(() => {
    const review = latestById.get(selectedId);
    setStatus(review?.status || 'pendiente');
    setObservation(review?.observation || '');
  }, [selectedId, latestById]);

  async function saveReview() {
    const cleanAuthor = author.trim();
    if (readOnly) return;
    if (!cleanAuthor) { setMessage('Escribe el nombre de quien valida.'); return; }
    if (!selected) return;
    const review: Review = { requirementId: selected.id, status, observation: observation.trim(), author: cleanAuthor, createdAt: new Date().toISOString() };
    await db.expertReviews.add(review);
    localStorage.setItem('panelapp-validator-author', cleanAuthor);
    setReviews(await db.expertReviews.orderBy('createdAt').reverse().toArray());
    setMessage(`Cambios de ${selected.id} guardados con fecha y autor.`);
  }

  async function importChecklist(file?: File) {
    if (!file || readOnly) return;
    setMessage('');
    if (file.size > 2 * 1024 * 1024) { setMessage('El JSON supera 2 MB. Elige un archivo más pequeño.'); return; }
    try {
      const parsed = JSON.parse(await file.text());
      const error = validateChecklist(parsed);
      if (error) { setMessage(`JSON no aceptado: ${error}`); return; }
      const cleanAuthor = author.trim();
      if (!cleanAuthor) { setMessage('Escribe el nombre de quien carga la versión.'); return; }
      const createdAt = new Date().toISOString();
      const version = String(parsed.metadata.version || 'sin versión');
      await db.checklistVersions.add({ createdAt, author: cleanAuthor, version, fileName: file.name, requirementsCount: parsed.requisitos.length });
      await db.checklistOverrides.put({ key: 'active', checklist: parsed, createdAt, author: cleanAuthor, version, fileName: file.name });
      localStorage.setItem('panelapp-validator-author', cleanAuthor);
      onChecklistChange(parsed as Checklist);
      setVersions(await db.checklistVersions.orderBy('createdAt').reverse().limit(10).toArray());
      setSelectedId(parsed.requisitos[0]?.id || '');
      setMessage(`Versión ${version} validada y activada en este dispositivo. El archivo original no fue modificado.`);
    } catch (error) {
      setMessage(`No se pudo leer el archivo. Revisa que sea un JSON válido. ${error instanceof Error ? error.message : ''}`);
    }
  }

  return <section className="expert-page">
    <div className="notice"><b>{readOnly ? 'Modo evaluador: solo lectura.' : 'Cambios guardados en este dispositivo.'}</b> El archivo fuente del checklist no se modifica.</div>
    <section className="page-head"><span className="eyebrow">REVISIÓN DE CONTENIDO</span><h1>Panel experto validador</h1><p>Revise los requisitos, agregue observaciones y cargue una versión del checklist.</p></section>
    <div className="expert-layout">
      <aside className="expert-list">
        <label className="search-wrap"><Search size={19}/><input aria-label="Buscar requisito para validar" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar código o tema"/></label>
        <p>{filtered.length} requisitos</p>
        {filtered.map(requirement => {
          const review = latestById.get(requirement.id);
          return <button key={requirement.id} className={`expert-item ${selectedId === requirement.id ? 'selected' : ''}`} onClick={() => setSelectedId(requirement.id)}>
            <span><code>{requirement.id}</code><b>{requirement.categoria}</b></span>
            <small>{requirement.pregunta_al_productor}</small>
            <i className={review?.status === 'validado' ? 'validated' : ''}>{review?.status === 'validado' ? 'Validado' : review?.observation ? 'Con observación' : 'Sin revisar'}</i>
          </button>;
        })}
      </aside>
      <div className="expert-detail">
        {selected ? <article className="form-card">
          <div className="question-meta"><code>{selected.id}</code><span>{selected.categoria}</span><span className={`level ${selected.criticidad}`}>{selected.criticidad}</span></div>
          <h2>{selected.pregunta_al_productor}</h2>
          <p><b>Evidencia:</b> {selected.evidencia_requerida}</p>
          <p><b>Acción sugerida:</b> {selected.accion_correctiva}</p>
          {selected.fuentes.map((source, index) => <small className="expert-source" key={`${source.norma}-${index}`}>{source.norma} · {source.articulo}</small>)}
          <button className="icon-btn expert-read" aria-label="Leer requisito en voz alta" onClick={() => read(`${selected.id}. ${selected.pregunta_al_productor}. ${selected.accion_correctiva}`)}><Volume2/></button>
          <label className="log-field">Nombre de quien valida<input disabled={readOnly} value={author} onChange={event => setAuthor(event.target.value)} placeholder="Nombre del experto validador"/></label>
          <label className="log-field">Estado<select disabled={readOnly} value={status} onChange={event => setStatus(event.target.value as Review['status'])}><option value="pendiente">Pendiente</option><option value="validado">Validado</option></select></label>
          <label className="log-field">Observación<textarea disabled={readOnly} value={observation} onChange={event => setObservation(event.target.value)} placeholder="Agrega una observación para este requisito"/></label>
          {!readOnly && <button className="primary large" onClick={saveReview}><Save size={19}/> Guardar validación</button>}
          {latestById.get(selected.id) && <p className="expert-stamp"><Check size={17}/> Último cambio: {latestById.get(selected.id)?.status === 'validado' ? 'Validado' : 'Pendiente'} · {latestById.get(selected.id)?.author} · {new Date(latestById.get(selected.id)!.createdAt).toLocaleString('es-CO')}</p>}
        </article> : <p>Elige un requisito.</p>}
      </div>
    </div>
    <article className="form-card version-card">
      <h2><FileJson2/> Nueva versión del checklist</h2>
      <p>Cargue un archivo JSON. PanelApp comprueba su estructura y guarda una copia local como versión activa.</p>
      <label className="log-field">Nombre de quien carga la versión<input disabled={readOnly} value={author} onChange={event => setAuthor(event.target.value)} placeholder="Nombre del experto validador"/></label>
      <label className="upload-json"><Upload/> Seleccionar JSON<input disabled={readOnly} type="file" accept="application/json,.json" onChange={event => importChecklist(event.target.files?.[0])}/></label>
      {versions.length > 0 && <><h3>Versiones cargadas en este dispositivo</h3>{versions.map(version => <p className="version-row" key={version.id}><b>{version.version}</b> · {version.fileName} · {version.author} · {new Date(version.createdAt).toLocaleString('es-CO')}</p>)}</>}
    </article>
    {message && <p className="log-message" role="status">{message}</p>}
  </section>;
}

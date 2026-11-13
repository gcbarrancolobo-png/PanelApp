import { FormEvent, useMemo, useState } from 'react';
import { BookOpenCheck, LoaderCircle, MessageCircle, Search, Send, Volume2, WifiOff } from 'lucide-react';
import { searchRequirements, type Checklist, type Requirement } from './checklist';

type Props = { checklist: Checklist; profile: Record<string, unknown>; online: boolean; read: (text: string) => void };
type Citation = { id: string; norma: string; articulo: string };
type DocumentCitation = { document: string; page: number };
type Message = { role: 'user' | 'assistant'; text: string; source?: 'gemini' | 'checklist' | 'none'; fallbackReason?: 'missing_citation' | 'invalid_citation'; citations?: Citation[]; documents?: DocumentCitation[]; localResults?: Requirement[] };
const noAnswer = 'No tengo esa información en las normas y requisitos que manejo. Le recomiendo consultar a la secretaría de salud de su municipio o al Invima.';

export default function AdvisorPage({ checklist, profile, online, read }: Props) {
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const localResults = useMemo(() => searchRequirements(question, checklist.requisitos, 8), [question, checklist]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const clean = question.trim();
    if (!clean || busy) return;
    const matches = searchRequirements(clean, checklist.requisitos, 8);
    setQuestion('');
    setError('');
    if (!matches.length) {
      setMessages(previous => [...previous, { role: 'user', text: clean }, { role: 'assistant', text: noAnswer, source: 'none' }]);
      return;
    }
    setMessages(previous => [...previous, { role: 'user', text: clean }]);
    if (!online) {
      setMessages(previous => [...previous, { role: 'assistant', text: 'Sin internet puedo mostrarle requisitos relacionados. La respuesta conversacional necesita conexión.', source: 'checklist', localResults: matches }]);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/advisor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: clean, profile, requirements: matches }),
        signal: AbortSignal.timeout(100_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'El asesor no está disponible.');
      setMessages(previous => [...previous, { role: 'assistant', text: data.answer || noAnswer, source: data.source || (data.fallback ? 'checklist' : 'gemini'), fallbackReason: data.fallbackReason, citations: data.citations || [], documents: data.documents || [], localResults: matches }]);
    } catch (exception) {
      const detail = exception instanceof Error && exception.name === 'TimeoutError' ? 'La consulta tardó demasiado.' : exception instanceof Error ? exception.message : 'No se pudo consultar al asesor.';
      setError(`${detail} Le muestro los requisitos locales relacionados.`);
      setMessages(previous => [...previous, { role: 'assistant', text: 'No pude obtener una respuesta conversacional ahora. Estos son los requisitos locales relacionados con su consulta.', source: 'checklist', localResults: matches }]);
    } finally {
      setBusy(false);
    }
  }

  return <section className="advisor-page">
    <section className="page-head"><span className="eyebrow">NORMAS Y REQUISITOS</span><h1>Asesor virtual</h1><p>Pregunte sobre inocuidad y calidad de panela. Las respuestas citan requisitos del checklist y páginas de las normas cargadas.</p></section>
    <div className="notice"><BookOpenCheck size={20}/><span>El asesor responde solo con las fuentes de PanelApp. Si no encuentra soporte, se lo dirá. No reemplaza orientación oficial.</span></div>
    {!online && <div className="offline-note"><WifiOff size={18}/> Sin conexión: escriba una palabra para buscar requisitos en este dispositivo.</div>}
    {error && <p className="log-message" role="status">{error}</p>}
    <div className="chat-history" aria-live="polite">
      {!messages.length && <article className="empty"><MessageCircle/><h2>¿Qué quiere consultar?</h2><p>Por ejemplo: “¿Qué debo hacer para limpiar el tanque de agua?”</p></article>}
      {messages.map((message, index) => <article className={`chat-message ${message.role}`} key={index}>
        <b>{message.role === 'user' ? 'Usted' : 'PanelApp'}</b>
        {message.role === 'assistant' && message.source && <span className={`response-origin ${message.source}`} role="status">{message.source === 'gemini' ? 'Respuesta de Gemini' : message.source === 'checklist' ? 'Respuesta basada directamente en el checklist' : 'Sin respuesta: no hubo requisitos relacionados'}</span>}
        {message.fallbackReason && <small className="response-origin-detail">Gemini respondió, pero no incluyó una cita válida. PanelApp muestra los requisitos del checklist.</small>}
        <p>{message.text}</p>
        {message.citations && message.citations.length > 0 && <div className="citation-list"><b>Requisitos citados</b>{message.citations.map(citation => <div className="citation" key={`${citation.id}-${citation.articulo}`}><code>{citation.id}</code><span>{citation.norma} · {citation.articulo}</span></div>)}</div>}
        {message.documents && message.documents.length > 0 && <div className="citation-list"><b>Fragmentos consultados</b>{message.documents.map((document, item) => <small key={`${document.document}-${document.page}-${item}`}>{document.document} · página {document.page}</small>)}</div>}
        {message.localResults && <div className="local-results"><b>{message.role === 'assistant' ? 'Requisitos relacionados' : 'Buscar requisito'}</b>{message.localResults.map(requirement => <article className="search-result" key={requirement.id}><div className="question-meta"><code>{requirement.id}</code><span>{requirement.categoria}</span></div><b>{requirement.pregunta_al_productor}</b><p>{requirement.accion_correctiva}</p>{requirement.fuentes.map((source, sourceIndex) => <small key={`${source.norma}-${sourceIndex}`}>{source.norma} · {source.articulo}</small>)}</article>)}</div>}
        {message.role === 'assistant' && <button className="icon-btn advisor-read" aria-label="Leer respuesta en voz alta" onClick={() => read(message.text)}><Volume2/></button>}
      </article>)}
      {busy && <p className="assistant-loading" role="status"><LoaderCircle className="spin"/> Consultando las normas. Puede tardar unos segundos.</p>}
    </div>
    <form className="advisor-form" onSubmit={ask}>
      <label htmlFor="advisor-question"><Search size={18}/> Escriba su pregunta</label>
      <textarea id="advisor-question" value={question} maxLength={1200} onChange={event => setQuestion(event.target.value)} placeholder="Ej. ¿Qué dice el requisito AUT-01?" rows={3}/>
      <p>{localResults.length ? `${localResults.length} requisitos locales relacionados` : 'La búsqueda local se activa al escribir.'}</p>
      <button className="primary large" type="submit" disabled={!question.trim() || busy}><Send size={19}/>{online ? 'Consultar a PanelApp' : 'Buscar requisitos'}</button>
    </form>
  </section>;
}

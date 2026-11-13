import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

try{const env=await readFile(new URL('../.env',import.meta.url),'utf8');for(const rawLine of env.split(/\r?\n/)){const line=rawLine.replace(/^\uFEFF/,'');const m=line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'')}}catch{}
const { syncRecords, verifyPublicLot, getSqliteStatus } = await import('./traceability.mjs');
const port=Number(process.env.PORT||process.env.API_PORT||8787);
const json=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj))};
const distDir=fileURLToPath(new URL('../dist',import.meta.url));
const MIME_TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8','.pdf':'application/pdf'};
const allowedOrigins=(process.env.API_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
function applyCors(req,res){const origin=req.headers.origin;if(!origin||!allowedOrigins.includes(origin))return;res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');res.setHeader('access-control-allow-headers','Content-Type');res.setHeader('access-control-allow-methods','GET,POST,OPTIONS')}
async function serveStatic(req,res){
 if(req.method!=='GET'&&req.method!=='HEAD')return false;
 let pathname;try{pathname=decodeURIComponent(new URL(req.url||'/','http://panelapp.local').pathname)}catch{return false}
 if(pathname.startsWith('/api/'))return false;
 const normalized=pathname.replace(/\\/g,'/').replace(/\.{2,}/g,'.');
 const candidate=resolve(distDir,'.'+normalized);
 if(candidate!==distDir&&!candidate.startsWith(distDir+sep))return false;
 let target=candidate;
 const info=await stat(target).catch(()=>null);
 if(info?.isDirectory())target=join(target,'index.html');
 const ext=extname(target).toLowerCase();
 if(!MIME_TYPES[ext]){
  if(ext)return false;
  target=join(distDir,'index.html');
 }
 let data;try{data=await readFile(target)}catch{return false}
 const finalExt=extname(target).toLowerCase();
 const noStore=/index\.html$|sw\.js$|registerSW\.js$/.test(target);
 res.writeHead(200,{'content-type':MIME_TYPES[finalExt]||'application/octet-stream','cache-control':noStore?'no-store':'public, max-age=3600'});
 if(req.method==='HEAD'){res.end();return true}
 res.end(data);return true;
}
async function body(req,max=120_000){const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw Object.assign(new Error('La solicitud supera el tamaño permitido.'),{status:413});chunks.push(c)}return Buffer.concat(chunks)}
async function jsonBody(req,max=120_000){return JSON.parse((await body(req,max)).toString('utf8'))}
function parts(buffer,boundary){const delim=Buffer.from(`--${boundary}`),out=[];let pos=0;while((pos=buffer.indexOf(delim,pos))!==-1){pos+=delim.length;if(buffer.subarray(pos,pos+2).toString()==='--')break;if(buffer.subarray(pos,pos+2).toString()==='\r\n')pos+=2;const hEnd=buffer.indexOf(Buffer.from('\r\n\r\n'),pos);if(hEnd<0)break;const next=buffer.indexOf(delim,hEnd+4);if(next<0)break;const headers=buffer.subarray(pos,hEnd).toString('utf8');const data=buffer.subarray(hEnd+4,Math.max(hEnd+4,next-2));out.push({headers,data});pos=next}return out}
async function gemini(input,{systemInstruction,maxOutputTokens=1200}={}){if(!process.env.GEMINI_API_KEY)throw Object.assign(new Error('Configura GEMINI_API_KEY en el archivo .env del servidor.'),{status:503});const payload={model:process.env.GEMINI_MODEL||'gemini-3.5-flash-lite',input,store:false,generation_config:{temperature:0,thinking_level:'low',max_output_tokens:maxOutputTokens},...(systemInstruction?{system_instruction:systemInstruction}:{})};let r;try{r=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify(payload),signal:AbortSignal.timeout(90_000)})}catch(e){if(e?.name==='TimeoutError')throw Object.assign(new Error('Gemini tardó más de 90 segundos. Los datos locales se conservan; puedes reintentar.'),{status:504});throw e}const out=await r.json().catch(()=>({}));if(!r.ok){let msg=out.error?.message||`Google Gemini respondió ${r.status}.`;if(/high demand|overloaded|try again later/i.test(msg))msg='Gemini tiene alta demanda temporal. Los datos locales se conservan; espera un momento e intenta de nuevo.';throw Object.assign(new Error(msg),{status:r.status===429||r.status===503?503:502})}const text=(out.steps||[]).filter(x=>x.type==='model_output').flatMap(x=>x.content||[]).filter(x=>typeof x.text==='string').map(x=>x.text).join('\n').trim();if(!text)throw Object.assign(new Error('Gemini no devolvió texto. Revisa los datos e intenta de nuevo.'),{status:502});return text}
const noAdvisorAnswer='No tengo esa información en las normas y requisitos que manejo. Le recomiendo consultar a la secretaría de salud de su municipio o al Invima.';
const pdfPagesCache=new Map();
const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const searchTokens=value=>normalize(value).split(/[^a-z0-9]+/).filter(x=>x.length>1&&!['para','como','con','del','las','los','una','uno','que','por','sin','sus','esta','este','tiene','debe','dice','sobre'].includes(x));
async function pdfDirectory(){for(const url of [new URL('../data/normativa/',import.meta.url),new URL('../public/data/normativa/',import.meta.url)])try{await readdir(url);return url}catch{}return null}
async function extractPdfPages(url){const key=url.href;if(pdfPagesCache.has(key))return pdfPagesCache.get(key);const promise=(async()=>{const bytes=new Uint8Array(await readFile(url));const pdf=await getDocument({data:bytes,verbosity:0}).promise;const pages=[];for(let number=1;number<=pdf.numPages;number++){const page=await pdf.getPage(number);const content=await page.getTextContent();const text=content.items.map(item=>typeof item.str==='string'?item.str:'').join(' ').replace(/\s+/g,' ').trim();if(text)pages.push({number,text})}return pages})();pdfPagesCache.set(key,promise);try{return await promise}catch(error){pdfPagesCache.delete(key);throw error}}
async function relevantPdfExcerpts(question,requirements){const directory=await pdfDirectory();if(!directory)return[];const files=(await readdir(directory)).filter(name=>name.toLowerCase().endsWith('.pdf')&&!/fuente_oficial/i.test(name));const queryNumbers=(question.match(/\d+/g)||[]);const sourceNumbers=requirements.flatMap(requirement=>(requirement.fuentes||[]).flatMap(source=>source.norma.match(/\d+/g)||[]));const tokens=searchTokens(question);const candidateFiles=files.map(name=>{const normalizedName=normalize(name);const numbers=[...new Set(normalizedName.match(/\d+/g)||[])];const sourceHits=sourceNumbers.filter(number=>numbers.includes(number)).length;const queryHits=queryNumbers.filter(number=>numbers.includes(number)).length;return{name,url:new URL(name,directory),score:sourceHits*2+queryHits}}).filter(file=>file.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,5);const selected=[];for(const file of candidateFiles){if(file.name==='res_2674_2013.pdf'&&files.includes('res_2674_2013_.pdf'))continue;try{const pages=await extractPdfPages(file.url);const ranked=pages.map(page=>{const text=normalize(page.text);const score=tokens.reduce((total,token)=>total+(text.includes(token)?1:0),0)+queryNumbers.reduce((total,number)=>total+(text.includes(number)?2:0),0);return{...page,score}}).filter(page=>page.score>0).sort((a,b)=>b.score-a.score||a.number-b.number).slice(0,2);for(const page of ranked){const normalized=normalize(page.text);const indexes=tokens.map(token=>normalized.indexOf(token)).filter(index=>index>=0);const start=Math.max(0,(indexes.length?Math.min(...indexes):0)-260);selected.push({document:file.name,page:page.number,text:page.text.slice(start,start+1800)})}}catch(error){console.warn(`No se pudo extraer texto de ${file.name}:`,error.message)}}return selected.slice(0,8)}
function checklistAdvisorFallback(requirements){
 const selected=requirements.slice(0,4);
 const lines=selected.map(item=>{
  const sources=(item.fuentes||[]).map(source=>`${source.norma}, ${source.articulo}`).join('; ');
  return `- ${item.id}: ${item.pregunta_al_productor} Acción sugerida: ${item.accion_correctiva}${sources?` (${sources})`:''}`;
 });
 return `En el checklist encontré estos requisitos relacionados con su pregunta:\n${lines.join('\n')}\n\nEsta orientación resume el checklist; confirme la aplicación de la norma con la autoridad sanitaria.`;
}
async function advisor(req,res){
 const input=await jsonBody(req);
 if(typeof input.question!=='string'||input.question.trim().length<3||input.question.length>1200)return json(res,400,{error:'Escribe una pregunta de máximo 1.200 caracteres.'});
 const provided=Array.isArray(input.requirements)?input.requirements:[];
 const requirements=provided.filter(item=>item&&/^[A-Z]{2,5}-\d{2,3}$/.test(item.id)&&typeof item.pregunta_al_productor==='string'&&typeof item.accion_correctiva==='string'&&Array.isArray(item.fuentes)).slice(0,10);
 if(!requirements.length)return json(res,200,{answer:noAdvisorAnswer,citations:[],documents:[],source:'none'});
 const contextRequirements=requirements.map(item=>({id:item.id,categoria:item.categoria,pregunta_al_productor:item.pregunta_al_productor,evidencia:item.evidencia_requerida,accion_correctiva:item.accion_correctiva,condicion_de_aplicabilidad:item.condicion_de_aplicabilidad,fuentes:item.fuentes.map(source=>({norma:source.norma,articulo:source.articulo}))}));
 const documentExcerpts=await relevantPdfExcerpts(input.question,requirements);
 const promptFile=await readFile(new URL('../data/prompts/prompts_sistema_ia.md',import.meta.url),'utf8');
 const basePrompt=promptFile.split('## 3. Asesor virtual de normativa')[1]?.split('## Notas para el desarrollador')[0]||'';
 const profile=input.profile&&typeof input.profile==='object'?Object.fromEntries(['tipo_establecimiento','cultiva_cana','exporta','panela_saborizada','elabora_panela_granulada','vende_a_granel','reenvasa','declara_100_natural','comercializa_panela_de_terceros','capta_agua_fuente','vierte_aguas_residuales','usa_biomasa','usa_lenia'].filter(key=>input.profile[key]!==undefined).map(key=>[key,input.profile[key]])):{};
 const context={perfil:profile,requisitos:contextRequirements,fragmentos_normativos:documentExcerpts.map(({document,page,text})=>({document,pagina:page,texto:text}))};
 const system=`${basePrompt}\n\nCONTEXTO FUENTE CERRADO (única fuente permitida):\n${JSON.stringify(context)}\n\nREGLAS DE CITA Y SEGURIDAD:\n- Cita cada afirmación normativa con un ID exacto de la lista de requisitos y su norma/artículo exactos: (ID, norma, artículo).\n- Si usas un fragmento PDF, añade además el nombre exacto del documento y su página entre corchetes. No inventes páginas.\n- No afirmes nada que no esté respaldado por estos requisitos o fragmentos. Si falta soporte, responde exactamente que no tienes esa información y recomienda consultar la autoridad territorial de salud o al Invima.\n- No menciones datos personales ni repitas el nombre del establecimiento. Máximo 120 palabras, frases cortas y español colombiano.`;
 console.log(JSON.stringify({event:'ai_advisor_context',requirementIds:contextRequirements.map(item=>item.id),documents:documentExcerpts.map(item=>({document:item.document,page:item.page}))}));
 const answer=await gemini(input.question.trim(),{systemInstruction:system,maxOutputTokens:700});
 const known=new Set(contextRequirements.map(item=>item.id));
 const cited=[...new Set(answer.match(/\b[A-Z]{2,5}-\d{2,3}\b/g)||[])];
 if(!cited.length||cited.some(id=>!known.has(id))){
  const fallbackReason=cited.length?'invalid_citation':'missing_citation';
  console.log(JSON.stringify({event:'ai_advisor_fallback',reason:fallbackReason,requirementIds:contextRequirements.map(item=>item.id)}));
  const citations=requirements.slice(0,4).flatMap(item=>(item.fuentes||[]).map(source=>({id:item.id,norma:source.norma,articulo:source.articulo})));
  return json(res,200,{answer:checklistAdvisorFallback(requirements),citations,documents:[],source:'checklist',fallbackReason});
 }
 const citations=cited.flatMap(id=>{const requirement=contextRequirements.find(item=>item.id===id);return (requirement?.fuentes||[]).map(source=>({id,norma:source.norma,articulo:source.articulo}))});
 return json(res,200,{answer,citations,documents:documentExcerpts.map(({document,page})=>({document,page})),source:'gemini'});
}
async function transcribe(req,res){const ct=req.headers['content-type']||'',m=ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);if(!m)return json(res,400,{error:'Formato de audio no válido.'});const raw=await body(req,14*1024*1024);const file=parts(raw,m[1]||m[2]).find(x=>/name="audio"/.test(x.headers));if(!file?.data?.length)return json(res,400,{error:'No se recibió un archivo de audio.'});const mime=(file.headers.match(/content-type:\s*([^;\r\n]+)/i)?.[1]||'audio/webm').trim().toLowerCase();if(!mime.startsWith('audio/'))return json(res,415,{error:'El archivo recibido no parece ser audio.'});const prompt='Transcribe literalmente este audio en español de Colombia. Conserva nombres de insumos, cantidades y unidades. Devuelve solo la transcripción, sin comentarios ni resumen.';const transcript=await gemini([{type:'text',text:prompt},{type:'audio',data:file.data.toString('base64'),mime_type:mime}],{maxOutputTokens:3000});return json(res,200,{transcript})}
async function extract(req,res){const input=await jsonBody(req);if(typeof input.transcript!=='string'||input.transcript.length>20_000)return json(res,400,{error:'Transcripción vacía o demasiado larga.'});const schemas=input.schemas||{};const typeNames=Object.keys(schemas);if(!typeNames.length)return json(res,400,{error:'Falta el esquema de bitácoras.'});const ids=(input.requirements||[]).map(x=>x.id).filter(x=>/^(INS|CAL|BPM)-/.test(x));console.log(JSON.stringify({event:'ai_extractor_context',requirementIds:[...new Set(ids)]}));
 const promptFile=await readFile(new URL('../data/prompts/prompts_sistema_ia.md',import.meta.url),'utf8');const prompt=promptFile.split('## 2. Extractor de bitácoras por voz')[1]?.split('## 3. Asesor virtual')[0]||'';
 const system=`${prompt}\n\nResponde SOLO JSON con esta forma: {"records":[{"type":"uno de ${typeNames.join(', ')}","fields":{},"campos_dudosos":[]}]} . Extrae solo los campos disponibles por tipo: ${JSON.stringify(schemas)}. Usa nombres de campos exactos del esquema y respeta el tipo de dato: fechas AAAA-MM-DD, números como números, texto como texto. El campo aditivos es texto plano, por ejemplo "bicarbonato de sodio 150 g; balso 400 g". No inventes. Fecha de hoy: ${input.today||new Date().toISOString().slice(0,10)}. Requisitos relacionados como referencia para reconocer el tema, nunca para decidir si el dato cumple: ${JSON.stringify((input.requirements||[]).map(x=>({id:x.id,pregunta:x.pregunta,fuentes:x.fuentes})))}`;
 const text=await gemini(`Fecha de hoy: ${input.today||new Date().toISOString().slice(0,10)}\nTranscripción:\n${input.transcript}`,{systemInstruction:system,maxOutputTokens:1800});
 let parsed;try{const clean=text.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');parsed=JSON.parse(clean)}catch{return json(res,502,{error:'La respuesta de IA no fue JSON válido. Puede llenar el formulario manualmente.'})}
 if(!Array.isArray(parsed.records))return json(res,502,{error:'La respuesta de IA no contiene registros.'});const records=parsed.records.filter(x=>x&&typeNames.includes(x.type)&&x.fields&&typeof x.fields==='object'&&!Array.isArray(x.fields)).map(x=>{const defs=schemas[x.type].map(f=>typeof f==='string'?{key:f,kind:'text'}:f);const fields={};for(const [key,value] of Object.entries(x.fields)){const def=defs.find(f=>f.key===key);if(!def||value===null||value===undefined)continue;if(def.kind==='number'){const num=Number(value);if((typeof value==='number'||typeof value==='string')&&String(value).trim()!==''&&Number.isFinite(num))fields[key]=num}else if(def.kind==='date'){if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00`)))fields[key]=value}else if(def.kind==='select'){if(typeof value==='string'&&def.options?.some(o=>o.toLowerCase()===value.toLowerCase()))fields[key]=value.toLowerCase()}else if(typeof value==='string')fields[key]=value.trim()}return {type:x.type,fields,campos_dudosos:Array.isArray(x.campos_dudosos)?x.campos_dudosos.filter(v=>typeof v==='string').slice(0,20):[]}}).filter(x=>Object.keys(x.fields).length>0);return json(res,200,{records});
}
const server=createServer(async(req,res)=>{try{
 applyCors(req,res);
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 if(req.method==='GET'&&req.url==='/api/health')return json(res,200,{ok:true,geminiConfigured:Boolean(process.env.GEMINI_API_KEY),storage:getSqliteStatus()});
 if(req.method==='POST'&&req.url==='/api/sync'){const result=await syncRecords(await jsonBody(req,5_000_000));return json(res,result.status,result.body)}
 if(req.method==='GET'&&req.url?.startsWith('/api/verify/')){const result=await verifyPublicLot(decodeURIComponent(req.url.slice('/api/verify/'.length)));return json(res,result.status,result.body)}
 if(req.method==='POST'&&req.url==='/api/transcribe')return await transcribe(req,res);
 if(req.method==='POST'&&req.url==='/api/extract')return await extract(req,res);
 if(req.method==='POST'&&req.url==='/api/advisor')return await advisor(req,res);
 if(await serveStatic(req,res))return;
 return json(res,404,{error:'Ruta no encontrada.'})
}catch(e){console.error('API error:',e);return json(res,e.status||500,{error:e.status?e.message:'Error interno del servidor.'})}});
server.listen(port,process.env.API_HOST||'127.0.0.1',()=>console.log(`PanelApp API listening on http://localhost:${port} · Gemini ${process.env.GEMINI_API_KEY?'configurado':'sin clave (revisa .env)'}`));


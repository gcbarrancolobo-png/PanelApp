import { cleanText } from './logbooks.ts';
type Req={id:string;accion_correctiva:string;fuentes?:{norma:string;articulo:string}[];pregunta_al_productor:string};
type Log={id:number;type:string;date:string;data:Record<string,any>};
export type PanelAlert={id:string;severity:'alta'|'media'|'aviso';title:string;detail:string;requirementId:string;action:string;sources:{norma:string;articulo:string}[]};
export function buildAlerts(logs:Log[],requirements:Req[],rules:any,establishmentType='trapiche',now:number=Date.now()):PanelAlert[]{
 const days=(date:string)=>{const d=new Date(`${date}T12:00:00`);return Number.isNaN(+d)?Infinity:Math.floor((now-d.getTime())/86400000)};
 const req=new Map(requirements.map(r=>[r.id,r]));const out:PanelAlert[]=[];
 const add=(id:string,severity:PanelAlert['severity'],title:string,detail:string,action?:string)=>{const r=req.get(id);if(!r)return;out.push({id:`${id}-${out.length}`,severity,title,detail,requirementId:id,action:action||r.accion_correctiva,sources:r.fuentes||[]})};
 const permitted=(rules?.aditivos_permitidos||[]).map(cleanText), prohibited=(rules?.aditivos_prohibidos||[]).map(cleanText);
 for(const log of logs.filter(x=>x.type==='molienda')){
  const items=String(log.data.aditivos||'').split(/[;,\n]+/).map(cleanText).filter(Boolean);
  for(const item of items){const ban=prohibited.find((term:string)=>item.includes(term));if(ban){if(/miel.*otro trapiche|mieles de otros trapiches/.test(ban)&&establishmentType==='central_acopio'){add('INS-03','media',`Mieles de otro trapiche: verifica autorización`,`El registro del ${log.date} menciona «${item}». En una central de acopio, confirma que las mieles provengan de trapiches y transporte autorizados.`);continue;}const id=/azucar|jarabe|miel/.test(ban)?'INS-03':'INS-02';add(id,'alta',`Aditivo de alto riesgo registrado: ${item}`,`Aparece en la molienda del ${log.date}, lote ${log.data.lote||'sin código'}. El registro requiere revisión inmediata.`);continue;}
   const allow=permitted.some((term:string)=>item.includes(term)||(term.includes('grasas y aceites')&&/aceite vegetal/.test(item))||(/poliacrilamidas/.test(term)&&/poliacrilamida/.test(item)));
   if(!allow)add('INS-01','media',`Aditivo no identificado en la lista: ${item}`,`La molienda del ${log.date}, lote ${log.data.lote||'sin código'}, contiene un insumo que no coincide con los permitidos del checklist.`);
  }
 }
 const labRules=rules?.laboratorio||{};
 for(const log of logs.filter(x=>x.type==='analisis_laboratorio')){
  const level=cleanText(log.data.presentacion)==='granulada'?'CAL-03':'CAL-02';const limits=labRules[level]||{};
  for(const [field,bound] of Object.entries(limits)){if(field==='presentacion')continue;const value=Number(log.data[field]);if(log.data[field]===''||log.data[field]===undefined||!Number.isFinite(value))continue;const b=bound as any;if(b.min!==undefined&&value<b.min)add(level,'alta',`${fieldLabel(field)} por debajo del límite`,`${value} registrado; mínimo del checklist: ${b.min}. Lote ${log.data.lote||'sin código'}.`);if(b.max!==undefined&&value>b.max)add(level,'alta',`${fieldLabel(field)} supera el límite`,`${value} registrado; máximo del checklist: ${b.max}. Lote ${log.data.lote||'sin código'}.`);}
  for(const field of ['so2','colorantes']){const v=cleanText(log.data[field]);if(v&&v!=='no analizado'&&v!=='negativo')add('CAL-04','alta',`${field==='so2'?'SO₂':'Colorantes'} con resultado positivo`,`El análisis del ${log.date}, lote ${log.data.lote||'sin código'}, reporta «${log.data[field]}».`);}
 }
 const period=rules?.periodos_alerta_dias||{};const trainingDays=Number(period.capacitacion)||365;
 const courses=logs.filter(x=>x.type==='capacitacion'&&days(x.date)<=trainingDays);const courseHours=courses.reduce((s,x)=>s+(Number(x.data.horas)||0),0);const minHours=Number(rules?.horas_capacitacion_anual_minimas)||10;
 if(!courses.length)add('BPM-10','alta','No hay capacitación registrada en el último año','Registra la capacitación del personal manipulador; verifica la duración y temas exigibles.');
 else if(courseHours<minHours)add('BPM-10','media',`Capacitación anual registrada por menos de ${minHours} horas`,`En los últimos 12 meses aparecen ${courseHours} horas. Revisa el plan y completa la formación necesaria.`);
 const waterDays=Number(period.analisis_agua)||365;const water=logs.filter(x=>x.type==='analisis_agua').sort((a,b)=>b.date.localeCompare(a.date))[0];
 if(!water)add('BPM-22','media','No hay análisis de agua registrado','Agrega el informe más reciente de calidad de agua utilizado en el establecimiento.');else if(days(water.date)>waterDays)add('BPM-22','media','El registro de análisis de agua está vencido',`Último registro: ${water.date}. El plazo de ${waterDays} días es un recordatorio orientativo de la app.`);
 const tankDays=Number(period.limpieza_tanque)||365;const tank=logs.filter(x=>x.type==='tanque_agua').sort((a,b)=>b.date.localeCompare(a.date))[0];
 if(!tank)add('BPM-22','media','No hay limpieza de tanque registrada','Registra la limpieza y desinfección del tanque de agua.');else if(days(tank.date)>tankDays)add('BPM-22','aviso','La limpieza del tanque necesita revisión',`Último registro: ${tank.date}. El plazo de ${tankDays} días es un recordatorio orientativo, no un plazo legal general.`);
 return out;
}
function fieldLabel(key:string){return ({azucares_reductores_pct:'Azúcares reductores',azucares_no_reductores_pct:'Azúcares no reductores',proteinas_pct:'Proteínas',cenizas_pct:'Cenizas',humedad_pct:'Humedad',plomo_mgkg:'Plomo',arsenico_mgkg:'Arsénico'} as Record<string,string>)[key]||key}

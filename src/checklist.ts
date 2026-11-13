export type RequirementSource = { norma: string; articulo: string; url?: string };
export type Requirement = {
  id: string;
  categoria: string;
  pregunta_al_productor: string;
  evidencia_requerida: string;
  criticidad: 'critica' | 'mayor' | 'menor';
  accion_correctiva: string;
  fuentes: RequirementSource[];
  caracter: string;
  modulo?: string;
  origen_del_requisito: string;
  condicion_de_aplicabilidad: string | null;
  aplica_si: Record<string, unknown>;
  estado_validacion?: string;
};
export type Checklist = { metadata: Record<string, any>; requisitos: Requirement[] };

export function validateChecklist(value: unknown): string | null {
  const checklist = value as any;
  if (!checklist || typeof checklist !== 'object' || !checklist.metadata || typeof checklist.metadata !== 'object' || !Array.isArray(checklist.requisitos)) {
    return 'El checklist debe contener metadata y una lista requisitos.';
  }
  if (checklist.requisitos.length < 68) return `El checklist está incompleto: se encontraron ${checklist.requisitos.length} requisitos; se requieren al menos 68.`;
  const ids = new Set<string>();
  for (const [index, item] of checklist.requisitos.entries()) {
    const label = typeof item?.id === 'string' ? item.id : `requisito ${index + 1}`;
    for (const field of ['id', 'categoria', 'pregunta_al_productor', 'evidencia_requerida', 'criticidad', 'accion_correctiva', 'fuentes', 'caracter', 'origen_del_requisito', 'condicion_de_aplicabilidad', 'aplica_si']) {
      if (!(field in (item || {}))) return `${label}: falta el campo «${field}».`;
    }
    for (const field of ['id', 'categoria', 'pregunta_al_productor', 'evidencia_requerida', 'accion_correctiva', 'caracter', 'origen_del_requisito']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) return `${label}: «${field}» debe ser texto y no puede estar vacío.`;
    }
    if (ids.has(item.id)) return `Identificador repetido: ${item.id}.`;
    ids.add(item.id);
    if (!['critica', 'mayor', 'menor'].includes(item.criticidad)) return `${label}: criticidad inválida.`;
    if (!Array.isArray(item.fuentes) || item.fuentes.some((source: any) => !source || typeof source.norma !== 'string' || typeof source.articulo !== 'string')) return `${label}: cada fuente debe incluir norma y artículo.`;
    if (!item.aplica_si || typeof item.aplica_si !== 'object' || Array.isArray(item.aplica_si)) return `${label}: «aplica_si» debe ser un objeto.`;
    if (item.condicion_de_aplicabilidad !== null && typeof item.condicion_de_aplicabilidad !== 'string') return `${label}: «condicion_de_aplicabilidad» debe ser texto o null.`;
  }
  return null;
}

const stopWords = new Set('a al algo alguna algunas alguno algunos ante bajo cada como con contra cual cuando de del desde donde durante e el ella en entre era es esa ese esta este esto fue ha hasta la las le les lo los mas me mi muy no o para pero por porque que quien se sin sobre su sus te tu un una uno unas unos y ya debo deberia deseo necesito quiero puede pueden podria revisar asegurar garantizar saber conocer hacer uso usar usan sea trapiche panela elaboracion'.split(' '));
export function normalizeText(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
export function searchRequirements(query: string, requirements: Requirement[], limit = 8): Requirement[] {
  const normalized = normalizeText(query).trim();
  if (!normalized) return [];
  const sourceTerms = normalized.split(/[^a-z0-9]+/).filter(term => term.length > 1 && !stopWords.has(term));
  const terms = new Set(sourceTerms);
  const expansions: Record<string, string[]> = {
    agua: ['potable', 'calidad', 'tanque', 'fuente', 'abastecimiento', 'higienizar'],
    potable: ['agua', 'calidad', 'tanque', 'fuente', 'microbiologico'],
    apta: ['potable', 'calidad', 'higienizar'],
    apto: ['potable', 'calidad', 'higienizar'],
    tanque: ['agua', 'limpieza', 'desinfeccion', 'calidad'],
    laboratorio: ['analisis', 'resultado', 'muestra'],
  };
  for (const term of sourceTerms) for (const related of expansions[term] || []) terms.add(related);
  const ranked = requirements.map(requirement => {
    const weightedText: [string, number][] = [
      [requirement.pregunta_al_productor, 5],
      [requirement.accion_correctiva, 3],
      [requirement.evidencia_requerida, 2],
      [requirement.condicion_de_aplicabilidad || '', 1],
      [requirement.categoria, 0.5],
      ...requirement.fuentes.flatMap(source => [[source.norma, 0.25], [source.articulo, 0.5]] as [string, number][]),
    ];
    const id = normalizeText(requirement.id);
    const exactId = normalized === normalizeText(requirement.id);
    const score = (exactId ? 100 : 0) + weightedText.reduce((sum, [content, weight]) => {
      const text = normalizeText(content);
      return sum + [...terms].reduce((subtotal, term) => subtotal + (text.includes(term) ? weight : 0), 0);
    }, 0)
      // Give domain terms more weight than generic words such as "proceso" or "establecimiento".
      + (terms.has('agua') && /agua|potable|tanque|abastecimiento|calidad del agua/i.test(normalizeText(requirement.pregunta_al_productor + ' ' + requirement.evidencia_requerida)) ? 18 : 0)
      + ([...terms].some(term => id.includes(term)) ? 8 : 0);
    return { requirement, score };
  }).filter(result => result.score > 0);
  ranked.sort((a, b) => b.score - a.score || a.requirement.id.localeCompare(b.requirement.id));
  return ranked.slice(0, limit).map(result => result.requirement);
}

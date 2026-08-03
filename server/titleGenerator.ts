/**
 * 合规标题自动生成器
 *
 * 目标：不复制竞品标题，而是从竞品标题中「提取结构化要素」（品类词、规格、材质、颜色、数量），
 * 再用自己的模板与修饰词重新组装，生成西语(MLM/MLC/MCO)或葡语(MLB)标题。
 * 同时计算与原标题的相似度，超过阈值会告警，确保不是换皮抄袭。
 *
 * 合规说明：品类名词属于通用词汇，不受著作权保护；受保护的是原创的表达组合。
 * 本模块通过「拆解 → 去修饰 → 重组 + 自有卖点词」保证生成结果是你自己的表达。
 */

export type Lang = 'es' | 'pt';

/** 站点 → 语言 */
export function langOfSite(site: string): Lang {
  return (site || '').toUpperCase() === 'MLB' ? 'pt' : 'es';
}

// ============ 词库 ============
// 通用卖点修饰词（自有表达，用于替换竞品的营销词）
const SELLING_POINTS: Record<Lang, string[]> = {
  es: [
    'Resistente', 'Duradero', 'Portátil', 'Plegable', 'Antideslizante', 'Impermeable',
    'Multifuncional', 'Ajustable', 'Ligero', 'Ergonómico', 'Compacto', 'Reutilizable',
    'Fácil de Limpiar', 'Alta Calidad', 'Uso Diario', 'Ahorra Espacio',
  ],
  pt: [
    'Resistente', 'Durável', 'Portátil', 'Dobrável', 'Antiderrapante', 'Impermeável',
    'Multifuncional', 'Ajustável', 'Leve', 'Ergonômico', 'Compacto', 'Reutilizável',
    'Fácil de Limpar', 'Alta Qualidade', 'Uso Diário', 'Economiza Espaço',
  ],
};

// 使用场景词
const SCENES: Record<Lang, string[]> = {
  es: ['para Casa', 'para Cocina', 'para Oficina', 'para Baño', 'para Auto', 'para Viaje', 'para Gimnasio', 'para Jardín'],
  pt: ['para Casa', 'para Cozinha', 'para Escritório', 'para Banheiro', 'para Carro', 'para Viagem', 'para Academia', 'para Jardim'],
};

// 需要从竞品标题中剔除的营销/促销词（这些是竞品的表达，不要沿用）
const STOP_WORDS: Record<Lang, string[]> = {
  es: [
    'envio', 'envío', 'gratis', 'oferta', 'promocion', 'promoción', 'descuento', 'barato',
    'nuevo', 'nueva', 'original', 'garantia', 'garantía', 'calidad', 'premium', 'super',
    'mejor', 'top', 'venta', 'liquidacion', 'liquidación', 'oportunidad', 'importado',
    'unidades', 'unidad', 'pza', 'pzas', 'envios', 'rapido', 'rápido', 'stock',
    'de', 'la', 'el', 'los', 'las', 'y', 'con', 'para', 'en', 'un', 'una', 'por', 'del', 'al',
  ],
  pt: [
    'frete', 'gratis', 'grátis', 'oferta', 'promocao', 'promoção', 'desconto', 'barato',
    'novo', 'nova', 'original', 'garantia', 'qualidade', 'premium', 'super', 'melhor',
    'top', 'venda', 'liquidacao', 'liquidação', 'importado', 'unidades', 'unidade',
    'pronta', 'entrega', 'estoque', 'rapido', 'rápido', 'envio',
    'de', 'da', 'do', 'a', 'o', 'os', 'as', 'e', 'com', 'para', 'em', 'um', 'uma', 'por',
  ],
};

// 颜色词（保留，属客观描述）
const COLORS: Record<Lang, string[]> = {
  es: ['negro', 'blanco', 'rojo', 'azul', 'verde', 'amarillo', 'rosa', 'gris', 'morado', 'naranja', 'beige', 'dorado', 'plateado', 'transparente'],
  pt: ['preto', 'branco', 'vermelho', 'azul', 'verde', 'amarelo', 'rosa', 'cinza', 'roxo', 'laranja', 'bege', 'dourado', 'prateado', 'transparente'],
};

// 材质词（保留，属客观描述）
const MATERIALS: Record<Lang, string[]> = {
  es: ['acero', 'inoxidable', 'plastico', 'plástico', 'silicona', 'madera', 'vidrio', 'aluminio', 'algodon', 'algodón', 'cuero', 'nylon', 'bambu', 'bambú', 'ceramica', 'cerámica'],
  pt: ['aco', 'aço', 'inox', 'plastico', 'plástico', 'silicone', 'madeira', 'vidro', 'aluminio', 'alumínio', 'algodao', 'algodão', 'couro', 'nylon', 'bambu', 'ceramica', 'cerâmica'],
};

// ============ 解析 ============
export interface TitleElements {
  /** 品类核心词（前 1~3 个有效名词） */
  coreWords: string[];
  colors: string[];
  materials: string[];
  /** 规格数字，如 500ml / 20cm / 3 pcs */
  specs: string[];
  /** 数量，如 x2 / 3 pzas */
  quantity: string;
}

function normalize(s: string): string {
  return (s || '')
    .replace(/[^\p{L}\p{N}\s.,/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从竞品标题拆出结构化要素（只取客观信息，剔除营销表达） */
export function parseTitle(competitorTitle: string, lang: Lang): TitleElements {
  const norm = normalize(competitorTitle);
  const lower = norm.toLowerCase();
  const tokens = lower.split(' ').filter(Boolean);
  const stop = new Set(STOP_WORDS[lang]);

  // 规格：带单位的数字
  const specs = Array.from(
    new Set((norm.match(/\d+[.,]?\d*\s?(ml|l|cm|mm|m|kg|g|w|v|"|pulgadas|polegadas|litros?|litro)/gi) || []).map((s) => s.trim()))
  ).slice(0, 3);

  // 数量：x2 / 2 pcs / 3 piezas / kit 4
  const qtyMatch = norm.match(/(?:x\s?\d+|\d+\s?(?:pcs|pzas?|piezas?|pe[çc]as?|unidades?|pack|kit))/i);
  const quantity = qtyMatch ? qtyMatch[0].trim() : '';

  const colorSet = new Set(COLORS[lang]);
  const matSet = new Set(MATERIALS[lang]);
  const colors: string[] = [];
  const materials: string[] = [];
  const coreWords: string[] = [];

  for (const t of tokens) {
    const clean = t.replace(/[.,]/g, '');
    if (!clean || clean.length < 3) continue;
    if (/^\d/.test(clean)) continue;
    if (colorSet.has(clean)) {
      if (!colors.includes(clean)) colors.push(clean);
      continue;
    }
    if (matSet.has(clean)) {
      if (!materials.includes(clean)) materials.push(clean);
      continue;
    }
    if (stop.has(clean)) continue;
    if (!coreWords.includes(clean)) coreWords.push(clean);
  }

  return {
    coreWords: coreWords.slice(0, 3),
    colors: colors.slice(0, 1),
    materials: materials.slice(0, 2),
    specs,
    quantity,
  };
}

// ============ 生成 ============
function capitalize(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** Jaccard 词集相似度，用于判断是否过于接近原标题 */
export function titleSimilarity(a: string, b: string): number {
  const setA = new Set(normalize(a).toLowerCase().split(' ').filter((w) => w.length > 2));
  const setB = new Set(normalize(b).toLowerCase().split(' ').filter((w) => w.length > 2));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  setA.forEach((w) => {
    if (setB.has(w)) inter++;
  });
  return inter / (setA.size + setB.size - inter);
}

export interface GeneratedTitle {
  title: string;
  length: number;
  /** 与竞品原标题的相似度 0~1，越低越安全 */
  similarity: number;
  /** 相似度是否在安全范围（<0.5） */
  safe: boolean;
}

export interface GenerateTitleOptions {
  competitorTitle: string;
  site: string;
  /** 你自己的品牌，默认 Generic 时不写入标题 */
  brand?: string;
  /** 额外自定义卖点词，会优先使用 */
  customPoints?: string[];
  /** 生成几个候选，默认 3 */
  count?: number;
  /** ML 标题上限 60 字符 */
  maxLength?: number;
}

/**
 * 生成候选标题（不含品牌词时更安全，避免误触品牌校验）
 * 模板（避免与竞品语序雷同）：
 *  A: [卖点] [品类] [材质] [规格] [场景]
 *  B: [品类] [材质] [卖点] [数量] [颜色]
 *  C: [品类] [规格] [卖点1] [卖点2] [场景]
 */
export function generateTitles(opts: GenerateTitleOptions): GeneratedTitle[] {
  const lang = langOfSite(opts.site);
  const maxLength = opts.maxLength ?? 60;
  const count = opts.count ?? 3;
  const el = parseTitle(opts.competitorTitle, lang);

  const points = (opts.customPoints && opts.customPoints.length ? opts.customPoints : SELLING_POINTS[lang]);
  const scenes = SCENES[lang];
  const core = el.coreWords.map(capitalize).join(' ') || (lang === 'es' ? 'Producto' : 'Produto');
  const mat = el.materials.map(capitalize).join(' ');
  const color = el.colors.map(capitalize).join(' ');
  const spec = el.specs.join(' ');
  const qty = el.quantity;
  const brandPart = opts.brand && opts.brand.toLowerCase() !== 'generic' ? opts.brand : '';

  // 用标题内容做确定性种子，保证同一商品每次生成一致
  const seed = Array.from(opts.competitorTitle).reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = (arr: string[], offset: number) => arr[(seed + offset) % arr.length];

  const templates: string[][] = [
    [brandPart, pick(points, 0), core, mat, spec, pick(scenes, 1)],
    [brandPart, core, mat, pick(points, 2), qty, color],
    [brandPart, core, spec, pick(points, 3), pick(points, 5), pick(scenes, 4)],
    [brandPart, pick(points, 6), core, color, qty, pick(scenes, 7)],
  ];

  const out: GeneratedTitle[] = [];
  const seen = new Set<string>();
  for (const parts of templates) {
    let title = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (title.length > maxLength) title = title.slice(0, maxLength).replace(/\s+\S*$/, '');
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const similarity = titleSimilarity(title, opts.competitorTitle);
    out.push({
      title,
      length: title.length,
      similarity: Math.round(similarity * 100) / 100,
      safe: similarity < 0.5,
    });
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 违禁词 / 侵权词检查（按参考文档 bannedWordsChecker 设计）
 * - 西语/葡语平台违禁词（夸大宣传、医疗功效、假货暗示等）
 * - 品牌黑名单（侵权高危词）
 * 用于 M3 上架预检与 M1/M2 自动筛选流水线。
 */

// 品牌黑名单（侵权高危，命中即拦截）
export const BRAND_BLACKLIST = [
  'nike', 'adidas', 'apple', 'iphone', 'airpods', 'sony', 'samsung', 'disney', 'lego',
  'cartier', 'gucci', 'louis vuitton', 'lv', 'chanel', 'puma', 'reebok', 'new balance',
  'xiaomi', 'huawei', 'rolex', 'hermes', 'prada', 'burberry', 'zara', 'uniqlo', 'tesla',
  'canon', 'nikon', 'bosch', 'philips', 'lenovo', 'asus', 'acer', 'msi', 'intel', 'amd',
  'logitech', 'jbl', 'beats', 'rayban', 'ray-ban', 'oakley', 'microsoft', 'google',
  'starbucks', 'coca-cola', 'coca cola', 'nintendo', 'playstation', 'xbox', 'marvel',
  'pokemon', 'pokémon', 'hello kitty', 'barbie', 'crocs', 'dyson', 'stanley', 'yeti',
  'north face', 'levis', "levi's", 'vans', 'converse', 'swarovski', 'pandora', 'casio',
  'seiko', 'fossil', 'michael kors', 'coach', 'kate spade', 'tommy hilfiger',
  'calvin klein', 'lacoste', 'champion', 'fila', 'under armour', 'skechers', 'timberland',
];

// 西语（MLM/MLC/MCO）平台违禁 / 高风险词
export const BANNED_WORDS_ES = [
  // 假货 / 仿品暗示
  'replica', 'réplica', 'imitacion', 'imitación', 'falsificado', 'copia original',
  'tipo original', 'clon', 'aaa calidad', 'calidad aaa', '1:1',
  // 医疗 / 疗效夸大（需资质）
  'cura', 'curativo', 'medicinal', 'terapeutico', 'terapéutico', 'antibacterial certificado',
  'adelgazante milagroso', 'pierde peso garantizado', 'anticancer', 'anticáncer',
  'covid', 'coronavirus',
  // 绝对化 / 违规宣传
  'el mejor del mundo', '100% garantizado', 'milagroso', 'gratis envio falso',
  // 违禁品类词
  'arma', 'municion', 'munición', 'cigarrillo', 'tabaco', 'vape', 'vaporizador nicotina',
  'medicamento', 'receta medica', 'receta médica',
];

// 葡语（MLB）平台违禁 / 高风险词
export const BANNED_WORDS_PT = [
  'replica', 'réplica', 'imitacao', 'imitação', 'falsificado', 'copia original',
  'cópia original', 'clone', 'qualidade aaa', '1:1', 'paralelo original',
  'cura', 'curativo', 'medicinal', 'terapeutico', 'terapêutico',
  'emagrecedor milagroso', 'perde peso garantido', 'anticancer', 'anticâncer',
  'covid', 'coronavirus', 'coronavírus',
  'o melhor do mundo', '100% garantido', 'milagroso',
  'arma', 'municao', 'munição', 'cigarro', 'tabaco', 'vape', 'vaporizador nicotina',
  'medicamento', 'receita medica', 'receita médica', 'anvisa nao aprovado',
];

export interface BannedCheckResult {
  ok: boolean;
  brandHits: string[];
  wordHits: string[];
  message: string;
}

/** 边界匹配，避免 'lv' 命中 'silver' 之类的误报 */
function containsWord(text: string, word: string): boolean {
  if (word.length <= 3 && !word.includes(' ')) {
    const re = new RegExp(`(^|[^a-z0-9á-úà-ũç])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9á-úà-ũç])`, 'i');
    return re.test(text);
  }
  return text.includes(word);
}

/**
 * 检查文本（标题/描述/品牌）中的违禁词与品牌词
 * @param site 站点代码，MLB 用葡语词表，其余用西语词表（同时都查品牌黑名单）
 */
export function checkBannedWords(text: string, site?: string): BannedCheckResult {
  const lower = (text || '').toLowerCase();
  const brandHits: string[] = [];
  const wordHits: string[] = [];

  for (const b of BRAND_BLACKLIST) {
    if (containsWord(lower, b)) brandHits.push(b);
  }
  const wordList = (site || '').toUpperCase() === 'MLB' ? BANNED_WORDS_PT : BANNED_WORDS_ES;
  for (const w of wordList) {
    if (containsWord(lower, w)) wordHits.push(w);
  }

  const ok = brandHits.length === 0 && wordHits.length === 0;
  const parts: string[] = [];
  if (brandHits.length) parts.push(`品牌侵权词 ${brandHits.length} 个：${brandHits.join(', ')}`);
  if (wordHits.length) parts.push(`平台违禁词 ${wordHits.length} 个：${wordHits.join(', ')}`);
  return {
    ok,
    brandHits,
    wordHits,
    message: ok ? '未命中违禁词' : parts.join('；'),
  };
}

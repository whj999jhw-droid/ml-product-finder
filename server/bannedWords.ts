/**
 * 违禁词 / 侵权词检查（按参考文档 bannedWordsChecker 设计）
 * - 西语/葡语平台违禁词（夸大宣传、医疗功效、假货暗示等）
 * - 品牌黑名单（侵权高危词）
 * - **影视/动漫/游戏 IP 黑名单**（2026-09 实测：ML 主动检测的最大受害类别）
 * - **体育赛事 / 球星 / 俱乐部黑名单**（2026 世界杯在北美，FIFA 维权最凶）
 * 用于 M3 上架预检与 M1/M2 自动筛选流水线。
 *
 * 数据来源：2026-09-16 全店 6628 件商品扫描 + 19 条真实被删案件实证。
 */

// 品牌黑名单（侵权高危，命中即拦截）
export const BRAND_BLACKLIST = [
  'nike', 'adidas', 'apple', 'iphone', 'ipad', 'airpods', 'lightning', 'sony', 'samsung',
  'galaxy', 'disney', 'lego', 'cartier', 'gucci', 'louis vuitton', 'lv', 'chanel', 'dior',
  'puma', 'reebok', 'new balance', 'xiaomi', 'huawei', 'rolex', 'hermes', 'prada',
  'burberry', 'zara', 'uniqlo', 'tesla', 'canon', 'nikon', 'bosch', 'philips', 'lenovo',
  'asus', 'acer', 'msi', 'intel', 'amd', 'logitech', 'jbl', 'beats', 'rayban', 'ray-ban',
  'oakley', 'microsoft', 'google', 'starbucks', 'coca-cola', 'coca cola', 'nintendo',
  'playstation', 'xbox', 'marvel', 'pokemon', 'pokémon', 'hello kitty', 'barbie', 'crocs',
  'dyson', 'stanley', 'yeti', 'north face', 'levis', "levi's", 'vans', 'converse',
  'swarovski', 'pandora', 'casio', 'seiko', 'fossil', 'michael kors', 'coach',
  'kate spade', 'tommy hilfiger', 'calvin klein', 'lacoste', 'champion', 'fila',
  'under armour', 'skechers', 'timberland',
];

/**
 * 影视 / 动漫 / 游戏 IP 黑名单
 * 实证：Kpop Demon Hunters(Huntrix) 单店 135 件被删、蜘蛛侠 38 件。
 * 这类商品卖的就是 IP 本身，改标题也没用 —— 只能不卖。
 */
export const IP_BLACKLIST = [
  // 影视
  'kpop demon hunters', 'demon hunters', 'huntrix', 'saja boys', 'netflix',
  'squid game', 'squidgame', 'stranger things', 'disney', 'mickey', 'minnie',
  'zootopia', 'frozen', 'elsa', 'moana', 'stitch', 'lilo', 'olaf', 'simba',
  'rey leon', 'rey león', 'lion king', 'mulan', 'aladdin', 'encanto', 'winnie',
  'pooh', 'marvel', 'avengers', 'iron man', 'spider-man', 'spiderman', 'spider man',
  'hulk', 'thor', 'captain america', 'black widow', 'loki', 'deadpool', 'wolverine',
  'x-men', 'venom', 'black panther', 'doctor strange', 'star wars', 'darth vader',
  'mandalorian', 'baby yoda', 'grogu', 'batman', 'superman', 'wonder woman',
  'harley quinn', 'joker',
  // 日漫
  'pokemon', 'pokémon', 'pikachu', 'nintendo', 'super mario', 'mario bros', 'luigi',
  'zelda', 'sonic', 'naruto', 'sasuke', 'kakashi', 'dragon ball', 'goku', 'vegeta',
  'one piece', 'luffy', 'zoro', 'demon slayer', 'kimetsu no yaiba', 'tanjiro',
  'attack on titan', 'eren', 'jujutsu kaisen', 'gojo', 'sailor moon', 'totoro',
  'ghibli', 'spirited away', 'doraemon', 'anpanman', 'crayon shin', 'shin-chan',
  // 卡通 / 儿童 IP
  'sanrio', 'hello kitty', 'kuromi', 'cinnamoroll', 'my melody', 'gudetama',
  'rilakkuma', 'peppa pig', 'paw patrol', 'bluey', 'cocomelon', 'baby shark',
  'minions', 'despicable me', 'shrek', 'madagascar', 'kung fu panda', 'toothless',
  'transformers', 'bumblebee', 'optimus prime', 'barbie', 'monster high',
  'hot wheels', 'thomas tank', 'ben 10', 'miraculous', 'ladybug', 'smurfs',
  'looney tunes', 'bugs bunny', 'tom and jerry', 'scooby doo', 'sesame street',
  'elmo', 'care bears', 'my little pony',
  // 游戏
  'minecraft', 'roblox', 'fortnite', 'among us', 'brawl stars', 'free fire',
];

/**
 * 体育赛事 / 球星 / 俱乐部黑名单
 * 实证：19 条被删案件中 12 条是世界杯周边（Copa Mundial 2026、奖杯、吉祥物、球员形象）。
 * FIFA 是 ML 品牌保护计划成员，2026 世界杯在北美举办，维权力度最高。
 */
export const SPORTS_BLACKLIST = [
  // 赛事
  'world cup', 'worldcup', 'copa mundial', 'mundial 2026', 'copa del mundo',
  'fifa', 'copa america', 'copa américa', 'champions league', 'libertadores',
  'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'nba', 'nfl',
  'formula 1', 'formula1', 'f1 ', 'grand prix',
  // 球星（肖像权 / 姓名权）
  'messi', 'cristiano ronaldo', 'ronaldo', 'cr7', 'neymar', 'mbappe', 'mbappé',
  'haaland', 'modric', 'pele', 'pelé', 'maradona', 'vinicius', 'vinícius',
  'kylian', 'bellingham', 'salah', 'kane', 'lewandowski',
  // 俱乐部
  'real madrid', 'barcelona', 'bayern', 'chelsea', 'manchester united',
  'manchester city', 'liverpool', 'juventus', 'psg', 'paris saint-germain',
  'arsenal', 'borussia', 'atletico madrid', 'atlético madrid', 'flamengo',
  'boca juniors', 'river plate', 'seleccion', 'selección',
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

/** 分词库命中结果（品牌 / 影视动漫游戏 IP / 体育 / 平台违禁词分开记） */
export interface CategorizedHits {
  brand: string[];
  ip: string[];
  sports: string[];
  platform: string[];
}

/**
 * 把文本按「四类词库」分别命中一次，返回各类命中词。
 *
 * 为什么要分类：处置方式完全不同 ——
 *  - brand（品牌词，如数据线 Model 写了 Apple）：**可洗**，删词换通用说法即可继续卖；
 *  - ip / sports（卖的就是 IP 本身，如蜘蛛侠帽子、世界杯围巾）：**改名字也侵权**，只能下架；
 *  - platform（西/葡语夸大宣传、医疗功效等）：**可洗**。
 */
export function categorizeHits(text: string, site?: string): CategorizedHits {
  const lower = (text || '').toLowerCase();
  const out: CategorizedHits = { brand: [], ip: [], sports: [], platform: [] };
  for (const b of BRAND_BLACKLIST) if (containsWord(lower, b)) out.brand.push(b);
  for (const b of IP_BLACKLIST) if (containsWord(lower, b) && !out.brand.includes(b)) out.ip.push(b);
  for (const b of SPORTS_BLACKLIST) if (containsWord(lower, b) && !out.brand.includes(b) && !out.ip.includes(b)) out.sports.push(b);
  const wordList = (site || '').toUpperCase() === 'MLB' ? BANNED_WORDS_PT : BANNED_WORDS_ES;
  for (const w of wordList) if (containsWord(lower, w)) out.platform.push(w);
  return out;
}

/** 四类词库全集（供索引扫描做批量预筛，避免逐字段跑正则） */
export const ALL_RISK_WORDS: string[] = Array.from(
  new Set([...BRAND_BLACKLIST, ...IP_BLACKLIST, ...SPORTS_BLACKLIST, ...BANNED_WORDS_ES, ...BANNED_WORDS_PT]),
);

/**
 * 判断文本是否命中任意风险词（含短词词边界校验）。
 * 走「先 includes 粗筛 → 再边界校验」的快路径，索引扫描 6000+ 商品时用这个。
 */
export function hitsAnyRiskWord(lowerText: string, word: string): boolean {
  if (!lowerText.includes(word)) return false;
  return containsWord(lowerText, word);
}

/**
 * 边界匹配，避免 'lv' 命中 'silver'、'acer' 命中西语 'acero'(钢)、
 * 'fila' 命中西语 'fila'(行) 之类的误报。
 * 长度 <=4 且不含空格的词一律走严格词边界。
 */
const SHORT_WORD_RE = new Map<string, RegExp>();
function shortWordRe(w: string): RegExp {
  let re = SHORT_WORD_RE.get(w);
  if (!re) {
    re = new RegExp(
      `(^|[^a-z0-9á-úà-ũç])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9á-úà-ũç])`,
      'i'
    );
    SHORT_WORD_RE.set(w, re);
  }
  return re;
}

function containsWord(text: string, word: string): boolean {
  const w = word.trim();
  if (!w) return false;
  if (w.length <= 4 && !w.includes(' ')) return shortWordRe(w).test(text);
  return text.includes(w);
}

/**
 * 检查文本（标题/描述/品牌/属性）中的违禁词、品牌词、IP 词、体育词
 * @param site 站点代码，MLB 用葡语词表，其余用西语词表（其他三类词表都查）
 */
export function checkBannedWords(text: string, site?: string): BannedCheckResult {
  const lower = (text || '').toLowerCase();
  const brandHits: string[] = [];
  const wordHits: string[] = [];

  // 侵权类（品牌 / IP / 体育）统一归到 brandHits，调用方无需改动即可生效
  for (const b of BRAND_BLACKLIST) if (containsWord(lower, b)) brandHits.push(b);
  for (const b of IP_BLACKLIST) if (containsWord(lower, b) && !brandHits.includes(b)) brandHits.push(b);
  for (const b of SPORTS_BLACKLIST) if (containsWord(lower, b) && !brandHits.includes(b)) brandHits.push(b);

  const wordList = (site || '').toUpperCase() === 'MLB' ? BANNED_WORDS_PT : BANNED_WORDS_ES;
  for (const w of wordList) {
    if (containsWord(lower, w)) wordHits.push(w);
  }

  const ok = brandHits.length === 0 && wordHits.length === 0;
  const parts: string[] = [];
  if (brandHits.length) parts.push(`侵权词(品牌/IP/体育) ${brandHits.length} 个：${brandHits.join(', ')}`);
  if (wordHits.length) parts.push(`平台违禁词 ${wordHits.length} 个：${wordHits.join(', ')}`);
  return {
    ok,
    brandHits,
    wordHits,
    message: ok ? '未命中违禁词' : parts.join('；'),
  };
}

/**
 * 清洗标题中的侵权词（用于发布前兜底）
 * 注意：影视/体育 IP 类商品「改名字也侵权」（卖的就是 IP 本身），
 * 所以清洗只适用于【通用商品误写品牌词】的场景（如数据线 Model 写了 Apple），
 * 调用方必须先判断命中的是品牌词还是 IP 词，IP 词应当直接拦截而不是清洗。
 */
export function sanitizeTitle(title: string): string {
  let out = title || '';
  const replaceMap: Array<[RegExp, string]> = [
    [/\blightning\b/gi, '8 Pin'],
    [/\biphone\b/gi, 'Smartphone'],
    [/\bapple\b/gi, 'Universal'],
    [/\bsamsung\b/gi, 'Universal'],
  ];
  for (const [re, to] of replaceMap) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, ' ').replace(/\s*\(\s*\)/g, '').trim();
}

// ===== 「一键改为符合规范」用的强清洗 =====
// 与 sanitizeTitle 的区别：这里要**清干净**品牌/商标/平台违禁词，供克隆重发或直接提交 ML 使用。
// 只处理「可洗」的词（品牌词、平台违禁词）；IP / 体育词属不可洗，调用方必须先判断 fixable。

// ⚠️ 只删「真正的品牌/商标名」。
// 不要把蓝牙(Bluetooth)、USB-C/Type-C/Micro USB 这类**通用标准名**放进来 —— 它们不是侵权词，
// 删掉只会让标题变得不可读（早期脚本曾误删，导致 "Cable ," 这种残句）。
const BRAND_TOKEN_RE =
  /\b(apple|iphone|ipad|airpods|macbook|samsung|galaxy|huawei|xiaomi|honor|redmi|oppo|vivo|oneplus|pixel|nike|adidas|puma|reebok|new balance|asics|under armour|skechers|timberland|crocs|gucci|chanel|dior|prada|louis vuitton|rolex|cartier|disney|lego|barbie|hello kitty|pokemon|pokémon|marvel|nintendo|playstation|xbox|lightning|thunderbolt|mag ?safe)\b/gi;
// 接口/技术商标 → 通用说法（保留可读性，不留下悬空连接词）
const BRAND_REPLACE: Array<[RegExp, string]> = [
  [/\blightning\b/gi, '8 Pin'],
  [/\bthunderbolt\b/gi, 'High Speed'],
  [/\bmag ?safe\b/gi, 'Magnetic'],
  [/\btype-?c\b/gi, 'Type-C'],
  [/\bmicro ?usb\b/gi, 'Micro USB'],
  [/\busb-?c\b/gi, 'USB-C'],
];

/** 清洗单段文本：替换接口商标 → 删除品牌词 → 收拾残留标点/悬空连接词 */
export function sanitizeComplianceText(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  for (const [re, to] of BRAND_REPLACE) s = s.replace(re, to);
  s = s.replace(BRAND_TOKEN_RE, ' ');
  // 清掉品牌词后常见的悬空连接词/标点：", ," / "para ," / "to Android" 等
  s = s
    .replace(/\s*\(\s*\)/g, '')
    .replace(/^\s*(to|for|and|with|de|para|y|con)\b\s*/i, '')
    .replace(/\b(to|for|and|de|para|y|con)\s*(?=[,;]|$)/gi, '')
    .replace(/\s*,\s*(?=[,;]|$)/g, '')
    .replace(/,{2,}/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:+\-]+|[\s,;:+\-]+$/g, '')
    .replace(/\s+,/g, ',');

  // 平台违禁词（西/葡语宣传词、医疗词）整段剔除
  for (const w of ALL_RISK_WORDS) {
    if (w.length > 4 || w.includes(' ')) {
      if (s.toLowerCase().includes(w)) s = s.replace(new RegExp(escapeRe(w), 'gi'), ' ');
    }
  }
  return s.replace(/\s{2,}/g, ' ').replace(/\s*,\s*(?=[,;]|$)/g, '').replace(/^[\s,;:+\-]+|[\s,;:+\-]+$/g, '').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

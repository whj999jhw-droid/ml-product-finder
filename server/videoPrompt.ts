/**
 * server/videoPrompt.ts
 * 商品视频的动作指令（prompt）生成。
 *
 * 为什么单独一个文件：
 *   之前 `i2v.ts` 里是一句写死的通用旁白（「镜头极缓慢推近……」），对任何商品都一模一样。
 *   用户明确要求「视频一定要与商品有关、无水印、最好能吸引顾客来买」，
 *   所以这里按**商品标题识别品类**，输出贴合该品类的运镜与呈现意图，
 *   并把「不出现文字/水印」写成硬约束（美客多 Clips 会拒收带文字/水印的视频）。
 *
 * 设计取舍：
 *   - 规则表为主（零成本、零延迟、可预测），LLM 润色为可选增强，失败静默降级。
 *   - 每个品类给多个变体轮换，避免同一批视频动作雷同。
 */

/** 品类 → 动作描述（每件商品随机取一条，避免整批雷同） */
interface CategoryRule {
  id: string;
  /** 匹配关键词（小写；标题里命中任一即可） */
  keywords: string[];
  motions: string[];
}

/** 注意：标题可能是西语 / 葡语 / 英语，三种都要覆盖常见写法 */
const RULES: CategoryRule[] = [
  {
    id: 'clothing',
    keywords: [
      'vestido', 'camisa', 'camiseta', 'camiseta', 'playera', 'remera', 'polera', 'blusa', 'top',
      'pantalon', 'pantalón', 'pantalones', 'short', 'shorts', 'bermuda', 'falda', 'pollera',
      'abrigo', 'chamarra', 'chaqueta', 'campera', 'sudadera', 'hoodie', 'jersey', 'sweater',
      'ropa', 'ropa interior', 'pijama', 'suit', 'traje', 'kimono', 'bata', 'chaleco', 'saco',
      'dress', 'shirt', 't-shirt', 'pants', 'jacket', 'coat', 'clothing',
      'vestido', 'camiseta', 'calça', 'camisa', 'blusa', 'jaqueta', 'casaco',
    ],
    motions: [
      '布料随着极轻微的气流自然起伏，衣褶缓缓流动，像挂在精品橱窗里被柔光拂过；镜头缓慢沿衣身向下平移，展示剪裁与面料质感',
      '衣角轻轻飘动、织物表面光泽缓慢流转，镜头非常缓慢地环绕半圈，突出版型轮廓与细节缝线',
      '衣物像被试穿般轻微转动、垂坠感自然显现，镜头极缓推近到面料纹理再缓缓拉回，呈现高级成衣质感',
    ],
  },
  {
    id: 'shoes',
    keywords: [
      'zapato', 'zapatos', 'zapatilla', 'zapatillas', 'tenis', 'zapatilha', 'tênis',
      'bota', 'botas', 'sandalia', 'sandália', 'sandalia', 'chinela', 'pantufla',
      'calzado', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots', 'sandal',
    ],
    motions: [
      '鞋子以极小角度缓慢旋转展示鞋面与鞋底轮廓，皮革/网面反光轻缓流动，背景干净明亮，镜头缓慢环绕',
      '镜头从鞋侧极缓横移到正面，鞋身在柔光下呈现材质层次，鞋带轻微飘动，最后停在鞋型的最佳侧角',
      '鞋子像放在展示转盘上缓慢自转一圈，光影随转动在鞋面上滑动，突出做工与立体造型',
    ],
  },
  {
    id: 'bag',
    keywords: [
      'bolso', 'bolsa', 'bolso cruzado', 'mochila', 'cartera', 'maleta', 'maletin',
      'neceser', 'riñonera', 'handbag', 'backpack', 'purse', 'bag',
    ],
    motions: [
      '包身缓慢自转展示正面与侧面轮廓，五金件与缝线处有细碎光泽流动，手提带轻微摆动，镜头极缓推近',
      '镜头沿包体缓慢环绕，皮质表面的高光随角度流转，最后停在能看清拉链与五金的角度',
      '包放在干净的展示面上，开口处轻微呼吸般起伏展示内部空间，镜头缓慢拉远露出整体比例',
    ],
  },
  {
    id: 'watch_jewelry',
    keywords: [
      'reloj', 'relojes', 'smartwatch', 'pulsera', 'pulseras', 'collar', 'colgante', 'cadena',
      'anillo', 'sortija', 'arete', 'aros', 'pendiente', 'joya', 'joyería', 'dije',
      'watch', 'bracelet', 'necklace', 'ring', 'earring', 'jewelry',
    ],
    motions: [
      '饰品在柔光下缓缓自转，金属切面的高光像星芒般连续流转，镜头极缓慢推近捕捉细节的闪耀',
      '主体在深色干净背景中缓慢旋转，每一处切面依次反光，最后停在最闪的角度，呈现高级珠宝质感',
      '饰品轻微悬空缓慢摆动，光泽在表面流动，背景微暗让主体更突出，镜头缓慢环绕',
    ],
  },
  {
    id: 'tools',
    keywords: [
      'herramienta', 'herramientas', 'taladro', 'atornillador', 'destornillador', 'sierra',
      'llave', 'alicate', 'alicates', 'pinza', 'pinzas', 'martillo', 'cutter', 'navaja',
      'multímetro', 'multimetro', 'nivel', 'cinta métrica', 'cepillo', 'juego de llaves',
      'tool', 'tools', 'drill', 'pliers', 'wrench', 'hammer',
    ],
    motions: [
      '工具在干净的工作台面上缓慢自转，金属表面反光随角度流转，手柄纹理清晰，镜头极缓推近展示工艺',
      '镜头缓慢环绕产品一圈，金属件呈现出结实可用的质感，最后停在功能部位的特写角度',
      '产品轻微转动，边缘版型的明暗变化自然，背景虚化成简洁深色，突出硬朗有力的造型',
    ],
  },
  {
    id: 'kitchen',
    keywords: [
      'cocina', 'olla', 'sartén', 'sarten', 'cuchillo', 'cuchillos', 'utensilio', 'utensilios',
      'licuadora', 'batidora', ' procesador', 'cafetera', 'tetera', 'hervidor', 'molde',
      'espátula', 'espumadera', 'tabla', 'vaso', 'vasos', 'taza', 'tazas', 'termo', 'botella',
      'kitchen', 'knife', 'cookware', 'pan', 'bottle', 'mug', 'thermos',
    ],
    motions: [
      '产品热气般微微升腾（若有液体则表面极轻微荡漾），镜头缓慢环绕并极缓推近，突出材质与光泽',
      '商品缓缓转动，釉面/金属表面的暖光慢慢滑动，像刚被端上餐桌那般有食欲，最后停在最佳角度',
      '镜头从上方缓慢俯视再平移到侧面，展示容量与比例，柔光让边缘勾出干净的高光线',
    ],
  },
  {
    id: 'home',
    keywords: [
      'mueble', 'mesa', 'silla', 'escritorio', 'estantería', 'estanteria', 'repisa', 'cama',
      'colchón', 'colchon', 'sofá', 'sofa', 'armario', 'ropero', 'cajonera', 'banco',
      'furniture', 'table', 'chair', 'desk', 'shelf', 'bed', 'sofa',
    ],
    motions: [
      '家具在明亮通透的空间里极其缓慢地被环绕拍摄，木质/布面在柔光下显现纹理，光影自然流转',
      '镜头缓慢平移并轻微抬升，展示整体比例与空间感，表面的光泽与阴影缓缓变化',
      '从细节 textures 缓缓拉开到整体造型，光线温柔移动，呈现舒适宜居的氛围感',
    ],
  },
  {
    id: 'lighting',
    keywords: [
      'lámpara', 'lampara', 'lámparas', 'luz', 'luces', 'led', 'foco', 'linterna',
      'lampara de mesa', 'aplique', 'luminaria', 'lamp', 'light', 'lantern', 'lighting',
    ],
    motions: [
      '灯光柔和地缓缓亮起并轻微呼吸般变化，光晕在空气中温柔扩散，产品边缘泛出干净的高光',
      '光源角度极缓慢地移动，照射面的明暗随之流动，呈现出温暖宜人的照明效果',
      '产品在暗背景中缓慢旋转，光随着转动在表面滑过，突出发出洁净柔光的那一刻',
    ],
  },
  {
    id: 'electronics',
    keywords: [
      'celular', 'celular ', 'funda', 'case', 'auricular', 'auriculares', 'audífonos', 'audifonos',
      'cargador', 'cable', 'parlante', 'altavoz', 'bocina', 'batería', 'power bank', 'soporte',
      'adaptador', 'control', 'mando', 'teclado', 'mouse', 'cámara', 'camara', 'monitor',
      'phone', 'case', 'earphone', 'earbuds', 'charger', 'speaker', 'powerbank', 'holder',
    ],
    motions: [
      '产品的金属与哑光表面在冷调柔光下缓缓转动，接口与按键轮廓清晰，镜头极缓推近展示做工',
      '镜头从侧面缓慢环绕到正面，屏幕/按键区域泛出细腻反光，背景干净，突出科技感与精密度',
      '机身缓慢自转，边缘倒角的高光连续流转，最后停在可看清全部按键/接口的角度',
    ],
  },
  {
    id: 'auto',
    keywords: [
      'auto', 'automóvil', 'automovil', 'carro', 'coche', 'moto', 'motocicleta', 'bicicleta',
      'bici', 'accesorio para auto', 'parabrisas', 'tapete', 'alfombrilla', 'luces automóvil',
      'car', 'motorcycle', 'bike', 'bicycle', 'dashboard', 'automotive',
    ],
    motions: [
      '产品在柔光下缓慢转动，喷漆/镀铬表面的反光随角度流动，像车展射灯掠过，质感硬朗有档次',
      '镜头沿车身/配件缓慢横移，表面光泽连续变化，最后停在最有力量感的侧面角度',
      '产品缓慢自转，明亮的高光带在曲面上滑过，背景干净，突出改装后的高级观感',
    ],
  },
  {
    id: 'pet',
    keywords: [
      'mascota', 'mascotas', 'perro', 'perros', 'gato', 'gatos', 'collar para perro',
      'comedero', 'cama para mascota', 'juguete para perro', 'arnés', 'arnes', 'correa',
      'pet', 'dog', 'cat', 'puppy', 'kitten',
    ],
    motions: [
      '产品轻轻晃动、柔软材质自然起伏，像等待被爱抚般有生气，柔光下镜头极缓推近',
      '镜头缓慢环绕，柔软绒面随角度显现细微绒毛层次，营造温暖安心的宠物用品氛围',
      '产品轻微弹动、形状温和地呼吸变化，背景简洁明亮，突出柔软亲肤的触感',
    ],
  },
  {
    id: 'beauty',
    keywords: [
      'maquillaje', 'labial', 'lápiz labial', 'lapiz labial', 'crema', 'perfume', 'fragancia',
      'base de maquillaje', 'sombra', 'rimel', 'esmalte', 'shampoo', 'champú', 'acondicionador',
      'serum', 'protector solar', 'locion', 'makeup', 'lipstick', 'cream', 'perfume', 'skincare',
    ],
    motions: [
      '瓶身在高级柔光下缓慢转动，玻璃/金属的高光像秀场灯掠过，盖子微微反光，镜头极缓推近',
      '产品表面折射出细腻流动的光泽，背景简洁高级，突出细腻高级的护肤/彩妆质感',
      '镜头沿包装缓慢上移到瓶口，反射光连续变化，像专柜柜台里的陈列，令人想拿起试试',
    ],
  },
  {
    id: 'sports',
    keywords: [
      'deporte', 'deportes', 'gimnasio', 'gym', 'pesa', 'pesas', 'mancuerna', 'yoga',
      'bicicleta fija', 'cuerda', 'banda elástica', 'balón', 'balon', 'pelota', 'fitness',
      'sports', 'dumbbell', 'fitness', 'exercise', 'ball',
    ],
    motions: [
      '产品稳稳地缓慢转动，受力面的材质结构清晰可见，光影结实有力，镜头缓慢环绕',
      '镜头缓慢推近再拉远，展示尺寸与握持处的纹理，背景干净，突出运动中的稳固与可靠',
      '产品在地面上稳如磐石，表面光影缓缓流转，呈现出耐用结实的运动器材质感',
    ],
  },
  {
    id: 'home_decor',
    keywords: [
      'cortina', 'alfombra', 'tapete', 'cojín', 'cojin', 'fundas', 'decoración', 'decoracion',
      'cuadro', 'espejo', 'jarrón', 'jarron', 'florero', 'vela', 'velas', 'organizador',
      'curtain', 'rug', 'cushion', 'mirror', 'vase', 'candle', 'organizer',
    ],
    motions: [
      '织物的纹理在温暖阳光里缓缓移动的光影下显现，边缘的流苏轻摆，营造出温馨居家氛围',
      '镜头缓慢平移掠过表面，材质的细腻层次依次呈现，光线温柔地在房间里滑过',
      '产品沐浴在缓慢变化的暖光中，形态与色泽都显得柔和舒适，画面干净宜人',
    ],
  },
  {
    id: 'garden',
    keywords: [
      'planta', 'plantas', 'maceta', 'macetas', 'jardín', 'jardin', 'manguera', 'regadera',
      'herramienta de jardín', 'semilla', 'invernadero', 'plant', 'garden', 'pot', 'planter',
    ],
    motions: [
      '植物叶片在轻柔微风里缓缓摆动，晨光般的光线在叶面慢慢流动，画面清新充满生机',
      '镜头缓慢环绕，叶片随角度舒展透光，呈现自然健康的生长姿态',
      '柔和的风依次拂过枝叶，光影细腻地移动，营造轻松治愈的园艺氛围',
    ],
  },
  {
    id: 'toy',
    keywords: [
      'juguete', 'juguetes', 'muñeca', 'muneca', 'peluche', 'rompecabezas', 'puzzle',
      'figura de acción', 'didáctico', 'juego de mesa', 'toy', 'toys', 'doll', 'plush', 'puzzle',
    ],
    motions: [
      '玩具被柔和的光洒满，表面微微转动展示各角度的讨喜造型，像在邀请孩子来拿，画面明亮可爱',
      '镜头缓慢环绕，毛绒/塑料材质呈现柔软或鲜亮的光泽，背景干净活泼',
      '玩偶轻轻摇摆、光影欢快地流动，营造童趣与安全并重的第一印象',
    ],
  },
];

/**
 * 「为什么不出现文字」必须写死：
 * 美客多 Clips 会拒收带文字、字幕、水印、价格的视频；
 * 而图生视频模型很爱在画面里脑补出不存在的水印或字母。
 */
const HARD_CONSTRAINTS =
  '严格约束：绝对不要新增任何文字、字幕、字母、Logo、价格牌、二维码或水印；' +
  '不要改变商品本身的形状、颜色、材质与上面的任何文字标识；' +
  '画面里不要凭空出现多余的人物、动物或物品；商品不要变形、断裂或扭曲。';

/** 通用摄影质感增强（让画面「像能勾起购买欲的商拍」而不是随手拍） */
const CINEMA = [
  '干净纯色背景、柔和的高级商业布光、细腻的浅景深，整体通透有质感，像品牌官方主图',
  '柔和立体的柔光与微妙细腻的反光、干净的极简背景，画面精致有档次',
  '明亮整洁的背景与细腻的商品阴影，柔光从左向右缓缓移动，呈现专业棚拍观感',
];

/** 摄像机语言（每个品类都会叠加一层） */
const CAMERA = [
  '镜头极其缓慢稳定地运动，全程不晃不抖',
  '镜头以极缓慢的速度推近再微微拉开，节奏从容',
  '镜头非常缓慢地环绕半圈，始终保持主体居中清晰',
];

function pick<T>(arr: T[], seed: number): T {
  if (!arr.length) return ('' as unknown) as T;
  const i = Math.abs(Math.floor(seed)) % arr.length;
  return arr[i];
}

/** 从标题里识别品类；返回 null 表示没匹配上（走通用展示） */
function matchCategory(titleLower: string): CategoryRule | null {
  let best: { rule: CategoryRule; len: number } | null = null;
  for (const rule of RULES) {
    for (const kw of rule.keywords) {
      if (titleLower.includes(kw)) {
        // 取「关键词最长」的那个品类：命中 "tool" 不如命中 "power tool" 准
        if (!best || kw.length > best.len) best = { rule, len: kw.length };
      }
    }
  }
  return best ? best.rule : null;
}

export interface BuildPromptOptions {
  /** 商品标题（西语/葡语/英语均可；为空则用通用展示词） */
  title?: string;
  /** 固定随机种子，便于同一件商品复现同样的动作（默认随机） */
  seed?: number;
  /** LLM 生成的更贴切描述（由调用方准备好；为空则只用规则） */
  llmMotion?: string;
}

/**
 * 生成图生视频的动作指令。
 *
 * @returns 直接可提交给平台的 prompt
 */
export function buildProductVideoPrompt(opts: BuildPromptOptions = {}): string {
  const title = String(opts.title || '').trim();
  const lower = title.toLowerCase();
  const seed =
    typeof opts.seed === 'number'
      ? opts.seed
      : (title ? hashSeed(title) : 0) + Math.floor(Math.random() * 1000);

  const rule = matchCategory(lower);
  const motion = opts.llmMotion?.trim() || (rule ? pick(rule.motions, seed) : '');
  const body = motion || '商品主体保持原样，镜头极缓慢地运动展示其造型与细节';
  const camera = pick(CAMERA, seed + 1);
  const cinema = pick(CINEMA, seed + 2);

  return `电商商品展示短片。${body}。${camera}，${cinema}。${HARD_CONSTRAINTS}`;
}

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 给前端/日志用的可读摘要：命中了什么品类 */
export function describeCategory(title?: string): string {
  const rule = matchCategory(String(title || '').toLowerCase());
  return rule ? rule.id : 'general';
}

// ============ 可选 LLM 增强 ============

/**
 * 用 LLM 按商品标题写一句更贴合的场景描述，失败返回 ''（调用方降级用规则结果）。
 * 走 aiService 的多平台 failover，只在 chat 类平台可用时才有返回。
 */
export async function llmMotionForProduct(title: string, timeoutMs = 15000): Promise<string> {
  if (!title) return '';
  try {
    const { llmGenerate } = await import('./aiService.js');
    const sys =
      '你是电商短视频导演。请只用一句中文描述这个商品的动作来到场面描写，40~70 字。' +
      '要求：只描述镜头怎么动、光线怎么变化、商品如何在画面里呈现吸引力；' +
      '绝对不要出现任何文字、字幕、水印、人物、无关物品；不要改变商品本身。直接输出这一句，不要任何前缀或引号。';
    const text = await llmGenerate({
      systemPrompt: sys,
      prompt: `商品标题：${title.slice(0, 160)}`,
      maxTokens: 200,
      temperature: 0.9,
    });
    const one = String(text || '')
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
    // 太短/太长都当作失败
    return one.length >= 12 && one.length <= 200 ? one : '';
  } catch {
    return '';
  }
}

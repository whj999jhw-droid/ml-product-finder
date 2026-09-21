/**
 * server/videoPrompt.ts
 * 商品视频的动作指令（prompt）生成。
 *
 * 为什么单独一个文件：
 *   之前 `i2v.ts` 里是一句写死的通用旁白（「镜头极缓慢推近……」），对任何商品都一模一样。
 *   用户明确要求「视频一定要与商品有关、无水印、最好能吸引顾客来买」，
 *   后续再次明确要求：视频要「使用 / 场景」感（商品被真实使用的样子），
 *   而不是转盘式棚拍展示（看起来就像几张图片拼在一起）。
 *   所以这里按**商品标题识别品类**，输出贴合该品类的**使用场景动效**，
 *   并把「不出现文字/水印」写成硬约束（美客多 Clips 会拒收带文字/水印的视频）。
 *
 * 设计取舍：
 *   - 规则表为主（零成本、零延迟、可预测），LLM 润色为可选增强，失败静默降级。
 *   - 每个品类给多个变体轮换，避免同一批视频动作雷同。
 *   - 场景化以「手部/人的局部操作商品 + 生活环境」为主，刻意避免清晰人脸：
 *     图生视频模型从商品静帧起稿，人脸极易崩坏毁掉整条视频，手部操作既有
 *     「真实使用感」又稳定。
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
      '一双手拿起这件衣服轻轻抖开，布料自然垂坠摆动，像在试衣间里准备穿上，随后衣身轻轻贴近镜头展示面料纹理',
      '衣服被手拎着缓缓转身半圈，衣袖与下摆随动作轻轻飘动，像刚从衣柜取下准备换上，光线柔和像清晨卧室',
      '手抚过衣面把褶皱抚平，随后提起衣架让衣服轻轻晃动，展示剪裁与垂感，背景是温馨的居家房间',
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
      '这双鞋被穿在脚上（只出现小腿与脚），轻轻原地踏步两下再侧移半步，展示上脚后的贴合感与弹性，背景是干净街道',
      '一双手捧起鞋子翻转展示鞋底防滑纹路，随后放回地面轻轻推前一点，像准备试穿，背景是明亮的玄关',
      '鞋子被脚轻轻踩进然后原地轻跳一下稳稳落地（只出现小腿），鞋面随受力自然弯曲回弹，突出穿着舒适感',
    ],
  },
  {
    id: 'bag',
    keywords: [
      'bolso', 'bolsa', 'bolso cruzado', 'mochila', 'cartera', 'maleta', 'maletin',
      'neceser', 'riñonera', 'handbag', 'backpack', 'purse', 'bag',
    ],
    motions: [
      '包被单手拎起轻轻晃了两下展示容量与垂感，随后拉开拉链露出内部隔层，像出门前最后检查，背景是玄关或街头',
      '背包被背上肩膀（只出现肩部与手），轻快走了两步再转回身面向镜头，肩带随步伐轻晃，背景是明亮的街道',
      '手托着包缓缓转动展示五金件与缝线，随后手指轻扣开磁扣再合上，声音般干脆的细节展示，背景简洁高级',
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
      '手表被戴到手腕上（只出现手臂），手腕轻轻翻转两下让表盘在不同角度反光，像出门前整理行头，背景是晨光卧室',
      '项链被双手轻轻展开再自然垂落，链条随动作细微摆动闪光，像正要戴上，背景柔和高级',
      '戒指被指尖捏着缓缓转动，切面依次折射星芒般的光，随后慢慢戴到手指上（只出现手部特写）',
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
      '工具被一只手稳稳握住开机运转（只出现手部），钻头/工作端高速稳定工作，碎屑轻扬，背景是真实的车间木工台',
      '手握着工具对准一颗螺丝利落拧动几下，随后抬起对镜头展示，动作干脆有力，背景是工作台与工具墙',
      '手拿起工具翻转检查各个面，金属反光随手部转动流动，随后在台面上轻轻一放，呈现专业可靠的质感',
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
      '锅放在灶台上正被使用：食材下锅发出轻微滋滋声般的动态，一只手握柄轻轻颠了两下，热气升腾，厨房背景温暖真实',
      '一双手握住刀轻轻切下食材，刀刃利落落下，随后抬起展示刀刃锋面反光，背景是整洁的料理台',
      '杯子/容器被手拿起，内部液体轻轻荡漾，随后缓缓放下，热气或凉意若隐若现，像清晨厨房的日常一刻',
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
      '家具在明亮的真实居室场景中：一只手压了压坐垫/桌面测试质感，随即缓缓起身离开画面，留下稳固妥帖的家具',
      '抽屉被手轻轻拉开再推上，顺滑无声，光线从窗外慢慢移进房间，呈现舒适宜居的日常使用感',
      '镜头掠过家具表面时一双手正在整理桌面物品，随后轻轻擦过台面，展示真实使用中的质感与空间感',
    ],
  },
  {
    id: 'lighting',
    keywords: [
      'lámpara', 'lampara', 'lámparas', 'luz', 'luces', 'led', 'foco', 'linterna',
      'lampara de mesa', 'aplique', 'luminaria', 'lamp', 'light', 'lantern', 'lighting',
    ],
    motions: [
      '灯被手按下开关缓缓亮起，暖光逐渐充满房间角落，光晕温柔扩散，像傍晚回家开灯的瞬间',
      '灯在书桌一角静静发光，一只手把书放到灯下翻开，光影落在纸面上微微晃动，氛围安静治愈',
      '灯头被手轻轻掰动调整照射角度，光斑随移动在墙面滑过，展示可调节的实用性',
    ],
  },
  {
    id: 'electronics',
    keywords: [
      'celular', 'celular ', 'funda', 'case', 'auricular', 'auriculares', 'audífonos', 'audifonos',
      'cargador', 'cable', 'parlante', 'altavoz', 'batería', 'power bank', 'soporte',
      'adaptador', 'control', 'mando', 'teclado', 'mouse', 'cámara', 'camara', 'monitor',
      'phone', 'case', 'earphone', 'earbuds', 'charger', 'speaker', 'powerbank', 'holder',
    ],
    motions: [
      '耳机被手拿起随后戴到耳上（只出现手部与耳部局部），轻轻点头跟着节奏微微律动，像沉浸在音乐里，背景是街头或健身房',
      '手机装进保护壳：手把手机按进壳里咔哒到位，翻转展示按键与摄像头开孔精准，随后握持展示手感',
      '音箱放在桌上开始播放，机身随低频轻微震动，手伸进来转动箱体展示各面做工，背景是温馨的房间',
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
      '汽车配件正在车内安装使用：一双手把配件按进车内对应位置卡紧到位，随后展示装好的效果，背景是真实车内',
      '车灯亮起，光束在夜色中清晰投射，镜头缓缓掠过灯面展现点亮瞬间的高级质感',
      '手把脚垫/饰件铺进车内抚平贴合，随后镜头拉远展示整体车厢效果，实用感十足',
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
      '一只狗（背影或侧影为主，不出现清晰面部）戴着这项用品轻快走来，用品随步伐自然摆动，背景是阳光草地',
      '宠物的爪子按住玩具拨弄玩耍，玩具轻轻滚动晃动，画面活泼有生命力，背景是温馨的居家地板',
      '手整理宠物窝/食盆，随后镜头拉远呈现它在旁安静等待的日常一刻，氛围温暖安心',
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
      '瓶盖被手拧开，膏体/液体被挤出一点点在指尖，质地细腻清晰可见，随后轻抹开，背景是明亮的梳妆台',
      '喷雾被轻轻按出细腻水雾在逆光中散开，瓶身反光随水雾微光流转，高级感与使用感并存',
      '香水被手拿起轻喷一下，细雾在光束中飘散，随后瓶身缓缓放回梳妆台，像出门前最后一道仪式',
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
      '一双手握住器械开始稳定发力（只出现手部与手臂），器械受力时的材质张力清晰可见，背景是健身房',
      '弹力带被双手拉开又缓缓收回复力，形变自然真实，展示弹性与耐用，背景是明亮的居家健身角',
      '球被手轻拍弹起又稳稳落回掌心，弹跳干脆利落，光影随运动流动，充满运动气息',
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
      '窗帘被手轻轻拉开，晨光顺着布料褶皱涌入房间，光线流动间呈现垂感与质感',
      '手把抱枕拍松摆正放到沙发上，随后靠上去轻轻压了一下（只出现局部），展示柔软回弹，房间温馨明亮',
      '烛火轻轻摇曳，光影在墙面温柔晃动，旁边的手把花放进花瓶调整角度，居家氛围感拉满',
    ],
  },
  {
    id: 'garden',
    keywords: [
      'planta', 'plantas', 'maceta', 'macetas', 'jardín', 'jardin', 'manguera', 'regadera',
      'herramienta de jardín', 'semilla', 'invernadero', 'plant', 'garden', 'pot', 'planter',
    ],
    motions: [
      '喷壶被手提起给植物浇水，水珠在阳光下洒落，叶片轻轻颤动变得湿润发亮，背景是阳光花园',
      '一双手把植物连土脱盆放进新花盆，培土压实动作利落，展示使用的轻松与盆器质感',
      '园艺工具正在松土，土壤翻起的颗粒感真实，随后工具抬起展示，背景是生机勃勃的菜园',
    ],
  },
  {
    id: 'toy',
    keywords: [
      'juguete', 'juguetes', 'muñeca', 'muneca', 'peluche', 'rompecabezas', 'puzzle',
      'figura de acción', 'didáctico', 'juego de mesa', 'toy', 'toys', 'doll', 'plush', 'puzzle',
    ],
    motions: [
      '孩子的手（只出现小手）拿起玩具轻轻摆弄，玩具关节/轮子活动起来，画面明亮活泼，背景是儿童房',
      '毛绒玩具被手抱着轻轻晃动，绒毛在窗边逆光下泛起柔和光晕，柔软感呼之欲出',
      '积木/拼图被手一块块搭起，动作轻快连贯，完成后镜头微微拉远展示成果，童趣十足',
    ],
  },
];

/**
 * 「为什么不出现文字」必须写死：
 * 美客多 Clips 会拒收带文字、字幕、水印、价格的视频；
 * 而图生视频模型很爱在画面里脑补出不存在的水印或字母。
 *
 * 「使用/场景」要求（2026-09-21 用户明确）：视频要是商品被真实使用的样子，
 * 所以允许手部/人的局部入镜；但刻意禁止清晰人脸 —— 图生视频从商品静帧起稿，
 * 人脸极易崩坏毁掉整条视频。
 */
const HARD_CONSTRAINTS =
  '严格约束：绝对不要新增任何文字、字幕、字母、Logo、价格牌、二维码或水印；' +
  '可以出现手部或人的局部（手臂、手腕、腿部、肩部、背影）来真实使用这件商品，但不要出现清晰的人脸；' +
  '不要改变商品本身的形状、颜色、材质与上面的任何文字标识；' +
  '除该商品与使用它所需的动作外，画面里不要凭空出现无关的成堆物品；商品不要变形、断裂或扭曲。';

/** 通用摄影质感增强（让画面「像能勾起购买欲的商拍」而不是随手拍） */
const CINEMA = [
  '干净整洁的生活化场景、柔和的高级商业布光、细腻的浅景深，整体通透有质感，像品牌官方使用视频',
  '柔和立体的柔光与微妙细腻的反光、真实但不杂乱的场景，画面精致有档次',
  '明亮的自然光与细腻的商品阴影，柔光从左向右缓缓移动，呈现专业生活方式短片观感',
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
  const body =
    motion ||
    '这件商品正被一双手真实地使用：手拿起它、操作它的核心功能，动作自然流畅，像日常生活里使用它的一刻';
  const camera = pick(CAMERA, seed + 1);
  const cinema = pick(CINEMA, seed + 2);

  return `电商商品使用场景短片。${body}。${camera}，${cinema}。${HARD_CONSTRAINTS}`;
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
 * 用 LLM 按商品标题写一句更贴合的使用场景描述，失败返回 ''（调用方降级用规则结果）。
 * 走 aiService 的多平台 failover，只在 chat 类平台可用时才有返回。
 */
export async function llmMotionForProduct(title: string, timeoutMs = 15000): Promise<string> {
  if (!title) return '';
  try {
    const { llmGenerate } = await import('./aiService.js');
    const sys =
      '你是电商短视频导演。请只用一句中文描述这个商品「被真实使用」的场景动作，40~70 字。' +
      '要求：写商品如何被手部操作、发挥它的核心功能、出现在什么样的生活场景里（如厨房、街头、健身房、卧室）；' +
      '可以出现手部或人的局部，但不要写人脸特写；' +
      '绝对不要出现任何文字、字幕、水印；不要让商品变形。直接输出这一句，不要任何前缀或引号。';
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

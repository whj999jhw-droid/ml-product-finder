/**
 * 商品图自动化（合规）：
 * 从你「1688 货源供应商图」(你是买家，供应商本就提供图给分销商用) 拉取主图
 *  → AI 修图(去背景/白底/增强) 或 水印/品牌化(纯 JS jimp)
 *  → 上传到美客多 /pictures → 返回美客多公网 URL，可直接用于 Listing 的 pictures.source。
 *
 * 合规红线（务必守住）：绝不用从美客多(Mercado Libre)抓到的竞品图。
 * 本模块只处理你作为买家可合法使用的 1688 货源图；AI 修图/水印进一步把它做成「你自己的图」。
 */
import path from 'path';
import fs from 'fs';
import { getAccessToken } from './mercadolibre.js';
import { processImageAI, checkRembgAvailable } from './imageAI.js';

const TMP = path.join(process.cwd(), 'data', 'img-tmp');

export interface PrepareImagesOptions {
  site: string;
  /** 1688 货源图 URL（你有权使用的供应商图，非 ML 竞品图） */
  sourceImages: string[];
  /** 图片处理模式：ai=AI修图(去背景+白底+增强+水印) / watermark=仅加水印 / direct=直传 */
  mode?: 'ai' | 'watermark' | 'direct';
  /** 水印文字，通常是你的店铺名 */
  watermarkText?: string;
  /** 最多处理几张，默认 6 */
  max?: number;
}

export interface PrepareImagesResult {
  success: boolean;
  message: string;
  /** 上传后美客多公网 URL（可直接用于 listing pictures.source） */
  pictures: string[];
  errors: string[];
}

function ensureTmp() {
  if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });
}

function normalizeUrl(u: string): string {
  if (!u) return u;
  if (u.startsWith('//')) return `https:${u}`;
  return u;
}

async function downloadImage(url: string): Promise<Buffer> {
  const r = await fetch(normalizeUrl(url), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`下载失败 ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function addWatermark(buf: Buffer, text: string): Promise<Buffer> {
  // jimp 为 CommonJS，动态导入以兼容 ESM/interop
  const mod: any = await import('jimp');
  const Jimp = mod.default ?? mod;
  const image: any = await Jimp.read(buf);
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const textW = Jimp.measureText(font, text);
  const textH = 34;
  const x = Math.max(6, image.bitmap.width - textW - 16);
  const y = Math.max(6, image.bitmap.height - textH - 12);
  // 半透明黑底条
  const bar: any = new Jimp(textW + 24, textH + 8, 0x000000);
  image.composite(bar, x - 10, y - 6, { opacitySource: 0.45, opacityDest: 1 });
  image.print(font, x, y, text);
  return await image.getBufferAsync(Jimp.MIME_JPEG);
}

async function uploadToML(buf: Buffer): Promise<string> {
  const token = getAccessToken();
  if (!token) throw new Error('未获取卖家 write token，无法上传图片（请先在「美客多商品抓取」页授权店铺）');
  const form: any = new FormData();
  form.append('file', new Blob([buf], { type: 'image/jpeg' }), 'img.jpg');
  // CBT 全球售：图片必须走 /pictures/items/upload（multipart + Bearer），返回 { id, url, secure_url }。
  // 旧版 POST /pictures?access_token= 是本地站写法，CBT 不适用。
  const r = await fetch(`https://api.mercadolibre.com/pictures/items/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data: any = await r.json();
  if (!r.ok) throw new Error(`上传失败 ${r.status}: ${data?.message || ''}`);
  // 返回公网 URL 供前端预览；CBT 发布时 createListing 会再解析出 picture id。
  return data.secure_url || data.url || data.id;
}

/** 批量处理一组 1688 货源图：下载 → (AI修图/水印) → 上传美客多 → 返回公网 URL */
export async function prepareListingImages(opts: PrepareImagesOptions): Promise<PrepareImagesResult> {
  const pictures: string[] = [];
  const errors: string[] = [];
  ensureTmp();
  const src = (opts.sourceImages || []).filter(Boolean);
  const max = Math.min(opts.max ?? 6, src.length);
  const mode = opts.mode || 'watermark';

  for (let i = 0; i < max; i++) {
    try {
      let buf = await downloadImage(src[i]);

      if (mode === 'ai') {
        // AI 修图模式：去背景 → 白底 → 增强 → 水印
        const aiResult = await processImageAI(buf, {
          removeBg: true,
          whiteBg: true,
          enhance: true,
          targetWidth: 1000,
          watermarkText: opts.watermarkText,
        });
        if (aiResult.success && aiResult.buffer) {
          buf = aiResult.buffer;
        } else {
          // AI 失败 → 回退到水印模式
          console.warn(`[ImagePipeline] AI processing failed for image ${i + 1}, falling back to watermark: ${aiResult.error}`);
          if (opts.watermarkText) {
            buf = await addWatermark(buf, opts.watermarkText);
          }
        }
      } else if (mode === 'watermark' && opts.watermarkText) {
        buf = await addWatermark(buf, opts.watermarkText);
      }
      // direct 模式：不做任何处理，直接上传

      const uploaded = await uploadToML(buf);
      pictures.push(uploaded);
    } catch (e: any) {
      errors.push(`${src[i]}: ${e?.message || '未知错误'}`);
    }
  }
  return {
    success: pictures.length > 0,
    message: `成功处理 ${pictures.length} 张，失败 ${errors.length} 张（模式: ${mode}）`,
    pictures,
    errors,
  };
}

/** 检查 AI 修图能力是否可用（rembg 是否已安装） */
export async function checkAIAvailable(): Promise<{ available: boolean; error?: string }> {
  return checkRembgAvailable();
}

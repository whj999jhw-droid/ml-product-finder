/**
 * server/slideshow.ts
 * 「图集运镜视频」兜底生成器（零 AI 成本）。
 *
 * 场景：商品没有 1688/妙手源视频，且所有 AI 图生视频平台都不可用（欠费/熔断）时，
 * 用商品的多张主图/细节图做 Ken Burns 式运镜视频（推近/平移），保证流水线永远能出片。
 *
 * 为什么不是「静态图轮播」：ML Clips 明确禁止纯静态图（会 UPLOADING_ERROR），
 * 所以每张图都加 zoompan 运镜（放大/平移），让画面持续有运动。
 *
 * 规格（对齐 ML Clips 硬性要求）：
 *   1080×1920 9:16 / H.264 + AAC（静音轨也必须有）/ 总时长 11~15s / ≤280MB
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SLIDESHOW_TMP_DIR = path.join(__dirname, '..', 'data', 'tmp', 'slideshow');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 每张图的秒数 = 12/N（夹在 3~6s），保证总时长 ≥10s（ML 下限） */
function perImageSec(n: number): number {
  return Math.max(3, Math.min(6, 12 / Math.max(1, n)));
}

/** 下载一张图（ML CDN 对 UA/Referer 敏感，用 curl 稳） */
async function downloadImage(url: string, outPath: string): Promise<void> {
  await execFileAsync(
    'curl',
    ['-s', '-L', '--max-time', '40', '-o', outPath, '-H', `User-Agent: ${UA}`, url],
    { timeout: 45000 },
  );
  const st = fs.statSync(outPath);
  if (st.size < 500) throw new Error(`图片下载异常（${st.size}B）：${url.slice(0, 80)}`);
}

/**
 * 生成一段单图运镜视频（1080×1920，无音轨，时长 sec 秒）。
 * 先放大到 2160×3840 再 zoompan，避免推近时的像素抖动。
 * 效果按 idx 轮换：① 居中缓推 ② 左→右平移 ③ 右→左平移 ④ 上→下平移。
 */
async function renderSegment(
  imgPath: string,
  outPath: string,
  sec: number,
  idx: number,
): Promise<void> {
  const fps = 30;
  const frames = Math.round(sec * fps);
  // 缓推速率：整段从 1.0 推到约 1.18
  const rate = (0.18 / frames).toFixed(6);
  const end = `on/( ${frames} - 1 )`; // 0→1 的进度
  const panX = `( iw - iw/zoom ) * ${end}`;
  const panY = `( ih - ih/zoom ) * ${end}`;
  const cx = `iw/2 - (iw/zoom/2)`;
  const cy = `ih/2 - (ih/zoom/2)`;
  const zoomExpr = idx % 4 === 0 ? `min(zoom+${rate},1.2)` : `1.15`;
  let xExpr = cx;
  let yExpr = cy;
  if (idx % 4 === 1) { xExpr = panX; yExpr = cy; }
  else if (idx % 4 === 2) { xExpr = `( iw - iw/zoom ) * ( 1 - ${end} )`; yExpr = cy; }
  else if (idx % 4 === 3) { xExpr = cx; yExpr = panY; }

  const vf = [
    'scale=2160:3840:force_original_aspect_ratio=increase',
    'crop=2160:3840',
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=1080x1920:fps=${fps}`,
    'setsar=1',
  ].join(',');

  await execFileAsync(
    'ffmpeg',
    [
      '-y', '-loop', '1', '-t', String(sec), '-i', imgPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-an', outPath,
    ],
    { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
  );
}

export interface SlideshowResult {
  success: boolean;
  outPath?: string;
  imagesUsed?: number;
  durationSec?: number;
  error?: string;
}

/**
 * 用商品图片列表生成一条合规的运镜视频。
 * @param imageUrls 图片 URL 列表（≥1 张，取前 5 张）
 * @param outPath   输出 mp4 路径
 */
export async function generateSlideshowVideo(opts: {
  imageUrls: string[];
  outPath: string;
}): Promise<SlideshowResult> {
  const urls = (opts.imageUrls || []).filter(Boolean).slice(0, 5);
  if (!urls.length) return { success: false, error: '没有可用图片' };

  fs.mkdirSync(SLIDESHOW_TMP_DIR, { recursive: true });
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const work = path.join(SLIDESHOW_TMP_DIR, stamp);
  fs.mkdirSync(work, { recursive: true });

  const segDur = perImageSec(urls.length);
  const total = +(segDur * urls.length).toFixed(2);
  try {
    // 1. 下载图片 → 统一转码（损坏/超大图先归一成标准 JPEG，ffmpeg 兼容性最好）
    const imgs: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const raw = path.join(work, `raw_${i}`);
      const jpg = path.join(work, `img_${i}.jpg`);
      try {
        await downloadImage(urls[i], raw);
        await execFileAsync(
          'ffmpeg',
          ['-y', '-i', raw, '-vf', 'scale=2160:-2', '-q:v', '4', jpg],
          { timeout: 30000 },
        );
        imgs.push(jpg);
      } catch (e: any) {
        console.warn(`[Slideshow] 第 ${i + 1} 张图跳过: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    if (!imgs.length) return { success: false, error: '所有图片下载/转码失败' };

    // 2. 逐段渲染运镜片段
    const segs: string[] = [];
    for (let i = 0; i < imgs.length; i++) {
      const seg = path.join(work, `seg_${i}.mp4`);
      await renderSegment(imgs[i], seg, segDur, i);
      segs.push(seg);
    }

    // 3. concat 拼接 + 补静音轨（ML Clips 强制要求音频）
    const listFile = path.join(work, 'list.txt');
    fs.writeFileSync(listFile, segs.map((s) => `file '${s}'`).join('\n'));
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo',
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-t', String(Math.max(10, total - 0.2)),
        '-movflags', '+faststart',
        opts.outPath,
      ],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
    );

    const st = fs.statSync(opts.outPath);
    if (st.size < 20000) return { success: false, error: `生成文件异常（${st.size}B）` };
    return { success: true, outPath: opts.outPath, imagesUsed: imgs.length, durationSec: total };
  } catch (e: any) {
    return { success: false, error: `图集视频生成失败：${String(e?.message || e).slice(0, 200)}` };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

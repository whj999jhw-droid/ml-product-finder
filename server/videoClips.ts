/**
 * server/videoClips.ts
 * 1688 视频 → ML Clips 处理流水线
 *
 * 流程：
 * 1. 下载 1688 视频（Taobao CDN，需 User-Agent + Referer 头）
 * 2. ffmpeg 处理：裁剪为 9:16 竖版、移除底部文字区域、保留音频
 * 3. 通过 ML Clips API 上传（POST /marketplace/items/{cbt_item_id}/clips/upload）
 *
 * ML Clips 要求：
 * - 格式：MP4/MOV/MPEG/AVI
 * - 时长：10-61 秒
 * - 分辨率：最小 360x640
 * - 比例：9:16 竖版
 * - 必须含音频（旁白或背景音乐）
 * - 文件大小：≤280MB
 * - 禁止静态图、水印、联系方式、价格信息
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { getStoreRaw } from './stores.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp', 'video');
const execFileAsync = promisify(execFile);

// ============ 下载视频 ============

/**
 * 下载 1688/Taobao 视频
 * Taobao CDN 需要 User-Agent + Referer 头，否则返回 JSON 错误。
 * 使用 curl 而非 fetch（Node fetch 对 Taobao CDN 连接超时）。
 */
export async function downloadVideo(url: string, outputPath: string): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await execFileAsync('curl', [
      '-s', '-L', '--max-time', '60',
      '-o', outputPath,
      '-H', 'User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
      '-H', 'Referer: https://detail.1688.com/',
      url,
    ], { timeout: 65000 });

    const stat = fs.statSync(outputPath);
    if (stat.size < 1000) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      console.error(`[VideoClips] 下载返回非视频内容 (${stat.size}B): ${content.slice(0, 200)}`);
      fs.unlinkSync(outputPath);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[VideoClips] 下载异常: ${e.message}`);
    return false;
  }
}

// ============ ffmpeg 处理 ============

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/**
 * 获取视频信息
 */
export async function getVideoInfo(filePath: string): Promise<VideoInfo | null> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ], { timeout: 15000 });
    const data = JSON.parse(stdout);
    const format = data.format || {};
    const streams = data.streams || [];
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');
    return {
      duration: parseFloat(format.duration || videoStream?.duration || '0'),
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      hasAudio: !!audioStream,
    };
  } catch (e: any) {
    console.error(`[VideoClips] ffprobe 失败: ${e.message}`);
    return null;
  }
}

/**
 * 将视频转换为 ML Clips 合规格式
 *
 * 处理步骤：
 * 1. 裁剪为 9:16 竖版（从 16:9 横版居中裁剪）
 * 2. 裁剪底部 10%（移除可能的文字/水印区域）
 * 3. 缩放到 1080x1920
 * 4. 保持音频轨道
 * 5. 限制时长在 10-61 秒
 */
export async function convertToClipsFormat(
  inputPath: string,
  outputPath: string
): Promise<{ success: boolean; info: VideoInfo | null; error?: string }> {
  const info = await getVideoInfo(inputPath);
  if (!info) return { success: false, info: null, error: 'ffprobe 失败' };

  // 如果视频过短或过长，先截断/填充
  const duration = info.duration;
  const tooShort = duration < 10;
  const tooLong = duration > 61;

  // 计算裁剪参数：从横版裁剪为竖版
  // 目标比例 9:16，从原始 16:9 横版居中裁剪
  const srcW = info.width;
  const srcH = info.height;
  // 按高度为基准，裁剪宽度 = 高度 * 9/16
  let cropW = Math.round(srcH * 9 / 16);
  let cropH = srcH;
  let cropX = Math.round((srcW - cropW) / 2);
  let cropY = 0;

  // 确保裁剪区域在画面内
  cropW = Math.max(1, Math.min(cropW, srcW));
  cropX = Math.max(0, Math.min(cropX, srcW - cropW));

  // 移除底部 12%（文字/水印区域）
  const bottomCrop = Math.round(srcH * 0.12);
  cropH -= bottomCrop;

  // 构建 ffmpeg 命令
  const filters: string[] = [
    `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    'scale=1080:1920',
  ];

  // 如果时长过长，添加截断
  if (tooLong) {
    filters.push(`t=60`); // 截断到 60 秒
  }

  // 如果时长过短，循环填充到 10 秒（仅在有音频时）
  const isLoop = tooShort && info.hasAudio;

  const vf = filters.join(',');

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const args = [
      '-y',
      ...(isLoop ? ['-stream_loop', '0'] : []),
      '-i', inputPath,
    ];

    // 如果时长过短且无音频，添加静音音频
    if (tooShort && !info.hasAudio) {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    }

    args.push(
      '-vf', vf,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '28',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
    );

    if (tooLong) {
      args.push('-t', '60');
    } else if (tooShort) {
      args.push('-t', '10');
    }

    args.push('-shortest', outputPath);

    await execFileAsync('ffmpeg', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    return { success: true, info };
  } catch (e: any) {
    console.error(`[VideoClips] ffmpeg 转换失败: ${e.message}`);
    return { success: false, info, error: e.message };
  }
}

// ============ ML Clips 上传 ============

/**
 * 上传视频到 ML Clips
 *
 * @param cbtItemId CBT 商品 ID（如 CBT5169919624）
 * @param videoPath 本地视频文件路径
 * @param siteIds 目标站点列表（如 ['MLM', 'MLB']）
 * @param storeId 店铺 ID（用于获取 access_token）
 */
export async function uploadClip(
  cbtItemId: string,
  videoPath: string,
  siteIds: string[],
  storeId: string
): Promise<{ success: boolean; error?: string }> {
  const store = getStoreRaw(storeId);
  if (!store?.accessToken) {
    return { success: false, error: '店铺无 access_token' };
  }

  try {
    // 使用 curl 上传（ML Clips API 对 sites 字段格式敏感，curl 的 multipart 处理更可靠）
    const args = [
      '-s', '-X', 'POST',
      '-H', `Authorization: Bearer ${store.accessToken}`,
      '-F', `file=@${videoPath};type=video/mp4`,
      '-F', `site_id=${siteIds[0]}`,  // 上传到主站点，ML 会自动复制到该 CBT item 的所有站点
      `https://api.mercadolibre.com/marketplace/items/${cbtItemId}/clips/upload`,
    ];

    const { stdout } = await execFileAsync('curl', args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
    const data = JSON.parse(stdout);

    if (data.status === 'accepted') {
      console.log(`[VideoClips] 上传成功: ${cbtItemId} → clip_uuid=${data.clip_uuid}`);
      return { success: true };
    }

    const msg = data?.message || data?.error_status || JSON.stringify(data);
    console.error(`[VideoClips] 上传失败: ${msg}`);
    return { success: false, error: msg };
  } catch (e: any) {
    console.error(`[VideoClips] 上传异常: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============ 完整流水线 ============

/**
 * 完整视频处理流水线：下载 → 转换 → 上传
 *
 * @param detailId 妙手商品 detailId
 * @param mainImgVideoUrl 1688 视频 URL
 * @param cbtItemId ML CBT 商品 ID
 * @param siteIds 目标站点列表
 * @param storeId 店铺 ID
 */
export async function processAndUploadVideo(opts: {
  detailId: string;
  mainImgVideoUrl: string;
  cbtItemId: string;
  siteIds: string[];
  storeId: string;
}): Promise<{ success: boolean; stage: string; error?: string }> {
  const { detailId, mainImgVideoUrl, cbtItemId, siteIds, storeId } = opts;

  const rawPath = path.join(TMP_DIR, `${detailId}_raw.mp4`);
  const outPath = path.join(TMP_DIR, `${detailId}_clips.mp4`);

  // 1. 下载
  console.log(`[VideoClips] 开始处理 ${detailId}: ${mainImgVideoUrl.slice(0, 60)}...`);
  const dlOk = await downloadVideo(mainImgVideoUrl, rawPath);
  if (!dlOk) {
    return { success: false, stage: 'download', error: '下载失败（视频可能已删除或需登录）' };
  }

  // 2. 转换
  const convResult = await convertToClipsFormat(rawPath, outPath);
  if (!convResult.success) {
    // 清理临时文件
    try { fs.unlinkSync(rawPath); } catch {}
    return { success: false, stage: 'convert', error: convResult.error };
  }

  // 3. 上传
  const uploadResult = await uploadClip(cbtItemId, outPath, siteIds, storeId);
  if (!uploadResult.success) {
    return { success: false, stage: 'upload', error: uploadResult.error };
  }

  // 4. 清理临时文件
  try { fs.unlinkSync(rawPath); fs.unlinkSync(outPath); } catch {}

  console.log(`[VideoClips] ${detailId} 视频处理完成`);
  return { success: true, stage: 'done' };
}

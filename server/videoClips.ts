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
// 持久化备份目录：转换后的合规视频保留一份，供「查看视频」播放与失败重传复用
export const BACKUP_DIR = path.join(__dirname, '..', 'data', 'video-backups');
// 视频处理记录：每个「店铺 × 妙手商品」一条，含备份路径、clip_uuid、各站点审核状态
const VIDEO_RECORDS_FILE = path.join(__dirname, '..', 'data', 'video-records.json');
const execFileAsync = promisify(execFile);

// ============ ML Clips 审核状态 ============
// ML 实际返回的 status 见 /marketplace/items/{id}/clips → clips[].metadata[].status
// 实测（2026-09-09）：UNDER_REVIEW / UPLOADING_ERROR；未在映射表内的状态原样展示
export const CLIP_STATUS_LABEL: Record<string, string> = {
  UNDER_REVIEW: '待审核',
  PROCESSING: '处理中',
  UPLOADED: '已上传待处理',
  READY: '待发布',
  AVAILABLE: '已通过',
  PUBLISHED: '已通过',
  APPROVED: '已通过',
  LIVE: '已通过',
  REJECTED: '已拒绝',
  BLOCKED: '已拒绝',
  REMOVED: '已移除',
  FAILED: '失败',
  UPLOADING_ERROR: '上传失败',
  UPLOAD_ERROR: '上传失败',
  NOT_AVAILABLE: '不可用',
  UNKNOWN: '未知',
};
const CLIP_OK = ['AVAILABLE', 'PUBLISHED', 'APPROVED', 'LIVE'];
const CLIP_WAIT = ['UNDER_REVIEW', 'PROCESSING', 'UPLOADED', 'READY'];
const CLIP_BAD = [
  'REJECTED', 'BLOCKED', 'FAILED', 'REMOVED',
  'UPLOADING_ERROR', 'UPLOAD_ERROR', 'NOT_AVAILABLE',
];

export const clipStatusLabel = (s?: string) => (s && CLIP_STATUS_LABEL[s]) || s || '未知';

/** 把一个商品各站点的审核状态汇成一句综合结论 */
export function overallReview(siteStatuses: Record<string, string> = {}): {
  label: string;
  kind: 'none' | 'wait' | 'ok' | 'bad';
} {
  const vals = Object.values(siteStatuses).filter(Boolean) as string[];
  if (vals.length === 0) return { label: '未上传', kind: 'none' };
  if (vals.every((v) => CLIP_OK.includes(v))) return { label: '全部通过', kind: 'ok' };
  if (vals.some((v) => CLIP_BAD.includes(v))) return { label: '存在被拒', kind: 'bad' };
  if (vals.every((v) => CLIP_WAIT.includes(v) || CLIP_OK.includes(v))) return { label: '待审核', kind: 'wait' };
  return { label: clipStatusLabel(vals[0]), kind: 'wait' };
}

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
  outputPath: string,
  variant = 0
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

  // 变体（variant>0）：平移裁切窗口，让输出文件内容不同。
  // 原因：ML Clips 按内容哈希去重，同一文件重复上传只会返回上一次失败的 clip 状态，
  // 必须换一片画面区域才能生成新 clip 重新送审。
  if (variant > 0) {
    const shift = ((variant * 7) % 9) * 2 - 8; // -8 .. +8 px
    cropX = Math.max(0, Math.min(cropX + shift, srcW - cropW));
  }

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
): Promise<{ success: boolean; clipUuid?: string; error?: string }> {
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
      console.log(
        `[VideoClips] 上传成功: ${cbtItemId} → clip_uuid=${data.clip_uuid} sites=${JSON.stringify(data.site_ids)}`
      );
      return { success: true, clipUuid: data.clip_uuid };
    }

    const msg = data?.message || data?.error_status || JSON.stringify(data);
    console.error(`[VideoClips] 上传失败: ${msg}`);
    return { success: false, error: msg };
  } catch (e: any) {
    console.error(`[VideoClips] 上传异常: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============ 视频处理记录（持久化） ============

export interface VideoRecord {
  detailId: string;
  storeId: string;
  cbtItemId: string;
  sourceUrl?: string;
  title?: string;
  /** 备份文件名（位于 data/video-backups/） */
  backupFile?: string;
  backupSize?: number;
  duration?: number;
  width?: number;
  height?: number;
  sites: string[];
  /** uploading=正在处理；uploaded=已提交 ML；failed=上传失败（可重试） */
  status: 'uploading' | 'uploaded' | 'failed';
  clipUuid?: string;
  /** 本次上传响应里的 clip_uuid（与状态查询的 clipUuid 不同可证明 ML 未去重） */
  lastUploadedClipUuid?: string;
  /** 上传响应返回的站点列表 */
  lastUploadedSiteIds?: string[];
  /** 转换变体编号：>0 表示为绕过 ML 内容去重而平移了裁切窗口 */
  variant?: number;
  /** 各站点审核状态：MLM → UNDER_REVIEW / AVAILABLE / REJECTED ... */
  siteStatuses: Record<string, string>;
  stage?: 'check' | 'download' | 'convert' | 'backup' | 'upload' | 'done';
  error?: string;
  createdAt: number;
  uploadedAt?: number;
  updatedAt: number;
  refreshAttempts: number;
  lastRefreshAt?: number;
}

interface VideoRecordsFile {
  version: number;
  records: Record<string, VideoRecord>;
}

const vrKey = (storeId: string, detailId: string) => `${storeId}|${detailId}`;

function loadVideoRecords(): VideoRecordsFile {
  try {
    if (fs.existsSync(VIDEO_RECORDS_FILE)) {
      const p = JSON.parse(fs.readFileSync(VIDEO_RECORDS_FILE, 'utf-8'));
      if (p && typeof p === 'object' && p.records) return p as VideoRecordsFile;
    }
  } catch (e: any) {
    console.error('[Video Records] 读取失败:', e?.message || e);
  }
  return { version: 1, records: {} };
}

let vrCache: VideoRecordsFile = loadVideoRecords();

export function saveVideoRecord(rec: VideoRecord): void {
  vrCache.records[vrKey(rec.storeId, rec.detailId)] = rec;
  try {
    if (!fs.existsSync(path.dirname(VIDEO_RECORDS_FILE))) {
      fs.mkdirSync(path.dirname(VIDEO_RECORDS_FILE), { recursive: true });
    }
    fs.writeFileSync(VIDEO_RECORDS_FILE, JSON.stringify(vrCache, null, 2));
  } catch (e: any) {
    console.error('[Video Records] 写入失败:', e?.message || e);
  }
}

export function getVideoRecords(): Record<string, VideoRecord> {
  return vrCache.records;
}

/** 所有记录按「上传时间」倒序（无上传时间则退回更新时间） */
export function listVideoRecordsSorted(): VideoRecord[] {
  return Object.values(vrCache.records).sort(
    (a, b) => (b.uploadedAt || b.updatedAt || b.createdAt) - (a.uploadedAt || a.updatedAt || a.createdAt)
  );
}

/** 备份文件绝对路径 */
export function backupFilePath(rec: Pick<VideoRecord, 'backupFile'>): string {
  return rec.backupFile ? path.join(BACKUP_DIR, rec.backupFile) : '';
}

// ============ ML Clips 状态查询 ============

/**
 * 查询某 CBT 商品在 ML Clips 的审核状态
 * GET /marketplace/items/{id}/clips
 * 返回各站点的 status（UNDER_REVIEW / AVAILABLE / REJECTED ...）
 */
export async function fetchClipStatus(
  cbtItemId: string,
  storeId: string
): Promise<{
  ok: boolean;
  clipCount: number;
  clipUuids: string[];
  siteStatuses: Record<string, string>;
  error?: string;
}> {
  const store = getStoreRaw(storeId);
  if (!store?.accessToken) {
    return { ok: false, clipCount: 0, clipUuids: [], siteStatuses: {}, error: '店铺无 access_token' };
  }
  try {
    const r = await fetch(
      `https://api.mercadolibre.com/marketplace/items/${cbtItemId}/clips?access_token=${store.accessToken}`
    );
    const data = await r.json();
    if (!r.ok) {
      return {
        ok: false,
        clipCount: 0,
        clipUuids: [],
        siteStatuses: {},
        error: data?.message || data?.error_status || `HTTP ${r.status}`,
      };
    }
    const clips = data.clips || [];
    const siteStatuses: Record<string, string> = {};
    const clipUuids: string[] = [];
    for (const c of clips) {
      if (c.clip_uuid) clipUuids.push(c.clip_uuid);
      for (const m of c.metadata || []) {
        if (m.site_id) siteStatuses[m.site_id] = m.status || 'UNKNOWN';
      }
    }
    return { ok: true, clipCount: clips.length, clipUuids, siteStatuses };
  } catch (e: any) {
    return { ok: false, clipCount: 0, clipUuids: [], siteStatuses: {}, error: e.message };
  }
}

// ============ 完整流水线 ============

export interface VideoPipelineResult {
  success: boolean;
  stage: string;
  error?: string;
  record?: VideoRecord;
}

/**
 * 完整视频处理流水线：下载 → 转换为 ML 合规格式 → 备份 → 上传 ML Clips → 记录状态
 *
 * 设计要点：
 * - 转换后的合规视频**保留**在 data/video-backups/ 作为服务器备份，供「查看视频」与失败重传复用
 * - 非强制模式下若 ML 已有 clip，直接同步审核状态返回，不重复上传（省流量、避免重复 clip）
 * - 有备份时跳过下载/转换，直接用备份上传（应对 1688 视频已删除的场景）
 * - 每一步都把状态落盘，前端轮询即可看到「上传中 / 待审核 / 已通过 / 已拒绝 / 失败」
 *
 * @param reuseBackup 有备份就直接复用（默认 true）
 * @param force 强制重新上传（忽略 ML 已有的 clip，用于「失败后按原因重传」）
 */
export async function processAndUploadVideo(opts: {
  detailId: string;
  mainImgVideoUrl: string;
  cbtItemId: string;
  siteIds: string[];
  storeId: string;
  title?: string;
  reuseBackup?: boolean;
  force?: boolean;
}): Promise<VideoPipelineResult> {
  const {
    detailId,
    mainImgVideoUrl,
    cbtItemId,
    siteIds,
    storeId,
    title,
    reuseBackup = true,
    force = false,
  } = opts;

  const now = () => Date.now();
  const key = vrKey(storeId, detailId);
  const existing = vrCache.records[key];

  const rec: VideoRecord = existing || {
    detailId,
    storeId,
    cbtItemId,
    sites: siteIds,
    status: 'uploading',
    siteStatuses: {},
    createdAt: now(),
    updatedAt: now(),
    refreshAttempts: 0,
  };
  // 刷新可变字段（storeId/cbtItemId/sites 可能变了）
  rec.storeId = storeId;
  rec.cbtItemId = cbtItemId;
  rec.detailId = detailId;
  rec.sites = siteIds;
  rec.sourceUrl = mainImgVideoUrl;
  if (title) rec.title = title;
  rec.updatedAt = now();

  // 0. 非强制：先查 ML 是否已有 clip → 正常则同步状态返回，全失败则继续重传
  let retryVariant = 0;
  if (!force) {
    const st = await fetchClipStatus(cbtItemId, storeId);
    if (st.ok && st.clipCount > 0) {
      const review = overallReview(st.siteStatuses);
      if (review.kind === 'bad') {
        // 全部站点上传失败/被拒（如 UPLOADING_ERROR）→ 不算「已上传」，按原因重传
        // 换裁切变体重传：ML Clips 按内容哈希去重，同一文件重传只会返回旧 clip 的失败状态
        retryVariant = (rec.refreshAttempts || 0) + 1;
        console.log(
          `[VideoClips] ${detailId}@${storeId.slice(0, 8)} clip 状态异常（${review.label} ` +
            `${JSON.stringify(st.siteStatuses)}），用变体 ${retryVariant} 重新转换上传`
        );
        rec.siteStatuses = { ...rec.siteStatuses, ...st.siteStatuses };
        rec.error = `上次上传状态异常：${JSON.stringify(st.siteStatuses)}`;
        rec.stage = 'check';
        rec.variant = retryVariant;
        saveVideoRecord(rec);
      } else {
        rec.status = 'uploaded';
        rec.siteStatuses = { ...rec.siteStatuses, ...st.siteStatuses };
        if (!rec.clipUuid) rec.clipUuid = st.clipUuids[0];
        rec.error = undefined;
        rec.stage = 'done';
        if (!rec.uploadedAt) rec.uploadedAt = now();
        rec.updatedAt = now();
        rec.lastRefreshAt = now();
        rec.refreshAttempts = (rec.refreshAttempts || 0) + 1;
        saveVideoRecord(rec);
        console.log(`[VideoClips] ${detailId}@${storeId.slice(0, 8)} 已有 clip，状态已同步`);
        return { success: true, stage: 'already_uploaded', record: rec };
      }
    } else if (!st.ok) {
      console.warn(`[VideoClips] ${detailId} 状态查询失败（继续尝试上传）: ${st.error}`);
    }
  }

  // 1. 定位输出文件：优先复用服务器备份
  const backupName = `${detailId}.mp4`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  const hasBackup =
    fs.existsSync(backupPath) && fs.statSync(backupPath).size > 1000;
  let outPath = backupPath;

  if (reuseBackup && hasBackup && retryVariant === 0) {
    rec.stage = 'backup';
    rec.status = 'uploading';
    rec.backupFile = backupName;
    rec.backupSize = fs.statSync(backupPath).size;
    saveVideoRecord(rec);
    console.log(`[VideoClips] ${detailId} 复用服务器备份 ${backupName}`);
  } else {
    // 1a. 下载 1688 视频
    const rawPath = path.join(TMP_DIR, `${detailId}_raw.mp4`);
    const tmpOut = path.join(TMP_DIR, `${detailId}_clips.mp4`);
    rec.stage = 'download';
    rec.status = 'uploading';
    saveVideoRecord(rec);
    console.log(`[VideoClips] 开始处理 ${detailId}: ${mainImgVideoUrl.slice(0, 60)}...`);
    const dlOk = await downloadVideo(mainImgVideoUrl, rawPath);

    if (dlOk) {
      // 1b. 转换为 ML 合规格式（9:16、10-61s、含音频、1080x1920）
      rec.stage = 'convert';
      saveVideoRecord(rec);
      const convResult = await convertToClipsFormat(rawPath, tmpOut, retryVariant);
      if (convResult.success) {
        // 1c. 写入服务器备份（永久保留）
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        try {
          fs.copyFileSync(tmpOut, backupPath);
          outPath = backupPath;
        } catch (e: any) {
          outPath = tmpOut; // 备份写失败则用临时文件继续上传，不阻断
        }
        rec.duration = convResult.info?.duration;
        rec.width = convResult.info?.width;
        rec.height = convResult.info?.height;
        if (convResult.info) {
          console.log(
            `[VideoClips] ${detailId} 转换完成 ${convResult.info.width}x${convResult.info.height} ` +
              `${convResult.info.duration.toFixed(1)}s 音频=${convResult.info.hasAudio}`
          );
        }
      } else {
        // 转换失败：有备份则退回用备份，否则报错
        try { fs.unlinkSync(rawPath); } catch {}
        if (hasBackup) {
          outPath = backupPath;
        } else {
          rec.status = 'failed';
          rec.error = `视频转换失败：${convResult.error}`;
          rec.updatedAt = now();
          saveVideoRecord(rec);
          return { success: false, stage: 'convert', error: rec.error, record: rec };
        }
      }
    } else {
      // 下载失败：有备份则退回用备份（应对 1688 视频已删除），否则报错
      if (hasBackup) {
        outPath = backupPath;
      } else {
        rec.status = 'failed';
        rec.error = '下载失败（1688 视频可能已删除或需登录）';
        rec.updatedAt = now();
        saveVideoRecord(rec);
        return { success: false, stage: 'download', error: rec.error, record: rec };
      }
    }
    try {
      fs.unlinkSync(rawPath);
      fs.unlinkSync(tmpOut);
    } catch {}
    rec.backupFile = backupName;
    rec.backupSize = fs.existsSync(backupPath) ? fs.statSync(backupPath).size : 0;
    rec.stage = 'backup';
    saveVideoRecord(rec);
  }

  // 兜底：确保输出文件可用
  if (!fs.existsSync(outPath)) {
    rec.status = 'failed';
    rec.error = '无可用视频文件（无备份且源视频下载失败）';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: 'prepare', error: rec.error, record: rec };
  }

  // 2. 上传 ML Clips
  rec.stage = 'upload';
  saveVideoRecord(rec);
  const uploadResult = await uploadClip(cbtItemId, outPath, siteIds, storeId);
  if (!uploadResult.success) {
    rec.status = 'failed';
    rec.error = uploadResult.error || '上传失败';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: 'upload', error: rec.error, record: rec };
  }

  // 3. 上传成功 → 立即查一次审核状态（通常 UNDER_REVIEW）
  const st2 = await fetchClipStatus(cbtItemId, storeId);
  rec.status = 'uploaded';
  rec.lastUploadedClipUuid = uploadResult.clipUuid;
  if (st2.ok) {
    rec.siteStatuses = { ...rec.siteStatuses, ...st2.siteStatuses };
    rec.clipUuid = st2.clipUuids[0] || rec.clipUuid;
  } else {
    rec.clipUuid = rec.clipUuid || uploadResult.clipUuid;
  }
  rec.error = undefined;
  rec.stage = 'done';
  rec.uploadedAt = rec.uploadedAt || now();
  rec.updatedAt = now();
  saveVideoRecord(rec);

  console.log(
    `[VideoClips] ${detailId}@${storeId.slice(0, 8)} 视频上传完成 variant=${rec.variant || 0} ` +
      `uploaded=${uploadResult.clipUuid} status=${JSON.stringify(rec.siteStatuses)}`
  );
  return { success: true, stage: 'done', record: rec };
}

/**
 * 刷新单个视频记录：
 * 1. 先查 ML 审核状态并落盘（刷新「待审核 → 已通过 / 已拒绝」）
 * 2. 若 ML 侧已无 clip（被拒/被删）→ 按失败原因自动重传（优先用服务器备份）
 *
 * @param forceReupload 强制重新上传，即使 ML 已有 clip
 */
export async function refreshVideoRecord(
  rec: VideoRecord,
  opts: { forceReupload?: boolean } = {}
): Promise<VideoRecord> {
  // 先把本次刷新计数写进缓存里的同一条记录（processAndUploadVideo 会读同 key 续接）
  const cur = vrCache.records[vrKey(rec.storeId, rec.detailId)] || rec;
  const r: VideoRecord = {
    ...cur,
    detailId: rec.detailId,
    storeId: rec.storeId,
    cbtItemId: rec.cbtItemId,
    sites: rec.sites,
    title: rec.title,
    sourceUrl: cur.sourceUrl || rec.sourceUrl,
    refreshAttempts: (cur.refreshAttempts || 0) + 1,
    lastRefreshAt: Date.now(),
    updatedAt: Date.now(),
    siteStatuses: { ...cur.siteStatuses },
  };
  if (!r.createdAt) r.createdAt = Date.now();
  saveVideoRecord(r);

  if (!r.sourceUrl && !(r.backupFile && fs.existsSync(backupFilePath(r)))) {
    r.status = 'failed';
    r.error = '无源视频 URL 且无服务器备份，无法重传';
    r.updatedAt = Date.now();
    saveVideoRecord(r);
    return r;
  }

  return (await processAndUploadVideo({
    detailId: r.detailId,
    mainImgVideoUrl: r.sourceUrl || '',
    cbtItemId: r.cbtItemId,
    siteIds: r.sites,
    storeId: r.storeId,
    title: r.title,
    reuseBackup: true,
    force: !!opts.forceReupload,
  })).record!;
}

/** 批量刷新：默认只同步审核状态；force=true 时全部强制重传 */
export async function refreshAllVideoRecords(
  forceReupload = false
): Promise<{ total: number; done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const rec of Object.values(vrCache.records)) {
    try {
      const r = await refreshVideoRecord(rec, { forceReupload });
      if (r.status === 'failed') failed++;
      else done++;
    } catch (e: any) {
      console.error(`[VideoClips] 刷新 ${rec.detailId} 异常: ${e.message}`);
      failed++;
    }
  }
  return { total: Object.keys(vrCache.records).length, done, failed };
}

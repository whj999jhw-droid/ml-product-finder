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

import { buildProductVideoPrompt, describeCategory, llmMotionForProduct } from './videoPrompt.js';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { getStoreRaw, ensureStoreToken } from './stores.js';
import { generateVideoFromImage } from './i2v.js';
import { generateSlideshowVideo } from './slideshow.js';

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

// ============ 店铺 token（上传前必须续期） ============

/**
 * 取店铺可用 access token：过期或临近过期（<5 分钟）自动用 refresh_token 续期。
 *
 * 为什么必须在这里做：ML 的 access token 寿命约 40 分钟，而定时续期是 30 分钟一次、
 * 且启动时才预热。视频处理链路是长任务（下载+转换+上传可能跨越 token 过期点），
 * 用过期 token 上传会得到 `{"code":"unauthorized","message":"invalid access token"}`，
 * ML 侧则把该 clip 标成 UPLOADING_ERROR —— 视频本身完全合规也会「失败」。
 */
async function getValidToken(storeId: string): Promise<{ token: string; error?: string }> {
  const store = getStoreRaw(storeId);
  if (!store) return { token: '', error: '店铺不存在' };
  if (!store.accessToken) {
    return { token: '', error: '店铺无 access token，请到「店铺管理」重新授权' };
  }
  try {
    return { token: await ensureStoreToken(store) };
  } catch (e: any) {
    return { token: '', error: `店铺 token 无效且自动续期失败：${e.message}` };
  }
}

/** 判断错误是否为鉴权问题（用于区分「token 问题」与「视频内容问题」） */
const isAuthError = (msg?: string) =>
  !!msg && /unauthorized|invalid access token|invalid_token/i.test(msg);

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

/**
 * 把 **AI 生成的原始片段** 归一化成 ML Clips 合规格式。
 *
 * 与 convertToClipsFormat 的区别：那个是为「1688 横版源视频」设计的（居中裁 9:16 + 去底部 12%）；
 * AI 片段可能本来就是竖版（1024x1792），用那套会把画面裁成中间一条，必须改用
 * 「覆盖式缩放 + 居中裁切」（force_original_aspect_ratio=increase + crop），横竖都正确。
 *
 * 另外 AI 片段常见问题：无音轨（ML 要求必须有音频）、时长 5s（ML 要求 ≥10s）、
 * 智谱免费档右下角烧了「AI生成」水印（只能裁不能关，实测纵向 95.0%~97.7% → 裁底部 8%）。
 */
export async function normalizeAiClip(
  inputPath: string,
  outputPath: string,
  opts: { cropBottomPct?: number; targetDuration?: number } = {},
): Promise<{ success: boolean; info: VideoInfo | null; error?: string }> {
  const info = await getVideoInfo(inputPath);
  if (!info || !info.width) {
    return { success: false, info: null, error: 'ffprobe 读不出 AI 片段信息（原始片段可能是 mjpeg-in-mp4、无时长元数据）' };
  }
  const srcDur = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : 5;
  const target = Math.max(10, Math.min(opts.targetDuration || 12, 60));
  const cropBottom = Math.max(0, Math.min(opts.cropBottomPct || 0, 0.2));

  const preCrop = cropBottom > 0 ? `crop=iw:ih*${(1 - cropBottom).toFixed(4)}:0:0,` : '';
  const vf = `${preCrop}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30`;

  const args: string[] = ['-y'];
  if (srcDur < target - 0.3) args.push('-stream_loop', '-1'); // 太短：循环补足
  args.push('-i', inputPath);
  if (!info.hasAudio) {
    // 无音轨 → 补静音轨（ML Clips 强制要求有音频）
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
  }
  args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '128k');
  if (!info.hasAudio) args.push('-map', '0:v:0', '-map', '1:a:0');
  args.push('-t', String(target), '-shortest', outputPath);

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await execFileAsync('ffmpeg', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    return { success: true, info };
  } catch (e: any) {
    console.error(`[VideoClips] AI 片段归一化失败: ${e?.message}`);
    return { success: false, info, error: `AI 片段归一化失败：${String(e?.message || e).slice(0, 300)}` };
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
): Promise<{ success: boolean; clipUuid?: string; authError?: boolean; error?: string }> {
  const { token, error } = await getValidToken(storeId);
  if (!token) {
    return { success: false, authError: true, error };
  }

  try {
    // 使用 curl 上传（ML Clips API 对 sites 字段格式敏感，curl 的 multipart 处理更可靠）
    const args = [
      '-s', '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
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
    return { success: false, authError: isAuthError(msg), error: msg };
  } catch (e: any) {
    console.error(`[VideoClips] 上传异常: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============ 视频处理记录（持久化） ============

export interface VideoRecord {
  /** 记录键对应的商品标识：老流程=妙手 detailId，新「视频生成」tab=ML CBT itemId */
  detailId: string;
  storeId: string;
  cbtItemId: string;
  /** ML CBT 商品 ID（与 cbtItemId 同义，便于前端按 itemId 匹配） */
  itemId?: string;
  /** 关联到的妙手采集箱 detailId（可能为空，纯 ML 存量商品没有） */
  miaoshouDetailId?: string;
  /** 这条视频的来源：source=1688/妙手源视频转码 / backup=服务器已有备份 / ai=AI 图生视频 */
  sourceKind?: 'source' | 'backup' | 'ai';
  /** 商品主图 URL（AI 图生视频兼底用，刷新/重传时可再次生成） */
  mainImageUrl?: string;
  sourceUrl?: string;
  title?: string;
  /** 备份文件名（位于 data/video-backups/） */
  backupFile?: string;
  backupSize?: number;
  duration?: number;
  width?: number;
  height?: number;
  sites: string[];
  /**
   * uploading=正在处理；uploaded=已提交 ML；failed=上传失败（可重试）；
   * generated=本地备份已就绪但**还没上传 ML**（定时流水线拆成「生成」「上传」两条
   * 独立限流链路后引入：每小时生成 N 条、每小时上传 M 条，M<N 时会有积压）
   */
  status: 'uploading' | 'uploaded' | 'failed' | 'generated';
  clipUuid?: string;
  /** 本次上传响应里的 clip_uuid（与状态查询的 clipUuid 不同可证明 ML 未去重） */
  lastUploadedClipUuid?: string;
  /** 上传响应返回的站点列表 */
  lastUploadedSiteIds?: string[];
  /** 各站点审核状态：MLM → UNDER_REVIEW / AVAILABLE / REJECTED ... */
  siteStatuses: Record<string, string>;
  stage?: 'auth' | 'check' | 'download' | 'convert' | 'backup' | 'upload' | 'done' | 'generated';
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
  authError?: boolean;
  error?: string;
}> {
  const { token, error } = await getValidToken(storeId);
  if (!token) {
    return { ok: false, clipCount: 0, clipUuids: [], siteStatuses: {}, authError: true, error };
  }
  try {
    const r = await fetch(
      `https://api.mercadolibre.com/marketplace/items/${cbtItemId}/clips?access_token=${token}`
    );
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.message || data?.error_status || `HTTP ${r.status}`;
      return {
        ok: false,
        clipCount: 0,
        clipUuids: [],
        siteStatuses: {},
        authError: isAuthError(msg),
        error: msg,
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
  /** 记录键：老流程传妙手 detailId；「视频生成」tab 传 ML itemId */
  detailId: string;
  mainImgVideoUrl: string;
  cbtItemId: string;
  siteIds: string[];
  storeId: string;
  title?: string;
  reuseBackup?: boolean;
  force?: boolean;
  /** 商品主图 URL —— 既无源视频又无备份时用它做 AI 图生视频 */
  mainImageUrl?: string;
  /** 额外的备份文件名（不带 .mp4），用于兼容老流程按妙手 detailId 存的备份 */
  altBackupKeys?: string[];
  /** 是否允许 AI 图生视频兜底（默认允许） */
  enableAiFallback?: boolean;
  /** 关联到的妙手采集箱 detailId（仅记录用） */
  miaoshouDetailId?: string;
  /** 本次运行内已熔断的 AI 视频平台（批量任务复用） */
  disabledAiPlatforms?: Set<string>;
  /**
   * 阶段拆分（定时任务用）：
   *  - 'generate' 只产出并落本地备份，**不调 ML 上传**
   *  - 'upload'   只从本地备份上传 ML；没有备份就失败（不再下载/不重新 AI 生成）
   *  - 'both'     生成后立刻上传（默认，兼容旧的单次按键行为）
   */
  mode?: 'generate' | 'upload' | 'both';
  /**
   * AI 图生视频的动作指令模式：
   *  - 'auto' 先用 LLM 按标题写场景描述，失败降级到品类规则（推荐）
   *  - 'rule' 只用本地品类规则（零成本、零延迟）
   */
  aiPromptMode?: 'auto' | 'rule';
  /** 商品图片列表（主图之外的细节图）——全部 AI 平台失败时做「图集运镜视频」兜底 */
  imageUrls?: string[];
  /** 是否允许「图集运镜视频」兜底（AI 全挂时的保底，默认允许） */
  enableSlideshowFallback?: boolean;
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
    mainImageUrl,
    altBackupKeys,
    enableAiFallback = true,
    miaoshouDetailId,
    disabledAiPlatforms,
    mode = 'both',
    aiPromptMode = 'auto',
    imageUrls,
    enableSlideshowFallback = true,
  } = opts;

  // 阶段拆分：能否「现场生成」/ 是否需要「上传 ML」
  const canProduce = mode !== 'upload';
  const doUpload = mode !== 'generate';

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
  rec.itemId = cbtItemId;
  rec.miaoshouDetailId = miaoshouDetailId || rec.miaoshouDetailId;
  rec.sites = siteIds;
  if (mainImgVideoUrl && !mainImgVideoUrl.startsWith('backup://')) rec.sourceUrl = mainImgVideoUrl;
  if (mainImageUrl) rec.mainImageUrl = mainImageUrl;
  if (title) rec.title = title;
  rec.updatedAt = now();

  // 0. 先查 ML 是否已有 clip
  const pre = await fetchClipStatus(cbtItemId, storeId);
  // 鉴权失败：token 过期且续期失败 → 不浪费带宽下载/转换，直接给出可操作提示
  if (!pre.ok && pre.authError) {
    rec.status = 'failed';
    rec.error = pre.error || '店铺 access token 无效';
    rec.stage = 'auth';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: 'auth', error: rec.error, record: rec };
  }
  if (!force && pre.ok && pre.clipCount > 0) {
    const review = overallReview(pre.siteStatuses);
    if (review.kind === 'bad') {
      // 全部站点上传失败/被拒（UPLOADING_ERROR / REJECTED）→ 不算「已上传」，按原因重传。
      // 注意：实测 ML 不为同文件去重（同一商品连续 4 次上传拿到 4 个不同 clip_uuid），
      // 因此重传可以直接复用服务器备份，无需重新下载转换。
      // 另外 DELETE /clips/{uuid} 对 UPLOADING_ERROR 状态的 clip 也返回 ERROR，删不掉，
      // 失败 clip 会在 ML 侧堆积，需要去卖家后台人工清理。
      console.log(
        `[VideoClips] ${detailId}@${storeId.slice(0, 8)} clip 状态异常（${review.label} ` +
          `${JSON.stringify(pre.siteStatuses)}），重新上传`
      );
      rec.siteStatuses = { ...rec.siteStatuses, ...pre.siteStatuses };
      rec.error = `上次上传状态异常：${JSON.stringify(pre.siteStatuses)}`;
      rec.stage = 'check';
      saveVideoRecord(rec);
    } else {
      rec.status = 'uploaded';
      rec.siteStatuses = { ...rec.siteStatuses, ...pre.siteStatuses };
      if (!rec.clipUuid) rec.clipUuid = pre.clipUuids[0];
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
  } else if (!pre.ok) {
    console.warn(`[VideoClips] ${detailId} 状态查询失败（继续尝试上传）: ${pre.error}`);
  }

  // ============ 1. 定位/生成输出文件 ============
  // 三档来源（按优先级）：
  //   ① 服务器已有备份  —— 含老流程按妙手 detailId 存的备份（altBackupKeys）
  //   ② 1688 / 妙手源视频 —— 下载 → 裁 9:16 → 去底部文字 → 限时长
  //   ③ AI 图生视频       —— 用商品主图现场生成 → 归一化（含去水印/补音轨/补时长）
  const backupKeys = Array.from(new Set([detailId, ...(altBackupKeys || [])].filter(Boolean)));
  const findBackup = (): string => {
    for (const k of backupKeys) {
      const p = path.join(BACKUP_DIR, `${k}.mp4`);
      try {
        if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
      } catch { /* ignore */ }
    }
    return '';
  };
  const backupName = `${detailId}.mp4`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  const foundBackup = findBackup();
  const hasBackup = !!foundBackup;
  let outPath = backupPath;
  const tried: string[] = [];

  if (hasBackup && (reuseBackup || !canProduce)) {
    rec.stage = 'backup';
    rec.status = 'uploading';
    rec.sourceKind = 'backup';
    rec.backupFile = path.basename(foundBackup);
    rec.backupSize = fs.statSync(foundBackup).size;
    saveVideoRecord(rec);
    outPath = foundBackup;
    console.log(`[VideoClips] ${detailId} 复用服务器备份 ${path.basename(foundBackup)}`);
  } else if (!canProduce) {
    // upload 模式：本地没有视频就到此为止，不再消耗额度去下载/AI 生成
    rec.status = 'failed';
    rec.error = '本地还没有生成好的视频（upload 模式不重新生成，先跑 generate 阶段）';
    rec.stage = 'prepare';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: 'prepare', error: rec.error, record: rec };
  } else {
    let produced = false;
    const rawPath = path.join(TMP_DIR, `${detailId}_raw.mp4`);
    const tmpOut = path.join(TMP_DIR, `${detailId}_clips.mp4`);

    // ② 源视频（1688 / 妙手 mainImgVideoUrl）
    if (mainImgVideoUrl && !mainImgVideoUrl.startsWith('backup://')) {
      rec.stage = 'download';
      rec.status = 'uploading';
      rec.sourceKind = 'source';
      saveVideoRecord(rec);
      console.log(`[VideoClips] 开始处理 ${detailId}: ${mainImgVideoUrl.slice(0, 60)}...`);
      const dlOk = await downloadVideo(mainImgVideoUrl, rawPath);
      if (dlOk) {
        rec.stage = 'convert';
        saveVideoRecord(rec);
        const convResult = await convertToClipsFormat(rawPath, tmpOut);
        if (convResult.success) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
          try {
            fs.copyFileSync(tmpOut, backupPath);
            outPath = backupPath;
          } catch {
            outPath = tmpOut; // 备份写失败则用临时文件继续上传，不阻断
          }
          rec.duration = convResult.info?.duration;
          rec.width = convResult.info?.width;
          rec.height = convResult.info?.height;
          produced = true;
          console.log(
            `[VideoClips] ${detailId} 源视频转换完成 ${convResult.info?.width}x${convResult.info?.height} ` +
              `${(convResult.info?.duration || 0).toFixed(1)}s 音频=${convResult.info?.hasAudio}`,
          );
        } else {
          tried.push(`源视频转换失败：${convResult.error}`);
        }
      } else {
        tried.push('源视频下载失败（1688 视频可能已删除或需登录）');
      }
      try { fs.unlinkSync(rawPath); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
    } else {
      tried.push('该商品没有 1688 / 妙手源视频');
    }

    // ③ AI 图生视频兜底
    if (!produced && enableAiFallback && mainImageUrl) {
      rec.stage = 'ai';
      rec.status = 'uploading';
      rec.sourceKind = 'ai';
      rec.error = `源视频不可用，改用 AI 图生视频：${tried.join('；')}`;
      saveVideoRecord(rec);
      console.log(`[VideoClips] ${detailId} 无源视频，改用 AI 图生视频（主图 ${mainImageUrl.slice(0, 60)}）`);
      const aiRaw = path.join(TMP_DIR, `${detailId}_ai_raw.mp4`);
      const aiOut = path.join(TMP_DIR, `${detailId}_ai_clips.mp4`);
      // 商品化动作指令：让视频「和这件商品有关」且具备购买吸引力。
      // LLM 失败会静默降级到品类规则，不阻塞整条流水线。
      let llmMotion = '';
      if (title && aiPromptMode === 'auto') {
        llmMotion = await llmMotionForProduct(title);
        if (llmMotion) console.log(`[VideoClips] ${detailId} AI 动作指令（LLM）：${llmMotion.slice(0, 70)}…`);
      }
      const aiPrompt = buildProductVideoPrompt({ title, llmMotion });
      if (!llmMotion) {
        console.log(
          `[VideoClips] ${detailId} AI 动作指令（品类=${describeCategory(title)}）：${aiPrompt.slice(0, 70)}…`,
        );
      }
      const ai = await generateVideoFromImage({
        imageUrl: mainImageUrl,
        outPath: aiRaw,
        durationSec: 10,
        disabledPlatforms: disabledAiPlatforms,
        title,
        prompt: aiPrompt,
      });
      if (ai.ok) {
        const norm = await normalizeAiClip(aiRaw, aiOut, {
          cropBottomPct: ai.cropBottomPct,
          targetDuration: 10,
        });
        if (norm.success) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
          try {
            fs.copyFileSync(aiOut, backupPath);
            outPath = backupPath;
          } catch {
            outPath = aiOut;
          }
          rec.duration = norm.info?.duration;
          rec.width = norm.info?.width;
          rec.height = norm.info?.height;
          produced = true;
          rec.sourceUrl = `ai:${ai.providerName || ai.platform}`;
          console.log(`[VideoClips] ${detailId} AI 图生视频完成（${ai.providerName}）`);
        } else {
          tried.push(`AI 片段归一化失败：${norm.error}`);
        }
      } else {
        tried.push(`AI 图生视频失败：${ai.error}`);
      }
      try { fs.unlinkSync(aiRaw); } catch { /* ignore */ }
      try { fs.unlinkSync(aiOut); } catch { /* ignore */ }
    } else if (!produced && !enableAiFallback) {
      tried.push('本次未启用 AI 图生视频兜底');
    } else if (!produced && !mainImageUrl) {
      tried.push('该商品没有可用主图，无法走 AI 图生视频');
    }

    // ③' 图集运镜视频兜底（零 AI 成本）：AI 平台全挂 / 全部欠费时，用商品多图做 Ken Burns
    //    注意画面是持续运镜的（zoompan），不是纯静态图 —— ML Clips 禁止静态图。
    if (!produced && enableSlideshowFallback) {
      const slideImgs = [...(imageUrls || [])];
      if (mainImageUrl && !slideImgs.includes(mainImageUrl)) slideImgs.unshift(mainImageUrl);
      if (slideImgs.length) {
        rec.stage = 'slideshow';
        rec.status = 'uploading';
        rec.sourceKind = 'slideshow';
        saveVideoRecord(rec);
        console.log(`[VideoClips] ${detailId} AI 不可用，改用图集运镜兜底（${slideImgs.length} 张图）`);
        const slideOut = path.join(TMP_DIR, `${detailId}_slide.mp4`);
        const slide = await generateSlideshowVideo({ imageUrls: slideImgs, outPath: slideOut });
        if (slide.success) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
          try {
            fs.copyFileSync(slideOut, backupPath);
            outPath = backupPath;
          } catch {
            outPath = slideOut;
          }
          rec.duration = slide.durationSec;
          rec.width = 1080;
          rec.height = 1920;
          rec.sourceUrl = 'slideshow:ffmpeg';
          produced = true;
          console.log(
            `[VideoClips] ${detailId} 图集运镜兜底完成（${slide.imagesUsed} 图 / ${slide.durationSec}s）`,
          );
        } else {
          tried.push(`图集运镜兜底失败：${slide.error}`);
        }
        try { fs.unlinkSync(slideOut); } catch { /* ignore */ }
      }
    }

    if (!produced) {
      if (hasBackup) {
        outPath = foundBackup;
        rec.sourceKind = 'backup';
      } else {
        rec.status = 'failed';
        rec.error = `无法获得可用视频：${tried.join('；') || '未知原因'}`;
        rec.stage = 'prepare';
        rec.updatedAt = now();
        saveVideoRecord(rec);
        return { success: false, stage: 'prepare', error: rec.error, record: rec };
      }
    }
    rec.backupFile = backupName;
    rec.backupSize = fs.existsSync(backupPath) ? fs.statSync(backupPath).size : 0;
    rec.stage = 'backup';
    saveVideoRecord(rec);
  }

  // 兜底：确保输出文件可用
  if (!outPath || !fs.existsSync(outPath)) {
    rec.status = 'failed';
    rec.error = '无可用视频文件（既无备份，源视频与 AI 生成也没成功）';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: 'prepare', error: rec.error, record: rec };
  }

  // ===== 阶段边界：generate 模式在这里收尾（落盘到 data/video-backups/，不调 ML）=====
  if (!doUpload) {
    rec.status = 'generated';
    rec.stage = 'generated';
    rec.error = undefined;
    rec.updatedAt = now();
    saveVideoRecord(rec);
    console.log(
      `[VideoClips] ${detailId}@${storeId.slice(0, 8)} 视频已生成待上传 ` +
        `${rec.backupFile} (${Math.round((rec.backupSize || 0) / 1024)}KB, source=${rec.sourceKind})`,
    );
    return { success: true, stage: 'generated', record: rec };
  }

  // 2. 上传 ML Clips
  rec.stage = 'upload';
  saveVideoRecord(rec);
  const uploadResult = await uploadClip(cbtItemId, outPath, siteIds, storeId);
  if (!uploadResult.success) {
    rec.status = 'failed';
    rec.error = uploadResult.authError
      ? `店铺 token 无效，请重新授权：${uploadResult.error || 'invalid access token'}`
      : uploadResult.error || '上传失败';
    rec.stage = uploadResult.authError ? 'auth' : 'upload';
    rec.updatedAt = now();
    saveVideoRecord(rec);
    return { success: false, stage: rec.stage, error: rec.error, record: rec };
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
    `[VideoClips] ${detailId}@${storeId.slice(0, 8)} 视频上传完成 ` +
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
    mainImageUrl: cur.mainImageUrl || rec.mainImageUrl,
    miaoshouDetailId: cur.miaoshouDetailId || rec.miaoshouDetailId,
    refreshAttempts: (cur.refreshAttempts || 0) + 1,
    lastRefreshAt: Date.now(),
    updatedAt: Date.now(),
    siteStatuses: { ...cur.siteStatuses },
  };
  if (!r.createdAt) r.createdAt = Date.now();
  saveVideoRecord(r);

  if (!r.sourceUrl && !r.mainImageUrl && !(r.backupFile && fs.existsSync(backupFilePath(r)))) {
    r.status = 'failed';
    r.error = '无源视频 URL、无商品主图且无服务器备份，无法重传';
    r.updatedAt = Date.now();
    saveVideoRecord(r);
    return r;
  }

  return (await processAndUploadVideo({
    detailId: r.detailId,
    mainImgVideoUrl: (r.sourceUrl || '').startsWith('ai:') ? '' : (r.sourceUrl || ''),
    cbtItemId: r.cbtItemId,
    siteIds: r.sites,
    storeId: r.storeId,
    title: r.title,
    mainImageUrl: r.mainImageUrl,
    miaoshouDetailId: r.miaoshouDetailId,
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

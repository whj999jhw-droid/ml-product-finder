/**
 * server/autoVideo.ts
 * 「自动给全店商品批量生成并上传视频」的定时流水线。
 *
 * 需求（用户原话）：
 *   · 每小时生成 10 个商品的视频
 *   · 每小时内上传 3~6 条到美客多
 *   · 生成完了就不再生成，上传完了就不再上传，全部做完自动结束
 *   · 能在 ml-finder 后台配置
 *
 * 为什么拆成「生成」「上传」两条独立链路：
 *   AI 图生视频一件要 60~90 秒，ML Clips 上传也要二三十秒且有限流，
 *   两个动作的瓶颈不同（生成慢、上传被限）。合在一条链路里会出现
 *   「上传配额没用完但生成堵塞」或「攒了一堆视频没人传」。
 *   拆开后各自按自己的小时配额跑，中间的待上传队列就是缓冲。
 *
 * 为什么 session 级队列要落盘：
 *   pm2 重启 / index.ts 改代码重部署会导致内存队列丢失，
 *   落盘到 data/auto-video.json 后重启能接着跑（这也是用户「任务全部结束才停」的前提）。
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

import { getStoreRaw, listStores } from './stores.js';
import { ensureIndex, listItems } from './storeItems.js';
import { getVideoRecords, BACKUP_DIR } from './videoClips.js';
import { resolveContext, runItemVideo } from './miaoshouRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = path.join(__dirname, '..', 'data', 'auto-video.json');
const HOUR = 60 * 60 * 1000;
/** tick 间隔：配额按小时算，但每 3 分钟检查一次，避免整点集中触发 ML 限流 */
const TICK_MS = 3 * 60 * 1000;
/** 单个商品最多重试次数（含首次）；超过就标 failed，不再占用配额 */
const MAX_ATTEMPTS = 2;

export type AutoVideoPhase = 'stopped' | 'running' | 'paused' | 'finished';

export interface AutoVideoConfig {
  enabled: boolean;
  /** 参与店铺（storeId）；空数组 = 全部已授权店铺 */
  storeIds: string[];
  /** 每小时最多生成几条（默认 10） */
  generatePerHour: number;
  /** 每小时最多上传几条（3~6，默认 4） */
  uploadPerHour: number;
  /** 只处理站点级真正在售的商品（默认 true；关掉会把被美客多禁止的也拉进来） */
  onlyOnSale: boolean;
  /** 跳过 ML 已有 clip / 本地已上传过的商品（默认 true） */
  skipExisting: boolean;
  /** 队列排序：最新上架 / 销量高 / 随机 */
  order: 'newest' | 'sold' | 'random';
  /** 整轮流水线最多处理多少件（0 = 不限） */
  maxTotal: number;
  /** 上传到哪些站点（默认墨西哥 MLM） */
  sites: string[];
  /** AI 图生视频的动作指令模式：先用 LLM 按标题写场景，失败降级品类规则 */
  aiPromptMode: 'auto' | 'rule';
  /** 是否允许 AI 图生视频兜底（没有源视频时） */
  enableAiFallback: boolean;
}

export interface AutoVideoQueueItem {
  key: string;
  storeId: string;
  storeNick?: string;
  itemId: string;
  title: string;
  thumbnail?: string;
  /** pending=待生成；generated=已生成本地视频待上传；uploaded=已上传；failed=失败放弃 */
  state: 'pending' | 'generated' | 'uploaded' | 'failed';
  sourceKind?: 'source' | 'backup' | 'ai';
  error?: string;
  attempts: number;
  generatedAt?: number;
  uploadedAt?: number;
  clipUuid?: string;
}

export interface AutoVideoState {
  phase: AutoVideoPhase;
  startedAt?: number;
  finishedAt?: number;
  /** 当前小时窗口起点（配额从此刻起算） */
  windowStart: number;
  generatedThisHour: number;
  uploadedThisHour: number;
  totalGenerated: number;
  totalUploaded: number;
  totalFailed: number;
  queue: AutoVideoQueueItem[];
  lastTickAt?: number;
  lastMessage?: string;
  lastError?: string;
}

interface PersistedShape {
  config: AutoVideoConfig;
  state: AutoVideoState;
}

const DEFAULT_CONFIG: AutoVideoConfig = {
  enabled: false,
  storeIds: [],
  generatePerHour: 10,
  uploadPerHour: 4,
  onlyOnSale: true,
  skipExisting: true,
  order: 'newest',
  maxTotal: 0,
  sites: ['MLM'],
  aiPromptMode: 'auto',
  enableAiFallback: true,
};

function emptyState(): AutoVideoState {
  return {
    phase: 'stopped',
    windowStart: Date.now(),
    generatedThisHour: 0,
    uploadedThisHour: 0,
    totalGenerated: 0,
    totalUploaded: 0,
    totalFailed: 0,
    queue: [],
  };
}

let config: AutoVideoConfig = { ...DEFAULT_CONFIG };
let state: AutoVideoState = emptyState();

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** AI 平台短路表：平台 → 恢复时间戳（过点后自动重试） */
const aiCooldown = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ 持久化 ============

function load(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as PersistedShape;
      if (p?.config) config = { ...DEFAULT_CONFIG, ...p.config };
      if (p?.state) state = { ...emptyState(), ...p.state, queue: Array.isArray(p.state.queue) ? p.state.queue : [] };
    }
  } catch (e: any) {
    console.warn(`[AutoVideo] 读取状态失败（用默认值）: ${e?.message || e}`);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ config, state }, null, 2));
  } catch (e: any) {
    console.warn(`[AutoVideo] 写状态失败: ${e?.message || e}`);
  }
}

load();

// ============ 对外：配置 ============

export function getAutoVideoConfig(): AutoVideoConfig {
  return { ...config };
}

export function saveAutoVideoConfig(patch: Partial<AutoVideoConfig>): { config: AutoVideoConfig; warnings: string[] } {
  const warnings: string[] = [];
  const next: AutoVideoConfig = { ...config };

  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (Array.isArray(patch.storeIds)) next.storeIds = patch.storeIds.filter(Boolean);
  if (typeof patch.onlyOnSale === 'boolean') next.onlyOnSale = patch.onlyOnSale;
  if (typeof patch.skipExisting === 'boolean') next.skipExisting = patch.skipExisting;
  if (typeof patch.enableAiFallback === 'boolean') next.enableAiFallback = patch.enableAiFallback;
  if (Array.isArray(patch.sites) && patch.sites.length) next.sites = patch.sites.filter(Boolean);
  if (patch.aiPromptMode === 'auto' || patch.aiPromptMode === 'rule') next.aiPromptMode = patch.aiPromptMode;
  if (patch.order === 'newest' || patch.order === 'sold' || patch.order === 'random') next.order = patch.order;

  if (typeof patch.generatePerHour === 'number') {
    const n = Math.max(0, Math.floor(patch.generatePerHour));
    next.generatePerHour = Math.min(n, 50);
    if (n > 50) warnings.push('每小时生成数上限为 50，已自动收敛');
  }
  if (typeof patch.uploadPerHour === 'number') {
    const n = Math.max(0, Math.floor(patch.uploadPerHour));
    next.uploadPerHour = Math.min(n, 20);
    if (n > 20) warnings.push('每小时上传数上限为 20，已自动收敛');
    if (n > 6) warnings.push('美客多 Clips 对频繁上传敏感，超过 6 条/小时有被限流风险');
  }
  if (typeof patch.maxTotal === 'number') next.maxTotal = Math.max(0, Math.floor(patch.maxTotal));

  config = next;
  save();

  // 打开了开关但没有队列且没在跑 → 自动起一轮
  if (config.enabled && state.phase === 'stopped') {
    void startAutoVideo().catch((e) => console.error(`[AutoVideo] 自动启动失败: ${e?.message}`));
  }
  return { config: getAutoVideoConfig(), warnings };
}

// ============ 对外：状态 ============

export function getAutoVideoStatus(): {
  config: AutoVideoConfig;
  state: AutoVideoState;
  counts: { pending: number; generated: number; uploaded: number; failed: number; total: number };
  /** 距离当前小时窗口结束还有多少毫秒 */
  windowLeftMs: number;
  ticking: boolean;
} {
  const c = { pending: 0, generated: 0, uploaded: 0, failed: 0, total: state.queue.length };
  for (const it of state.queue) {
    if (it.state === 'pending') c.pending++;
    else if (it.state === 'generated') c.generated++;
    else if (it.state === 'uploaded') c.uploaded++;
    else if (it.state === 'failed') c.failed++;
  }
  const windowLeftMs = Math.max(0, HOUR - (Date.now() - state.windowStart));
  return { config: getAutoVideoConfig(), state, counts: c, windowLeftMs, ticking };
}

/** 最近 N 条队列（给后台页面展示，避免一次返回几千条） */
export function getAutoVideoQueue(limit = 100, filter?: string): AutoVideoQueueItem[] {
  let q = state.queue;
  if (filter && filter !== 'all') q = q.filter((i) => i.state === filter);
  return q.slice(0, Math.max(1, Math.min(limit, 1000)));
}

// ============ 队列构建 ============

function targetStoreIds(): string[] {
  // authorized = 已完成 ML OAuth 授权（listStores 内部判定）
  const all = listStores().filter((s) => s.authorized);
  if (config.storeIds.length) {
    const set = new Set(config.storeIds);
    return all.filter((s) => set.has(s.id)).map((s) => s.id);
  }
  return all.map((s) => s.id);
}

/**
 * 构建待处理队列：
 *   站点级真正在售 → 同款去重（同一 SKU 只留最新一条）→ 排除已有视频的 → 排序
 */
async function buildQueue(): Promise<{ added: number; skipped: number; reason: string }> {
  const storeIds = targetStoreIds();
  if (!storeIds.length) return { added: 0, skipped: 0, reason: '没有已授权的店铺' };

  const records = getVideoRecords();
  const rows: Array<{ storeId: string; storeNick?: string; itemId: string; title: string; thumbnail?: string; dateCreated?: string; soldQuantity?: number }> = [];

  for (const storeId of storeIds) {
    const store = getStoreRaw(storeId);
    if (!store) continue;
    await ensureIndex(storeId);
    const items = listItems(storeId, {
      status: 'active',
      page: 1,
      pageSize: 20000,
      onSale: config.onlyOnSale ? 'yes' : 'all',
    }).items;
    for (const r of items) rows.push({
      storeId,
      storeNick: (store as any).nickname,
      itemId: r.id,
      title: r.title,
      thumbnail: r.thumbnail,
      dateCreated: (r as any).dateCreated,
      soldQuantity: (r as any).soldQuantity,
    });
  }

  // 同款去重：同一件商品被换标题重复上架时 SKU 相同，留最新一条
  const first = new Map<string, number>();
  const keyOf = (r: any) => String((r as any).dupKey || `id:${r.itemId}`);
  for (const r of rows as any[]) {
    const k = keyOf(r);
    if (first.has(k)) continue;
    first.set(k, 1);
  }
  const seen = new Set<string>();
  const dedup = rows.filter((r: any) => {
    const k = keyOf(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 排序
  const sorted = [...dedup];
  if (config.order === 'sold') sorted.sort((a, b) => (b.soldQuantity || 0) - (a.soldQuantity || 0));
  else if (config.order === 'random') sorted.sort(() => Math.random() - 0.5);
  else sorted.sort((a, b) => String(b.dateCreated || '').localeCompare(String(a.dateCreated || '')));

  const queue: AutoVideoQueueItem[] = [];
  let skipped = 0;
  for (const r of sorted) {
    const key = `${r.storeId}|${r.itemId}`;
    const rec = records[key] || records[`${r.storeId}|${r.itemId}`];
    // 已上传过 → 跳过（除非关闭 skipExisting）
    if (config.skipExisting) {
      if (rec && (rec.status === 'uploaded' || rec.clipUuid)) { skipped++; continue; }
      // 本地已有备份且已经上传过 ML 的记录缺失时，仍然可以只上传；这里保守按备份存在视为「已处理」
      if (!rec) {
        const bp = path.join(BACKUP_DIR, `${r.itemId}.mp4`);
        try {
          if (fs.existsSync(bp) && fs.statSync(bp).size > 1000) { skipped++; continue; }
        } catch { /* ignore */ }
      }
    }
    queue.push({
      key,
      storeId: r.storeId,
      storeNick: r.storeNick,
      itemId: r.itemId,
      title: r.title,
      thumbnail: r.thumbnail,
      state: 'pending',
      attempts: 0,
    });
    if (config.maxTotal > 0 && queue.length >= config.maxTotal) break;
  }

  state.queue = queue;
  state.startedAt = Date.now();
  state.finishedAt = undefined;
  state.totalGenerated = 0;
  state.totalUploaded = 0;
  state.totalFailed = 0;
  state.windowStart = Date.now();
  state.generatedThisHour = 0;
  state.uploadedThisHour = 0;
  save();

  return {
    added: queue.length,
    skipped,
    reason: `队列已重建：待生成 ${queue.length} 件，跳过 ${skipped} 件（已有视频/备份）`,
  };
}

// ============ 核心 tick ============

const countBy = (s: AutoVideoState, st: AutoVideoQueueItem['state']) =>
  s.queue.filter((i) => i.state === st).length;

function currentDisabledAi(): Set<string> {
  const s = new Set<string>();
  const now = Date.now();
  for (const [k, until] of aiCooldown) {
    if (until > now) s.add(k);
    else aiCooldown.delete(k);
  }
  return s;
}

/** 熔断某平台 30 分钟（比如账号欠费、无模型权限） */
function coolDownPlatform(name: string, reason: string): void {
  aiCooldown.set(name, Date.now() + 30 * 60 * 1000);
  console.warn(`[AutoVideo] 平台 ${name} 冷却 30 分钟：${reason.slice(0, 120)}`);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    if (state.phase !== 'running') return;

    // 小时窗口滚动
    const now = Date.now();
    if (now - state.windowStart >= HOUR) {
      state.windowStart = now;
      state.generatedThisHour = 0;
      state.uploadedThisHour = 0;
    }

    const disabledAi = currentDisabledAi();

    // ---------- 阶段一：生成本地视频（每小时 generatePerHour 条）----------
    while (state.generatedThisHour < config.generatePerHour && state.phase === 'running') {
      const item = state.queue.find((i) => i.state === 'pending');
      if (!item) break;
      item.attempts++;
      try {
        const ctx = await resolveContext(item.storeId, item.itemId);
        if (!ctx) {
          item.error = '找不到该商品（可能已下架或不在索引里）';
          if (item.attempts >= MAX_ATTEMPTS) { item.state = 'failed'; state.totalFailed++; }
          continue;
        }
        const r = await runItemVideo(ctx, {
          mode: 'generate',
          sites: config.sites,
          disabledAi,
        });
        if (r.ok) {
          if (r.stage === 'generated') {
            item.state = 'generated';
            item.generatedAt = Date.now();
            item.sourceKind = r.sourceKind as any;
            item.error = undefined;
            state.totalGenerated++;
            state.generatedThisHour++;
            state.lastMessage = `已生成 ${item.itemId}（${r.sourceKind}）`;
          } else {
            // already_uploaded / done：ML 那边本就已有视频，无需再生成
            item.state = 'uploaded';
            item.uploadedAt = Date.now();
            item.clipUuid = r.clipUuid;
            item.sourceKind = r.sourceKind as any;
            state.totalUploaded++;
            state.generatedThisHour++;
            state.lastMessage = `${item.itemId} 美客多已有视频，跳过生成`;
          }
        } else {
          item.error = r.skipReason || r.error || '生成失败';
          if (/欠费|余额|无可用资源包|doing|权限|does not exist|InvalidEndpoint/i.test(item.error)) {
            // 平台级问题 → 冷却，别让后面每件都白等
            for (const p of ['volcano', 'zhipu', 'agnes']) coolDownPlatform(p, item.error);
          }
          if (item.attempts >= MAX_ATTEMPTS) {
            item.state = 'failed';
            state.totalFailed++;
          }
        }
      } catch (e: any) {
        item.error = e?.message || String(e);
        if (item.attempts >= MAX_ATTEMPTS) { item.state = 'failed'; state.totalFailed++; }
      }
      save();
      await sleep(800);
    }

    // ---------- 阶段二：上传美客多（每小时 uploadPerHour 条）----------
    while (state.uploadedThisHour < config.uploadPerHour && state.phase === 'running') {
      const item = state.queue.find((i) => i.state === 'generated');
      if (!item) break;
      try {
        const ctx = await resolveContext(item.storeId, item.itemId);
        if (!ctx) {
          item.error = '找不到该商品';
          item.state = 'failed';
          state.totalFailed++;
          continue;
        }
        const r = await runItemVideo(ctx, { mode: 'upload', sites: config.sites });
        if (r.ok) {
          item.state = 'uploaded';
          item.uploadedAt = Date.now();
          item.clipUuid = r.clipUuid || item.clipUuid;
          item.error = undefined;
          state.totalUploaded++;
          state.uploadedThisHour++;
          state.lastMessage = `已上传 ${item.itemId} → ${JSON.stringify(r.siteStatuses || {})}`;
        } else {
          item.error = r.error || '上传失败';
          // 上传失败多半是限流/链接问题，回到 generated 下次再试
          item.attempts++;
          if (item.attempts >= MAX_ATTEMPTS + 1) { item.state = 'failed'; state.totalFailed++; }
        }
      } catch (e: any) {
        item.error = e?.message || String(e);
        item.attempts++;
        if (item.attempts >= MAX_ATTEMPTS + 1) { item.state = 'failed'; state.totalFailed++; }
      }
      save();
      await sleep(1200);
    }

    state.lastTickAt = Date.now();

    // ---------- 结束判定：生成与上传都清空 → 自动结束 ----------
    const remainGenerate = countBy(state, 'pending');
    const remainUpload = countBy(state, 'generated');
    if (remainGenerate === 0 && remainUpload === 0) {
      state.phase = 'finished';
      state.finishedAt = Date.now();
      state.lastMessage =
        `全部完成：共生成 ${state.totalGenerated} 条、上传 ${state.totalUploaded} 条、失败 ${state.totalFailed} 件。` +
        `自动任务已停止，不会再消耗 AI 额度。`;
      stopTimer();
      console.log(`[AutoVideo] ${state.lastMessage}`);
    }
    save();
  } finally {
    ticking = false;
  }
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((e) => console.error(`[AutoVideo] tick 异常: ${e?.message}`));
  }, TICK_MS);
  // 别让定时器阻止进程退出
  (timer as any).unref?.();
}

// ============ 对外：控制 ============

export async function startAutoVideo(rebuild = true): Promise<AutoVideoState> {
  if (rebuild || !state.queue.length) {
    const r = await buildQueue();
    state.lastMessage = r.reason;
  }
  if (!state.queue.length) {
    state.phase = 'finished';
    state.finishedAt = Date.now();
    config.enabled = false;
    save();
    return state;
  }
  state.phase = 'running';
  state.windowStart = Date.now();
  state.generatedThisHour = 0;
  state.uploadedThisHour = 0;
  config.enabled = true;
  save();
  ensureTimer();
  // 立即跑一轮，不等第一个 tick
  void tick().catch((e) => console.error(`[AutoVideo] 首轮 tick 异常: ${e?.message}`));
  return state;
}

export function pauseAutoVideo(): AutoVideoState {
  if (state.phase === 'running') {
    state.phase = 'paused';
    stopTimer();
    save();
  }
  return state;
}

export function resumeAutoVideo(): AutoVideoState {
  if (state.phase === 'paused') {
    state.phase = 'running';
    state.windowStart = Date.now();
    state.generatedThisHour = 0;
    state.uploadedThisHour = 0;
    save();
    ensureTimer();
    void tick().catch((e) => console.error(`[AutoVideo] resume tick 异常: ${e?.message}`));
  }
  return state;
}

export function stopAutoVideo(): AutoVideoState {
  stopTimer();
  state.phase = 'stopped';
  state.queue = [];
  state.startedAt = undefined;
  state.finishedAt = undefined;
  state.lastMessage = '已停止并清空队列';
  config.enabled = false;
  save();
  return state;
}

/** 手动跑一轮（后台「立即执行」按钮 / 调试用） */
export async function tickOnce(): Promise<AutoVideoState> {
  if (state.phase !== 'running') {
    state.phase = 'running';
    save();
  }
  await tick();
  return state;
}

/** 重新扫描店铺、重建队列（保留已完成项，只补新商品） */
export async function refreshQueue(): Promise<{ added: number; kept: number; total: number; reason: string }> {
  const before = new Map(state.queue.map((i) => [i.key, i]));
  const r = await buildQueue();
  let kept = 0;
  for (const it of state.queue) {
    const old = before.get(it.key);
    if (old) {
      it.state = old.state;
      it.attempts = old.attempts;
      it.error = old.error;
      it.generatedAt = old.generatedAt;
      it.uploadedAt = old.uploadedAt;
      it.clipUuid = old.clipUuid;
      it.sourceKind = old.sourceKind;
      kept++;
    }
  }
  save();
  return { added: r.added - kept, kept, total: state.queue.length, reason: r.reason };
}

/**
 * 进程启动时调用：如果上次是 running 状态（比如 pm2 重启），接着跑。
 */
export function initAutoVideo(): void {
  if (state.phase === 'running') {
    console.log(
      `[AutoVideo] 恢复上次任务：队列 ${state.queue.length} 件（待生成 ${
        state.queue.filter((i) => i.state === 'pending').length
      } / 待上传 ${state.queue.filter((i) => i.state === 'generated').length}）`,
    );
    ensureTimer();
    void tick().catch((e) => console.error(`[AutoVideo] 启动时 tick 异常: ${e?.message}`));
  } else if (config.enabled) {
    // 配置了「启用」但还没跑 → 自动起一轮
    void startAutoVideo(true).catch((e) => console.error(`[AutoVideo] 开机自启失败: ${e?.message}`));
  }
}

// ============ HTTP 路由（供 ml-finder 后台「自动视频」页面调用）============

export const autoVideoRouter = express.Router();

/** 读取配置 */
autoVideoRouter.get('/config', (_req, res) => {
  res.json({ config: getAutoVideoConfig() });
});

/** 保存配置（并据此决定是否自动开跑） */
autoVideoRouter.post('/config', (req, res) => {
  try {
    const { config, warnings } = saveAutoVideoConfig(req.body || {});
    res.json({ ok: true, config, warnings });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

/** 当前状态 + 队列计数 + 距离本小时窗口结束的毫秒 */
autoVideoRouter.get('/status', (_req, res) => {
  res.json(getAutoVideoStatus());
});

/** 队列明细（默认前 100 条，可按 state 过滤） */
autoVideoRouter.get('/queue', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  res.json({ items: getAutoVideoQueue(limit, filter) });
});

/** 开始（默认重建队列） */
autoVideoRouter.post('/start', async (req, res) => {
  try {
    const rebuild = req.body?.rebuild !== false;
    const state = await startAutoVideo(rebuild);
    res.json({ ok: true, state });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** 暂停 */
autoVideoRouter.post('/pause', (_req, res) => {
  res.json({ ok: true, state: pauseAutoVideo() });
});

/** 继续 */
autoVideoRouter.post('/resume', (_req, res) => {
  res.json({ ok: true, state: resumeAutoVideo() });
});

/** 停止并清空队列 */
autoVideoRouter.post('/stop', (_req, res) => {
  res.json({ ok: true, state: stopAutoVideo() });
});

/** 重新扫描店铺、补建队列（保留已完成项） */
autoVideoRouter.post('/refresh', async (_req, res) => {
  try {
    const r = await refreshQueue();
    res.json({ ok: true, ...r });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** 手动跑一轮（不依赖定时器） */
autoVideoRouter.post('/tick', async (_req, res) => {
  try {
    const state = await tickOnce();
    res.json({ ok: true, state });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

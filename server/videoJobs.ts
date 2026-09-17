/**
 * server/videoJobs.ts
 * 「批量生成并上传商品视频」的后台任务管理。
 *
 * 为什么要任务化：单件商品要经历「找源视频 → 下载 → 转码 →（必要时）AI 图生视频 → 上传 ML Clips」，
 * 一件 10~90 秒。批量几十件必然超过 HTTP 超时，所以改成
 * 「POST 建任务返回 jobId → 前端轮询进度」，并能看到每一件当前处于哪个阶段、失败的详细原因。
 */

export type VideoJobItemStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface VideoJobItem {
  itemId: string;
  title?: string;
  status: VideoJobItemStatus;
  /** 当前/最后阶段：check / download / convert / ai / backup / upload / done */
  stage?: string;
  /** 视频来源：source（源视频转码）/ backup（服务器备份）/ ai（AI 图生视频） */
  sourceKind?: string;
  error?: string;
  clipUuid?: string;
  siteStatuses?: Record<string, string>;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface VideoJob {
  id: string;
  storeId: string;
  storeNick?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'canceled';
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  cancelRequested: boolean;
  /** 当前正在处理的 itemId */
  current?: string;
  items: VideoJobItem[];
}

export interface JobRunResult {
  ok: boolean;
  skipped?: boolean;
  stage?: string;
  error?: string;
  sourceKind?: string;
  clipUuid?: string;
  siteStatuses?: Record<string, string>;
  /** 跳过原因说明（ok=false 且 skipped=true 时展示） */
  skipReason?: string;
}

export type JobRunner = (itemId: string, job: VideoJob) => Promise<JobRunResult>;

const jobs = new Map<string, VideoJob>();
/** 只保留最近 20 个任务，避免内存无限增长 */
const MAX_JOBS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function getVideoJob(id: string): VideoJob | undefined {
  return jobs.get(id);
}

export function listVideoJobs(): VideoJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function cancelVideoJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== 'running') return false;
  j.cancelRequested = true;
  return true;
}

/** 从任务列表里剔除已完成的最老任务 */
function prune(): void {
  const doneJobs = [...jobs.values()].filter((j) => j.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
  while (jobs.size > MAX_JOBS && doneJobs.length) {
    const oldest = doneJobs.shift()!;
    jobs.delete(oldest.id);
  }
}

/**
 * 创建并启动一个批量视频任务（异步执行，立即返回作业对象）。
 * @param onProgress 每件完成后回调（可用于打日志）
 */
export function createVideoJob(opts: {
  storeId: string;
  storeNick?: string;
  itemIds: string[];
  titles?: Record<string, string>;
  runner: JobRunner;
  onProgress?: (job: VideoJob) => void;
}): VideoJob {
  const id = `vj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const job: VideoJob = {
    id,
    storeId: opts.storeId,
    storeNick: opts.storeNick,
    createdAt: Date.now(),
    status: 'running',
    total: opts.itemIds.length,
    done: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    cancelRequested: false,
    items: opts.itemIds.map((itemId) => ({
      itemId,
      title: opts.titles?.[itemId],
      status: 'pending',
    })),
  };
  jobs.set(id, job);
  prune();

  // 后台串行执行（ML Clips / 生成平台都吃限流，串行最稳）
  (async () => {
    job.startedAt = Date.now();
    for (const entry of job.items) {
      if (job.cancelRequested) break;
      job.current = entry.itemId;
      entry.status = 'running';
      entry.startedAt = Date.now();
      try {
        const r = await opts.runner(entry.itemId, job);
        entry.finishedAt = Date.now();
        entry.durationMs = entry.finishedAt - entry.startedAt;
        entry.stage = r.stage;
        entry.sourceKind = r.sourceKind;
        entry.clipUuid = r.clipUuid;
        entry.siteStatuses = r.siteStatuses;
        if (r.ok) {
          entry.status = 'ok';
          job.ok++;
        } else if (r.skipped) {
          entry.status = 'skipped';
          entry.error = r.skipReason || r.error || '已跳过';
          job.skipped++;
        } else {
          entry.status = 'failed';
          entry.error = r.error || '未知错误';
          job.failed++;
        }
      } catch (e: any) {
        entry.status = 'failed';
        entry.finishedAt = Date.now();
        entry.durationMs = (entry.finishedAt || Date.now()) - (entry.startedAt || Date.now());
        entry.error = e?.message || String(e);
        job.failed++;
      }
      job.done++;
      opts.onProgress?.(job);
      await sleep(300); // 件间节流
    }
    job.current = undefined;
    job.status = job.cancelRequested ? 'canceled' : 'done';
    job.finishedAt = Date.now();
    console.log(
      `[VideoJob] ${job.id} 结束：共 ${job.total}，成功 ${job.ok}，失败 ${job.failed}，跳过 ${job.skipped}`,
    );
  })().catch((e) => {
    job.status = 'done';
    job.finishedAt = Date.now();
    console.error(`[VideoJob] ${job.id} 异常: ${e?.message}`);
  });

  return job;
}

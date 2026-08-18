import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEDULE_FILE = path.join(__dirname, '..', 'data', 'ml-schedule.json');

/** 单个定时任务的配置 */
export interface TaskSchedule {
  enabled: boolean;
  time: string; // "HH:MM" 每天执行时间（服务器时区）
  lastRun: string; // ISO 时间
}

export interface ScheduleConfig {
  // 多任务表：key 为任务名（export=白天抓取导出，sourcing=夜间 AI 选品流水线）
  tasks: Record<string, TaskSchedule>;
}

/** 默认任务：抓取白天跑；选品流水线夜间跑、早上审 */
const DEFAULT_TASKS: Record<string, TaskSchedule> = {
  export: { enabled: false, time: '09:00', lastRun: '' },
  sourcing: { enabled: true, time: '03:00', lastRun: '' },
};

let schedule: ScheduleConfig = {
  tasks: JSON.parse(JSON.stringify(DEFAULT_TASKS)),
};

export function loadSchedule(): ScheduleConfig {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const tasks = { ...DEFAULT_TASKS, ...(parsed.tasks || {}) };
      // 兼容旧版扁平字段：enabled/time/lastRun 直接映射到 export 任务
      if (typeof parsed.enabled === 'boolean') tasks.export.enabled = parsed.enabled;
      if (typeof parsed.time === 'string') tasks.export.time = parsed.time;
      if (typeof parsed.lastRun === 'string') tasks.export.lastRun = parsed.lastRun;
      schedule = { tasks };
    }
  } catch (err) {
    console.error('[Scheduler] 加载配置失败:', err);
  }
  return getSchedule();
}
loadSchedule();

function persist() {
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (err) {
    console.error('[Scheduler] 保存失败:', err);
  }
}

export function saveSchedule(cfg: Partial<ScheduleConfig> & {
  enabled?: boolean;
  time?: string;
  lastRun?: string;
} = {}): ScheduleConfig {
  // 兼容旧前端：顶层 enabled/time/lastRun 直接映射到 export 任务
  if (typeof cfg.enabled === 'boolean') schedule.tasks.export.enabled = cfg.enabled;
  if (typeof cfg.time === 'string') schedule.tasks.export.time = cfg.time;
  if (typeof cfg.lastRun === 'string') schedule.tasks.export.lastRun = cfg.lastRun;
  // 直接传 tasks 则逐任务覆盖
  if (cfg.tasks && typeof cfg.tasks === 'object') {
    for (const [k, v] of Object.entries(cfg.tasks)) {
      schedule.tasks[k] = { ...schedule.tasks[k], ...v };
    }
  }
  persist();
  return getSchedule();
}

/** 返回对外结构：除 tasks 外，顶层再暴露 export 任务字段（兼容旧前端） */
export function getSchedule(): ScheduleConfig & { enabled: boolean; time: string; lastRun: string } {
  return {
    ...schedule,
    enabled: schedule.tasks.export.enabled,
    time: schedule.tasks.export.time,
    lastRun: schedule.tasks.export.lastRun,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 启动定时循环：每分钟检查一次，对注册的每个任务，若到达设定时间且当天尚未运行，则触发回调。
 * 注意：免费版 Render 会休眠，需配合外部 cron（如 cron-job.org）定时请求 /api/ml/trigger 来唤醒并触发。
 *
 * @param tasks 任务名 → 异步回调。任务名需与 schedule.tasks 的 key 对应。
 */
export function startScheduler(tasks: Record<string, () => Promise<void>>) {
  setInterval(() => {
    const now = new Date();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const today = now.toISOString().slice(0, 10);

    for (const [name, fn] of Object.entries(tasks)) {
      const t = schedule.tasks[name];
      if (!t || !t.enabled) continue;
      if (hhmm !== t.time) continue;
      if (t.lastRun && t.lastRun.startsWith(today)) continue; // 当天已跑

      t.lastRun = now.toISOString();
      persist();
      console.log(`[Scheduler] 触发定时任务 "${name}" @ ${t.time}`);
      fn().catch((e) => console.error(`[Scheduler] 任务 "${name}" 运行失败:`, e));
    }
  }, 60 * 1000);
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEDULE_FILE = path.join(__dirname, '..', 'data', 'ml-schedule.json');

export interface ScheduleConfig {
  enabled: boolean;
  time: string; // "HH:MM" 每天执行时间（服务器时区）
  lastRun: string; // ISO 时间
}

let schedule: ScheduleConfig = {
  enabled: false,
  time: '09:00',
  lastRun: '',
};

export function loadSchedule(): ScheduleConfig {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      const raw = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
      schedule = { ...schedule, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('[Scheduler] 加载配置失败:', err);
  }
  return schedule;
}
loadSchedule();

export function saveSchedule(cfg: Partial<ScheduleConfig>): ScheduleConfig {
  schedule = { ...schedule, ...cfg };
  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
  } catch (err) {
    console.error('[Scheduler] 保存失败:', err);
  }
  return schedule;
}

export function getSchedule(): ScheduleConfig {
  return schedule;
}

/**
 * 启动定时循环：每分钟检查一次，若到达设定时间且当天尚未运行，则触发回调。
 * 注意：免费版 Render 会休眠，需配合外部 cron（如 cron-job.org）定时请求 /api/ml/trigger 来唤醒并触发。
 */
export function startScheduler(runCallback: () => Promise<void>) {
  setInterval(() => {
    if (!schedule.enabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm !== schedule.time) return;

    const today = now.toISOString().slice(0, 10);
    if (schedule.lastRun && schedule.lastRun.startsWith(today)) return; // 当天已跑

    schedule.lastRun = now.toISOString();
    saveSchedule(schedule);
    console.log(`[Scheduler] 触发定时抓取 (${schedule.time})`);
    runCallback().catch((e) => console.error('[Scheduler] 运行失败:', e));
  }, 60 * 1000);
}

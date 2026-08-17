/**
 * 美客多订单「履约剩余时间」计算工具。
 *
 * 履约规则（见运营约定截图）：
 *   1. 订单履约时限 = 自「下单时间」(date_created) 起 72 小时；
 *   2. 节假日不计入履约时间；
 *   3. 周末自动顺延。
 *
 * 实现思路：以「营业小时」累加方式计算截止时间——从下单时间开始，逐小时推进，
 * 仅当该时刻落在工作日（周一~周五且非节假日）时才消耗履约额度；周末与节假日整段
 * 跳过（顺延）。累计满 72 个营业小时后得到的时刻即为履约截止时间。
 *
 * 节假日数据：优先使用 date-holidays 库（覆盖拉美各站点国家）；若该库未安装或
 * 对应国家无数据，则退化为「仅跳过周末」，并在 source 中标注 fallback。
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export interface FulfillmentDeadline {
  /** 履约截止 ISO 时间 */
  deadline: string | null;
  /** 剩余小时数，负数表示已超时（按营业小时口径） */
  remainingHours: number | null;
  /** 用于展示的中文文本，例如「履约剩余：60小时」「已超时 12小时」 */
  remainingHoursText: string;
  /** 当前 deadline 的数据来源 / 计算口径 */
  source: 'business_72h' | 'business_72h_no_holiday' | 'fallback' | null;
  /** 计算时使用的国家码（用于调试/确认节假日口径） */
  countryCode?: string;
}

/**
 * 履约计算口径（运营约定 + 中国日历）：
 *   - 官方红线：订单生成后 72 小时内发货并上传单号（Mercado Libre 跨境卖家政策）。
 *   - 内部管控：按「72 个营业小时」自下单起算；周末（中国周六日）不计入、顺延；
 *     中国法定节假日不计入、顺延。
 *   - 日历口径：一律按「中国日历」判断工作日/周末/法定假日（中国 UTC+8，无夏令时）。
 */

/** 自下单起算的履约营业小时数（规则要求 72 小时） */
const FULFILLMENT_BUSINESS_HOURS = 72;

/** 履约日历口径：中国（周末=中国周六日；节假日=中国法定节假日） */
const FULFILLMENT_COUNTRY = 'CN';
/** 中国时区偏移（小时），用于把美客多 UTC 时间换算到中国自然日来判工作日 */
const FULFILLMENT_TZ_OFFSET_HOURS = 8;

/**
 * 中国调休日历补充表（date-holidays 库只覆盖「法定核心假日」，无法处理国务院调休）。
 * 数据来自《国务院办公厅关于2026年部分节假日安排的通知》：
 *   - CN_HOLIDAYS：调休放假延展日（含核心假日，统一列出，确保长假区间全部顺延）；
 *   - CN_WORKDAYS：调休补班日（落在周六/周日但须上班，须当工作日消耗额度）。
 * 每年更新一次即可；未来年份若无数据，则退化为「仅核心法定假日+周末」。
 */
const CN_HOLIDAYS_2026: string[] = [
  // 元旦 1/1-1/3（1/4 补班）
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节 2/15(除夕)-2/23（2/14、2/28 补班），共 9 天
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明 4/4-4/6
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动 5/1-5/5（5/9 补班）
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午 6/19-6/21
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋 9/25-9/27
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆 10/1-10/7（9/20、10/10 补班）
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
];
const CN_WORKDAYS_2026: string[] = [
  '2026-01-04',
  '2026-02-14', '2026-02-28',
  '2026-05-09',
  '2026-09-20', '2026-10-10',
];

const CN_HOLIDAYS_SET = new Set(CN_HOLIDAYS_2026);
const CN_WORKDAYS_SET = new Set(CN_WORKDAYS_2026);

/** 取某本地 Date 的 ISO 日期串（YYYY-MM-DD），按中国自然日 */
function isoDateOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

let holidayCheckerCache: Map<string, any> = new Map();
let holidayLibAvailable = true;

function getCountryCode(_site?: string): string {
  // 统一按中国日历计算，不再按站点国家
  return FULFILLMENT_COUNTRY;
}

/**
 * 返回某日期（已换算到中国本地）是否为中国法定节假日（基于 date-holidays）。
 * 库不可用 / 国家无数据 / 异常时一律视为「非节假日」（安全退化，仅跳周末）。
 */
function isHoliday(localDate: Date, countryCode: string): boolean {
  if (!holidayLibAvailable) return false;
  try {
    let checker = holidayCheckerCache.get(countryCode);
    if (!checker) {
      const Holidays = require('date-holidays');
      const hd = new Holidays(countryCode);
      checker = (d: Date) => {
        // d 已是中国本地时刻（toChinaLocalMs 换算过），取其年月日拼成 ISO 日期串判断。
        // 注意：date-holidays 的 isHoliday 不接受 (年,月,日) 三个数字参数，必须传 Date/ISO 串。
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth() + 1;
        const day = d.getUTCDate();
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const res = hd.isHoliday(iso);
        return Array.isArray(res) ? res.length > 0 : !!res;
      };
      holidayCheckerCache.set(countryCode, checker);
    }
    return checker(localDate);
  } catch {
    // 库未安装 / 国家无数据：退化为「仅跳过周末」
    holidayLibAvailable = false;
    holidayCheckerCache.clear();
    return false;
  }
}

/** 把 UTC 毫秒换算到中国本地毫秒（仅用于读取年/月/日/星期，不做时区转换存储） */
function toChinaLocalMs(utcMs: number): number {
  return utcMs + FULFILLMENT_TZ_OFFSET_HOURS * MS_HOUR;
}

/** 该 UTC 时刻（换算到中国后）是否落在「营业时间」（中国工作日，且非中国法定假日/调休假日） */
function isBusinessMoment(utcMs: number, countryCode: string): boolean {
  const local = new Date(toChinaLocalMs(utcMs));
  const iso = isoDateOf(local);

  // 调休补班日：落在周六/周日但须上班，按工作日处理
  if (CN_WORKDAYS_SET.has(iso)) return true;

  const day = local.getUTCDay(); // 0=周日 6=周六（中国本地星期）
  if (day === 0 || day === 6) return false; // 中国周末

  // 中国法定/调休假日（date-holidays 核心假日 或 调休补充表）
  if (CN_HOLIDAYS_SET.has(iso)) return false;
  return !isHoliday(local, countryCode);
}

const MS_HOUR = 3600 * 1000;

/** 取某 UTC 时刻所在「中国自然日」的结束边界（中国次日 00:00 对应的真实 UTC 毫秒） */
function endOfChinaDay(utcMs: number): number {
  const local = new Date(toChinaLocalMs(utcMs));
  // 中国次日 00:00 的 UTC 值
  const nextChinaMidnightUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    0,
    0,
    0
  );
  return nextChinaMidnightUtc - FULFILLMENT_TZ_OFFSET_HOURS * MS_HOUR;
}

/**
 * 自下单时间起，按「中国营业小时」累加满 totalBusinessHours 后的截止时刻（UTC ms）。
 * 全程以「中国自然日」为单位推进：仅当该时刻落在中国工作日（周一~周五 且非法定假日）
 * 时才消耗履约额度；中国周末与法定假日整段跳过，顺延到下一个中国工作日 00:00 继续累计。
 */
export function computeBusinessDeadline(
  startMs: number,
  totalBusinessHours: number,
  countryCode: string
): number {
  let remaining = totalBusinessHours;
  let cursorMs = startMs;
  // 安全上限：最坏情况（长假连周末）也不会超过约 400 天
  let guard = 0;
  const MAX_GUARD = 10000;

  while (remaining > 0 && guard < MAX_GUARD) {
    guard++;
    if (isBusinessMoment(cursorMs, countryCode)) {
      // 当日（中国）剩余可消耗的营业小时数（到中国次日 00:00）
      const hoursLeftInDay = (endOfChinaDay(cursorMs) - cursorMs) / MS_HOUR;
      const consume = Math.min(remaining, hoursLeftInDay);
      remaining -= consume;
      cursorMs += consume * MS_HOUR;
    } else {
      // 非营业时刻：跳到中国次日 00:00（顺延）
      cursorMs = endOfChinaDay(cursorMs);
    }
  }
  return cursorMs;
}

function parseIsoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

function fmtRemainingText(remainingHours: number | null): string {
  if (remainingHours == null) return '—';
  // 保留 1 位小数，去掉多余的 .0（短文本，不带「履约剩余：」前缀，由展示端自行加标签）
  const v = Math.round(remainingHours * 10) / 10;
  const txt = Number.isInteger(v) ? `${v}` : `${v.toFixed(1)}`;
  return remainingHours >= 0 ? `${txt} 小时` : `已超时 ${Math.abs(v)} 小时`;
}

/**
 * 计算订单履约截止与剩余时间（按「72 营业小时 + 跳过周末/节假日」规则）。
 * @param order 美客多订单对象（需含 date_created）
 * @param site 站点，用于确定国家节假日口径
 */
export function extractHandlingDeadline(
  order: any,
  _shipment?: any | null,
  site?: string
): FulfillmentDeadline {
  const created = parseIsoToMs(order?.date_created);
  if (!created) {
    return { deadline: null, remainingHours: null, remainingHoursText: '—', source: null };
  }

  const countryCode = getCountryCode(site || order?.site);
  const deadlineMs = computeBusinessDeadline(created, FULFILLMENT_BUSINESS_HOURS, countryCode);
  const deadline = new Date(deadlineMs).toISOString();

  // source 标识是否真正用上了节假日数据（用于前端提示口径）
  const source: FulfillmentDeadline['source'] = holidayLibAvailable
    ? 'business_72h'
    : 'business_72h_no_holiday';

  // 调试日志：帮助排查「国家代码/节假日库」是否按预期工作
  console.log(
    `[fulfillment] order=${order?.id || 'n/a'} site=${site || order?.site || 'n/a'} ` +
      `country=${countryCode} holidayLibAvailable=${holidayLibAvailable} ` +
      `created=${order?.date_created} deadline=${deadline}`
  );

  const now = Date.now();
  const diffMs = deadlineMs - now;
  const remainingHours = diffMs / MS_HOUR;

  return {
    deadline,
    remainingHours,
    remainingHoursText: fmtRemainingText(remainingHours),
    source,
    countryCode,
  };
}

/**
 * 基于已存储的 deadline 重新计算剩余小时数（用于从 DB 读取后动态刷新）。
 * 存储时直接存 deadline ISO，剩余时间随当前时间实时计算，无需再叠加节假日逻辑。
 */
export function recalcHandlingDeadline(order: any): FulfillmentDeadline {
  const deadline = order?.handlingDeadline || order?.handling_deadline || null;
  if (!deadline) {
    return { deadline: null, remainingHours: null, remainingHoursText: '—', source: null };
  }
  const deadlineMs = parseIsoToMs(deadline);
  if (deadlineMs == null) {
    return { deadline: null, remainingHours: null, remainingHoursText: '—', source: null };
  }
  const now = Date.now();
  const diffMs = deadlineMs - now;
  const remainingHours = diffMs / MS_HOUR;
  return {
    deadline,
    remainingHours,
    remainingHoursText: fmtRemainingText(remainingHours),
    source: order?.source || order?.deadlineSource || null,
    countryCode: order?.countryCode || null,
  };
}

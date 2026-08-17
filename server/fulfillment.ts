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
}

/** 自下单起算的履约营业小时数（规则要求 72 小时） */
const FULFILLMENT_BUSINESS_HOURS = 72;

/** 美客多站点 → ISO 国家码（用于 date-holidays 取节假日） */
const SITE_TO_COUNTRY: Record<string, string> = {
  MLM: 'MX', // 墨西哥
  MLB: 'BR', // 巴西
  MLC: 'CL', // 智利
  MCO: 'CO', // 哥伦比亚
  MLA: 'AR', // 阿根廷
  MLU: 'UY', // 乌拉圭
  MPE: 'PE', // 秘鲁
  MEC: 'EC', // 厄瓜多尔
  MLV: 'VE', // 委内瑞拉
  MLCR: 'CR', // 哥斯达黎加
  MBO: 'BO', // 玻利维亚
  MPA: 'PA', // 巴拿马
  MLN: 'NI', // 尼加拉瓜
  MRD: 'DO', // 多米尼加
  CBT: 'MX', // 跨境：按收货国较难判定，默认墨西哥口径（仅跳过周末+可能节假日）
  DEFAULT: 'MX',
};

let holidayCheckerCache: Map<string, any> = new Map();
let holidayLibAvailable = true;

function getCountryCode(site?: string): string {
  const key = (site || 'DEFAULT').toUpperCase();
  return SITE_TO_COUNTRY[key] ?? SITE_TO_COUNTRY.DEFAULT;
}

/**
 * 返回某国家某日期是否为节假日（基于 date-holidays）。
 * 库不可用 / 国家无数据 / 异常时一律视为「非节假日」（安全退化）。
 */
function isHoliday(date: Date, countryCode: string): boolean {
  if (!holidayLibAvailable) return false;
  try {
    let checker = holidayCheckerCache.get(countryCode);
    if (!checker) {
      const Holidays = require('date-holidays');
      const hd = new Holidays(countryCode);
      checker = (d: Date) => {
        // 用 UTC 年月日判断，避免服务器本地时区把节假日算到相邻自然日
        const res = hd.isHoliday(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        return Array.isArray(res) ? res.length > 0 : !!res;
      };
      holidayCheckerCache.set(countryCode, checker);
    }
    return checker(date);
  } catch {
    // 库未安装 / 国家无数据：退化为「仅跳过周末」
    holidayLibAvailable = false;
    holidayCheckerCache.clear();
    return false;
  }
}

/** 该时刻（按 UTC 日）是否落在「营业时间」（周一~周五 且 非节假日） */
function isBusinessMoment(d: Date, countryCode: string): boolean {
  const day = d.getUTCDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  return !isHoliday(d, countryCode);
}

const MS_HOUR = 3600 * 1000;

/** 取某 UTC 时刻所在「UTC 自然日」的结束边界（次日 00:00 UTC，ms） */
function endOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

/**
 * 自下单时间起，按「营业小时」累加满 totalBusinessHours 后的截止时刻（ms）。
 * 全程以 UTC 自然日为单位推进，避免服务器本地时区干扰（美客多时间为 UTC）。
 * 周末与节假日整段跳过，下一个营业日 00:00 UTC 继续累计。
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
    const d = new Date(cursorMs);
    if (isBusinessMoment(d, countryCode)) {
      // 当日（UTC）剩余可消耗的营业小时数（到次日 00:00 UTC）
      const hoursLeftInDay = (endOfUtcDay(d) - cursorMs) / MS_HOUR;
      const consume = Math.min(remaining, hoursLeftInDay);
      remaining -= consume;
      cursorMs += consume * MS_HOUR;
    } else {
      // 非营业时刻：跳到次日 00:00 UTC（顺延）
      cursorMs = endOfUtcDay(d);
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

  const now = Date.now();
  const diffMs = deadlineMs - now;
  const remainingHours = diffMs / MS_HOUR;

  return {
    deadline,
    remainingHours,
    remainingHoursText: fmtRemainingText(remainingHours),
    source,
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
    source: order?.deadlineSource || null,
  };
}

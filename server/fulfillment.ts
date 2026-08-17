/**
 * 美客多订单「履约剩余时间」计算工具。
 *
 * 美客多官方发货截止字段：
 * - shipment.lead_time.estimated_handling_limit.date（卖家最晚发货日期）
 * - shipment.lead_time.estimated_delivery_time.handling（处理小时数，可作为兜底）
 *
 * 当物流对象不存在时，使用各站点默认 handling 时间 + 订单创建时间做保守估算。
 */

export interface FulfillmentDeadline {
  /** 履约截止 ISO 时间（可能为估算） */
  deadline: string | null;
  /** 剩余小时数，负数表示已超时 */
  remainingHours: number | null;
  /** 用于展示的中文文本，例如「60小时」「已超时 12小时」 */
  remainingHoursText: string;
  /** 当前 deadline 的数据来源 */
  source: 'estimated_handling_limit' | 'lead_time_handling' | 'fallback' | null;
}

const DEFAULT_HANDLING_HOURS: Record<string, number> = {
  MLM: 48, // 墨西哥
  MLB: 48, // 巴西
  MLC: 48, // 智利
  MCO: 48, // 哥伦比亚
  MLA: 48, // 阿根廷
  MLU: 48, // 乌拉圭
  MPE: 48, // 秘鲁
  MEC: 48, // 厄瓜多尔
  MLV: 48, // 委内瑞拉
  MLCR: 48,
  MBO: 48,
  MPA: 48,
  MLN: 48,
  MRD: 48,
  CBT: 72, // 跨境
  DEFAULT: 48,
};

export function getDefaultHandlingHours(site?: string): number {
  const key = (site || 'DEFAULT').toUpperCase();
  return DEFAULT_HANDLING_HOURS[key] ?? DEFAULT_HANDLING_HOURS.DEFAULT;
}

function parseIsoToMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

/**
 * 从订单 + 物流对象中提取履约截止时间。
 * @param order 美客多订单对象（需含 date_created）
 * @param shipment 物流详情对象（优先使用 lead_time.estimated_handling_limit.date）
 * @param site 站点，用于 fallback 默认 handling 时间
 */
export function extractHandlingDeadline(
  order: any,
  shipment: any | null | undefined,
  site?: string
): FulfillmentDeadline {
  const now = Date.now();
  const siteKey = (site || order?.site || '').toUpperCase();

  let deadline: string | null = null;
  let source: FulfillmentDeadline['source'] = 'estimated_handling_limit';

  // 1. 官方字段：lead_time.estimated_handling_limit.date
  const handlingLimit = shipment?.lead_time?.estimated_handling_limit?.date;
  if (handlingLimit) {
    deadline = handlingLimit;
  }

  // 2. 退而求其次：estimated_delivery_time.handling（小时）+ 订单创建时间
  if (!deadline && shipment?.lead_time?.estimated_delivery_time?.handling != null) {
    const handlingHours = Number(shipment.lead_time.estimated_delivery_time.handling);
    const created = parseIsoToMs(order?.date_created);
    if (handlingHours > 0 && created) {
      deadline = new Date(created + handlingHours * 3600 * 1000).toISOString();
      source = 'lead_time_handling';
    }
  }

  // 3. 兜底：站点默认 handling 小时 + 订单创建时间
  if (!deadline && order?.date_created) {
    const created = parseIsoToMs(order.date_created);
    if (created) {
      const fallbackHours = getDefaultHandlingHours(siteKey);
      deadline = new Date(created + fallbackHours * 3600 * 1000).toISOString();
      source = 'fallback';
    }
  }

  if (!deadline) {
    return { deadline: null, remainingHours: null, remainingHoursText: '—', source: null };
  }

  const deadlineMs = parseIsoToMs(deadline)!;
  const diffMs = deadlineMs - now;
  const remainingHours = Math.floor(diffMs / (3600 * 1000));
  const remainingHoursText =
    remainingHours >= 0 ? `${remainingHours}小时` : `已超时 ${Math.abs(remainingHours)}小时`;

  return { deadline, remainingHours, remainingHoursText, source };
}

/** 基于已存储的 deadline 重新计算剩余小时数（用于从 DB 读取后动态刷新） */
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
  const remainingHours = Math.floor(diffMs / (3600 * 1000));
  const remainingHoursText =
    remainingHours >= 0 ? `${remainingHours}小时` : `已超时 ${Math.abs(remainingHours)}小时`;
  return { deadline, remainingHours, remainingHoursText, source: order?.deadlineSource || null };
}

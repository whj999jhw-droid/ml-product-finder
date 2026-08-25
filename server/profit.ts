/**
 * 完整利润测算引擎（按参考文档《M2利润计算与四站点选品深挖》实现）
 *
 * 净利润 = 售价
 *   − 平台佣金（按站点）
 *   − Mercado Pago 手续费
 *   − 官方物流费（体积重/实重取大计费）
 *   − 头程运费
 *   − 关税/进口税（MX 无 RFC 高扣税、BR ICMS 等）
 *   − 采购成本（1688）
 *   − 广告费（ACoS）
 *   − 退款损耗（退货率 × 40% 损失）
 *   − 汇率损耗
 *   − 提现手续费
 *
 * 附带：保本价反推、体积重预警（比值>3 预警 / >5 建议放弃）、绿/黄/红推荐。
 * 所有费率可被 data/ml-site-rates.json 覆盖（无则用内置默认）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRateToUsd, getCnyUsd } from './exchangeRate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RATES_FILE = path.join(__dirname, '..', 'data', 'ml-site-rates.json');

// ============ 税务模式（关键：不同经营模式税负天差地别）============
/**
 * direct_import  纯跨境自发货直邮：买家为进口商、税费由买家承担，卖家侧预扣≈0。
 *                中国发货、货物不在墨西哥境内存仓 → 无需 RFC。【无货源跟卖默认模式】
 * cbt_with_rfc   CBT 跨境店 + 已绑定并通过验证的 RFC：综合预扣约 16%
 * cbt_no_rfc     CBT 跨境店 + 无 RFC / RFC 验证未通过：综合预扣 36%（16% IVA + 20% ISR）
 * local_store    墨西哥本土店（本地公司 + 本地 RFC + 本地银行账户）：综合预扣约 10.5%
 * 巴西 MLB：ICMS 等由站点 taxRate 决定，与本参数无关。
 */
export type TaxMode = 'direct_import' | 'cbt_with_rfc' | 'cbt_no_rfc' | 'local_store';

/** 墨西哥站各税务模式的综合预扣税率 */
export const MX_TAX_MODE_RATES: Record<TaxMode, number> = {
  direct_import: 0,
  cbt_with_rfc: 0.16,
  cbt_no_rfc: 0.36,
  local_store: 0.105,
};

export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  direct_import: '跨境自发货直邮（买家为进口商，无需 RFC）',
  cbt_with_rfc: 'CBT 跨境店 + 已验证 RFC（约 16%）',
  cbt_no_rfc: 'CBT 跨境店 + 无/未验证 RFC（36%）',
  local_store: '墨西哥本土店（约 10.5%）',
};

// ============ 站点费率配置 ============
export interface SiteRates {
  /** 平台佣金比例 */
  commissionRate: number;
  /** Mercado Pago 回款手续费比例 */
  pagoFeeRate: number;
  /** 站点默认税率（非墨西哥站使用；墨西哥站由 taxMode 决定） */
  taxRate: number;
  /** 兼容字段：墨西哥 CBT 无 RFC 时的高扣税比例 */
  taxRateNoRfc: number;
  /** 平均退货率 */
  returnRate: number;
  /** 退货损失系数（退货订单平均损失售价的比例） */
  returnLossFactor: number;
  /** 汇率损耗比例 */
  exchangeLossRate: number;
  /** 提现手续费比例 */
  withdrawalFeeRate: number;
  /** 官方跨境物流估算：首重费用 USD */
  logisticsBaseUsd: number;
  /** 官方跨境物流估算：每 kg 费用 USD（按计费重） */
  logisticsPerKgUsd: number;
  /** 头程运费估算：每 kg CNY（未手填头程运费时按计费重估算） */
  firstLegPerKgCny: number;
}

export const DEFAULT_SITE_RATES: Record<string, SiteRates> = {
  // 墨西哥：跨境自发货直邮默认 0 税（买家为进口商）；CBT/本土店走 taxMode 覆盖
  MLM: {
    commissionRate: 0.04,
    pagoFeeRate: 0.04,
    taxRate: 0,
    taxRateNoRfc: 0.36,
    returnRate: 0.05,
    returnLossFactor: 0.4,
    exchangeLossRate: 0.01,
    withdrawalFeeRate: 0.01,
    logisticsBaseUsd: 4.0,
    logisticsPerKgUsd: 6.0,
    firstLegPerKgCny: 30,
  },
  // 巴西：佣金高 + ICMS 重税，客单价要求高
  MLB: {
    commissionRate: 0.125,
    pagoFeeRate: 0.045,
    taxRate: 0.2,
    taxRateNoRfc: 0.2,
    returnRate: 0.08,
    returnLossFactor: 0.4,
    exchangeLossRate: 0.015,
    withdrawalFeeRate: 0.01,
    logisticsBaseUsd: 5.0,
    logisticsPerKgUsd: 7.0,
    firstLegPerKgCny: 40,
  },
  // 智利：中等佣金，无额外进口税（限额内）
  MLC: {
    commissionRate: 0.12,
    pagoFeeRate: 0.04,
    taxRate: 0,
    taxRateNoRfc: 0,
    returnRate: 0.05,
    returnLossFactor: 0.4,
    exchangeLossRate: 0.01,
    withdrawalFeeRate: 0.008,
    logisticsBaseUsd: 4.5,
    logisticsPerKgUsd: 6.5,
    firstLegPerKgCny: 35,
  },
  // 哥伦比亚
  MCO: {
    commissionRate: 0.12,
    pagoFeeRate: 0.04,
    taxRate: 0,
    taxRateNoRfc: 0,
    returnRate: 0.05,
    returnLossFactor: 0.4,
    exchangeLossRate: 0.01,
    withdrawalFeeRate: 0.008,
    logisticsBaseUsd: 4.5,
    logisticsPerKgUsd: 6.5,
    firstLegPerKgCny: 35,
  },
};

let ratesCache: Record<string, SiteRates> | null = null;

/** 读取站点费率（data/ml-site-rates.json 可覆盖默认值，支持部分覆盖） */
export function getSiteRates(): Record<string, SiteRates> {
  if (ratesCache) return ratesCache;
  const merged: Record<string, SiteRates> = JSON.parse(JSON.stringify(DEFAULT_SITE_RATES));
  try {
    if (fs.existsSync(RATES_FILE)) {
      const user = JSON.parse(fs.readFileSync(RATES_FILE, 'utf-8'));
      for (const site of Object.keys(user || {})) {
        merged[site] = { ...(merged[site] || DEFAULT_SITE_RATES.MLM), ...user[site] };
      }
    }
  } catch {
    /* 配置文件损坏时使用默认 */
  }
  ratesCache = merged;
  return merged;
}

/** 保存用户覆盖费率并刷新缓存 */
export function saveSiteRates(overrides: Record<string, Partial<SiteRates>>): Record<string, SiteRates> {
  const dir = path.dirname(RATES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(RATES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
  ratesCache = null;
  return getSiteRates();
}

// ============ 输入 / 输出 ============
export interface ProductInput {
  site: string; // MLM / MLB / MLC / MCO
  /** 拟定售价（USD） */
  listingPriceUsd: number;
  /** 1688 采购价（CNY） */
  purchaseCostCny: number;
  /** 头程运费（CNY），不填则按计费重 × firstLegPerKgCny 估算 */
  firstLegShippingCny?: number;
  /** 实重 kg */
  weightKg?: number;
  /** 尺寸 cm */
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  /**
   * 墨西哥站税务模式，默认 'direct_import'（纯跨境自发货直邮，无需 RFC、卖家侧预扣 0）。
   * 非墨西哥站忽略此参数，使用站点 taxRate。
   */
  taxMode?: TaxMode;
  /** @deprecated 兼容旧调用：hasRfc=false 曾等价于 36%，现已由 taxMode 取代 */
  hasRfc?: boolean;
  /** 广告 ACoS（广告费/销售额），默认 0.05 */
  adAcosRate?: number;
  /** CNY→USD 汇率（批量时传入避免重复请求） */
  cnyUsd?: number;
}

export interface CostBreakdown {
  commission: number;
  pagoFee: number;
  logisticsFee: number;
  firstLegFee: number;
  tax: number;
  purchaseCost: number;
  adCost: number;
  refundLoss: number;
  exchangeLoss: number;
  withdrawalFee: number;
  totalCost: number;
}

export type Recommendation = 'green' | 'yellow' | 'red';

export interface ProfitResult {
  site: string;
  listingPriceUsd: number;
  cnyUsd: number;
  /** 实际生效的税务模式与税率（便于前端展示与核对） */
  taxMode: TaxMode;
  taxRate: number;
  netProfit: number; // USD
  netProfitRate: number; // 净利润率 = netProfit / price
  roi: number; // netProfit / (采购+头程)
  costBreakdown: CostBreakdown;
  breakEvenPrice: number; // 保本价 USD
  volumeWeightKg: number;
  chargeableWeightKg: number;
  volumeWeightRatio: number; // 体积重 / 实重
  recommendation: Recommendation; // green ≥20% / yellow ≥5% / red
  warnings: string[];
}

const VOLUME_DIVISOR = 5000; // 体积重系数：L×W×H(cm³)/5000

/** 完整利润测算（单品） */
export async function calculateProfit(input: ProductInput): Promise<ProfitResult> {
  const site = (input.site || 'MLM').toUpperCase();
  const rates = getSiteRates()[site] || DEFAULT_SITE_RATES.MLM;
  const cnyUsd = input.cnyUsd ?? (await getCnyUsd());
  const price = input.listingPriceUsd || 0;

  // 体积重与计费重
  const weightKg = input.weightKg || 0;
  const volumeWeightKg =
    input.lengthCm && input.widthCm && input.heightCm
      ? (input.lengthCm * input.widthCm * input.heightCm) / VOLUME_DIVISOR
      : 0;
  const chargeableWeightKg = Math.max(weightKg, volumeWeightKg) || weightKg || 0.3; // 无数据时按 0.3kg 兜底
  const volumeWeightRatio = weightKg > 0 && volumeWeightKg > 0 ? volumeWeightKg / weightKg : 0;

  // 各项成本（USD）
  // 墨西哥站按经营模式取税率；其他站点用站点默认税率（如巴西 ICMS）
  const taxMode: TaxMode = input.taxMode ?? 'direct_import';
  const taxRate = site === 'MLM' ? MX_TAX_MODE_RATES[taxMode] ?? 0 : rates.taxRate;
  const adAcosRate = input.adAcosRate ?? 0.05;

  const commission = price * rates.commissionRate;
  const pagoFee = price * rates.pagoFeeRate;
  const tax = price * taxRate;
  const adCost = price * adAcosRate;
  const refundLoss = price * rates.returnRate * rates.returnLossFactor;
  const exchangeLoss = price * rates.exchangeLossRate;
  const withdrawalFee = price * rates.withdrawalFeeRate;

  const logisticsFee = rates.logisticsBaseUsd + rates.logisticsPerKgUsd * chargeableWeightKg;
  const firstLegCny =
    input.firstLegShippingCny != null && input.firstLegShippingCny > 0
      ? input.firstLegShippingCny
      : rates.firstLegPerKgCny * chargeableWeightKg;
  const firstLegFee = firstLegCny * cnyUsd;
  const purchaseCost = (input.purchaseCostCny || 0) * cnyUsd;

  const totalCost =
    commission + pagoFee + tax + adCost + refundLoss + exchangeLoss + withdrawalFee + logisticsFee + firstLegFee + purchaseCost;
  const netProfit = price - totalCost;
  const netProfitRate = price > 0 ? netProfit / price : 0;
  const invested = purchaseCost + firstLegFee;
  const roi = invested > 0 ? netProfit / invested : 0;

  // 保本价反推：price × (1 − 变动费率合计) = 固定成本合计
  const variableRate =
    rates.commissionRate +
    rates.pagoFeeRate +
    taxRate +
    adAcosRate +
    rates.returnRate * rates.returnLossFactor +
    rates.exchangeLossRate +
    rates.withdrawalFeeRate;
  const fixedCost = logisticsFee + firstLegFee + purchaseCost;
  const breakEvenPrice = variableRate < 1 ? fixedCost / (1 - variableRate) : Infinity;

  // 推荐等级
  let recommendation: Recommendation = 'red';
  if (netProfitRate >= 0.2) recommendation = 'green';
  else if (netProfitRate >= 0.05) recommendation = 'yellow';

  // 风险预警
  const warnings: string[] = [];
  if (volumeWeightRatio > 5) warnings.push(`体积重是实重的 ${volumeWeightRatio.toFixed(1)} 倍（>5），泡货运费失控，建议放弃`);
  else if (volumeWeightRatio > 3) warnings.push(`体积重是实重的 ${volumeWeightRatio.toFixed(1)} 倍（>3），运费按体积重计费，注意压缩包装`);
  if (site === 'MLM') {
    if (taxMode === 'cbt_no_rfc') {
      warnings.push('CBT 跨境店未通过 RFC 验证，综合预扣 36%，建议尽快完成 RFC 绑定验证（可降至约 16%）');
    } else if (taxMode === 'direct_import') {
      warnings.push('按「跨境自发货直邮」计税（买家为进口商，卖家侧预扣 0）。若你的店铺走 CBT 海外仓通道，请切换税务模式重算');
    }
  }
  if (netProfit < 0) warnings.push(`当前定价亏损 $${Math.abs(netProfit).toFixed(2)}，保本价为 $${isFinite(breakEvenPrice) ? breakEvenPrice.toFixed(2) : 'N/A'}`);
  if (chargeableWeightKg > 2) warnings.push(`计费重 ${chargeableWeightKg.toFixed(2)}kg 偏大，跨境自发货优选 <1kg 轻小件`);
  if (price > 0 && purchaseCost / price > 0.5) warnings.push('采购成本占售价超 50%，利润空间薄');

  return {
    site,
    listingPriceUsd: price,
    cnyUsd,
    taxMode,
    taxRate,
    netProfit: round2(netProfit),
    netProfitRate: round4(netProfitRate),
    roi: round4(roi),
    costBreakdown: {
      commission: round2(commission),
      pagoFee: round2(pagoFee),
      logisticsFee: round2(logisticsFee),
      firstLegFee: round2(firstLegFee),
      tax: round2(tax),
      purchaseCost: round2(purchaseCost),
      adCost: round2(adCost),
      refundLoss: round2(refundLoss),
      exchangeLoss: round2(exchangeLoss),
      withdrawalFee: round2(withdrawalFee),
      totalCost: round2(totalCost),
    },
    breakEvenPrice: isFinite(breakEvenPrice) ? round2(breakEvenPrice) : -1,
    volumeWeightKg: round2(volumeWeightKg),
    chargeableWeightKg: round2(chargeableWeightKg),
    volumeWeightRatio: round2(volumeWeightRatio),
    recommendation,
    warnings,
  };
}

/** 批量测算（共享一次汇率请求） */
export async function batchCalculateProfit(inputs: ProductInput[]): Promise<ProfitResult[]> {
  const cnyUsd = await getCnyUsd();
  const results: ProfitResult[] = [];
  for (const input of inputs) {
    results.push(await calculateProfit({ ...input, cnyUsd }));
  }
  return results;
}

/**
 * 按目标净利率反推建议售价（USD）。
 * 公式：price × (1 − targetNetRate) = 固定成本合计（采购+头程+物流）
 *       即 price = fixedCost / (1 − targetNetRate)
 * @param targetNetRate 目标净利润率，如 0.20 表示 20%
 */
export async function reverseEngineerPrice(
  input: Omit<ProductInput, 'listingPriceUsd'>,
  targetNetRate: number
): Promise<number> {
  const site = (input.site || 'MLM').toUpperCase();
  const rates = getSiteRates()[site] || DEFAULT_SITE_RATES.MLM;
  const cnyUsd = input.cnyUsd ?? (await getCnyUsd());

  const weightKg = input.weightKg || 0;
  const volumeWeightKg =
    input.lengthCm && input.widthCm && input.heightCm
      ? (input.lengthCm * input.widthCm * input.heightCm) / VOLUME_DIVISOR
      : 0;
  const chargeableWeightKg = Math.max(weightKg, volumeWeightKg) || weightKg || 0.3;

  const taxMode: TaxMode = input.taxMode ?? 'direct_import';
  const taxRate = site === 'MLM' ? MX_TAX_MODE_RATES[taxMode] ?? 0 : rates.taxRate;
  const adAcosRate = input.adAcosRate ?? 0.05;

  const logisticsFee = rates.logisticsBaseUsd + rates.logisticsPerKgUsd * chargeableWeightKg;
  const firstLegCny =
    input.firstLegShippingCny != null && input.firstLegShippingCny > 0
      ? input.firstLegShippingCny
      : rates.firstLegPerKgCny * chargeableWeightKg;
  const firstLegFee = firstLegCny * cnyUsd;
  const purchaseCost = (input.purchaseCostCny || 0) * cnyUsd;

  const fixedCost = logisticsFee + firstLegFee + purchaseCost;
  const variableRate =
    rates.commissionRate +
    rates.pagoFeeRate +
    taxRate +
    adAcosRate +
    rates.returnRate * rates.returnLossFactor +
    rates.exchangeLossRate +
    rates.withdrawalFeeRate +
    targetNetRate;

  if (variableRate >= 1) return Infinity;
  return round2(fixedCost / (1 - variableRate));
}

/**
 * 按目标净利润（绝对金额 USD）反推建议售价（USD）。
 * 公式：price × (1 − variableRate) − fixedCost = targetNetProfit
 *       即 price = (fixedCost + targetNetProfit) / (1 − variableRate)
 * 运费（logisticsFee + 头程）由重量与尺寸自动决定（计费重 = max(实重, 体积重)，体积重 = L×W×H/5000）。
 * @param targetNetProfitUsd 目标净利润金额（USD），如 5 表示每件净赚 5 美元
 */
export async function priceForTargetNetProfit(
  input: Omit<ProductInput, 'listingPriceUsd'>,
  targetNetProfitUsd: number
): Promise<number> {
  const site = (input.site || 'MLM').toUpperCase();
  const rates = getSiteRates()[site] || DEFAULT_SITE_RATES.MLM;
  const cnyUsd = input.cnyUsd ?? (await getCnyUsd());

  const weightKg = input.weightKg || 0;
  const volumeWeightKg =
    input.lengthCm && input.widthCm && input.heightCm
      ? (input.lengthCm * input.widthCm * input.heightCm) / VOLUME_DIVISOR
      : 0;
  const chargeableWeightKg = Math.max(weightKg, volumeWeightKg) || weightKg || 0.3;

  const taxMode: TaxMode = input.taxMode ?? 'direct_import';
  const taxRate = site === 'MLM' ? MX_TAX_MODE_RATES[taxMode] ?? 0 : rates.taxRate;
  const adAcosRate = input.adAcosRate ?? 0.05;

  const logisticsFee = rates.logisticsBaseUsd + rates.logisticsPerKgUsd * chargeableWeightKg;
  const firstLegCny =
    input.firstLegShippingCny != null && input.firstLegShippingCny > 0
      ? input.firstLegShippingCny
      : rates.firstLegPerKgCny * chargeableWeightKg;
  const firstLegFee = firstLegCny * cnyUsd;
  const purchaseCost = (input.purchaseCostCny || 0) * cnyUsd;

  const fixedCost = logisticsFee + firstLegFee + purchaseCost;
  const variableRate =
    rates.commissionRate +
    rates.pagoFeeRate +
    taxRate +
    adAcosRate +
    rates.returnRate * rates.returnLossFactor +
    rates.exchangeLossRate +
    rates.withdrawalFeeRate;

  if (variableRate >= 1) return Infinity;
  return round2((fixedCost + targetNetProfitUsd) / (1 - variableRate));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

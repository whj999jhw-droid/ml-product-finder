/**
 * 自动筛选流水线（参考文档 filterPipeline 三层设计）
 * 第 1 层：硬性过滤 —— 价格区间 / 最低销量 / 成色 / 违禁词与品牌侵权词
 * 第 2 层：货源匹配 —— 已填 1688 货源价的进入利润测算；未填的标记「待补货源价」
 * 第 3 层：利润与体积重过滤 —— 净利率 / 体积重比 / 计费重上限
 * 输入为 M1 最新导出（或前端传入的行），输出通过/拒绝清单及原因。
 */
import { checkBannedWords } from './bannedWords.js';
import { calculateProfit, type ProfitResult, type TaxMode } from './profit.js';
import { getCnyUsd } from './exchangeRate.js';
import type { ExportProductRow } from './sourcing.js';

export interface FilterConfig {
  /** 售价下限 USD（太便宜没利润空间） */
  minPriceUsd: number;
  /** 售价上限 USD（太贵资金压力大、税费高） */
  maxPriceUsd: number;
  /** 最低销量（爆款证据） */
  minSold: number;
  /** 只要全新品 */
  requireNew: boolean;
  /** 净利率下限（第 3 层） */
  minNetProfitRate: number;
  /** 体积重/实重 比值上限 */
  maxVolumeRatio: number;
  /** 计费重上限 kg */
  maxChargeableKg: number;
  /** 墨西哥站税务模式，默认跨境自发货直邮（无需 RFC） */
  taxMode: TaxMode;
  /** 广告 ACoS 假设 */
  adAcosRate: number;
}

export const defaultFilterConfig: FilterConfig = {
  minPriceUsd: 5,
  maxPriceUsd: 100,
  minSold: 5,
  requireNew: true,
  minNetProfitRate: 0.05,
  maxVolumeRatio: 5,
  maxChargeableKg: 2,
  taxMode: 'direct_import',
  adAcosRate: 0.05,
};

export interface FilterItemResult {
  row: ExportProductRow;
  passed: boolean;
  stage: 'hard' | 'sourcing' | 'profit' | 'passed';
  reasons: string[];
  profit?: ProfitResult;
  needsSourcePrice?: boolean; // 通过硬性过滤但缺货源价，无法算利润
}

export interface FilterPipelineResult {
  total: number;
  passed: number;
  rejected: number;
  needsSourcePrice: number;
  config: FilterConfig;
  items: FilterItemResult[];
}

/**
 * 运行三层筛选流水线
 */
export async function runFilterPipeline(
  rows: ExportProductRow[],
  cfg?: Partial<FilterConfig>
): Promise<FilterPipelineResult> {
  const config: FilterConfig = { ...defaultFilterConfig, ...(cfg || {}) };
  const cnyUsd = await getCnyUsd();
  const items: FilterItemResult[] = [];

  for (const row of rows) {
    const reasons: string[] = [];

    // ===== 第 1 层：硬性过滤 =====
    if (row.priceUSD < config.minPriceUsd) reasons.push(`售价 $${row.priceUSD.toFixed(2)} 低于下限 $${config.minPriceUsd}`);
    if (row.priceUSD > config.maxPriceUsd) reasons.push(`售价 $${row.priceUSD.toFixed(2)} 高于上限 $${config.maxPriceUsd}`);
    if (config.minSold > 0 && row.soldQuantity < config.minSold) reasons.push(`销量 ${row.soldQuantity} 低于 ${config.minSold}`);
    if (config.requireNew && row.condition && row.condition !== 'new' && row.condition !== '全新') {
      reasons.push(`成色非全新（${row.condition}）`);
    }
    const banned = checkBannedWords(`${row.title} ${row.brand || ''}`, row.site);
    if (!banned.ok) reasons.push(banned.message);

    if (reasons.length > 0) {
      items.push({ row, passed: false, stage: 'hard', reasons });
      continue;
    }

    // ===== 第 2 层：货源匹配 =====
    const hasSourcePrice = (row.sourcePriceCNY || 0) > 0;
    if (!hasSourcePrice) {
      items.push({
        row,
        passed: false,
        stage: 'sourcing',
        reasons: ['缺少 1688 货源价，先在「货源与利润」页补齐后再跑利润过滤'],
        needsSourcePrice: true,
      });
      continue;
    }

    // ===== 第 3 层：利润与体积重过滤 =====
    const profit = await calculateProfit({
      site: row.site,
      listingPriceUsd: row.priceUSD,
      purchaseCostCny: row.sourcePriceCNY || 0,
      firstLegShippingCny: row.shippingCNY,
      weightKg: row.weight || 0,
      taxMode: config.taxMode,
      adAcosRate: config.adAcosRate,
      cnyUsd,
    });

    if (profit.netProfitRate < config.minNetProfitRate) {
      reasons.push(`净利率 ${(profit.netProfitRate * 100).toFixed(1)}% 低于 ${(config.minNetProfitRate * 100).toFixed(0)}%`);
    }
    if (profit.volumeWeightRatio > config.maxVolumeRatio) {
      reasons.push(`体积重比 ${profit.volumeWeightRatio.toFixed(1)} 超过 ${config.maxVolumeRatio}`);
    }
    if (profit.chargeableWeightKg > config.maxChargeableKg) {
      reasons.push(`计费重 ${profit.chargeableWeightKg.toFixed(2)}kg 超过 ${config.maxChargeableKg}kg`);
    }

    if (reasons.length > 0) {
      items.push({ row, passed: false, stage: 'profit', reasons, profit });
    } else {
      items.push({ row, passed: true, stage: 'passed', reasons: [], profit });
    }
  }

  return {
    total: rows.length,
    passed: items.filter((i) => i.passed).length,
    rejected: items.filter((i) => !i.passed && !i.needsSourcePrice).length,
    needsSourcePrice: items.filter((i) => i.needsSourcePrice).length,
    config,
    items,
  };
}

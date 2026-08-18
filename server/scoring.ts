/**
 * 五维选品打分器
 * 维度：需求强度、竞争密度、利润可行性、物流适配、合规风险
 * 总分 0~1，低于 SCORE_THRESHOLD 自动淘汰。
 */
import type { RawCandidate } from './sourcingScanner.js';
import type { Ali1688Product } from './ali1688Skill.js';
import type { ProfitResult } from './profit.js';
import { checkBannedWords } from './bannedWords.js';

export const SCORE_THRESHOLD = 0.6;

export interface ScoreBreakdown {
  demand: number; // 0~1
  competition: number; // 0~1，越高越好（蓝海）
  profit: number; // 0~1
  logistics: number; // 0~1
  compliance: number; // 0~1
  total: number;
  reasons: string[];
}

export interface ScoringInput {
  candidate: RawCandidate;
  source?: Ali1688Product;
  profit: ProfitResult;
}

/**
 * 对单个候选进行五维评分
 */
export function scoreCandidate(input: ScoringInput): ScoreBreakdown {
  const { candidate, source, profit } = input;
  const reasons: string[] = [];

  // 1) 需求强度：基于日均销量
  let demand = 0;
  if (candidate.dailySales >= 5) demand = 1;
  else if (candidate.dailySales >= 2) demand = 0.8;
  else if (candidate.dailySales >= 1) demand = 0.6;
  else if (candidate.dailySales >= 0.5) demand = 0.4;
  else demand = Math.max(0.1, candidate.dailySales);
  reasons.push(`日均销量 ${candidate.dailySales.toFixed(2)} → 需求分 ${demand.toFixed(2)}`);

  // 2) 竞争密度：越低越蓝海；有 1688 downstreamOffer 时优先用
  let competition = 0.5;
  const downstream = source?.stats?.downstreamOffer;
  if (typeof downstream === 'number') {
    if (downstream < 100) competition = 1;
    else if (downstream < 300) competition = 0.8;
    else if (downstream < 500) competition = 0.5;
    else competition = 0.2;
    reasons.push(`1688 下游铺货数 ${downstream} → 竞争分 ${competition.toFixed(2)}`);
  } else {
    // 无数据时，按 ML 同款价格带推断：售价低、销量高通常竞争更激烈
    competition = candidate.priceUsd < 15 ? 0.4 : 0.6;
    reasons.push('无 1688 铺货数据，按价格带估算竞争分');
  }

  // 3) 利润可行性：基于净利润率
  let profitScore = 0;
  if (profit.netProfitRate >= 0.25) profitScore = 1;
  else if (profit.netProfitRate >= 0.15) profitScore = 0.8;
  else if (profit.netProfitRate >= 0.08) profitScore = 0.6;
  else if (profit.netProfitRate >= 0.03) profitScore = 0.3;
  else profitScore = Math.max(0, profit.netProfitRate * 10);
  reasons.push(`净利率 ${(profit.netProfitRate * 100).toFixed(1)}% → 利润分 ${profitScore.toFixed(2)}`);

  // 4) 物流适配：轻小件、体积重比低得分高
  let logistics = 0.5;
  const cw = profit.chargeableWeightKg;
  const ratio = profit.volumeWeightRatio;
  if (cw <= 0.3 && ratio <= 2) logistics = 1;
  else if (cw <= 0.5 && ratio <= 3) logistics = 0.8;
  else if (cw <= 1 && ratio <= 4) logistics = 0.6;
  else if (cw <= 2 && ratio <= 5) logistics = 0.4;
  else logistics = 0.2;
  reasons.push(`计费重 ${cw.toFixed(2)}kg / 体积重比 ${ratio.toFixed(1)} → 物流分 ${logistics.toFixed(2)}`);

  // 5) 合规风险：命中品牌/违禁词直接判低；重量尺寸缺失也扣分
  let compliance = 1;
  const text = `${candidate.title || ''} ${source?.title || ''}`;
  const banned = checkBannedWords(text, candidate.site);
  if (!banned.ok) {
    compliance = 0;
    reasons.push(`合规风险：${banned.message}`);
  } else {
    // 数据完整度：重量/尺寸缺失扣 0.2
    if (!cw || cw <= 0) {
      compliance -= 0.2;
      reasons.push('缺少重量数据，合规分扣 0.2');
    }
    // 售价过低（< 5 USD）易被平台风控
    if (candidate.priceUsd < 5) {
      compliance -= 0.1;
      reasons.push('售价低于 5 USD，合规分扣 0.1');
    }
    if (compliance === 1) reasons.push('未命中违禁词且数据完整');
  }
  compliance = Math.max(0, compliance);

  // 加权总分：利润与合规权重最高
  const weights = { demand: 0.2, competition: 0.15, profit: 0.3, logistics: 0.15, compliance: 0.2 };
  const total =
    demand * weights.demand +
    competition * weights.competition +
    profitScore * weights.profit +
    logistics * weights.logistics +
    compliance * weights.compliance;

  return {
    demand: round2(demand),
    competition: round2(competition),
    profit: round2(profitScore),
    logistics: round2(logistics),
    compliance: round2(compliance),
    total: round2(total),
    reasons,
  };
}

export function isScorePass(score: ScoreBreakdown): boolean {
  return score.total >= SCORE_THRESHOLD && score.compliance > 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * AI 选品核价流水线
 * 串联：ML 新品扫描 → 1688 货源匹配 → 利润测算/反推 → 五维评分 → 入库
 * 设计为可独立运行，也可被 scheduler.ts 定时调用。
 */
import { v4 as uuidv4 } from 'uuid';
import {
  scanNewRisingProducts,
  enrichCandidate,
  type RawCandidate,
  type ScannerOptions,
} from './sourcingScanner.js';
import { search1688ByQuery, get1688ProductDetail, type Ali1688Product } from './ali1688Skill.js';
import { calculateProfit, reverseEngineerPrice, type ProfitResult } from './profit.js';
import { scoreCandidate, isScorePass, type ScoreBreakdown } from './scoring.js';
import {
  createSourcingRun,
  updateSourcingRun,
  insertCandidate,
  getCandidateById,
  getSourcingRun,
} from './db.js';

export interface PipelineOptions extends ScannerOptions {
  runId?: string; // 外部传入 runId（如从 API 端点预创建），不传则内部生成
  targetNetRate?: number; // 目标净利率，默认 0.15
  maxCandidatesToSource?: number; // 最多对多少个候选查 1688，控制成本，默认 30
  minScoreThreshold?: number; // 覆盖 scoring.SCORE_THRESHOLD
  skip1688IfNoAK?: boolean; // AK 未配置时是否跳过（默认 false，会报错）
}

export interface PipelineResult {
  runId: string;
  status: string;
  totalScanned: number;
  totalMatched: number;
  totalScored: number;
  totalApproved: number;
  totalRejected: number;
  errors: string[];
}

export interface SourcedCandidate {
  candidate: RawCandidate;
  source?: Ali1688Product;
  profit: ProfitResult;
  score: ScoreBreakdown;
  suggestedPriceUsd: number;
  dbId: number;
}

/**
 * 执行完整选品流水线。
 * 注意：1688 查询按候选收费（时间和积分），用 maxCandidatesToSource 控制。
 */
export async function runSourcingPipeline(opts: PipelineOptions = {}): Promise<PipelineResult> {
  const runId = opts.runId || uuidv4();
  const targetNetRate = opts.targetNetRate ?? 0.15;
  const maxCandidatesToSource = opts.maxCandidatesToSource ?? 30;
  const minScore = opts.minScoreThreshold ?? 0.6;

  // run 记录应由调用方（API 端点）预先创建，这里兜底创建
  try {
    const existing = getSourcingRun(runId);
    if (!existing) createSourcingRun(runId);
  } catch (e: any) {
    console.error(`[SourcingPipeline] 创建运行记录失败 runId=${runId}:`, e?.message || String(e));
    throw e;
  }
  const errors: string[] = [];

  try {
    // 1) 扫描 ML 新品（把扫描器内部进度同步到 run 记录，方便前端查看）
    console.log(`[SourcingPipeline] 开始扫描 runId=${runId}`);
    updateSourcingRun(runId, { message: '正在扫描 Mercado Libre 新品...' });
    const scan = await scanNewRisingProducts({
      ...opts,
      onProgress: (p) => {
        updateSourcingRun(runId, {
          message: p.message,
          ...(p.totalScanned !== undefined ? { total_scanned: p.totalScanned } : {}),
          ...(p.totalMatched !== undefined ? { total_matched: p.totalMatched } : {}),
        });
      },
    });
    const rawCandidates = scan.candidates.slice(0, maxCandidatesToSource * 2);
    // 从扫描结果里取回用于详情补全的店铺 token（自动刷新），供后续 enrich 复用
    const scanToken = (scan as any).scanToken as string | undefined;
    console.log(`[SourcingPipeline] 扫描完成：${scan.totalScanned} 个，过滤后 ${rawCandidates.length} 个`);

    updateSourcingRun(runId, {
      total_scanned: scan.totalScanned,
      total_matched: rawCandidates.length,
      message: rawCandidates.length
        ? `扫描完成：${scan.totalScanned} 个商品，${rawCandidates.length} 个进入 1688 匹配`
        : `扫描完成：${scan.totalScanned} 个商品，无符合过滤条件的候选（请检查 ML 访问令牌 / 代理 / 站点过滤）`,
    });

    if (rawCandidates.length === 0) {
      updateSourcingRun(runId, { status: 'done', finished_at: new Date().toISOString() });
      return { runId, status: 'done', totalScanned: scan.totalScanned, totalMatched: 0, totalScored: 0, totalApproved: 0, totalRejected: 0, errors: scan.errors };
    }

    let totalScored = 0;
    let totalApproved = 0;
    let totalRejected = 0;
    const rejectReasons: Record<string, number> = {};

    // 2) 逐个查 1688 + 利润 + 评分 + 入库
    const totalToProcess = Math.min(rawCandidates.length, maxCandidatesToSource);
    for (let i = 0; i < totalToProcess; i++) {
      const raw = rawCandidates[i];
      updateSourcingRun(runId, {
        message: `正在匹配 1688：第 ${i + 1}/${totalToProcess} 个（${raw.title.slice(0, 30)}）`,
        total_scored: totalScored,
        total_approved: totalApproved,
        total_rejected: totalRejected,
      });
      try {
        const { result, reason } = await processOneCandidate(runId, raw, targetNetRate, minScore, scanToken);
        totalScored++;
        if (result) {
          totalApproved++;
        } else {
          totalRejected++;
          rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
          console.log(`[SourcingPipeline] 候选 ${raw.itemId} 未通过: ${reason}`);
        }
      } catch (err: any) {
        const msg = `处理候选 ${raw.itemId} 失败: ${err?.message || String(err)}`.slice(0, 200);
        console.warn('[SourcingPipeline]', msg);
        errors.push(msg);
      }
      // 限速，避免 1688/ML 被封
      await sleep(800);
    }

    const rejectSummary = Object.entries(rejectReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    updateSourcingRun(runId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      total_scored: totalScored,
      total_approved: totalApproved,
      total_rejected: totalRejected,
      message: `选品完成：扫描 ${scan.totalScanned} 个，入库 ${totalApproved} 个${rejectSummary ? `，淘汰原因 [${rejectSummary}]` : ''}`,
      error: errors.length ? errors.join('; ') : null,
    });

    return {
      runId,
      status: 'done',
      totalScanned: scan.totalScanned,
      totalMatched: rawCandidates.length,
      totalScored,
      totalApproved,
      totalRejected,
      errors,
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    updateSourcingRun(runId, { status: 'failed', finished_at: new Date().toISOString(), message: `流水线失败：${msg}`, error: msg });
    return { runId, status: 'failed', totalScanned: 0, totalMatched: 0, totalScored: 0, totalApproved: 0, totalRejected: 0, errors: [msg] };
  }
}

/**
 * 处理单个候选：1688 货源 → 利润 → 评分 → 入库
 * @returns SourcedCandidate 如果通过评分；null 如果未通过或处理失败
 */
async function processOneCandidate(
  runId: string,
  raw: RawCandidate,
  targetNetRate: number,
  minScore: number,
  scanToken?: string
): Promise<{ result: SourcedCandidate | null; reason: string }> {
  // 2.1 补充详情（重量/尺寸/图片）
  const enriched = await enrichCandidate(raw, scanToken);

  // 2.2 1688 找货源（用简化标题，去掉站点无关词）
  const searchQuery = build1688SearchQuery(enriched.title);
  console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索词: "${searchQuery}"`);
  const searchResult = await search1688ByQuery(searchQuery);
  console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索结果: success=${searchResult.success}, message=${searchResult.message}, products=${searchResult.products.length}`);
  if (searchResult.raw) {
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索 raw:`, JSON.stringify(searchResult.raw).slice(0, 500));
  }
  if (!searchResult.success || searchResult.products.length === 0) {
    return { result: null, reason: '1688无货源' };
  }

  // 取 cheapest + 有销量的货源
  const source = pickBestSource(searchResult.products);
  if (!source) return { result: null, reason: '1688货源筛选失败' };

  // 2.3 利润测算：按目标净利率反推建议售价
  const suggestedPrice = await reverseEngineerPrice({
    site: enriched.site,
    purchaseCostCny: source.price,
    firstLegShippingCny: estimate1688Shipping(source.price),
    weightKg: enriched.weightKg,
    lengthCm: enriched.lengthCm,
    widthCm: enriched.widthCm,
    heightCm: enriched.heightCm,
    taxMode: 'direct_import',
    adAcosRate: 0.05,
  }, targetNetRate);

  // 如果反推价超过竞品 1.5 倍，说明利润空间不够，改用竞品价格测算
  const listingPrice = suggestedPrice > 0 && suggestedPrice <= enriched.priceUsd * 1.5 ? suggestedPrice : enriched.priceUsd;

  const profit = await calculateProfit({
    site: enriched.site,
    listingPriceUsd: listingPrice,
    purchaseCostCny: source.price,
    firstLegShippingCny: estimate1688Shipping(source.price),
    weightKg: enriched.weightKg,
    lengthCm: enriched.lengthCm,
    widthCm: enriched.widthCm,
    heightCm: enriched.heightCm,
    taxMode: 'direct_import',
    adAcosRate: 0.05,
  });

  // 2.4 五维评分
  const score = scoreCandidate({ candidate: enriched, source, profit });
  if (!isScorePass(score) || score.total < minScore) {
    return { result: null, reason: `评分未通过(total=${score.total}, profit=${score.profit}, compliance=${score.compliance})` };
  }

  // 2.5 入库
  const dbId = insertCandidate({
    run_id: runId,
    site: enriched.site,
    ml_item_id: enriched.itemId,
    ml_title: enriched.title,
    ml_price_usd: enriched.priceUsd,
    ml_currency: enriched.currency,
    ml_sold_quantity: enriched.soldQuantity,
    ml_category_id: enriched.categoryId,
    ml_category_name: enriched.categoryName,
    ml_permalink: enriched.permalink,
    ml_thumbnail: enriched.thumbnail,
    ml_seller_id: enriched.sellerId ? String(enriched.sellerId) : null,
    ml_listing_date: enriched.listingDate,
    source_title: searchQuery,
    source_image_url: source.imageUrl || enriched.thumbnail,
    ali1688_product_id: source.id,
    ali1688_title: source.title,
    ali1688_price_cny: source.price,
    ali1688_shipping_cny: estimate1688Shipping(source.price),
    ali1688_url: source.url,
    ali1688_supplier: source.stats?.categoryListName || '',
    ali1688_image_url: source.imageUrl,
    length_cm: enriched.lengthCm,
    width_cm: enriched.widthCm,
    height_cm: enriched.heightCm,
    weight_kg: enriched.weightKg,
    listing_price_usd: listingPrice,
    profit_net_usd: profit.netProfit,
    profit_rate: profit.netProfitRate,
    roi: profit.roi,
    break_even_price: profit.breakEvenPrice,
    cost_breakdown_json: JSON.stringify(profit.costBreakdown),
    score_demand: score.demand,
    score_competition: score.competition,
    score_profit: score.profit,
    score_logistics: score.logistics,
    score_compliance: score.compliance,
    score_total: score.total,
    status: 'pending',
  });

  if (!dbId) return { result: null, reason: '数据库写入失败' };

  return {
    result: {
      candidate: enriched,
      source,
      profit,
      score,
      suggestedPriceUsd: listingPrice,
      dbId,
    },
    reason: '通过',
  };
}

// 供 runSourcingPipeline 在循环中回填 run_id
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 生成 1688 搜索词：取 ML 标题前 5 个有效词，去掉促销/站点词
 */
function build1688SearchQuery(mlTitle: string): string {
  const stop = new Set([
    'envio', 'gratis', 'oferta', 'promocion', 'descuento', 'nuevo', 'original', 'garantia',
    'calidad', 'premium', 'super', 'mejor', 'top', 'venta', 'stock', 'rapido', 'unidad', 'unidades',
    'frete', 'grátis', 'promoção', 'desconto', 'novo', 'nova', 'garantia', 'qualidade', 'pronta',
    'entrega', 'estoque', 'rápido', 'emagrecedor', 'milagroso',
  ]);
  const tokens = (mlTitle || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !stop.has(t) && !/^\d+$/.test(t))
    .slice(0, 5);
  return tokens.join(' ') || mlTitle.slice(0, 40);
}

function pickBestSource(products: Ali1688Product[]): Ali1688Product | undefined {
  // 优先：价格低 + 有销量 + 好评率高
  const scored = products.map((p) => {
    const s = p.stats || {};
    let score = 0;
    score += Math.max(0, 1 - p.price / 100); // 越便宜越好
    score += Math.min(1, (s.last30DaysSales || 0) / 1000);
    score += (s.goodRates || 0.9) - 0.9;
    score -= (s.downstreamOffer || 0) / 1000; // 铺货数越少越好
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.p;
}

function estimate1688Shipping(priceCny: number): number {
  // MVP 估算：1688 国内运费按件 3~8 元；后续可接运费模板
  if (priceCny <= 0) return 0;
  if (priceCny < 20) return 3;
  if (priceCny < 100) return 5;
  return 8;
}

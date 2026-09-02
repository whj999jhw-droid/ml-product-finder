/**
 * AI 选品核价流水线
 * 串联：ML 新品扫描 → 1688 货源匹配 → 利润测算/反推 → 五维评分 → 入库
 * 设计为可独立运行，也可被 scheduler.ts 定时调用。
 */
import { v4 as uuidv4 } from 'uuid';
import {
  scanNewRisingProducts,
  enrichCandidate,
  CATEGORY_ZH_BY_ID,
  type RawCandidate,
  type ScannerOptions,
} from './sourcingScanner.js';
import { search1688ByQuery, get1688ProductDetail, type Ali1688Product } from './ali1688Skill.js';
import { runNewtonAutoSourcing, isNewtonConfigured } from './newtonService.js';
import { calculateProfit, reverseEngineerPrice, type ProfitResult } from './profit.js';
import { scoreCandidate, isScorePass, type ScoreBreakdown } from './scoring.js';
import { aiEvaluateCandidate, assessSourceRelevance, aiGenerateTitles, aiGenerateDescription, getLlmConfig, type AIEvaluationResult } from './aiService.js';
import { getTrendsKeywords } from './trends.js';
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
  /** 是否优先使用牛顿寻源（默认 true）；牛顿未配置或超限时自动回退 1688-shopkeeper */
  newtonPriorityEnabled?: boolean;
  /** 单次运行最多用牛顿处理多少个候选（默认 10），防止整体运行时间过长 */
  newtonMaxPerRun?: number;
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

// 牛顿优先级配置（可被环境变量覆盖，也可被单次 PipelineOptions 覆盖）
const NEWTON_PRIORITY_ENABLED = process.env.NEWTON_PRIORITY_ENABLED !== 'false';
const NEWTON_MAX_PER_RUN = Number(process.env.NEWTON_MAX_CANDIDATES_PER_RUN || 10);

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
  const maxCandidatesToSource = opts.maxCandidatesToSource ?? 40;
  const minScore = opts.minScoreThreshold ?? 0.55;
  const newtonEnabled = (opts.newtonPriorityEnabled ?? NEWTON_PRIORITY_ENABLED) && isNewtonConfigured?.();
  const newtonMax = opts.newtonMaxPerRun ?? NEWTON_MAX_PER_RUN;

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
    let totalNew = 0;
    let newtonAttempts = 0;
    let newtonHits = 0;
    const rejectReasons: Record<string, number> = {};

    // 2) 逐个查 1688 + 利润 + 评分 + 入库
    const totalToProcess = Math.min(rawCandidates.length, maxCandidatesToSource);
    for (let i = 0; i < totalToProcess; i++) {
      const raw = rawCandidates[i];
      const allowNewton = newtonEnabled && newtonAttempts < newtonMax;
      updateSourcingRun(runId, {
        message: allowNewton
          ? `正在用牛顿寻源：第 ${i + 1}/${totalToProcess} 个（${raw.title.slice(0, 30)}）`
          : `正在匹配 1688：第 ${i + 1}/${totalToProcess} 个（${raw.title.slice(0, 30)}）`,
        total_scored: totalScored,
        total_approved: totalApproved,
        total_rejected: totalRejected,
      });
      try {
      const { result, reason, isNew, sourceOrigin } = await processOneCandidate(runId, raw, targetNetRate, minScore, scanToken, allowNewton);
      if (sourceOrigin === 'newton') newtonAttempts++;
      totalScored++;
      if (result) {
        totalApproved++;
        if (isNew) totalNew++;
        if (sourceOrigin === 'newton') newtonHits++;
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

    // 将「进入匹配但未核价」的尾部商品也落库（status='matched'），便于前端按漏斗查看
    for (let i = totalToProcess; i < rawCandidates.length; i++) {
      const r = rawCandidates[i];
      insertCandidate({
        run_id: runId,
        site: r.site,
        ml_item_id: r.itemId,
        ml_title: r.title,
        ml_price_usd: r.priceUsd,
        ml_currency: r.currency,
        ml_sold_quantity: r.soldQuantity,
        ml_category_id: r.categoryId,
        ml_category_name: r.categoryName || '',
        ml_permalink: r.permalink,
        ml_thumbnail: r.thumbnail,
        ml_pictures: JSON.stringify([r.thumbnail].filter(Boolean)),
        ml_seller_id: r.sellerId ? String(r.sellerId) : null,
        ml_listing_date: r.listingDate,
        status: 'matched',
        source_tag: r.sourceTag || 'recent',
        trend_keyword: r.trendKeyword || null,
        trend_note: `进入匹配但未核价（受单次处理上限 ${maxCandidatesToSource} 个限制）`,
      });
    }

    const rejectSummary = Object.entries(rejectReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    updateSourcingRun(runId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      total_scanned: scan.totalScanned,
      total_matched: rawCandidates.length,
      total_scored: totalScored,
      total_approved: totalApproved,
      total_new: totalNew,
      total_rejected: totalRejected,
      message: `选品完成：扫描 ${scan.totalScanned} 个，入库 ${totalApproved} 个${newtonEnabled ? `（牛顿命中 ${newtonHits}/${newtonAttempts}）` : ''}${rejectSummary ? `，淘汰原因 [${rejectSummary}]` : ''}`,
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
 * 组装 candidates 入库行。类目名存为「中文 (Native)」双语，便于前端中英文展示。
 * 无论通过还是淘汰都走这里，保证候选列表可见、可人工复核。
 */
function buildCandidateRow(
  runId: string,
  enriched: Awaited<ReturnType<typeof enrichCandidate>>,
  opts: {
    status: 'pending' | 'rejected' | 'matched';
    rejectReason?: string;
    searchQuery?: string;
    source?: Ali1688Product;
    profit?: ProfitResult;
    listingPrice?: number;
    score?: ScoreBreakdown;
    aiEvaluation?: AIEvaluationResult;
  /** #4 MVP：定制新品信号标记（JSON 字符串） */
  flags?: CustomFlags;
    /** #2：AI 精化上架标题（西/葡语） */
    aiTitle?: string;
    /** #2：AI 精化商品描述 */
    aiDescription?: string;
    /** 货源来源：newton / 1688-shopkeeper */
    sourceOrigin?: 'newton' | '1688-shopkeeper' | null;
  }
): Record<string, any> {
  const zh = CATEGORY_ZH_BY_ID[enriched.categoryId] || '';
  const categoryNameBilingual = zh ? `${zh} (${enriched.categoryName})` : enriched.categoryName;
  const row: Record<string, any> = {
    run_id: runId,
    site: enriched.site,
    ml_item_id: enriched.itemId,
    ml_title: enriched.title,
    ml_price_usd: enriched.priceUsd,
    ml_currency: enriched.currency,
    ml_sold_quantity: enriched.soldQuantity,
    ml_category_id: enriched.categoryId,
    ml_category_name: categoryNameBilingual,
    ml_permalink: enriched.permalink,
    ml_thumbnail: enriched.thumbnail,
    ml_pictures: JSON.stringify(enriched.pictures && enriched.pictures.length ? enriched.pictures : [enriched.thumbnail].filter(Boolean)),
    ml_seller_id: enriched.sellerId ? String(enriched.sellerId) : null,
    ml_listing_date: enriched.listingDate,
    length_cm: enriched.lengthCm,
    width_cm: enriched.widthCm,
    height_cm: enriched.heightCm,
    weight_kg: enriched.weightKg,
    status: opts.status,
    reject_reason: opts.rejectReason || null,
  };
  if (opts.source) {
    row.source_title = opts.searchQuery || '';
    row.source_image_url = opts.source.imageUrl || enriched.thumbnail;
    row.ali1688_product_id = opts.source.id;
    row.ali1688_title = opts.source.title;
    row.ali1688_price_cny = opts.source.price;
    row.ali1688_shipping_cny = estimate1688Shipping(opts.source.price);
    row.ali1688_url = opts.source.url;
    row.ali1688_supplier = opts.source.stats?.categoryListName || '';
    row.ali1688_image_url = opts.source.imageUrl;
  }
  if (opts.profit) {
    row.listing_price_usd = opts.listingPrice;
    row.profit_net_usd = opts.profit.netProfit;
    row.profit_rate = opts.profit.netProfitRate;
    row.roi = opts.profit.roi;
    row.break_even_price = opts.profit.breakEvenPrice;
    row.cost_breakdown_json = JSON.stringify(opts.profit.costBreakdown);
  }
  if (opts.score) {
    row.score_demand = opts.score.demand;
    row.score_competition = opts.score.competition;
    row.score_profit = opts.score.profit;
    row.score_logistics = opts.score.logistics;
    row.score_compliance = opts.score.compliance;
    row.score_total = opts.score.total;
  }
  if (opts.aiEvaluation) row.ai_evaluation_json = JSON.stringify(opts.aiEvaluation);
  // #2：AI 精化标题/描述（best-effort 生成，可能为空；空则不写列）
  if (opts.aiTitle) row.ai_title = opts.aiTitle;
  if (opts.aiDescription) row.ai_description = opts.aiDescription;
  // 货源来源标记（newton / 1688-shopkeeper）
  if (opts.sourceOrigin) row.source_origin = opts.sourceOrigin;
  // #4 MVP：定制新品信号标记
  if (opts.flags) row.flags = JSON.stringify(opts.flags);
  // 趋势备注：简明说明为何选入（近期上架 + 上涨趋势 + 售价区间 + 竞争环境）
  row.trend_note = buildTrendNote(enriched, opts.score?.competition);
  // 来源标记（recent / trend / bestseller）
  row.source_tag = enriched.sourceTag || 'recent';
  // 选品时的具体热搜词（trend 模式有值），供生成标题/详情时复用，提升搜索命中
  row.trend_keyword = enriched.trendKeyword || null;
  return row;
}

/**
 * 生成「趋势备注」：简明展示选入理由。
 * 维度：上架时间、日均销量/趋势强度、售价区间、竞争环境（若有评分）。
 */
function buildTrendNote(
  enriched: Awaited<ReturnType<typeof enrichCandidate>>,
  competition?: number
): string {
  const days = enriched.daysListed || 0;
  const daily = enriched.dailySales || 0;
  const sold = enriched.soldQuantity || 0;
  const price = enriched.priceUsd || 0;

  // 来源标签（模式 A/B/recent 一目了然）
  const sourceTag =
    enriched.sourceTag === 'trend'
      ? `🔥官方热搜第${enriched.trendRank ?? '?'}名${enriched.trendKeyword ? `(${enriched.trendKeyword})` : ''}`
      : enriched.sourceTag === 'bestseller'
      ? '🏆类目热销榜'
      : '🆕近期新上';

  const ageTag =
    days <= 7 ? '近1周新上'
    : days <= 15 ? '近半月新上'
    : days <= 30 ? '近1月上架'
    : `${days}天前上架`;

  const trendTag =
    daily >= 2 ? `日均${daily.toFixed(1)}单·上涨明显`
    : daily >= 1 ? `日均${daily.toFixed(1)}单·稳步上涨`
    : daily >= 0.5 ? `日均${daily.toFixed(1)}单·有动销`
    : `累计${sold}件`;

  const priceTag = `售价$${price.toFixed(1)}`;

  let compTag = '';
  if (typeof competition === 'number') {
    compTag = competition >= 0.65 ? '竞争蓝海' : competition >= 0.5 ? '竞争中等' : '竞争偏红';
  }

  return [sourceTag, ageTag, trendTag, priceTag, compTag].filter(Boolean).join(' · ');
}

/**
 * 处理单个候选：1688 货源 → 利润 → 评分 → 入库
 * 通过则入库为 pending；1688 无货源/评分未通过等也入库为 rejected（带原因），便于人工复核。
 * @returns SourcedCandidate 如果通过评分；null 如果未通过或处理失败
 */
async function processOneCandidate(
  runId: string,
  raw: RawCandidate,
  targetNetRate: number,
  minScore: number,
  scanToken?: string,
  allowNewton = false
): Promise<{ result: SourcedCandidate | null; reason: string; isNew?: boolean; sourceOrigin?: 'newton' | '1688-shopkeeper' | null }> {
  // 2.1 补充详情（重量/尺寸/图片）
  const enriched = await enrichCandidate(raw, scanToken);

  // 2.2 优先走牛顿 NL 寻源；未配置/超时/无结果则回退 1688-shopkeeper 关键词搜索
  let sourceOrigin: 'newton' | '1688-shopkeeper' | null = null;
  let searchQuery = build1688SearchQuery(enriched.title);
  let newtonQuery = '';
  let newtonResult: { success: boolean; message: string; products: Ali1688Product[] } | undefined;

  if (allowNewton) {
    newtonQuery = buildNewtonSearchQuery(enriched);
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} 牛顿查询: "${newtonQuery}"`);
    newtonResult = await runNewtonAutoSourcing({
      query: newtonQuery,
      competitorPriceUsd: enriched.priceUsd,
      site: enriched.site,
      timeoutMs: 35000,
      maxItems: 5,
      autoAnswerClarification: true,
    });
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} 牛顿结果: success=${newtonResult.success}, message=${newtonResult.message}, products=${newtonResult.products.length}`);
  }

  if (newtonResult?.success && newtonResult.products.length > 0) {
    sourceOrigin = 'newton';
    searchQuery = newtonQuery;
  } else {
    sourceOrigin = '1688-shopkeeper';
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索词: "${searchQuery}"`);
    if (!searchQuery.trim()) {
      insertCandidate(buildCandidateRow(runId, enriched, { status: 'rejected', rejectReason: '标题为空，无法生成1688搜索词' }));
      return { result: null, reason: '标题为空，无法生成1688搜索词', sourceOrigin: null };
    }
    const searchResult = await search1688ByQuery(searchQuery);
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索结果: success=${searchResult.success}, message=${searchResult.message}, products=${searchResult.products.length}`);
    if (searchResult.raw) {
      console.log(`[SourcingPipeline] 候选 ${raw.itemId} 1688 搜索 raw:`, JSON.stringify(searchResult.raw).slice(0, 500));
    }
    if (!searchResult.success || searchResult.products.length === 0) {
      const reason = searchResult.message?.includes('CLI 未安装')
        ? searchResult.message.slice(0, 80)
        : '1688无货源';
      insertCandidate(buildCandidateRow(runId, enriched, { status: 'rejected', rejectReason: reason, searchQuery, sourceOrigin }));
      return { result: null, reason, sourceOrigin };
    }
    newtonResult = { success: true, message: searchResult.message, products: searchResult.products };
  }

  // 取货源：先按价格/销量取 Top5 候选，再逐个性相关度校验，取最匹配的一个。
  // 牛顿返回的结果同样走相关度校验，避免答非所问。
  // 这样避免「只看价格 → 便宜但不同类」的 1688 货源被错误入库（张冠李戴）。
  // LLM 不可用时退回按价格选最优，保持无 LLM 用户不被阻断。
  const topSources = pickTopSources(newtonResult!.products, 5);
  let source: Ali1688Product | undefined;
  let bestRelScore = -1;
  let fallback: Ali1688Product | undefined; // LLM 不可用时的兜底（价格最优）
  for (const cand of topSources) {
    const rel = await assessSourceRelevance(enriched.title, enriched.categoryName, cand);
    if (rel.unavailable) {
      if (!fallback) fallback = cand;
      continue;
    }
    if (rel.relevant && rel.score >= 0.6 && rel.score > bestRelScore) {
      source = cand;
      bestRelScore = rel.score;
    }
  }
  if (!source) {
    if (fallback) {
      source = fallback; // LLM 不可用：退回价格优先（旧行为）
    } else {
      const top = topSources[0];
      const rel = top ? await assessSourceRelevance(enriched.title, enriched.categoryName, top) : undefined;
      insertCandidate(buildCandidateRow(runId, enriched, {
        status: 'rejected',
        rejectReason: `1688货源不匹配(${(rel?.score ?? 0).toFixed(2)}): ${rel?.reason || '无合适货源'}`,
        searchQuery,
        sourceOrigin,
      }));
      return { result: null, reason: '1688货源不匹配', sourceOrigin };
    }
  }

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

  // 如果反推价超过竞品 3 倍，说明利润空间不够，改用竞品价格测算；否则保留反推价以保证目标净利
  const listingPrice = suggestedPrice > 0 && suggestedPrice <= enriched.priceUsd * 3 ? suggestedPrice : enriched.priceUsd;

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
    const reason = `评分未通过(total=${score.total.toFixed(2)}, demand=${score.demand.toFixed(2)}, competition=${score.competition.toFixed(2)}, profit=${score.profit.toFixed(2)}, logistics=${score.logistics.toFixed(2)}, compliance=${score.compliance.toFixed(2)})`;
    insertCandidate(buildCandidateRow(runId, enriched, { status: 'rejected', rejectReason: reason, searchQuery, source, profit, listingPrice, score, sourceOrigin }));
    return { result: null, reason, sourceOrigin };
  }

  // 2.5 AI 选品研判（可选，失败不影响入库）
  let aiEvaluation: AIEvaluationResult | undefined;
  try {
    aiEvaluation = await aiEvaluateCandidate({
      site: enriched.site,
      title: enriched.title,
      categoryName: enriched.categoryName,
      priceUsd: enriched.priceUsd,
      soldQuantity: enriched.soldQuantity,
      dailySales: enriched.dailySales,
      sourceTitle: source.title,
      sourcePriceCny: source.price,
      listingPriceUsd: listingPrice,
      netProfitRate: profit.netProfitRate,
      scoreTotal: score.total,
      scoreDemand: score.demand,
      scoreCompetition: score.competition,
      scoreProfit: score.profit,
      scoreLogistics: score.logistics,
      scoreCompliance: score.compliance,
    });
    console.log(`[SourcingPipeline] 候选 ${raw.itemId} AI 研判: pass=${aiEvaluation.pass} score=${aiEvaluation.score} reason=${aiEvaluation.reason}`);
  } catch (err: any) {
    console.warn(`[SourcingPipeline] 候选 ${raw.itemId} AI 研判失败:`, err?.message || err);
  }

  // 2.5b AI 精化上架标题/描述（#2：把已有但零调用的生成函数接进流水线）
  // best-effort：LLM 未配置或失败都不阻断入库。
  let aiTitle = '';
  let aiDescription = '';
  if (getLlmConfig()) {
    try {
      const titles = await aiGenerateTitles({
        competitorTitle: enriched.title,
        site: enriched.site,
        sourceTitle: source.title,
        sourcePriceCNY: source.price,
        count: 3,
        trendKeywords: enriched.trendKeyword ? [enriched.trendKeyword] : undefined,
      });
      aiTitle = titles.titles[0] || '';
    } catch (e: any) {
      console.warn(`[SourcingPipeline] 候选 ${raw.itemId} AI 标题生成失败:`, e?.message || e);
    }
    if (aiTitle) {
      try {
        const desc = await aiGenerateDescription({
          title: aiTitle,
          site: enriched.site,
          sourceTitle: source.title,
          sourcePriceCNY: source.price,
          categoryName: enriched.categoryName,
          trendKeywords: enriched.trendKeyword ? [enriched.trendKeyword] : undefined,
        });
        aiDescription = desc.description || '';
      } catch (e: any) {
        console.warn(`[SourcingPipeline] 候选 ${raw.itemId} AI 描述生成失败:`, e?.message || e);
      }
    }
  }

  // 2.5c 定制新品信号（#4 MVP）：从 1688 货源标题/上架时间抽取
  const flags = classifyCustom(source);

  // 2.6 入库（通过 → pending）
  const ins = insertCandidate(
    buildCandidateRow(runId, enriched, {
      status: 'pending',
      searchQuery,
      source,
      profit,
      listingPrice,
      score,
      aiEvaluation,
      flags,
      aiTitle,
      aiDescription,
      sourceOrigin,
    })
  );

  if (!ins.id) return { result: null, reason: '数据库写入失败', sourceOrigin };

  return {
    result: {
      candidate: enriched,
      source,
      profit,
      score,
      suggestedPriceUsd: listingPrice,
      dbId: ins.id,
    },
    reason: '通过',
    isNew: ins.isNew,
    sourceOrigin,
  };
}

// 供 runSourcingPipeline 在循环中回填 run_id
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 生成牛顿自然语言寻源查询。
 * 明确需求（快速发货、评价优、一件代发）可减少澄清卡概率，便于自动化流程。
 */
function buildNewtonSearchQuery(enriched: Awaited<ReturnType<typeof enrichCandidate>>): string {
  const title = enriched.title || '';
  const category = enriched.categoryName || '';
  const site = enriched.site || '';
  const priceHint = enriched.priceUsd && enriched.priceUsd > 0
    ? `竞品售价约 $${enriched.priceUsd.toFixed(2)}（${site}），进货预算按竞品价 15%~45%`
    : '';
  const trend = enriched.trendKeyword ? `，热搜词「${enriched.trendKeyword}」` : '';
  return `在1688上找「${title}${category ? `（${category}）` : ''}」的跨境无货源优质货源，要求12到48小时内发货、评价优、支持一件代发${priceHint ? '，' + priceHint : ''}${trend}。返回3-5个候选商品链接、进货价、起订量和供应商。`;
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

/** 取价格/销量综合得分最高的前 N 个货源作为相关性候选集 */
function pickTopSources(products: Ali1688Product[], topN: number): Ali1688Product[] {
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
  return scored.slice(0, topN).map((x) => x.p);
}

function estimate1688Shipping(priceCny: number): number {
  // MVP 估算：1688 国内运费按件 3~8 元；后续可接运费模板
  if (priceCny <= 0) return 0;
  if (priceCny < 20) return 3;
  if (priceCny < 100) return 5;
  return 8;
}

// ============ 定制新品信号（#4 MVP）============
// 从 1688 货源标题抽取「支持定制/定做/OEM/ODM」等关键词，结合上架时间判断「新品」。
const CUSTOM_KEYWORDS = ['定制', '定做', 'oem', 'odm', '来样加工', '支持定制', '私模', '加工定制'];

export interface CustomFlags {
  isCustom: boolean;
  isNewArrival: boolean;
  customNewArrival: boolean;
  customKeywords: string[];
}

export function classifyCustom(product: Ali1688Product, newArrivalDays = 30): CustomFlags {
  const title = (product.title || '').toLowerCase();
  const hits = CUSTOM_KEYWORDS.filter((k) => title.includes(k.toLowerCase()));
  const isCustom = hits.length > 0;
  let isNewArrival = false;
  const t = product.stats?.earliestListingTime;
  if (t) {
    const d = Date.parse(t);
    if (!isNaN(d)) {
      const days = (Date.now() - d) / 86400000;
      isNewArrival = days >= 0 && days <= newArrivalDays;
    }
  }
  return { isCustom, isNewArrival, customNewArrival: isCustom && isNewArrival, customKeywords: hits };
}

// 生成 1688 搜索用的「类目热词」种子（定制新品发现模式用）
// 1688 是中文平台，必须用中文词才能命中「定制/OEM/ODM」标题；站点热搜词是西/葡语，搜 1688 基本无定制命中。
// 故此处固定用跨境电商常见易定制的类目中文词（后续可做成可配置）。
function customNewSeedKeywords(_site: string): string[] {
  return [
    '收纳盒 定制', '手机壳 定制', '硅胶模具 定制', '宠物用品 定制', '化妆刷 定制',
    '瑜伽裤 定制', '车载支架 定制', 'LED灯带 定制', '钥匙扣 定制', '保温杯 定制',
    '定做', 'OEM 加工', '来样加工', '私模',
  ];
}

/**
 * 定制新品发现扫描（#4 MVP 的「提前布局」能力）。
 * 不再按 ML 竞品标题搜，而是按类目热词直接搜 1688，过滤出
 * 「支持定制 + 30天内上新」的货源，作为候选入库（source_tag='custom-new'）。
 * 这些往往是小 B 需求萌芽、可能先于 C 端爆款的源头。
 */
export async function runCustomNewScan(opts: {
  keywords?: string[];
  site?: string;
  runId?: string;
  targetNetRate?: number;
  maxPerKeyword?: number;
} = {}): Promise<{ runId: string; status: string; totalScanned: number; totalApproved: number; totalRejected: number }> {
  const runId = opts.runId || uuidv4();
  const site = opts.site || 'MLM';
  const targetNetRate = opts.targetNetRate ?? 0.15;
  const maxPerKeyword = opts.maxPerKeyword ?? 12;
  try {
    const existing = getSourcingRun(runId);
    if (!existing) createSourcingRun(runId);
  } catch (e: any) {
    console.error(`[CustomNewScan] 创建运行记录失败 runId=${runId}:`, e?.message || String(e));
    throw e;
  }

  const keywords = opts.keywords && opts.keywords.length ? opts.keywords : await customNewSeedKeywords(site);
  let totalScanned = 0;
  let totalApproved = 0;
  let totalRejected = 0;

  try {
    updateSourcingRun(runId, { message: `定制新品发现：种子词 ${keywords.length} 个`, total_scanned: 0, total_approved: 0, total_rejected: 0 });
    for (const kw of keywords) {
      const res = await search1688ByQuery(kw);
      if (!res.success) continue;
      const products = res.products.slice(0, maxPerKeyword);
      for (const p of products) {
        totalScanned++;
        const flags = classifyCustom(p);
        // 硬性门槛：必须是「支持定制/OEM」的货源（这是可检测的提前布局信号）。
        // isNewArrival（1688 上新≤30天）依赖 earliestListingTime，搜索接口常不返回，
        // 故作为加分项而非硬门槛——能拿到就标「上新」，拿不到只标「定制能力」。
        if (!flags.isCustom) {
          totalRejected++;
          continue;
        }
        // 利润粗估（默认 0.5kg / 10cm 立方；仅给一个量级参考，非精算）
        const priceCny = p.price || 0;
        const shipCny = estimate1688Shipping(priceCny);
        const suggested = await reverseEngineerPrice(
          { site, purchaseCostCny: priceCny, firstLegShippingCny: shipCny, weightKg: 0.5, lengthCm: 10, widthCm: 10, heightCm: 10, taxMode: 'direct_import', adAcosRate: 0.05 },
          targetNetRate
        );
        const listingPrice = suggested > 0 ? suggested : priceCny * 3;
        const profit = await calculateProfit(
          { site, listingPriceUsd: listingPrice, purchaseCostCny: priceCny, firstLegShippingCny: shipCny, weightKg: 0.5, lengthCm: 10, widthCm: 10, heightCm: 10, taxMode: 'direct_import', adAcosRate: 0.05 }
        );
        const row: Record<string, any> = {
          run_id: runId,
          site,
          ml_item_id: `custom-${p.id}-${kw}`,
          ml_title: p.title,
          ml_price_usd: +(priceCny * 0.14).toFixed(2),
          ml_category_name: p.stats?.categoryListName || '',
          ml_thumbnail: p.imageUrl || '',
          ml_pictures: JSON.stringify(p.imageUrl ? [p.imageUrl] : []),
          source_title: kw,
          source_image_url: p.imageUrl || '',
          ali1688_product_id: p.id,
          ali1688_title: p.title,
          ali1688_price_cny: p.price,
          ali1688_shipping_cny: shipCny,
          ali1688_url: p.url,
          ali1688_supplier: p.stats?.categoryListName || '',
          ali1688_image_url: p.imageUrl,
          listing_price_usd: +listingPrice.toFixed(2),
          profit_net_usd: +profit.netProfit.toFixed(2),
          profit_rate: +profit.netProfitRate.toFixed(4),
          roi: +profit.roi.toFixed(2),
          break_even_price: +profit.breakEvenPrice.toFixed(2),
          cost_breakdown_json: JSON.stringify(profit.costBreakdown),
          status: 'pending',
          reject_reason: null,
          trend_note: `🛠定制货源: ${flags.customKeywords.join('/')}${flags.isNewArrival ? ' · 1688 上新≤30天' : ''} · 种子词「${kw}」`,
          source_tag: 'custom-new',
          trend_keyword: kw,
          flags: JSON.stringify(flags),
        };
        const ins = insertCandidate(row);
        if (ins.id) totalApproved++;
        updateSourcingRun(runId, { total_scanned: totalScanned, total_approved: totalApproved, total_rejected: totalRejected });
      }
    }
    updateSourcingRun(runId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      message: `定制货源发现完成：扫描 ${totalScanned} 个，命中可定制货源 ${totalApproved} 个`,
    });
    return { runId, status: 'done', totalScanned, totalApproved, totalRejected };
  } catch (err: any) {
    const msg = err?.message || String(err);
    updateSourcingRun(runId, { status: 'failed', finished_at: new Date().toISOString(), message: `定制新品发现失败：${msg}`, error: msg });
    return { runId, status: 'failed', totalScanned, totalApproved, totalRejected };
  }
}

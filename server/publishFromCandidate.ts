/**
 * 从候选商品一键生成 CBT ListingDraft 并批量上架到多店铺。
 * 复用 listing.ts 的 publishBatch，负责：
 * - 标题生成（去重 + 卖点重组）
 * - 描述生成（轻量模板）
 * - 图片上传到 ML 图床取 picture id
 * - 按店铺站点过滤并分发
 */
import type { RawCandidate } from './sourcingScanner.js';
import { generateTitles } from './titleGenerator.js';
import { publishBatch, type ListingDraft, type BatchPublishResult } from './listing.js';
import { getAllStores, ensureStoreToken } from './stores.js';
import { createPublishJob, updatePublishJob, updateCandidateStatus, insertPublishedItem, generateSellerSku } from './db.js';
import { uploadVideoToYouTube } from './youtubeUpload.js';

// CBT 类目前缀：部分情况下需要在原站点类目前加 CBT- 前缀（若 API 报错可回退原 ID）
function toCbtCategoryId(site: string, localCategoryId: string): string {
  if (!localCategoryId) return '';
  const upper = localCategoryId.toUpperCase();
  if (upper.startsWith('CBT-')) return upper;
  // 常见写法：CBT-MLM1574 或直接用 MLM1574；先尝试 CBT- 前缀
  return `CBT-${upper}`;
}

function generateDescription(candidate: RawCandidate, title: string): string {
  const lines = [
    title,
    '',
    `Condición: Nuevo`,
    `Disponible para envío cross-border.`,
  ];
  if (candidate.weightKg) lines.push(`Peso aproximado: ${(candidate.weightKg * 1000).toFixed(0)} g.`);
  if (candidate.lengthCm || candidate.widthCm || candidate.heightCm) {
    lines.push(`Dimensiones aproximadas: ${[candidate.heightCm, candidate.widthCm, candidate.lengthCm].filter(Boolean).join(' x ')} cm.`);
  }
  lines.push('', 'Garantía de satisfacción. Consulta por disponibilidad de colores y modelos.');
  return lines.join('\n');
}

export interface CandidateToDraftOptions {
  candidate: RawCandidate;
  listingPriceUsd: number;
  sourceImageUrl?: string;
  brand?: string;
  availableQuantity?: number;
  useCbtCategory?: boolean;
  /** 前端覆盖字段（单位与 ListingDraft 一致：重量 g，尺寸 cm） */
  overrides?: Partial<ListingDraft>;
}

/**
 * 把候选商品转换为 CBT ListingDraft
 */
export function candidateToDraft(opts: CandidateToDraftOptions): ListingDraft {
  const { candidate, listingPriceUsd, sourceImageUrl, brand, availableQuantity, useCbtCategory, overrides } = opts;
  const titles = generateTitles({ competitorTitle: candidate.title, site: candidate.site, count: 3 });
  const bestTitle = titles.find((t) => t.safe)?.title || titles[0]?.title || candidate.title;

  // 类目可被前端覆盖（覆盖值同样套用 CBT- 前缀规则）
  const overrideCategory = overrides && overrides.category_id != null ? overrides.category_id : candidate.categoryId;
  const categoryId = useCbtCategory ? toCbtCategoryId(candidate.site, overrideCategory) : overrideCategory;

  const draft: ListingDraft = {
    site: candidate.site,
    title: bestTitle,
    category_id: categoryId,
    price: listingPriceUsd,
    available_quantity: availableQuantity ?? 50,
    description: generateDescription(candidate, bestTitle),
    pictureUrls: sourceImageUrl ? [sourceImageUrl, candidate.thumbnail].filter(Boolean) : [candidate.thumbnail].filter(Boolean),
    brand: brand || 'Generic',
    weight: candidate.weightKg ? Math.round(candidate.weightKg * 1000) : undefined,
    height: candidate.heightCm,
    width: candidate.widthCm,
    length: candidate.lengthCm,
    listing_type_id: 'gold_special',
  };

  if (overrides) {
    if (overrides.title != null) draft.title = overrides.title;
    if (overrides.category_id != null) draft.category_id = overrides.category_id;
    if (overrides.price != null) draft.price = overrides.price;
    if (overrides.available_quantity != null) draft.available_quantity = overrides.available_quantity;
    if (overrides.description != null) draft.description = overrides.description;
    if (overrides.pictureUrls != null) draft.pictureUrls = overrides.pictureUrls;
    if (overrides.brand != null) draft.brand = overrides.brand;
    if (overrides.model != null) draft.model = overrides.model;
    if (overrides.weight != null) draft.weight = overrides.weight;
    if (overrides.height != null) draft.height = overrides.height;
    if (overrides.width != null) draft.width = overrides.width;
    if (overrides.length != null) draft.length = overrides.length;
    if (overrides.warrantyType != null) draft.warrantyType = overrides.warrantyType;
    if (overrides.warrantyTime != null) draft.warrantyTime = overrides.warrantyTime;
    if (overrides.listing_type_id != null) draft.listing_type_id = overrides.listing_type_id;
    if (overrides.seller_custom_field != null) draft.seller_custom_field = overrides.seller_custom_field;
    if (Array.isArray(overrides.skus)) {
      draft.skus = overrides.skus;
      // 未填 model 时，用第一个 SKU 标题作为型号
      if (!draft.model && overrides.skus[0]?.title) draft.model = overrides.skus[0].title;
    }
  }

  return draft;
}

/** 逐国家/站点覆盖配置 */
export interface SiteOverride {
  price?: number;
  listing_type_id?: string;
  category_id?: string;
  attributes?: Array<{ id: string; value_id?: string; value_name?: string; values?: any[] }>;
}

export interface PublishCandidateOptions {
  candidate: RawCandidate;
  candidateDbId: number;
  listingPriceUsd: number;
  sourceImageUrl?: string;
  brand?: string;
  storeIds?: string[]; // 为空时发布到所有已启用店铺
  concurrency?: number;
  useCbtCategory?: boolean;
  youtube?: { enabled: boolean; videoPath: string; privacy?: 'private' | 'unlisted' | 'public'; title?: string };
  draftOverrides?: Partial<ListingDraft>;
  /** 按目标站点覆盖售价、listing_type、类目、属性；key 为 MLM/MLB/MLC/MCO */
  siteOverrides?: Record<string, SiteOverride>;
}

// CBT 店铺发布时复制的目标本地站点
const CBT_TARGET_SITES = ['MCO', 'MLM', 'MLB', 'MLC'];

function getStoreTargetSites(store: { site: string }): string[] {
  if (store.site === 'CBT') return CBT_TARGET_SITES;
  return [store.site];
}

/**
 * 一键将候选商品上架到指定/全部店铺。
 * 先为每个目标店铺创建 publish_jobs 记录，再并发上架，最后更新记录。
 * 支持 CBT 店铺自动复制到四国，并支持逐国家独立售价/类型/属性。
 */
export async function publishCandidate(opts: PublishCandidateOptions): Promise<BatchPublishResult> {
  const stores = getAllStores().filter((s) => s.enabled && (!opts.storeIds || opts.storeIds.includes(s.id)));
  if (stores.length === 0) {
    throw new Error('没有可用的目标店铺，请先在「店铺管理」中添加并启用店铺');
  }

  const baseDraft = candidateToDraft({
    candidate: opts.candidate,
    listingPriceUsd: opts.listingPriceUsd,
    sourceImageUrl: opts.sourceImageUrl,
    brand: opts.brand,
    useCbtCategory: opts.useCbtCategory,
    overrides: opts.draftOverrides,
  });
  // 卖家 SKU：调用方覆盖优先，否则按站点自动生成（每个站点独立，保证唯一）
  const baseSku = opts.draftOverrides?.seller_custom_field || generateSellerSku(opts.candidate.site);

  // 加分项：上架前把商品视频上传到 YouTube，并把链接写进商品描述
  if (opts.youtube?.enabled && opts.youtube.videoPath) {
    try {
      const yt = await uploadVideoToYouTube({
        filePath: opts.youtube.videoPath,
        title: opts.youtube.title || baseDraft.title,
        description: `Video demostración del producto: ${baseDraft.title}`,
        tags: [opts.candidate.site, opts.candidate.categoryName].filter(Boolean).slice(0, 5) as string[],
        privacy: opts.youtube.privacy || 'unlisted',
      });
      baseDraft.description = `${baseDraft.description}\n\n🎥 Video demostración: ${yt.url}`;
      console.log(`[Publish] YouTube 上传成功: ${yt.url}`);
    } catch (err: any) {
      console.warn('[Publish] YouTube 上传失败（不影响上架）:', err?.message || err);
    }
  }

  // 为每个（店铺 × 目标站点）生成独立草稿，支持逐国家覆盖
  const drafts: ListingDraft[] = [];
  const jobIdByDraftIndex: Record<number, number> = {};
  const storeByDraftIndex: Record<number, string> = {};
  for (const store of stores) {
    const targetSites = getStoreTargetSites(store);
    for (const site of targetSites) {
      const override = opts.siteOverrides?.[site] || {};
      const siteDraft: ListingDraft = {
        ...baseDraft,
        site,
        storeId: store.id,
        seller_custom_field: generateSellerSku(site),
        price: override.price ?? baseDraft.price,
        listing_type_id: override.listing_type_id ?? baseDraft.listing_type_id,
        category_id: override.category_id ?? baseDraft.category_id,
        sites_to_sell: [
          {
            site_id: site,
            price: override.price ?? baseDraft.price,
            listing_type_id: override.listing_type_id ?? baseDraft.listing_type_id,
            title: baseDraft.title,
            attributes: override.attributes,
          },
        ],
      };
      const idx = drafts.length;
      drafts.push(siteDraft);
      storeByDraftIndex[idx] = store.id;
      const jobId = createPublishJob({
        candidate_id: opts.candidateDbId,
        store_id: store.id,
        site,
        payload_json: JSON.stringify(siteDraft),
      });
      if (jobId) jobIdByDraftIndex[idx] = jobId;
    }
  }

  // 并发上架
  const results = await publishBatch(drafts, {
    concurrency: opts.concurrency ?? 2,
    maxRetries: 2,
    onProgress: (done, total, last) => {
      if (last?.storeId) {
        const idx = drafts.findIndex((d) => d.storeId === last.storeId && d.site === last.site);
        const jobId = idx >= 0 ? jobIdByDraftIndex[idx] : undefined;
        if (jobId) {
          updatePublishJob(jobId, {
            status: last.success ? 'success' : last.precheckHits?.length ? 'blocked' : 'failed',
            ml_item_id: last.itemId,
            ml_permalink: last.permalink,
            error: last.error,
          });
        }
      }
    },
  });

  // 上架成功的逐条写入 published_items（用于「已上架」tab 与后续修改）
  results.results.forEach((r, i) => {
    if (!r.success || !r.itemId) return;
    const jobId = jobIdByDraftIndex[i];
    const draft = drafts[i];
    if (!draft) return;
    try {
      insertPublishedItem({
        candidate_id: opts.candidateDbId,
        store_id: storeByDraftIndex[i] || draft.storeId || '',
        site: draft.site,
        ml_item_id: r.itemId,
        ml_permalink: r.permalink,
        seller_sku: draft.seller_custom_field,
        title: draft.title,
        description: draft.description,
        picture_urls: Array.isArray(draft.pictureUrls) ? draft.pictureUrls.join('|') : undefined,
        brand: draft.brand,
        model: draft.model,
        weight: draft.weight,
        length: draft.length,
        width: draft.width,
        height: draft.height,
        available_quantity: draft.available_quantity,
        price_by_site: JSON.stringify(draft.sites_to_sell || []),
        listing_type_by_site: JSON.stringify({}),
        net_proceeds_by_site: JSON.stringify({}),
      });
      if (jobId) updatePublishJob(jobId, { status: 'success' });
    } catch (e: any) {
      console.warn('[Publish] 写入 published_items 失败（不影响上架）:', e?.message || String(e));
    }
  });

  // 更新候选商品状态
  const anySuccess = results.succeeded > 0;
  updateCandidateStatus(opts.candidateDbId, anySuccess ? 'published' : 'approved', {
    published_at: anySuccess ? new Date().toISOString() : undefined,
    // 记录该候选的卖家 SKU（取首个生成的，便于检索）
    ...(anySuccess ? { seller_sku: baseSku } : {}),
  } as any);

  return results;
}

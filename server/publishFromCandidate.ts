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
import { createPublishJob, updatePublishJob, updateCandidateStatus } from './db.js';

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
}

/**
 * 把候选商品转换为 CBT ListingDraft
 */
export function candidateToDraft(opts: CandidateToDraftOptions): ListingDraft {
  const { candidate, listingPriceUsd, sourceImageUrl, brand, availableQuantity, useCbtCategory } = opts;
  const titles = generateTitles({ competitorTitle: candidate.title, site: candidate.site, count: 3 });
  const bestTitle = titles.find((t) => t.safe)?.title || titles[0]?.title || candidate.title;

  const categoryId = useCbtCategory ? toCbtCategoryId(candidate.site, candidate.categoryId) : candidate.categoryId;

  return {
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
    listing_type_id: 'bronze',
  };
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
}

/**
 * 一键将候选商品上架到指定/全部店铺。
 * 先为每个目标店铺创建 publish_jobs 记录，再并发上架，最后更新记录。
 */
export async function publishCandidate(opts: PublishCandidateOptions): Promise<BatchPublishResult> {
  const stores = getAllStores().filter((s) => s.enabled && (!opts.storeIds || opts.storeIds.includes(s.id)));
  if (stores.length === 0) {
    throw new Error('没有可用的目标店铺，请先在「店铺管理」中添加并启用店铺');
  }

  const draft = candidateToDraft({
    candidate: opts.candidate,
    listingPriceUsd: opts.listingPriceUsd,
    sourceImageUrl: opts.sourceImageUrl,
    brand: opts.brand,
    useCbtCategory: opts.useCbtCategory,
  });

  // 为每个目标店铺创建 pending 任务
  const jobIdByStore: Record<string, number> = {};
  for (const store of stores) {
    const jobId = createPublishJob({
      candidate_id: opts.candidateDbId,
      store_id: store.id,
      site: store.site,
      payload_json: JSON.stringify(draft),
    });
    if (jobId) jobIdByStore[store.id] = jobId;
  }

  // 并发上架：按店铺站点分发
  const results = await publishBatch(
    stores.map((s) => ({ ...draft, storeId: s.id })),
    {
      concurrency: opts.concurrency ?? 2,
      maxRetries: 2,
      onProgress: (done, total, last) => {
        if (last?.storeId && jobIdByStore[last.storeId]) {
          updatePublishJob(jobIdByStore[last.storeId], {
            status: last.success ? 'success' : last.precheckHits?.length ? 'blocked' : 'failed',
            ml_item_id: last.itemId,
            ml_permalink: last.permalink,
            error: last.error,
          });
        }
      },
    }
  );

  // 更新候选商品状态
  const anySuccess = results.succeeded > 0;
  updateCandidateStatus(opts.candidateDbId, anySuccess ? 'published' : 'approved', {
    published_at: anySuccess ? new Date().toISOString() : undefined,
  });

  return results;
}

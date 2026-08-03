/**
 * M2：货源匹配 + 利润测算
 * 基于 M1 导出的爆款，做 1688 货源匹配与利润测算。
 * 合规：绝不复制竞品销量/评论/原图；价格/标题/图片由卖家自建。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { getExchangeRate } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const exportDir = path.join(__dirname, '..', 'data', 'exports');

// ============ 利润引擎 ============
export interface ProfitInput {
  priceUSD: number; // 竞品在 ML 的售价 (USD)，即你打算跟卖的定价参考
  sourcePriceCNY: number; // 1688 进货价 (CNY)
  shippingCNY?: number; // 国内→目标国头程运费 (CNY)
  commissionRate?: number; // ML 佣金比例，默认 0.13
  payoutRate?: number; // 回款通道手续费比例，默认 0.03
  exchangeRateCnyUsd?: number; // 可选，不传则实时取
}

export interface ProfitResult {
  cnyUsd: number;
  landedCostCNY: number;
  landedCostUSD: number;
  mlFeeUSD: number;
  payoutFeeUSD: number;
  profitUSD: number;
  roi: number;
  followable: boolean; // profitUSD>0
}

export async function computeProfit(input: ProfitInput): Promise<ProfitResult> {
  const cnyUsd = input.exchangeRateCnyUsd ?? (await getExchangeRate('CNY'));
  const landedCostCNY = (input.sourcePriceCNY || 0) + (input.shippingCNY || 0);
  const landedCostUSD = landedCostCNY * cnyUsd;
  const commissionRate = input.commissionRate ?? 0.13;
  const payoutRate = input.payoutRate ?? 0.03;
  const mlFeeUSD = (input.priceUSD || 0) * commissionRate;
  const payoutFeeUSD = (input.priceUSD || 0) * payoutRate;
  const profitUSD = (input.priceUSD || 0) - landedCostUSD - mlFeeUSD - payoutFeeUSD;
  const roi = landedCostUSD > 0 ? profitUSD / landedCostUSD : 0;
  return {
    cnyUsd,
    landedCostCNY,
    landedCostUSD,
    mlFeeUSD,
    payoutFeeUSD,
    profitUSD,
    roi,
    followable: profitUSD > 0,
  };
}

export async function getCnyUsdRate(): Promise<number> {
  return getExchangeRate('CNY');
}

// ============ 读取 M1 最新导出 ============
export interface ExportProductRow {
  site: string;
  siteName: string;
  categoryName: string;
  categoryId: string;
  itemId: string;
  title: string;
  price: number;
  currency: string;
  priceUSD: number;
  soldQuantity: number;
  condition: string;
  brand: string;
  weight: number;
  permalink: string;
  thumbnail: string;
  // M2 用户填写 / 自动匹配字段
  sourcePriceCNY?: number;
  shippingCNY?: number;
  sourceLink?: string;
  supplier?: string;
  profitUSD?: number;
  roi?: number;
  followable?: boolean;
}

export function getLatestExportFile(): string | null {
  if (!fs.existsSync(exportDir)) return null;
  const files = fs.readdirSync(exportDir)
    .filter((f) => f.endsWith('.xlsx'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(exportDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(exportDir, files[0].f) : null;
}

/**
 * 读取 M1 最新持久化的完整商品数据（data/exports/latest_products.json）。
 * 该文件由 M1 抓取后写入，包含 M2 所需的全部字段（含 permalink / 重量 / 品牌 / 成色 / 销量 / 图片），并预计算 priceUSD。
 */
export function readLatestProducts(): ExportProductRow[] {
  const jsonPath = path.join(exportDir, 'latest_products.json');
  if (!fs.existsSync(jsonPath)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (!Array.isArray(arr) || !arr.length) return [];
    return arr.map((p: any) => ({
      site: p.site || '',
      siteName: p.siteName || p.site || '',
      categoryName: p.categoryName || '',
      categoryId: p.categoryId || '',
      itemId: p.itemId || '',
      title: p.title || '',
      price: typeof p.price === 'number' ? p.price : 0,
      currency: p.currency || '',
      priceUSD: typeof p.priceUSD === 'number' ? p.priceUSD : 0,
      soldQuantity: typeof p.soldQuantity === 'number' ? p.soldQuantity : 0,
      condition: p.condition || '',
      brand: p.brand || '',
      weight: typeof p.weight === 'number' ? p.weight : 0,
      permalink: p.permalink || '',
      thumbnail: p.thumbnail || '',
    }));
  } catch (err) {
    console.error('[M2] 读取 latest_products.json 失败:', err);
    return [];
  }
}

export async function readLatestExportRows(): Promise<ExportProductRow[]> {
  // 优先：M1 持久化的完整商品 JSON（含 permalink、priceUSD 等）
  const jsonRows = readLatestProducts();
  if (jsonRows.length) return jsonRows;
  // 回退：解析最新 M1 导出的 xlsx（兼容妙手「产品导入」Sheet）
  return readLatestExportRowsFromXlsx();
}

async function readLatestExportRowsFromXlsx(): Promise<ExportProductRow[]> {
  const file = getLatestExportFile();
  if (!file) return [];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  // 预取汇率（避免在每个 row 回调里 await）
  const rateMap: Record<string, number> = {};
  const needRates = new Set<string>(['MXN', 'BRL', 'CLP', 'COP', 'CNY', 'USD']);
  await Promise.all([...needRates].map(async (c) => { rateMap[c] = await getExchangeRate(c); }));
  const rows: ExportProductRow[] = [];
  workbook.eachSheet((sheet) => {
    if (sheet.name === '汇总') return;
    const headers: Record<number, string> = {};
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell, col) => {
      headers[col] = String(cell.value || '');
    });
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 跳过表头
      const get = (key: string): any => {
        for (const [col, h] of Object.entries(headers)) {
          if (h === key) return row.getCell(Number(col)).value;
        }
        return undefined;
      };
      const num = (key: string): number => {
        const v = get(key);
        return typeof v === 'number' ? v : parseFloat(String(v || '0')) || 0;
      };
      const str = (key: string): string => String(get(key) ?? '');
      const siteCode = str('站点') || str('site');
      // itemId 兼容：妙手「货号」格式为 `${site}-${itemId}`
      let itemId = str('商品ID') || str('itemId') || '';
      const sku = str('货号');
      if (!itemId && sku) itemId = sku.includes('-') ? sku.slice(sku.indexOf('-') + 1) : sku;
      // 当地价格 → USD（妙手 Sheet 只有「售价」/「币种」，无 USD 列）
      const localPrice = num('售价') || num('本地价格');
      const currency = str('币种') || str('货币');
      let priceUSD = num('USD价格');
      if (!priceUSD && localPrice && currency) {
        const rate = rateMap[currency] ?? (currency === 'USD' ? 1 : 0);
        priceUSD = rate > 0 ? Number((localPrice * rate).toFixed(2)) : 0;
      }
      rows.push({
        site: siteCode,
        siteName: str('站点') || siteCode,
        categoryName: str('分类') || str('类目名称') || '',
        categoryId: str('类目ID') || str('分类ID') || '',
        itemId,
        title: str('产品标题') || str('商品标题') || str('title'),
        price: localPrice,
        currency,
        priceUSD,
        soldQuantity: num('销量'),
        condition: str('成色'),
        brand: str('品牌'),
        weight: num('重量'),
        permalink: str('商品链接'),
        thumbnail: str('缩略图'),
      });
    });
  });
  return rows;
}

// ============ 写出含利润的 enriched xlsx ============
export async function writeEnrichedExport(
  rows: ExportProductRow[],
  opts: { commissionRate: number; payoutRate: number; roiThreshold: number; cnyUsd: number }
): Promise<{ fileName: string; filePath: string }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ML Product Finder · M2';
  workbook.created = new Date();
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `ML_Sourcing_${dateStr}.xlsx`;
  const sheet = workbook.addWorksheet('可跟卖清单', { properties: { tabColor: '00A859' } });

  sheet.columns = [
    { header: '站点', key: 'siteName', width: 10 },
    { header: '分类', key: 'categoryName', width: 25 },
    { header: '商品标题', key: 'title', width: 50 },
    { header: 'USD价格', key: 'priceUSD', width: 12 },
    { header: '货源价CNY', key: 'sourcePriceCNY', width: 12 },
    { header: '头程运费CNY', key: 'shippingCNY', width: 12 },
    { header: ' landedCostUSD', key: 'landedCostUSD', width: 14 },
    { header: 'ML佣金USD', key: 'mlFeeUSD', width: 12 },
    { header: '回款费USD', key: 'payoutFeeUSD', width: 12 },
    { header: '净利润USD', key: 'profitUSD', width: 12 },
    { header: 'ROI', key: 'roi', width: 10 },
    { header: '可跟卖', key: 'followable', width: 10 },
    { header: '货源链接', key: 'sourceLink', width: 40 },
    { header: '供应商', key: 'supplier', width: 15 },
    { header: '商品链接', key: 'permalink', width: 40 },
  ];

  for (const r of rows) {
    const p = await computeProfit({
      priceUSD: r.priceUSD,
      sourcePriceCNY: r.sourcePriceCNY || 0,
      shippingCNY: r.shippingCNY || 0,
      commissionRate: opts.commissionRate,
      payoutRate: opts.payoutRate,
      exchangeRateCnyUsd: opts.cnyUsd,
    });
    sheet.addRow({
      siteName: r.siteName,
      categoryName: r.categoryName,
      title: r.title,
      priceUSD: r.priceUSD,
      sourcePriceCNY: r.sourcePriceCNY || '',
      shippingCNY: r.shippingCNY || '',
      landedCostUSD: Number(p.landedCostUSD.toFixed(2)),
      mlFeeUSD: Number(p.mlFeeUSD.toFixed(2)),
      payoutFeeUSD: Number(p.payoutFeeUSD.toFixed(2)),
      profitUSD: Number(p.profitUSD.toFixed(2)),
      roi: Number(p.roi.toFixed(2)),
      followable: p.followable && p.roi >= opts.roiThreshold ? '是' : '否',
      sourceLink: r.sourceLink || '',
      supplier: r.supplier || '',
      permalink: r.permalink,
    });
  }

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00A859' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: 15 } };

  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.join(exportDir, fileName);
  await workbook.xlsx.writeFile(filePath);
  return { fileName, filePath };
}

// ============ 1688 图搜 / 货源匹配（best-effort，需开放平台密钥）============
export interface Ali1688SearchResult {
  available: boolean;
  message: string;
  items?: Array<{
    title: string;
    priceCNY: number;
    moq: number;
    supplier: string;
    supplierLevel: string;
    url: string;
    /** 货源主图 URL（供应商图，可用于自动配图；非美客多竞品图） */
    imageUrl?: string;
  }>;
}

/**
 * 1688 开放平台「以图搜货 / 关键词搜货」。
 * 需要环境变量：ML_1688_APPKEY、ML_1688_SECRET、ML_1688_TOKEN。
 * 未配置时返回 available=false，前端降级为「人工粘贴货源价」模式。
 * 注：1688 签名与具体 API 名以开放平台文档为准；此处为标准 param2 签名实现，
 * 若返回错误，请按平台最新文档微调 apiName / 字段。
 */
export async function search1688(params: {
  imageUrl?: string;
  title?: string;
}): Promise<Ali1688SearchResult> {
  const appKey = process.env.ML_1688_APPKEY;
  const secret = process.env.ML_1688_SECRET;
  const token = process.env.ML_1688_TOKEN;
  if (!appKey || !secret || !token) {
    return {
      available: false,
      message: '未配置 1688 开放平台密钥（ML_1688_APPKEY / ML_1688_SECRET / ML_1688_TOKEN）。可在「货源与利润」页用人工粘贴模式，或在环境变量配置后启用自动图搜。',
    };
  }
  try {
    // 选择 API：有图走图搜，否则走关键词搜索
    const apiName = params.imageUrl ? 'alibaba.product.image.search' : 'alibaba.product.search';
    const apiGroup = 'com.alibaba.product';
    const protocol = 'param2';
    const version = '1';

    const sysParams: Record<string, string> = {
      access_token: token,
      _aop_timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const apiParams: Record<string, string> = {};
    if (params.imageUrl) apiParams.imageUrl = params.imageUrl;
    else apiParams.q = params.title || '';
    apiParams.pageSize = '20';

    // 1688 param2 签名：secret + 按字典序拼接 所有参数 + secret，MD5
    const allParams: Record<string, string> = {
      ...sysParams,
      ...apiParams,
    };
    const sortedKeys = Object.keys(allParams).sort();
    let signStr = secret;
    for (const k of sortedKeys) signStr += k + allParams[k];
    signStr += secret;
    const signature = crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();

    const base = `https://gw.open.1688.com/openapi/${protocol}/${version}/${apiGroup}/${apiName}/${appKey}`;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(allParams)) qs.append(k, v);
    qs.append('_aop_signature', signature);
    const url = `${base}?${qs.toString()}`;

    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const text = await resp.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error_response: { sub_msg: text.slice(0, 200) } };
    }
    if (json.error_response) {
      return { available: true, message: `1688 返回错误：${json.error_response.sub_msg || json.error_response.msg || '未知错误'}` };
    }
    // 结果字段因 API 而异，做宽松解析
    const resultObj = json.result || json.alibaba_product_search_response?.result || json;
    const list = resultObj?.productList || resultObj?.list || resultObj?.resultList || [];
    const items = (Array.isArray(list) ? list : []).map((it: any) => ({
      title: it.subject || it.title || it.name || '',
      priceCNY: Number(it.priceRange?.begin || it.price?.begin || it.minPrice || it.priceCNY || 0),
      moq: Number(it.minOrderQuantity || it.moq || 1),
      supplier: it.supplierName || it.companyName || '',
      supplierLevel: it.supplierLevel || it.companyLevel || '',
      url: it.detailUrl || it.url || it.productUrl || '',
      imageUrl: it.imgUrl || it.image || it.pictureUrl || it.productImgUrl || it.imageUrl || '',
    }));
    return { available: true, message: `找到 ${items.length} 条货源`, items };
  } catch (err: any) {
    return { available: true, message: `1688 调用异常：${err?.message || '未知错误'}（请检查密钥与 API 名）` };
  }
}

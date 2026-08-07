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

// ============ 1688 搜款配置持久化 ============
export interface Ali1688Config {
  /** 当前选用的搜款方案 */
  method: 'onebound' | 'search1688api';
  /** OneBound API 密钥 */
  oneboundKey?: string;
  oneboundSecret?: string;
}

function configFilePath(): string {
  const cfgDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
  return path.join(cfgDir, 'ml-1688-config.json');
}

export function loadAli1688Config(): Ali1688Config {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { method: 'onebound' };
  }
}

export function saveAli1688Config(cfg: Ali1688Config): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

// ============ 1688 图搜 / 货源匹配（best-effort）============
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

// ======== 方案 A：OneBound 第三方 API ========
/**
 * OneBound 聚合 API（1688.item_search_img / 1688.item_search）
 * 注册即用，500次/天免费，无需企业资质。
 * 配置：ML_ONEBOUND_KEY + ML_ONEBOUND_SECRET（或存 ml-1688-config.json）
 */
async function search1688OneBound(params: {
  imageUrl?: string;
  title?: string;
  key?: string;
  secret?: string;
}): Promise<Ali1688SearchResult> {
  const key = params.key || process.env.ML_ONEBOUND_KEY;
  const secret = params.secret || process.env.ML_ONEBOUND_SECRET;
  if (!key || !secret) {
    return {
      available: false,
      message: '未配置 OneBound 密钥（Key/Secret）。请在「货源与利润」页填写 OneBound 配置，或设置环境变量 ML_ONEBOUND_KEY / ML_ONEBOUND_SECRET。',
    };
  }
  try {
    const apiName = params.imageUrl ? '1688/item_search_img' : '1688/item_search';
    const qs = new URLSearchParams({
      key,
      secret,
      page: '1',
      sort: 'sales_desc',
    });
    if (params.imageUrl) {
      qs.set('imgid', params.imageUrl);
    } else {
      qs.set('q', params.title || '');
    }
    const url = `https://api-gw.onebound.cn/${apiName}?${qs.toString()}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const json = await resp.json();
    if (json.error || json.code) {
      return { available: true, message: `OneBound 错误：${json.error || json.msg || json.error_msg || '未知错误'}` };
    }
    const list = json.items?.item || json.items || json.data || [];
    const items = (Array.isArray(list) ? list : []).slice(0, 20).map((it: any) => ({
      title: it.title || it.name || '',
      priceCNY: Number(it.price || 0),
      moq: Number(it.moq || it.min_quantity || 1),
      supplier: it.seller_nick || it.supplier || '',
      supplierLevel: it.seller_level || '',
      url: it.detail_url || it.url || '',
      imageUrl: it.pic_url || it.image || it.img || '',
    }));
    return { available: true, message: `OneBound 找到 ${items.length} 条货源`, items };
  } catch (err: any) {
    return { available: true, message: `OneBound 调用异常：${err?.message || '未知错误'}` };
  }
}

// ======== 方案 B：search1688api 开源 Python 库 ========
/**
 * 调用本机 Python 运行 search1688api，支持图搜/关键词搜。
 * 完全免费，无需任何密钥，MIT 开源。
 * 需要：pip install search1688api
 */
async function search1688ByPython(params: {
  imageUrl?: string;
  title?: string;
}): Promise<Ali1688SearchResult> {
  // 先检查 Python 环境
  try {
    const { execSync } = await import('child_process');
    let pythonCmd = 'python3';
    try { execSync('python3 --version', { stdio: 'pipe' }); } catch {
      try { execSync('python --version', { stdio: 'pipe' }); pythonCmd = 'python'; } catch {
        return { available: false, message: '本机未安装 Python。请安装 Python 3.9+ 后重试。' };
      }
    }
    // 检查 search1688api 是否安装
    try {
      execSync(`${pythonCmd} -c "import search1688api"`, { stdio: 'pipe' });
    } catch {
      return { available: false, message: 'search1688api 库未安装。请运行：pip install search1688api' };
    }

    // 构建 Python 脚本
    const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const scriptPath = path.join(tmpDir, '_1688_search.py');
    const outPath = path.join(tmpDir, '_1688_result.json');

    let pyCode: string;
    if (params.imageUrl) {
      // 图搜：先下载图片到临时文件
      const imgPath = path.join(tmpDir, '_search_img.jpg');
      try {
        const imgResp = await fetch(params.imageUrl, { signal: AbortSignal.timeout(10000) });
        if (imgResp.ok) {
          const buf = Buffer.from(await imgResp.arrayBuffer());
          fs.writeFileSync(imgPath, buf);
        } else {
          return { available: false, message: '商品图片下载失败，请检查图片链接是否有效' };
        }
      } catch {
        return { available: false, message: '商品图片下载超时' };
      }
      pyCode = `
import json, sys
try:
    from search1688api import Sync1688Session
    with Sync1688Session() as s:
        products = s.search_by_image(r"${imgPath.replace(/\\/g, '\\\\')}")
    items = []
    for p in products[:20]:
        items.append({
            "title": getattr(p, "title", "") or "",
            "priceCNY": float(getattr(p, "price", 0) or 0),
            "moq": int(getattr(p, "moq", 1) or 1),
            "supplier": getattr(p, "supplier", "") or "",
            "url": getattr(p, "url", "") or "",
            "imageUrl": getattr(p, "image_url", "") or ""
        })
    with open(r"${outPath.replace(/\\/g, '\\\\')}", "w", encoding="utf-8") as f:
        json.dump({"success": True, "items": items, "count": len(items)}, f, ensure_ascii=False)
except Exception as e:
    with open(r"${outPath.replace(/\\/g, '\\\\')}", "w", encoding="utf-8") as f:
        json.dump({"success": False, "error": str(e)}, f, ensure_ascii=False)
`;
    } else {
      const keyword = (params.title || '').replace(/"/g, '\\"');
      pyCode = `
import json, sys
try:
    from search1688api import Sync1688Session
    with Sync1688Session() as s:
        products = s.search_by_keyword("${keyword}")
    items = []
    for p in products[:20]:
        items.append({
            "title": getattr(p, "title", "") or "",
            "priceCNY": float(getattr(p, "price", 0) or 0),
            "moq": int(getattr(p, "moq", 1) or 1),
            "supplier": getattr(p, "supplier", "") or "",
            "url": getattr(p, "url", "") or "",
            "imageUrl": getattr(p, "image_url", "") or ""
        })
    with open(r"${outPath.replace(/\\/g, '\\\\')}", "w", encoding="utf-8") as f:
        json.dump({"success": True, "items": items, "count": len(items)}, f, ensure_ascii=False)
except Exception as e:
    with open(r"${outPath.replace(/\\/g, '\\\\')}", "w", encoding="utf-8") as f:
        json.dump({"success": False, "error": str(e)}, f, ensure_ascii=False)
`;
    }
    fs.writeFileSync(scriptPath, pyCode, 'utf-8');

    // 执行 Python 脚本（最多 30 秒）
    try {
      execSync(`${pythonCmd} "${scriptPath}"`, { timeout: 30000, stdio: 'pipe' });
    } catch (e: any) {
      const stderr = e.stderr?.toString() || '';
      return { available: true, message: `Python 执行失败：${stderr.slice(0, 200) || e.message}` };
    }

    // 读取结果
    if (!fs.existsSync(outPath)) {
      return { available: true, message: 'Python 脚本未产出结果文件' };
    }
    const resultJson = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    // 清理临时文件
    try { fs.unlinkSync(scriptPath); fs.unlinkSync(outPath); } catch {}
    if (!resultJson.success) {
      return { available: true, message: `search1688api 错误：${resultJson.error || '未知错误'}` };
    }
    return {
      available: true,
      message: `search1688api 找到 ${resultJson.count || resultJson.items?.length || 0} 条货源`,
      items: (resultJson.items || []).slice(0, 20),
    };
  } catch (err: any) {
    return { available: true, message: `search1688api 调用异常：${err?.message || '未知错误'}` };
  }
}

// ======== 统一分发：按 method 参数路由到不同方案 ========
/**
 * 统一的 1688 搜款入口，支持两种方案切换。
 * @param method - 'onebound' | 'search1688api'
 * @param imageUrl - 商品图 URL（图搜）
 * @param title - 关键词（文本搜）
 * @param oneboundKey - OneBound Key（可选，不传则从配置/环境变量读取）
 * @param oneboundSecret - OneBound Secret（可选）
 */
export async function search1688(params: {
  method?: string;
  imageUrl?: string;
  title?: string;
  oneboundKey?: string;
  oneboundSecret?: string;
}): Promise<Ali1688SearchResult> {
  const method = params.method || loadAli1688Config().method || 'onebound';

  switch (method) {
    case 'search1688api':
      return search1688ByPython({ imageUrl: params.imageUrl, title: params.title });
    case 'onebound':
    default: {
      const cfg = loadAli1688Config();
      return search1688OneBound({
        imageUrl: params.imageUrl,
        title: params.title,
        key: params.oneboundKey || cfg.oneboundKey,
        secret: params.oneboundSecret || cfg.oneboundSecret,
      });
    }
  }
}

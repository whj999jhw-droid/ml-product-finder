/**
 * 选品利润分析导出：1688货源匹配后，生成含利润测算的 Excel 明细表。
 * 字段：货号/标题/币种/货源链接/采购价/售价/净收益/颜色/尺码/
 * 库存/类目ID/站点/物流方式/描述/图片URL。
 * 注意合规：图片 URL 列仅放你自有/已授权的图；缩略图列单独标注「参考图（禁止直接上架用）」。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import { batchCalculateProfit, type TaxMode } from './profit.js';
import type { ExportProductRow } from './sourcing.js';
import { ML_SITES } from './mercadolibre.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const exportDir = path.join(__dirname, '..', 'data', 'exports');

export interface ErpExportOptions {
  taxMode?: TaxMode;
  adAcosRate?: number;
  /** 默认库存 */
  defaultStock?: number;
  /** 只导出净利率 ≥ 该值的行（0 表示全导） */
  minNetProfitRate?: number;
}

export async function writeErpExport(
  rows: ExportProductRow[],
  opts?: ErpExportOptions
): Promise<{ fileName: string; filePath: string; exported: number; skipped: number }> {
  const options = {
    defaultStock: 50,
    minNetProfitRate: 0,
    adAcosRate: 0.05,
    taxMode: 'direct_import' as TaxMode,
    ...(opts || {}),
  };

  // 批量利润测算（缺货源价的行 netProfit 记为 0 并标注）
  const profits = await batchCalculateProfit(
    rows.map((r) => ({
      site: r.site,
      listingPriceUsd: r.priceUSD,
      purchaseCostCny: r.sourcePriceCNY || 0,
      firstLegShippingCny: r.shippingCNY,
      weightKg: r.weight || 0,
      taxMode: options.taxMode,
      adAcosRate: options.adAcosRate,
    }))
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ML Product Finder · 选品利润分析';
  workbook.created = new Date();
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `选品利润分析_${dateStr}.xlsx`;
  const sheet = workbook.addWorksheet('利润分析', { properties: { tabColor: '3366FF' } });

  sheet.columns = [
    { header: '货号', key: 'sku', width: 18 },
    { header: '标题', key: 'title', width: 50 },
    { header: '站点', key: 'site', width: 8 },
    { header: '币种', key: 'currency', width: 8 },
    { header: '类目ID', key: 'categoryId', width: 14 },
    { header: '售价', key: 'price', width: 10 },
    { header: '采购价CNY', key: 'purchaseCny', width: 12 },
    { header: '净收益USD', key: 'netProfit', width: 12 },
    { header: '净利率', key: 'netProfitRate', width: 10 },
    { header: '推荐', key: 'recommendation', width: 8 },
    { header: '库存', key: 'stock', width: 8 },
    { header: '颜色', key: 'color', width: 10 },
    { header: '尺码', key: 'size', width: 10 },
    { header: '物流方式', key: 'logistics', width: 12 },
    { header: '货源链接', key: 'sourceLink', width: 40 },
    { header: '描述', key: 'description', width: 50 },
    { header: '自有图片URL(须自备)', key: 'ownImage', width: 30 },
    { header: '参考图(禁止直接使用)', key: 'refImage', width: 40 },
    { header: '风险预警', key: 'warnings', width: 40 },
  ];

  let exported = 0;
  let skipped = 0;
  rows.forEach((r, idx) => {
    const p = profits[idx];
    const hasSource = (r.sourcePriceCNY || 0) > 0;
    if (options.minNetProfitRate > 0 && (!hasSource || p.netProfitRate < options.minNetProfitRate)) {
      skipped++;
      return;
    }
    const siteInfo = ML_SITES[r.site as keyof typeof ML_SITES];
    sheet.addRow({
      sku: `MLPF-${r.site}-${String(idx + 1).padStart(4, '0')}`,
      title: r.title, // 提醒：上架前请改写为自己的标题
      site: r.site,
      currency: siteInfo?.currency || r.currency || 'USD',
      categoryId: r.categoryId || '',
      price: r.priceUSD,
      purchaseCny: r.sourcePriceCNY || '',
      netProfit: hasSource ? p.netProfit : '',
      netProfitRate: hasSource ? `${(p.netProfitRate * 100).toFixed(1)}%` : '待补货源价',
      recommendation: hasSource ? (p.recommendation === 'green' ? '绿' : p.recommendation === 'yellow' ? '黄' : '红') : '',
      stock: options.defaultStock,
      color: '',
      size: '',
      logistics: '自发货(custom)',
      sourceLink: r.sourceLink || '',
      description: '',
      ownImage: '',
      refImage: r.thumbnail || '',
      warnings: (p.warnings || []).join('；'),
    });
    exported++;
  });

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3366FF' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: exported + 1, column: 19 } };

  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.join(exportDir, fileName);
  await workbook.xlsx.writeFile(filePath);
  return { fileName, filePath, exported, skipped };
}

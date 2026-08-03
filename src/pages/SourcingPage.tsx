import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Tag,
  Table,
  InputNumber,
  Input,
  Select,
  NotificationPlugin,
  Loading,
  Dialog,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';

interface SourcingRow {
  site: string;
  siteName: string;
  categoryName: string;
  categoryId?: string;
  itemId: string;
  title: string;
  priceUSD: number;
  soldQuantity?: number;
  condition?: string;
  brand?: string;
  weight?: number;
  sourcePriceCNY: number;
  shippingCNY: number;
  sourceLink: string;
  supplier: string;
  permalink: string;
  thumbnail: string;
  /** 卖家自建的上架标题（由「AI生成」或手工填入，绝不复制竞品原标题） */
  mlTitle?: string;
  /** 1688 货源主图 URL（供应商图，自动配图用；非美客多竞品图） */
  sourceImages?: string[];
  // 测算结果（前端实时算）
  profitUSD?: number;
  roi?: number;
  followable?: boolean;
}

// 完整测算结果（后端 /api/ml/profit/batch 返回）
interface FullProfit {
  netProfit: number;
  netProfitRate: number;
  breakEvenPrice: number;
  volumeWeightRatio: number;
  recommendation: 'green' | 'yellow' | 'red';
  warnings: string[];
}

interface FilterInfo {
  passed: boolean;
  stage: string;
  reasons: string[];
  needsSourcePrice?: boolean;
}

const defaultSettings = { commissionRate: 0.13, payoutRate: 0.03, roiThreshold: 0.2 };

export function SourcingPage() {
  const [rows, setRows] = useState<SourcingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [cnyUsd, setCnyUsd] = useState(0.14);
  const [settings, setSettings] = useState(defaultSettings);
  const [exporting, setExporting] = useState(false);
  const [searching, setSearching] = useState<string | null>(null); // 正在图搜的 itemId
  const [fullCalcing, setFullCalcing] = useState(false);
  const [filtering, setFiltering] = useState(false);
  const [erpExporting, setErpExporting] = useState(false);
  const [fullProfits, setFullProfits] = useState<Record<string, FullProfit>>({});
  const [filterInfo, setFilterInfo] = useState<Record<string, FilterInfo>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 标题生成（合规：提取竞品要素→重组为你自己的标题）
  const [genOpen, setGenOpen] = useState(false);
  const [genRow, setGenRow] = useState<SourcingRow | null>(null);
  const [genTitles, setGenTitles] = useState<any[]>([]);
  const [genLoading, setGenLoading] = useState(false);
  // 1688 免密钥关键词找同款
  const [kwOpen, setKwOpen] = useState(false);
  const [kwRow, setKwRow] = useState<SourcingRow | null>(null);
  const [kw, setKw] = useState('');
  const [kwLoading, setKwLoading] = useState(false);
  // 税务模式（影响利润/筛选/导出测算）：跨境自发货直邮0% / CBT有RFC 16% / CBT无RFC 36% / 本土店 10.5%
  const [taxMode, setTaxMode] = useState<string>('direct_import');
  // 自动配图设置
  const [autoImageMode, setAutoImageMode] = useState<string>('watermark'); // watermark=加水印(推荐) / direct=直传源图 / off=关
  const [watermarkText, setWatermarkText] = useState('TuTienda');
  // 每张图处理好的美客多公网 URL（按 itemId 存）
  const [mlPictures, setMlPictures] = useState<Record<string, string[]>>({});
  const [batchGenLoading, setBatchGenLoading] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  // 一键上架确认
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishSummary, setPublishSummary] = useState<string>('');

  // 前端实时利润测算（与后端 computeProfit 同公式）
  const calc = useCallback(
    (row: SourcingRow) => {
      const landedCNY = (row.sourcePriceCNY || 0) + (row.shippingCNY || 0);
      const landedUSD = landedCNY * cnyUsd;
      const mlFee = (row.priceUSD || 0) * settings.commissionRate;
      const payout = (row.priceUSD || 0) * settings.payoutRate;
      const profit = (row.priceUSD || 0) - landedUSD - mlFee - payout;
      const roi = landedUSD > 0 ? profit / landedUSD : 0;
      return { profitUSD: profit, roi, followable: profit > 0 && roi >= settings.roiThreshold };
    },
    [cnyUsd, settings]
  );

  const loadRate = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/sourcing/rate');
      const d = await r.json();
      if (d.success && d.cnyUsd) setCnyUsd(d.cnyUsd);
    } catch { /* 用默认 0.14 */ }
  }, []);

  const loadLatest = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/ml/sourcing/export/latest');
      const d = await r.json();
      if (d.success) {
        const mapped: SourcingRow[] = (d.rows || []).map((x: any) => ({
          ...x,
          sourcePriceCNY: 0,
          shippingCNY: 0,
          sourceLink: '',
          supplier: '',
        }));
        setRows(mapped);
        if (mapped.length === 0) {
          NotificationPlugin.warning({ title: '暂无数据', content: '请先到「美客多商品抓取」跑一次 M1，生成导出文件' });
        }
      } else {
        NotificationPlugin.error({ title: '读取失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '读取失败', content: err?.message || '未知错误' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRate();
    loadLatest();
  }, [loadRate, loadLatest]);

  const updateRow = (itemId: string, patch: Partial<SourcingRow>) => {
    setRows((prev) => prev.map((r) => (r.itemId === itemId ? { ...r, ...patch } : r)));
  };

  const handleAutoSearch = async (row: SourcingRow) => {
    setSearching(row.itemId);
    try {
      const r = await fetch('/api/ml/sourcing/1688/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: row.thumbnail || '', title: row.title }),
      });
      const d = await r.json();
      if (d.success && d.available && d.items && d.items.length) {
        const top = d.items[0];
        updateRow(row.itemId, {
          sourcePriceCNY: Number(top.priceCNY) || 0,
          sourceLink: top.url || '',
          supplier: top.supplier || '',
          sourceImages: top.imageUrl ? [top.imageUrl] : [],
        });
        NotificationPlugin.success({ title: '图搜完成', content: `找到 ${d.items.length} 条货源，已填入首条（${top.priceCNY} CNY）` });
      } else {
        NotificationPlugin.warning({ title: '自动图搜不可用', content: d.message || '未配置 1688 密钥，请改用手工粘贴模式' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '图搜失败', content: err?.message || '未知错误' });
    } finally {
      setSearching(null);
    }
  };

  // 合规标题自动生成（提取竞品要素→重组为你自己的标题，不复制竞品）
  const handleGenerateTitle = async (row: SourcingRow) => {
    setGenRow(row);
    setGenOpen(true);
    setGenLoading(true);
    setGenTitles([]);
    try {
      const r = await fetch('/api/ml/listing/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitorTitle: row.title, site: row.site, brand: row.brand }),
      });
      const d = await r.json();
      if (d.success && d.titles?.length) {
        setGenTitles(d.titles);
      } else {
        NotificationPlugin.warning({ title: '生成失败', content: d.message || '未生成标题' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '生成失败', content: err?.message || '未知错误' });
    } finally {
      setGenLoading(false);
    }
  };

  const handleAdoptTitle = (title: string) => {
    if (genRow) updateRow(genRow.itemId, { mlTitle: title });
    setGenOpen(false);
    NotificationPlugin.success({ title: '已采用标题', content: title });
  };

  // 1688 免密钥关键词找同款（Playwright + 本机 Edge，best-effort）
  const openKwSearch = (row: SourcingRow) => {
    setKwRow(row);
    setKw(row.title || '');
    setKwOpen(true);
  };

  const handleKwRun = async () => {
    if (!kwRow) return;
    setKwLoading(true);
    try {
      const r = await fetch('/api/ml/sourcing/1688/auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: kw, title: kwRow.title }),
      });
      const d = await r.json();
      if (d.success && d.available && d.items?.length) {
        const top = d.items[0];
        updateRow(kwRow.itemId, {
          sourcePriceCNY: Number(top.priceCNY) || 0,
          sourceLink: top.url || '',
          supplier: top.supplier || '',
          sourceImages: top.imageUrl ? [top.imageUrl] : [],
        });
        NotificationPlugin.success({ title: '1688 找同款完成', content: `找到 ${d.items.length} 条，已回填首条（${top.priceCNY} CNY）` });
        setKwOpen(false);
      } else {
        NotificationPlugin.warning({ title: '免密钥搜索不可用', content: d.message || '未找到货源' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '搜索失败', content: err?.message || '未知错误' });
    } finally {
      setKwLoading(false);
    }
  };

  // 完整测算（后端引擎：体积重/税费/广告/退款损耗/汇损/提现费 + 保本价 + 预警）
  const handleFullCalc = async () => {
    setFullCalcing(true);
    try {
      const inputs = rows.map((r) => ({
        site: r.site,
        listingPriceUsd: r.priceUSD,
        purchaseCostCny: r.sourcePriceCNY || 0,
        firstLegShippingCny: r.shippingCNY || undefined,
        weightKg: r.weight || 0,
        taxMode,
      }));
      const r = await fetch('/api/ml/profit/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      const d = await r.json();
      if (d.success) {
        const map: Record<string, FullProfit> = {};
        rows.forEach((row, i) => {
          if (d.results[i]) map[row.itemId] = d.results[i];
        });
        setFullProfits(map);
        const green = d.results.filter((x: any) => x.recommendation === 'green').length;
        NotificationPlugin.success({
          title: '完整测算完成',
          content: `共 ${d.results.length} 条，绿灯（净利率≥20%）${green} 条。含官方物流费/税费/广告/退款损耗等全项成本。`,
        });
      } else {
        NotificationPlugin.error({ title: '测算失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '测算失败', content: err?.message || '未知错误' });
    } finally {
      setFullCalcing(false);
    }
  };

  // 自动筛选流水线（3 层：硬性过滤 → 货源 → 利润/体积重）
  const handleRunFilter = async () => {
    setFiltering(true);
    try {
      const r = await fetch('/api/ml/filter/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, config: { taxMode } }),
      });
      const d = await r.json();
      if (d.success) {
        const map: Record<string, FilterInfo> = {};
        (d.items || []).forEach((it: any) => {
          if (it.row?.itemId) {
            map[it.row.itemId] = { passed: it.passed, stage: it.stage, reasons: it.reasons || [], needsSourcePrice: it.needsSourcePrice };
          }
        });
        setFilterInfo(map);
        NotificationPlugin.success({
          title: '筛选完成',
          content: `共 ${d.total} 条：通过 ${d.passed}，拒绝 ${d.rejected}，待补货源价 ${d.needsSourcePrice}`,
        });
      } else {
        NotificationPlugin.error({ title: '筛选失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '筛选失败', content: err?.message || '未知错误' });
    } finally {
      setFiltering(false);
    }
  };

  // 妙手 ERP 素材包导出
  const handleErpExport = async () => {
    setErpExporting(true);
    try {
      const r = await fetch('/api/ml/erp/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, options: { taxMode } }),
      });
      const d = await r.json();
      if (d.success) {
        window.open(`/api/ml/download/${encodeURIComponent(d.fileName)}`, '_blank');
        NotificationPlugin.success({ title: '妙手素材包已导出', content: `${d.fileName}（导出 ${d.exported} 条）` });
      } else {
        NotificationPlugin.error({ title: '导出失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '导出失败', content: err?.message || '未知错误' });
    } finally {
      setErpExporting(false);
    }
  };

  const handleExport = async () => {
    const enriched = rows.map((r) => {
      const c = calc(r);
      return { ...r, ...c };
    });
    setExporting(true);
    try {
      const r = await fetch('/api/ml/sourcing/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: enriched, ...settings }),
      });
      const d = await r.json();
      if (d.success) {
        window.open(`/api/ml/download/${encodeURIComponent(d.fileName)}`, '_blank');
        NotificationPlugin.success({ title: '已导出', content: d.fileName });
      } else {
        NotificationPlugin.error({ title: '导出失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '导出失败', content: err?.message || '未知错误' });
    } finally {
      setExporting(false);
    }
  };

  // 一键批量生成标题：对全部行调用后端，自动填回相似度最低的候选（最安全）
  const handleBatchGenTitles = async () => {
    if (rows.length === 0) return;
    setBatchGenLoading(true);
    try {
      const r = await fetch('/api/ml/listing/generate-title/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rows.map((x) => ({ competitorTitle: x.title, site: x.site, brand: x.brand })),
        }),
      });
      const d = await r.json();
      if (d.success && Array.isArray(d.titles)) {
        rows.forEach((x, i) => {
          if (d.titles[i]) updateRow(x.itemId, { mlTitle: d.titles[i] });
        });
        NotificationPlugin.success({
          title: '批量标题已生成',
          content: `已为 ${d.titles.filter(Boolean).length} 条填好「我的标题」（自动选最安全候选）`,
        });
      } else {
        NotificationPlugin.warning({ title: '生成失败', content: d.message || '未生成' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '生成失败', content: err?.message || '未知错误' });
    } finally {
      setBatchGenLoading(false);
    }
  };

  // 批量配图（合规）：1688 货源图 → 可选水印 → 上传美客多，按 itemId 存公网 URL
  const handleBatchImages = async () => {
    const targets = rows.filter((r) => (r.sourceImages || []).length > 0);
    if (targets.length === 0) {
      NotificationPlugin.warning({ title: '无可配图商品', content: '请先对商品做 1688 图搜拿到货源图' });
      return;
    }
    setImgLoading(true);
    try {
      const newPics: Record<string, string[]> = { ...mlPictures };
      const pool = 4;
      let idx = 0;
      async function worker() {
        while (idx < targets.length) {
          const row = targets[idx++];
          try {
            const r = await fetch('/api/ml/listing/prepare-images', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                site: row.site,
                sourceImages: row.sourceImages,
                watermark: autoImageMode !== 'direct',
                watermarkText,
                max: 6,
              }),
            });
            const d = await r.json();
            newPics[row.itemId] = d.success && d.pictures?.length ? d.pictures : [];
          } catch {
            newPics[row.itemId] = [];
          }
        }
      }
      await Promise.all(Array.from({ length: pool }, () => worker()));
      setMlPictures(newPics);
      const done = Object.values(newPics).filter((p) => p.length > 0).length;
      NotificationPlugin.success({ title: '批量配图完成', content: `${done}/${targets.length} 个商品已生成美客多图` });
    } finally {
      setImgLoading(false);
    }
  };

  // 一键上架（用「我的标题」+「已配图」构建草稿并批量发布，合规预检在前端/后端双重把关）
  const handlePublishConfirm = async () => {
    setPublishing(true);
    setPublishSummary('');
    try {
      const drafts = rows
        .filter((r) => (r.mlTitle || '').trim().length >= 5 && (mlPictures[r.itemId]?.length || 0) > 0)
        .map((r) => ({
          site: r.site,
          title: r.mlTitle,
          category_id: r.categoryId || '',
          price: r.priceUSD,
          available_quantity: 10,
          description: `【${r.mlTitle}】 优选货源，质量保障，欢迎选购。`,
          pictureUrls: mlPictures[r.itemId],
          brand: r.brand && r.brand.toLowerCase() !== 'generic' ? r.brand : 'Generic',
          weight: r.weight || 0.5,
        }));
      if (drafts.length === 0) {
        NotificationPlugin.warning({ title: '无符合条件的商品', content: '需同时具备「我的标题」与「已配图」' });
        setPublishing(false);
        return;
      }
      const r = await fetch('/api/ml/listing/publish-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts, concurrency: 3 }),
      });
      const d = await r.json();
      if (d.success) {
        setPublishSummary(`上架完成：成功 ${d.succeeded} / 合规拦截 ${d.blocked} / 失败 ${d.failed}（共 ${d.total}）`);
        NotificationPlugin.success({ title: '批量上架完成', content: `成功 ${d.succeeded} 条` });
      } else {
        NotificationPlugin.error({ title: '上架失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '上架失败', content: err?.message || '未知错误' });
    } finally {
      setPublishing(false);
    }
  };

  const followableCount = rows.filter((r) => calc(r).followable).length;

  const columns: PrimaryTableCol<SourcingRow>[] = [
    { colKey: 'siteName', title: '站点', width: 70 },
    { colKey: 'categoryName', title: '分类', width: 130, ellipsis: true },
    { colKey: 'title', title: '商品标题', width: 260, ellipsis: true },
    {
      colKey: 'priceUSD',
      title: '售价USD',
      width: 90,
      cell: ({ row }) => `$${(row.priceUSD || 0).toFixed(2)}`,
    },
    {
      colKey: 'sourcePriceCNY',
      title: '货源价CNY',
      width: 110,
      cell: ({ row }) => (
        <InputNumber
          value={row.sourcePriceCNY}
          min={0}
          step={1}
          theme="column"
          onChange={(v) => updateRow(row.itemId, { sourcePriceCNY: Number(v) || 0 })}
        />
      ),
    },
    {
      colKey: 'shippingCNY',
      title: '头程CNY',
      width: 100,
      cell: ({ row }) => (
        <InputNumber
          value={row.shippingCNY}
          min={0}
          step={1}
          theme="column"
          onChange={(v) => updateRow(row.itemId, { shippingCNY: Number(v) || 0 })}
        />
      ),
    },
    {
      colKey: 'sourceLink',
      title: '货源链接',
      width: 200,
      cell: ({ row }) => (
        <Input
          value={row.sourceLink}
          placeholder="粘贴 1688 链接"
          onChange={(v) => updateRow(row.itemId, { sourceLink: v as string })}
        />
      ),
    },
    {
      colKey: 'profitUSD',
      title: '净利润USD',
      width: 100,
      cell: ({ row }) => {
        const c = calc(row);
        return (
          <span style={{ color: c.profitUSD >= 0 ? '#00A859' : '#E34D59', fontWeight: 600 }}>
            ${c.profitUSD.toFixed(2)}
          </span>
        );
      },
    },
    {
      colKey: 'roi',
      title: 'ROI',
      width: 70,
      cell: ({ row }) => {
        const c = calc(row);
        return <span>{(c.roi * 100).toFixed(0)}%</span>;
      },
    },
    {
      colKey: 'followable',
      title: '可跟卖',
      width: 80,
      cell: ({ row }) => {
        const c = calc(row);
        return c.followable ? (
          <Tag theme="success" variant="light">可跟卖</Tag>
        ) : (
          <Tag theme="danger" variant="light">不可</Tag>
        );
      },
    },
    {
      colKey: 'fullProfit',
      title: '完整净利率',
      width: 110,
      cell: ({ row }) => {
        const fp = fullProfits[row.itemId];
        if (!fp) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        const color = fp.recommendation === 'green' ? '#00A859' : fp.recommendation === 'yellow' ? '#E37318' : '#E34D59';
        const label = fp.recommendation === 'green' ? '绿' : fp.recommendation === 'yellow' ? '黄' : '红';
        return (
          <span title={fp.warnings.join('\n')} style={{ color, fontWeight: 600 }}>
            {(fp.netProfitRate * 100).toFixed(1)}%（{label}）
          </span>
        );
      },
    },
    {
      colKey: 'breakEven',
      title: '保本价',
      width: 90,
      cell: ({ row }) => {
        const fp = fullProfits[row.itemId];
        if (!fp) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        const over = fp.breakEvenPrice > 0 && row.priceUSD < fp.breakEvenPrice;
        return (
          <span style={{ color: over ? '#E34D59' : 'inherit' }}>
            {fp.breakEvenPrice > 0 ? `$${fp.breakEvenPrice.toFixed(2)}` : 'N/A'}
          </span>
        );
      },
    },
    {
      colKey: 'filter',
      title: '筛选',
      width: 100,
      cell: ({ row }) => {
        const fi = filterInfo[row.itemId];
        if (!fi) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        if (fi.passed) return <Tag theme="success" variant="light">通过</Tag>;
        if (fi.needsSourcePrice) return <Tag theme="warning" variant="light" title={fi.reasons.join('\n')}>缺货源价</Tag>;
        return (
          <Tag theme="danger" variant="light" title={fi.reasons.join('\n')}>
            {fi.stage === 'hard' ? '硬性拒绝' : '利润拒绝'}
          </Tag>
        );
      },
    },
    {
      colKey: 'mlTitle',
      title: '我的标题(上架用)',
      width: 240,
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <Input
            value={row.mlTitle || ''}
            placeholder="手工填 或 AI生成"
            onChange={(v) => updateRow(row.itemId, { mlTitle: v as string })}
          />
          <Button size="small" theme="primary" variant="outline" onClick={() => handleGenerateTitle(row)}>
            AI生成
          </Button>
        </div>
      ),
    },
    {
      colKey: 'op',
      title: '操作',
      width: 110,
      cell: ({ row }) => (
        <div className="flex flex-col gap-1">
          <Button
            size="small"
            theme="default"
            variant="outline"
            loading={searching === row.itemId}
            onClick={() => handleAutoSearch(row)}
          >
            API图搜
          </Button>
          <Button size="small" theme="default" variant="outline" onClick={() => openKwSearch(row)}>
            1688找同款
          </Button>
        </div>
      ),
    },
    {
      colKey: 'images',
      title: '配图',
      width: 80,
      cell: ({ row }) => {
        const n = mlPictures[row.itemId]?.length || 0;
        return n > 0 ? (
          <Tag theme="success" variant="light">已配 {n} 张</Tag>
        ) : row.sourceImages?.length ? (
          <Tag theme="warning" variant="light">待配图</Tag>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>
        );
      },
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">货源匹配 &amp; 利润测算（M2）</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--td-text-color-secondary)' }}>
              基于 M1 导出的爆款，填入 1688 货源价即可实时测算净利润 / ROI，标记「可跟卖」清单。
              <span style={{ color: 'var(--td-text-color-placeholder)' }}>合规：只用你自己的标题/图片/定价，不复制竞品销量、评论、原图。</span>
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button theme="primary" onClick={loadLatest} loading={loading}>刷新数据</Button>
            <Button theme="success" onClick={handleFullCalc} loading={fullCalcing}>
              完整测算（含税费/物流/体积重）
            </Button>
            <Button theme="warning" variant="outline" onClick={handleRunFilter} loading={filtering}>
              自动筛选（3层）
            </Button>
            <Button theme="primary" variant="outline" onClick={handleExport} loading={exporting}>
              导出含利润清单
            </Button>
            <Button theme="default" variant="outline" onClick={handleErpExport} loading={erpExporting}>
              妙手素材包
            </Button>
            <Button theme="primary" variant="outline" onClick={handleBatchGenTitles} loading={batchGenLoading}>
              一键生成标题
            </Button>
            <Button theme="default" variant="outline" onClick={handleBatchImages} loading={imgLoading}>
              批量配图
            </Button>
            <Button theme="success" onClick={() => setPublishOpen(true)}>
              一键上架
            </Button>
          </div>
        </div>

        <Card title="测算参数" bordered>
          <div className="flex flex-wrap gap-6 items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span>ML 佣金比例</span>
              <InputNumber
                value={settings.commissionRate}
                min={0}
                max={0.5}
                step={0.01}
                theme="column"
                onChange={(v) => setSettings((s) => ({ ...s, commissionRate: Number(v) || 0 }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>回款手续费比例</span>
              <InputNumber
                value={settings.payoutRate}
                min={0}
                max={0.2}
                step={0.01}
                theme="column"
                onChange={(v) => setSettings((s) => ({ ...s, payoutRate: Number(v) || 0 }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>ROI 阈值（可跟卖）</span>
              <InputNumber
                value={settings.roiThreshold}
                min={0}
                max={2}
                step={0.05}
                theme="column"
                onChange={(v) => setSettings((s) => ({ ...s, roiThreshold: Number(v) || 0 }))}
              />
            </label>
            <div className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
              CNY→USD 汇率：<b>{cnyUsd.toFixed(4)}</b>
              <br />
              共 {rows.length} 个爆款，其中 <b style={{ color: '#00A859' }}>{followableCount}</b> 个可跟卖
            </div>
          </div>
        </Card>

        <Card title="自动上架设置（税务 / 配图）" bordered>
          <div className="flex flex-wrap gap-6 items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span>税务模式（影响利润/筛选/导出）</span>
              <Select value={taxMode} onChange={(v) => setTaxMode(v as string)} style={{ width: 300 }}>
                <Select.Option value="direct_import">跨境自发货直邮（买家为进口商，0%）</Select.Option>
                <Select.Option value="cbt_with_rfc">CBT 跨境店 + 有 RFC（16%）</Select.Option>
                <Select.Option value="cbt_no_rfc">CBT 跨境店 + 无 RFC（36%）</Select.Option>
                <Select.Option value="local_store">墨西哥本土店（10.5%）</Select.Option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>自动配图方式</span>
              <Select value={autoImageMode} onChange={(v) => setAutoImageMode(v as string)} style={{ width: 220 }}>
                <Select.Option value="watermark">1688源图 + 水印(推荐)</Select.Option>
                <Select.Option value="direct">1688源图直传</Select.Option>
                <Select.Option value="off">关闭自动配图</Select.Option>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>水印文字（你的店铺名）</span>
              <Input value={watermarkText} onChange={(v) => setWatermarkText(v as string)} style={{ width: 200 }} />
            </label>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
            配图只用 1688 货源供应商图（你是买家，供应商授权给分销商用），自动加水印做成你自己的图；绝不使用从美客多抓到的竞品图。
          </p>
        </Card>

        <Card title="爆款 → 货源 → 利润" bordered>
          {loading ? (
            <Loading loading={true} text="加载中..." />
          ) : (
            <Table
              data={rows}
              columns={columns}
              rowKey="itemId"
              size="small"
              bordered
              tableLayout="auto"
              maxHeight={560}
              pagination={{ pageSize: 50, showJumper: true }}
            />
          )}
        </Card>

        {/* 合规标题生成对话框 */}
        <Dialog
          header="合规标题生成（不复制竞品，重组为你自己的标题）"
          visible={genOpen}
          onClose={() => setGenOpen(false)}
          footer={false}
          width={560}
        >
          {genLoading ? (
            <Loading loading={true} text="生成中..." />
          ) : (
            <div className="space-y-2">
              <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
                下列标题由竞品要素（品类/规格/材质/颜色）+ 你的卖点词重组而成，相似度越低越安全。点击「采用」填入「我的标题」。
              </p>
              {genTitles.map((t: any, i: number) => (
                <div key={i} className="flex items-start justify-between gap-2 p-2 border rounded">
                  <div>
                    <div className="font-medium">{t.title}</div>
                    <div className="text-xs" style={{ color: t.safe ? '#00A859' : '#E37318' }}>
                      长度 {t.length} · 相似度 {(t.similarity * 100).toFixed(0)}% · {t.safe ? '安全' : '偏像，建议手动改'}
                    </div>
                  </div>
                  <Button size="small" theme="primary" onClick={() => handleAdoptTitle(t.title)}>
                    采用
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Dialog>

        {/* 1688 免密钥找同款对话框 */}
        <Dialog
          header="1688 免密钥找同款（关键词）"
          visible={kwOpen}
          onClose={() => setKwOpen(false)}
          footer={false}
          width={520}
        >
          <div className="space-y-3">
            <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
              免密钥模式用关键词搜索 1688，建议填<b>中文品名</b>（如：保温杯、硅胶手机壳）。西/葡语竞品标题直搜效果较差。质量不如开放平台 API 的以图搜货。
            </p>
            <Input value={kw} placeholder="中文品名，如：保温杯" onChange={(v) => setKw(v as string)} />
            <Button theme="primary" loading={kwLoading} onClick={handleKwRun}>
              搜索并回填货源价
            </Button>
          </div>
        </Dialog>

        {/* 一键上架确认 */}
        <Dialog
          header="一键上架确认"
          visible={publishOpen}
          onClose={() => setPublishOpen(false)}
          onConfirm={handlePublishConfirm}
          confirmBtn={{ content: publishing ? '上架中...' : '确认上架', loading: publishing }}
          width={540}
        >
          <div className="space-y-2 text-sm">
            <p>
              将对<strong>同时具备「我的标题」且「已配图」</strong>的商品一键发布到对应美客多站点；
              后端合规预检会拦截品牌侵权/盗用竞品原图等情况。
            </p>
            <p style={{ color: 'var(--td-text-color-secondary)' }}>
              预计上架{' '}
              <b>
                {rows.filter((r) => (r.mlTitle || '').trim().length >= 5 && (mlPictures[r.itemId]?.length || 0) > 0).length}
              </b>{' '}
              条。
            </p>
            {publishSummary && (
              <p style={{ color: '#00A859', fontWeight: 600 }}>{publishSummary}</p>
            )}
          </div>
        </Dialog>
      </div>
    </div>
  );
}

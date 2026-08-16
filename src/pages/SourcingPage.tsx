import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Tag,
  Table,
  InputNumber,
  Input,
  Select,
  Radio,
  NotificationPlugin,
  Loading,
  Dialog,
  MessagePlugin,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import { FeatureIntro } from '../components/FeatureIntro';

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
  /** AI 生成的商品描述（西语/葡语） */
  mlDescription?: string;
  /** 1688 货源标题（中文，AI 生成标题/描述时参考用） */
  sourceTitle?: string;
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
  const navigate = useNavigate();
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
  const [autoImageMode, setAutoImageMode] = useState<string>('ai'); // ai=AI修图 / watermark=仅水印 / direct=直传 / off=关
  const [watermarkText, setWatermarkText] = useState('TuTienda');
  // AI 图片处理是否可用（rembg 是否已安装）
  const [aiImageAvailable, setAiImageAvailable] = useState<boolean | null>(null);
  // 每张图处理好的美客多公网 URL（按 itemId 存）
  const [mlPictures, setMlPictures] = useState<Record<string, string[]>>({});
  const [batchGenLoading, setBatchGenLoading] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  // 描述生成
  const [descGenLoading, setDescGenLoading] = useState(false);
  // 一键全自动
  const [autoAllLoading, setAutoAllLoading] = useState(false);
  const [autoAllProgress, setAutoAllProgress] = useState<string>('');
  // 多店铺：已添加的店铺列表（含 authorized 标记）
  const [storesList, setStoresList] = useState<{ id: string; nickname: string; site: string; authorized: boolean; enabled: boolean }[]>([]);
  // 发布时选定的目标店铺
  const [selectedStoreId, setSelectedStoreId] = useState<string>('');
  // 一键上架确认
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishSummary, setPublishSummary] = useState<string>('');
  // 当前站点 & ML 热搜词
  const [currentSite, setCurrentSite] = useState<string>('MLM');
  const [trendKeywords, setTrendKeywords] = useState<string[]>([]);
  const [trendsLoading, setTrendsLoading] = useState(false);

  // 1688 搜款方案切换
  const [searchMethod, setSearchMethod] = useState<string>('onebound');
  const [oneboundKey, setOneboundKey] = useState('');
  const [oneboundSecret, setOneboundSecret] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [show1688Config, setShow1688Config] = useState(true);

  // 加载已保存的 1688 搜款配置
  const load1688Config = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/sourcing/1688/config');
      const d = await r.json();
      if (d.success) {
        setSearchMethod(d.method || 'onebound');
        if (d.hasOneboundKey) setOneboundKey('******');
        if (d.hasOneboundSecret) setOneboundSecret('******');
      }
    } catch { /* 用默认值 */ }
  }, []);

  // 保存 1688 搜款配置
  const save1688Config = async () => {
    setSavingConfig(true);
    try {
      const body: any = { method: searchMethod };
      if (searchMethod === 'onebound') {
        if (oneboundKey && oneboundKey !== '******') body.oneboundKey = oneboundKey;
        if (oneboundSecret && oneboundSecret !== '******') body.oneboundSecret = oneboundSecret;
      }
      const r = await fetch('/api/ml/sourcing/1688/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success) {
        MessagePlugin.success({ content: `已切换到「${getMethodLabel(searchMethod)}」方案` });
        // 遮罩处理
        if (body.oneboundKey) setOneboundKey('******');
        if (body.oneboundSecret) setOneboundSecret('******');
      }
    } catch (err: any) {
      MessagePlugin.error({ content: err?.message || '保存失败' });
    } finally {
      setSavingConfig(false);
    }
  };

  const methodLabels: Record<string, string> = {
    onebound: 'OneBound（第三方）',
    search1688api: 'search1688api（开源）',
  };
  const getMethodLabel = (m: string) => methodLabels[m] || m;

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

  // 同步当前站点并加载 ML 热搜词
  const loadTrends = useCallback(async (site: string) => {
    setTrendsLoading(true);
    try {
      const r = await fetch(`/api/ml/trends?site=${encodeURIComponent(site)}&limit=20`);
      const d = await r.json();
      if (d.success) setTrendKeywords(d.keywords || []);
    } catch {
      setTrendKeywords([]);
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRate();
    loadLatest();
    load1688Config();
    // 检查 AI 图片处理是否可用
    fetch('/api/ml/listing/ai-image-status').then(r => r.json()).then(d => {
      setAiImageAvailable(d.available === true);
    }).catch(() => setAiImageAvailable(false));
    // 拉取已添加店铺（多店铺上架用）
    fetch('/api/ml/stores').then(r => r.json()).then(d => {
      const list = Array.isArray(d.stores) ? d.stores : [];
      setStoresList(list);
      // 默认选中第一个「已授权且启用」的店铺
      const firstOk = list.find((s: any) => s.authorized && s.enabled);
      if (firstOk) setSelectedStoreId(firstOk.id);
    }).catch(() => null);
  }, [loadRate, loadLatest, load1688Config]);

  // 当 rows 变化时，同步当前站点并刷新热搜词
  useEffect(() => {
    const site = rows.length > 0 ? rows[0].site : 'MLM';
    setCurrentSite(site);
    loadTrends(site);
  }, [rows, loadTrends]);

  const updateRow = (itemId: string, patch: Partial<SourcingRow>) => {
    setRows((prev) => prev.map((r) => (r.itemId === itemId ? { ...r, ...patch } : r)));
  };

  const handleAutoSearch = async (row: SourcingRow) => {
    setSearching(row.itemId);
    try {
      const body: any = {
        method: searchMethod,
        imageUrl: row.thumbnail || '',
        title: row.title,
      };
      // OneBound：传页面配置的密钥（以页面填写的为准）
      if (searchMethod === 'onebound') {
        if (oneboundKey && oneboundKey !== '******') body.oneboundKey = oneboundKey;
        if (oneboundSecret && oneboundSecret !== '******') body.oneboundSecret = oneboundSecret;
      }
      const r = await fetch('/api/ml/sourcing/1688/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.success && d.available && d.items && d.items.length) {
        const top = d.items[0];
        updateRow(row.itemId, {
          sourcePriceCNY: Number(top.priceCNY) || 0,
          sourceLink: top.url || '',
          supplier: top.supplier || '',
          sourceImages: top.imageUrl ? [top.imageUrl] : [],
          sourceTitle: top.title || '',
        });
        NotificationPlugin.success({ title: `${getMethodLabel(searchMethod)} 搜款完成`, content: `找到 ${d.items.length} 条货源，已填入首条（${top.priceCNY} CNY）` });
      } else {
        NotificationPlugin.warning({ title: `${getMethodLabel(searchMethod)} 搜款不可用`, content: d.message || '未配置密钥或搜索无结果' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '搜款失败', content: err?.message || '未知错误' });
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
        body: JSON.stringify({ competitorTitle: row.title, site: row.site, brand: row.brand, trendKeywords }),
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

  // 合规描述自动生成
  const handleGenerateDescription = async (row: SourcingRow) => {
    if (!row.mlTitle || row.mlTitle.trim().length < 5) {
      MessagePlugin.warning({ content: '请先生成或填写标题（≥5 字）' });
      return;
    }
    setDescGenLoading(true);
    try {
      const r = await fetch('/api/ml/listing/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: row.mlTitle,
          site: row.site,
          sourceTitle: row.sourceTitle,
          sourcePriceCNY: row.sourcePriceCNY,
          categoryName: row.categoryName,
          brand: row.brand,
          trendKeywords,
        }),
      });
      const d = await r.json();
      if (d.success && d.description) {
        updateRow(row.itemId, { mlDescription: d.description });
        MessagePlugin.success({ content: '描述已生成' });
      } else {
        MessagePlugin.warning({ content: d.message || '生成失败' });
      }
    } catch (err: any) {
      MessagePlugin.error({ content: err?.message || '生成失败' });
    } finally {
      setDescGenLoading(false);
    }
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
          sourceTitle: top.title || '',
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
        NotificationPlugin.success({ title: '利润分析表已导出', content: `${d.fileName}（导出 ${d.exported} 条）` });
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
          rows: rows.map((x) => ({ competitorTitle: x.title, site: x.site, brand: x.brand, trendKeywords })),
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

  // 批量配图（合规）：1688 货源图 → AI修图/水印 → 上传美客多，按 itemId 存公网 URL
  const handleBatchImages = async () => {
    const targets = rows.filter((r) => (r.sourceImages || []).length > 0);
    if (targets.length === 0) {
      NotificationPlugin.warning({ title: '无可配图商品', content: '请先对商品做 1688 图搜拿到货源图' });
      return;
    }
    // AI 模式但 rembg 不可用时自动降级到水印
    const effectiveMode = autoImageMode === 'ai' && aiImageAvailable === false ? 'watermark' : autoImageMode;
    if (autoImageMode === 'ai' && aiImageAvailable === false) {
      NotificationPlugin.info({ title: 'AI修图不可用', content: 'rembg 未安装，自动降级为水印模式。可用 pip install rembg 安装' });
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
                mode: effectiveMode,
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
      NotificationPlugin.success({ title: '批量配图完成', content: `${done}/${targets.length} 个商品已生成美客多图（模式: ${effectiveMode === 'ai' ? 'AI修图' : effectiveMode === 'watermark' ? '水印' : '直传'}）` });
    } finally {
      setImgLoading(false);
    }
  };

  // 批量生成描述：对已 有标题 的行调 AI 生成描述
  const handleBatchDescriptions = async () => {
    const targets = rows.filter((r) => (r.mlTitle || '').trim().length >= 5);
    if (targets.length === 0) {
      NotificationPlugin.warning({ title: '无可生成描述的商品', content: '请先生成标题' });
      return;
    }
    setDescGenLoading(true);
    try {
      const r = await fetch('/api/ml/listing/generate-description/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: targets.map((x) => ({
            title: x.mlTitle,
            site: x.site,
            sourceTitle: x.sourceTitle,
            sourcePriceCNY: x.sourcePriceCNY,
            categoryName: x.categoryName,
            brand: x.brand,
            trendKeywords,
          })),
        }),
      });
      const d = await r.json();
      if (d.success && Array.isArray(d.descriptions)) {
        targets.forEach((x, i) => {
          if (d.descriptions[i]) updateRow(x.itemId, { mlDescription: d.descriptions[i] });
        });
        const done = d.descriptions.filter(Boolean).length;
        NotificationPlugin.success({ title: '批量描述已生成', content: `已为 ${done} 条商品生成 AI 描述` });
      } else {
        NotificationPlugin.warning({ title: '生成失败', content: d.message || '未生成' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '生成失败', content: err?.message || '未知错误' });
    } finally {
      setDescGenLoading(false);
    }
  };

  // 一键全自动：对所有有货源图的商品，自动执行 标题→描述→配图
  const handleAutoAll = async () => {
    const targets = rows.filter((r) => (r.sourceImages || []).length > 0 || (r.sourcePriceCNY || 0) > 0);
    if (targets.length === 0) {
      NotificationPlugin.warning({ title: '无符合条件的商品', content: '请先对商品做 1688 搜款' });
      return;
    }
    setAutoAllLoading(true);
    setAutoAllProgress('正在生成标题...');
    try {
      // 1. 批量生成标题（对没有 mlTitle 的行）
      const needTitle = targets.filter((r) => !r.mlTitle || r.mlTitle.trim().length < 5);
      if (needTitle.length > 0) {
        const r = await fetch('/api/ml/listing/generate-title/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: needTitle.map((x) => ({
              competitorTitle: x.title,
              site: x.site,
              sourceTitle: x.sourceTitle,
              sourcePriceCNY: x.sourcePriceCNY,
              brand: x.brand,
              trendKeywords,
            })),
          }),
        });
        const d = await r.json();
        if (d.success && Array.isArray(d.titles)) {
          needTitle.forEach((x, i) => {
            if (d.titles[i]) updateRow(x.itemId, { mlTitle: d.titles[i] });
          });
        }
      }
      setAutoAllProgress('正在生成描述...');

      // 2. 批量生成描述（对有标题但没描述的行）
      const needDesc = targets.filter((r) => r.mlTitle && (!r.mlDescription || r.mlDescription.trim().length < 10));
      if (needDesc.length > 0) {
        const r = await fetch('/api/ml/listing/generate-description/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: needDesc.map((x) => ({
              title: x.mlTitle,
              site: x.site,
              sourceTitle: x.sourceTitle,
              sourcePriceCNY: x.sourcePriceCNY,
              categoryName: x.categoryName,
              brand: x.brand,
              trendKeywords,
            })),
          }),
        });
        const d = await r.json();
        if (d.success && Array.isArray(d.descriptions)) {
          needDesc.forEach((x, i) => {
            if (d.descriptions[i]) updateRow(x.itemId, { mlDescription: d.descriptions[i] });
          });
        }
      }
      setAutoAllProgress('正在处理图片...');

      // 3. 批量配图（对有货源图但没配图的行）
      const effectiveMode = autoImageMode === 'ai' && aiImageAvailable === false ? 'watermark' : autoImageMode;
      const needImg = targets.filter((r) => (r.sourceImages || []).length > 0 && !(mlPictures[r.itemId]?.length > 0));
      if (needImg.length > 0) {
        const newPics: Record<string, string[]> = { ...mlPictures };
        for (const row of needImg) {
          try {
            const r = await fetch('/api/ml/listing/prepare-images', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                site: row.site,
                sourceImages: row.sourceImages,
                mode: effectiveMode,
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
        setMlPictures(newPics);
      }

      setAutoAllProgress('');
      const ready = targets.filter((r) =>
        (r.mlTitle || '').trim().length >= 5 &&
        (r.mlDescription || '').trim().length >= 10 &&
        (mlPictures[r.itemId]?.length || 0) > 0
      ).length;
      NotificationPlugin.success({
        title: '一键全自动完成',
        content: `共处理 ${targets.length} 个商品，${ready} 个已就绪可上架（标题+描述+图片齐全）`,
      });
    } catch (err: any) {
      NotificationPlugin.error({ title: '全自动处理失败', content: err?.message || '未知错误' });
    } finally {
      setAutoAllLoading(false);
      setAutoAllProgress('');
    }
  };

  // 当前选中的目标店铺及站点（多店铺上架用）
  const selectedStore = storesList.find((s) => s.id === selectedStoreId) || null;
  const selectedStoreSite = selectedStore?.site || '';
  const authorizedStores = storesList.filter((s) => s.authorized && s.enabled);

  // 一键上架（用「我的标题」+「描述」+「已配图」构建草稿并批量发布，合规预检在前端/后端双重把关）
  const handlePublishConfirm = async () => {
    setPublishing(true);
    setPublishSummary('');
    try {
      // 多店铺：仅发布到所选店铺站点匹配的商品
      const siteFilter = selectedStoreSite;
      const drafts = rows
        .filter(
          (r) =>
            (r.mlTitle || '').trim().length >= 5 &&
            (mlPictures[r.itemId]?.length || 0) > 0 &&
            (!siteFilter || r.site === siteFilter)
        )
        .map((r) => ({
          site: r.site,
          storeId: selectedStoreId || undefined,
          title: r.mlTitle,
          category_id: r.categoryId || '',
          price: r.priceUSD,
          available_quantity: 10,
          description: (r.mlDescription && r.mlDescription.trim().length >= 10)
            ? r.mlDescription
            : `【${r.mlTitle}】 优选货源，质量保障，欢迎选购。`,
          pictureUrls: mlPictures[r.itemId],
          brand: r.brand && r.brand.toLowerCase() !== 'generic' ? r.brand : 'Generic',
          weight: r.weight || 0.5,
        }));
      if (!selectedStoreId || !selectedStore) {
        NotificationPlugin.warning({ title: '未选择目标店铺', content: '请先在「店铺管理」添加并授权店铺，并在发布弹窗中选择目标店铺' });
        setPublishing(false);
        return;
      }
      if (drafts.length === 0) {
        NotificationPlugin.warning({ title: '无符合条件的商品', content: siteFilter ? `需同时具备「我的标题」「已配图」且站点为 ${siteFilter}` : '需同时具备「我的标题」与「已配图」' });
        setPublishing(false);
        return;
      }
      const r = await fetch('/api/ml/listing/publish-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts, storeId: selectedStoreId, concurrency: 3 }),
      });
      const d = await r.json();
      if (d.success) {
        const parts = [`成功 ${d.succeeded}`, `合规拦截 ${d.blocked}`, `站点不符跳过 ${d.skipped || 0}`, `失败 ${d.failed}`];
        setPublishSummary(`上架到「${selectedStore.nickname}」完成：${parts.join(' / ')}（共 ${d.total}）`);
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
    { colKey: 'siteName', title: '站点', width: 50, align: 'center' },
    { colKey: 'categoryName', title: '分类', width: 80, ellipsis: true },
    {
      colKey: 'title',
      title: '商品标题',
      width: 130,
      ellipsis: true,
      cell: ({ row }) => <span title={row.title}>{row.title}</span>,
    },
    {
      colKey: 'priceUSD',
      title: '售价',
      width: 60,
      align: 'right',
      cell: ({ row }) => `$${(row.priceUSD || 0).toFixed(2)}`,
    },
    {
      colKey: 'sourcePriceCNY',
      title: '货源价',
      width: 70,
      cell: ({ row }) => (
        <InputNumber
          size="small"
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
      title: '头程',
      width: 65,
      cell: ({ row }) => (
        <InputNumber
          size="small"
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
      width: 90,
      cell: ({ row }) => (
        <Input
          value={row.sourceLink}
          placeholder="1688链接"
          onChange={(v) => updateRow(row.itemId, { sourceLink: v as string })}
        />
      ),
    },
    {
      colKey: 'profitUSD',
      title: '净利润',
      width: 70,
      align: 'right',
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
      width: 50,
      align: 'right',
      cell: ({ row }) => {
        const c = calc(row);
        return <span>{(c.roi * 100).toFixed(0)}%</span>;
      },
    },
    {
      colKey: 'followable',
      title: '可跟卖',
      width: 60,
      align: 'center',
      cell: ({ row }) => {
        const c = calc(row);
        return c.followable ? (
          <Tag theme="success" variant="light" size="small">可</Tag>
        ) : (
          <Tag theme="danger" variant="light" size="small">否</Tag>
        );
      },
    },
    {
      colKey: 'fullProfit',
      title: '净利率',
      width: 70,
      align: 'right',
      cell: ({ row }) => {
        const fp = fullProfits[row.itemId];
        if (!fp) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        const color = fp.recommendation === 'green' ? '#00A859' : fp.recommendation === 'yellow' ? '#E37318' : '#E34D59';
        const label = fp.recommendation === 'green' ? '绿' : fp.recommendation === 'yellow' ? '黄' : '红';
        return (
          <span title={fp.warnings.join('\n')} style={{ color, fontWeight: 600 }}>
            {(fp.netProfitRate * 100).toFixed(0)}%{label}
          </span>
        );
      },
    },
    {
      colKey: 'breakEven',
      title: '保本价',
      width: 60,
      align: 'right',
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
      width: 60,
      align: 'center',
      cell: ({ row }) => {
        const fi = filterInfo[row.itemId];
        if (!fi) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>;
        if (fi.passed) return <Tag theme="success" variant="light" size="small">通过</Tag>;
        if (fi.needsSourcePrice) return <Tag theme="warning" variant="light" size="small" title={fi.reasons.join('\n')}>缺价</Tag>;
        return (
          <Tag theme="danger" variant="light" size="small" title={fi.reasons.join('\n')}>
            {fi.stage === 'hard' ? '硬拒' : '利拒'}
          </Tag>
        );
      },
    },
    {
      colKey: 'listingInfo',
      title: '上架信息',
      width: 170,
      cell: ({ row }) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <Input
              value={row.mlTitle || ''}
              placeholder="标题"
              onChange={(v) => updateRow(row.itemId, { mlTitle: v as string })}
              style={{ flex: 1 }}
            />
            <Button size="small" theme="primary" variant="outline" onClick={() => handleGenerateTitle(row)}>AI</Button>
          </div>
          <div className="flex items-center gap-1">
            <Input
              value={row.mlDescription || ''}
              placeholder="描述"
              onChange={(v) => updateRow(row.itemId, { mlDescription: v as string })}
              style={{ flex: 1 }}
            />
            <Button
              size="small"
              theme="primary"
              variant="outline"
              loading={descGenLoading}
              disabled={!(row.mlTitle && row.mlTitle.trim().length >= 5)}
              onClick={() => handleGenerateDescription(row)}
            >
              AI
            </Button>
          </div>
        </div>
      ),
    },
    {
      colKey: 'op',
      title: '操作',
      width: 80,
      cell: ({ row }) => (
        <div className="flex flex-col gap-1">
          <Button
            size="small"
            theme="default"
            variant="outline"
            loading={searching === row.itemId}
            onClick={() => handleAutoSearch(row)}
            title={getMethodLabel(searchMethod)}
          >
            搜款
          </Button>
          <Button size="small" theme="default" variant="outline" onClick={() => openKwSearch(row)}>
            找同款
          </Button>
        </div>
      ),
    },
    {
      colKey: 'images',
      title: '配图',
      width: 55,
      align: 'center',
      cell: ({ row }) => {
        const n = mlPictures[row.itemId]?.length || 0;
        return n > 0 ? (
          <Tag theme="success" variant="light" size="small">{n}张</Tag>
        ) : row.sourceImages?.length ? (
          <Tag theme="warning" variant="light" size="small">待配</Tag>
        ) : (
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>—</span>
        );
      },
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="max-w-7xl mx-auto space-y-4">
        {/* 页头：标题 + 操作按钮 */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h1 className="text-xl font-semibold">货源匹配 &amp; 利润测算（M2）</h1>
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
              利润分析表
            </Button>
            <Button theme="primary" variant="outline" onClick={handleBatchGenTitles} loading={batchGenLoading}>
              一键生成标题
            </Button>
            <Button theme="default" variant="outline" onClick={handleBatchImages} loading={imgLoading}>
              批量配图
            </Button>
            <Button theme="warning" onClick={handleAutoAll} loading={autoAllLoading}>
              {autoAllLoading && autoAllProgress ? autoAllProgress : '一键全自动(标题+描述+配图)'}
            </Button>
            <Button theme="success" onClick={() => setPublishOpen(true)}>
              一键上架
            </Button>
          </div>
        </div>

        {/* 功能说明（默认折叠） */}
        <FeatureIntro title="功能说明与使用步骤" summary="M2 是做什么的、怎么算利润、合规红线" defaultOpen={false}>
          <p>本页（M2）承接「美客多商品抓取（M1）」导出的爆款清单：填入 1688 货源价，系统实时测算 <strong>净利润 / ROI</strong>，自动标记「可跟卖」清单，并可一键生成标题/描述/配图后上架。</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><b>利润测算</b>：综合考虑 ML 佣金、回款手续费、物流（体积重）与税务模式（跨境直邮 0% / CBT 有 RFC 16% / CBT 无 RFC 36% / 本土店 10.5%）。</li>
            <li><b>货源</b>：通过 1688 搜款找同款；配图只用 1688 供货商图并加水印做成你自己的图，<b style={{ color: '#E34D59' }}>绝不使用从美客多抓到的竞品图</b>。</li>
            <li><b>合规</b>：标题/描述/定价均用你自己的内容，不复制竞品销量、评论、原图。</li>
            <li><b>一键上架</b>：需先在「店铺管理」授权卖家 write token 店铺（见下方提示）。</li>
          </ul>
          <p className="pt-1 font-medium" style={{ color: 'var(--td-text-color-primary)' }}>常用操作</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>填好货源价后点「完整测算」得到含税费/物流的净利润与 ROI。</li>
            <li>点「自动筛选（3层）」按 ROI 阈值标记可跟卖清单。</li>
            <li>点「一键全自动」自动生成标题+描述+配图，再「一键上架」发布。</li>
          </ul>
        </FeatureIntro>

        {/* 多店铺授权提示（一键上架需要所选店铺的 write token） */}
        {authorizedStores.length === 0 ? (
          <div className="p-3 rounded flex items-center justify-between gap-3" style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)', border: '1px solid #E37318' }}>
            <div className="text-sm">
              <b style={{ color: '#E37318' }}>⚠️ 尚未授权任何店铺</b>
              <span className="ml-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                「一键上架」需卖家 write token，请先在「店铺管理」中添加并授权店铺（授权一次长期有效）。
              </span>
            </div>
            <Button theme="warning" onClick={() => navigate('/stores')}>
              去店铺管理授权
            </Button>
          </div>
        ) : (
          <div className="p-2 rounded text-sm" style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}>
            ✅ 已授权 {authorizedStores.length} 个店铺，上架时选择目标店铺即可一键发布。
          </div>
        )}

        <Card title={`ML 热搜词 · ${currentSite}`} bordered>
          <div className="flex flex-wrap gap-2 items-center min-h-[32px]">
            {trendsLoading ? (
              <span className="text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>加载中...</span>
            ) : trendKeywords.length === 0 ? (
              <span className="text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>暂无热搜词（生成标题/描述时会自动重试）</span>
            ) : (
              trendKeywords.map((k) => (
                <Tag key={k} theme="primary" variant="light">{k}</Tag>
              ))
            )}
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--td-text-color-secondary)' }}>
            自动生成标题/描述时会参考这些热搜词；若与产品无关则会被 AI 忽略，避免堆砌。
          </p>
        </Card>

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
              <Select value={autoImageMode} onChange={(v) => setAutoImageMode(v as string)} style={{ width: 260 }}>
                <Select.Option value="ai">AI修图(去背景+白底+增强+水印){aiImageAvailable === false ? '（未安装）' : ''}</Select.Option>
                <Select.Option value="watermark">1688源图 + 水印(推荐兜底)</Select.Option>
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

        {/* 1688 搜款方案切换 */}
        <Card
          title={
            <div className="flex items-center gap-2 cursor-pointer select-none" onClick={() => setShow1688Config(!show1688Config)}>
              <span>🔍 1688 搜款方案（{getMethodLabel(searchMethod)}）</span>
              <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>点击{show1688Config ? '收起' : '展开'}</span>
            </div>
          }
          bordered
        >
          {show1688Config && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-4 items-end">
                <label className="flex flex-col gap-1 text-sm">
                  <span>搜款方案</span>
                  <Radio.Group value={searchMethod} onChange={(v) => setSearchMethod(v as string)}>
                    <Radio.Button value="onebound">OneBound（第三方，免费 500次/天）</Radio.Button>
                    <Radio.Button value="search1688api">search1688api（开源，完全免费）</Radio.Button>
                  </Radio.Group>
                </label>
              </div>

              {searchMethod === 'onebound' && (
                <div className="flex flex-wrap gap-4 items-end p-3 rounded" style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>OneBound Key</span>
                    <Input
                      value={oneboundKey}
                      placeholder="注册即得 → console.open.onebound.cn"
                      onChange={(v) => setOneboundKey(v as string)}
                      style={{ width: 260 }}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span>OneBound Secret</span>
                    <Input
                      value={oneboundSecret}
                      type="password"
                      placeholder="注册即得 → console.open.onebound.cn"
                      onChange={(v) => setOneboundSecret(v as string)}
                      style={{ width: 260 }}
                    />
                  </label>
                  <Button theme="primary" loading={savingConfig} onClick={save1688Config}>
                    保存并切换
                  </Button>
                </div>
              )}

              {searchMethod === 'search1688api' && (
                <div className="p-3 rounded" style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}>
                  <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
                    search1688api 是 MIT 开源 Python 库，<b>无需任何密钥</b>，直接调用 1688 网页端搜图接口。
                    需要本机安装 Python 3.9+ 并运行 <code>pip install search1688api</code>。
                    搜索速度较慢（约 5-10 秒），但完全免费。
                  </p>
                  <Button theme="primary" loading={savingConfig} onClick={save1688Config} className="mt-2">
                    确认使用此方案
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap gap-3 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                <span>A: OneBound — 注册即用，500次/天免费，有图搜API</span>
                <span>B: search1688api — 开源免费，需 Python，无次数限制</span>
              </div>
            </div>
          )}
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
              tableLayout="fixed"
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
          width="min(560px, 92vw)"
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
          width="min(520px, 92vw)"
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
          header="一键上架确认（多店铺）"
          visible={publishOpen}
          onClose={() => setPublishOpen(false)}
          onConfirm={handlePublishConfirm}
          confirmBtn={{ content: publishing ? '上架中...' : '确认上架', loading: publishing }}
          width="min(540px, 92vw)"
        >
          <div className="space-y-3 text-sm">
            {/* 目标店铺选择 */}
            <div className="flex flex-col gap-1">
              <span className="text-sm">目标店铺（用自己的 write token 上架）</span>
              {authorizedStores.length === 0 ? (
                <div className="text-sm" style={{ color: '#E37318' }}>
                  暂无已授权店铺，请先到「店铺管理」添加并授权。
                </div>
              ) : (
                <Select
                  value={selectedStoreId}
                  onChange={(v) => setSelectedStoreId(v as string)}
                  options={authorizedStores.map((s) => ({
                    value: s.id,
                    label: `${s.nickname}（${s.site}）`,
                  }))}
                />
              )}
            </div>
            <p>
              将对<strong>同时具备「我的标题」「已配图」且站点与所选店铺一致</strong>的商品一键发布；
              后端合规预检会拦截品牌侵权/盗用竞品原图等情况。
            </p>
            <p style={{ color: 'var(--td-text-color-secondary)' }}>
              预计上架{' '}
              <b>
                {rows.filter(
                  (r) =>
                    (r.mlTitle || '').trim().length >= 5 &&
                    (mlPictures[r.itemId]?.length || 0) > 0 &&
                    (!selectedStoreSite || r.site === selectedStoreSite)
                ).length}
              </b>{' '}
              条（站点 {selectedStoreSite || '未选店铺'}）。
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

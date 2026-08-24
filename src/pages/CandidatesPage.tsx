import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Table,
  Tag,
  Select,
  Loading,
  MessagePlugin,
  Dialog,
  Space,
  Switch,
  Link,
  ImageViewer,
  Input,
  InputNumber,
  Textarea,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';

interface Candidate {
  id: number;
  site: string;
  ml_item_id: string;
  ml_title: string;
  ml_price_usd: number;
  ml_thumbnail: string;
  ml_permalink: string;
  ml_category_id?: string;
  ml_category_name?: string;
  ali1688_title?: string;
  ali1688_price_cny: number;
  ali1688_url: string;
  ali1688_image_url: string;
  ali1688_supplier?: string;
  source_title?: string;
  listing_price_usd: number;
  profit_net_usd: number;
  profit_rate: number;
  roi: number;
  cost_breakdown_json?: string;
  score_total: number;
  score_demand: number;
  score_competition: number;
  score_profit: number;
  score_logistics: number;
  score_compliance: number;
  ai_evaluation_json?: string;
  status: 'pending' | 'approved' | 'rejected' | 'published';
  reject_reason: string;
  weight_kg: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  created_at: string;
}

interface Store {
  id: string;
  nickname: string;
  site: string;
  authorized: boolean;
  enabled: boolean;
}

interface PublishDraft {
  title: string;
  description: string;
  pictureUrls: string[];
  /** 默认售价（无逐国家覆盖时回退使用） */
  listingPriceUsd: number;
  /** 逐国家/站点独立售价（USD） */
  priceBySite: Record<string, number>;
  /** 逐国家/站点独立刊登类型 */
  listingTypeBySite: Record<string, string>;
  availableQuantity: number;
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  brand: string;
  model: string;
  warrantyType: string;
  warrantyTime: string;
  /** 全局默认 listingType（已被 listingTypeBySite 取代，保留兼容） */
  listingType: string;
  skuTitle: string;
  skuImageUrl: string;
  /** 类目属性值：{ [attributeId]: { value_id|value_name|values } } */
  attributeValues: Record<string, any>;
}

interface CategoryAttribute {
  id: string;
  name: string;
  required: boolean;
  value_type: string;
  values?: Array<{ id: string; name: string }>;
  hint?: string;
}

interface SiteInfo {
  name: string;
  currency: string;
}

function parseAiEvaluation(raw: string | undefined | null): { pass: boolean; score: number; reason: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      pass: !!parsed.pass,
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      reason: String(parsed.reason || ''),
    };
  } catch {
    return null;
  }
}

interface SourcingRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at?: string;
  total_scanned: number;
  total_matched: number;
  total_scored: number;
  total_approved: number;
  total_rejected: number;
  message?: string;
  error?: string;
}

const runStatusMap: Record<string, { label: string; theme: any }> = {
  running: { label: '进行中', theme: 'warning' },
  done: { label: '已完成', theme: 'success' },
  failed: { label: '失败', theme: 'danger' },
};

const statusMap: Record<string, { label: string; theme: any }> = {
  pending: { label: '待审核', theme: 'warning' },
  approved: { label: '已通过', theme: 'success' },
  rejected: { label: '已拒绝', theme: 'danger' },
  published: { label: '已上架', theme: 'primary' },
};

export function CandidatesPage() {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishRow, setPublishRow] = useState<Candidate | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [useCbtCategory, setUseCbtCategory] = useState(true);
  const [akStatus, setAkStatus] = useState<{ configured?: boolean; message?: string }>({});
  const [latestRun, setLatestRun] = useState<SourcingRun | null>(null);
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  const [elapsedText, setElapsedText] = useState('');
  const [runPollError, setRunPollError] = useState<string | null>(null);

  // YouTube 上传配置（仅保留授权状态；具体配置在「配置中心」）
  const [ytConfigured, setYtConfigured] = useState(false);
  // 上架时是否上传 YouTube 视频（填本地视频文件绝对路径）
  const [uploadYoutube, setUploadYoutube] = useState(false);
  const [youtubeVideoPath, setYoutubeVideoPath] = useState('');

  // 图片大图预览
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerImages, setViewerImages] = useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);

  // 上架预览编辑态
  const [publishDraft, setPublishDraft] = useState<PublishDraft | null>(null);
  const [targetSites, setTargetSites] = useState<string[]>([]);
  const [siteInfos, setSiteInfos] = useState<Record<string, SiteInfo>>({});
  const [profitBySite, setProfitBySite] = useState<Record<string, any>>({});
  const [profitLoading, setProfitLoading] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [categoryAttributes, setCategoryAttributes] = useState<CategoryAttribute[]>([]);
  const [categoryAttrLoading, setCategoryAttrLoading] = useState(false);

  const fetchAkStatus = async () => {
    try {
      const res = await fetch('/api/ml/ali1688/config');
      const data = await res.json();
      setAkStatus({ configured: data?.configured, message: data?.message || '' });
    } catch {
      setAkStatus({ configured: false, message: '无法检测 AK 状态' });
    }
  };

  const fetchYouTubeStatus = async () => {
    try {
      const res = await fetch('/api/ml/youtube/status');
      const data = await res.json();
      setYtConfigured(!!data?.configured);
    } catch {
      setYtConfigured(false);
    }
  };

  const fetchSiteInfos = async () => {
    try {
      const res = await fetch('/api/ml/sites');
      const data = await res.json();
      if (Array.isArray(data.sites)) {
        const map: Record<string, SiteInfo> = {};
        data.sites.forEach((s: any) => {
          map[s.code] = { name: s.name, currency: s.currency };
        });
        setSiteInfos(map);
      }
    } catch {
      /* ignore */
    }
  };

  const fetchLatestRun = async () => {
    try {
      // 强制绕过浏览器/代理缓存，避免轮询拿到旧状态
      const res = await fetch(`/api/ml/sourcing/runs/latest?_t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      });
      const data = await res.json();
      if (data.success) {
        setLatestRun(data.run);
        setRunPollError(null);
      }
    } catch (e: any) {
      setRunPollError(`轮询状态失败: ${e?.message || '网络错误'}`);
    }
  };

  useEffect(() => {
    fetchRows();
    fetchStores();
    fetchAkStatus();
    fetchYouTubeStatus();
    fetchLatestRun();
    fetchSiteInfos();
    const timer = setInterval(() => {
      fetchLatestRun();
    }, 3000);
    return () => clearInterval(timer);
    // 轮询不应依赖 status；status 只是表格筛选条件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!latestRun || latestRun.status !== 'running') {
      setElapsedText('');
      return;
    }
    const start = runStartTime || new Date(latestRun.started_at).getTime() || Date.now();
    const pad = (n: number) => String(n).padStart(2, '0');
    const update = () => {
      const sec = Math.floor((Date.now() - start) / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const h = Math.floor(m / 60);
      setElapsedText(h > 0 ? `${pad(h)}:${pad(m % 60)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [latestRun, runStartTime]);

  const fetchRows = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ml/candidates?status=${status}&limit=100`);
      const data = await res.json();
      if (data.success) {
        setRows(dedupCandidates(data.rows || []));
      } else {
        MessagePlugin.error(data.message || '获取候选列表失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setLoading(false);
    }
  };

  const fetchStores = async () => {
    try {
      const res = await fetch('/api/ml/stores');
      const data = await res.json();
      if (data.success) {
        setStores(data.stores || []);
      }
    } catch {
      /* ignore */
    }
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/ml/sourcing/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxCandidatesToSource: 30, targetNetRate: 0.15 }),
      });
      const data = await res.json();
      if (data.success && data.runId) {
        MessagePlugin.success('选品流水线已启动');
        const now = Date.now();
        setRunStartTime(now);
        setElapsedText('00:00');
        setRunPollError(null);
        // 立即显示一个本地运行状态，避免轮询空窗期
        setLatestRun({
          id: data.runId,
          status: 'running',
          started_at: new Date().toISOString(),
          total_scanned: 0,
          total_matched: 0,
          total_scored: 0,
          total_approved: 0,
          total_rejected: 0,
          message: '正在初始化...',
        } as SourcingRun);
        fetchLatestRun();
      } else {
        MessagePlugin.error(data.message || '启动失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setRunning(false);
    }
  };

  const handleApprove = async (id: number) => {
    try {
      const res = await fetch(`/api/ml/candidates/${id}/approve`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('已通过');
        fetchRows();
      } else {
        MessagePlugin.error(data.message);
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message);
    }
  };

  const handleReject = async (id: number) => {
    try {
      const res = await fetch(`/api/ml/candidates/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '人工审核不通过' }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('已拒绝');
        fetchRows();
      } else {
        MessagePlugin.error(data.message);
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message);
    }
  };

  const deduceTargetSites = (storeIds: string[], candidateSite: string): string[] => {
    const selected = storeIds.map((id) => stores.find((s) => s.id === id)).filter(Boolean) as Store[];
    const hasCbt = selected.some((s) => s.site === 'CBT');
    const localSites = selected.filter((s) => s.site !== 'CBT').map((s) => s.site);
    const unique = Array.from(new Set(hasCbt ? [...localSites, 'MCO', 'MLM', 'MLB', 'MLC'] : localSites));
    return unique.length > 0 ? unique : [candidateSite];
  };

  const openPublish = (row: Candidate) => {
    setPublishRow(row);
    const initialStoreIds = stores.filter((s) => s.enabled && s.authorized).map((s) => s.id);
    setSelectedStoreIds(initialStoreIds);
    const initialSites = deduceTargetSites(initialStoreIds, row.site);
    setTargetSites(initialSites);
    const imgs = extractImageUrls(row);
    const basePrice = row.listing_price_usd || row.ml_price_usd || 0;
    const initialPriceBySite: Record<string, number> = {};
    const initialListingTypeBySite: Record<string, string> = {};
    for (const site of initialSites) {
      initialPriceBySite[site] = basePrice;
      initialListingTypeBySite[site] = 'bronze';
    }
    setPublishDraft({
      title: row.ml_title || row.ali1688_title || '',
      description: buildDefaultDescription(row, row.ml_title || row.ali1688_title || ''),
      pictureUrls: imgs,
      listingPriceUsd: basePrice,
      priceBySite: initialPriceBySite,
      listingTypeBySite: initialListingTypeBySite,
      availableQuantity: 50,
      weightKg: row.weight_kg || 0,
      lengthCm: row.length_cm || 0,
      widthCm: row.width_cm || 0,
      heightCm: row.height_cm || 0,
      brand: 'Generic',
      model: '',
      warrantyType: '',
      warrantyTime: '',
      listingType: 'bronze',
      skuTitle: '',
      skuImageUrl: '',
      attributeValues: {},
    });
    setProfitBySite({});
    setUploadYoutube(false);
    setYoutubeVideoPath('');
    setCategoryAttributes([]);
    setCategoryAttrLoading(false);
    setPublishOpen(true);
    // 拉取类目属性
    if (row.ml_category_id) {
      fetchCategoryAttributes(row.ml_category_id);
    }
  };

  const fetchCategoryAttributes = async (categoryId: string) => {
    setCategoryAttrLoading(true);
    try {
      const res = await fetch(`/api/ml/category/${categoryId}/attributes`);
      const data = await res.json();
      if (data.attributes && Array.isArray(data.attributes)) {
        setCategoryAttributes(data.attributes);
        // 自动为必填属性填充已知值
        setPublishDraft((prev) => {
          if (!prev) return prev;
          const values = { ...prev.attributeValues };
          for (const attr of data.attributes) {
            if (values[attr.id]) continue;
            if (attr.id === 'BRAND' && prev.brand) {
              values[attr.id] = { value_name: prev.brand };
            } else if (attr.id === 'MODEL' && prev.model) {
              values[attr.id] = { value_name: prev.model };
            } else if (attr.id === 'ITEM_CONDITION') {
              values[attr.id] = { value_id: '2230284', value_name: 'New' };
            }
          }
          return { ...prev, attributeValues: values };
        });
      }
    } catch (e: any) {
      console.warn('拉取类目属性失败', e);
    } finally {
      setCategoryAttrLoading(false);
    }
  };

  // 店铺选择变化时同步目标国家
  useEffect(() => {
    if (publishRow) {
      setTargetSites(deduceTargetSites(selectedStoreIds, publishRow.site));
    }
  }, [selectedStoreIds, publishRow]);

  const handleGenerateTitle = async () => {
    if (!publishRow || !publishDraft) return;
    try {
      const res = await fetch('/api/ml/listing/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          competitorTitle: publishRow.ml_title,
          site: publishRow.site,
          sourceTitle: publishRow.ali1688_title,
          sourcePriceCNY: publishRow.ali1688_price_cny,
          brand: publishDraft.brand,
          count: 3,
        }),
      });
      const data = await res.json();
      if (data.success && data.titles?.length) {
        const t = data.titles.find((x: any) => x.safe)?.title || data.titles[0]?.title;
        if (t) setPublishDraft((prev) => (prev ? { ...prev, title: t } : prev));
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '标题生成失败');
    }
  };

  const handleGenerateDescription = async () => {
    if (!publishRow || !publishDraft) return;
    try {
      const res = await fetch('/api/ml/listing/generate-description', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: publishDraft.title,
          site: publishRow.site,
          sourceTitle: publishRow.ali1688_title,
          sourcePriceCNY: publishRow.ali1688_price_cny,
          categoryName: publishRow.ml_category_name,
          brand: publishDraft.brand,
        }),
      });
      const data = await res.json();
      if (data.success && data.description) {
        setPublishDraft((prev) => (prev ? { ...prev, description: data.description } : prev));
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '描述生成失败');
    }
  };

  // 当预览字段变化时，重新测算各国净利润（使用逐国家独立售价）
  useEffect(() => {
    if (!publishDraft || !publishRow || targetSites.length === 0) return;
    let cancelled = false;
    const calc = async () => {
      setProfitLoading(true);
      const inputs = targetSites.map((site) => ({
        site,
        listingPriceUsd: publishDraft.priceBySite[site] ?? publishDraft.listingPriceUsd,
        purchaseCostCny: publishRow.ali1688_price_cny || 0,
        weightKg: publishDraft.weightKg || undefined,
        lengthCm: publishDraft.lengthCm || undefined,
        widthCm: publishDraft.widthCm || undefined,
        heightCm: publishDraft.heightCm || undefined,
        taxMode: 'direct_import',
        adAcosRate: 0.05,
      }));
      try {
        const res = await fetch('/api/ml/profit/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs }),
        });
        const data = await res.json();
        if (!cancelled && data.success) {
          const map: Record<string, any> = {};
          (data.results || []).forEach((r: any) => {
            map[r.site] = r;
          });
          setProfitBySite(map);
        }
      } catch (e: any) {
        console.warn('利润测算失败', e);
      } finally {
        if (!cancelled) setProfitLoading(false);
      }
    };
    calc();
    return () => {
      cancelled = true;
    };
  }, [publishDraft, publishRow, targetSites]);

  const handlePublish = async () => {
    if (!publishRow || !publishDraft) return;
    if (selectedStoreIds.length === 0) {
      MessagePlugin.warning('请至少选择一个店铺');
      return;
    }
    setPublishing(true);
    try {
      const pictureUrls = [...publishDraft.pictureUrls];
      if (publishDraft.skuImageUrl.trim().startsWith('http') && !pictureUrls.includes(publishDraft.skuImageUrl.trim())) {
        pictureUrls.push(publishDraft.skuImageUrl.trim());
      }
      const draftPayload = {
        title: publishDraft.title,
        description: publishDraft.description,
        pictureUrls,
        listingPriceUsd: publishDraft.listingPriceUsd,
        priceBySite: publishDraft.priceBySite,
        listingTypeBySite: publishDraft.listingTypeBySite,
        availableQuantity: publishDraft.availableQuantity,
        weightKg: publishDraft.weightKg,
        lengthCm: publishDraft.lengthCm,
        widthCm: publishDraft.widthCm,
        heightCm: publishDraft.heightCm,
        brand: publishDraft.brand,
        model: publishDraft.model || publishDraft.skuTitle,
        warrantyType: publishDraft.warrantyType,
        warrantyTime: publishDraft.warrantyTime,
        listingType: publishDraft.listingType,
        attributeValues: publishDraft.attributeValues,
      };
      const res = await fetch(`/api/ml/candidates/${publishRow.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeIds: selectedStoreIds,
          useCbtCategory,
          draft: draftPayload,
          youtube: uploadYoutube
            ? { enabled: true, videoPath: youtubeVideoPath.trim(), privacy: 'unlisted' }
            : { enabled: false },
        }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success(`上架完成：成功 ${data.result.succeeded} 个，失败 ${data.result.failed} 个`);
        setPublishOpen(false);
        fetchRows();
      } else {
        MessagePlugin.error(data.message || '上架失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setPublishing(false);
    }
  };

  // 按 ml_item_id 保留最新一条，避免多次扫描导致同一商品重复展示
  const dedupCandidates = (list: Candidate[]): Candidate[] => {
    const map = new Map<string, Candidate>();
    for (const row of list) {
      const key = `${row.site}|${row.ml_item_id}`;
      const existing = map.get(key);
      if (!existing || row.id > existing.id) {
        map.set(key, row);
      }
    }
    return Array.from(map.values());
  };

  // 生成默认商品描述（西/葡语模板）
  const buildDefaultDescription = (row: Candidate, title: string): string => {
    const lines = [title, '', 'Condición: Nuevo', 'Disponible para envío cross-border.'];
    if (row.weight_kg) lines.push(`Peso aproximado: ${(row.weight_kg * 1000).toFixed(0)} g.`);
    if (row.length_cm || row.width_cm || row.height_cm) {
      lines.push(`Dimensiones aproximadas: ${[row.height_cm, row.width_cm, row.length_cm].filter(Boolean).join(' x ')} cm.`);
    }
    lines.push('', 'Garantía de satisfacción. Consulta por disponibilidad de colores y modelos.');
    return lines.join('\n');
  };

  // 从候选行提取所有可用图片 URL（支持逗号/分号/空格分隔的多图），去重后返回
  const extractImageUrls = (row: Candidate): string[] => {
    const parts = [row.ali1688_image_url, row.ml_thumbnail]
      .filter(Boolean)
      .flatMap((s) => String(s).split(/[,; ]+/))
      .map((s) => s.trim())
      .filter((s) => s.startsWith('http'));
    return Array.from(new Set(parts));
  };

  const FALLBACK_IMAGE =
    'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%23f3f4f6%22/><text x=%2250%22 y=%2255%22 font-size=%2212%22 fill=%22%239ca3af%22 text-anchor=%22middle%22>无图</text></svg>';

  const columns: PrimaryTableCol<Candidate>[] = [
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 110,
      cell: ({ row }) => {
        const urls = extractImageUrls(row);
        const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
          const img = e.currentTarget;
          img.onerror = null;
          img.src = FALLBACK_IMAGE;
        };
        if (urls.length === 0) {
          return (
            <div className="w-16 h-16 rounded bg-gray-100 flex items-center justify-center text-xs text-gray-400 border border-gray-100">
              无图
            </div>
          );
        }
        return (
          <div className="grid grid-cols-2 gap-1 w-[76px]">
            {urls.slice(0, 4).map((src, idx) => (
              <img
                key={`${src}-${idx}`}
                src={src}
                alt=""
                className="w-9 h-9 object-cover rounded border border-gray-100 cursor-pointer hover:opacity-80"
                onError={handleError}
                onClick={() => {
                  setViewerImages(urls);
                  setViewerIndex(idx);
                  setViewerVisible(true);
                }}
              />
            ))}
          </div>
        );
      },
    },
    {
      colKey: 'ml_title',
      title: '标题',
      ellipsis: true,
      cell: ({ row }) => {
        const title = row.ml_title || row.ali1688_title || '';
        const isFallback = !row.ml_title && !!row.ali1688_title;
        return (
          <a href={row.ml_permalink} target="_blank" rel="noreferrer" className="hover:underline block">
            <span className={isFallback ? 'text-orange-600' : ''}>{title}</span>
            {isFallback && <span className="text-xs text-gray-400 ml-1">(来自1688)</span>}
          </a>
        );
      },
    },
    { colKey: 'site', title: '站点', width: 80 },
    {
      colKey: 'ml_category_name',
      title: '类目',
      width: 180,
      ellipsis: true,
      cell: ({ row }) => <span className="text-xs text-gray-600">{row.ml_category_name || '-'}</span>,
    },
    {
      colKey: 'ml_price_usd',
      title: '竞品售价',
      width: 100,
      cell: ({ row }) => `$${row.ml_price_usd?.toFixed(2) || '--'}`,
    },
    {
      colKey: 'ali1688_price_cny',
      title: '1688价',
      width: 100,
      cell: ({ row }) => (
        row.ali1688_url ? (
          <a href={row.ali1688_url} target="_blank" rel="noreferrer" className="hover:underline">
            ¥{row.ali1688_price_cny?.toFixed(2) || '--'}
          </a>
        ) : `¥${row.ali1688_price_cny?.toFixed(2) || '--'}`
      ),
    },
    {
      colKey: 'listing_price_usd',
      title: '建议售价',
      width: 100,
      cell: ({ row }) => `$${row.listing_price_usd?.toFixed(2) || '--'}`,
    },
    {
      colKey: 'profit_net_usd',
      title: '净利润',
      width: 100,
      cell: ({ row }) => `$${row.profit_net_usd?.toFixed(2) || '--'} (${((row.profit_rate || 0) * 100).toFixed(0)}%)`,
    },
    {
      colKey: 'score_total',
      title: '评分',
      width: 80,
      cell: ({ row }) => (
        <Tag theme={row.score_total >= 0.7 ? 'success' : row.score_total >= 0.6 ? 'warning' : 'danger'}>
          {row.score_total?.toFixed(2)}
        </Tag>
      ),
    },
    {
      colKey: 'ai_evaluation_json',
      title: 'AI 研判',
      width: 120,
      cell: ({ row }) => {
        const ev = parseAiEvaluation(row.ai_evaluation_json);
        if (!ev) return <span className="text-gray-400">-</span>;
        return (
          <div className="text-xs">
            <Tag theme={ev.pass ? 'success' : 'danger'} size="small">
              {ev.pass ? '通过' : '不通过'}
            </Tag>
            {ev.score > 0 && <span className="ml-1 text-gray-500">{ev.score.toFixed(2)}</span>}
            {ev.reason && <div className="mt-1 text-gray-500 truncate max-w-[200px]" title={ev.reason}>{ev.reason}</div>}
          </div>
        );
      },
    },
    {
      colKey: 'status',
      title: '状态',
      width: 90,
      cell: ({ row }) => {
        const s = statusMap[row.status] || { label: row.status, theme: 'default' };
        const title = row.status === 'rejected' && row.reject_reason ? row.reject_reason : undefined;
        return <Tag theme={s.theme} title={title}>{s.label}</Tag>;
      },
    },
    {
      colKey: 'reject_reason',
      title: '淘汰原因',
      width: 150,
      ellipsis: true,
      cell: ({ row }) => {
        if (row.status !== 'rejected' || !row.reject_reason) return <span className="text-gray-300">-</span>;
        return (
          <span className="text-xs text-gray-500 truncate max-w-[140px] inline-block" title={row.reject_reason}>
            {row.reject_reason}
          </span>
        );
      },
    },
    {
      colKey: 'action',
      title: '操作',
      width: 220,
      cell: ({ row }) => (
        <Space>
          {row.status === 'pending' && (
            <>
              <Button size="small" theme="primary" onClick={() => handleApprove(row.id)}>
                通过
              </Button>
              <Button size="small" theme="danger" variant="outline" onClick={() => handleReject(row.id)}>
                拒绝
              </Button>
            </>
          )}
          {(row.status === 'approved' || row.status === 'pending') && (
            <Button size="small" theme="success" onClick={() => openPublish(row)}>
              上架
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const renderRunStatus = () => {
    if (!latestRun) {
      return <div className="text-sm text-gray-500">暂无运行记录，点击「立即扫描选品」开始</div>;
    }
    const s = runStatusMap[latestRun.status] || { label: latestRun.status, theme: 'default' };
    const elapsedSec = elapsedText
      ? Math.floor(
          (Date.now() -
            (runStartTime || new Date(latestRun.started_at).getTime() || Date.now())) /
            1000
        )
      : 0;
    const isStuck = latestRun.status === 'running' && elapsedSec > 120;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Tag theme={s.theme}>{s.label}</Tag>
          <span className="text-sm text-gray-600">{latestRun.message || ''}</span>
          {latestRun.status === 'running' && <Loading size="small" loading />}
          {elapsedText && (
            <span className="text-xs text-gray-500">已运行 {elapsedText}</span>
          )}
          {isStuck && (
            <span className="text-xs text-orange-600 bg-orange-50 px-2 py-0.5 rounded">
              运行时间较长，可能卡在 ML/1688 网络请求，请检查服务器日志
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <div>
            <div className="text-gray-500">扫描商品</div>
            <div className="font-medium">{latestRun.total_scanned || 0}</div>
          </div>
          <div>
            <div className="text-gray-500">进入匹配</div>
            <div className="font-medium">{latestRun.total_matched || 0}</div>
          </div>
          <div>
            <div className="text-gray-500">已核价</div>
            <div className="font-medium">{latestRun.total_scored || 0}</div>
          </div>
          <div>
            <div className="text-gray-500">入库通过</div>
            <div className="font-medium text-green-600">{latestRun.total_approved || 0}</div>
          </div>
          <div>
            <div className="text-gray-500"> rejected</div>
            <div className="font-medium text-red-600">{latestRun.total_rejected || 0}</div>
          </div>
        </div>
        {runPollError && (
          <div className="text-xs text-red-600 bg-red-50 p-2 rounded">{runPollError}</div>
        )}
        {latestRun.error && (
          <div className="text-xs text-red-600 bg-red-50 p-2 rounded">{latestRun.error}</div>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 h-full overflow-auto">
      <Card title="运行状态" headerBordered className="mb-4">
        {renderRunStatus()}
      </Card>

      <Card title="AI 选品候选列表" headerBordered>
        <div className="flex items-center justify-between mb-4">
          <Space>
            <Button theme="primary" loading={running} onClick={handleRun}>
              立即扫描选品
            </Button>
            <Button variant="outline" onClick={fetchRows}>
              刷新
            </Button>
            <Link
              href="#/config"
              theme="primary"
              size="small"
              suffixIcon={akStatus.configured ? undefined : undefined}
            >
              {akStatus.configured ? '1688 AK 已配置' : '配置 1688 AK'}
            </Link>
            <Link href="#/config" theme="primary" size="small">
              {ytConfigured ? 'YouTube 已授权' : '配置 YouTube'}
            </Link>
          </Space>
          <Select
            value={status}
            onChange={(v) => setStatus(v as string)}
            options={[
              { label: '全部', value: '' },
              { label: '待审核', value: 'pending' },
              { label: '已通过', value: 'approved' },
              { label: '已拒绝', value: 'rejected' },
              { label: '已上架', value: 'published' },
            ]}
            style={{ width: 140 }}
          />
        </div>

        <Loading loading={loading} size="small">
          <Table
            data={rows}
            columns={columns}
            rowKey="id"
            bordered
            hover
            stripe
            pagination={{
              defaultCurrent: 1,
              defaultPageSize: 20,
              total: rows.length,
            }}
          />
        </Loading>

        <ImageViewer
          images={viewerImages}
          visible={viewerVisible}
          defaultIndex={viewerIndex}
          onClose={() => setViewerVisible(false)}
        />
      </Card>

      <Dialog
        visible={publishOpen}
        onClose={() => setPublishOpen(false)}
        header="商品详情预览"
        width={720}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              取消
            </Button>
            <Button theme="success" loading={publishing} onClick={handlePublish}>
              确认上架
            </Button>
          </div>
        }
      >
        {publishRow && publishDraft && (
          <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
            {/* 标题 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">商品标题</span>
                <Button size="small" variant="text" theme="primary" onClick={handleGenerateTitle}>
                  生成标题
                </Button>
              </div>
              <Input
                value={publishDraft.title}
                onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, title: String(v) } : prev))}
                placeholder="西/葡语标题"
              />
            </div>

            {/* 类目与站点 */}
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-gray-500">站点：</span>
                <Tag size="small">{publishRow.site}</Tag>
              </div>
              <div>
                <span className="text-gray-500">类目：</span>
                <span>{publishRow.ml_category_name || '-'}</span>
              </div>
              <div>
                <span className="text-gray-500">竞品售价：</span>
                <span className="text-blue-600 font-medium">${publishRow.ml_price_usd?.toFixed(2)}</span>
              </div>
            </div>

            {/* 默认售价 & 库存 */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-1">默认售价（USD，未单独设置国家使用）</div>
                <InputNumber
                  value={publishDraft.listingPriceUsd}
                  onChange={(v) =>
                    setPublishDraft((prev) => {
                      if (!prev) return prev;
                      const price = Number(v) || 0;
                      // 同步更新尚未单独设置的国家
                      const priceBySite = { ...prev.priceBySite };
                      for (const site of targetSites) {
                        if (priceBySite[site] == null) priceBySite[site] = price;
                      }
                      return { ...prev, listingPriceUsd: price, priceBySite };
                    })
                  }
                  decimalPlaces={2}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">库存</div>
                <InputNumber
                  value={publishDraft.availableQuantity}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, availableQuantity: Number(v) || 0 } : prev))}
                  min={1}
                />
              </div>
            </div>

            {/* 商品图片 */}
            <div>
              <div className="text-sm font-medium mb-2">商品图片</div>
              <div className="flex flex-wrap gap-2 mb-2">
                {publishDraft.pictureUrls.map((url, idx) => (
                  <div key={`${url}-${idx}`} className="relative w-16 h-16 border rounded overflow-hidden group">
                    <img
                      src={url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src = FALLBACK_IMAGE;
                      }}
                      onClick={() => {
                        setViewerImages(publishDraft.pictureUrls);
                        setViewerIndex(idx);
                        setViewerVisible(true);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setPublishDraft((prev) =>
                          prev ? { ...prev, pictureUrls: prev.pictureUrls.filter((_, i) => i !== idx) } : prev
                        )
                      }
                      className="absolute top-0 right-0 bg-red-500 text-white text-xs px-1 rounded-bl"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={newImageUrl}
                  onChange={(v) => setNewImageUrl(String(v))}
                  placeholder="https://...（添加更多图片 URL）"
                  className="flex-1"
                />
                <Button
                  size="small"
                  onClick={() => {
                    const url = newImageUrl.trim();
                    if (!url.startsWith('http')) {
                      MessagePlugin.warning('请输入有效的 http(s) 图片地址');
                      return;
                    }
                    setPublishDraft((prev) =>
                      prev ? { ...prev, pictureUrls: Array.from(new Set([...prev.pictureUrls, url])) } : prev
                    );
                    setNewImageUrl('');
                  }}
                >
                  添加
                </Button>
              </div>
            </div>

            {/* SKU */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-1">SKU 标题（型号）</div>
                <Input
                  value={publishDraft.skuTitle}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, skuTitle: String(v) } : prev))}
                  placeholder="如未填写，将使用商品标题"
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">SKU 图片 URL</div>
                <Input
                  value={publishDraft.skuImageUrl}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, skuImageUrl: String(v) } : prev))}
                  placeholder="https://..."
                />
              </div>
            </div>

            {/* 重量尺寸 */}
            <div className="grid grid-cols-4 gap-3">
              <div>
                <div className="text-sm font-medium mb-1">重量（kg）</div>
                <InputNumber
                  value={publishDraft.weightKg}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, weightKg: Number(v) || 0 } : prev))}
                  decimalPlaces={3}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">长（cm）</div>
                <InputNumber
                  value={publishDraft.lengthCm}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, lengthCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">宽（cm）</div>
                <InputNumber
                  value={publishDraft.widthCm}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, widthCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">高（cm）</div>
                <InputNumber
                  value={publishDraft.heightCm}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, heightCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
            </div>

            {/* 品牌/型号/保修/刊登类型 */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-1">品牌</div>
                <Input
                  value={publishDraft.brand}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, brand: String(v) } : prev))}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">型号（Model）</div>
                <Input
                  value={publishDraft.model}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, model: String(v) } : prev))}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">质保类型</div>
                <select
                  value={publishDraft.warrantyType}
                  onChange={(e) => setPublishDraft((prev) => (prev ? { ...prev, warrantyType: e.target.value } : prev))}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                >
                  <option value="">无</option>
                  <option value="Factory warranty">Factory warranty</option>
                  <option value="Seller warranty">Seller warranty</option>
                  <option value="No warranty">No warranty</option>
                </select>
              </div>
              <div>
                <div className="text-sm font-medium mb-1">质保时间</div>
                <Input
                  value={publishDraft.warrantyTime}
                  onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, warrantyTime: String(v) } : prev))}
                  placeholder="如 90 days / 1 year"
                />
              </div>
            </div>

            {/* 类目属性 */}
            {categoryAttributes.length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">
                  类目属性
                  {categoryAttrLoading && <span className="ml-2 text-xs text-gray-400">加载中...</span>}
                </div>
                <div className="border border-gray-100 rounded p-3 space-y-3">
                  {categoryAttributes
                    .filter((attr) => attr.id !== 'ITEM_CONDITION')
                    .map((attr) => (
                      <div key={attr.id} className="grid grid-cols-12 gap-3 items-center">
                        <div className="col-span-3 text-sm">
                          {attr.name}
                          {attr.required && <span className="text-red-500 ml-1">*</span>}
                          <div className="text-xs text-gray-400">{attr.id}</div>
                        </div>
                        <div className="col-span-9">
                          {attr.values && attr.values.length > 0 ? (
                            <select
                              value={publishDraft.attributeValues[attr.id]?.value_id || ''}
                              onChange={(e) => {
                                const val = attr.values?.find((v) => v.id === e.target.value);
                                setPublishDraft((prev) => {
                                  if (!prev) return prev;
                                  return {
                                    ...prev,
                                    attributeValues: {
                                      ...prev.attributeValues,
                                      [attr.id]: val ? { value_id: val.id, value_name: val.name } : undefined,
                                    },
                                  };
                                });
                              }}
                              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                            >
                              <option value="">{attr.required ? '请选择（必填）' : '请选择（可选）'}</option>
                              {attr.values.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {v.name}
                                </option>
                              ))}
                            </select>
                          ) : attr.value_type === 'number_unit' || attr.value_type === 'number' ? (
                            <div className="flex gap-2">
                              <Input
                                value={publishDraft.attributeValues[attr.id]?.value_name || ''}
                                onChange={(v) =>
                                  setPublishDraft((prev) => {
                                    if (!prev) return prev;
                                    return {
                                      ...prev,
                                      attributeValues: {
                                        ...prev.attributeValues,
                                        [attr.id]: { value_name: String(v) },
                                      },
                                    };
                                  })
                                }
                                placeholder={attr.hint || '如 10 cm / 500 g'}
                                className="flex-1"
                              />
                            </div>
                          ) : (
                            <Input
                              value={publishDraft.attributeValues[attr.id]?.value_name || ''}
                              onChange={(v) =>
                                setPublishDraft((prev) => {
                                  if (!prev) return prev;
                                  return {
                                    ...prev,
                                    attributeValues: {
                                      ...prev.attributeValues,
                                      [attr.id]: { value_name: String(v) },
                                    },
                                  };
                                })
                              }
                              placeholder={attr.hint || '请输入'}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* 描述 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">商品描述</span>
                <Button size="small" variant="text" theme="primary" onClick={handleGenerateDescription}>
                  生成描述
                </Button>
              </div>
              <Textarea
                value={publishDraft.description}
                onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, description: String(v) } : prev))}
                rows={4}
                placeholder="西/葡语商品描述"
              />
            </div>

            {/* 目标国家与利润 */}
            <div>
              <div className="text-sm font-medium mb-2">目标国家 / 独立售价 / 净利润测算</div>
              <div className="border border-gray-100 rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">国家</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">售价（USD）</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">产品类型</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">净利润</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">利润率</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">ROI</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">佣金比例</th>
                    </tr>
                  </thead>
                  <tbody>
                    {targetSites.map((site) => {
                      const info = siteInfos[site];
                      const p = profitBySite[site];
                      const sitePrice = publishDraft.priceBySite[site] ?? publishDraft.listingPriceUsd;
                      const siteType = publishDraft.listingTypeBySite[site] ?? publishDraft.listingType;
                      return (
                        <tr key={site} className="border-t">
                          <td className="px-3 py-2">{info ? `${info.name} (${site})` : site}</td>
                          <td className="px-3 py-2">
                            <InputNumber
                              value={sitePrice}
                              onChange={(v) =>
                                setPublishDraft((prev) => {
                                  if (!prev) return prev;
                                  return {
                                    ...prev,
                                    priceBySite: { ...prev.priceBySite, [site]: Number(v) || 0 },
                                  };
                                })
                              }
                              decimalPlaces={2}
                              min={0}
                              style={{ width: 110 }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={siteType}
                              onChange={(e) =>
                                setPublishDraft((prev) => {
                                  if (!prev) return prev;
                                  return {
                                    ...prev,
                                    listingTypeBySite: { ...prev.listingTypeBySite, [site]: e.target.value },
                                  };
                                })
                              }
                              className="border border-gray-300 rounded px-2 py-1 text-sm"
                            >
                              <option value="bronze">Classic（bronze）</option>
                              <option value="gold_pro">Premium（gold_pro）</option>
                              <option value="gold">Gold</option>
                              <option value="silver">Silver</option>
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            {p ? (
                              <span className={p.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}>
                                ${p.netProfit.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-gray-400">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2">{p ? `${(p.netProfitRate * 100).toFixed(1)}%` : '-'}</td>
                          <td className="px-3 py-2">{p ? p.roi.toFixed(2) : '-'}</td>
                          <td className="px-3 py-2">{p && p.listingPriceUsd ? `${(p.costBreakdown.commission / p.listingPriceUsd * 100).toFixed(0)}%` : '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {profitLoading && <div className="text-xs text-gray-400 px-3 py-2">测算中...</div>}
              </div>
            </div>

            {/* 上架目标店铺 */}
            <div>
              <div className="text-sm font-medium mb-2">选择要上架的目标店铺：</div>
              <div className="space-y-2 max-h-40 overflow-auto border border-gray-100 rounded p-2">
                {stores
                  .filter((s) => s.enabled && s.authorized)
                  .map((s) => (
                    <div key={s.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedStoreIds.includes(s.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedStoreIds((prev) => [...prev, s.id]);
                          } else {
                            setSelectedStoreIds((prev) => prev.filter((id) => id !== s.id));
                          }
                        }}
                      />
                      <span>{s.nickname}</span>
                      <Tag size="small">{s.site}</Tag>
                    </div>
                  ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch value={useCbtCategory} onChange={(v) => setUseCbtCategory(v as boolean)} />
              <span className="text-sm">使用 CBT 类目前缀（上架失败可关闭）</span>
            </div>

            {/* YouTube 上传 */}
            <div className="border border-gray-100 rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <Switch value={uploadYoutube} onChange={(v) => setUploadYoutube(v as boolean)} />
                <span className="text-sm font-medium">上架后上传商品视频到 YouTube</span>
                {!ytConfigured && <Tag size="small" theme="warning">未授权</Tag>}
              </div>
              {uploadYoutube && (
                <div className="space-y-2">
                  <div className="text-xs text-gray-500">
                    填写服务器上视频文件的<strong>绝对路径</strong>。
                    {!ytConfigured && (
                      <span className="text-red-500"> 尚未完成 YouTube OAuth 授权，请到「配置中心 → YouTube 上传」完成授权。</span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={youtubeVideoPath}
                    onChange={(e) => setYoutubeVideoPath(e.target.value)}
                    placeholder="/data/videos/product_demo.mp4"
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
            </div>

            <div className="text-xs text-gray-400 bg-yellow-50 p-2 rounded">
              提示：确认上架后，系统会按上方预览信息生成 Listing 并发布。建议售价、库存、图片、描述等均可在此修改。
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

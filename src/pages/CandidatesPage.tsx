import { useEffect, useState, useRef } from 'react';
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
  Collapse,
  Tooltip,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';

interface Candidate {
  id: number;
  site: string;
  ml_item_id: string;
  ml_title: string;
  ml_price_usd: number;
  ml_thumbnail: string;
  ml_pictures?: string;
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
  status: 'pending' | 'approved' | 'rejected' | 'published' | 'matched';
  reject_reason: string;
  trend_note?: string;
  source_tag?: 'recent' | 'trend' | 'bestseller';
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
  /** 多 SKU：标题来自 1688 SKU 标题，图片来自 1688 SKU 图片（取不到回退主图） */
  skus: { title: string; imageUrl: string }[];
  /** 1688 货源链接，方便手动核对重量/尺寸 */
  ali1688Url?: string;
  /** 类目属性值：{ [attributeId]: { value_id|value_name|values } } */
  attributeValues: Record<string, any>;
  /** 类目 ID（可编辑，覆盖原候选类目） */
  categoryId?: string;
  /** 类目名称（展示用） */
  categoryName?: string;
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
  total_new?: number;
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
  matched: { label: '进入匹配', theme: 'default' },
  published: { label: '已上架', theme: 'primary' },
};

export function CandidatesPage() {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [scanMode, setScanMode] = useState<string>('all');
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

  // 排序方式：评分 / 入库时间（新→旧）/ 入库时间（旧→新）
  const [orderBy, setOrderBy] = useState<string>('created_at DESC');
  // 表头显隐配置（持久化到 localStorage）
  const COL_VIS_KEY = 'mlfinder_col_visibility';
  const [colVisibility, setColVisibility] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem(COL_VIS_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [showColSettings, setShowColSettings] = useState(false);

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
  // 目标净利润（USD，按站点独立）：用户直接填写，系统据此反推售价（运费按重量/尺寸自动测算）
  const [targetNetBySite, setTargetNetBySite] = useState<Record<string, number>>({});
  // 用 ref 让后台自动填充在读到最新 draft/targetSites，避免闭包过期
  const publishDraftRef = useRef<PublishDraft | null>(null);
  const targetSitesRef = useRef<string[]>([]);
  useEffect(() => { publishDraftRef.current = publishDraft; }, [publishDraft]);
  useEffect(() => { targetSitesRef.current = targetSites; }, [targetSites]);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [categoryAttributes, setCategoryAttributes] = useState<CategoryAttribute[]>([]);
  const [categoryAttrLoading, setCategoryAttrLoading] = useState(false);
  // 上架结果详情
  const [publishResult, setPublishResult] = useState<any>(null);
  const [resultOpen, setResultOpen] = useState(false);

  // 顶部 Tab：候选列表 / 已上架
  const [activeTab, setActiveTab] = useState<'candidates' | 'published'>('candidates');
  const [siteFilter, setSiteFilter] = useState('');

  // 运行状态卡片点击下钻到对应列表筛选
  const drillToStatus = (nextStatus: string) => {
    setActiveTab('candidates');
    setStatus(nextStatus);
    // 切换到候选列表后会由 useEffect 自动拉取
  };

  // 批量上架
  const [selectedRowIds, setSelectedRowIds] = useState<(string | number)[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchStoreIds, setBatchStoreIds] = useState<string[]>([]);
  const [batchListingType, setBatchListingType] = useState('gold_special');
  const [batching, setBatching] = useState(false);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [batchResultOpen, setBatchResultOpen] = useState(false);

  // 已上架 tab
  const [publishedRows, setPublishedRows] = useState<any[]>([]);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [publishedSiteFilter, setPublishedSiteFilter] = useState('');
  const [publishedStoreFilter, setPublishedStoreFilter] = useState('');

  // 已上架商品编辑
  const [editOpen, setEditOpen] = useState(false);
  const [editItem, setEditItem] = useState<any>(null);
  const [editDraft, setEditDraft] = useState<any>(null);
  const [editing, setEditing] = useState(false);

  // 上架弹窗内：类目可编辑（全路径 / 搜索 / 推荐）
  const [catSearch, setCatSearch] = useState('');
  const [catResults, setCatResults] = useState<{ id: string; name: string }[]>([]);
  const [catPredict, setCatPredict] = useState<{ id: string; name: string }[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [catPath, setCatPath] = useState('');
  const [catError, setCatError] = useState('');

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
      const contentType = res.headers.get('content-type') || '';
      // 若后端返回 HTML（如代理错误、静态回退、404 页面），不要直接 res.json() 抛红字
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        const preview = text.slice(0, 120).replace(/\s+/g, ' ');
        throw new Error(`服务端返回非 JSON 响应（HTTP ${res.status} ${res.statusText}）：${preview}`);
      }
      const data = await res.json();
      if (data.success) {
        setLatestRun(data.run);
        setRunPollError(null);
      } else {
        // 业务失败：比如运行记录不存在，不算轮询错误，只记日志
        console.warn('[LatestRun]', data.message);
      }
    } catch (e: any) {
      // 连续失败时给出诊断提示，但不被红字 scare error 占满
      setRunPollError(`状态同步异常：${e?.message || '网络错误'}（请确认后端地址/端口正确）`);
    }
  };

  const resetRunStatus = async () => {
    if (!latestRun?.id) return;
    try {
      const res = await fetch(`/api/ml/sourcing/runs/${latestRun.id}/reset`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('已重置运行状态');
        setLatestRun(data.run);
        setRunPollError(null);
      } else {
        MessagePlugin.warning(data.message || '重置失败');
      }
    } catch (e: any) {
      MessagePlugin.error(`重置失败：${e?.message || '网络错误'}`);
    }
  };

  useEffect(() => {
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

  // 筛选联动：状态/站点/顶部 Tab 变化时自动刷新对应列表
  useEffect(() => {
    if (activeTab === 'candidates') {
      fetchRows();
    } else {
      fetchPublishedItems();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, siteFilter, activeTab, publishedSiteFilter, publishedStoreFilter]);

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
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (siteFilter) params.set('site', siteFilter);
      if (orderBy) params.set('orderBy', orderBy);
      params.set('limit', '100');
      const res = await fetch(`/api/ml/candidates?${params.toString()}`);
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
        body: JSON.stringify({ maxCandidatesToSource: 30, targetNetRate: 0.15, mode: scanMode }),
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
      initialListingTypeBySite[site] = 'gold_special';
    }
    const draft: PublishDraft = {
      title: row.ml_title || row.ali1688_title || '',
      description: buildDefaultDescription(row, row.ml_title || row.ali1688_title || ''),
      pictureUrls: imgs,
      listingPriceUsd: basePrice,
      priceBySite: initialPriceBySite,
      listingTypeBySite: initialListingTypeBySite,
      availableQuantity: 3,
      weightKg: row.weight_kg || 0,
      lengthCm: row.length_cm || 0,
      widthCm: row.width_cm || 0,
      heightCm: row.height_cm || 0,
      brand: 'Generic',
      model: '',
      warrantyType: 'No warranty',
      warrantyTime: '',
      listingType: 'gold_special',
      skus: [],
      ali1688Url: row.ali1688_url || '',
      attributeValues: {},
      categoryId: row.ml_category_id || '',
      categoryName: row.ml_category_name || '',
    };
    setPublishDraft(draft);
    setProfitBySite({});
    setUploadYoutube(false);
    setYoutubeVideoPath('');
    setCategoryAttributes([]);
    setCategoryAttrLoading(false);
    setCatSearch('');
    setCatResults([]);
    setCatPredict([]);
    setCatError('');
    setCatPath('');
    setAiEditing(false);
    setPublishOpen(true);
    // 拉取类目属性 + 全路径
    if (row.ml_category_id) {
      fetchCategoryAttributes(row.ml_category_id);
      fetchCategoryPath(row.ml_category_id);
    }
    // 后台自动：补充 1688 重量/尺寸/SKU + AI 编辑图片 + 按目标净利润反推售价（无需手动点击）
    autoFillPublish(row, draft, initialSites);
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
          candidateId: publishRow.id,
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
          categoryName: publishDraft.categoryName || publishRow.ml_category_name,
          brand: publishDraft.brand,
          candidateId: publishRow.id,
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

  // ============ 类目可编辑：全路径 / 关键词搜索 / 类目推荐 ============
  const fetchCategoryPath = async (categoryId: string) => {
    if (!categoryId) {
      setCatPath('');
      return;
    }
    try {
      const res = await fetch(`/api/ml/category/${categoryId}/path`);
      const data = await res.json();
      if (data.success && data.category?.path_from_root?.length) {
        setCatPath(data.category.path_from_root.map((p: any) => p.name).join(' > '));
      } else {
        setCatPath('');
      }
    } catch {
      setCatPath('');
    }
  };

  const searchCategory = async (q: string) => {
    if (!publishRow || !q.trim()) {
      setCatResults([]);
      return;
    }
    setCatLoading(true);
    try {
      const res = await fetch(`/api/ml/categories/${publishRow.site}/search?q=${encodeURIComponent(q.trim())}`);
      const data = await res.json();
      if (data.success) setCatResults(data.categories || []);
    } catch {
      setCatResults([]);
    } finally {
      setCatLoading(false);
    }
  };

  const predictCategoryForTitle = async () => {
    if (!publishRow || !publishDraft?.title) {
      MessagePlugin.warning('请先填写标题再获取推荐类目');
      return;
    }
    setCatLoading(true);
    setCatError('');
    try {
      const res = await fetch(`/api/ml/categories/${publishRow.site}/predict?title=${encodeURIComponent(publishDraft.title)}`);
      const data = await res.json();
      if (data.success && (data.categories || []).length) {
        setCatPredict(data.categories.slice(0, 8));
      } else {
        setCatError('未找到推荐类目，可尝试修改标题或手动搜索');
        setCatPredict([]);
      }
    } catch (e: any) {
      setCatError(e?.message || '类目推荐失败');
    } finally {
      setCatLoading(false);
    }
  };

  const onSelectCategory = (cat: { id: string; name: string }) => {
    setPublishDraft((prev) => (prev ? { ...prev, categoryId: cat.id, categoryName: cat.name } : prev));
    setCatSearch('');
    setCatResults([]);
    setCatPredict([]);
    setCatError('');
    fetchCategoryPath(cat.id);
    fetchCategoryAttributes(cat.id);
  };

  // ============ 从 1688 详情补充重量/尺寸/SKU（后台自动调用，无需手动点击） ============
  const [aliFilling, setAliFilling] = useState(false);
  const fetch1688DetailCore = async (row: Candidate) => {
    const res = await fetch(`/api/ml/candidates/${row.id}/1688-detail`, { method: 'POST' });
    const data = await res.json();
    if (!data.success) return null;
    return data;
  };
  const apply1688Detail = (data: any) => {
    setPublishDraft((prev) => {
      if (!prev) return prev;
      const next: typeof prev = { ...prev };
      if (typeof data.weightKg === 'number') next.weightKg = data.weightKg;
      if (typeof data.lengthCm === 'number') next.lengthCm = data.lengthCm;
      if (typeof data.widthCm === 'number') next.widthCm = data.widthCm;
      if (typeof data.heightCm === 'number') next.heightCm = data.heightCm;
      if (Array.isArray(data.skus) && data.skus.length) next.skus = data.skus;
      else if (Array.isArray(data.skuList) && data.skuList.length) {
        next.skus = data.skuList.map((t: string) => ({ title: t, imageUrl: prev.pictureUrls[0] || '' }));
      }
      if (data.ali1688Url) next.ali1688Url = data.ali1688Url;
      return next;
    });
    return data;
  };
  const handleFetch1688Detail = async () => {
    if (!publishRow) return;
    try {
      const data = await fetch1688DetailCore(publishRow);
      if (!data) {
        MessagePlugin.warning('未获取到 1688 详情（可能该候选无 1688 商品 ID 或 AK 未配置）');
        return;
      }
      apply1688Detail(data);
      MessagePlugin.success('已从 1688 详情补充重量/尺寸/SKU');
    } catch (e: any) {
      MessagePlugin.error(e?.message || '补充失败');
    }
  };

  // ============ 打开弹窗时后台自动：补充 1688 重量/尺寸/SKU + AI 编辑图片 + 反推净利润售价 ============
  const autoFillPublish = async (row: Candidate, draft: PublishDraft, sites: string[]) => {
    // 1) 补充 1688 重量/尺寸/SKU（失败不影响主流程）
    setAliFilling(true);
    try {
      const data = await fetch1688DetailCore(row);
      if (data) apply1688Detail(data);
    } catch {
      /* 忽略：1688 不可用时仍可用手动填写 */
    } finally {
      setAliFilling(false);
    }
    // 2) 自动 AI 编辑图片（去背景+白底+水印，符合美客多要求），失败则保留原图
    if (draft.pictureUrls.length > 0) {
      try {
        await autoAiEditImages(draft.pictureUrls);
      } catch {
        /* 忽略 */
      }
    }
    // 3) 按默认目标净利润（竞品价 20%）反推各站点售价，运费由重量/尺寸自动测算
    try {
      const purchaseCostCny = row.ali1688_price_cny || 0;
      for (const site of sites) {
        const suggestedTarget = Math.max(0.5, Math.round((draft.priceBySite[site] ?? draft.listingPriceUsd) * 0.2 * 100) / 100);
        await reverseNetProfit(site, suggestedTarget, {
          purchaseCostCny,
          weightKg: draft.weightKg,
          lengthCm: draft.lengthCm,
          widthCm: draft.widthCm,
          heightCm: draft.heightCm,
        });
      }
    } catch {
      /* 忽略 */
    }
  };

  // ============ 按目标净利润反推售价（运费按重量/尺寸自动测算） ============
  const reverseNetProfit = async (
    site: string,
    targetNetProfitUsd: number,
    dims: { purchaseCostCny: number; weightKg?: number; lengthCm?: number; widthCm?: number; heightCm?: number }
  ) => {
    if (!targetNetProfitUsd || targetNetProfitUsd <= 0) return;
    try {
      const res = await fetch('/api/ml/profit/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site,
          targetNetProfitUsd,
          purchaseCostCny: dims.purchaseCostCny || 0,
          weightKg: dims.weightKg || undefined,
          lengthCm: dims.lengthCm || undefined,
          widthCm: dims.widthCm || undefined,
          heightCm: dims.heightCm || undefined,
          taxMode: 'direct_import',
          adAcosRate: 0.05,
        }),
      });
      const data = await res.json();
      if (data.success && Number.isFinite(data.listingPriceUsd)) {
        setPublishDraft((prev) =>
          prev ? { ...prev, priceBySite: { ...prev.priceBySite, [site]: data.listingPriceUsd } } : prev
        );
        setTargetNetBySite((prev) => ({ ...prev, [site]: targetNetProfitUsd }));
      }
    } catch {
      /* 忽略反推失败 */
    }
  };

  // ============ 图片 AI 编辑（去背景+白底+水印）后回传美客多公网 URL ============
  const [aiEditing, setAiEditing] = useState(false);
  const autoAiEditImages = async (images?: string[]) => {
    if (!publishRow) return;
    const srcs = images && images.length ? images : publishDraft?.pictureUrls || [];
    if (srcs.length === 0) return;
    setAiEditing(true);
    try {
      const res = await fetch('/api/ml/listing/prepare-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          site: publishRow.site,
          sourceImages: srcs,
          mode: 'ai',
          watermarkText: publishRow.site,
        }),
      });
      const data = await res.json();
      if (data.success && Array.isArray(data.pictures) && data.pictures.length) {
        setPublishDraft((prev) => (prev ? { ...prev, pictureUrls: data.pictures } : prev));
      }
    } catch {
      /* 后台自动编辑失败则保留原图，不阻断上架 */
    } finally {
      setAiEditing(false);
    }
  };
  const handleAiEditImages = async () => {
    if (!publishDraft || publishDraft.pictureUrls.length === 0) {
      MessagePlugin.warning('请先有可用图片');
      return;
    }
    await autoAiEditImages();
  };

  // ============ 批量上架 ============
  const openBatchPublish = () => {
    if (selectedRowIds.length === 0) {
      MessagePlugin.warning('请先勾选要上架的商品');
      return;
    }
    const initial = stores.filter((s) => s.enabled && s.authorized).map((s) => s.id);
    setBatchStoreIds(initial);
    setBatchListingType('gold_special');
    setBatchResult(null);
    setBatchOpen(true);
  };

  const handleBatchPublish = async () => {
    if (batchStoreIds.length === 0) {
      MessagePlugin.warning('请至少选择一个目标店铺');
      return;
    }
    setBatching(true);
    try {
      const res = await fetch('/api/ml/candidates/batch-publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ids: selectedRowIds.map((x) => Number(x)),
          storeIds: batchStoreIds,
          useCbtCategory,
          draft: { listingType: batchListingType },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setBatchResult(data);
        setBatchResultOpen(true);
        setSelectedRowIds([]);
        if (data.totalSucceeded > 0) fetchRows();
      } else {
        MessagePlugin.error(data.message || '批量上架失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setBatching(false);
    }
  };

  // ============ 已上架商品列表 / 编辑 ============
  const fetchPublishedItems = async () => {
    setPublishedLoading(true);
    try {
      const params = new URLSearchParams();
      if (publishedSiteFilter) params.set('site', publishedSiteFilter);
      if (publishedStoreFilter) params.set('storeId', publishedStoreFilter);
      const res = await fetch(`/api/ml/published-items?${params.toString()}`);
      const data = await res.json();
      if (data.success) {
        setPublishedRows(data.rows || []);
      } else {
        MessagePlugin.error(data.message || '获取已上架商品失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setPublishedLoading(false);
    }
  };

  const openEditPublished = (item: any) => {
    setEditItem(item);
    let priceBySite: Record<string, any> = {};
    try {
      const arr = JSON.parse(item.price_by_site || '[]');
      if (Array.isArray(arr)) {
        arr.forEach((s: any) => {
          priceBySite[s.site_id] = {
            price: s.price,
            listingType: s.listing_type_id,
            netProceeds: !!s.net_proceeds,
          };
        });
      }
    } catch {
      /* ignore */
    }
    setEditDraft({
      title: item.title || '',
      description: item.description || '',
      pictureUrls: (item.picture_urls || '').split('|').filter(Boolean),
      brand: item.brand || 'Generic',
      model: item.model || '',
      weightKg: item.weight ? Number(item.weight) / 1000 : 0,
      lengthCm: item.length ? Number(item.length) : 0,
      widthCm: item.width ? Number(item.width) : 0,
      heightCm: item.height ? Number(item.height) : 0,
      availableQuantity: item.available_quantity || 50,
      priceBySite,
      newImageUrl: '',
    });
    setEditOpen(true);
  };

  const handleEditPublishedSave = async () => {
    if (!editItem || !editDraft) return;
    setEditing(true);
    try {
      const pictureUrls = [...editDraft.pictureUrls];
      if (editDraft.newImageUrl?.trim().startsWith('http') && !pictureUrls.includes(editDraft.newImageUrl.trim())) {
        pictureUrls.push(editDraft.newImageUrl.trim());
      }
      const res = await fetch(`/api/ml/published-items/${editItem.id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editDraft.title,
          description: editDraft.description,
          pictureUrls,
          brand: editDraft.brand,
          model: editDraft.model,
          weightKg: editDraft.weightKg,
          lengthCm: editDraft.lengthCm,
          widthCm: editDraft.widthCm,
          heightCm: editDraft.heightCm,
          availableQuantity: editDraft.availableQuantity,
          priceBySite: editDraft.priceBySite,
        }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('已更新已上架商品');
        setEditOpen(false);
        fetchPublishedItems();
      } else {
        MessagePlugin.error(data.message || '修改失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setEditing(false);
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
      // 把每个 SKU 的图片（若有）一并上架，最多补充到 6 张
      for (const sku of publishDraft.skus) {
        if (sku.imageUrl && sku.imageUrl.startsWith('http') && !pictureUrls.includes(sku.imageUrl) && pictureUrls.length < 6) {
          pictureUrls.push(sku.imageUrl);
        }
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
        model: publishDraft.model || (publishDraft.skus[0]?.title ?? ''),
        warrantyType: publishDraft.warrantyType,
        warrantyTime: publishDraft.warrantyTime,
        listingType: publishDraft.listingType,
        skus: publishDraft.skus,
        attributeValues: publishDraft.attributeValues,
        categoryId: publishDraft.categoryId,
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
        const r = data.result || {};
        setPublishResult(r);
        setResultOpen(true);
        // 只有成功数>0才关闭预览弹窗并刷新列表
        if (r.succeeded > 0) {
          setPublishOpen(false);
          fetchRows();
        }
      } else {
        MessagePlugin.error(data.message || '上架失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setPublishing(false);
    }
  };

  // 标题相似度去重：提取关键词计算 Jaccard 相似度
  const titleTokens = (title: string): string[] => {
    return String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  };
  const jaccardSimilarity = (a: string[], b: string[]): number => {
    const setA = new Set(a);
    const setB = new Set(b);
    const intersection = new Set([...setA].filter((x) => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  };

  // 去重策略：1) 同一 site+ml_item_id 保留最新；2) 1688 货源链接相同保留最优；3) 标题相似度>0.7 视为重复保留评分高者
  const dedupCandidates = (list: Candidate[]): Candidate[] => {
    const byItemId = new Map<string, Candidate>();
    const by1688Url = new Map<string, Candidate>();
    const kept: Candidate[] = [];
    const simThreshold = 0.7;

    // 先按 id 降序，保证较新记录优先
    const sorted = [...list].sort((a, b) => b.id - a.id);

    for (const row of sorted) {
      const itemKey = `${row.site}|${row.ml_item_id}`;
      if (byItemId.has(itemKey)) continue;

      // 1688 货源链接去重
      const url = row.ali1688_url || '';
      if (url.startsWith('http')) {
        const existing1688 = by1688Url.get(url);
        if (existing1688) {
          if ((row.score_total || 0) > (existing1688.score_total || 0)) {
            by1688Url.set(url, row);
            // 替换 kept 中旧的
            const idx = kept.findIndex((x) => x.id === existing1688.id);
            if (idx >= 0) kept[idx] = row;
          }
          continue;
        }
        by1688Url.set(url, row);
      }

      // 标题相似度去重：与已保留的同行站点商品比较
      const tokens = titleTokens(row.ml_title || row.ali1688_title || '');
      const dup = kept.find((k) => {
        if (k.site !== row.site) return false;
        const kTokens = titleTokens(k.ml_title || k.ali1688_title || '');
        return jaccardSimilarity(tokens, kTokens) >= simThreshold;
      });
      if (dup) {
        // 保留评分更高或更新的
        if ((row.score_total || 0) > (dup.score_total || 0) || row.id > dup.id) {
          const idx = kept.findIndex((x) => x.id === dup.id);
          if (idx >= 0) kept[idx] = row;
        }
        continue;
      }

      byItemId.set(itemKey, row);
      kept.push(row);
    }
    // 保持原始列表的相对顺序（按 id 降序）
    const keptIds = new Set(kept.map((x) => x.id));
    return list.filter((x) => keptIds.has(x.id));
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
    let multi: string[] = [];
    if (row.ml_pictures) {
      try {
        const parsed = JSON.parse(row.ml_pictures);
        if (Array.isArray(parsed)) multi = parsed.map((s) => String(s).trim()).filter(Boolean);
      } catch {
        /* 旧数据或脏数据容错 */
      }
    }
    const parts = [...multi, row.ali1688_image_url, row.ml_thumbnail]
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
      colKey: 'row-select',
      type: 'multiple',
      width: 48,
      title: '',
    },
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
          <div className="grid grid-cols-4 gap-0.5 w-[104px]">
            {urls.slice(0, 8).map((src, idx) => (
              <img
                key={`${src}-${idx}`}
                src={src}
                alt=""
                className="w-6 h-6 object-cover rounded border border-gray-100 cursor-pointer hover:opacity-80"
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
      colKey: 'source_tag',
      title: '来源',
      width: 110,
      cell: ({ row }) => {
        const map: Record<string, { label: string; theme: any }> = {
          trend: { label: '🔥热搜上升', theme: 'warning' },
          bestseller: { label: '🏆热销榜', theme: 'danger' },
          recent: { label: '🆕近期新上', theme: 'success' },
        };
        const s = map[row.source_tag || 'recent'] || map.recent;
        return <Tag theme={s.theme} size="small">{s.label}</Tag>;
      },
    },
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
      colKey: 'trend_note',
      title: '趋势备注',
      width: 240,
      ellipsis: true,
      cell: ({ row }) => {
        if (!row.trend_note) return <span className="text-gray-300">-</span>;
        return (
          <span className="text-xs text-indigo-600 truncate max-w-[220px] inline-block" title={row.trend_note}>
            {row.trend_note}
          </span>
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
      colKey: 'created_at',
      title: '入库时间',
      width: 150,
      cell: ({ row }) => {
        const t = row.created_at ? new Date(row.created_at) : null;
        return (
          <span className="text-xs text-gray-500">
            {t && !isNaN(t.getTime()) ? t.toLocaleString('zh-CN', { hour12: false }) : '-'}
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

  // 固定常显的列（不参与显隐切换）
  const FIXED_COL_KEYS = ['row-select', 'thumbnail', 'action'];
  // 生成可切换列的下拉选项（基于 columns 的 colKey/title，排除固定列）
  const columnToggleOptions = columns
    .filter((c) => !FIXED_COL_KEYS.includes(c.colKey as string))
    .map((c) => ({ colKey: c.colKey as string, title: (c.title as string) || String(c.colKey) }));
  const visibleColumns = columns.filter((c) => {
    const key = c.colKey as string;
    if (FIXED_COL_KEYS.includes(key)) return true;
    return colVisibility[key] !== false;
  });
  const toggleColumn = (key: string, visible: boolean) => {
    const next = { ...colVisibility, [key]: visible };
    setColVisibility(next);
    try {
      localStorage.setItem(COL_VIS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

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
          {isStuck && (
            <Button size="small" variant="outline" theme="warning" onClick={resetRunStatus}>
              重置状态
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
          <Tooltip content="本次扫描从 Mercado Libre 各站点抓取到的候选商品总数（尚未经过 1688 匹配与评分筛选）。点击显示全部候选。">
            <button
              type="button"
              onClick={() => drillToStatus('')}
              className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2 hover:border-blue-300 hover:shadow-sm transition"
            >
              <div className="text-gray-500">扫描商品</div>
              <div className="font-medium text-lg">{latestRun.total_scanned || 0}</div>
            </button>
          </Tooltip>
          <Tooltip content="扫描结果中符合基础过滤条件、进入 1688 货源匹配环节的商品数。点击筛选「进入匹配」状态。">
            <button
              type="button"
              onClick={() => drillToStatus('matched')}
              className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2 hover:border-blue-300 hover:shadow-sm transition"
            >
              <div className="text-gray-500">进入匹配</div>
              <div className="font-medium text-lg">{latestRun.total_matched || 0}</div>
            </button>
          </Tooltip>
          <Tooltip content="实际完成 1688 找货 + 利润测算 + 五维评分的商品数（受单次处理上限限制，小于「进入匹配」）。点击显示所有已核价候选。">
            <button
              type="button"
              onClick={() => drillToStatus('')}
              className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2 hover:border-blue-300 hover:shadow-sm transition"
            >
              <div className="text-gray-500">已核价</div>
              <div className="font-medium text-lg text-blue-600">{latestRun.total_scored || 0}</div>
            </button>
          </Tooltip>
          <Tooltip content="系统初筛通过并写入候选库的商品，当前状态为「待审核」，需要你在列表里点「通过」后才会进入可上架状态。点击筛选「待审核」。">
            <button
              type="button"
              onClick={() => drillToStatus('pending')}
              className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2 hover:border-blue-300 hover:shadow-sm transition"
            >
              <div className="text-gray-500">入库待审</div>
              <div className="font-medium text-lg text-green-600">{latestRun.total_approved || 0}</div>
              {latestRun.total_new !== undefined && latestRun.total_approved > 0 && (
                <div className="text-xs text-gray-400">
                  新增 {latestRun.total_new || 0} / 更新 {(latestRun.total_approved || 0) - (latestRun.total_new || 0)}
                </div>
              )}
            </button>
          </Tooltip>
          <Tooltip content="进入匹配但未达到评分/合规性门槛、被淘汰的商品数。点击筛选「已拒绝」查看具体原因。">
            <button
              type="button"
              onClick={() => drillToStatus('rejected')}
              className="text-left rounded-lg border border-gray-100 bg-white px-3 py-2 hover:border-blue-300 hover:shadow-sm transition"
            >
              <div className="text-gray-500">已淘汰</div>
              <div className="font-medium text-lg text-red-600">{latestRun.total_rejected || 0}</div>
            </button>
          </Tooltip>
        </div>
        {runPollError && (
          <div className="flex items-start justify-between gap-2 text-xs text-amber-700 bg-amber-50 p-2 rounded">
            <span>{runPollError}</span>
            <Button size="small" variant="text" theme="primary" onClick={fetchLatestRun}>
              重试
            </Button>
          </div>
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

      {/* 顶部 Tab：候选列表 / 已上架 */}
      <div className="flex gap-1 mb-4 bg-gray-100 rounded-lg p-1 w-max max-w-full overflow-x-auto">
        <button
          onClick={() => setActiveTab('candidates')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'candidates' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600'
          }`}
        >
          AI 选品候选
        </button>
        <button
          onClick={() => setActiveTab('published')}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'published' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600'
          }`}
        >
          已上架商品
        </button>
      </div>

      {activeTab === 'candidates' ? (
        <Card title="AI 选品候选列表" headerBordered>
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <Space>
              <Button theme="primary" loading={running} onClick={handleRun}>
                立即扫描选品
              </Button>
              <Select
                value={scanMode}
                onChange={(v) => setScanMode(v as string)}
                options={[
                  { label: '全部来源（推荐）', value: 'all' },
                  { label: '近期新上+有销量', value: 'recent' },
                  { label: '🔥官方热搜上升品', value: 'trend' },
                  { label: '🏆类目热销榜', value: 'bestseller' },
                ]}
                style={{ width: 180 }}
              />
              <Button variant="outline" onClick={fetchRows}>
                刷新
              </Button>
              <Link href="#/config" theme="primary" size="small">
                {akStatus.configured ? '1688 AK 已配置' : '配置 1688 AK'}
              </Link>
              <Link href="#/config" theme="primary" size="small">
                {ytConfigured ? 'YouTube 已授权' : '配置 YouTube'}
              </Link>
            </Space>
            <Space>
              <Select
                value={status}
                onChange={(v) => setStatus(v as string)}
                options={[
                  { label: '全部状态', value: '' },
                  { label: '待审核', value: 'pending' },
                  { label: '进入匹配', value: 'matched' },
                  { label: '已通过', value: 'approved' },
                  { label: '已拒绝', value: 'rejected' },
                  { label: '已上架', value: 'published' },
                ]}
                style={{ width: 130 }}
              />
              <Select
                value={siteFilter}
                onChange={(v) => setSiteFilter(v as string)}
                options={[
                  { label: '全部站点', value: '' },
                  ...Object.keys(siteInfos).map((code) => ({
                    label: `${siteInfos[code].name} (${code})`,
                    value: code,
                  })),
                ]}
                style={{ width: 150 }}
                placeholder="站点筛选"
              />
              <Select
                value={orderBy}
                onChange={(v) => setOrderBy(v as string)}
                options={[
                  { label: '入库时间（新→旧）', value: 'created_at DESC' },
                  { label: '入库时间（旧→新）', value: 'created_at ASC' },
                  { label: '评分（高→低）', value: 'score_total DESC, created_at DESC' },
                ]}
                style={{ width: 160 }}
                placeholder="排序"
              />
              <div className="relative">
                <Button variant="outline" size="medium" onClick={() => setShowColSettings((v) => !v)}>
                  列设置
                </Button>
                {showColSettings && (
                  <div className="absolute right-0 z-20 mt-1 bg-white border border-gray-200 shadow-lg rounded-lg p-2 max-h-80 overflow-auto" style={{ minWidth: 220 }}>
                    <div className="text-xs text-gray-400 px-2 py-1">点击切换列显隐（自动保存）</div>
                    {columnToggleOptions.map((opt) => (
                      <div key={opt.colKey} className="flex items-center gap-2 px-2 py-1">
                        <Switch
                          size="small"
                          value={colVisibility[opt.colKey] !== false}
                          onChange={(val) => toggleColumn(opt.colKey, val as boolean)}
                        />
                        <span className="text-sm">{opt.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Space>
          </div>

          <Loading loading={loading} size="small">
            <Table
              data={rows}
              columns={visibleColumns}
              rowKey="id"
              bordered
              hover
              stripe
              selectedRowKeys={selectedRowIds}
              onSelectChange={(keys) => setSelectedRowIds(keys as (string | number)[])}
              pagination={{
                defaultCurrent: 1,
                defaultPageSize: 20,
                total: rows.length,
              }}
            />
          </Loading>

          {/* 批量操作吸底栏 */}
          {selectedRowIds.length > 0 && (
            <div className="sticky bottom-2 z-10 mt-3 flex items-center justify-between gap-3 bg-white border border-blue-200 shadow-lg rounded-lg px-4 py-2.5">
              <span className="text-sm text-gray-700">已选 <b className="text-blue-600">{selectedRowIds.length}</b> 项</span>
              <Space>
                <Button variant="text" size="small" onClick={() => setSelectedRowIds([])}>
                  取消选择
                </Button>
                <Button theme="success" onClick={openBatchPublish}>
                  批量上架
                </Button>
              </Space>
            </div>
          )}

          <ImageViewer
            images={viewerImages}
            visible={viewerVisible}
            defaultIndex={viewerIndex}
            closeOnOverlay
            onClose={() => setViewerVisible(false)}
          />
        </Card>
      ) : (
        <Card title="已上架商品（可修改标题/描述/重量/尺寸/净利润/图片）" headerBordered>
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <Space>
              <Button variant="outline" onClick={fetchPublishedItems}>
                刷新
              </Button>
            </Space>
            <Space>
              <Select
                value={publishedSiteFilter}
                onChange={(v) => setPublishedSiteFilter(v as string)}
                options={[
                  { label: '全部站点', value: '' },
                  ...Object.keys(siteInfos).map((code) => ({
                    label: `${siteInfos[code].name} (${code})`,
                    value: code,
                  })),
                ]}
                style={{ width: 150 }}
                placeholder="站点筛选"
              />
              <Select
                value={publishedStoreFilter}
                onChange={(v) => setPublishedStoreFilter(v as string)}
                options={[
                  { label: '全部店铺', value: '' },
                  ...stores.map((s) => ({ label: s.nickname, value: s.id })),
                ]}
                style={{ width: 160 }}
                placeholder="店铺筛选"
              />
            </Space>
          </div>

          <Loading loading={publishedLoading} size="small">
            {publishedRows.length === 0 ? (
              <div className="text-sm text-gray-400 py-10 text-center">暂无已上架商品，去「AI 选品候选」标签上架吧</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-gray-50">
                    <tr className="text-left text-gray-600">
                      <th className="px-3 py-2 font-medium">图片</th>
                      <th className="px-3 py-2 font-medium">标题</th>
                      <th className="px-3 py-2 font-medium">SKU 编号</th>
                      <th className="px-3 py-2 font-medium">站点</th>
                      <th className="px-3 py-2 font-medium">店铺</th>
                      <th className="px-3 py-2 font-medium">价格</th>
                      <th className="px-3 py-2 font-medium">重量/尺寸</th>
                      <th className="px-3 py-2 font-medium">上架时间</th>
                      <th className="px-3 py-2 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {publishedRows.map((item) => {
                      const imgs = (item.picture_urls || '').split('|').filter(Boolean);
                      const pbs = (() => {
                        try {
                          const arr = JSON.parse(item.price_by_site || '[]');
                          return Array.isArray(arr) ? arr : [];
                        } catch {
                          return [];
                        }
                      })();
                      return (
                        <tr key={item.id} className="border-t hover:bg-gray-50">
                          <td className="px-3 py-2">
                            {imgs[0] ? (
                              <img
                                src={imgs[0]}
                                alt=""
                                className="w-12 h-12 object-cover rounded border border-gray-100 cursor-pointer hover:opacity-80"
                                onError={(e) => ((e.currentTarget as HTMLImageElement).src = FALLBACK_IMAGE)}
                                onClick={() => {
                                  setViewerImages(imgs);
                                  setViewerIndex(0);
                                  setViewerVisible(true);
                                }}
                              />
                            ) : (
                              <div className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-xs text-gray-400">无图</div>
                            )}
                          </td>
                          <td className="px-3 py-2 max-w-[240px]">
                            <div className="truncate" title={item.title}>{item.title || '-'}</div>
                            {item.ml_permalink && (
                              <a href={item.ml_permalink} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">查看</a>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-indigo-600 font-mono">{item.seller_sku || '-'}</td>
                          <td className="px-3 py-2"><Tag size="small">{item.site}</Tag></td>
                          <td className="px-3 py-2 text-xs">{stores.find((s) => s.id === item.store_id)?.nickname || item.store_id || '-'}</td>
                          <td className="px-3 py-2 text-xs">
                            {pbs.length ? (
                              pbs.map((p: any) => (
                                <div key={p.site_id}>{p.site_id}: ${Number(p.price || 0).toFixed(2)}</div>
                              ))
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-600">
                            {item.weight ? `${(item.weight / 1000).toFixed(2)}kg` : '-'}
                            {item.length ? ` / ${item.length}×${item.width}×${item.height}cm` : ''}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-500">
                            {item.published_at ? new Date(item.published_at).toLocaleString('zh-CN', { hour12: false }) : '-'}
                          </td>
                          <td className="px-3 py-2">
                            <Button size="small" theme="primary" variant="outline" onClick={() => openEditPublished(item)}>
                              修改
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Loading>

          <ImageViewer
            images={viewerImages}
            visible={viewerVisible}
            defaultIndex={viewerIndex}
            closeOnOverlay
            onClose={() => setViewerVisible(false)}
          />
        </Card>
      )}


      <Dialog
        visible={publishOpen}
        onClose={() => setPublishOpen(false)}
        header="商品详情预览"
        width={1100}
        style={{ maxWidth: '95vw' }}
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
          <div className="max-h-[78vh] overflow-auto pr-1 -mr-1">
            <div className="mb-3 text-xs text-gray-500 bg-blue-50 px-3 py-2 rounded">
              打开弹窗时已自动：①从 1688 读取重量/尺寸/SKU；②调用 AI 去背景+白底+水印；③按目标净利润反推售价。
              {publishDraft.ali1688Url && (
                <span className="ml-1">
                  货源：
                  <a href={publishDraft.ali1688Url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">
                    1688 商品链接
                  </a>
                </span>
              )}
            </div>

            <Collapse defaultValue={['basic', 'images', 'profit', 'stores']}>
              {/* 基础信息 */}
              <Collapse.Panel header="基础信息" value="basic">
                <div className="space-y-4">
                  <div className="grid grid-cols-12 gap-4">
                    <div className="col-span-8">
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
                    <div className="col-span-2">
                      <div className="text-sm font-medium mb-1">默认售价（USD）</div>
                      <InputNumber
                        value={publishDraft.listingPriceUsd}
                        onChange={(v) =>
                          setPublishDraft((prev) => {
                            if (!prev) return prev;
                            const price = Number(v) || 0;
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
                    <div className="col-span-2">
                      <div className="text-sm font-medium mb-1">库存</div>
                      <InputNumber
                        value={publishDraft.availableQuantity}
                        onChange={(v) => setPublishDraft((prev) => (prev ? { ...prev, availableQuantity: Number(v) || 0 } : prev))}
                        min={1}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">来源站点：</span>
                      <Tag size="small">{publishRow.site}</Tag>
                    </div>
                    <div>
                      <span className="text-gray-500">竞品售价：</span>
                      <span className="text-blue-600 font-medium">${publishRow.ml_price_usd?.toFixed(2)}</span>
                    </div>
                  </div>

                  <div className="border border-gray-100 rounded p-3 space-y-2 bg-gray-50/50">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">类目（CBT 上架类目，可修改）</span>
                      <Button size="small" variant="text" theme="primary" onClick={predictCategoryForTitle}>
                        按标题推荐类目
                      </Button>
                    </div>
                    <div className="text-xs text-gray-500">
                      当前类目：{publishDraft.categoryName || '-'}
                      {catPath && <span className="ml-1 text-indigo-600">（{catPath}）</span>}
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={catSearch}
                        onChange={(v) => {
                          setCatSearch(String(v));
                          searchCategory(String(v));
                        }}
                        placeholder="输入关键词搜索类目，如 phone / 手机"
                        className="flex-1"
                      />
                      {catLoading && <Loading size="small" loading />}
                    </div>
                    {catResults.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {catResults.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => onSelectCategory(c)}
                            className="text-xs px-2 py-1 rounded border border-gray-200 bg-white hover:border-blue-400 hover:bg-blue-50"
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {catPredict.length > 0 && (
                      <div>
                        <div className="text-xs text-gray-400 mb-1">推荐类目：</div>
                        <div className="flex flex-wrap gap-2">
                          {catPredict.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => onSelectCategory(c)}
                              className="text-xs px-2 py-1 rounded border border-green-200 text-green-700 bg-white hover:bg-green-50"
                            >
                              {c.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {catError && <div className="text-xs text-orange-600">{catError}</div>}
                  </div>
                </div>
              </Collapse.Panel>

              {/* 图片与 SKU */}
              <Collapse.Panel header="商品图片 & SKU" value="images">
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">商品图片（点击放大，后台已 AI 处理）</span>
                      <Space>
                        {aliFilling && <span className="text-xs text-gray-400">从1688补充中…</span>}
                        {aiEditing && <span className="text-xs text-gray-400">AI 编辑中…</span>}
                        <Button size="small" variant="text" theme="primary" loading={aliFilling} onClick={handleFetch1688Detail}>
                          重新获取1688信息
                        </Button>
                      </Space>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      {publishDraft.pictureUrls.map((url, idx) => (
                        <div key={`${url}-${idx}`} className="relative w-20 h-20 border rounded-lg overflow-hidden group hover:shadow-md transition-shadow">
                          <img
                            src={url}
                            alt=""
                            className="w-full h-full object-cover cursor-pointer"
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
                            className="absolute top-0 right-0 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-bl opacity-80 group-hover:opacity-100"
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

                  <div className="border-t border-dashed border-gray-200 pt-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium">SKU（规格，可从 1688 自动识别多个）</span>
                      <Button
                        size="small"
                        variant="text"
                        theme="primary"
                        onClick={() =>
                          setPublishDraft((prev) =>
                            prev ? { ...prev, skus: [...prev.skus, { title: '', imageUrl: '' }] } : prev
                          )
                        }
                      >
                        添加 SKU
                      </Button>
                    </div>
                    {publishDraft.skus.length === 0 ? (
                      <div className="text-xs text-gray-400 mb-2">
                        未从 1688 识别到 SKU（可能无 1688 商品 ID 或 AK 未配置）。可在「重新获取1688信息」后自动填充，或手动添加。
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {publishDraft.skus.map((sku, idx) => (
                          <div key={idx} className="flex items-center gap-2 border border-gray-100 rounded-lg p-2 bg-white hover:shadow-sm transition-shadow">
                            <div
                              className="w-12 h-12 border rounded overflow-hidden cursor-pointer flex-shrink-0"
                              onClick={() => {
                                if (sku.imageUrl) {
                                  setViewerImages([sku.imageUrl]);
                                  setViewerIndex(0);
                                  setViewerVisible(true);
                                }
                              }}
                            >
                              {sku.imageUrl ? (
                                <img src={sku.imageUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).src = FALLBACK_IMAGE; }} />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">无图</div>
                              )}
                            </div>
                            <Input
                              value={sku.title}
                              onChange={(v) =>
                                setPublishDraft((prev) =>
                                  prev ? { ...prev, skus: prev.skus.map((s, i) => (i === idx ? { ...s, title: String(v) } : s)) } : prev
                                )
                              }
                              placeholder="SKU 标题（型号/规格）"
                              className="flex-1"
                            />
                            <Button
                              size="small"
                              variant="text"
                              theme="danger"
                              onClick={() =>
                                setPublishDraft((prev) => (prev ? { ...prev, skus: prev.skus.filter((_, i) => i !== idx) } : prev))
                              }
                            >
                              删
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Collapse.Panel>

              {/* 重量 / 尺寸 / 质保 */}
              <Collapse.Panel header="重量 / 尺寸 / 质保" value="physical">
                <div className="space-y-4">
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

                  <div className="grid grid-cols-4 gap-4">
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
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
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
                </div>
              </Collapse.Panel>

              {/* 类目属性 */}
              {categoryAttributes.length > 0 && (
                <Collapse.Panel header="类目属性" value="attrs">
                  <div className="border border-gray-100 rounded p-3 space-y-3 bg-gray-50/30">
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
                                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
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
                </Collapse.Panel>
              )}

              {/* 商品描述 */}
              <Collapse.Panel header="商品描述" value="desc">
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
                    rows={5}
                    placeholder="西/葡语商品描述"
                  />
                </div>
              </Collapse.Panel>

              {/* 目标国家 / 利润 / 售价 */}
              <Collapse.Panel header="目标国家 / 利润 / 售价" value="profit">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-500">
                      运费按重量+尺寸自动测算；直接填「目标净利润」，系统自动算出上架售价。
                    </div>
                    {profitLoading && <div className="text-xs text-gray-400">测算中...</div>}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {targetSites.map((site) => {
                      const info = siteInfos[site];
                      const p = profitBySite[site];
                      const sitePrice = publishDraft.priceBySite[site] ?? publishDraft.listingPriceUsd;
                      const siteType = publishDraft.listingTypeBySite[site] ?? publishDraft.listingType;
                      const targetNet = targetNetBySite[site];
                      return (
                        <div key={site} className="border border-gray-200 rounded-lg p-3 bg-white hover:shadow-sm transition-shadow">
                          <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100">
                            <div className="font-medium text-sm">
                              {info?.name} <span className="text-gray-400 text-xs">({site})</span>
                            </div>
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
                              className="text-xs border border-gray-300 rounded px-1.5 py-0.5 bg-white"
                            >
                              <option value="gold_special">Classic</option>
                              <option value="gold_pro">Premium</option>
                              <option value="gold">Gold</option>
                              <option value="silver">Silver</option>
                            </select>
                          </div>
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-500">目标净利润</span>
                              <InputNumber
                                value={targetNet ?? undefined}
                                onChange={(v) =>
                                  reverseNetProfit(site, Number(v) || 0, {
                                    purchaseCostCny: publishRow ? publishRow.ali1688_price_cny || 0 : 0,
                                    weightKg: publishDraft.weightKg,
                                    lengthCm: publishDraft.lengthCm,
                                    widthCm: publishDraft.widthCm,
                                    heightCm: publishDraft.heightCm,
                                  })
                                }
                                decimalPlaces={2}
                                min={0}
                                style={{ width: 90 }}
                                size="small"
                              />
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-500">反推售价</span>
                              <span className="text-blue-600 font-medium">${sitePrice.toFixed(2)}</span>
                            </div>
                            <div className="grid grid-cols-4 gap-1 text-xs pt-2 border-t border-gray-100 mt-2">
                              <div className="text-center">
                                <div className="text-gray-400">净利润</div>
                                <div className={p && p.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}>
                                  {p ? `$${p.netProfit.toFixed(2)}` : '-'}
                                </div>
                              </div>
                              <div className="text-center">
                                <div className="text-gray-400">利润率</div>
                                <div>{p ? `${(p.netProfitRate * 100).toFixed(1)}%` : '-'}</div>
                              </div>
                              <div className="text-center">
                                <div className="text-gray-400">ROI</div>
                                <div>{p ? p.roi.toFixed(2) : '-'}</div>
                              </div>
                              <div className="text-center">
                                <div className="text-gray-400">佣金</div>
                                <div>{p && p.listingPriceUsd ? `${(p.costBreakdown.commission / p.listingPriceUsd * 100).toFixed(0)}%` : '-'}</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Collapse.Panel>

              {/* 目标店铺 / 高级设置 */}
              <Collapse.Panel header="目标店铺 / 高级设置" value="stores">
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-medium mb-2">选择要上架的目标店铺：</div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-auto border border-gray-100 rounded p-3 bg-gray-50/30">
                      {stores
                        .filter((s) => s.enabled && s.authorized)
                        .map((s) => (
                          <label key={s.id} className="flex items-center gap-2 cursor-pointer hover:bg-white p-1.5 rounded transition-colors">
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
                            <span className="text-sm">{s.nickname}</span>
                            <Tag size="small">{s.site}</Tag>
                          </label>
                        ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Switch value={useCbtCategory} onChange={(v) => setUseCbtCategory(v as boolean)} />
                    <span className="text-sm">使用 CBT 类目前缀（上架失败可关闭）</span>
                  </div>

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
                    提示：确认上架后，系统会按上方预览信息生成 Listing 并发布。
                  </div>
                </div>
              </Collapse.Panel>
            </Collapse>
          </div>
        )}
      </Dialog>

      {/* 上架结果详情弹窗 */}
      <Dialog
        visible={resultOpen}
        onClose={() => setResultOpen(false)}
        header="上架结果详情"
        width={720}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setResultOpen(false)}>
              关闭
            </Button>
            {publishResult?.succeeded > 0 && (
              <Button theme="primary" onClick={() => { setResultOpen(false); setPublishOpen(false); fetchRows(); }}>
                确定
              </Button>
            )}
          </div>
        }
      >
        {publishResult && (
          <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
            <div className="grid grid-cols-5 gap-3 text-center">
              <div className="bg-gray-50 p-3 rounded">
                <div className="text-xs text-gray-500">总计</div>
                <div className="font-medium text-lg">{publishResult.total || 0}</div>
              </div>
              <div className="bg-green-50 p-3 rounded">
                <div className="text-xs text-green-600">成功</div>
                <div className="font-medium text-lg text-green-700">{publishResult.succeeded || 0}</div>
              </div>
              <div className="bg-red-50 p-3 rounded">
                <div className="text-xs text-red-600">失败</div>
                <div className="font-medium text-lg text-red-700">{publishResult.failed || 0}</div>
              </div>
              <div className="bg-orange-50 p-3 rounded">
                <div className="text-xs text-orange-600">预检拦截</div>
                <div className="font-medium text-lg text-orange-700">{publishResult.blocked || 0}</div>
              </div>
              <div className="bg-blue-50 p-3 rounded">
                <div className="text-xs text-blue-600">跳过</div>
                <div className="font-medium text-lg text-blue-700">{publishResult.skipped || 0}</div>
              </div>
            </div>

            {publishResult.results && publishResult.results.length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">各店铺/站点明细</div>
                <div className="border border-gray-100 rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">站点</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">店铺</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">结果</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">ML Item ID / 链接</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">失败原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {publishResult.results.map((r: any, idx: number) => (
                        <tr key={idx} className="border-t">
                          <td className="px-3 py-2">
                            <Tag size="small">{r.site}</Tag>
                          </td>
                          <td className="px-3 py-2">
                            {stores.find((s) => s.id === r.storeId)?.nickname || r.storeId || '-'}
                          </td>
                          <td className="px-3 py-2">
                            {r.success ? (
                              <Tag theme="success" size="small">成功</Tag>
                            ) : r.skipped ? (
                              <Tag theme="warning" size="small">跳过</Tag>
                            ) : r.precheckHits?.length ? (
                              <Tag theme="warning" size="small">预检拦截</Tag>
                            ) : (
                              <Tag theme="danger" size="small">失败</Tag>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {r.permalink ? (
                              <a href={r.permalink} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline text-xs">
                                {r.itemId || '查看'}
                              </a>
                            ) : (
                              <span className="text-gray-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-red-600 max-w-[250px] break-words">
                            {r.error || (r.precheckHits?.length ? r.precheckHits.join('; ') : '') || (r.skipped ? r.error : '') || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(publishResult.blocked > 0 || publishResult.skipped > 0) && (
              <div className="text-xs text-orange-600 bg-orange-50 p-2 rounded">
                提示：预检拦截或跳过的站点不会消耗 ML API 配额。请根据失败原因修改商品信息后重试。
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* 批量上架弹窗 */}
      <Dialog
        visible={batchOpen}
        onClose={() => setBatchOpen(false)}
        header={`批量上架（已选 ${selectedRowIds.length} 项）`}
        width={640}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBatchOpen(false)}>
              取消
            </Button>
            <Button theme="success" loading={batching} onClick={handleBatchPublish}>
              确认批量上架
            </Button>
          </div>
        }
      >
        <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
          <div className="text-xs text-gray-500 bg-blue-50 p-2 rounded">
            批量上架将按每个候选自身的标题/图片/售价/SKU 上架到所选店铺。如需统一修改某字段，请单独打开「上架」预览。
          </div>
          <div>
            <div className="text-sm font-medium mb-2">选择要上架的目标店铺：</div>
            <div className="space-y-2 max-h-40 overflow-auto border border-gray-100 rounded p-2">
              {stores
                .filter((s) => s.enabled && s.authorized)
                .map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={batchStoreIds.includes(s.id)}
                      onChange={(e) => {
                        if (e.target.checked) setBatchStoreIds((prev) => [...prev, s.id]);
                        else setBatchStoreIds((prev) => prev.filter((id) => id !== s.id));
                      }}
                    />
                    <span>{s.nickname}</span>
                    <Tag size="small">{s.site}</Tag>
                  </div>
                ))}
              {stores.filter((s) => s.enabled && s.authorized).length === 0 && (
                <div className="text-xs text-gray-400">暂无可用店铺，请先到「店铺管理」添加并启用</div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm font-medium mb-1">默认刊登类型（应用于所有站点）</div>
              <select
                value={batchListingType}
                onChange={(e) => setBatchListingType(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              >
                <option value="gold_special">Classic（gold_special）</option>
                <option value="gold_pro">Premium（gold_pro）</option>
                <option value="gold">Gold</option>
                <option value="silver">Silver</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Switch value={useCbtCategory} onChange={(v) => setUseCbtCategory(v as boolean)} />
              <span className="text-sm">使用 CBT 类目前缀</span>
            </div>
          </div>
        </div>
      </Dialog>

      {/* 批量上架结果弹窗 */}
      <Dialog
        visible={batchResultOpen}
        onClose={() => setBatchResultOpen(false)}
        header="批量上架结果"
        width={680}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setBatchResultOpen(false)}>
              关闭
            </Button>
            {batchResult?.totalSucceeded > 0 && (
              <Button theme="primary" onClick={() => { setBatchResultOpen(false); setBatchOpen(false); fetchRows(); }}>
                确定
              </Button>
            )}
          </div>
        }
      >
        {batchResult && (
          <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="bg-green-50 p-3 rounded">
                <div className="text-xs text-green-600">成功站点数</div>
                <div className="font-medium text-lg text-green-700">{batchResult.totalSucceeded || 0}</div>
              </div>
              <div className="bg-red-50 p-3 rounded">
                <div className="text-xs text-red-600">失败站点数</div>
                <div className="font-medium text-lg text-red-700">{batchResult.totalFailed || 0}</div>
              </div>
            </div>
            {batchResult.perResult && (
              <div>
                <div className="text-sm font-medium mb-2">各候选明细</div>
                <div className="border border-gray-100 rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">候选 ID</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">结果</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-600">说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(batchResult.perResult).map(([id, r]: any) => (
                        <tr key={id} className="border-t">
                          <td className="px-3 py-2 text-xs">#{id}</td>
                          <td className="px-3 py-2">
                            {r.success ? (
                              <Tag theme="success" size="small">成功</Tag>
                            ) : (
                              <Tag theme="danger" size="small">失败</Tag>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-600">
                            {r.success
                              ? `站点成功 ${r.result?.succeeded || 0}，失败 ${r.result?.failed || 0}`
                              : r.message || '上架失败'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </Dialog>

      {/* 已上架商品修改弹窗 */}
      <Dialog
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        header="修改已上架商品"
        width={760}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button theme="primary" loading={editing} onClick={handleEditPublishedSave}>
              保存修改
            </Button>
          </div>
        }
      >
        {editItem && editDraft && (
          <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
            <div>
              <div className="text-sm font-medium mb-1">商品标题</div>
              <Input
                value={editDraft.title}
                onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, title: String(v) } : prev))}
              />
            </div>
            <div>
              <div className="text-sm font-medium mb-2">商品图片（点击可放大）</div>
              <div className="flex flex-wrap gap-2 mb-2">
                {editDraft.pictureUrls.map((url: string, idx: number) => (
                  <div key={`${url}-${idx}`} className="relative w-16 h-16 border rounded overflow-hidden group">
                    <img
                      src={url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => ((e.currentTarget as HTMLImageElement).src = FALLBACK_IMAGE)}
                      onClick={() => {
                        setViewerImages(editDraft.pictureUrls);
                        setViewerIndex(idx);
                        setViewerVisible(true);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setEditDraft((prev: any) =>
                          prev ? { ...prev, pictureUrls: prev.pictureUrls.filter((_: any, i: number) => i !== idx) } : prev
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
                  value={editDraft.newImageUrl}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, newImageUrl: String(v) } : prev))}
                  placeholder="https://...（添加图片 URL）"
                  className="flex-1"
                />
                <Button
                  size="small"
                  onClick={() => {
                    const url = (editDraft.newImageUrl || '').trim();
                    if (!url.startsWith('http')) {
                      MessagePlugin.warning('请输入有效的 http(s) 图片地址');
                      return;
                    }
                    setEditDraft((prev: any) =>
                      prev ? { ...prev, pictureUrls: Array.from(new Set([...prev.pictureUrls, url])), newImageUrl: '' } : prev
                    );
                  }}
                >
                  添加
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-1">品牌</div>
                <Input
                  value={editDraft.brand}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, brand: String(v) } : prev))}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">型号（Model）</div>
                <Input
                  value={editDraft.model}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, model: String(v) } : prev))}
                />
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              <div>
                <div className="text-sm font-medium mb-1">重量（kg）</div>
                <InputNumber
                  value={editDraft.weightKg}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, weightKg: Number(v) || 0 } : prev))}
                  decimalPlaces={3}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">长（cm）</div>
                <InputNumber
                  value={editDraft.lengthCm}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, lengthCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">宽（cm）</div>
                <InputNumber
                  value={editDraft.widthCm}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, widthCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-1">高（cm）</div>
                <InputNumber
                  value={editDraft.heightCm}
                  onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, heightCm: Number(v) || 0 } : prev))}
                  decimalPlaces={1}
                  min={0}
                />
              </div>
            </div>

            <div>
              <div className="text-sm font-medium mb-1">库存</div>
              <InputNumber
                value={editDraft.availableQuantity}
                onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, availableQuantity: Number(v) || 0 } : prev))}
                min={1}
              />
            </div>

            <div>
              <div className="text-sm font-medium mb-2">逐国家售价 / 产品类型 / 净利润</div>
              <div className="border border-gray-100 rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">国家</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">售价（USD）</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">产品类型</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">净利润</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(editDraft.priceBySite).map((site) => {
                      const info = siteInfos[site];
                      const ps = editDraft.priceBySite[site] || {};
                      return (
                        <tr key={site} className="border-t">
                          <td className="px-3 py-2">{info ? `${info.name} (${site})` : site}</td>
                          <td className="px-3 py-2">
                            <InputNumber
                              value={ps.price}
                              onChange={(v) =>
                                setEditDraft((prev: any) => ({
                                  ...prev,
                                  priceBySite: { ...prev.priceBySite, [site]: { ...prev.priceBySite[site], price: Number(v) || 0 } },
                                }))
                              }
                              decimalPlaces={2}
                              min={0}
                              style={{ width: 110 }}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={ps.listingType}
                              onChange={(e) =>
                                setEditDraft((prev: any) => ({
                                  ...prev,
                                  priceBySite: { ...prev.priceBySite, [site]: { ...prev.priceBySite[site], listingType: e.target.value } },
                                }))
                              }
                              className="border border-gray-300 rounded px-2 py-1 text-sm"
                            >
                              <option value="gold_special">Classic</option>
                              <option value="gold_pro">Premium</option>
                              <option value="gold">Gold</option>
                              <option value="silver">Silver</option>
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <label className="flex items-center gap-1 text-xs">
                              <input
                                type="checkbox"
                                checked={!!ps.netProceeds}
                                onChange={(e) =>
                                  setEditDraft((prev: any) => ({
                                    ...prev,
                                    priceBySite: { ...prev.priceBySite, [site]: { ...prev.priceBySite[site], netProceeds: e.target.checked } },
                                  }))
                                }
                              />
                              计算净利润
                            </label>
                          </td>
                        </tr>
                      );
                    })}
                    {Object.keys(editDraft.priceBySite).length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-3 text-center text-xs text-gray-400">无逐国家售价（上架时未记录）</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium">商品描述</span>
              </div>
              <Textarea
                value={editDraft.description}
                onChange={(v) => setEditDraft((prev: any) => (prev ? { ...prev, description: String(v) } : prev))}
                rows={4}
              />
            </div>

            <div className="text-xs text-gray-400 bg-yellow-50 p-2 rounded">
              提示：保存后将调用美客多修改接口更新该商品。标题、描述、图片、重量、尺寸、库存、品牌、型号及逐国家售价/净利润均可修改。
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

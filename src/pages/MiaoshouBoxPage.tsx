/**
 * src/pages/MiaoshouBoxPage.tsx
 * 妙手采集箱页面
 * 读取妙手美客多采集箱的「未发布」商品，表格展示，可多选预览，
 * 一键发布到选定店铺的选定站点（CBT 全球售）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Divider,
  Drawer,
  Image,
  Input,
  Loading,
  MessagePlugin,
  Pagination,
  Space,
  Table,
  Tabs,
  Tag,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import { FeatureIntro } from '../components/FeatureIntro';
import { Inbox, RefreshCw, Video, CloudUpload, Play, RotateCw } from 'lucide-react';

// ============ 类型定义 ============

interface MiaoshouBoxItem {
  collectBoxDetailId: string;
  itemNum: string | null;
  breadcrumb: string;
  cid: string;
  globalPrice: string;
  stock: string;
  price: string;
  thumbnail: string;
  gmtCreate: string;
  title: string;
  platform: string;
  appAccountId: string;
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    siteAndMaxPriceMap: Record<string, string>;
    siteAndMinPriceMap: Record<string, string>;
    siteAndPriceMap: Record<string, string>;
    sites: string[];
  };
  sourceList?: Array<{ source: string; sourceItemId: string; sourceItemUrl: string }>;
}

interface MiaoshouBoxDetail {
  title: string;
  itemNum: string | null;
  notesFull: string;
  notes: string;
  price: string;
  globalPrice: string;
  originPrice: string;
  cid: string;
  cateList: string[];
  breadcrumb: string;
  sourceImgUrls: string[];
  videoUrl?: string;
  mainImgVideoUrl?: string;
  source: string;
  sourceItemId: string;
  sourceItemUrl: string;
  skuMap?: Record<string, any>;
  attributes?: Array<{ name: string; valueType: string; values: string[] }>;
  siteAndListingTypeList?: string[];
  siteAndTitleList?: string[];
  pricingMode: string;
  siteAndPriceMap?: Record<string, string>;
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    sites: string[];
    siteAndPriceMap: Record<string, string>;
  };
}

interface Store {
  id: string;
  nickname: string;
  site: string;
  authorized: boolean;
  enabled: boolean;
}

interface PublishTarget {
  storeId: string;
  sites: string[];
}

const SITE_OPTIONS = [
  { label: '🇲🇽 墨西哥 MLM', value: 'MLM' },
  { label: '🇧🇷 巴西 MLB', value: 'MLB' },
  { label: '🇨🇱 智利 MLC', value: 'MLC' },
  { label: '🇨🇴 哥伦比亚 MCO', value: 'MCO' },
];

const SITE_LABEL: Record<string, string> = {
  MLM: '🇲🇽 墨西哥',
  MLB: '🇧🇷 巴西',
  MLC: '🇨🇱 智利',
  MCO: '🇨🇴 哥伦比亚',
};

/** 妙手 ERP 自己上架的商品在本系统里归到「妙手ERP」虚拟店铺，不占用真实店铺额度 */
const MIAOSHOU_STORE_KEY = 'miaoshou-erp';

// ML Clips 审核状态 → 中文（与后端 CLIP_STATUS_LABEL 保持一致）
const CLIP_LABEL: Record<string, string> = {
  UNDER_REVIEW: '待审核',
  PROCESSING: '处理中',
  UPLOADED: '已上传待处理',
  READY: '待发布',
  AVAILABLE: '已通过',
  PUBLISHED: '已通过',
  APPROVED: '已通过',
  LIVE: '已通过',
  REJECTED: '已拒绝',
  BLOCKED: '已拒绝',
  REMOVED: '已移除',
  FAILED: '失败',
  UPLOADING_ERROR: '上传失败',
  UPLOAD_ERROR: '上传失败',
  NOT_AVAILABLE: '不可用',
};
const CLIP_OK = ['AVAILABLE', 'PUBLISHED', 'APPROVED', 'LIVE'];
const CLIP_BAD = [
  'REJECTED', 'BLOCKED', 'FAILED', 'REMOVED',
  'UPLOADING_ERROR', 'UPLOAD_ERROR', 'NOT_AVAILABLE',
];

/** 视频综合状态标签：用于「已发布」列表逐店铺显示 */
function videoReviewTag(siteStatuses: Record<string, string> = {}): {
  label: string;
  theme: 'success' | 'warning' | 'danger' | 'default' | 'primary';
} {
  const vals = Object.values(siteStatuses).filter(Boolean) as string[];
  if (vals.length === 0) return { label: '待审核', theme: 'warning' };
  if (vals.every((v) => CLIP_OK.includes(v))) return { label: '视频已通过', theme: 'success' };
  if (vals.some((v) => CLIP_BAD.includes(v))) return { label: '视频被拒', theme: 'danger' };
  if (vals.some((v) => CLIP_OK.includes(v))) return { label: '部分通过', theme: 'warning' };
  return { label: '视频待审核', theme: 'warning' };
}

// ============ 主组件 ============

export function MiaoshouBoxPage() {
  // 数据状态
  const [items, setItems] = useState<MiaoshouBoxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastSyncTs, setLastSyncTs] = useState<number>(Date.now());

  // 分页
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // 搜索过滤
  const [searchKw, setSearchKw] = useState('');
  const [filteredItems, setFilteredItems] = useState<MiaoshouBoxItem[]>([]);

  // 多选
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionLoading, setSelectionLoading] = useState(false);

  // 店铺列表
  const [stores, setStores] = useState<Store[]>([]);

  // 详情抽屉
  const [detailItem, setDetailItem] = useState<MiaoshouBoxItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<MiaoshouBoxDetail | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);

  // 发布弹窗
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishResults, setPublishResults] = useState<any[]>([]);
  const [publishDone, setPublishDone] = useState(false);

  // 已发布记录（storeId|detailId → 记录），用于「已发布」标记与防重复发布
  const [publishedRecords, setPublishedRecords] = useState<Record<string, any>>({});
  // 当前 tab：未发布 / 已发布
  const [activeTab, setActiveTab] = useState<'unpublished' | 'published'>('unpublished');

  // 每行的发布目标（storeId → sites[]）
  const [targets, setTargets] = useState<Record<string, PublishTarget>>({});

  // 视频记录（后端按「上传时间倒序」返回，含服务器备份路径与 ML 审核状态）
  const [videoList, setVideoList] = useState<any[]>([]);
  const [videoBusy, setVideoBusy] = useState<Record<string, boolean>>({});
  const [videoRefreshingAll, setVideoRefreshingAll] = useState(false);
  const [syncingMs, setSyncingMs] = useState(false);
  // 视频预览弹窗
  const [videoView, setVideoView] = useState<{ detailId: string; title: string; size: number } | null>(null);

  // 快速取某「店铺 × 商品」的视频记录
  const videoMap = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of videoList) m[`${r.storeId}|${r.detailId}`] = r;
    return m;
  }, [videoList]);

  // ============ 加载采集箱列表 ============

  const loadBox = useCallback(async (force = false, keepPage = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: 'notPublished', filterCidSite: 'CBT' });
      if (force) params.set('refresh', '1');
      params.set('pageSize', '2000'); // 一次拉完，后端分页
      const resp = await fetch(`/api/ml/miaoshou/box?${params}`, {
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      const json = await resp.json();
      if (!json.success) throw new Error(json.message || '加载失败');
      setItems(json.items || []);
      setTotal(json.total || json.items?.length || 0);
      setLastSyncTs(Date.now());
      // 刷新后清掉「已不在妙手列表里」的勾选（妙手侧已删的 item 不再显示也不再可操作）
      setSelected((prev) => {
        const ids = new Set((json.items || []).map((it: any) => it.collectBoxDetailId));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next.size === prev.size ? prev : next;
      });
      if (!keepPage) setCurrent(1); // 刷新本页时保持当前页码，其余回第1页
    } catch (e: any) {
      MessagePlugin.error(e.message || '加载采集箱失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载店铺列表
  const loadStores = useCallback(async () => {
    try {
      const resp = await fetch('/api/ml/stores');
      const json = await resp.json();
      if (json.success) {
        setStores(json.stores.filter((s: Store) => s.authorized && s.enabled));
      }
    } catch {}
  }, []);

  // 加载已发布记录
  const loadPublished = useCallback(async () => {
    try {
      const resp = await fetch('/api/ml/miaoshou/published', {
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      const json = await resp.json();
      if (json.success) setPublishedRecords(json.records || {});
    } catch {}
  }, []);

  // 加载视频记录（上传状态 / ML 审核状态 / 服务器备份路径）
  const loadVideoRecords = useCallback(async () => {
    try {
      const resp = await fetch('/api/ml/miaoshou/video/records', {
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      const json = await resp.json();
      if (json.success) setVideoList(json.items || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadBox();
    loadStores();
    loadPublished();
    loadVideoRecords();
  }, [loadBox, loadStores, loadPublished, loadVideoRecords]);

  // 自动轮询：每 30 秒静默刷新一次列表，同步妙手侧最新的图片/SKU/属性修改
  // 后端缓存 TTL 10 秒，所以 30 秒轮询最多看到 10-30 秒前的数据，无需用户手动点刷新
  // 跳过条件：正在加载 / 正在发布 / 浏览器标签页不可见（省流量）
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      if (loading || publishLoading) return;
      loadBox(); // 不传 force，走后端 10 秒缓存；过期则实时拉妙手
      // 停留在「已发布」tab 时顺带刷新视频审核状态（ML 审核是异步的，需要自动跟进）
      if (activeTab === 'published' && videoList.length > 0 && !videoRefreshingAll) {
        loadVideoRecords();
      }
    }, 30 * 1000);
    return () => clearInterval(timer);
  }, [loadBox, loadVideoRecords, loading, publishLoading, activeTab, videoList, videoRefreshingAll]);

  // 某店铺是否已发布过某个采集箱商品（CBT 一店一品，重复发必然失败）
  const isPublished = (storeId: string, detailId: string) => {
    const rec = publishedRecords[`${storeId}|${detailId}`];
    return !!rec && rec.status !== 'failed';
  };

  // 该 detailId 在任一店铺成功发布过？（用于把「未发布」/「已发布」两个 tab 分开）
  const hasAnySuccess = (detailId: string) =>
    Object.values(publishedRecords).some(
      (r: any) => r.detailId === detailId && r.status === 'success'
    );

  // 该 detailId 的失败记录（用于「未发布」tab 标注「发布失败」红色标签）
  const getFailedRecords = (detailId: string) =>
    Object.values(publishedRecords).filter(
      (r: any) => r.detailId === detailId && r.status === 'failed'
    );

  // 「未发布」tab 数据源：妙手列表里「任一店铺都还没成功发布过」的商品
  const unpublishedItems = items.filter((it) => !hasAnySuccess(it.collectBoxDetailId));
  // 「已发布」tab 数据源：直接以 publishedRecords 为准（含本系统上架 + 妙手侧已上传），
  // 按 detailId 聚合后 join 妙手列表补全缩略图/标题，最后按「上传时间倒序」排列。
  // 注意：不能从 items 里 filter —— 发布成功后 save_move_collect_task 会把商品从妙手
  // 「未发布」列表移除，那时 items 里就没有它了，会导致「已发布」tab 变空。
  const publishedItems = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const r of Object.values(publishedRecords)) {
      if (!r || r.status !== 'success') continue;
      const arr = groups.get(r.detailId) || [];
      arr.push(r);
      groups.set(r.detailId, arr);
    }
    const list = [...groups.entries()].map(([detailId, records]) => {
      const it = items.find((i) => i.collectBoxDetailId === detailId);
      return {
        detailId,
        title: it?.title || records[0]?.title || `商品 ${detailId}`,
        breadcrumb: it?.breadcrumb || '',
        thumbnail: it?.thumbnail || '',
        records,
        item: it || null,
      };
    });
    // 上传顺序倒序：同一商品取最晚一条上架时间排序
    return list.sort((a, b) => {
      const ta = Math.max(...a.records.map((r: any) => r.publishedAt || 0));
      const tb = Math.max(...b.records.map((r: any) => r.publishedAt || 0));
      return tb - ta;
    });
  }, [publishedRecords, items]);

  // 搜索过滤（分页前过滤全部）—— 只过滤「未发布」tab 当前显示的数据源
  useEffect(() => {
    const source = unpublishedItems;
    if (!searchKw.trim()) {
      setFilteredItems(source);
    } else {
      const kw = searchKw.toLowerCase();
      setFilteredItems(
        source.filter(
          (it) =>
            it.title.toLowerCase().includes(kw) ||
            it.breadcrumb.toLowerCase().includes(kw) ||
            it.collectBoxDetailId.includes(kw)
        )
      );
    }
    setCurrent(1); // 搜索后回第1页
  }, [searchKw, unpublishedItems]);

  // 当前页数据
  const pagedItems = filteredItems.slice((current - 1) * pageSize, current * pageSize);

  // ============ 打开商品详情 ============

  const handlePreview = useCallback(async (item: MiaoshouBoxItem) => {
    setDetailItem(item);
    setDetailDrawerOpen(true);
    setDetailLoading(true);
    setDetailData(null);
    try {
      // 加时间戳参数 + no-cache 头，双重防浏览器缓存
      // 妙手侧改了图片/SKU/属性后，每次点「预览」都拿到最新数据
      const _t = Date.now();
      const resp = await fetch(
        `/api/ml/miaoshou/box/${item.collectBoxDetailId}/detail?shopId=${item.collectBoxDetailShop.shopId}&cid=${item.cid}&_t=${_t}`,
        { headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } }
      );
      const json = await resp.json();
      if (!json.success) throw new Error(json.message);
      setDetailData(json.detail);
    } catch (e: any) {
      MessagePlugin.error('加载详情失败: ' + (e.message || ''));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // ============ 全选 / 取消全选 ============

  const allChecked = filteredItems.length > 0 && selected.size === filteredItems.length;
  const someChecked = selected.size > 0 && selected.size < filteredItems.length;

  const toggleAll = () => {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredItems.map((it) => it.collectBoxDetailId)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  // ============ 初始化 targets（默认每个店铺全站点）============

  const initTargetsForItem = (item: MiaoshouBoxItem) => {
    const newTargets: Record<string, PublishTarget> = {};
    // 妙手配置的站点
    const shopSites: string[] = item.collectBoxDetailShop?.sites || [];
    // 映射：MX(Up) → MLM, BR(Up) → MLB ...
    const siteMap: Record<string, string> = {
      'MX(Up)': 'MLM',
      'BR(Up)': 'MLB',
      'CL(Up)': 'MLC',
      'CO(Up)': 'MCO',
    };
    const availableSites = shopSites
      .map((s) => siteMap[s] || s)
      .filter((s) => ['MLM', 'MLB', 'MLC', 'MCO'].includes(s));

    stores.forEach((store) => {
      // CBT 店铺可发任意站点：默认勾商品妙手配置的站点；未配置则全选 4 站
      const initSites =
        availableSites.length > 0 ? [...availableSites] : SITE_OPTIONS.map((o) => o.value);
      newTargets[store.id] = { storeId: store.id, sites: initSites };
    });
    return newTargets;
  };

  // 打开发布弹窗前，对所有选中商品初始化 targets
  const handleOpenPublish = () => {
    if (selected.size === 0) {
      MessagePlugin.warning('请先勾选要发布的商品');
      return;
    }
    // 以第一件的店铺配置初始化所有选中商品的 targets
    const firstItem = items.find((it) => selected.has(it.collectBoxDetailId));
    if (firstItem) {
      setTargets(initTargetsForItem(firstItem));
    }
    setPublishDone(false);
    setPublishResults([]);
    setPublishOpen(true);
  };

  // 切换某店铺的某个站点
  const toggleSite = (storeId: string, site: string) => {
    setTargets((prev) => {
      const t = prev[storeId] || { storeId, sites: [] };
      const sites = t.sites.includes(site)
        ? t.sites.filter((s) => s !== site)
        : [...t.sites, site];
      return { ...prev, [storeId]: { storeId, sites } };
    });
  };

  // 全选 / 取消某店铺所有站点
  const toggleAllSitesForStore = (storeId: string) => {
    const allSites = SITE_OPTIONS.map((o) => o.value);
    const current = targets[storeId]?.sites || [];
    const next = current.length === allSites.length ? [] : allSites;
    setTargets((prev) => ({ ...prev, [storeId]: { storeId, sites: next } }));
  };

  // ============ 执行发布 ============

  const handlePublish = async () => {
    const validTargets = Object.values(targets)
      .filter((t) => t.sites.length > 0)
      .map((t) => ({ storeId: t.storeId, sites: t.sites }));

    if (validTargets.length === 0) {
      MessagePlugin.warning('请至少选择一个店铺+站点的发布目标');
      return;
    }

    const selectedItems = items.filter((it) => selected.has(it.collectBoxDetailId));
    const payload = {
      items: selectedItems.map((it) => ({
        detailId: it.collectBoxDetailId,
        shopId: it.collectBoxDetailShop.shopId,
        cid: it.cid,
        // 详情接口的 price/globalPrice 字段经常缺失或异常，把列表值一并传给后端兜底
        price: it.price,
        globalPrice: it.globalPrice,
      })),
      targets: validTargets,
    };

    setPublishLoading(true);
    try {
      const resp = await fetch('/api/ml/miaoshou/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      if (!json.success && !json.results?.length) {
        throw new Error(json.message || '发布失败');
      }
      setPublishResults(json.results || []);
      setPublishDone(true);
      const ok = json.successCount || 0;
      const skip = json.alreadyPublishedCount || 0;
      const fail = json.failCount || 0;
      if (fail > 0 && ok === 0 && skip === 0) {
        // 全部失败：把后端返回的真实错误带出来，避免只看到笼统的「发布失败」
        const firstErr =
          json.results.find((r: any) => r.error)?.error || json.message || '未知错误';
        MessagePlugin.error('发布失败：' + firstErr);
      } else {
        const parts = [`成功 ${ok}`];
        if (skip) parts.push(`已存在 ${skip}`);
        if (fail) parts.push(`失败 ${fail}`);
        MessagePlugin.success('发布完成：' + parts.join('，'));
      }
      loadPublished();
    } catch (e: any) {
      MessagePlugin.error('发布失败: ' + (e.message || ''));
    } finally {
      setPublishLoading(false);
      // 发布完成（成功/失败/异常）后自动清空勾选，无需手动点「完成并刷新」
      setSelected(new Set());
      // 发布成功会触发视频自动处理，顺带拉一次视频记录
      loadVideoRecords();
    }
  };

  // 清除选中商品的「已发布」标记（用于已在美客多删除、需要重新发布时）
  const handleClearPublished = async () => {
    const detailIds = [...selected];
    const keys = stores
      .flatMap((s) => detailIds.map((d) => `${s.id}|${d}`))
      .filter((k) => publishedRecords[k]);
    if (keys.length === 0) {
      MessagePlugin.info('选中的商品没有已发布标记');
      return;
    }
    try {
      const resp = await fetch('/api/ml/miaoshou/published/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      const json = await resp.json();
      if (!json.success) throw new Error(json.message || '清除失败');
      MessagePlugin.success(`已清除 ${json.removed} 条已发布标记`);
      loadPublished();
    } catch (e: any) {
      MessagePlugin.error('清除失败: ' + (e.message || ''));
    }
  };

  // ============ 视频操作（上传 / 刷新 / 同步妙手） ============

  // 店铺展示名：真实店铺用昵称，虚拟店铺显示「妙手ERP」
  const storeNick = (storeId: string) =>
    storeId === MIAOSHOU_STORE_KEY
      ? '妙手ERP'
      : stores.find((s) => s.id === storeId)?.nickname || storeId.slice(0, 8);

  // 上传视频：后端自动下载 1688 视频 → 裁剪 9:16/去底部文字/限制时长 → 备份 → 传 ML Clips
  const handleUploadVideo = async (rec: any) => {
    if (!rec.itemId) {
      MessagePlugin.warning(`「${storeNick(rec.storeId)}」无 ML 商品 ID，无法上传视频`);
      return;
    }
    const key = `${rec.storeId}|${rec.detailId}`;
    setVideoBusy((p) => ({ ...p, [key]: true }));
    try {
      const resp = await fetch('/api/ml/miaoshou/video/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detailId: rec.detailId,
          itemId: rec.itemId,
          storeId: rec.storeId,
          sites: rec.sites,
          shopId: rec.shopId,
          title: rec.title,
        }),
      });
      const json = await resp.json();
      if (json.success) {
        MessagePlugin.success(`视频已提交 ${rec.itemId}，进入 ML 审核`);
      } else {
        MessagePlugin.error('视频上传失败：' + (json.error || json.message || '未知原因'));
      }
      loadVideoRecords();
      loadPublished();
    } catch (e: any) {
      MessagePlugin.error('视频上传异常：' + (e.message || ''));
    } finally {
      setVideoBusy((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    }
  };

  // 刷新单条：同步 ML 审核状态；若 ML 侧已无 clip（被拒/被删）会按失败原因自动重传
  const handleRefreshVideo = async (key: string) => {
    setVideoBusy((p) => ({ ...p, [key]: true }));
    try {
      const resp = await fetch('/api/ml/miaoshou/video/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const json = await resp.json();
      const r = json.record;
      if (json.success) {
        const tag = videoReviewTag(r?.siteStatuses || {});
        MessagePlugin.success(
          `刷新完成：${tag.label}` + (r?.error ? `（${r.error}）` : '')
        );
      } else {
        MessagePlugin.error('刷新失败：' + (json.error || ''));
      }
      loadVideoRecords();
    } catch (e: any) {
      MessagePlugin.error('刷新异常：' + (e.message || ''));
    } finally {
      setVideoBusy((p) => {
        const n = { ...p };
        delete n[key];
        return n;
      });
    }
  };

  // 批量刷新全部视频记录
  const handleRefreshAllVideo = async () => {
    if (videoList.length === 0) {
      MessagePlugin.info('暂无视频记录可刷新');
      return;
    }
    setVideoRefreshingAll(true);
    try {
      const resp = await fetch('/api/ml/miaoshou/video/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await resp.json();
      if (json.success) {
        MessagePlugin.success(
          `视频状态已刷新：共 ${json.total} 条（正常 ${json.done} / 失败 ${json.failed}）`
        );
      } else {
        MessagePlugin.error('批量刷新失败：' + (json.error || ''));
      }
      loadVideoRecords();
    } catch (e: any) {
      MessagePlugin.error('批量刷新异常：' + (e.message || ''));
    } finally {
      setVideoRefreshingAll(false);
    }
  };

  // 同步妙手侧已上传：妙手 ERP 有自己的上架限流对策，它自己上架的商品会从「未发布」
  // 列表消失，同步后在本系统「已发布」tab 显示并按上传时间倒序
  const handleSyncMiaoshou = async () => {
    setSyncingMs(true);
    try {
      const resp = await fetch('/api/ml/miaoshou/published/sync-miaoshou', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await resp.json();
      if (json.success) {
        setPublishedRecords(json.records || {});
        MessagePlugin.success(
          `妙手侧已上传 ${json.miaoshouPublished} 件：新增 ${json.added} 条 / 已有 ${json.skipped} 条`
        );
        loadVideoRecords();
      } else {
        MessagePlugin.error('同步妙手状态失败：' + (json.error || ''));
      }
    } catch (e: any) {
      MessagePlugin.error('同步异常：' + (e.message || ''));
    } finally {
      setSyncingMs(false);
    }
  };

  // ============ 表格列定义 ============

  const columns: PrimaryTableCol<MiaoshouBoxItem>[] = [
    {
      colKey: 'row-select',
      title: (
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked}
          onChange={toggleAll}
        />
      ),
      width: 48,
    },
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 80,
      cell({ row }) {
        return (
          <Image
            src={row.thumbnail}
            style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4 }}
            fit="cover"
            referrerPolicy="no-referrer"
          />
        );
      },
    },
    {
      colKey: 'title',
      title: '商品标题',
      ellipsis: { showTooltip: true },
      cell({ row }) {
        const pubStores = stores.filter((s) => isPublished(s.id, row.collectBoxDetailId));
        const failedRecs = getFailedRecords(row.collectBoxDetailId);
        const failedStores = failedRecs
          .map((r: any) => stores.find((s) => s.id === r.storeId)?.nickname || r.storeId)
          .filter(Boolean);
        return (
          <div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <div className="font-medium text-sm">{row.title}</div>
              {pubStores.length > 0 && (
                <Tag size="small" theme="success" variant="outline">
                  已发布：{pubStores.map((s) => s.nickname).join('/')}
                </Tag>
              )}
              {failedRecs.length > 0 && (
                <Tag
                  size="small"
                  theme="danger"
                  variant="light"
                  title={failedRecs.map((r: any) => `${stores.find((s) => s.id === r.storeId)?.nickname || r.storeId}: ${r.error}`).join('\n')}
                >
                  发布失败
                </Tag>
              )}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{row.breadcrumb}</div>
          </div>
        );
      },
    },
    {
      colKey: 'price',
      title: '全球净收益(USD)',
      width: 130,
      cell({ row }) {
        const p = parseFloat(row.globalPrice || row.price || '0');
        return (
          <span className="font-semibold text-orange-600">
            ${p.toFixed(2)}
          </span>
        );
      },
    },
    {
      colKey: 'stock',
      title: '库存',
      width: 70,
      cell({ row }) {
        return <Tag>{row.stock || '-'}</Tag>;
      },
    },
    {
      colKey: 'sites',
      title: '目标站点',
      width: 160,
      cell({ row }) {
        const shopSites: string[] = row.collectBoxDetailShop?.sites || [];
        const siteMap: Record<string, string> = {
          'MX(Up)': 'MLM',
          'BR(Up)': 'MLB',
          'CL(Up)': 'MLC',
          'CO(Up)': 'MCO',
        };
        return (
          <Space size={4}>
            {shopSites.map((s) => (
              <Tag key={s} theme="primary" variant="outline">
                {SITE_LABEL[siteMap[s] || s] || s}
              </Tag>
            ))}
            {shopSites.length === 0 && <span className="text-gray-400 text-xs">未配置</span>}
          </Space>
        );
      },
    },
    {
      colKey: 'gmtCreate',
      title: '采集时间',
      width: 140,
      cell({ row }) {
        const d = new Date(row.gmtCreate);
        return (
          <span className="text-xs text-gray-500">
            {d.toLocaleString('zh-CN')}
          </span>
        );
      },
    },
    {
      colKey: 'action',
      title: '操作',
      width: 80,
      fixed: 'right',
      cell({ row }) {
        return (
          <Button size="small" variant="text" onClick={() => handlePreview(row)}>
            预览
          </Button>
        );
      },
    },
  ];

  // ============ 渲染 ============

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部功能说明 */}
      <FeatureIntro
        icon={<Inbox size={20} />}
        title="妙手采集箱"
        defaultCollapsed
        content={
          <div className="text-sm leading-relaxed space-y-1">
            <p>
              从妙手 ERP 美客多「采集箱-未发布」列表拉取商品，在本系统预览、勾选后，
              通过您自己的 <strong>Mercado Libre CBT 官方通道</strong>直接上架到选定店铺，
              <strong>彻底绕开妙手共享 App 的 429 限流</strong>。
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-gray-600">
              <li>数据来源：妙手采集箱（状态=未发布，站点类型=CBT）</li>
              <li>发布通道：美客多 CBT 全球售 <code>POST /global/items</code></li>
              <li>价格单位：USD（全球净收益 globalPrice）</li>
              <li>发布间隔：每商品 1 秒节流，避免触发平台限流</li>
              <li>
                视频：1688 视频自动裁剪为 <strong>1080x1920 / 9:16 / 10-61 秒 / 含音频</strong>，
                上传美客多 Clips 并保留服务器备份；「已发布」tab 可查看视频、上传/重试视频、
                刷新审核状态（被拒会自动重传）
              </li>
              <li>
                妙手侧限流对策：点「同步妙手已上传」把妙手 ERP 自己上架的商品同步过来，
                「已发布」列表按上传时间倒序
              </li>
            </ul>
          </div>
        }
      />

      {/* 操作栏 */}
      <div className="flex items-center gap-3 px-5 py-3 flex-shrink-0">
        <Button
          icon={<Inbox size={16} />}
          onClick={() => loadBox(true)}
          loading={loading}
        >
          刷新列表
        </Button>
        <Button
          icon={<RefreshCw size={16} />}
          onClick={() => loadBox(true, true)}
          loading={loading}
          variant="outline"
        >
          刷新本页
        </Button>
        <Input
          placeholder="搜索标题 / 类目 / ID..."
          value={searchKw}
          onChange={(v) => setSearchKw(String(v))}
          style={{ width: 240 }}
          clearable
        />
        <span className="text-sm text-gray-500 ml-auto">
          {activeTab === 'unpublished'
            ? <>妙手未发布 {unpublishedItems.length} 件 · 搜索命中 {filteredItems.length} 件</>
            : <>已发布 {publishedItems.length} 件</>}
          {activeTab === 'unpublished' && selected.size > 0 && (
            <span className="ml-2 text-blue-600 font-medium">已选 {selected.size} 件</span>
          )}
          <span className="ml-3 text-xs text-gray-400" title="每 30 秒自动同步妙手最新数据">
            同步于 {new Date(lastSyncTs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </span>
        {activeTab === 'unpublished' && (
          <Button
            theme="primary"
            disabled={selected.size === 0}
            onClick={handleOpenPublish}
          >
            一键发布({selected.size})
          </Button>
        )}
      </div>

      {/* Tab 切换：未发布 / 已发布 */}
      {/* flex-1 + overflow-auto：在 flex-col 父容器内撑满剩余高度并可滚动 */}
      <div className="flex-1 min-h-0 overflow-auto">
      <Tabs
        value={activeTab}
        onChange={(v) => setActiveTab(v as 'unpublished' | 'published')}
        className="px-5"
      >
        <Tabs.TabPanel
          value="unpublished"
          label={`未发布 (${unpublishedItems.length})`}
        >
          <div className="px-5 pb-3 pt-2">
            <Table
              data={pagedItems}
              columns={columns}
              rowKey="collectBoxDetailId"
              loading={loading}
              hover
              stripe
              bordered
              selectedRowKeys={[...selected]}
              onSelectChange={(value) => setSelected(new Set(value as string[]))}
            />
            {/* 分页 */}
            {filteredItems.length > 0 && (
              <div className="flex justify-end mt-3">
                <Pagination
                  current={current}
                  pageSize={pageSize}
                  total={filteredItems.length}
                  showJumper
                  pageSizeOptions={[20, 50, 100, 200]}
                  onChange={({ current: c }) => setCurrent(c)}
                  onPageSizeChange={(size) => {
                    const firstItem = (current - 1) * pageSize;
                    setPageSize(size);
                    setCurrent(Math.floor(firstItem / size) + 1);
                  }}
                />
              </div>
            )}
            {unpublishedItems.length === 0 && !loading && (
              <div className="text-center py-10 text-gray-400 text-sm">
                妙手采集箱暂无未发布商品（妙手侧已删的会自动从列表移除）
              </div>
            )}
          </div>
        </Tabs.TabPanel>
        <Tabs.TabPanel
          value="published"
          label={`已发布 (${publishedItems.length})`}
        >
          <div className="px-5 pb-3 pt-2">
            {/* 已发布 tab 工具栏 */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <Button
                icon={<RotateCw size={16} />}
                onClick={handleSyncMiaoshou}
                loading={syncingMs}
                variant="outline"
              >
                同步妙手已上传
              </Button>
              <Button
                icon={<RefreshCw size={16} />}
                onClick={handleRefreshAllVideo}
                loading={videoRefreshingAll}
                variant="outline"
              >
                刷新视频状态
              </Button>
              <span className="text-xs text-gray-400">
                列表按上传时间倒序 · 视频记录 {videoList.length} 条
              </span>
              <span className="text-xs text-gray-400 ml-auto">
                {(() => {
                  const ok = videoList.filter((v) =>
                    videoReviewTag(v.siteStatuses).theme === 'success'
                  ).length;
                  const bad = videoList.filter((v) =>
                    videoReviewTag(v.siteStatuses).theme === 'danger'
                  ).length;
                  return `已通过 ${ok} · 待审核 ${videoList.length - ok - bad} · 被拒 ${bad}`;
                })()}
              </span>
            </div>

            {publishedItems.length === 0 ? (
              <div className="text-center py-10 text-gray-400 text-sm">
                暂无已发布记录。从「未发布」tab 勾选商品点击「一键发布」，
                或点「同步妙手已上传」导入妙手侧已上架的商品。
              </div>
            ) : (
              <div className="space-y-2">
                {publishedItems.map(({ detailId, title, breadcrumb, thumbnail, records }) => (
                  <div
                    key={detailId}
                    className="flex gap-3 p-3 bg-gray-50 rounded border"
                  >
                    {thumbnail ? (
                      <Image
                        src={thumbnail}
                        style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4 }}
                        fit="cover"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-[56px] h-[56px] shrink-0 rounded flex items-center justify-center bg-gray-200">
                        <Video size={22} className="text-gray-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{title}</span>
                        <Tag size="small" theme="success" variant="light">已上架</Tag>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{breadcrumb || `商品 ${detailId}`}</div>

                      {/* 每个店铺一行：上架信息 + 视频状态 + 操作 */}
                      <div className="mt-1.5 space-y-1">
                        {records.map((r: any) => {
                          const key = `${r.storeId}|${r.detailId}`;
                          const vrec = videoMap[key];
                          const busy = videoBusy[key];
                          const fromMs = r.source === 'miaoshou';
                          const tag = vrec ? videoReviewTag(vrec.siteStatuses) : null;
                          const hasBackup = !!vrec?.hasBackup;
                          return (
                            <div
                              key={key}
                              className="flex items-center gap-2 flex-wrap text-xs bg-white rounded px-2 py-1 border"
                            >
                              <Tag size="small" variant="outline">
                                {storeNick(r.storeId)}
                                {r.sites?.length ? `·${r.sites.join('/')}` : ''}
                              </Tag>
                              {fromMs ? (
                                <Tag size="small" theme="primary" variant="light">
                                  妙手ERP已上传
                                </Tag>
                              ) : r.itemId ? (
                                <a
                                  href={r.permalink || ''}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 underline break-all"
                                >
                                  {r.itemId}
                                </a>
                              ) : (
                                <span className="text-gray-400">无商品ID</span>
                              )}

                              {/* 视频状态 */}
                              {fromMs ? (
                                <span className="text-gray-400">视频状态未知</span>
                              ) : !vrec ? (
                                <Tag size="small" variant="light">📹 未上传视频</Tag>
                              ) : vrec.status === 'failed' ? (
                                <Tag
                                  size="small"
                                  theme="danger"
                                  variant="light"
                                  title={`${vrec.error || ''}\n阶段: ${vrec.stage || '-'}`}
                                >
                                  📹 失败
                                </Tag>
                              ) : (
                                <Tag size="small" theme={tag!.theme} variant="light" title={vrec.clipUuid}>
                                  📹 {tag!.label}
                                  {Object.values(vrec.siteStatuses || {})
                                    .filter(Boolean)
                                    .length > 0 &&
                                    `（${Object.entries(vrec.siteStatuses)
                                      .filter(([, v]) => v)
                                      .map(([k, v]) => `${k}:${CLIP_LABEL[v] || v}`)
                                      .join(' ')}）`}
                                </Tag>
                              )}

                              <span className="ml-auto flex items-center gap-1">
                                {hasBackup && (
                                  <Button
                                    size="small"
                                    variant="text"
                                    onClick={() =>
                                      setVideoView({
                                        detailId: String(r.detailId),
                                        title: title || String(r.detailId),
                                        size: vrec.backupSize || 0,
                                      })
                                    }
                                  >
                                    <Play size={12} className="inline mr-0.5" />
                                    查看视频
                                  </Button>
                                )}
                                {r.itemId && (
                                  <Button
                                    size="small"
                                    variant="text"
                                    loading={busy}
                                    onClick={() => handleUploadVideo(r)}
                                  >
                                    <CloudUpload size={12} className="inline mr-0.5" />
                                    {vrec?.status === 'failed' ||
                                    (tag && tag.theme === 'danger')
                                      ? '重传视频'
                                      : '上传视频'}
                                  </Button>
                                )}
                                {vrec && (
                                  <Button
                                    size="small"
                                    variant="text"
                                    loading={busy}
                                    onClick={() => handleRefreshVideo(key)}
                                  >
                                    <RefreshCw size={12} className="inline mr-0.5" />
                                    刷新视频
                                  </Button>
                                )}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="text-right shrink-0 self-start">
                      <div className="text-xs text-gray-500">
                        {new Date(records[0]?.publishedAt).toLocaleString('zh-CN')}
                      </div>
                      {records[0]?.permalink && (
                        <a
                          href={records[0].permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 underline text-xs block mt-1"
                        >
                          查看 ML 链接
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Tabs.TabPanel>
      </Tabs>
      </div>

      {/* 商品详情抽屉 */}
      <Drawer
        header="商品详情预览"
        visible={detailDrawerOpen}
        onClose={() => setDetailDrawerOpen(false)}
        size="640px"
        footer={null}
      >
        {detailLoading ? (
          <div className="flex justify-center py-20">
            <Loading />
          </div>
        ) : detailData ? (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              {/* 主图优先用 SKU 编辑后的第一张图，回退到 sourceImgUrls */}
              {(() => {
                const skuImgs: string[] = [];
                for (const v of Object.values(detailData.skuMap || {})) {
                  const sv = v as any;
                  if (sv.isDelete) continue;
                  for (const u of sv.imgUrls || []) {
                    if (!skuImgs.includes(u)) skuImgs.push(u);
                  }
                }
                const mainImg = skuImgs[0] || detailData.sourceImgUrls?.[0] || detailItem?.thumbnail || '';
                return (
                  <Image
                    src={mainImg}
                    style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }}
                    fit="cover"
                    referrerPolicy="no-referrer"
                  />
                );
              })()}
              <div className="flex-1">
                <div className="font-semibold text-base">{detailData.title}</div>
                <div className="text-sm text-gray-500 mt-1">{detailData.breadcrumb}</div>
                <div className="flex gap-3 mt-2">
                  <Tag theme="success">全球净收益 ${parseFloat(detailData.globalPrice || '0').toFixed(2)}</Tag>
                  <Tag theme="warning">货源价 ¥{detailData.originPrice || detailData.price}</Tag>
                  <Tag>库存 {detailData.stock || '-'}</Tag>
                </div>
              </div>
            </div>

            {/* 商品图片：优先显示 SKU 编辑后的图，再显示货源全部图 */}
            {(() => {
              const skuImgs: string[] = [];
              for (const v of Object.values(detailData.skuMap || {})) {
                const sv = v as any;
                if (sv.isDelete) continue;
                for (const u of sv.imgUrls || []) {
                  if (!skuImgs.includes(u)) skuImgs.push(u);
                }
              }
              const allImgs = skuImgs.length > 0 ? skuImgs : (detailData.sourceImgUrls || []);
              if (!allImgs.length) return null;
              return (
                <div>
                  <div className="text-sm font-medium mb-2">
                    商品图片（{skuImgs.length > 0 ? `妙手编辑 ${skuImgs.length} 张` : `货源原始 ${allImgs.length} 张`}）
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {allImgs.slice(0, 9).map((url, i) => (
                      <Image
                        key={i}
                        src={url}
                        style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 4 }}
                        fit="cover"
                        referrerPolicy="no-referrer"
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 描述：优先显示 notes（妙手编辑后的英文），notesFull 作为「货源原始描述」折叠 */}
            {detailData.notes && (
              <div>
                <div className="text-sm font-medium mb-1">商品描述</div>
                <div
                  className="text-sm text-gray-600 p-3 rounded bg-gray-50"
                  style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}
                >
                  {detailData.notes}
                </div>
              </div>
            )}
            {detailData.notesFull && detailData.notesFull !== detailData.notes && (
              <details>
                <summary className="text-sm text-gray-400 cursor-pointer hover:text-gray-600">
                  货源原始描述（1688 快照，未编辑）
                </summary>
                <div
                  className="text-sm text-gray-500 p-3 rounded bg-gray-50 mt-1"
                  style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}
                >
                  {detailData.notesFull}
                </div>
              </details>
            )}

            {/* SKU 明细：尺寸/重量/库存（妙手编辑过的数据，发布时原样传美客多 PACKAGE_* 属性） */}
            {(() => {
              const skuEntries = Object.entries(detailData.skuMap || {}).filter(
                ([, v]: any) => !v.isDelete
              );
              if (skuEntries.length === 0) return null;
              return (
                <div>
                  <div className="text-sm font-medium mb-2">
                    SKU 明细（{skuEntries.length} 个，发布时尺寸/重量写入包裹属性）
                  </div>
                  <div className="space-y-2">
                    {skuEntries.map(([k, v]: any, i: number) => (
                      <div key={k} className="p-2 bg-gray-50 rounded text-xs space-y-1">
                        <div className="flex items-center gap-2">
                          {v.imgUrls?.[0] && (
                            <Image
                              src={v.imgUrls[0]}
                              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 3 }}
                              fit="cover"
                              referrerPolicy="no-referrer"
                            />
                          )}
                          <span className="font-medium">{v.itemNum || `SKU ${i + 1}`}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
                          <span>库存：{v.stock ?? '-'}</span>
                          <span>货源价：{v.originPrice != null ? `¥${v.originPrice}` : '-'}</span>
                          <span>
                            尺寸：{[v.length, v.width, v.height].filter(Boolean).join('×') || '-'}
                            {v.lengthWidthHeightUnit ? ` ${v.lengthWidthHeightUnit}` : ''}
                          </span>
                          <span>
                            重量：{v.weight || '-'}
                            {v.weightUnit ? ` ${v.weightUnit}` : ''}
                          </span>
                          {v.upc && <span>UPC：{v.upc}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {detailData.sourceItemUrl && (
              <div>
                <div className="text-sm font-medium mb-1">货源链接</div>
                <a
                  href={detailData.sourceItemUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 underline break-all"
                >
                  {detailData.sourceItemUrl}
                </a>
              </div>
            )}

            {detailData.siteAndPriceMap && Object.keys(detailData.siteAndPriceMap).length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">各站点定价</div>
                <div className="space-y-1">
                  {Object.entries(detailData.siteAndPriceMap).map(([site, price]) => {
                    const msToMl: Record<string,string> = {'MX(Up)':'MLM','BR(Up)':'MLB','CL(Up)':'MLC','CO(Up)':'MCO'};
                    const ml = msToMl[site] || site;
                    const priceNum = parseFloat(price as string);
                    return (
                      <div key={site} className="flex justify-between text-sm p-2 bg-gray-50 rounded">
                        <span>{SITE_LABEL[ml] || site}</span>
                        <span className="font-medium">
                          {priceNum > 0 ? `$${priceNum.toFixed(2)} USD` : <span className="text-gray-400">未设置（用全球净收益兜底）</span>}
                        </span>
                      </div>
                    );
                  })}
                  <div className="text-xs text-gray-400 mt-1">
                    定价模式：{detailData.pricingMode === 'netProceeds' ? '净收益定价（netProceeds）' : detailData.pricingMode}
                    {' · 空值站点将用全球净收益 $'}{parseFloat(detailData.globalPrice || '0').toFixed(2)}{' 兜底'}
                  </div>
                </div>
              </div>
            )}

            {detailItem && (
              <div>
                <Button
                  theme="primary"
                  onClick={() => {
                    toggleOne(detailItem.collectBoxDetailId);
                  }}
                  className="mr-2"
                >
                  {selected.has(detailItem.collectBoxDetailId) ? '取消勾选' : '勾选此商品'}
                </Button>
                <Button
                  disabled={!selected.has(detailItem.collectBoxDetailId)}
                  onClick={() => {
                    setDetailDrawerOpen(false);
                    handleOpenPublish();
                  }}
                >
                  发布已选商品
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>

      {/* 发布弹窗 */}
      <Dialog
        header="一键发布到美客多"
        visible={publishOpen}
        onClose={() => !publishLoading && setPublishOpen(false)}
        footer={null}
        width={640}
      >
        {!publishDone ? (
          <div className="space-y-4">
            <div className="bg-blue-50 rounded p-3 text-sm text-blue-700">
              即将发布 <strong>{selected.size}</strong> 件商品到以下店铺
            </div>

            {stores.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                暂无已授权店铺，请先在「店铺管理」添加并授权
              </div>
            ) : (
              <div className="space-y-3">
                {stores.map((store) => {
                  const currentSites = targets[store.id]?.sites || [];
                  const checked = currentSites.length === SITE_OPTIONS.length;
                  const someChecked = currentSites.length > 0;
                  const selIds = [...selected];
                  const already = selIds.filter((d) => isPublished(store.id, d));
                  const allAlready = selIds.length > 0 && already.length === selIds.length;
                  return (
                    <Card key={store.id} size="small" className="border">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <Checkbox
                          checked={checked}
                          indeterminate={someChecked && !checked}
                          disabled={allAlready}
                          onChange={() => toggleAllSitesForStore(store.id)}
                        />
                        <span className="font-medium text-sm">
                          {store.nickname}
                        </span>
                        <Tag size="small">CBT</Tag>
                        {already.length > 0 && (
                          <Tag size="small" theme="warning">
                            {allAlready
                              ? '所选商品均已发布'
                              : `已有 ${already.length}/${selIds.length} 件已发布`}
                          </Tag>
                        )}
                      </div>
                      {allAlready ? (
                        <div className="text-xs text-gray-500 ml-7">
                          所选商品在本店均已上架。美客多 CBT 一店一品，重复发布会报
                          listing.conflict；如需重新上架，请先点左下角「清除已发布标记」，
                          并确认商品已在美客多后台删除。
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 ml-7">
                          {SITE_OPTIONS.map((opt) => (
                            <Checkbox
                              key={opt.value}
                              checked={currentSites.includes(opt.value)}
                              onChange={() => toggleSite(store.id, opt.value)}
                              label={opt.label}
                            />
                          ))}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}

            <Divider />

            <div className="flex justify-between gap-3 items-center">
              <Button size="small" variant="text" theme="danger" onClick={handleClearPublished}>
                清除已发布标记
              </Button>
              <div className="flex gap-3">
                <Button onClick={() => setPublishOpen(false)} disabled={publishLoading}>
                  取消
                </Button>
                <Button
                  theme="primary"
                  loading={publishLoading}
                  onClick={handlePublish}
                  disabled={stores.length === 0}
                >
                  确认发布
                </Button>
              </div>
            </div>
          </div>
        ) : (
          // 发布结果
          <div className="space-y-3">
            <div className="flex gap-3 flex-wrap">
              <Tag theme="success">
                成功 {publishResults.filter((r) => r.success).length}
              </Tag>
              {publishResults.some((r) => r.alreadyPublished) && (
                <Tag theme="warning">
                  已存在（未重复上架）
                  {publishResults.filter((r) => r.alreadyPublished).length}
                </Tag>
              )}
              <Tag theme="danger">
                失败 {publishResults.filter((r) => !r.success && !r.alreadyPublished).length}
              </Tag>
            </div>
            <div className="max-h-80 overflow-y-auto space-y-2">
              {publishResults.map((r, i) => {
                const isAlready = !!r.alreadyPublished;
                const rowCls = r.success
                  ? 'bg-green-50'
                  : isAlready
                  ? 'bg-amber-50'
                  : 'bg-red-50';
                return (
                  <div key={i} className={`p-2 rounded text-sm ${rowCls}`}>
                    <div className="flex justify-between items-center gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium shrink-0">{r.storeNick}</span>
                        <Tag size="small">{r.site}</Tag>
                      </div>
                      {r.success ? (
                        r.permalink ? (
                          <a
                            href={r.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline text-xs shrink-0"
                          >
                            查看
                          </a>
                        ) : (
                          <Tag theme="success" size="small">已上架</Tag>
                        )
                      ) : isAlready ? (
                        r.permalink ? (
                          <a
                            href={r.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline text-xs shrink-0"
                          >
                            查看
                          </a>
                        ) : (
                          <Tag theme="warning" size="small">已存在</Tag>
                        )
                      ) : (
                        <Tag theme="danger" size="small">失败</Tag>
                      )}
                    </div>
                    {r.error && (
                      <div
                        className={`mt-1 text-xs break-all ${
                          isAlready ? 'text-amber-700' : 'text-red-600'
                        }`}
                      >
                        {r.error}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <Divider />
            <div className="flex justify-end gap-3">
              <Button
                onClick={() => {
                  setPublishOpen(false);
                  setSelected(new Set());
                  loadBox();
                  loadPublished();
                }}
              >
                完成并刷新
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* 视频预览弹窗（播放服务器备份的合规视频） */}
      <Dialog
        header="视频预览（服务器备份）"
        visible={!!videoView}
        onClose={() => setVideoView(null)}
        footer={null}
        width={420}
      >
        {videoView && (
          <div className="space-y-2">
            <div className="text-sm font-medium truncate">{videoView.title}</div>
            <video
              src={`/api/ml/miaoshou/video/file/${videoView.detailId}`}
              controls
              autoPlay
              style={{
                width: '100%',
                maxHeight: 560,
                borderRadius: 8,
                background: '#000',
              }}
            />
            <div className="text-xs text-gray-400">
              {videoView.size > 0
                ? `备份大小 ${(videoView.size / 1024 / 1024).toFixed(2)} MB · 1080x1920 9:16 已符合 ML Clips 要求`
                : '已符合 ML Clips 要求（1080x1920 / 9:16 / 含音频 / 10-61 秒）'}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

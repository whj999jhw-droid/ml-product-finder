/**
 * src/pages/ProductManagerPage.tsx
 * 商品管理页（重做版）
 *
 * 需求：
 *  1. 分店铺展示全部商品（店铺 Tab）
 *  2. 可筛选「正在上架 / 已暂停(被禁止) / 违规风险商品」
 *  3. 违规风险商品可「一键改为符合规范」
 *  4. 商品详情弹窗展示全部字段
 *  5. 保留原搜索框与搜索功能
 *  6. 左右留白收窄、紧凑布局、小屏可用
 *
 * ⚠️ 平台事实（2026-09-17 实测，别推翻）：
 *  CBT 商品对本店 token 是「只读」的 —— PUT /items/{CBT} 报 400、PUT /marketplace/items 报 405、
 *  本地站点商品报 403、DELETE 报 405。所以「改标题/改价/改图」不能直接改原链接；
 *  唯一可行的合规化路径是**克隆清洗重发**（POST /global/items 建一条新链接），
 *  原链接仍需到美客多后台人工暂停/删除 —— 界面上已明确提示。
 *  命中影视/动漫/游戏 IP 或体育赛事词的商品无法靠改名规避（卖的就是 IP 本身），只能下架。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  Input,
  MessagePlugin,
  Pagination,
  Progress,
  Select,
  Space,
  Switch,
  Textarea,
  InputNumber,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Loading,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  RefreshCw,
  SearchIcon,
  Shield,
  ShieldAlert,
  Wand2,
  Download,
} from 'lucide-react';
import { Lightbox } from '../components/Lightbox';

// ============ 类型 ============

interface RiskFieldHit {
  id?: string;
  name?: string;
  value: string;
  hits: string[];
}
interface StoreItemRisk {
  level: 'none' | 'platform' | 'brand' | 'ip';
  hits: string[];
  titleHits: string[];
  attrHits: RiskFieldHit[];
  fixable: boolean;
  message: string;
}
interface StoreItemRow {
  id: string;
  title: string;
  status: string;
  subStatus: string[];
  price: number;
  currencyId: string;
  availableQuantity: number;
  soldQuantity: number;
  condition?: string;
  listingTypeId?: string;
  categoryId?: string;
  sellerSku?: string;
  brand?: string;
  model?: string;
  thumbnail: string;
  pictures: string[];
  siteItemIds: string[];
  dateCreated?: string;
  lastUpdated?: string;
  risk: StoreItemRisk;
  miaoshouDetailId?: string;
  /** 站点级真实售卖状态（MLM/MLB/MLC/MCO → active|paused|inactive） */
  siteStatus?: Record<string, 'active' | 'paused' | 'inactive' | 'unknown'>;
  activeSites?: string[];
  pausedSites?: string[];
  inactiveSites?: string[];
  /** 至少一个站点在售（买家真能看到）；undefined = 该店还没拉到站点数据 */
  onSale?: boolean;
  /** 被美客多禁止的站点（ML 标记 forbidden） */
  blockedSites?: string[];
  /** 审核中但未被禁的站点 */
  reviewSites?: string[];
  /** 中文原因，如「MLM 被美客多禁止」 */
  reasons?: string[];
  /** 同款重复链接数（同一 SKU 被重复上架） */
  dupCount?: number;
}
interface IndexStore {
  storeId: string;
  storeNick: string;
  site: string;
  built: boolean;
  builtAt: number;
  building: boolean;
  progress: { done: number; total: number };
  counts: {
    total: number;
    active: number;
    paused: number;
    risk: number;
    riskIp: number;
    riskBrand: number;
    riskPlatform: number;
  } | null;
  error?: string;
}
interface FullDetail {
  row: StoreItemRow | null;
  siteStatus?: {
    sites: Record<string, 'active' | 'paused' | 'inactive' | 'unknown'>;
    siteItems: Array<{ siteId: string; itemId: string; userId: number; logisticType: string; state: string }>;
    activeSites: string[];
    pausedSites: string[];
    inactiveSites: string[];
    onSale: boolean;
  } | null;
  raw: any;
  description: string;
  marketplaceItems: any[];
  permalink: string;
  risk: StoreItemRisk;
  suggested: { title: string; attributeChanges: Array<{ id?: string; name?: string; from: string; to: string }> };
  _errors?: string[];
}
interface FixResult {
  itemId: string;
  title?: string;
  ok: boolean;
  skipped?: boolean;
  dry?: boolean;
  newId?: string;
  mode?: string;
  changes?: string[];
  preview?: { title: string; attributeChanges: any[] };
  newSites?: string[];
  siteErrors?: Array<{ site: string; msg: string }>;
  error?: string;
}

const SITE_NAME: Record<string, string> = {
  MLM: '墨西哥',
  MLB: '巴西',
  MLC: '智利',
  MCO: '哥伦比亚',
  MLA: '阿根廷',
  MLU: '乌拉圭',
};
const SITE_STATE_LABEL: Record<string, string> = {
  active: '在售',
  paused: '已暂停',
  inactive: '未激活',
  unknown: '未知',
};

/** 站点级状态徽标：每个站点一个小标签（在售绿 / 已暂停灰 / 未激活红） */
function SiteBadges({
  row,
  size = 'small',
}: {
  row: Pick<
    StoreItemRow,
    | 'siteStatus'
    | 'activeSites'
    | 'pausedSites'
    | 'inactiveSites'
    | 'onSale'
    | 'blockedSites'
    | 'reviewSites'
    | 'reasons'
  >;
  size?: 'small' | 'mini';
}) {
  const st = row.siteStatus;
  if (!st || !Object.keys(st).length) {
    return <span className="text-[11px] text-gray-400">站点状态待拉取</span>;
  }
  const cls = size === 'mini' ? 'text-[10px] px-1 py-[1px]' : 'text-[11px] px-1.5 py-[1px]';
  const blocked = new Set(row.blockedSites || []);
  const reviewing = new Set(row.reviewSites || []);
  const tipBase = row.reasons?.length ? ' · ' + row.reasons.join('；') : '';
  return (
    <span className="inline-flex flex-wrap gap-1 items-center">
      {Object.entries(st).map(([site, state]) => {
        const b = blocked.has(site);
        const r = reviewing.has(site);
        const label =
          state === 'active' ? '在售' : b ? '被禁止' : r ? '审核中' : state === 'paused' ? '已暂停' : '未激活';
        return (
          <span
            key={site}
            title={`${SITE_NAME[site] || site}：${label}${tipBase}`}
            className={`${cls} rounded border ${
              state === 'active'
                ? 'border-green-300 bg-green-50 text-green-700'
                : b
                  ? 'border-red-300 bg-red-100 text-red-700'
                  : r
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : state === 'paused'
                      ? 'border-gray-300 bg-gray-50 text-gray-500'
                      : 'border-red-300 bg-red-50 text-red-600'
            }`}
          >
            {site} {label}
          </span>
        );
      })}
      {(row.blockedSites || []).length > 0 && (
        <span
          className={`${cls} rounded border border-red-400 bg-red-600 text-white font-medium`}
          title={'这些站点被美客多标记为 forbidden，买家完全看不到' + tipBase}
        >
          🚫 已被美客多禁止 {(row.blockedSites || []).length} 站
        </span>
      )}
      {row.onSale === false && (row.blockedSites || []).length === 0 && (
        <span className={`${cls} rounded border border-red-300 bg-red-100 text-red-700 font-medium`} title="所有站点都未激活 —— 买家看不到">
          全部未激活
        </span>
      )}
    </span>
  );
}

const RISK_LABEL: Record<string, { label: string; theme: any }> = {
  none: { label: '无风险', theme: 'success' },
  platform: { label: '平台违禁词', theme: 'warning' },
  brand: { label: '品牌词', theme: 'warning' },
  ip: { label: 'IP/赛事（不可洗）', theme: 'danger' },
};

const STATUS_LABEL: Record<string, { label: string; theme: any }> = {
  active: { label: '正在上架', theme: 'success' },
  paused: { label: '已暂停', theme: 'warning' },
  closed: { label: '已关闭', theme: 'default' },
  under_review: { label: '审核中', theme: 'warning' },
  inactive: { label: '未激活', theme: 'default' },
  not_yet_active: { label: '待上架', theme: 'default' },
};

const SUB_LABEL: Record<string, string> = {
  out_of_stock: '缺货',
  paused: '已暂停',
  free_shipping: '包邮',
  incomplete: '信息不全',
  deleted: '已删除',
};

const ITEM_TLD: Record<string, string> = {
  MLM: 'com.mx',
  MLB: 'com.br',
  MLC: 'cl',
  MCO: 'co',
  MLA: 'com.ar',
  MPE: 'com.pe',
  MPT: 'com.uy',
};

function permalinkOf(row: { siteItemIds?: string[] }): string {
  const sid = (row.siteItemIds || [])[0];
  if (!sid) return '';
  const tld = ITEM_TLD[sid.slice(0, 3)] || 'com.mx';
  return `https://www.mercadolibre.${tld}/p/${sid}`;
}

function fmtTime(v?: string): string {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString('zh-CN');
}

/** 把任意值转成可读字符串（详情里展示原始字段用） */
function showVal(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return '—';
    return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' / ');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ============ 主组件 ============

export function ProductManagerPage() {
  const [stores, setStores] = useState<IndexStore[]>([]);
  const [storeId, setStoreId] = useState('');
  const [loadingStores, setLoadingStores] = useState(true);

  // 筛选
  const [status, setStatus] = useState<'all' | 'active' | 'paused'>('all');
  const [risk, setRisk] = useState<'all' | 'none' | 'risk' | 'ip' | 'brand' | 'platform'>('all');
  const [query, setQuery] = useState('');
  const [qApplied, setQApplied] = useState('');

  // 列表
  const [items, setItems] = useState<StoreItemRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [counts, setCounts] = useState<IndexStore['counts']>(null);
  const [listError, setListError] = useState('');

  // 详情
  /** 是否显示「全部站点未激活」的链接（默认隐藏——用户反馈这类不该出现在列表里） */
  const [includeOffShelf, setIncludeOffShelf] = useState(false);
  /** 'all' | 'only' 只看被美客多禁止（forbidden）的商品 */
  const [onlyBlocked, setOnlyBlocked] = useState(false);
  // ---- 直接修改商品（实测可写字段：描述 / 库存 / 暂停）----
  const [editDesc, setEditDesc] = useState('');
  const [editQty, setEditQty] = useState<number>(0);
  const [editBusy, setEditBusy] = useState('');
  const [editResults, setEditResults] = useState<Array<{ field: string; ok: boolean; applied: boolean; message: string }> | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<FullDetail | null>(null);
  const [detailFor, setDetailFor] = useState<StoreItemRow | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // 图片查看
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerImages, setViewerImages] = useState<string[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);

  // 合规修复
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fixLoading, setFixLoading] = useState(false);
  const [fixPreview, setFixPreview] = useState<{ results: FixResult[]; total: number } | null>(null);
  const [fixPreviewOpen, setFixPreviewOpen] = useState(false);
  const [fixDone, setFixDone] = useState<{ results: FixResult[]; ok: number; failed: number; skipped: number } | null>(null);
  const [fixDoneOpen, setFixDoneOpen] = useState(false);

  const currentStore = useMemo(() => stores.find((s) => s.storeId === storeId), [stores, storeId]);

  // ---- 店铺索引状态 ----
  const loadStores = useCallback(async (refresh = false) => {
    setLoadingStores(true);
    try {
      const r = await fetch(`/api/ml/product-admin/index${refresh ? '?refresh=1' : ''}`);
      const d = await r.json();
      if (!d.success) {
        MessagePlugin.error('获取店铺索引失败');
        return;
      }
      const list: IndexStore[] = d.stores || [];
      setStores(list);
      if (!storeId && list.length) setStoreId(list[0].storeId);
    } catch (e: any) {
      MessagePlugin.error('获取店铺索引异常：' + (e?.message || e));
    } finally {
      setLoadingStores(false);
    }
  }, [storeId]);

  useEffect(() => {
    loadStores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 索引构建中 / 未构建完成 → 轮询
  useEffect(() => {
    const cur = stores.find((s) => s.storeId === storeId);
    if (!cur) return;
    if (!cur.building && cur.built) return;
    const t = window.setInterval(() => loadStores(), 5000);
    return () => window.clearInterval(t);
  }, [stores, storeId, loadStores]);

  // ---- 商品列表 ----
  const loadItems = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!storeId) return;
      if (!opts.silent) setLoading(true);
      try {
        const qs = new URLSearchParams({
          status,
          risk,
          q: qApplied,
          page: String(page),
          pageSize: String(pageSize),
          // 默认只列「至少一个站点在售」的链接；勾上「含未激活」才显示被平台挂起的
          onSale: includeOffShelf ? 'all' : 'yes',
          blocked: onlyBlocked ? 'only' : 'all',
        });
        const r = await fetch(`/api/ml/product-admin/${storeId}/items?${qs}`);
        const d = await r.json();
        if (!d.success) {
          setListError(d.message || '加载失败');
          setItems([]);
          setTotal(0);
          return;
        }
        setItems(d.items || []);
        setTotal(d.total || 0);
        setBuilding(!!d.building);
        setProgress(d.progress || { done: 0, total: 0 });
        setCounts(d.counts || null);
        setListError(d.error || '');
      } catch (e: any) {
        setListError(e?.message || String(e));
        setItems([]);
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [storeId, status, risk, qApplied, page, pageSize, includeOffShelf, onlyBlocked],
  );

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // 切换店铺时清空选择与筛选
  const switchStore = (id: string) => {
    setStoreId(id);
    setSelected(new Set());
    setPage(1);
  };

  // ---- 详情 ----
  const openDetail = useCallback(
    async (row: StoreItemRow) => {
      if (!storeId) return;
      setDetailOpen(true);
      setDetailFor(row);
      setDetail(null);
      setShowRaw(false);
      setDetailLoading(true);
      try {
        const r = await fetch(`/api/ml/product-admin/${storeId}/item/${encodeURIComponent(row.id)}`);
        const d = await r.json();
        if (!d.success) {
          MessagePlugin.error(d.message || '获取详情失败');
          setDetailOpen(false);
          return;
        }
        setDetail(d as FullDetail);
        setEditDesc(String((d as any)?.description || ''));
        setEditQty(Number((d as any)?.row?.availableQuantity) || 0);
        setEditResults(null);
      } catch (e: any) {
        MessagePlugin.error('获取详情异常：' + (e?.message || e));
        setDetailOpen(false);
      } finally {
        setDetailLoading(false);
      }
    },
    [storeId],
  );

  const openViewer = (images: string[], index: number) => {
    const valid = (images || []).filter(Boolean);
    if (!valid.length) return;
    const idx = Math.min(index, valid.length - 1);
    setViewerImages(valid);
    setViewerIndex(idx < 0 ? 0 : idx);
    setViewerOpen(true);
  };

  // ---- 一键改为符合规范 ----
  const runFix = useCallback(
    async (ids: string[], dryRun: boolean) => {
      if (!storeId || !ids.length) return;
      setFixLoading(true);
      try {
        const r = await fetch(`/api/ml/product-admin/${storeId}/compliance-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemIds: ids, dryRun }),
        });
        const d = await r.json();
        if (!d.success) {
          MessagePlugin.error(d.message || '操作失败');
          return;
        }
        if (dryRun) {
          setFixPreview({ results: d.results || [], total: d.total || ids.length });
          setFixPreviewOpen(true);
        } else {
          setFixDone({ results: d.results || [], ok: d.ok || 0, failed: d.failed || 0, skipped: d.skipped || 0 });
          setFixDoneOpen(true);
          setFixPreviewOpen(false);
          setSelected(new Set());
          loadItems({ silent: true });
        }
      } catch (e: any) {
        MessagePlugin.error('请求异常：' + (e?.message || e));
      } finally {
        setFixLoading(false);
      }
    },
    [storeId, loadItems],
  );

  // ---- 直接改原链接：POST /item/:id/update（后端写后回读校验，200≠生效）----
  const runUpdate = useCallback(
    async (patch: { description?: string; availableQuantity?: number; status?: 'paused' | 'active' }, tag: string) => {
      const id = detail?.row?.id;
      if (!storeId || !id) return;
      setEditBusy(tag);
      setEditResults(null);
      try {
        const r = await fetch(`/api/ml/product-admin/${storeId}/item/${id}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const d = await r.json();
        if (!d.success) {
          MessagePlugin.error(d.message || '修改失败');
          setEditResults([{ field: tag, ok: false, applied: false, message: d.message || '修改失败' }]);
          return;
        }
        setEditResults(d.results || []);
        const applied = (d.results || []).filter((x: any) => x.applied).length;
        if (applied) MessagePlugin.success(`${applied} 项已生效`);
        else MessagePlugin.warning('ML 返回成功但值未变，详见下方逐项说明');
        // 刷新详情与列表
        const r2 = await fetch(`/api/ml/product-admin/${storeId}/item/${id}`);
        const d2 = await r2.json();
        if (d2.success) setDetail(d2);
        loadItems({ silent: true });
      } catch (e: any) {
        MessagePlugin.error('请求异常：' + (e?.message || e));
      } finally {
        setEditBusy('');
      }
    },
    [storeId, detail, loadItems],
  );

  const fixableSelected = useMemo(() => {
    const m: Record<string, StoreItemRow> = {};
    for (const it of items) m[it.id] = it;
    return [...selected].filter((id) => m[id] && m[id].risk.fixable);
  }, [selected, items]);

  const columns: PrimaryTableCol<StoreItemRow>[] = [
    {
      colKey: 'row-select',
      title: (
        <Checkbox
          checked={items.length > 0 && items.every((i) => selected.has(i.id))}
          indeterminate={items.some((i) => selected.has(i.id)) && !items.every((i) => selected.has(i.id))}
          onChange={(v) => (v ? setSelected(new Set(items.map((i) => i.id))) : setSelected(new Set()))}
          disabled={!items.some((i) => i.risk.level !== 'none')}
        />
      ),
      width: 44,
    },
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 60,
      cell: ({ row }) =>
        row.thumbnail ? (
          <img
            src={row.thumbnail}
            style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
            referrerPolicy="no-referrer"
            loading="lazy"
            onClick={() => openViewer(row.pictures?.length ? row.pictures : [row.thumbnail], 0)}
          />
        ) : (
          <div className="w-[44px] h-[44px] rounded bg-gray-100 flex items-center justify-center">
            <ImageIcon size={14} className="text-gray-300" />
          </div>
        ),
    },
    {
      colKey: 'siteStatus',
      title: '站点状态',
      width: 232,
      cell: ({ row }) => <SiteBadges row={row} />,
    },
    {
      colKey: 'title',
      title: '商品',
      ellipsis: true,
      cell: ({ row }) => {
        const pl = permalinkOf(row);
        return (
          <div>
            <div className="text-sm leading-snug">{row.title || '（无标题）'}</div>
            <div className="flex items-center gap-2 flex-wrap mt-0.5">
              <span className="text-[11px] text-gray-400">{row.id}</span>
              {row.sellerSku && <span className="text-[11px] text-gray-500">SKU: {row.sellerSku}</span>}
              {pl && (
                <a
                  href={pl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
                >
                  <ExternalLink size={10} /> ML 链接
                </a>
              )}
            </div>
          </div>
        );
      },
    },
    {
      colKey: 'status',
      title: '状态',
      width: 122,
      cell: ({ row }) => {
        const st = STATUS_LABEL[row.status] || { label: row.status || '—', theme: 'default' };
        return (
          <div className="flex flex-col gap-0.5">
            <Tag size="small" theme={st.theme} variant="light">
              {st.label}
            </Tag>
            {row.subStatus?.length > 0 && (
              <span className="text-[11px] text-gray-500">
                {row.subStatus.map((s) => SUB_LABEL[s] || s).join(' / ')}
              </span>
            )}
          </div>
        );
      },
    },
    {
      colKey: 'risk',
      title: '违规风险',
      width: 150,
      cell: ({ row }) => {
        const rl = RISK_LABEL[row.risk.level] || RISK_LABEL.none;
        const tip = [
          row.risk.message,
          row.risk.titleHits?.length ? `标题命中：${row.risk.titleHits.join(', ')}` : '',
          ...(row.risk.attrHits || []).map((a) => `${a.name || a.id}="${a.value}" → ${a.hits.join(', ')}`),
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <Tooltip content={<span style={{ whiteSpace: 'pre-wrap' }}>{tip}</span>} placement="top-left">
            <div className="flex flex-col gap-0.5">
              <Tag size="small" theme={rl.theme} variant="light">
                {row.risk.level === 'none' ? <Shield size={11} className="inline mr-0.5" /> : <ShieldAlert size={11} className="inline mr-0.5" />}
                {rl.label}
              </Tag>
              {row.risk.level !== 'none' && (
                <span className="text-[11px] text-gray-500 line-clamp-2">
                  {row.risk.hits.slice(0, 3).join(', ')}
                  {row.risk.hits.length > 3 ? ` +${row.risk.hits.length - 3}` : ''}
                </span>
              )}
            </div>
          </Tooltip>
        );
      },
    },
    {
      colKey: 'price',
      title: '价格 / 库存',
      width: 110,
      cell: ({ row }) => (
        <div className="text-[12px] leading-tight">
          <div className="font-medium">
            {row.currencyId} {row.price}
          </div>
          <div className="text-gray-500">
            库存 {row.availableQuantity} · 已售 {row.soldQuantity}
          </div>
        </div>
      ),
    },
    {
      colKey: 'action',
      title: '操作',
      width: 148,
      fixed: 'right',
      cell: ({ row }) => (
        <Space size={2} breakLine>
          <Button size="small" variant="text" onClick={() => openDetail(row)}>
            <Eye size={12} className="inline mr-0.5" />
            详情
          </Button>
          {row.risk.level !== 'none' && (
            <Tooltip
              content={
                row.risk.fixable
                  ? '洗掉品牌词/违禁词后克隆生成一条新的合规链接（原链接需到美客多后台暂停）'
                  : '命中 IP/赛事词，改名也侵权，只能到美客多后台下架'
              }
            >
              <Button
                size="small"
                variant="text"
                theme={row.risk.fixable ? 'primary' : 'default'}
                disabled={!row.risk.fixable || fixLoading}
                onClick={() => runFix([row.id], true)}
              >
                <Wand2 size={12} className="inline mr-0.5" />
                改为合规
              </Button>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  const fixableOnPage = items.filter((i) => i.risk.fixable).length;

  return (
    <div className="p-2 sm:p-3 w-full">
      {/* 标题 */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <Shield size={18} />
        <h1 className="text-lg font-semibold">商品管理</h1>
        <span className="text-xs text-gray-500">
          分店铺展示全部商品，可筛在售 / 已暂停 / 违规风险，查看全部字段，违规风险商品可一键改为合规
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="small"
            variant="outline"
            icon={<RefreshCw size={13} />}
            loading={loadingStores}
            onClick={() => {
              loadStores(true);
              loadItems();
            }}
          >
            刷新索引
          </Button>
          {storeId && (
            <Button
              size="small"
              variant="outline"
              icon={<Download size={13} />}
              onClick={() => window.open(`/api/ml/product-admin/${storeId}/export?status=${status}&risk=${risk}&q=${encodeURIComponent(qApplied)}`, '_blank')}
            >
              导出 CSV
            </Button>
          )}
        </span>
      </div>

      {/* 店铺 Tab */}
      <div className="border-b mb-2">
        <Tabs
          value={storeId}
          onChange={(v) => switchStore(v as string)}
          theme="normal"
        >
          {stores.map((s) => (
            <Tabs.TabPanel
              key={s.storeId}
              value={s.storeId}
              label={
                <span className="inline-flex items-center gap-1">
                  {s.storeNick}
                  {s.counts && <span className="text-[11px] text-gray-400">({s.counts.total})</span>}
                  {s.building && <span className="text-[11px] text-blue-500">建索引…</span>}
                </span>
              }
            />
          ))}
        </Tabs>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v as any);
            setPage(1);
          }}
          style={{ width: 132 }}
          size="small"
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'active', label: `正在上架${counts ? ` (${counts.active})` : ''}` },
            { value: 'paused', label: `已暂停/禁止${counts ? ` (${counts.paused})` : ''}` },
          ]}
        />
        <label
          className="inline-flex items-center gap-1.5 text-xs text-gray-600 px-2 py-1 rounded border border-gray-200 cursor-pointer select-none"
          title="美客多的「未激活」= 所有站点都挂了（多为审核不过/商品分类错误/被平台下架），买家看不到。默认不显示。"
        >
          <Switch
            size="small"
            value={includeOffShelf}
            onChange={(v) => {
              setIncludeOffShelf(!!v);
              setPage(1);
            }}
          />
          含未激活链接
          {counts && typeof (counts as any).offShelf === 'number' && (
            <span className="text-red-500">{(counts as any).offShelf}</span>
          )}
        </label>
        <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer" title="只看有站点被美客多标记 forbidden 的商品 —— 买家完全看不到，通常要下架重发或申诉">
          <Switch
            size="small"
            value={onlyBlocked}
            onChange={(v) => {
              setOnlyBlocked(!!v);
              setPage(1);
            }}
          />
          <span className={onlyBlocked ? 'text-red-600 font-medium' : ''}>只看被禁止</span>
          {counts && typeof (counts as any).blocked === 'number' && (
            <span className="text-red-500">{(counts as any).blocked}</span>
          )}
        </label>
        <Select
          value={risk}
          onChange={(v) => {
            setRisk(v as any);
            setPage(1);
          }}
          style={{ width: 168 }}
          size="small"
          options={[
            { value: 'all', label: '全部风险' },
            { value: 'risk', label: `仅违规风险${counts ? ` (${counts.risk})` : ''}` },
            { value: 'none', label: '无风险' },
            { value: 'brand', label: `品牌词${counts ? ` (${counts.riskBrand})` : ''}` },
            { value: 'platform', label: '平台违禁词' },
            { value: 'ip', label: `IP/赛事不可洗${counts ? ` (${counts.riskIp})` : ''}` },
          ]}
        />
        <Input
          value={query}
          onChange={(v) => setQuery(String(v))}
          onEnter={() => {
            setQApplied(query.trim());
            setPage(1);
          }}
          placeholder="搜索标题 / 商品ID / SKU / 品牌 / 型号"
          style={{ width: 260 }}
          size="small"
          clearable
        />
        <Button
          size="small"
          theme="primary"
          icon={<SearchIcon />}
          onClick={() => {
            setQApplied(query.trim());
            setPage(1);
          }}
        >
          搜索
        </Button>
        {qApplied && (
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setQuery('');
              setQApplied('');
              setPage(1);
            }}
          >
            清空搜索
          </Button>
        )}
        <span className="text-xs text-gray-500">
          共 {total} 件{selected.size > 0 ? ` · 已选 ${selected.size}（可洗 ${fixableSelected.length}）` : ''}
          {counts && typeof (counts as any).onSale === 'number' && (
            <span className="ml-2 text-gray-400">
              · 站点级在售 {(counts as any).onSale} / 全站未激活 {(counts as any).offShelf}
              {typeof (counts as any).blocked === 'number' && (
                <span className="text-red-500"> / 含禁售站点 {(counts as any).blocked}</span>
              )}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="small"
            variant="outline"
            disabled={!fixableOnPage}
            onClick={() => setSelected(new Set(items.filter((i) => i.risk.fixable).map((i) => i.id)))}
          >
            勾选本页可洗商品({fixableOnPage})
          </Button>
          <Button
            size="small"
            theme="primary"
            disabled={!fixableSelected.length || fixLoading}
            loading={fixLoading}
            onClick={() => runFix(fixableSelected, true)}
          >
            <Wand2 size={13} className="inline mr-0.5" />
            批量改为合规({fixableSelected.length})
          </Button>
        </span>
      </div>

      {/* 索引构建中 */}
      {(building || (currentStore && !currentStore.built && !currentStore.error)) && (
        <div className="mb-2 text-xs px-3 py-2 rounded border border-blue-200 bg-blue-50 text-blue-700 flex items-center gap-3">
          <span>正在建立全店商品索引（约 3000 件，首次约 1-2 分钟）…</span>
          <Progress
            theme="line"
            percentage={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
            style={{ flex: 1, minWidth: 120 }}
          />
          <span>
            {progress.done}/{progress.total}
          </span>
        </div>
      )}
      {listError && (
        <div className="mb-2 text-xs px-3 py-2 rounded border border-red-200 bg-red-50 text-red-700">
          索引/取数异常：{listError}
        </div>
      )}

      {/* 批量合规提示 */}
      {selected.size > 0 && fixableSelected.length < selected.size && (
        <div className="mb-2 text-xs px-3 py-2 rounded border border-amber-200 bg-amber-50 text-amber-800 flex items-start gap-2">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            已选 {selected.size} 件中，仅 <strong>{fixableSelected.length}</strong> 件可通过改名规避；
            其余命中影视/动漫/游戏 IP 或体育赛事词，卖的就是 IP 本身，改名仍侵权，需到美客多后台下架。
          </span>
        </div>
      )}

      <Table
        data={items}
        columns={columns}
        rowKey="id"
        loading={loading}
        hover
        size="small"
        bordered
        selectedRowKeys={[...selected]}
        onSelectChange={(v) => setSelected(new Set(v as string[]))}
      />

      {total > 0 && (
        <div className="flex justify-end mt-3">
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            showJumper
            pageSizeOptions={[20, 50, 100, 200]}
            onChange={({ current: c }) => setPage(c)}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}

      {!loading && total === 0 && storeId && !building && (
        <div className="text-center py-10 text-gray-400 text-sm">
          没有符合条件的商品
        </div>
      )}

      {/* ============ 详情弹窗（全部字段） ============ */}
      <Dialog
        visible={detailOpen}
        onClose={() => setDetailOpen(false)}
        header={
          <div className="flex items-center gap-2">
            <span>商品详情</span>
            {detail?.risk && detail.risk.level !== 'none' && (
              <Tag size="small" theme={RISK_LABEL[detail.risk.level].theme} variant="light">
                {RISK_LABEL[detail.risk.level].label}
              </Tag>
            )}
          </div>
        }
        width="min(1000px, 96vw)"
        footer={null}
      >
        {detailLoading ? (
          <Loading loading={true} text="加载商品全部字段…" style={{ height: 240 }} />
        ) : !detail ? (
          <div className="text-center py-10 text-gray-400 text-sm">未取到详情</div>
        ) : (
          <div className="space-y-4 max-h-[74vh] overflow-auto pr-1">
            {detail._errors?.length ? (
              <div className="text-xs px-3 py-2 rounded border border-amber-200 bg-amber-50 text-amber-800">
                部分接口未取到：{detail._errors.join('；')}
              </div>
            ) : null}

            {/* 图片 */}
            {(() => {
              const rowPics: string[] = detail.row?.pictures?.length ? detail.row.pictures : [];
              const rawPics: string[] = ((detail.raw?.pictures || []) as any[])
                .map((p: any) => p?.secure_url || p?.url)
                .filter(Boolean);
              const pics: string[] = rowPics.length ? rowPics : rawPics;
              if (!pics.length) return null;
              return (
                <div>
                  <div className="text-xs font-medium mb-1.5">商品图片（{pics.length} 张，点击放大）</div>
                  <div className="flex flex-wrap gap-2">
                    {pics.slice(0, 12).map((u: string, i: number) => (
                      <img
                        key={i}
                        src={u}
                        style={{ width: 62, height: 62, objectFit: 'cover', borderRadius: 4, cursor: 'zoom-in' }}
                        referrerPolicy="no-referrer"
                        onClick={() => openViewer(pics, i)}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* 核心字段 */}
            <div>
              <div className="text-xs font-medium mb-1.5">基础字段</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-1.5 text-xs">
                {(
                  [
                    ['商品ID', detail.row?.id],
                    ['站点商品ID', (detail.row?.siteItemIds || []).join(', ')],
                    ['状态', `${detail.row?.status || '—'}${detail.row?.subStatus?.length ? ` (${detail.row.subStatus.join(', ')})` : ''}`],
                    ['SKU', detail.row?.sellerSku],
                    ['品牌', detail.row?.brand],
                    ['型号', detail.row?.model],
                    ['价格', `${detail.row?.currencyId || ''} ${detail.row?.price ?? ''}`],
                    ['库存', detail.row?.availableQuantity],
                    ['已售', detail.row?.soldQuantity],
                    ['成色', detail.row?.condition],
                    ['上架类型', detail.row?.listingTypeId],
                    ['类目ID', detail.row?.categoryId],
                    ['妙手 detailId', detail.row?.miaoshouDetailId],
                    ['创建时间', fmtTime(detail.row?.dateCreated)],
                    ['更新时间', fmtTime(detail.row?.lastUpdated)],
                    ['商品链接', detail.permalink],
                  ] as Array<[string, any]>
                ).map(([k, v]) => (
                  <div key={k} className="flex gap-1 min-w-0">
                    <span className="text-gray-400 shrink-0" style={{ minWidth: 62 }}>
                      {k}
                    </span>
                    {k === '商品链接' && v ? (
                      <a href={v} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate">
                        {v}
                      </a>
                    ) : (
                      <span className="truncate" title={showVal(v)}>
                        {showVal(v)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* 站点级真实在售状态 */}
            <div>
              <div className="text-xs font-medium mb-1.5 flex items-center gap-2">
                站点级在售状态
                {detail.siteStatus ? (
                  <Tag size="small" variant="light" theme={detail.siteStatus.onSale ? 'success' : 'danger'}>
                    {detail.siteStatus.onSale ? '买家可见（至少一个站点在售）' : '全部站点未激活（买家看不到）'}
                  </Tag>
                ) : (
                  <span className="text-[11px] text-gray-400">未取到（接口失败或该店无站点数据）</span>
                )}
              </div>
              <div className="text-xs px-3 py-2 rounded border" style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}>
                <div className="text-[11px] text-gray-500 mb-1.5">
                  CBT 父商品的 status <strong>不能</strong>代表买家能不能看到 —— 真正说话的是各站点本地 listing：
                </div>
                {(detail.siteStatus?.siteItems || []).length ? (
                  <div className="space-y-1">
                    {detail.siteStatus!.siteItems.map((m) => (
                      <div key={`${m.siteId}-${m.itemId}`} className="flex items-center gap-2">
                        <span className="w-10 shrink-0 text-gray-500">{m.siteId}</span>
                        <span className="text-[11px] text-gray-400 w-16 shrink-0">{SITE_NAME[m.siteId] || ''}</span>
                        <Tag
                          size="small"
                          variant="light"
                          theme={m.state === 'active' ? 'success' : m.state === 'paused' ? 'default' : 'danger'}
                        >
                          {SITE_STATE_LABEL[m.state] || m.state}
                        </Tag>
                        <span className="text-[11px] text-gray-400 truncate">{m.itemId}</span>
                        <span className="text-[11px] text-gray-300">子账号 {m.userId}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-gray-400">无站点 listing 数据</div>
                )}
              </div>
            </div>

            {/* 直接修改商品（实测可写字段） */}
            <div>
              <div className="text-xs font-medium mb-1.5">
                直接修改原链接
                <span className="ml-2 text-[11px] font-normal text-gray-400">
                  实测可写：描述 / 库存 / 暂停 · 价格与标题 ML 开放 API 不支持（返回 200 但值不变）
                </span>
              </div>
              <div className="text-xs px-3 py-2 rounded border space-y-3" style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}>
                <div>
                  <div className="text-[11px] text-gray-500 mb-1">商品描述（PUT /items/商品ID/description，实测可改）</div>
                  <Textarea
                    value={editDesc || (detail.description || '')}
                    onChange={(v) => setEditDesc(String(v))}
                    autosize={{ minRows: 3, maxRows: 8 }}
                    placeholder="留空则不改"
                  />
                  <div className="mt-1.5 flex gap-2">
                    <Button
                      size="small"
                      theme="primary"
                      loading={editBusy === 'desc'}
                      onClick={() => runUpdate({ description: editDesc || detail.description || '' }, 'desc')}
                    >
                      保存描述
                    </Button>
                    <Button size="small" variant="outline" onClick={() => setEditDesc(detail.description || '')}>
                      重置
                    </Button>
                  </div>
                </div>

                <div className="flex items-end gap-2 flex-wrap">
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">
                      库存 available_quantity（当前 {detail.row?.availableQuantity ?? '—'}）
                    </div>
                    <InputNumber
                      size="small"
                      theme="normal"
                      value={editQty}
                      min={0}
                      max={9999}
                      onChange={(v) => setEditQty(Number(v) || 0)}
                      style={{ width: 120 }}
                    />
                  </div>
                  <Button
                    size="small"
                    theme="primary"
                    loading={editBusy === 'qty'}
                    onClick={() => runUpdate({ availableQuantity: editQty }, 'qty')}
                  >
                    保存库存
                  </Button>
                  <Button
                    size="small"
                    variant="outline"
                    theme="default"
                    loading={editBusy === 'pause'}
                    disabled={detail.row?.status === 'paused'}
                    onClick={() => runUpdate({ status: 'paused' }, 'pause')}
                  >
                    暂停该链接
                  </Button>
                  <Button
                    size="small"
                    variant="outline"
                    loading={editBusy === 'active'}
                    disabled={detail.row?.status === 'active'}
                    onClick={() => runUpdate({ status: 'active' }, 'active')}
                  >
                    重新激活
                  </Button>
                </div>

                {editResults && (
                  <div className="space-y-1 border-t pt-2" style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}>
                    {editResults.map((r, i) => (
                      <div key={i} className={r.applied ? 'text-green-600' : 'text-red-600'}>
                        [{r.field}] {r.applied ? '✅ 已生效' : '⚠️ 未生效'} — {r.message}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 风险分析 */}
            <div>
              <div className="text-xs font-medium mb-1.5">侵权 / 违禁风险分析</div>
              <div className="text-xs px-3 py-2 rounded border" style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <Tag size="small" theme={RISK_LABEL[detail.risk.level].theme} variant="light">
                    {RISK_LABEL[detail.risk.level].label}
                  </Tag>
                  <span className="text-gray-500">{detail.risk.message}</span>
                </div>
                {detail.risk.level !== 'none' && !detail.risk.fixable && (
                  <div className="text-red-600">
                    该商品命中 IP/赛事词，无法通过改名规避侵权，请到美客多后台下架。
                  </div>
                )}
                {detail.risk.titleHits?.length ? (
                  <div className="mt-1">
                    <span className="text-gray-400">标题命中：</span>
                    {detail.risk.titleHits.map((h) => (
                      <Tag key={h} size="small" variant="outline" className="mr-1">
                        {h}
                      </Tag>
                    ))}
                  </div>
                ) : null}
                {detail.risk.attrHits?.length ? (
                  <div className="mt-1 space-y-0.5">
                    <span className="text-gray-400">属性命中：</span>
                    {detail.risk.attrHits.map((a, i) => (
                      <div key={i} className="pl-3">
                        <span className="text-gray-500">{a.name || a.id}</span> = 「{a.value}」
                        {a.hits.map((h) => (
                          <Tag key={h} size="small" theme="danger" variant="light" className="ml-1">
                            {h}
                          </Tag>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {/* 合规化预览 */}
            {detail.risk.level !== 'none' && detail.risk.fixable && (
              <div>
                <div className="text-xs font-medium mb-1.5">
                  一键改为合规 —— 预览（洗掉品牌词/违禁词后克隆生成新链接）
                </div>
                <div className="text-xs px-3 py-2 rounded border space-y-1.5" style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}>
                  <div>
                    <span className="text-gray-400">原标题：</span>
                    <span className="line-through text-gray-500">{detail.row?.title}</span>
                  </div>
                  <div>
                    <span className="text-gray-400">新标题：</span>
                    <span className="text-green-700 font-medium">{detail.suggested.title}</span>
                  </div>
                  {detail.suggested.attributeChanges?.length ? (
                    <div>
                      <span className="text-gray-400">属性改动（{detail.suggested.attributeChanges.length} 处）：</span>
                      <table className="w-full mt-1" style={{ borderCollapse: 'collapse' }}>
                        <thead>
                          <tr className="text-gray-400 text-left">
                            <th className="pr-3 font-normal">字段</th>
                            <th className="pr-3 font-normal">原值</th>
                            <th className="font-normal">改为</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.suggested.attributeChanges.map((c, i) => (
                            <tr key={i}>
                              <td className="pr-3">{c.name || c.id}</td>
                              <td className="pr-3 line-through text-gray-500">{c.from}</td>
                              <td className="text-green-700">{c.to}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="text-gray-400">属性无需改动</div>
                  )}
                  <div className="pt-1">
                    <Button size="small" theme="primary" loading={fixLoading} onClick={() => runFix([detail.row!.id], true)}>
                      <Wand2 size={12} className="inline mr-0.5" />
                      改为符合规范（先预览）
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 全部属性 */}
            {Array.isArray(detail.raw?.attributes) && detail.raw.attributes.length > 0 && (
              <div>
                <div className="text-xs font-medium mb-1.5">全部属性（{detail.raw.attributes.length} 项）</div>
                <div className="max-h-56 overflow-auto border rounded">
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                    <thead className="sticky top-0 bg-gray-50">
                      <tr className="text-left text-gray-500">
                        <th className="px-2 py-1 font-normal">属性ID</th>
                        <th className="px-2 py-1 font-normal">名称</th>
                        <th className="px-2 py-1 font-normal">值</th>
                        <th className="px-2 py-1 font-normal">value_id</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.raw.attributes.map((a: any, i: number) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1 text-gray-400">{a.id}</td>
                          <td className="px-2 py-1">{a.name}</td>
                          <td className="px-2 py-1">
                            {a.value_name || showVal(a.values?.map((v: any) => v?.name))}
                          </td>
                          <td className="px-2 py-1 text-gray-400">{showVal(a.value_id)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 站点售卖信息 */}
            {detail.marketplaceItems?.length > 0 && (
              <div>
                <div className="text-xs font-medium mb-1.5">各站点售卖信息（CBT）</div>
                <div className="overflow-auto border rounded">
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                    <thead className="bg-gray-50">
                      <tr className="text-left text-gray-500">
                        {Object.keys(detail.marketplaceItems[0] || {})
                          .slice(0, 8)
                          .map((k) => (
                            <th key={k} className="px-2 py-1 font-normal">
                              {k}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detail.marketplaceItems.map((m: any, i: number) => (
                        <tr key={i} className="border-t">
                          {Object.keys(detail.marketplaceItems[0] || {})
                            .slice(0, 8)
                            .map((k) => (
                              <td key={k} className="px-2 py-1">
                                {showVal(m[k])}
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 描述 */}
            <div>
              <div className="text-xs font-medium mb-1.5">商品描述</div>
              <div
                className="text-xs px-3 py-2 rounded border whitespace-pre-wrap max-h-52 overflow-auto"
                style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}
              >
                {detail.description || '（无描述）'}
              </div>
            </div>

            {/* 原始 JSON */}
            <div>
              <Button size="small" variant="text" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? '收起' : '展开'}完整原始数据（JSON）
              </Button>
              {showRaw && (
                <pre
                  className="text-[11px] mt-1 p-2 rounded border overflow-auto max-h-72"
                  style={{ borderColor: 'var(--td-border-level-1-color, #e7e7e7)' }}
                >
                  {JSON.stringify(detail.raw, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}
      </Dialog>

      {/* ============ 合规修复：预览确认 ============ */}
      <Dialog
        visible={fixPreviewOpen}
        onClose={() => setFixPreviewOpen(false)}
        header={`改为符合规范 · 预览（${fixPreview?.results.filter((r) => r.dry).length || 0} 件可执行）`}
        width="min(880px, 95vw)"
        footer={
          <Space>
            <Button variant="outline" onClick={() => setFixPreviewOpen(false)}>
              取消
            </Button>
            <Button
              theme="primary"
              loading={fixLoading}
              disabled={!fixPreview?.results.some((r) => r.dry)}
              onClick={() => {
                const ids = (fixPreview?.results || []).filter((r) => r.dry).map((r) => r.itemId);
                runFix(ids, false);
              }}
            >
              确认执行（克隆生成新链接）
            </Button>
          </Space>
        }
      >
        {fixPreview && (
          <div className="space-y-3 max-h-[70vh] overflow-auto pr-1">
            <div className="text-xs px-3 py-2 rounded border border-amber-200 bg-amber-50 text-amber-900">
              <strong>重要：</strong>美客多 CBT 商品对本店 API 是只读的（改不了、删不掉、暂停不了）。
              因此「改为合规」是<strong>克隆一件清洗后的新商品并重新上架</strong>，得到一条全新的合规链接；
              <strong>原违规链接仍需你到美客多卖家后台手动暂停或删除</strong>，否则旧链接依然存在侵权风险。
            </div>
            {fixPreview.results.map((r) => (
              <div key={r.itemId} className="text-xs border rounded p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag size="small" theme={r.dry ? 'primary' : r.ok ? 'success' : 'danger'} variant="light">
                    {r.dry ? '可执行' : r.ok ? '成功' : r.skipped ? '无需修改' : '失败'}
                  </Tag>
                  <span className="text-gray-400">{r.itemId}</span>
                  <span className="truncate">{r.title}</span>
                </div>
                {r.changes?.length ? (
                  <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                    {r.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null}
                {r.error && <div className="text-red-600">{r.error}</div>}
              </div>
            ))}
          </div>
        )}
      </Dialog>

      {/* ============ 合规修复：执行结果 ============ */}
      <Dialog
        visible={fixDoneOpen}
        onClose={() => setFixDoneOpen(false)}
        header="改为符合规范 · 执行结果"
        width="min(880px, 95vw)"
        footer={
          <Button theme="primary" onClick={() => setFixDoneOpen(false)}>
            知道了
          </Button>
        }
      >
        {fixDone && (
          <div className="space-y-3 max-h-[70vh] overflow-auto pr-1">
            <div className="flex items-center gap-3 text-sm">
              <Tag theme="success">成功 {fixDone.ok}</Tag>
              <Tag theme="warning">无需修改 {fixDone.skipped}</Tag>
              <Tag theme="danger">失败 {fixDone.failed}</Tag>
            </div>
            <div className="text-xs px-3 py-2 rounded border border-amber-200 bg-amber-50 text-amber-900">
              新链接已生成，请在美客多后台<strong>暂停/删除原始违规链接</strong>（API 无权限操作原 CBT 商品）。
            </div>
            {fixDone.results.map((r) => (
              <div key={r.itemId} className="text-xs border rounded p-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag size="small" theme={r.ok ? 'success' : r.skipped ? 'warning' : 'danger'} variant="light">
                    {r.ok ? '成功' : r.skipped ? '无需修改' : '失败'}
                  </Tag>
                  <span className="text-gray-400">{r.itemId}</span>
                  <span className="truncate">{r.title}</span>
                  {r.newId && (
                    <Tag size="small" theme="primary" variant="outline">
                      新链接 {r.newId}
                    </Tag>
                  )}
                  {r.newSites?.length ? <span className="text-gray-500">站点 {r.newSites.join('/')}</span> : null}
                </div>
                {r.changes?.length ? (
                  <ul className="list-disc list-inside text-gray-600 space-y-0.5">
                    {r.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : null}
                {r.siteErrors?.length ? (
                  <div className="text-red-600">
                    站点报错：{r.siteErrors.map((s) => `${s.site}: ${s.msg}`).join('；')}
                  </div>
                ) : null}
                {r.error && <div className="text-red-600">{r.error}</div>}
              </div>
            ))}
          </div>
        )}
      </Dialog>

      <Lightbox
        images={viewerImages}
        visible={viewerOpen}
        index={viewerIndex}
        closeOnOverlay
        onClose={() => setViewerOpen(false)}
      />
    </div>
  );
}

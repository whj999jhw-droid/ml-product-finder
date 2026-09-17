/**
 * src/pages/VideoGenTab.tsx
 * 「视频生成」tab —— 针对 ML 店铺**在售**商品批量/单件生成并上传 Clips 视频。
 *
 * 与「已发布」tab 的区别：数据源是 ML 全店在售商品（天然满足「未被美客多暂停」），
 * 所以妙手 ERP 自己上架、本系统没有发布记录的商品也能覆盖。
 *
 * 视频来源三档（后端自动按优先级选）：
 *   ① 服务器已有备份 → ② 妙手/1688 源视频转码 → ③ AI 用商品主图生成。
 * 能否取到「妙手源视频」取决于**标题前缀配对**（ML 商品没有 SKU）：
 * 配到的（约 80%）走源视频转码，配不到的只能靠 AI 图生视频 —— 所以要能按来源筛选。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Table,
  Tag,
  Tooltip,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import {
  CloudUpload,
  ExternalLink,
  Play,
  RefreshCw,
  Sparkles,
  X,
  AlertTriangle,
  Link2,
  DownloadCloud,
} from 'lucide-react';

interface Store {
  id: string;
  nickname: string;
  site: string;
  authorized: boolean;
  enabled: boolean;
}

interface CandidateVideo {
  status: string;
  stage?: string;
  error?: string;
  sourceKind?: string;
  siteStatuses?: Record<string, string>;
  clipUuid?: string;
  hasBackup?: boolean;
  updatedAt?: number;
}

interface ClipInfo {
  ok: boolean;
  clipCount?: number;
  siteStatuses?: Record<string, string>;
  review?: { kind: string; label: string };
  error?: string;
}

interface Candidate {
  itemId: string;
  title: string;
  thumbnail: string;
  price: number;
  currencyId: string;
  status: string;
  soldQuantity: number;
  permalink: string;
  miaoshouDetailId: string | null;
  recordKey: string;
  hasBackup: boolean;
  expectedSource: 'backup' | 'source' | 'ai';
  detailLink?: 'record' | 'title' | 'none';
  /** 卖家 SKU（来自 SELLER_SKU 属性；ML 商品没有 seller_custom_field） */
  sellerSku?: string | null;
  /** 同款重复链接数：>1 表示这件商品在美客多被重复上架，列表只展示其中一条 */
  dupCount?: number;
  video: CandidateVideo | null;
  clip?: ClipInfo;
}

interface JobItem {
  itemId: string;
  title?: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  stage?: string;
  sourceKind?: string;
  error?: string;
  clipUuid?: string;
  siteStatuses?: Record<string, string>;
  durationMs?: number;
}

interface Job {
  id: string;
  storeId: string;
  storeNick?: string;
  status: 'running' | 'done' | 'canceled';
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  cancelRequested: boolean;
  current?: string;
  items: JobItem[];
}

/** ML Clips 审核状态 → 中文 */
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
const CLIP_BAD = ['REJECTED', 'BLOCKED', 'FAILED', 'REMOVED', 'UPLOADING_ERROR', 'UPLOAD_ERROR', 'NOT_AVAILABLE'];

/** 阶段 → 中文（后端 stage 取值） */
const STAGE_LABEL: Record<string, string> = {
  check: '检查已有视频',
  download: '下载源视频',
  convert: '转码为 9:16',
  ai: 'AI 生成视频',
  backup: '写服务器备份',
  upload: '上传到美客多',
  done: '完成',
  auth: '店铺授权失效',
  error: '异常',
};

/** 视频来源 → 展示文案 */
const SOURCE_LABEL: Record<string, string> = {
  source: '源视频转码',
  backup: '服务器备份',
  ai: 'AI 图生视频',
};

const SOURCE_HINT: Record<string, string> = {
  backup: '服务器已有合规备份，直接复用（最快）',
  source: '已配到妙手/1688 源视频，下载后转码上传',
  ai: '没有源视频也没有备份 → 用商品主图做 AI 图生视频',
};

const LINK_LABEL: Record<string, string> = {
  record: '发布记录直接对应',
  title: '标题前缀配对',
  none: '',
};

/** 综合判定一件商品的视频状态 */
function videoState(c: Candidate): {
  key: string;
  label: string;
  theme: 'success' | 'warning' | 'danger' | 'default' | 'primary';
} {
  const v = c.video;
  const ss = v?.siteStatuses || c.clip?.siteStatuses || {};
  const vals = Object.values(ss).filter(Boolean) as string[];
  if (v?.status === 'failed') return { key: 'failed', label: '生成/上传失败', theme: 'danger' };
  if (v?.status === 'uploading') return { key: 'uploading', label: '处理中', theme: 'warning' };
  if (vals.length) {
    if (vals.some((x) => CLIP_BAD.includes(x))) return { key: 'bad', label: '视频被拒', theme: 'danger' };
    if (vals.every((x) => CLIP_OK.includes(x))) return { key: 'ok', label: '视频已通过', theme: 'success' };
    return { key: 'wait', label: '视频审核中', theme: 'warning' };
  }
  return { key: 'none', label: '未上传视频', theme: 'default' };
}

export function VideoGenTab({ stores }: { stores: Store[] }) {
  const activeStores = useMemo(
    () => (stores || []).filter((s) => s.authorized !== false && s.enabled !== false),
    [stores],
  );
  const [storeId, setStoreId] = useState('');
  const [query, setQuery] = useState('');
  const [qApplied, setQApplied] = useState('');
  const [link, setLink] = useState<'any' | 'source' | 'ai'>('any');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Candidate[]>([]);
  const [total, setTotal] = useState(0);
  const [linkCounts, setLinkCounts] = useState<{ source: number; ai: number } | null>(null);
  const [mergedAway, setMergedAway] = useState(0);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [aiProviders, setAiProviders] = useState<Array<{ name: string; model: string; platform: string }>>([]);
  const [checkClip, setCheckClip] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [force, setForce] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [jobOpen, setJobOpen] = useState(false);
  const [videoView, setVideoView] = useState<{ key: string; title: string } | null>(null);
  const pollRef = useRef<number | null>(null);

  // 默认选第一个可用店铺
  useEffect(() => {
    if (!storeId && activeStores.length) setStoreId(activeStores[0].id);
  }, [activeStores, storeId]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!storeId) return;
      if (!opts.silent) setLoading(true);
      try {
        const qs = new URLSearchParams({
          storeId,
          q: qApplied,
          link,
          page: String(page),
          pageSize: String(pageSize),
          checkClip: checkClip ? '1' : '0',
        });
        const r = await fetch(`/api/ml/miaoshou/video/candidates?${qs}`);
        const d = await r.json();
        if (!d.success) {
          MessagePlugin.error(d.error || '加载失败');
          setItems([]);
          return;
        }
        setItems(d.items || []);
        setTotal(d.total || 0);
        setLinkCounts(d.linkCounts || null);
        setMergedAway(Number(d.mergedAway) || 0);
        setBuilding(!!d.building);
        setProgress(d.progress || { done: 0, total: 0 });
        setAiProviders(d.aiProviders || []);
      } catch (e: any) {
        MessagePlugin.error('加载失败：' + (e?.message || e));
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [storeId, qApplied, link, page, pageSize, checkClip],
  );

  useEffect(() => {
    load();
  }, [load]);

  // 索引构建中 → 每 4 秒静默刷新一次
  useEffect(() => {
    if (!building) return;
    const t = window.setInterval(() => load({ silent: true }), 4000);
    return () => window.clearInterval(t);
  }, [building, load]);

  // 批量任务轮询
  useEffect(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (!job || job.status !== 'running') return;
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch(`/api/ml/miaoshou/video/job/${job.id}`);
        const d = await r.json();
        if (d.success && d.job) {
          setJob(d.job);
          if (d.job.status !== 'running') {
            if (pollRef.current) window.clearInterval(pollRef.current);
            pollRef.current = null;
            load({ silent: true });
          }
        }
      } catch {
        /* 轮询失败忽略，下轮再来 */
      }
    }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [job, load]);

  /** 同步妙手「已发布」记录 —— 源视频配对依赖它，同步后配对率会明显提高 */
  const syncMiaoshou = useCallback(async () => {
    setSyncing(true);
    try {
      const r = await fetch('/api/ml/miaoshou/published/sync-miaoshou', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        MessagePlugin.success(
          `妙手已发布 ${d.miaoshouPublished} 件：新增 ${d.added} 条 / 已有 ${d.skipped} 条`,
        );
        await load();
      } else {
        MessagePlugin.error('同步失败：' + (d.error || ''));
      }
    } catch (e: any) {
      MessagePlugin.error('同步异常：' + (e?.message || e));
    } finally {
      setSyncing(false);
    }
  }, [load]);

  /** 单件生成并上传 */
  const generateOne = useCallback(
    async (c: Candidate) => {
      if (!storeId) return;
      setBusy((b) => ({ ...b, [c.itemId]: true }));
      try {
        const r = await fetch('/api/ml/miaoshou/video/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storeId, itemId: c.itemId, force }),
        });
        const d = await r.json();
        if (d.success && d.skipped) {
          MessagePlugin.info(d.skipReason || '已有视频，已跳过');
        } else if (d.success) {
          const sites = Object.entries(d.siteStatuses || {})
            .filter(([, v]) => v)
            .map(([k, v]) => `${k}:${CLIP_LABEL[v as string] || v}`)
            .join(' ');
          MessagePlugin.success(`生成并上传成功${sites ? `（${sites}）` : ''}`);
        } else {
          MessagePlugin.error(
            `失败【${STAGE_LABEL[d.stage || ''] || d.stage || '未知阶段'}】：${d.error || '未知原因'}`,
          );
        }
        load({ silent: true });
      } catch (e: any) {
        MessagePlugin.error('请求异常：' + (e?.message || e));
      } finally {
        setBusy((b) => ({ ...b, [c.itemId]: false }));
      }
    },
    [storeId, force, load],
  );

  /** 批量生成并上传 */
  const generateBatch = useCallback(async () => {
    const ids = [...selected];
    if (!storeId || !ids.length) return;
    try {
      const r = await fetch('/api/ml/miaoshou/video/job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeId, itemIds: ids, force }),
      });
      const d = await r.json();
      if (!d.success) {
        MessagePlugin.error(d.error || '创建任务失败');
        return;
      }
      setJob(d.job);
      setJobOpen(true);
      MessagePlugin.success(`已开始为 ${ids.length} 件商品生成视频（串行执行，可关闭弹窗后台继续）`);
    } catch (e: any) {
      MessagePlugin.error('创建任务异常：' + (e?.message || e));
    }
  }, [storeId, selected, force]);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    await fetch(`/api/ml/miaoshou/video/job/${job.id}/cancel`, { method: 'POST' });
    MessagePlugin.info('已请求取消，当前商品处理完即停止');
  }, [job]);

  const toggleAll = useCallback(
    (checked: boolean) => {
      if (checked) setSelected(new Set(items.map((i) => i.itemId)));
      else setSelected(new Set());
    },
    [items],
  );

  const allChecked = items.length > 0 && items.every((i) => selected.has(i.itemId));
  const someChecked = items.some((i) => selected.has(i.itemId));
  const jobMap = useMemo(() => {
    const m: Record<string, JobItem> = {};
    for (const it of job?.items || []) m[it.itemId] = it;
    return m;
  }, [job]);

  /** 当前页有多少件能取到妙手源视频 */
  const pageLinked = useMemo(() => items.filter((i) => i.miaoshouDetailId).length, [items]);
  const aiOnlyVisible = items.some((i) => !i.miaoshouDetailId);

  const columns: PrimaryTableCol<Candidate>[] = [
    {
      colKey: 'row-select',
      title: <Checkbox checked={allChecked} indeterminate={someChecked && !allChecked} onChange={(v) => toggleAll(!!v)} />,
      width: 48,
    },
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 64,
      cell: ({ row }) =>
        row.thumbnail ? (
          <img
            src={row.thumbnail}
            style={{ width: 46, height: 46, objectFit: 'cover', borderRadius: 4 }}
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <div className="w-[46px] h-[46px] rounded bg-gray-100 flex items-center justify-center text-[10px] text-gray-400">
            无图
          </div>
        ),
    },
    {
      colKey: 'title',
      title: '商品',
      ellipsis: true,
      cell: ({ row }) => (
        <div>
          <div className="text-sm font-medium leading-snug">{row.title}</div>
          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
            <span className="text-[11px] text-gray-400">{row.itemId}</span>
            {row.permalink && (
              <a
                href={row.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
              >
                <ExternalLink size={10} /> ML
              </a>
            )}
            {row.miaoshouDetailId ? (
              <Tag
                size="small"
                variant="outline"
                theme="success"
                title={`妙手采集箱 detailId ${row.miaoshouDetailId}（配对方式：${LINK_LABEL[row.detailLink || 'none'] || '—'}）`}
              >
                <Link2 size={10} className="inline mr-0.5" />
                妙手 {row.miaoshouDetailId}
                {row.detailLink === 'title' ? '（标题配对）' : ''}
              </Tag>
            ) : (
              <Tag
                size="small"
                variant="light"
                theme="warning"
                title="没配到妙手采集箱商品，取不到源视频，只能靠 AI 图生视频"
              >
                无妙手关联
              </Tag>
            )}
            <Tag size="small" variant="light" theme="primary" title={SOURCE_HINT[row.expectedSource]}>
              预期来源：{SOURCE_LABEL[row.expectedSource]}
            </Tag>
            {(row.dupCount || 1) > 1 && (
              <Tag
                size="small"
                variant="light"
                theme="danger"
                title={`同一件商品（SKU 相同）在美客多有 ${row.dupCount} 条重复链接，列表只展示最新一条；其余重复链接请到美客多后台处理`}
              >
                同款重复 {row.dupCount}
              </Tag>
            )}
            {row.sellerSku && (
              <span className="text-[11px] text-gray-400" title={`卖家 SKU：${row.sellerSku}`}>
                SKU {row.sellerSku}
              </span>
            )}
            <span className="text-[11px] text-gray-400">
              {row.currencyId} {row.price} · 已售 {row.soldQuantity}
            </span>
          </div>
        </div>
      ),
    },
    {
      colKey: 'video',
      title: '视频状态',
      width: 210,
      cell: ({ row }) => {
        const st = videoState(row);
        const v = row.video;
        const ss = v?.siteStatuses || row.clip?.siteStatuses || {};
        const detail = Object.entries(ss)
          .filter(([, x]) => x)
          .map(([k, x]) => `${k}:${CLIP_LABEL[x as string] || x}`)
          .join('  ');
        const tip = [
          detail,
          v?.sourceKind ? `来源：${SOURCE_LABEL[v.sourceKind] || v.sourceKind}` : '',
          v?.stage ? `阶段：${STAGE_LABEL[v.stage] || v.stage}` : '',
          v?.error || '',
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <Tooltip content={<span style={{ whiteSpace: 'pre-wrap' }}>{tip || st.label}</span>} placement="top-left">
            <div className="flex flex-col gap-0.5">
              <Tag size="small" theme={st.theme} variant="light">
                📹 {st.label}
              </Tag>
              {v?.status === 'failed' && v.error && (
                <span className="text-[11px] text-red-500 line-clamp-2" title={v.error}>
                  {STAGE_LABEL[v.stage || ''] ? `[${STAGE_LABEL[v.stage || '']}] ` : ''}
                  {v.error}
                </span>
              )}
              {detail && <span className="text-[11px] text-gray-500">{detail}</span>}
            </div>
          </Tooltip>
        );
      },
    },
    {
      colKey: 'action',
      title: '操作',
      width: 190,
      fixed: 'right',
      cell: ({ row }) => {
        const v = row.video;
        const hasVideo = !!(v?.hasBackup || row.hasBackup);
        const jr = jobMap[row.itemId];
        const running = jr?.status === 'running' || jr?.status === 'pending';
        return (
          <Space size={2} breakLine>
            <Button size="small" variant="text" loading={busy[row.itemId] || running} onClick={() => generateOne(row)}>
              <Sparkles size={12} className="inline mr-0.5" />
              {v?.status === 'failed' || videoState(row).key === 'bad' ? '重试' : '生成并上传'}
            </Button>
            {hasVideo && (
              <Button
                size="small"
                variant="text"
                onClick={() => setVideoView({ key: row.recordKey, title: row.title })}
              >
                <Play size={12} className="inline mr-0.5" />
                查看视频
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  const jobPct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div className="px-5 pb-4 pt-2">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <Select
          value={storeId}
          onChange={(v) => {
            setStoreId(v as string);
            setSelected(new Set());
            setPage(1);
          }}
          style={{ width: 176 }}
          size="small"
          placeholder="选择店铺"
          options={activeStores.map((s) => ({ value: s.id, label: `${s.nickname}（${s.site}）` }))}
        />
        <Select
          value={link}
          onChange={(v) => {
            setLink(v as any);
            setSelected(new Set());
            setPage(1);
          }}
          style={{ width: 190 }}
          size="small"
          options={[
            { value: 'any', label: '全部商品' },
            { value: 'source', label: `有源视频${linkCounts ? ` (${linkCounts.source})` : ''}` },
            { value: 'ai', label: `只能 AI 生成${linkCounts ? ` (${linkCounts.ai})` : ''}` },
          ]}
        />
        <Input
          value={query}
          onChange={(v) => {
            const nv = String(v);
            setQuery(nv);
            // 清空输入框即恢复全量列表，不用再点一次「搜索」
            if (!nv.trim() && qApplied) {
              setQApplied('');
              setPage(1);
            }
          }}
          onEnter={() => {
            setQApplied(query.trim());
            setPage(1);
          }}
          placeholder="搜索 标题 / 商品ID / SKU / 妙手ID"
          style={{ width: 230 }}
          size="small"
          clearable
        />
        <Button
          size="small"
          variant="outline"
          onClick={() => {
            setQApplied(query.trim());
            setPage(1);
          }}
        >
          搜索
        </Button>
        <Button size="small" icon={<RefreshCw size={13} />} variant="outline" onClick={() => load()} loading={loading}>
          刷新
        </Button>
        <Button
          size="small"
          icon={<DownloadCloud size={13} />}
          variant="outline"
          loading={syncing}
          onClick={syncMiaoshou}
          title="从妙手拉取「已发布」列表，提高源视频配对率（配对靠标题前缀，因为 ML 商品没有 SKU）"
        >
          同步妙手发布记录
        </Button>
        <Checkbox checked={checkClip} onChange={(v) => setCheckClip(!!v)} label="查 ML 审核状态" />
        <Checkbox checked={force} onChange={(v) => setForce(!!v)} label="强制重新生成" />
        <span className="text-xs text-gray-500">
          共 {total} 件{selected.size > 0 ? ` · 已选 ${selected.size}` : ''}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="small"
            variant="outline"
            onClick={() => setSelected(new Set(items.map((i) => i.itemId)))}
            disabled={!items.length}
          >
            全选本页
          </Button>
          <Button
            size="small"
            variant="outline"
            disabled={!pageLinked}
            onClick={() => setSelected(new Set(items.filter((i) => i.miaoshouDetailId).map((i) => i.itemId)))}
            title="只勾选能取到妙手/1688 源视频的商品（成功率高）"
          >
            勾选有源视频({pageLinked})
          </Button>
          <Button size="small" variant="outline" disabled={!selected.size} onClick={() => setSelected(new Set())}>
            清空
          </Button>
          <Button theme="primary" disabled={!selected.size} onClick={generateBatch} icon={<CloudUpload size={14} />}>
            一键批量生成并上传({selected.size})
          </Button>
        </span>
      </div>

      {/* 搜索生效提示 */}
      {!!qApplied && (
        <div className="mb-2 text-xs px-3 py-1.5 rounded border border-blue-200 bg-blue-50 text-blue-700 flex items-center gap-2">
          <span>
            正在按「<strong>{qApplied}</strong>」过滤：命中 <strong>{total}</strong> 件
            （标题 / 商品ID / SKU / 妙手 detailId 都能搜）
          </span>
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setQuery('');
              setQApplied('');
              setPage(1);
            }}
          >
            清除
          </Button>
        </div>
      )}

      {/* 来源配对说明 */}
      {linkCounts && (
        <div className="mb-2 text-xs text-gray-500">
          源视频配对：
          <Tag size="small" theme="success" variant="light" className="mr-1">
            能取到源视频 {linkCounts.source}
          </Tag>
          <Tag size="small" theme="warning" variant="light" className="mr-1">
            只能 AI 生成 {linkCounts.ai}
          </Tag>
          {mergedAway > 0 && (
            <Tag size="small" variant="light" className="mr-1" title="同一 SKU 的多条重复链接已合并，只保留最新一条">
              已合并同款重复 {mergedAway} 条
            </Tag>
          )}
          <span className="text-gray-400">
            配对依据是妙手发布记录的标题前缀（SKU 取自 SELLER_SKU 属性）。数量偏低时点「同步妙手发布记录」再刷新。
          </span>
        </div>
      )}

      {/* AI 平台提示：只对「无妙手关联」的商品有影响 */}
      {aiProviders.length === 0 &&
        aiOnlyVisible && (
          <div className="mb-2 text-xs px-3 py-2 rounded border border-amber-300 bg-amber-50 text-amber-800 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <strong>没有配置可用的「视频」AI 模型</strong> —— 当前列表里
              <strong>没有配到妙手源视频</strong>的商品会生成失败（它们只能靠 AI 图生视频）。
              建议先把来源筛选切到「有源视频」再批量生成；或到「配置中心 → AI 配置」添加视频模型
              （如 火山方舟 Seedance、智谱 cogvideox-flash）。
            </div>
          </div>
        )}

      {aiProviders.length > 0 && (
        <div className="mb-2 text-xs text-gray-500">
          AI 图生视频可用平台：
          {aiProviders.map((p) => (
            <Tag key={`${p.platform}:${p.model}`} size="small" variant="outline" className="mr-1">
              {p.platform} · {p.model}
            </Tag>
          ))}
          <span className="text-gray-400">（按配置顺序尝试，第一个成功即用；账号欠费/限流会在失败原因里写明）</span>
        </div>
      )}

      {/* 索引构建进度 */}
      {building && (
        <div className="mb-2 text-xs px-3 py-2 rounded border border-blue-200 bg-blue-50 text-blue-700 flex items-center gap-3">
          <span>正在建立全店商品索引…</span>
          <Progress
            theme="line"
            percentage={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
            style={{ flex: 1 }}
          />
          <span>
            {progress.done}/{progress.total}
          </span>
        </div>
      )}

      {/* 批量任务进行中 */}
      {job && (
        <div className="mb-2 text-xs px-3 py-2 rounded border flex items-center gap-3 flex-wrap border-indigo-200 bg-indigo-50 text-indigo-800">
          <span className="font-medium">
            批量任务 {job.status === 'running' ? '进行中' : job.status === 'canceled' ? '已取消' : '已完成'}
          </span>
          <Progress theme="line" percentage={jobPct} style={{ flex: 1, minWidth: 120 }} />
          <span>
            {job.done}/{job.total} · 成功 {job.ok} · 跳过 {job.skipped} · 失败 {job.failed}
          </span>
          <Button size="small" variant="text" onClick={() => setJobOpen(true)}>
            查看详情
          </Button>
          {job.status === 'running' && (
            <Button size="small" variant="text" theme="danger" onClick={cancelJob}>
              <X size={12} className="inline mr-0.5" />
              取消
            </Button>
          )}
        </div>
      )}

      <Table
        data={items}
        columns={columns}
        rowKey="itemId"
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
            pageSizeOptions={[20, 50, 100]}
            onChange={({ current: c }) => setPage(c)}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(1);
            }}
          />
        </div>
      )}

      {!loading && total === 0 && storeId && (
        <div className="text-center py-10 text-gray-400 text-sm">
          {qApplied ? (
            <>
              没有匹配「<span className="text-gray-600">{qApplied}</span>」的在售商品。
              <br />
              <span className="text-xs">
                支持：标题关键词 / 美客多商品ID（CBT…）/ 卖家 SKU（如 623739534720）/ 妙手 detailId。
                确认商品没被美客多暂停、且索引已建好。
              </span>
              <div className="mt-3">
                <Button
                  size="small"
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setQApplied('');
                    setPage(1);
                  }}
                >
                  清除搜索条件
                </Button>
              </div>
            </>
          ) : (
            '该店铺没有在售商品（或索引尚未建好，请点「刷新」）'
          )}
        </div>
      )}

      {/* 批量任务详情 */}
      <Dialog
        visible={jobOpen}
        onClose={() => setJobOpen(false)}
        header={`批量视频任务 ${job ? `（${job.done}/${job.total}）` : ''}`}
        width="min(880px, 94vw)"
        footer={null}
      >
        {job && (
          <div className="space-y-3 max-h-[70vh] overflow-auto pr-1">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              <Tag theme="success">成功 {job.ok}</Tag>
              <Tag theme="warning">跳过 {job.skipped}</Tag>
              <Tag theme="danger">失败 {job.failed}</Tag>
              <Tag>共 {job.total}</Tag>
              <span className="text-gray-400 text-xs">
                {job.status === 'running'
                  ? `进行中：${job.current || '—'}`
                  : job.status === 'canceled'
                    ? '已取消'
                    : '已完成'}
              </span>
            </div>
            <Table
              data={job.items}
              rowKey="itemId"
              size="small"
              columns={[
                {
                  colKey: 'title',
                  title: '商品',
                  ellipsis: true,
                  cell: ({ row }) => (
                    <div>
                      <div className="text-xs">{row.title || row.itemId}</div>
                      <div className="text-[11px] text-gray-400">{row.itemId}</div>
                    </div>
                  ),
                },
                {
                  colKey: 'status',
                  title: '结果',
                  width: 82,
                  cell: ({ row }) => {
                    const map: Record<string, { t: any; l: string }> = {
                      pending: { t: 'default', l: '排队中' },
                      running: { t: 'primary', l: '处理中' },
                      ok: { t: 'success', l: '成功' },
                      skipped: { t: 'warning', l: '跳过' },
                      failed: { t: 'danger', l: '失败' },
                    };
                    const m = map[row.status] || { t: 'default', l: row.status };
                    return (
                      <Tag size="small" theme={m.t}>
                        {m.l}
                      </Tag>
                    );
                  },
                },
                {
                  colKey: 'sourceKind',
                  title: '来源',
                  width: 96,
                  cell: ({ row }) => (
                    <span className="text-[11px] text-gray-500">
                      {row.sourceKind ? SOURCE_LABEL[row.sourceKind] || row.sourceKind : '—'}
                    </span>
                  ),
                },
                {
                  colKey: 'error',
                  title: '阶段 / 失败原因',
                  ellipsis: true,
                  cell: ({ row }) => (
                    <span className={`text-[11px] ${row.status === 'failed' ? 'text-red-500' : 'text-gray-500'}`}>
                      {row.status === 'failed' && row.stage ? `[${STAGE_LABEL[row.stage] || row.stage}] ` : ''}
                      {row.error || (row.stage ? STAGE_LABEL[row.stage] || row.stage : '—')}
                    </span>
                  ),
                },
              ]}
            />
          </div>
        )}
      </Dialog>

      {/* 视频预览 */}
      <Dialog
        visible={!!videoView}
        onClose={() => setVideoView(null)}
        header={videoView?.title || '视频预览'}
        width="min(420px, 92vw)"
        footer={null}
      >
        {videoView && (
          <div className="space-y-2">
            <video
              src={`/api/ml/miaoshou/video/file/${encodeURIComponent(videoView.key)}`}
              controls
              autoPlay
              style={{ width: '100%', borderRadius: 6, background: '#000' }}
            />
            <div className="text-xs text-gray-500">
              1080×1920 · 9:16 · 10-61 秒 · 含音频（已符合 ML Clips 要求）
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

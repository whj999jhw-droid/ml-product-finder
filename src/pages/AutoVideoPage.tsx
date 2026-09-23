import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  Button,
  Card,
  Table,
  Tag,
  Select,
  Loading,
  MessagePlugin,
  Space,
  Switch,
  InputNumber,
  Collapse,
  Tooltip,
  Input,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import { PlayCircleIcon, PauseCircleIcon, StopIcon, RefreshIcon, TimeIcon, SearchIcon } from 'tdesign-icons-react';

type Phase = 'stopped' | 'running' | 'paused' | 'finished';
type Order = 'newest' | 'sold' | 'random';
type AiPromptMode = 'auto' | 'rule';

interface AutoVideoConfig {
  enabled: boolean;
  storeIds: string[];
  generatePerHour: number;
  uploadPerHour: number;
  onlyOnSale: boolean;
  skipExisting: boolean;
  order: Order;
  maxTotal: number;
  sites: string[];
  aiPromptMode: AiPromptMode;
  enableAiFallback: boolean;
  enableSlideshowFallback: boolean;
}

interface QueueItem {
  key: string;
  storeId: string;
  storeNick?: string;
  itemId: string;
  title: string;
  thumbnail?: string;
  state: 'pending' | 'generated' | 'uploaded' | 'failed';
  sourceKind?: string;
  error?: string;
  attempts: number;
  generatedAt?: number;
  uploadedAt?: number;
  clipUuid?: string;
}

interface StatusResp {
  config: AutoVideoConfig;
  state: {
    phase: Phase;
    startedAt?: number;
    finishedAt?: number;
    windowStart: number;
    generatedThisHour: number;
    uploadedThisHour: number;
    totalGenerated: number;
    totalUploaded: number;
    totalFailed: number;
    queue: QueueItem[];
    lastTickAt?: number;
    lastMessage?: string;
    lastError?: string;
  };
  counts: { pending: number; generated: number; uploaded: number; failed: number; total: number };
  windowLeftMs: number;
  ticking: boolean;
}

const SITE_OPTIONS = [
  { label: '🇲🇽 墨西哥 MLM', value: 'MLM' },
  { label: '🇧🇷 巴西 MLB', value: 'MLB' },
  { label: '🇨🇱 智利 MLC', value: 'MLC' },
  { label: '🇨🇴 哥伦比亚 MCO', value: 'MCO' },
];

const ORDER_OPTIONS = [
  { label: '最新上架优先', value: 'newest' },
  { label: '销量高优先', value: 'sold' },
  { label: '随机', value: 'random' },
];

const PROMPT_OPTIONS = [
  { label: 'LLM 写场景（失败降级规则）', value: 'auto' },
  { label: '只用本地规则（零成本）', value: 'rule' },
];

const STATE_TAG: Record<QueueItem['state'], { label: string; theme: 'default' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  pending: { label: '待生成', theme: 'default' },
  generated: { label: '待上传', theme: 'warning' },
  uploaded: { label: '已上传', theme: 'success' },
  failed: { label: '失败', theme: 'danger' },
};

const PHASE_TAG: Record<Phase, { label: string; theme: 'default' | 'primary' | 'success' | 'warning' | 'danger' }> = {
  stopped: { label: '已停止', theme: 'default' },
  running: { label: '运行中', theme: 'success' },
  paused: { label: '已暂停', theme: 'warning' },
  finished: { label: '已完成', theme: 'primary' },
};

const DEFAULT_CONFIG: AutoVideoConfig = {
  enabled: false,
  storeIds: [],
  generatePerHour: 10,
  uploadPerHour: 4,
  onlyOnSale: true,
  skipExisting: true,
  order: 'newest',
  maxTotal: 0,
  sites: ['MLM'],
  aiPromptMode: 'auto',
  enableAiFallback: true,
  enableSlideshowFallback: true,
};

export function AutoVideoPage() {
  const [config, setConfig] = useState<AutoVideoConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [rawQueue, setRawQueue] = useState<QueueItem[]>([]);
  const [stores, setStores] = useState<{ id: string; nickname: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [titleFilter, setTitleFilter] = useState('');
  const timerRef = useRef<number | null>(null);

  const api = useCallback(async (url: string, opts?: { method?: string; body?: any }) => {
    const r = await fetch(url, {
      method: opts?.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
    return j;
  }, []);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const s = (await api('/api/ml/auto-video/status')) as StatusResp;
      setStatus(s);
      setConfig(s.config);
    } catch (e: any) {
      // 静默：页面初次可能接口未就绪
    } finally {
      setLoadingStatus(false);
    }
  }, [api]);

  const loadQueue = useCallback(async () => {
    try {
      const q = (await api('/api/ml/auto-video/queue?limit=300')) as { items: QueueItem[] };
      setRawQueue(q.items || []);
    } catch {
      /* ignore */
    }
  }, [api]);

  const loadStores = useCallback(async () => {
    try {
      const j = (await api('/api/ml/stores')) as { stores: Array<{ id: string; nickname: string; authorized?: boolean }> };
      setStores((j.stores || []).filter((s) => s.authorized).map((s) => ({ id: s.id, nickname: s.nickname || s.id })));
    } catch {
      /* ignore */
    }
  }, [api]);

  useEffect(() => {
    loadStatus();
    loadQueue();
    loadStores();
  }, [loadStatus, loadQueue, loadStores]);

  // 轮询：running/paused 时每 5 秒刷新状态 + 队列
  useEffect(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    const phase = status?.state?.phase;
    if (phase === 'running' || phase === 'paused') {
      timerRef.current = window.setInterval(() => {
        loadStatus();
        loadQueue();
      }, 5000);
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [status?.state?.phase, loadStatus, loadQueue]);

  const action = useCallback(
    async (fn: () => Promise<any>, okMsg?: string) => {
      setBusy(true);
      try {
        await fn();
        if (okMsg) MessagePlugin.success(okMsg);
        await loadStatus();
        await loadQueue();
      } catch (e: any) {
        MessagePlugin.error(e?.message || '操作失败');
      } finally {
        setBusy(false);
      }
    },
    [api, loadStatus, loadQueue],
  );

  const saveConfig = async () => {
    await action(() => api('/api/ml/auto-video/config', { method: 'POST', body: config }), '配置已保存');
  };

  const patchConfig = (p: Partial<AutoVideoConfig>) => setConfig((c) => ({ ...c, ...p }));

  // 筛选 + 排序：默认按完成时间倒序，标题筛选模糊匹配
  const filteredQueue = useMemo(() => {
    let rows = rawQueue;
    if (titleFilter.trim()) {
      const kw = titleFilter.trim().toLowerCase();
      rows = rows.filter((r) =>
        (r.title || '').toLowerCase().includes(kw) ||
        (r.itemId || '').toLowerCase().includes(kw) ||
        (r.storeNick || '').toLowerCase().includes(kw),
      );
    }
    // 默认按 uploadedAt 倒序（完成时间最近在前），无完成时间的放后面
    return [...rows].sort((a, b) => {
      const aTime = a.uploadedAt || a.generatedAt || 0;
      const bTime = b.uploadedAt || b.generatedAt || 0;
      return bTime - aTime;
    });
  }, [rawQueue, titleFilter]);

  const columns: PrimaryTableCol<QueueItem>[] = [
    { colKey: 'title', title: '商品', width: 320, ellipsis: true, cell: ({ row }) => (
      <div className="flex items-center gap-2">
        {row.thumbnail ? (
          <img src={row.thumbnail} alt="" className="w-9 h-9 object-cover rounded" />
        ) : null}
        <span className="text-sm line-clamp-2">{row.title || row.itemId}</span>
      </div>
    ) },
    { colKey: 'storeNick', title: '店铺', width: 110, cell: ({ row }) => <span className="text-xs text-gray-500">{row.storeNick || row.storeId.slice(0, 8)}</span> },
    { colKey: 'state', title: '状态', width: 90, cell: ({ row }) => {
      const t = STATE_TAG[row.state];
      return <Tag theme={t.theme} variant="light">{t.label}</Tag>;
    } },
    { colKey: 'sourceKind', title: '来源', width: 80, cell: ({ row }) => <span className="text-xs text-gray-500">{row.sourceKind || '-'}</span> },
    { colKey: 'attempts', title: '重试', width: 60, cell: ({ row }) => <span className="text-xs">{row.attempts}</span> },
    { colKey: 'error', title: '备注/错误', minWidth: 160, ellipsis: true, cell: ({ row }) => (
      <span className="text-xs text-red-500">{row.error || '-'}</span>
    ) },
    { colKey: 'uploadedAt', title: '完成时间', width: 150, cell: ({ row }) => (
      <span className="text-xs text-gray-500">
        {row.uploadedAt ? new Date(row.uploadedAt).toLocaleString('zh-CN', { hour12: false }) : '-'}
      </span>
    ) },
  ];

  const phase = status?.state?.phase || 'stopped';
  const counts = status?.counts;
  const fmtLeft = status ? `${(status.windowLeftMs / 60000).toFixed(1)} 分钟` : '-';

  return (
    <div className="p-4 max-w-[1200px] mx-auto space-y-4">
      {/* 顶部标题 + 说明 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <TimeIcon /> 自动视频流水线
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            每小时生成 N 个商品视频、上传 3~6 条到美客多；生成完不再生成、上传完不再上传，全部结束自动停止。
          </p>
        </div>
        <Tag theme={PHASE_TAG[phase].theme} variant="light" size="large">{PHASE_TAG[phase].label}</Tag>
      </div>

      {/* 状态卡 */}
      <Card title="运行状态" bordered>
        {loadingStatus && !status ? <Loading /> : null}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
          <Stat label="待生成" value={counts?.pending ?? 0} />
          <Stat label="待上传" value={counts?.generated ?? 0} theme="warning" />
          <Stat label="已上传" value={counts?.uploaded ?? 0} theme="success" />
          <Stat label="失败" value={counts?.failed ?? 0} theme="danger" />
          <Stat label="队列总计" value={counts?.total ?? 0} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-sm">
          <Stat label="本小时已生成" value={`${status?.state.generatedThisHour ?? 0}/${config.generatePerHour}`} />
          <Stat label="本小时已上传" value={`${status?.state.uploadedThisHour ?? 0}/${config.uploadPerHour}`} />
          <Stat label="距本小时窗口结束" value={fmtLeft} />
          <Stat label="累计生成/上传" value={`${status?.state.totalGenerated ?? 0}/${status?.state.totalUploaded ?? 0}`} />
        </div>
        {status?.state.lastMessage ? (
          <div className="text-sm text-gray-600 mb-1">📋 {status.state.lastMessage}</div>
        ) : null}
        {status?.state.lastError ? (
          <div className="text-sm text-red-500 mb-1">⚠️ {status.state.lastError}</div>
        ) : null}

        <Space className="mt-3">
          {phase === 'running' ? (
            <>
              <Button theme="warning" icon={<PauseCircleIcon />} loading={busy} onClick={() => action(() => api('/api/ml/auto-video/pause', { method: 'POST' }), '已暂停')}>
                暂停
              </Button>
              <Button theme="danger" icon={<StopIcon />} loading={busy} onClick={() => action(() => api('/api/ml/auto-video/stop', { method: 'POST' }), '已停止并清空')}>
                停止并清空
              </Button>
            </>
          ) : (
            <Button theme="primary" icon={<PlayCircleIcon />} loading={busy} onClick={() => action(() => api('/api/ml/auto-video/start', { method: 'POST', body: { rebuild: true } }), '已开始')}>
              {phase === 'paused' ? '重新开始（重建队列）' : '开始'}
            </Button>
          )}
          {phase === 'paused' ? (
            <Button theme="primary" icon={<PlayCircleIcon />} loading={busy} onClick={() => action(() => api('/api/ml/auto-video/resume', { method: 'POST' }), '已继续')}>
              继续
            </Button>
          ) : null}
          <Button theme="default" icon={<RefreshIcon />} loading={busy} onClick={() => action(() => api('/api/ml/auto-video/refresh', { method: 'POST' }), '已刷新队列')}>
            重新扫描店铺
          </Button>
          <Button theme="default" variant="outline" loading={busy} onClick={() => action(() => api('/api/ml/auto-video/tick', { method: 'POST' }), '已手动跑一轮')}>
            立即执行一轮
          </Button>
        </Space>
      </Card>

      {/* 配置卡 */}
      <Card title="配置" bordered>
        <Collapse defaultValue={['base']} className="mb-3">
          <Collapse.Panel value="base" header="基础参数（点击展开/收起）">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
              <Field label="开启后自动开跑">
                <Switch value={config.enabled} onChange={(v) => patchConfig({ enabled: !!v })} />
              </Field>
              <Field label="每小时生成数（0~50）">
                <InputNumber value={config.generatePerHour} min={0} max={50} onChange={(v) => patchConfig({ generatePerHour: Number(v) || 0 })} />
              </Field>
              <Field label="每小时上传数（0~20，建议≤6）">
                <InputNumber value={config.uploadPerHour} min={0} max={20} onChange={(v) => patchConfig({ uploadPerHour: Number(v) || 0 })} />
              </Field>
              <Field label="整轮上限（0=不限）">
                <InputNumber value={config.maxTotal} min={0} max={100000} onChange={(v) => patchConfig({ maxTotal: Number(v) || 0 })} />
              </Field>
              <Field label="队列排序">
                <Select value={config.order} options={ORDER_OPTIONS} onChange={(v) => patchConfig({ order: v as Order })} style={{ width: '100%' }} />
              </Field>
              <Field label="AI 动作指令模式">
                <Select value={config.aiPromptMode} options={PROMPT_OPTIONS} onChange={(v) => patchConfig({ aiPromptMode: v as AiPromptMode })} style={{ width: '100%' }} />
              </Field>
              <Field label="只处理真正在售商品">
                <Switch value={config.onlyOnSale} onChange={(v) => patchConfig({ onlyOnSale: !!v })} />
              </Field>
              <Field label="跳过已有视频/备份">
                <Switch value={config.skipExisting} onChange={(v) => patchConfig({ skipExisting: !!v })} />
              </Field>
              <Field label="允许 AI 图生视频兜底">
                <Switch value={config.enableAiFallback} onChange={(v) => patchConfig({ enableAiFallback: !!v })} />
              </Field>
              <Field label="允许图集运镜兜底（AI 全挂时零成本保底）">
                <Switch value={config.enableSlideshowFallback} onChange={(v) => patchConfig({ enableSlideshowFallback: !!v })} />
              </Field>
              <Field label="上传站点">
                <Select multiple value={config.sites} options={SITE_OPTIONS} onChange={(v) => patchConfig({ sites: (v as string[]) || [] })} style={{ width: '100%' }} />
              </Field>
              <Field label="参与店铺（空=全部已授权）">
                <Select multiple value={config.storeIds} options={stores.map((s) => ({ label: s.nickname, value: s.id }))} onChange={(v) => patchConfig({ storeIds: (v as string[]) || [] })} style={{ width: '100%' }} placeholder="全部已授权店铺" />
              </Field>
            </div>
            <div className="mt-4">
              <Button theme="primary" loading={busy} onClick={saveConfig}>保存配置</Button>
              <Tooltip content="开启「开启后自动开跑」并保存，或点上方「开始」即可运行">
                <span className="ml-3 text-xs text-gray-400">提示：保存配置不会立即开跑，需点「开始」</span>
              </Tooltip>
            </div>
          </Collapse.Panel>
        </Collapse>
      </Card>

      {/* 队列卡 */}
      <Card title="队列明细" bordered>
        <div className="mb-3 flex items-center gap-2">
          <SearchIcon className="text-gray-400" size={16} />
          <Input
            placeholder="按商品名/ID/店铺名筛选（留空显示全部）"
            value={titleFilter}
            onChange={(v) => setTitleFilter(v as string)}
            allowClear
            style={{ maxWidth: 360 }}
          />
          <span className="text-xs text-gray-400">默认按完成时间倒序 · 共 {filteredQueue.length} 条</span>
        </div>
        <Table
          data={filteredQueue}
          columns={columns}
          rowKey="key"
          size="small"
          maxHeight={520}
          pagination={{ defaultPageSize: 20, total: filteredQueue.length }}
          loading={busy}
        />
      </Card>
    </div>
  );
}

function Stat({ label, value, theme }: { label: string; value: string | number; theme?: 'warning' | 'success' | 'danger' }) {
  const color = theme === 'warning' ? 'text-orange-500' : theme === 'success' ? 'text-green-600' : theme === 'danger' ? 'text-red-500' : 'text-gray-900';
  return (
    <div className="rounded-lg bg-gray-50 p-3 text-center">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-gray-600">{label}</span>
      {children}
    </div>
  );
}

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
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';

interface Candidate {
  id: number;
  site: string;
  ml_title: string;
  ml_price_usd: number;
  ml_thumbnail: string;
  ml_permalink: string;
  ali1688_price_cny: number;
  ali1688_url: string;
  ali1688_image_url: string;
  listing_price_usd: number;
  profit_net_usd: number;
  profit_rate: number;
  roi: number;
  score_total: number;
  score_demand: number;
  score_competition: number;
  score_profit: number;
  score_logistics: number;
  score_compliance: number;
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
  const [status, setStatus] = useState<string>('pending');
  const [running, setRunning] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreIds, setSelectedStoreIds] = useState<string[]>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishRow, setPublishRow] = useState<Candidate | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [useCbtCategory, setUseCbtCategory] = useState(true);
  const [akDialogOpen, setAkDialogOpen] = useState(false);
  const [akValue, setAkValue] = useState('');
  const [akSaving, setAkSaving] = useState(false);
  const [akStatus, setAkStatus] = useState<{ configured?: boolean; message?: string }>({});
  const [latestRun, setLatestRun] = useState<SourcingRun | null>(null);
  const [runStartTime, setRunStartTime] = useState<number | null>(null);
  const [elapsedText, setElapsedText] = useState('');
  const [runPollError, setRunPollError] = useState<string | null>(null);

  const fetchAkStatus = async () => {
    try {
      const res = await fetch('/api/ml/ali1688/config');
      const data = await res.json();
      setAkStatus({ configured: data?.configured, message: data?.message || '' });
    } catch {
      setAkStatus({ configured: false, message: '无法检测 AK 状态' });
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
    fetchLatestRun();
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

  const handleSaveAk = async () => {
    if (!akValue.trim()) {
      MessagePlugin.warning('请输入 AK');
      return;
    }
    setAkSaving(true);
    try {
      const res = await fetch('/api/ml/ali1688/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ak: akValue.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('AK 已保存');
        setAkDialogOpen(false);
        setAkValue('');
        fetchAkStatus();
      } else {
        MessagePlugin.error(data.message || '保存失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setAkSaving(false);
    }
  };

  const fetchRows = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ml/candidates?status=${status}&limit=100`);
      const data = await res.json();
      if (data.success) {
        setRows(data.rows);
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
        body: JSON.stringify({ maxCandidatesToSource: 20, targetNetRate: 0.15 }),
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

  const openPublish = (row: Candidate) => {
    setPublishRow(row);
    setSelectedStoreIds(stores.filter((s) => s.enabled && s.authorized).map((s) => s.id));
    setPublishOpen(true);
  };

  const handlePublish = async () => {
    if (!publishRow) return;
    if (selectedStoreIds.length === 0) {
      MessagePlugin.warning('请至少选择一个店铺');
      return;
    }
    setPublishing(true);
    try {
      const res = await fetch(`/api/ml/candidates/${publishRow.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeIds: selectedStoreIds, useCbtCategory }),
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

  const columns: PrimaryTableCol<Candidate>[] = [
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 90,
      cell: ({ row }) => {
        const src = row.ali1688_image_url || row.ml_thumbnail;
        return src ? (
          <img
            src={src}
            alt=""
            className="w-16 h-16 object-cover rounded border border-gray-100"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.onerror = null;
              img.src = 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%23f3f4f6%22/><text x=%2250%22 y=%2255%22 font-size=%2212%22 fill=%22%239ca3af%22 text-anchor=%22middle%22>无图</text></svg>';
            }}
          />
        ) : (
          <div className="w-16 h-16 rounded bg-gray-100 flex items-center justify-center text-xs text-gray-400 border border-gray-100">
            无图
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
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }) => {
        const s = statusMap[row.status] || { label: row.status, theme: 'default' };
        return <Tag theme={s.theme}>{s.label}</Tag>;
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
            <Button
              variant="outline"
              theme={akStatus.configured ? 'success' : 'default'}
              onClick={() => setAkDialogOpen(true)}
            >
              {akStatus.configured ? '1688 AK 已配置' : '配置 1688 AK'}
            </Button>
          </Space>
          <Select
            value={status}
            onChange={(v) => setStatus(v as string)}
            options={[
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
      </Card>

      <Dialog
        visible={publishOpen}
        onClose={() => setPublishOpen(false)}
        header="一键上架"
        onConfirm={handlePublish}
        confirmLoading={publishing}
      >
        <div className="space-y-4">
          <p>选择要上架的目标店铺：</p>
          <div className="space-y-2 max-h-60 overflow-auto">
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
          <div className="flex items-center gap-2">
            <Switch value={useCbtCategory} onChange={(v) => setUseCbtCategory(v as boolean)} />
            <span>使用 CBT 类目前缀（上架失败可关闭）</span>
          </div>
        </div>
      </Dialog>

      <Dialog
        visible={akDialogOpen}
        onClose={() => setAkDialogOpen(false)}
        header="配置 1688 AK"
        onConfirm={handleSaveAk}
        confirmLoading={akSaving}
      >
        <div className="space-y-4">
          <p>
            请将 1688 AI 版 App 里获取到的 AK 粘贴到下方。
            <span className="text-red-500">AK 仅保存在服务器本地，不会上传到第三方。</span>
          </p>
          <input
            type="text"
            value={akValue}
            onChange={(e) => setAkValue(e.target.value)}
            placeholder="例如：ak_xxxxxxxxxxxxxxxx"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="text-xs text-gray-500">
            当前状态：{akStatus.configured ? '已配置' : '未配置'}
            {akStatus.message ? `（${akStatus.message}）` : ''}
          </div>
        </div>
      </Dialog>
    </div>
  );
}

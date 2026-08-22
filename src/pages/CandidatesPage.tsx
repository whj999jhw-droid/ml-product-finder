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
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';

interface Candidate {
  id: number;
  site: string;
  ml_title: string;
  ml_price_usd: number;
  ml_thumbnail: string;
  ml_permalink: string;
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

  const openPublish = (row: Candidate) => {
    setPublishRow(row);
    setSelectedStoreIds(stores.filter((s) => s.enabled && s.authorized).map((s) => s.id));
    setUploadYoutube(false);
    setYoutubeVideoPath('');
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
        body: JSON.stringify({
          storeIds: selectedStoreIds,
          useCbtCategory,
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
      width: 100,
      cell: ({ row }) => {
        const s = statusMap[row.status] || { label: row.status, theme: 'default' };
        const title = row.status === 'rejected' && row.reject_reason ? row.reject_reason : undefined;
        return <Tag theme={s.theme} title={title}>{s.label}</Tag>;
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
        {publishRow && (
          <div className="space-y-4 max-h-[70vh] overflow-auto pr-2">
            {/* 基本信息 */}
            <div className="flex gap-4">
              <div className="flex-shrink-0">
                {publishRow.ali1688_image_url || publishRow.ml_thumbnail ? (
                  <img
                    src={publishRow.ali1688_image_url || publishRow.ml_thumbnail}
                    alt=""
                    className="w-32 h-32 object-cover rounded border border-gray-100"
                    onError={(e) => {
                      const img = e.target as HTMLImageElement;
                      img.onerror = null;
                      img.style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-32 h-32 rounded bg-gray-100 flex items-center justify-center text-sm text-gray-400">
                    无图
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-1 text-sm">
                <div className="font-medium text-base">{publishRow.ml_title || publishRow.ali1688_title}</div>
                <div className="text-gray-500">
                  站点：<Tag size="small">{publishRow.site}</Tag>
                  {publishRow.ml_category_name && <span className="ml-2">类目：{publishRow.ml_category_name}</span>}
                </div>
                <div className="text-gray-500">
                  竞品售价：<span className="text-blue-600 font-medium">${publishRow.ml_price_usd?.toFixed(2)}</span>
                  <span className="ml-4">建议售价：<span className="text-blue-600 font-medium">${publishRow.listing_price_usd?.toFixed(2)}</span></span>
                </div>
                <div className="text-gray-500">
                  净利润：<span className="text-green-600 font-medium">${publishRow.profit_net_usd?.toFixed(2)} ({((publishRow.profit_rate || 0) * 100).toFixed(0)}%)</span>
                  <span className="ml-4">ROI：<span className="text-green-600 font-medium">{(publishRow.roi || 0).toFixed(2)}</span></span>
                </div>
                <div className="text-gray-500">
                  重量/尺寸：{(publishRow.weight_kg ? `${(publishRow.weight_kg * 1000).toFixed(0)}g` : '未知')}
                  {publishRow.length_cm ? ` / ${publishRow.length_cm}×${publishRow.width_cm}×${publishRow.height_cm} cm` : ''}
                </div>
              </div>
            </div>

            {/* AI 研判 */}
            {publishRow.ai_evaluation_json && (
              <div className="bg-gray-50 p-3 rounded">
                <div className="text-sm font-medium mb-1">AI 研判</div>
                {(() => {
                  const ev = parseAiEvaluation(publishRow.ai_evaluation_json);
                  if (!ev) return null;
                  return (
                    <div className="text-sm">
                      <Tag theme={ev.pass ? 'success' : 'danger'} size="small">{ev.pass ? '通过' : '不通过'}</Tag>
                      <span className="ml-2 text-gray-600">{ev.reason}</span>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* 1688 货源 */}
            <div>
              <div className="text-sm font-medium mb-1">1688 货源</div>
              <div className="text-sm text-gray-600 space-y-1">
                {publishRow.ali1688_title && <div>标题：{publishRow.ali1688_title}</div>}
                <div>
                  价格：¥{publishRow.ali1688_price_cny?.toFixed(2)}
                  {publishRow.ali1688_url && (
                    <a href={publishRow.ali1688_url} target="_blank" rel="noreferrer" className="ml-2 text-blue-600 hover:underline">
                      查看货源
                    </a>
                  )}
                </div>
                {publishRow.ali1688_supplier && <div>供应商：{publishRow.ali1688_supplier}</div>}
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

            {/* 加分项：上架前把商品视频上传到 YouTube */}
            <div className="border border-gray-100 rounded p-3">
              <div className="flex items-center gap-2 mb-2">
                <Switch value={uploadYoutube} onChange={(v) => setUploadYoutube(v as boolean)} />
                <span className="text-sm font-medium">上架后上传商品视频到 YouTube</span>
                {!ytConfigured && (
                  <Tag size="small" theme="warning">未授权</Tag>
                )}
              </div>
              {uploadYoutube && (
                <div className="space-y-2">
                  <div className="text-xs text-gray-500">
                    填写服务器上视频文件的<strong>绝对路径</strong>（如 /data/videos/abc.mp4）。图生视频需你先用 Luma/Kling 等工具生成。
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
                  <div className="text-xs text-gray-400">
                    上传成功后，视频链接会自动写入商品描述。上传失败不影响正常上架。
                  </div>
                </div>
              )}
            </div>

            <div className="text-xs text-gray-400 bg-yellow-50 p-2 rounded">
              提示：确认上架后，系统会自动生成西/葡语标题和描述，并将图片上传至 Mercado Libre 图床后发布。
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

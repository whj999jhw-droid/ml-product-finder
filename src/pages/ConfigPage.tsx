import { useState, useEffect } from 'react';
import {
  Tabs,
  Card,
  Button,
  Input,
  Switch,
  Tag,
  MessagePlugin,
  Loading,
  Link,
  Select,
} from 'tdesign-react';
import { RefreshIcon, DeleteIcon, AddIcon } from 'tdesign-icons-react';
import { NotificationSettingsPage } from './NotificationSettingsPage';
import { StoreManagementPage } from './StoreManagementPage';

interface LlmProviderForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 多个模型用逗号隔开，如 gpt-4o, gpt-4o-mini, deepseek-chat */
  models: string;
  /** 调用方式：openai 兼容 / 火山方舟 REST / 火山方舟 SDK */
  type?: 'openai' | 'volcano-rest' | 'volcano-sdk';
}

const LLM_TYPE_OPTIONS: { label: string; value: LlmProviderForm['type'] }[] = [
  { label: 'OpenAI 兼容 (REST)', value: 'openai' },
  { label: '火山方舟 REST', value: 'volcano-rest' },
  { label: '火山方舟 SDK', value: 'volcano-sdk' },
];

interface FeatureInfo {
  key: string;
  name: string;
  desc: string;
  fallback: string;
}

interface AiStatus {
  envConfigured: { baseUrl: boolean; apiKey: boolean; model: boolean };
  envActive: boolean;
  providerCount: number;
  providers: { name: string; baseUrl: string; model: string }[];
  features: FeatureInfo[];
}

// ============ AI 大模型配置面板 ============
function AiConfigPanel() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [providers, setProviders] = useState<LlmProviderForm[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/ml/ai-config/status');
      const data = await res.json();
      if (data.success) setStatus(data);
    } catch {
      /* ignore */
    }
  };

  const loadProviders = async () => {
    try {
      const res = await fetch('/api/ml/llm-config');
      const data = await res.json();
      const raw: any[] = data.providers || [];
      // 合并「同一 baseUrl + type 的多个 model」为一条表单记录（models 用逗号拼接）
      const byBase = new Map<string, LlmProviderForm>();
      for (const p of raw) {
        const base = (p.baseUrl || '').trim();
        if (!base) continue;
        const type = p.type || 'openai';
        const key = `${base}|${type}`;
        const existing = byBase.get(key);
        if (existing) {
          if (p.model && !existing.models.split(/[,，]/).map((m: string) => m.trim()).includes(p.model)) {
            existing.models = `${existing.models}, ${p.model}`;
          }
        } else {
          byBase.set(key, {
            name: p.name || '平台 1',
            baseUrl: p.baseUrl || '',
            apiKey: '', // 出于安全不回显 Key；留空=复用已保存
            models: p.model || '',
            type,
          });
        }
      }
      const list = Array.from(byBase.values());
      setProviders(list.length ? list : [{ name: '平台 1', baseUrl: '', apiKey: '', models: '', type: 'openai' }]);
    } catch {
      setProviders([{ name: '平台 1', baseUrl: '', apiKey: '', models: '', type: 'openai' }]);
    }
  };

  useEffect(() => {
    loadStatus();
    loadProviders();
  }, []);

  const updateProvider = (i: number, patch: Partial<LlmProviderForm>) => {
    setProviders((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ml/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success(data.message || 'AI 配置已保存');
        loadStatus();
        loadProviders();
        setTestResult(null);
      } else {
        MessagePlugin.error(data.message || '保存失败');
      }
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ml/llm-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      const data = await res.json();
      setTestResult(data);
      if (data.success) MessagePlugin.success('测试完成，见下方结果');
      else MessagePlugin.warning(data.message || '测试未通过');
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* 环境变量兜底提示 */}
      {status?.envActive ? (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm p-3 rounded">
          检测到环境变量 <code>LLM_BASE_URL</code> / <code>LLM_API_KEY</code> / <code>LLM_MODEL</code> 已配置，
          <strong> 优先级最高</strong>，会覆盖下方文件配置并排在最前。下方文件配置仍作为兜底/多平台 failover 使用。
        </div>
      ) : (
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 text-sm p-3 rounded">
          未检测到完整的环境变量 <code>LLM_*</code>（baseUrl/apiKey/model 需三者齐全才生效）。
          当前使用下方「文件配置」；环境变量仅部分配置时：
          {status && (
            <span className="ml-1">
              baseUrl {status.envConfigured.baseUrl ? '✅' : '❌'} / apiKey {status.envConfigured.apiKey ? '✅' : '❌'} / model {status.envConfigured.model ? '✅' : '❌'}
            </span>
          )}
        </div>
      )}

      {/* 平台列表 */}
      <Card title="LLM 平台（多平台自动 failover）" headerBordered>
        <div className="space-y-3">
          {providers.map((p, i) => (
            <div key={i} className="border border-gray-100 rounded p-3 space-y-3">
              <div className="text-xs font-medium text-gray-500">平台 {i + 1}</div>
              {/* 第一行：平台名 · 链接 · API Key */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                <Input
                  className="md:col-span-2"
                  size="small"
                  value={p.name}
                  onChange={(v) => updateProvider(i, { name: v as string })}
                  placeholder="平台名"
                />
                <Input
                  className="md:col-span-6"
                  size="small"
                  value={p.baseUrl}
                  onChange={(v) => updateProvider(i, { baseUrl: v as string })}
                  placeholder="链接 / baseUrl（https://.../v1）"
                />
                <Input
                  className="md:col-span-3"
                  size="small"
                  type="password"
                  value={p.apiKey}
                  onChange={(v) => updateProvider(i, { apiKey: v as string })}
                  placeholder={status ? '留空=复用已保存' : 'API Key'}
                />
                <Button
                  className="md:col-span-1"
                  size="small"
                  variant="text"
                  theme="danger"
                  icon={<DeleteIcon />}
                  onClick={() => setProviders((prev) => prev.filter((_, idx) => idx !== i))}
                />
              </div>
              {/* 第二行：调用方式 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 shrink-0">调用方式</span>
                <Select
                  className="w-44"
                  size="small"
                  value={p.type || 'openai'}
                  options={LLM_TYPE_OPTIONS}
                  onChange={(v) => updateProvider(i, { type: v as LlmProviderForm['type'] })}
                />
                <span className="text-xs text-gray-400">
                  火山图片生成选「火山方舟 REST」并填 <code>https://ark.cn-beijing.volces.com/api/v3/images/generations</code>；想用官方 SDK 选「火山方舟 SDK」。
                </span>
              </div>
              {/* 第三行：多个模型，逗号隔开 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 shrink-0">模型（逗号隔开）</span>
                <Input
                  className="flex-1"
                  size="small"
                  value={p.models}
                  onChange={(v) => updateProvider(i, { models: v as string })}
                  placeholder="gpt-4o, gpt-4o-mini, deepseek-chat"
                />
              </div>
              <div className="text-xs text-gray-400">
                第一行填平台名 / 链接(baseUrl) / API Key（修改其他项时 Key 留空即复用已保存，不会丢失）；
                第二行多个模型用<strong>逗号</strong>隔开，会按序自动 failover。
              </div>
            </div>
          ))}
          <Button size="small" variant="dashed" icon={<AddIcon />} onClick={() => setProviders((prev) => [...prev, { name: `平台 ${prev.length + 1}`, baseUrl: '', apiKey: '', models: '', type: 'openai' }])}>
            添加平台
          </Button>
          <div className="flex items-center gap-2 pt-1">
            <Button size="small" theme="primary" loading={saving} onClick={handleSave}>
              保存配置
            </Button>
            <Button size="small" variant="outline" loading={testing} onClick={handleTest}>
              测试连接
            </Button>
            <Button size="small" variant="text" icon={<RefreshIcon />} onClick={() => { loadStatus(); loadProviders(); }}>
              刷新
            </Button>
          </div>
        </div>

        {/* 测试结果 */}
        {testResult?.perProvider && (
          <div className="mt-3 space-y-2">
            {testResult.perProvider.map((r: any, i: number) => (
              <div key={i} className="text-xs border border-gray-100 rounded p-2">
                <div className="flex items-center gap-2">
                  <Tag size="small" theme={r.success ? 'success' : 'danger'}>{r.success ? '成功' : '失败'}</Tag>
                  <span className="font-medium">{r.name}</span>
                  <span className="text-gray-500">{r.model}</span>
                </div>
                <div className="text-gray-600 mt-1">{r.message || ''}</div>
                {r.sample && (
                  <div className="text-gray-500 mt-1">示例：{JSON.stringify(r.sample)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 规则引擎兜底 */}
      <Card title="兜底机制（AI 不可用时）" headerBordered>
        <div className="text-sm text-gray-600 mb-3">
          当所有 LLM 平台均未配置或调用失败时，系统按以下规则兜底，<strong>不会中断业务流程</strong>：
        </div>
        <div className="space-y-2">
          {status?.features?.map((f) => (
            <div key={f.key} className="border border-gray-100 rounded p-2">
              <div className="text-sm font-medium">{f.name}</div>
              <div className="text-xs text-gray-500">{f.desc}</div>
              <div className="text-xs text-orange-600 mt-1">兜底：{f.fallback}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* AI 使用场景 */}
      <Card title="AI 一处配置，多处复用" headerBordered>
        <div className="text-sm text-gray-600 mb-3">
          下方所有功能共用上方同一套 LLM 配置，配置一次即可在以下场景生效：
        </div>
        <div className="flex flex-wrap gap-2">
          {status?.features?.map((f) => (
            <Tag key={f.key} theme="primary" variant="light" size="medium">{f.name}</Tag>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ============ 1688 货源配置面板 ============
function Ali1688ConfigPanel() {
  const [akValue, setAkValue] = useState('');
  const [akSaving, setAkSaving] = useState(false);
  const [akStatus, setAkStatus] = useState<{ configured?: boolean; message?: string }>({});

  const fetchAkStatus = async () => {
    try {
      const res = await fetch('/api/ml/ali1688/config');
      const data = await res.json();
      setAkStatus({ configured: data?.configured, message: data?.message || '' });
    } catch {
      setAkStatus({ configured: false, message: '无法检测 AK 状态' });
    }
  };

  useEffect(() => { fetchAkStatus(); }, []);

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

  return (
    <Card title="1688 货源 AK" headerBordered>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          将 1688 AI 版 App 里获取到的 AK 粘贴到下方。
          <span className="text-red-500">AK 仅保存在服务器本地，不会上传到第三方。</span>
        </p>
        <Input
          type="password"
          value={akValue}
          onChange={(v) => setAkValue(v as string)}
          placeholder="例如：ak_xxxxxxxxxxxxxxxx"
        />
        <div className="flex items-center gap-3">
          <Button theme="primary" loading={akSaving} onClick={handleSaveAk}>
            保存 AK
          </Button>
          <span className="text-xs">
            当前状态：
            <Tag size="small" theme={akStatus.configured ? 'success' : 'default'}>
              {akStatus.configured ? '已配置' : '未配置'}
            </Tag>
            {akStatus.message ? <span className="text-gray-500 ml-1">（{akStatus.message}）</span> : null}
          </span>
        </div>
      </div>
    </Card>
  );
}

// ============ YouTube 上传配置面板 ============
function YouTubeConfigPanel() {
  const [ytClientId, setYtClientId] = useState('');
  const [ytClientSecret, setYtClientSecret] = useState('');
  const [ytAuthUrl, setYtAuthUrl] = useState('');
  const [ytCode, setYtCode] = useState('');
  const [ytConfigured, setYtConfigured] = useState(false);
  const [ytSaving, setYtSaving] = useState(false);
  const [ytMsg, setYtMsg] = useState('');

  const fetchYouTubeStatus = async () => {
    try {
      const res = await fetch('/api/ml/youtube/status');
      const data = await res.json();
      setYtConfigured(!!data?.configured);
    } catch {
      setYtConfigured(false);
    }
  };

  useEffect(() => { fetchYouTubeStatus(); }, []);

  const handleSaveYtClient = async () => {
    if (!ytClientId.trim() || !ytClientSecret.trim()) {
      MessagePlugin.warning('请填写 client_id 与 client_secret');
      return;
    }
    setYtSaving(true);
    try {
      const res = await fetch('/api/ml/youtube/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: ytClientId.trim(), clientSecret: ytClientSecret.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setYtMsg('已保存，下一步：点击「获取授权链接」');
        MessagePlugin.success('client_id/secret 已保存');
        fetchYouTubeStatus();
      } else {
        setYtMsg(data.message || '保存失败');
      }
    } catch (e: any) {
      setYtMsg(e?.message || '网络错误');
    } finally {
      setYtSaving(false);
    }
  };

  const handleFetchYtAuthUrl = async () => {
    setYtMsg('');
    try {
      const res = await fetch('/api/ml/youtube/auth-url');
      const data = await res.json();
      if (data.success && data.url) {
        setYtAuthUrl(data.url);
        setYtMsg('已生成授权链接，请在浏览器打开并复制 code');
      } else {
        setYtMsg(data.message || '生成授权链接失败（请先保存 client_id/secret）');
      }
    } catch (e: any) {
      setYtMsg(e?.message || '网络错误');
    }
  };

  const handleExchangeYtCode = async () => {
    if (!ytCode.trim()) {
      MessagePlugin.warning('请粘贴授权后得到的 code');
      return;
    }
    setYtSaving(true);
    try {
      const res = await fetch('/api/ml/youtube/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ytCode.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        MessagePlugin.success('YouTube 授权成功，可上传视频');
        setYtMsg('授权成功 ✅');
        setYtConfigured(true);
      } else {
        setYtMsg(data.message || '换取 refresh_token 失败');
      }
    } catch (e: any) {
      setYtMsg(e?.message || '网络错误');
    } finally {
      setYtSaving(false);
    }
  };

  return (
    <Card title="YouTube 上传（OAuth2 授权）" headerBordered>
      <div className="space-y-4 text-sm">
        <div className="text-xs text-gray-500 leading-relaxed">
          步骤：① 在 Google Cloud 创建 OAuth 客户端（类型选「桌面应用 / TV 设备」），把 client_id / client_secret 粘贴到下方保存；
          ② 点「获取授权链接」在浏览器打开并同意，复制 code；③ 粘贴 code 后点「完成授权」。授权一次后静默上传，无需重复操作。
          详细指引见 <Link href="docs/YOUTUBE_SETUP.md" target="_blank" theme="primary" size="small">YOUTUBE_SETUP.md</Link>。
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-gray-600 mb-1">Client ID</label>
            <Input
              value={ytClientId}
              onChange={(v) => setYtClientId(v as string)}
              placeholder="xxxxx.apps.googleusercontent.com"
            />
          </div>
          <div>
            <label className="block text-gray-600 mb-1">Client Secret</label>
            <Input
              value={ytClientSecret}
              onChange={(v) => setYtClientSecret(v as string)}
              placeholder="GOCSPX-xxxxxxxx"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button theme="primary" variant="outline" loading={ytSaving} onClick={handleSaveYtClient}>
            1. 保存 Client 凭证
          </Button>
          <Button theme="primary" variant="outline" onClick={handleFetchYtAuthUrl}>
            2. 获取授权链接
          </Button>
          <Button theme="success" loading={ytSaving} onClick={handleExchangeYtCode}>
            3. 完成授权
          </Button>
        </div>

        {ytAuthUrl && (
          <div className="border border-gray-100 rounded p-2">
            <div className="text-gray-600 mb-1">授权链接（在新标签打开并复制 code）：</div>
            <Link href={ytAuthUrl} target="_blank" theme="primary" className="break-all text-xs">{ytAuthUrl}</Link>
          </div>
        )}

        <div>
          <label className="block text-gray-600 mb-1">3. 粘贴授权 code</label>
          <Input
            value={ytCode}
            onChange={(v) => setYtCode(v as string)}
            placeholder="4/0xxxxxxx-xxxxxxxx"
          />
        </div>

        {ytConfigured && (
          <div className="text-green-600">已授权 ✅ 可在上架弹窗上传商品视频</div>
        )}
        {ytMsg && (
          <div className={`text-xs p-2 rounded ${ytConfigured ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-600'}`}>
            {ytMsg}
          </div>
        )}
      </div>
    </Card>
  );
}

// ============ 代理配置面板 ============
function ProxyConfigPanel() {
  const SITES = [
    { code: 'MLM', name: '墨西哥', cc: 'mx' },
    { code: 'MLB', name: '巴西', cc: 'br' },
    { code: 'MLC', name: '智利', cc: 'cl' },
    { code: 'MCO', name: '哥伦比亚', cc: 'co' },
  ];
  const [config, setConfig] = useState<{ proxyUrl: string; bySite: Record<string, string>; enabled: boolean }>({
    proxyUrl: '', bySite: {}, enabled: false,
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [descExpanded, setDescExpanded] = useState(false);

  const featureLines = [
    '住宅代理用于解锁 Mercado Libre 对中国大陆 / 数据中心 IP 的地理封锁（主要是 /search 自由关键词搜索与 /items 精确销量接口）。官方 API（/trends、/highlights、/products）免费且合法，无需代理。',
    '默认代理链接支持 {cc} 占位符：运行时自动替换为目标站点国家代码（MLM→mx、MLB→br、MLC→cl、MCO→co），即「一条链接覆盖多国」。若供应商要求每个国家独立出口，展开「按站点单独配置」逐国填写即可覆盖默认。',
    '启用后扫描按商品所属站点自动选用对应国家出口；关闭则全部直连（官方 API 不受影响）。注意：住宅代理抓取公开页面属灰色地带，请控制请求频率、避免影响正式店铺。',
  ];

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/ml/proxy');
      const data = await res.json();
      setConfig({
        proxyUrl: data.proxyUrl || '',
        bySite: data.bySite || {},
        enabled: !!data.enabled,
      });
    } catch { /* ignore */ }
  };

  useEffect(() => { loadStatus(); }, []);

  const updateBySite = (code: string, v: string) => {
    setConfig((prev) => ({ ...prev, bySite: { ...prev.bySite, [code]: v as string } }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ml/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: config.proxyUrl.trim(), bySite: config.bySite, enabled: config.enabled }),
      });
      const data = await res.json();
      if (data.success) { MessagePlugin.success(data.message || '代理配置已保存'); loadStatus(); }
      else MessagePlugin.error(data.message || '保存失败');
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/ml/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: 'MLM' }),
      });
      const data = await res.json();
      setTestResult(data);
      if (data.success) MessagePlugin.success('测试通过');
      else MessagePlugin.warning(data.message || '测试未通过');
    } catch (e: any) {
      MessagePlugin.error(e?.message || '网络错误');
    } finally { setTesting(false); }
  };

  return (
    <div className="space-y-5">
      <Card title="住宅代理配置（解锁美客多地理封锁）" headerBordered>
        <div className="space-y-4">
          {/* 功能说明（超过 3 行折叠） */}
          <div className="text-xs text-gray-500 bg-gray-50 rounded p-3">
            {descExpanded ? featureLines.map((l, i) => (<div key={i}>{l}</div>)) : featureLines.slice(0, 2).map((l, i) => (<div key={i}>{l}</div>))}
            <button className="text-blue-500 mt-1" onClick={() => setDescExpanded((v) => !v)}>
              {descExpanded ? '收起 ▲' : '展开详细说明 ▼'}
            </button>
          </div>

          {/* 总开关 */}
          <div className="flex items-center justify-between border border-gray-100 rounded p-3">
            <div>
              <div className="text-sm font-medium">启用住宅代理</div>
              <div className="text-xs text-gray-500">关闭时全部请求直连官方 API（/trends、/highlights、/products 不受影响）</div>
            </div>
            <Switch value={config.enabled} onChange={(v) => setConfig((p) => ({ ...p, enabled: v as boolean }))} />
          </div>

          {/* 默认代理链接 */}
          <div>
            <label className="block text-sm text-gray-600 mb-1">默认代理链接（支持 {'{cc}'} 占位符）</label>
            <Input
              value={config.proxyUrl}
              onChange={(v) => setConfig((p) => ({ ...p, proxyUrl: v as string }))}
              placeholder="http://user:pass@host:port  或  http://user-country-{cc}@host:port"
            />
            <div className="text-xs text-gray-400 mt-1">
              主流供应商（Bright Data / Oxylabs / Smartproxy 等）支持在账号名加 <code>-country-mx</code> 或链接带 <code>?country=mx</code>；
              所有站点共用同一出口时只填这里即可，留空「按站点覆盖」按需补充。
            </div>
          </div>

          {/* 高级：按站点单独配置 */}
          <div className="border border-gray-100 rounded p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">按站点单独配置（高级，可选）</div>
              <Button size="small" variant="text" onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? '收起' : '展开'}
              </Button>
            </div>
            <div className="text-xs text-gray-400 mt-1">当供应商要求每个国家独立链接时填写，会覆盖上方默认链接。</div>
            {showAdvanced && (
              <div className="space-y-2 mt-3">
                {SITES.map((s) => (
                  <div key={s.code} className="flex items-center gap-2">
                    <span className="text-xs w-28 shrink-0 text-gray-600">{s.name}（{s.code}→{s.cc}）</span>
                    <Input
                      size="small"
                      value={config.bySite[s.code] || ''}
                      onChange={(v) => updateBySite(s.code, v as string)}
                      placeholder={`${s.code} 专用链接`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button size="small" theme="primary" loading={saving} onClick={handleSave}>保存配置</Button>
            <Button size="small" variant="outline" loading={testing} onClick={handleTest}>测试连接（MLM）</Button>
            <Button size="small" variant="text" icon={<RefreshIcon />} onClick={loadStatus}>刷新</Button>
          </div>

          {testResult && (
            <div className={`text-xs p-2 rounded ${testResult.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {testResult.success ? '✅ ' : '❌ '}{testResult.message}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ============ 配置中心 ============
export function ConfigPage() {
  const [activeTab, setActiveTab] = useState('ai');

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="p-3 border-b" style={{ borderColor: 'var(--td-component-border)' }}>
        <h1 className="text-xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>配置中心</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--td-text-color-secondary)' }}>
          统一管理 AI 大模型、货源、视频上传与通知等配置
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3">
        <Tabs value={activeTab} onChange={(v) => setActiveTab(v as string)}>
          <Tabs.TabPanel value="ai" label="AI 大模型">
            <div className="pt-3"><AiConfigPanel /></div>
          </Tabs.TabPanel>
          <Tabs.TabPanel value="ali1688" label="1688 货源">
            <div className="pt-3"><Ali1688ConfigPanel /></div>
          </Tabs.TabPanel>
          <Tabs.TabPanel value="youtube" label="YouTube 上传">
            <div className="pt-3"><YouTubeConfigPanel /></div>
          </Tabs.TabPanel>
          <Tabs.TabPanel value="proxy" label="代理配置">
            <div className="pt-3"><ProxyConfigPanel /></div>
          </Tabs.TabPanel>
          <Tabs.TabPanel value="notify" label="通知设置">
            <div style={{ height: 'calc(100vh - 220px)' }}><NotificationSettingsPage /></div>
          </Tabs.TabPanel>
          <Tabs.TabPanel value="stores" label="店铺管理">
            <div style={{ height: 'calc(100vh - 220px)' }}><StoreManagementPage /></div>
          </Tabs.TabPanel>
        </Tabs>
      </div>
    </div>
  );
}

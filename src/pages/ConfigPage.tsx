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
} from 'tdesign-react';
import { RefreshIcon, DeleteIcon, AddIcon } from 'tdesign-icons-react';
import { NotificationSettingsPage } from './NotificationSettingsPage';
import { StoreManagementPage } from './StoreManagementPage';

interface LlmProviderForm {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

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
      const list: LlmProviderForm[] = (data.providers || []).map((p: any) => ({
        name: p.name || '',
        baseUrl: p.baseUrl || '',
        apiKey: '', // 出于安全不回显 Key；留空=复用已保存
        model: p.model || '',
      }));
      setProviders(list.length ? list : [{ name: '平台 1', baseUrl: '', apiKey: '', model: '' }]);
    } catch {
      setProviders([{ name: '平台 1', baseUrl: '', apiKey: '', model: '' }]);
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
            <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border border-gray-100 rounded p-2">
              <Input
                className="md:col-span-2"
                size="small"
                value={p.name}
                onChange={(v) => updateProvider(i, { name: v as string })}
                placeholder="平台名"
              />
              <Input
                className="md:col-span-5"
                size="small"
                value={p.baseUrl}
                onChange={(v) => updateProvider(i, { baseUrl: v as string })}
                placeholder="https://.../v1"
              />
              <Input
                className="md:col-span-3"
                size="small"
                type="password"
                value={p.apiKey}
                onChange={(v) => updateProvider(i, { apiKey: v as string })}
                placeholder={status ? '留空=复用已保存' : 'API Key'}
              />
              <Input
                className="md:col-span-1"
                size="small"
                value={p.model}
                onChange={(v) => updateProvider(i, { model: v as string })}
                placeholder="model"
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
          ))}
          <Button size="small" variant="dashed" icon={<AddIcon />} onClick={() => setProviders((prev) => [...prev, { name: `平台 ${prev.length + 1}`, baseUrl: '', apiKey: '', model: '' }])}>
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

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Card, Tag, Progress, Table, NotificationPlugin, Radio, Switch, Checkbox, Input, InputGroup } from 'tdesign-react';
import {
  DownloadIcon,
  RefreshIcon,
  SearchIcon,
  CloudDownloadIcon,
  FileExcelIcon,
  FileIcon,
  CheckCircleIcon,
  LoadingIcon,
  LockOnIcon,
  CheckIcon,
  CloseIcon,
  DeleteIcon,
} from 'tdesign-icons-react';
import { ShoppingBag } from 'lucide-react';

// 进度消息类型
interface FetchProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
  site?: string;
  category?: string;
}

// 导出文件信息
interface ExportedFile {
  fileName: string;
  filePath: string;
  size: number;
  createdAt: string;
}

// 完成结果
interface FetchResult {
  phase: string;
  message: string;
  filePath?: string;
  totalCount?: number;
  siteStats?: Record<string, number>;
}

export function ProductFinderPage() {
  const [isFetching, setIsFetching] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [result, setResult] = useState<FetchResult | null>(null);
  // 跨站点全局进度（累计所有站点分类，呈现一条 0→100% 的总进度条）
  const [globalProgress, setGlobalProgress] = useState<{ current: number; total: number }>({ current: 0, total: 0 });
  const globalBaseRef = useRef(0); // 已完成站点的分类总数累计
  const currentSiteTotalRef = useRef(0); // 当前站点的分类总数
  const fetchStartTimeRef = useRef(0); // 本次抓取开始时间戳（用于估算剩余时间）
  const [files, setFiles] = useState<ExportedFile[]>([]);
  const [selectedSites, setSelectedSites] = useState<string[]>(['MLM', 'MLB', 'MLC', 'MCO']);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null); // token 轮询定时器

  // Token 状态
  const [tokenInput, setTokenInput] = useState('');
  const [tokenStatus, setTokenStatus] = useState<{ hasToken: boolean; tokenPreview: string }>({ hasToken: false, tokenPreview: '' });
  const [tokenValidating, setTokenValidating] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [tokenMessage, setTokenMessage] = useState('');

  // OAuth2 状态
  const [oauthAppId, setOauthAppId] = useState('');
  const [oauthSecretKey, setOauthSecretKey] = useState('');
  const [oauthConfig, setOauthConfig] = useState<{
    hasConfig: boolean;
    appId: string;
    secretKeyPreview: string;
    redirectUri: string;
    hasRefreshToken: boolean;
    tokenExpiry: string | null;
    tokenExpired: boolean;
  }>({ hasConfig: false, appId: '', secretKeyPreview: '', redirectUri: '', hasRefreshToken: false, tokenExpiry: null, tokenExpired: true });
  const [oauthSaving, setOauthSaving] = useState(false);
  const [oauthAuthorizing, setOauthAuthorizing] = useState(false);
  const [oauthRefreshing, setOauthRefreshing] = useState(false);
  const [oauthClientCreds, setOauthClientCreds] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [authUrl, setAuthUrl] = useState(''); // 生成的授权链接，页面内展示供用户点击

  // 抓取选项（价格上限 / 筛选 / 扩量）
  const [priceLimitUsd, setPriceLimitUsd] = useState<number>(0);  // 价格上限 USD，0 = 不限（美客多 Best Sellers 多为本土且单价偏高，默认不限才能拿到量）
  const [excludeFull, setExcludeFull] = useState(true);           // 排除 ML Full（官方仓），默认开启
  const [excludeDomestic, setExcludeDomestic] = useState(false);  // 排除本土卖家：默认关闭（Best Sellers 绝大多数是本土卖家，开启后几乎抓不到数据）
  const [onlyNew, setOnlyNew] = useState(false);                  // 仅全新
  const [includeSubcategories, setIncludeSubcategories] = useState(false); // 展开子分类扩量
  const [miaoshouPackage, setMiaoshouPackage] = useState(true);    // 导出妙手素材包（ZIP 含主图），推荐导入方式

  // 住宅代理（可选）：配置后 /search 走翻页拉取更多数据（地理匹配 MX/BR/CL/CO 解锁量）
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyStatus, setProxyStatus] = useState<{ hasProxy: boolean; proxyUrl: string }>({ hasProxy: false, proxyUrl: '' });
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // 邮件配置
  const [emailCfg, setEmailCfg] = useState<any>({ enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' });
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailTestMsg, setEmailTestMsg] = useState<{ success: boolean; message: string } | null>(null);
  const [emailLoaded, setEmailLoaded] = useState(false);
  const [smtpOpen, setSmtpOpen] = useState(true);

  // 定时调度
  const [scheduleCfg, setScheduleCfg] = useState<any>({ enabled: false, time: '09:00' });
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);

  // 公网隧道状态
  const [tunnelInfo, setTunnelInfo] = useState<{ running: boolean; url: string; callbackUrl: string }>({ running: false, url: '', callbackUrl: '' });
  const [tunnelLoading, setTunnelLoading] = useState(false);

  // 获取已导出文件列表
  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/files');
      const data = await res.json();
      setFiles(data.files || []);
    } catch (err) {
      console.error('获取文件列表失败:', err);
    }
  }, []);

  // 获取 token 状态
  const fetchTokenStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/token');
      const data = await res.json();
      setTokenStatus(data);
      // 检测到 token 已获取 → 停止轮询
      if (data.hasToken && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        NotificationPlugin.success({ title: 'Token 已获取', content: '可以开始抓取商品了' });
      }
    } catch (err) {
      console.error('获取 token 状态失败:', err);
    }
  }, []);

  // 保存 token
  const handleSaveToken = useCallback(async () => {
    if (!tokenInput.trim()) {
      NotificationPlugin.warning({ title: '请输入 access token', content: '' });
      return;
    }
    try {
      const res = await fetch('/api/ml/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: 'Token 已保存', content: '' });
        setTokenInput('');
        setTokenValid(null);
        fetchTokenStatus();
      } else {
        NotificationPlugin.error({ title: '保存失败', content: data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '保存失败', content: err?.message || '' });
    }
  }, [tokenInput, fetchTokenStatus]);

  // 验证 token
  const handleValidateToken = useCallback(async () => {
    setTokenValidating(true);
    setTokenValid(null);
    setTokenMessage('');
    try {
      const res = await fetch('/api/ml/token/validate', { method: 'POST' });
      const data = await res.json();
      setTokenValid(data.valid);
      setTokenMessage(data.message || '');
      if (data.valid) {
        NotificationPlugin.success({ title: 'Token 验证通过', content: data.message || '' });
      } else {
        NotificationPlugin.warning({ title: 'Token 验证失败', content: data.message || '' });
      }
    } catch (err: any) {
      setTokenValid(false);
      setTokenMessage(err?.message || '验证请求失败');
      NotificationPlugin.error({ title: '验证失败', content: err?.message || '' });
    } finally {
      setTokenValidating(false);
    }
  }, []);

  // 获取 OAuth2 配置状态
  const fetchOAuthConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/oauth/config');
      const data = await res.json();
      setOauthConfig(data);
      if (data.appId) setOauthAppId(data.appId);
    } catch (err) {
      console.error('获取 OAuth 配置失败:', err);
    }
  }, []);

  // 获取隧道状态
  const fetchTunnelInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/oauth/tunnel');
      const data = await res.json();
      setTunnelInfo(data);
    } catch (err) {
      console.error('获取隧道状态失败:', err);
    }
  }, []);

  // 保存邮件配置
  const handleSaveEmail = useCallback(async () => {
    setEmailSaving(true);
    try {
      // 发送完整配置（含发件人 SMTP）；密码若仍是遮罩 ****** 说明未修改，剔除以免覆盖服务端已存值
      const payload: any = { ...emailCfg };
      if (payload.pass === '******') delete payload.pass;
      const res = await fetch('/api/ml/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        setEmailCfg(data.config);
        NotificationPlugin.success({ title: '邮件配置已保存', content: '' });
      } else {
        NotificationPlugin.error({ title: '保存失败', content: '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '保存失败', content: err?.message || '' });
    } finally {
      setEmailSaving(false);
    }
  }, [emailCfg]);

  // 测试邮件
  const handleTestEmail = useCallback(async () => {
    setEmailTestMsg(null);
    try {
      const res = await fetch('/api/ml/email/test', { method: 'POST' });
      const data = await res.json();
      setEmailTestMsg({ success: data.success, message: data.message || '' });
      if (data.success) {
        NotificationPlugin.success({ title: '测试邮件已发送', content: data.message || '' });
      } else {
        NotificationPlugin.warning({ title: '邮件发送失败', content: data.message || '' });
      }
    } catch (err: any) {
      setEmailTestMsg({ success: false, message: err?.message || '' });
      NotificationPlugin.error({ title: '测试失败', content: err?.message || '' });
    }
  }, []);

  // 保存定时调度
  const handleSaveSchedule = useCallback(async () => {
    setScheduleSaving(true);
    try {
      const res = await fetch('/api/ml/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scheduleCfg),
      });
      const data = await res.json();
      if (data.success) {
        setScheduleCfg(data.schedule);
        NotificationPlugin.success({ title: '定时任务已保存', content: `每日 ${scheduleCfg.time} 自动抓取` });
      } else {
        NotificationPlugin.error({ title: '保存失败', content: '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '保存失败', content: err?.message || '' });
    } finally {
      setScheduleSaving(false);
    }
  }, [scheduleCfg]);

  // 启动公网隧道
  const handleStartTunnel = useCallback(async () => {
    setTunnelLoading(true);
    try {
      const res = await fetch('/api/ml/oauth/tunnel', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setTunnelInfo({ running: true, url: data.url, callbackUrl: data.callbackUrl });
        setOauthConfig(prev => ({ ...prev, redirectUri: data.callbackUrl }));
        NotificationPlugin.success({ title: '公网隧道已启动', content: `回调地址: ${data.callbackUrl}` });
      } else {
        NotificationPlugin.error({ title: '隧道启动失败', content: data.message || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '隧道启动失败', content: err?.message || '' });
    } finally {
      setTunnelLoading(false);
    }
  }, []);

  // 关闭公网隧道
  const handleStopTunnel = useCallback(async () => {
    try {
      await fetch('/api/ml/oauth/tunnel', { method: 'DELETE' });
      setTunnelInfo({ running: false, url: '', callbackUrl: '' });
      await fetchOAuthConfig();
      NotificationPlugin.info({ title: '公网隧道已关闭', content: '' });
    } catch (err: any) {
      NotificationPlugin.error({ title: '关闭隧道失败', content: err?.message || '' });
    }
  }, [fetchOAuthConfig]);

  // 保存 OAuth2 配置
  const handleSaveOAuthConfig = useCallback(async () => {
    if (!oauthAppId.trim() || !oauthSecretKey.trim()) {
      NotificationPlugin.warning({ title: '请填写 App ID 和 Secret Key', content: '' });
      return;
    }
    setOauthSaving(true);
    try {
      const res = await fetch('/api/ml/oauth/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: oauthAppId.trim(), secretKey: oauthSecretKey.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: 'OAuth 配置已保存', content: '' });
        setOauthSecretKey('');
        fetchOAuthConfig();
      } else {
        NotificationPlugin.error({ title: '保存失败', content: data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '保存失败', content: err?.message || '' });
    } finally {
      setOauthSaving(false);
    }
  }, [oauthAppId, oauthSecretKey, fetchOAuthConfig]);

  // 获取授权 URL 并在页面内展示为可点击链接（避免弹窗被拦截或闪退）
  const handleAuthorize = useCallback(async () => {
    setOauthAuthorizing(true);
    try {
      const res = await fetch('/api/ml/oauth/auth-url');
      const data = await res.json();
      if (data.url) {
        setAuthUrl(data.url);
        NotificationPlugin.success({ title: '授权链接已生成', content: '请点击下方蓝色链接前往美客多授权' });
        // 启动轮询：每 3 秒检查一次 token 状态（用户在新标签页完成授权后自动感知）
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(() => { fetchTokenStatus(); }, 3000);
      } else {
        NotificationPlugin.error({ title: '生成授权 URL 失败', content: data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '请求失败', content: err?.message || '' });
    } finally {
      setOauthAuthorizing(false);
    }
  }, [fetchTokenStatus]);

  // 手动交换授权码（支持粘贴完整回调 URL 或仅 code）
  const handleExchangeCode = useCallback(async () => {
    if (!manualCode.trim()) {
      NotificationPlugin.warning({ title: '请输入授权码或回调 URL', content: '' });
      return;
    }
    try {
      const input = manualCode.trim();
      // 如果输入看起来像 URL，用 callbackUrl 字段发送
      const body = input.startsWith('http')
        ? JSON.stringify({ callbackUrl: input })
        : JSON.stringify({ code: input });

      const res = await fetch('/api/ml/oauth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: 'Token 获取成功', content: data.message || '' });
        setManualCode('');
        fetchTokenStatus();
        fetchOAuthConfig();
      } else {
        NotificationPlugin.error({ title: '获取失败', content: data.message || data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '请求失败', content: err?.message || '' });
    }
  }, [manualCode, fetchTokenStatus, fetchOAuthConfig]);

  // 使用 client_credentials 获取应用级 token（无需用户授权和公网隧道）
  const handleClientCredentials = useCallback(async () => {
    setOauthClientCreds(true);
    try {
      const res = await fetch('/api/ml/oauth/client-credentials', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: '应用 Token 获取成功', content: data.message || '' });
        fetchTokenStatus();
        fetchOAuthConfig();
      } else {
        NotificationPlugin.warning({ title: '获取失败', content: data.message || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '请求失败', content: err?.message || '' });
    } finally {
      setOauthClientCreds(false);
    }
  }, [fetchTokenStatus, fetchOAuthConfig]);

  // 刷新 token
  const handleRefreshToken = useCallback(async () => {
    setOauthRefreshing(true);
    try {
      const res = await fetch('/api/ml/oauth/refresh', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: 'Token 已刷新', content: data.message || '' });
        fetchTokenStatus();
        fetchOAuthConfig();
      } else {
        NotificationPlugin.warning({ title: '刷新失败', content: data.message || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '刷新失败', content: err?.message || '' });
    } finally {
      setOauthRefreshing(false);
    }
  }, [fetchTokenStatus, fetchOAuthConfig]);

  useEffect(() => {
    fetchFiles();
    fetchTokenStatus();
    fetchOAuthConfig();
    fetchTunnelInfo();
    // 加载邮件与定时配置
    fetch('/api/ml/email').then(r => r.json()).then(d => { setEmailCfg({ ...d, pass: '' }); setEmailLoaded(true); }).catch(() => setEmailLoaded(true));
    fetch('/api/ml/schedule').then(r => r.json()).then(d => { setScheduleCfg(d); setScheduleLoaded(true); }).catch(() => setScheduleLoaded(true));
  }, [fetchFiles, fetchTokenStatus, fetchOAuthConfig, fetchTunnelInfo]);

  // 住宅代理配置
  const fetchProxyStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/ml/proxy');
      const data = await res.json();
      setProxyStatus(data);
    } catch (err) {
      console.error('获取代理状态失败:', err);
    }
  }, []);

  const handleSaveProxy = useCallback(async () => {
    setProxySaving(true);
    try {
      const res = await fetch('/api/ml/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: proxyUrl.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: '代理已保存', content: data.message || '' });
        setProxyTestResult(null);
        fetchProxyStatus();
      } else {
        NotificationPlugin.error({ title: '保存失败', content: data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '保存失败', content: err?.message || '' });
    } finally {
      setProxySaving(false);
    }
  }, [proxyUrl, fetchProxyStatus]);

  const handleTestProxy = useCallback(async () => {
    setProxyTesting(true);
    setProxyTestResult(null);
    try {
      const res = await fetch('/api/ml/proxy/test', { method: 'POST' });
      const data = await res.json();
      setProxyTestResult({ success: data.success, message: data.message || '' });
      if (data.success) {
        NotificationPlugin.success({ title: '代理测试成功', content: data.message || '' });
      } else {
        NotificationPlugin.warning({ title: '代理测试失败', content: data.message || '' });
      }
    } catch (err: any) {
      const msg = err?.message || '请求失败';
      setProxyTestResult({ success: false, message: msg });
      NotificationPlugin.error({ title: '测试失败', content: msg });
    } finally {
      setProxyTesting(false);
    }
  }, []);

  useEffect(() => {
    fetchProxyStatus();
  }, [fetchProxyStatus]);

  // 当 token 状态变化为"已获取"时，刷新 OAuth 配置（同步 hasRefreshToken / tokenExpiry 等）
  useEffect(() => {
    if (tokenStatus.hasToken) {
      fetchOAuthConfig();
    }
  }, [tokenStatus.hasToken, fetchOAuthConfig]);

  // 用户从授权标签页切回本页时立即刷新 token 状态
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchTokenStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchTokenStatus]);

  // 组件卸载时清理轮询定时器
  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, []);

  // 自动滚动日志
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [progressLog]);

  // 开始抓取（根据代理配置选择模式）
  const handleFetchViaBrowser = useCallback(async () => {
    if (selectedSites.length === 0) {
      NotificationPlugin.warning({ title: '请至少选择一个站点', content: '' });
      return;
    }

    if (!tokenStatus.hasToken) {
      NotificationPlugin.warning({ title: '请先设置 Access Token', content: '在上方「API 认证配置」中获取 token 后再抓取' });
      return;
    }

    setIsFetching(true);
    setProgress(null);
    setProgressLog([]);
    setResult(null);
    setGlobalProgress({ current: 0, total: 0 });
    globalBaseRef.current = 0;
    currentSiteTotalRef.current = 0;
    fetchStartTimeRef.current = Date.now();

    const addLog = (msg: string) => {
      setProgressLog((prev) => [...prev, msg]);
    };

    // ===== 后端直连抓取（highlights → products 链路，免 VPN）=====
    {
      addLog(`☁️ 后端直连模式：通过后端调用 ML API（免 VPN）...`);
      try {
        const response = await fetch('/api/ml/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sites: selectedSites,
            options: {
              priceLimitUsd,
              excludeFull,
              excludeDomestic,
              onlyNew,
              includeSubcategories,
              miaoshouPackage,
            },
          }),
        });

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error('无法读取响应流');
        }

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data: FetchProgress | FetchResult = JSON.parse(line.slice(6));
                if (data.phase === 'complete') {
                  setResult(data as FetchResult);
                  addLog(`✅ ${data.message}`);
                  setGlobalProgress({ current: 1, total: 1 });
                  fetchFiles();
                } else if (data.phase === 'error') {
                  setResult(data as FetchResult);
                  addLog(`❌ ${data.message}`);
                } else {
                  setProgress(data as FetchProgress);
                  // 「正在获取 X (i/total)」已在状态行/进度条显示，不重复进日志；
                  // 仅在「筛选出 N 个」等结果型阶段记一条，实现日志合并、避免刷屏
                  if (data.phase !== 'fetching') addLog(data.message);
                  // 累计全局进度（跨站点）
                  const ph = data.phase;
                  if (ph === 'site_start') {
                    currentSiteTotalRef.current = 0;
                    setGlobalProgress({ current: globalBaseRef.current, total: globalBaseRef.current || 1 });
                  } else if (ph === 'categories_done') {
                    currentSiteTotalRef.current = data.total || 0;
                    setGlobalProgress({ current: globalBaseRef.current, total: globalBaseRef.current + currentSiteTotalRef.current });
                  } else if (ph === 'fetching') {
                    setGlobalProgress({
                      current: globalBaseRef.current + data.current,
                      total: globalBaseRef.current + (currentSiteTotalRef.current || data.total || 1),
                    });
                  } else if (ph === 'site_done') {
                    globalBaseRef.current += currentSiteTotalRef.current;
                    currentSiteTotalRef.current = 0;
                    setGlobalProgress({ current: globalBaseRef.current, total: globalBaseRef.current });
                  } else if (ph === 'exporting' || ph === 'done') {
                    const t = globalBaseRef.current || 1;
                    setGlobalProgress({ current: t, total: t });
                  }
                }
              } catch { /* ignore parse errors */ }
            }
          }
        }
      } catch (err: any) {
        NotificationPlugin.error({ title: '抓取失败', content: err?.message || '未知错误' });
        addLog(`❌ 错误: ${err?.message || '未知错误'}`);
      } finally {
        setIsFetching(false);
      }
      return;
    }

  }, [selectedSites, tokenStatus.hasToken, fetchFiles]);

  // 下载文件
  const handleDownload = useCallback((fileName: string) => {
    window.open(`/api/ml/download/${encodeURIComponent(fileName)}`, '_blank');
  }, []);

  // 将历史导出文件重新发送邮件
  const handleResendEmail = useCallback(async (fileName: string) => {
    try {
      const res = await fetch('/api/ml/email/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName }),
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: '已发送', content: data.message });
      } else {
        NotificationPlugin.warning({ title: '发送失败', content: data.message || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '发送失败', content: err?.message || '' });
    }
  }, []);

  // 删除已导出的文件
  const handleDeleteFile = useCallback(async (fileName: string) => {
    try {
      const res = await fetch(`/api/ml/files/${encodeURIComponent(fileName)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        NotificationPlugin.success({ title: '已删除', content: data.message });
        fetchFiles();
      } else {
        NotificationPlugin.warning({ title: '删除失败', content: data.error || '' });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '删除失败', content: err?.message || '' });
    }
  }, [fetchFiles]);

  // 格式化文件大小
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // 格式化日期
  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleString('zh-CN');
  };

  // 格式化时长（毫秒 → 中文「X时Y分Z秒 / Y分Z秒 / Z秒」）
  const formatDuration = (ms: number) => {
    if (ms < 0 || !isFinite(ms)) ms = 0;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}时${m}分${sec}秒`;
    if (m > 0) return `${m}分${sec}秒`;
    return `${sec}秒`;
  };

  // 估算剩余时间：根据全局进度与已用时间线性外推
  const elapsedMs = isFetching && fetchStartTimeRef.current ? Date.now() - fetchStartTimeRef.current : 0;
  const remainingMs =
    globalProgress.total > 0 && globalProgress.current > 0 && globalProgress.current < globalProgress.total
      ? (elapsedMs / globalProgress.current) * (globalProgress.total - globalProgress.current)
      : 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            <ShoppingBag size={20} color="white" />
          </div>
          <div>
            <h2 className="text-xl font-bold" style={{ color: 'var(--td-text-color-primary)' }}>
              美客多商品抓取
            </h2>
            <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
              每日获取墨西哥/巴西/智利/哥伦比亚各品类销量前100、单价≤设定上限的商品
            </p>
          </div>
        </div>

        {/* API 认证配置 */}
        <Card title="API 认证配置" bordered>
          <div className="space-y-4">
            {/* Token 状态概览 */}
            <div className="flex items-start gap-3 p-3 rounded-lg" style={{ backgroundColor: tokenStatus.hasToken ? 'rgba(103, 194, 58, 0.08)' : 'rgba(245, 108, 108, 0.08)' }}>
              {tokenStatus.hasToken ? (
                <CheckCircleIcon size={20} style={{ color: '#67c23a', flexShrink: 0 }} />
              ) : (
                <LockOnIcon size={20} style={{ color: '#f56c6c', flexShrink: 0 }} />
              )}
              <div className="flex-1">
                <div className="font-medium text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
                  {tokenStatus.hasToken ? `已设置 Token: ${tokenStatus.tokenPreview}` : '未设置 Access Token'}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--td-text-color-secondary)' }}>
                  {tokenStatus.hasToken
                    ? 'Token 已配置，点击「验证」检查是否有效'
                    : 'Mercado Libre API 需要认证，请通过下方 OAuth2 授权获取 token'}
                </div>
                {/* Token 过期信息 */}
                {tokenStatus.hasToken && oauthConfig.tokenExpiry && (
                  <div className="text-xs mt-1 flex items-center gap-1" style={{ color: oauthConfig.tokenExpired ? '#f56c6c' : 'var(--td-text-color-secondary)' }}>
                    {oauthConfig.tokenExpired ? <CloseIcon size={14} /> : <CheckIcon size={14} />}
                    {oauthConfig.tokenExpired
                      ? 'Token 已过期'
                      : `过期时间: ${new Date(oauthConfig.tokenExpiry).toLocaleString('zh-CN')}`}
                    {oauthConfig.hasRefreshToken && (
                      <Button
                        size="small"
                        variant="text"
                        theme="primary"
                        onClick={handleRefreshToken}
                        loading={oauthRefreshing}
                        style={{ marginLeft: '8px', padding: '0 4px' }}
                      >
                        刷新 Token
                      </Button>
                    )}
                  </div>
                )}
                {tokenValid !== null && (
                  <div className="text-xs mt-1 flex items-center gap-1" style={{ color: tokenValid ? '#67c23a' : '#f56c6c' }}>
                    {tokenValid ? <CheckIcon size={14} /> : <CloseIcon size={14} />}
                    {tokenMessage}
                  </div>
                )}
              </div>
              {tokenStatus.hasToken && (
                <Button
                  variant="outline"
                  size="small"
                  onClick={handleValidateToken}
                  loading={tokenValidating}
                >
                  验证
                </Button>
              )}
            </div>

            {/* OAuth2 配置区域 */}
            <div className="p-4 rounded-lg border" style={{ borderColor: 'var(--td-border-level-2-color)' }}>
              <div className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-primary)' }}>
                OAuth2 授权（推荐方式）
              </div>

              {/* App ID / Secret Key 输入 */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs w-20 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>App ID</span>
                  <Input
                    value={oauthAppId}
                    onChange={(val) => setOauthAppId(val as string)}
                    placeholder="ML 应用的 App ID"
                    clearable
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs w-20 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>Secret Key</span>
                  <Input
                    value={oauthSecretKey}
                    onChange={(val) => setOauthSecretKey(val as string)}
                    placeholder={oauthConfig.secretKeyPreview ? `已设置 (${oauthConfig.secretKeyPreview})，重新输入覆盖` : 'ML 应用的 Secret Key'}
                    type="password"
                    clearable
                  />
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    theme="primary"
                    variant="outline"
                    size="small"
                    onClick={handleSaveOAuthConfig}
                    loading={oauthSaving}
                    disabled={!oauthAppId.trim() || !oauthSecretKey.trim()}
                  >
                    保存配置
                  </Button>
                  <Button
                    theme="success"
                    size="small"
                    onClick={handleClientCredentials}
                    loading={oauthClientCreds}
                    disabled={!oauthConfig.hasConfig}
                  >
                    获取应用 Token
                  </Button>
                  <Button
                    theme="primary"
                    size="small"
                    onClick={handleAuthorize}
                    loading={oauthAuthorizing}
                    disabled={!oauthConfig.hasConfig}
                  >
                    OAuth 授权获取 Token
                  </Button>
                  {oauthConfig.hasRefreshToken && (
                    <Button
                      variant="outline"
                      size="small"
                      onClick={handleRefreshToken}
                      loading={oauthRefreshing}
                    >
                      刷新 Token
                    </Button>
                  )}
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  推荐：先点击「获取应用 Token」（无需公网隧道和用户授权）。如失败再用「OAuth 授权获取 Token」。
                </div>

                {/* 生成的授权链接（点击真实 <a> 链接，浏览器不会拦截） */}
                {authUrl && !tokenStatus.hasToken && (
                  <div className="mt-2 p-3 rounded-lg" style={{ backgroundColor: 'var(--td-brand-color-light)', border: '1px solid var(--td-brand-color)' }}>
                    <div className="text-xs font-medium mb-2" style={{ color: 'var(--td-brand-color)' }}>
                      ① 点击下方链接前往美客多授权（新标签打开）：
                    </div>
                    <a
                      href={authUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        display: 'inline-block',
                        padding: '8px 16px',
                        borderRadius: '6px',
                        backgroundColor: 'var(--td-brand-color)',
                        color: '#fff',
                        fontSize: '13px',
                        fontWeight: 500,
                        textDecoration: 'none',
                      }}
                    >
                      前往美客多授权 →
                    </a>
                    <div className="text-xs mt-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                      ② 登录并点击「允许」后，页面会跳转回本应用自动获取 Token。<br />
                      ③ 若没有自动跳回，把浏览器地址栏的<strong>完整 URL</strong> 复制到下方「手动粘贴」框。
                    </div>
                    <div className="mt-2">
                      <Button
                        variant="outline"
                        size="small"
                        onClick={() => { fetchTokenStatus(); fetchOAuthConfig(); }}
                      >
                        我已完成授权，刷新状态
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {/* 公网隧道控制 */}
              <div className="mt-3 p-3 rounded" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                    公网回调隧道
                  </span>
                  {tunnelInfo.running ? (
                    <Button
                      variant="text"
                      size="small"
                      theme="danger"
                      onClick={handleStopTunnel}
                    >
                      关闭隧道
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="small"
                      onClick={handleStartTunnel}
                      loading={tunnelLoading}
                    >
                      启动公网隧道
                    </Button>
                  )}
                </div>
                {tunnelInfo.running ? (
                  <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                    <div>公网地址: <code style={{ color: 'var(--td-brand-color)' }}>{tunnelInfo.url}</code></div>
                    <div className="mt-1">回调地址: <code style={{ color: '#67c23a' }}>{tunnelInfo.callbackUrl}</code></div>
                    <div className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      请将此回调地址填入 ML 应用配置的 Redirect URI
                    </div>
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    Mercado Libre 不接受 localhost 回调地址。点击「启动公网隧道」获取 HTTPS 公网地址。
                  </div>
                )}
              </div>

              {/* 回调地址提示 */}
              {oauthConfig.hasConfig && !tunnelInfo.running && (
                <div className="text-xs mt-3 p-2 rounded" style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-secondary)' }}>
                  当前回调地址: <code style={{ color: 'var(--td-brand-color)' }}>{oauthConfig.redirectUri}</code>
                  <br />
                  请确保 ML 应用配置中的 Redirect URI 与此一致
                </div>
              )}
            </div>

            {/* 手动交换授权码（备用） */}
            {oauthConfig.hasConfig && !tokenStatus.hasToken && (
              <div className="p-3 rounded-lg" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                  备用：手动粘贴授权码或回调 URL
                </div>
                <div className="text-xs mb-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  如果自动回调失败，从浏览器地址栏复制完整 URL 粘贴到下方（推荐），或仅粘贴 code 参数值
                </div>
                <div className="flex gap-2">
                  <Input
                    value={manualCode}
                    onChange={(val) => setManualCode(val as string)}
                    placeholder="粘贴完整回调 URL 或 code 值..."
                    clearable
                  />
                  <Button
                    variant="outline"
                    size="small"
                    onClick={handleExchangeCode}
                    disabled={!manualCode.trim()}
                  >
                    交换 Token
                  </Button>
                </div>
              </div>
            )}

            {/* 手动粘贴 Token（备用） */}
            <details className="text-xs">
              <summary className="cursor-pointer" style={{ color: 'var(--td-text-color-secondary)' }}>
                手动粘贴 Access Token（备用方式）
              </summary>
              <div className="mt-2 flex gap-2">
                <Input
                  value={tokenInput}
                  onChange={(val) => setTokenInput(val as string)}
                  placeholder="粘贴 Mercado Libre Access Token..."
                  type="password"
                  clearable
                />
                <Button
                  theme="primary"
                  variant="outline"
                  onClick={handleSaveToken}
                  disabled={!tokenInput.trim()}
                >
                  保存
                </Button>
              </div>
            </details>

            {/* 后端直连说明（无需代理 / VPN） */}
            <div className="text-xs p-3 rounded-lg flex items-start gap-2" style={{ backgroundColor: 'rgba(103, 194, 58, 0.06)', color: 'var(--td-text-color-secondary)' }}>
              <CheckCircleIcon size={16} style={{ color: '#67c23a', marginTop: 1 }} />
              <div>
                <p className="font-medium mb-1" style={{ color: '#67c23a' }}>后端直连模式（免 VPN）</p>
                <p>后端 Node 进程从中国直连 ML 的 <code style={{ color: 'var(--td-brand-color)' }}>/highlights</code> 与 <code style={{ color: 'var(--td-brand-color)' }}>/products</code> 接口抓取（无需 VPN、无需任何代理）。若填入<strong>住宅代理</strong>，则自动改走 <code style={{ color: 'var(--td-brand-color)' }}>/search</code> 翻页拉取更多数据。下方按需求设置筛选条件即可。</p>
              </div>
            </div>

            {/* 帮助说明 */}
            <div className="text-xs p-3 rounded-lg" style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-secondary)' }}>
              <p className="font-medium mb-1" style={{ color: 'var(--td-text-color-primary)' }}>快速开始:</p>
              <p>1. 访问 <a href="https://developers.mercadolibre.com.mx/devcenter/" target="_blank" rel="noopener" style={{ color: 'var(--td-brand-color)' }}>developers.mercadolibre.com.mx</a> 登录并创建应用，获取 <strong>App ID</strong> 和 <strong>Secret Key</strong></p>
              <p>2. 将 App ID 和 Secret Key 填入上方输入框 → 点击「保存配置」</p>
              <p>3. 点击「获取应用 Token」（推荐，无需公网隧道和用户授权）</p>
              <p>4. 如果步骤3失败，点击「OAuth 授权获取 Token」→ 启动公网隧道 → 前往美客多授权</p>
              <p>5. 在「抓取配置」中勾选站点、设置价格上限与筛选条件</p>
              <p>6. 点击「开始抓取（后端直连·免 VPN）」即可，无需任何代理</p>
              <p className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>※ Token 有效期约 6 小时，过期后可点击「刷新 Token」一键续期</p>
              <p className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>※ 后端直接从中国直连 ML 接口抓取，无需 VPN、无需代理</p>
            </div>
          </div>
        </Card>

        {/* 配置卡片 */}
        <Card title="抓取配置" bordered>
          <div className="space-y-4">
            {/* 站点选择 */}
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium w-20" style={{ color: 'var(--td-text-color-primary)' }}>
                目标站点
              </span>
              <div className="flex gap-3 flex-wrap">
                <Checkbox
                  checked={selectedSites.includes('MLM')}
                  onChange={(val) => {
                    if (val) {
                      setSelectedSites([...selectedSites, 'MLM']);
                    } else {
                      setSelectedSites(selectedSites.filter(s => s !== 'MLM'));
                    }
                  }}
                >
                  墨西哥 (MLM)
                </Checkbox>
                <Checkbox
                  checked={selectedSites.includes('MLB')}
                  onChange={(val) => {
                    if (val) {
                      setSelectedSites([...selectedSites, 'MLB']);
                    } else {
                      setSelectedSites(selectedSites.filter(s => s !== 'MLB'));
                    }
                  }}
                >
                  巴西 (MLB)
                </Checkbox>
                <Checkbox
                  checked={selectedSites.includes('MLC')}
                  onChange={(val) => {
                    if (val) {
                      setSelectedSites([...selectedSites, 'MLC']);
                    } else {
                      setSelectedSites(selectedSites.filter(s => s !== 'MLC'));
                    }
                  }}
                >
                  智利 (MLC)
                </Checkbox>
                <Checkbox
                  checked={selectedSites.includes('MCO')}
                  onChange={(val) => {
                    if (val) {
                      setSelectedSites([...selectedSites, 'MCO']);
                    } else {
                      setSelectedSites(selectedSites.filter(s => s !== 'MCO'));
                    }
                  }}
                >
                  哥伦比亚 (MCO)
                </Checkbox>
              </div>
            </div>

            {/* 价格上限 */}
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium w-20" style={{ color: 'var(--td-text-color-primary)' }}>
                价格上限 (USD)
              </span>
              <Input
                type="number"
                value={String(priceLimitUsd)}
                onChange={(val) => setPriceLimitUsd(Number(val) || 0)}
                style={{ width: 120 }}
                suffix="USD"
              />
              <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                (0 = 不限价格；自动转换为本地货币筛选)
              </span>
            </div>

            {/* 筛选条件 */}
            <div className="flex items-start gap-4">
              <span className="text-sm font-medium w-20 pt-1" style={{ color: 'var(--td-text-color-primary)' }}>
                筛选条件
              </span>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Switch value={excludeFull} onChange={(val) => setExcludeFull(val as boolean)} />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>排除 ML Full（官方仓发货）</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch value={excludeDomestic} onChange={(val) => setExcludeDomestic(val as boolean)} />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>仅保留跨境商品（排除本土卖家）</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch value={onlyNew} onChange={(val) => setOnlyNew(val as boolean)} />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>仅全新商品</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch value={includeSubcategories} onChange={(val) => setIncludeSubcategories(val as boolean)} />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>展开子分类扩量（更多数据，更慢）</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch value={miaoshouPackage} onChange={(val) => setMiaoshouPackage(val as boolean)} />
                  <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>导出妙手素材包（ZIP 含商品主图，推荐导入方式）</span>
                </div>
              </div>
            </div>

            {/* 抓取数量 */}
            <div className="flex items-center gap-4">
              <span className="text-sm font-medium w-20" style={{ color: 'var(--td-text-color-primary)' }}>
                每类数量
              </span>
              <Tag size="large" theme="success" variant="light">
                Top 100
              </Tag>
              <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                (按销量排序)
              </span>
            </div>

            {/* 导出字段 */}
            <div className="flex items-start gap-4">
              <span className="text-sm font-medium w-20 pt-1" style={{ color: 'var(--td-text-color-primary)' }}>
                导出字段
              </span>
              <div className="flex flex-wrap gap-2">
                {['商品链接', '价格', '标题', '重量', '尺寸(长宽高)', '销量', '库存', '品牌', '型号', '卖家', '成色'].map(field => (
                  <Tag key={field} size="small" variant="light-outline">
                    {field}
                  </Tag>
                ))}
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="mt-6 flex gap-3 flex-wrap">
            <Button
              theme="primary"
              size="large"
              icon={isFetching ? <LoadingIcon /> : <SearchIcon />}
              onClick={handleFetchViaBrowser}
              loading={isFetching}
              disabled={isFetching || selectedSites.length === 0 || !tokenStatus.hasToken}
            >
              {isFetching ? '抓取中...' : '开始抓取（后端直连·免 VPN）'}
            </Button>
            <Button
              size="large"
              variant="outline"
              icon={<RefreshIcon />}
              onClick={fetchFiles}
              disabled={isFetching}
            >
              刷新文件列表
            </Button>
          </div>

          {/* 抓取模式说明 */}
          <div className="mt-3 p-3 rounded-lg text-xs" style={{ backgroundColor: 'rgba(59, 130, 246, 0.08)', color: 'var(--td-text-color-secondary)' }}>
            <p className="font-medium mb-1" style={{ color: '#67c23a' }}>✓ 后端直连模式（免 VPN）</p>
            <p>后端 Node 进程从中国直连 ML 的 highlights/products 接口抓取（无需 VPN、无需任何代理）；若填入住宅代理，则自动改走 /search 翻页拉取更多数据。抓取完成后自动导出 Excel 文件。如已配置邮箱，结果会自动发送到你的邮箱。</p>
          </div>
        </Card>

        {/* 住宅代理（可选·解锁更多数据） */}
        <Card title="住宅代理（可选·解锁更多数据）" bordered>
          <div className="space-y-3">
            <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
              留空＝免 VPN 走 <code style={{ color: 'var(--td-brand-color)' }}>/highlights</code>（每类目约 20 条）。填入<strong>目标国住宅代理</strong>后，抓取自动改走 <code style={{ color: 'var(--td-brand-color)' }}>/search</code> 翻页（每类目最多约 2000 条）。代理须<strong>地理匹配</strong>：抓墨西哥用墨西哥 IP、巴西用巴西 IP，依此类推。
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <Input
                value={proxyUrl}
                onChange={(val: any) => setProxyUrl(val)}
                placeholder="http://user:pass@mx.proxy.com:8000 或 socks5://..."
                style={{ width: 380 }}
              />
              <Button theme="primary" variant="outline" size="small" onClick={handleSaveProxy} loading={proxySaving}>保存代理</Button>
              <Button size="small" onClick={handleTestProxy} loading={proxyTesting}>测试连通</Button>
              {proxyStatus.hasProxy && (
                <Tag size="small" theme="success" variant="light">已配置代理</Tag>
              )}
            </div>
            {proxyTestResult && (
              <div className="text-xs" style={{ color: proxyTestResult.success ? '#67c23a' : '#f56c6c' }}>
                {proxyTestResult.success ? '✓ ' : '✗ '}{proxyTestResult.message}
              </div>
            )}
          </div>
        </Card>

        {/* 邮件配置 */}
        <Card title="邮件通知" bordered>
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 rounded-lg" style={{ backgroundColor: emailCfg.enabled ? 'rgba(103, 194, 58, 0.08)' : 'rgba(245, 108, 108, 0.08)' }}>
              {emailCfg.enabled ? (
                <CheckCircleIcon size={20} style={{ color: '#67c23a', flexShrink: 0 }} />
              ) : (
                <LockOnIcon size={20} style={{ color: '#f56c6c', flexShrink: 0 }} />
              )}
              <div className="flex-1 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                {emailCfg.enabled ? `已启用邮件通知，抓取结果将发送至 ${emailCfg.to || '（未设置收件人）'}` : '未启用邮件通知'}
              </div>
              <Switch value={emailCfg.enabled} onChange={(val: any) => setEmailCfg({ ...emailCfg, enabled: val })} />
            </div>

            {/* 收件人 */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>收件邮箱</span>
              <Input
                value={emailCfg.to}
                onChange={(val: any) => setEmailCfg({ ...emailCfg, to: val })}
                placeholder="接收结果的邮箱地址"
                style={{ width: 300 }}
              />
            </div>

            {/* 发件人 SMTP 设置（折叠，首次必填） */}
            <div className="rounded-lg border" style={{ borderColor: 'var(--td-component-border)' }}>
              <div
                className="flex items-center justify-between px-3 py-2 cursor-pointer select-none"
                onClick={() => setSmtpOpen((v) => !v)}
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                <span className="text-sm font-medium">发件人 SMTP 设置（只需配置一次）</span>
                <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>{smtpOpen ? '收起 ▲' : '展开填写 ▼'}</span>
              </div>
              {smtpOpen && (
                <div className="px-3 pb-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>SMTP 主机</span>
                      <Input value={emailCfg.host} onChange={(val: any) => setEmailCfg({ ...emailCfg, host: val })} placeholder="如 smtp.gmail.com" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-12 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>端口</span>
                      <Input type="number" value={emailCfg.port} onChange={(val: any) => setEmailCfg({ ...emailCfg, port: Number(val) || 465 })} style={{ width: 90 }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>账号</span>
                      <Input value={emailCfg.user} onChange={(val: any) => setEmailCfg({ ...emailCfg, user: val })} placeholder="发件邮箱" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-12 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>密码</span>
                      <Input type="password" value={emailCfg.pass} onChange={(val: any) => setEmailCfg({ ...emailCfg, pass: val })} placeholder="授权码/密码" />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs w-16 flex-shrink-0" style={{ color: 'var(--td-text-color-secondary)' }}>发件人</span>
                      <Input value={emailCfg.from} onChange={(val: any) => setEmailCfg({ ...emailCfg, from: val })} placeholder="可选，默认同账号" />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                        <input
                          type="checkbox"
                          checked={emailCfg.secure}
                          onChange={(e) => setEmailCfg({ ...emailCfg, secure: (e.target as HTMLInputElement).checked })}
                        />
                        SSL/TLS 加密（端口 465 通常开启）
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <Button theme="primary" variant="outline" size="small" onClick={handleSaveEmail} loading={emailSaving}>保存配置</Button>
              <Button size="small" onClick={handleTestEmail} disabled={emailSaving || !emailCfg.to || !emailCfg.host || !emailCfg.user}>发送测试</Button>
              {emailTestMsg && (
                <span className="text-xs" style={{ color: emailTestMsg.success ? '#67c23a' : '#f56c6c' }}>{emailTestMsg.message}</span>
              )}
            </div>
            <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              ※ 抓取完成后后端自动将 xlsx 结果作为附件发送。首次使用需填写上面的发件人 SMTP（Gmail / QQ / 企业邮箱均可），之后无需再改。
            </div>
          </div>
        </Card>

        {/* 定时任务 */}
        <Card title="定时自动抓取" bordered>
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>启用定时</span>
              <Switch value={scheduleCfg.enabled} onChange={(val: any) => setScheduleCfg({ ...scheduleCfg, enabled: val })} />
              <span className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>每日运行时间</span>
              <input type="time" value={scheduleCfg.time} onChange={(e) => setScheduleCfg({ ...scheduleCfg, time: (e.target as HTMLInputElement).value })} style={{ width: 130, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--td-component-border)', background: 'var(--td-bg-color-container)', color: 'var(--td-text-color-primary)' }} />
              <Button theme="primary" variant="outline" size="small" onClick={handleSaveSchedule} loading={scheduleSaving}>保存</Button>
            </div>
            {scheduleCfg.lastRun && (
              <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                上次运行: {new Date(scheduleCfg.lastRun).toLocaleString('zh-CN')}
              </div>
            )}
            <div className="text-xs p-3 rounded-lg" style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-secondary)' }}>
              <p>① 本机/服务器内置调度器：开启后，程序在设定时间（服务器时区）自动抓取并发送邮件。</p>
              <p>② 部署到 Render 等免费平台时，服务会休眠。请用外部定时器（如 cron-job.org）每日在设定时间请求 <code style={{ color: 'var(--td-brand-color)' }}>/api/ml/trigger</code> 唤醒并触发抓取。</p>
              <p className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>※ 定时触发会使用最近一次「开始抓取」的站点与筛选条件。</p>
            </div>
          </div>
        </Card>

        {/* 进度区域 */}
        {(isFetching || progress || result) && (
          <Card title="抓取进度" bordered>
            {/* 当前步骤状态（始终可见，避免误以为卡死） */}
            {progress && (
              <div className="mb-3 text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
                ⏳ {progress.message}
              </div>
            )}

            {/* 全局总进度条（跨站点 0→100%） */}
            {globalProgress.total > 0 && (() => {
              const gp = Math.round((globalProgress.current / globalProgress.total) * 100);
              return (
                <div className="mb-4">
                  <div className="flex justify-between mb-2">
                    <span className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
                      总进度（全部站点累计）
                    </span>
                    <span className="text-sm font-bold" style={{ color: 'var(--td-brand-color)' }}>
                      {globalProgress.current} / {globalProgress.total} ({gp}%)
                    </span>
                  </div>
                  <Progress percentage={gp} color="var(--td-brand-color)" />
                  <div className="flex justify-between mt-2 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    <span>已用 {formatDuration(elapsedMs)}</span>
                    <span>{remainingMs > 0 ? `预计剩余 ${formatDuration(remainingMs)}` : '即将完成'}</span>
                  </div>
                </div>
              );
            })()}

            {/* 完成结果 */}
            {result && (
              <div
                className="p-4 rounded-lg mb-4 flex items-center gap-3"
                style={{
                  backgroundColor: result.phase === 'complete'
                    ? 'rgba(103, 194, 58, 0.1)'
                    : 'rgba(245, 108, 108, 0.1)',
                }}
              >
                {result.phase === 'complete' ? (
                  <CheckCircleIcon size={24} style={{ color: '#67c23a' }} />
                ) : (
                  <CloudDownloadIcon size={24} style={{ color: '#f56c6c' }} />
                )}
                <div className="flex-1">
                  <div className="font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
                    {result.message}
                  </div>
                  {result.totalCount !== undefined && (
                    <div className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
                      总计 {result.totalCount} 个商品
                      {result.siteStats && Object.entries(result.siteStats).map(([site, count]) => (
                        <span key={site} className="ml-3">
                          {site === 'MLM' ? '墨西哥' : site === 'MLB' ? '巴西' : site === 'MLC' ? '智利' : '哥伦比亚'}: {count} 个
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {result.filePath && (
                  <Button
                    theme="primary"
                    icon={<DownloadIcon />}
                    onClick={() => handleDownload(result.filePath!)}
                  >
                    下载 Excel
                  </Button>
                )}
              </div>
            )}

            {/* 日志区域 */}
            {progressLog.length > 0 && (
              <div
                className="mt-4 p-3 rounded-lg overflow-y-auto"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  maxHeight: '300px',
                  fontFamily: 'SF Mono, Monaco, Consolas, monospace',
                  fontSize: '12px',
                  lineHeight: '1.6',
                }}
              >
                {progressLog.map((log, i) => (
                  <div
                    key={i}
                    style={{ color: log.startsWith('❌') ? '#f56c6c' : log.startsWith('✅') ? '#67c23a' : 'var(--td-text-color-secondary)' }}
                  >
                    {log}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </Card>
        )}

        {/* 已导出文件列表 */}
        <Card title="已导出文件" bordered>
          <div className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--td-text-color-secondary)' }}>
            带 <Tag theme="warning" size="small" variant="light">妙手素材包</Tag> 标记的 <b>*.zip</b>（含商品主图）可直接拖入妙手「素材包导入」走 采集箱→认领→发布；<b>*.xlsx</b> 为 14 列明细，供妙手「产品导入表格」使用。两者下载按钮通用。
          </div>
          {files.length === 0 ? (
            <div
              className="py-12 text-center"
              style={{ color: 'var(--td-text-color-placeholder)' }}
            >
              <FileExcelIcon size={48} style={{ opacity: 0.3 }} />
              <p className="mt-3">暂无导出文件，点击"开始抓取"生成第一个文件</p>
            </div>
          ) : (
            <Table
              data={files.map((f, i) => ({
                key: i,
                index: i + 1,
                fileName: f.fileName,
                size: formatSize(f.size),
                createdAt: formatDate(f.createdAt),
                operation: f.fileName,
              }))}
              columns={[
                { colKey: 'index', title: '#', width: 60 },
                {
                  colKey: 'fileName',
                  title: '文件名',
                  ellipsis: true,
                  render: ({ row }: any) => {
                    const isZip = row.fileName.endsWith('.zip');
                    return (
                      <div className="flex items-center gap-2">
                        {isZip ? <FileIcon style={{ color: '#e37318' }} /> : <FileExcelIcon style={{ color: '#1a8e3f' }} />}
                        <span>{row.fileName}</span>
                        {isZip && <Tag theme="warning" size="small" variant="light">妙手素材包</Tag>}
                      </div>
                    );
                  },
                },
                { colKey: 'size', title: '大小', width: 100 },
                { colKey: 'createdAt', title: '创建时间', width: 180 },
                {
                  colKey: 'operation',
                  title: '操作',
                  width: 180,
                  render: ({ row }: any) => (
                    <div className="flex gap-2">
                      <Button
                        size="small"
                        theme="primary"
                        variant="outline"
                        icon={<DownloadIcon />}
                        onClick={() => handleDownload(row.operation)}
                      >
                        下载
                      </Button>
                      <Button
                        size="small"
                        theme="default"
                        variant="outline"
                        onClick={() => handleResendEmail(row.operation)}
                      >
                        发邮件
                      </Button>
                      <Button
                        size="small"
                        theme="danger"
                        variant="outline"
                        icon={<DeleteIcon />}
                        onClick={() => handleDeleteFile(row.operation)}
                      >
                        删除
                      </Button>
                    </div>
                  ),
                },
              ]}
              rowKey="key"
              bordered
              size="small"
            />
          )}
        </Card>

        {/* 使用说明 */}
        <Card title="使用说明" bordered>
          <div className="space-y-2 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            <p>1. 选择目标站点（墨西哥 MLM / 巴西 MLB / 智利 MLC / 哥伦比亚 MCO），可多选</p>
            <p>2. 设置价格上限、筛选条件（排除 ML Full / 本土、仅全新、展开子分类扩量）</p>
            <p>3. 点击"开始抓取"按钮，系统将自动获取各分类销量前100的商品并导出 Excel</p>
            <p>4. 配置邮箱后可自动将结果 xlsx 发送至你的邮箱；配置定时任务可每日自动运行</p>
            <p>5. 可在"已导出文件"列表中下载历史文件</p>
            <p className="pt-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
              ※ 注意：美客多 API 有速率限制，完整抓取可能需要数分钟。后端直连模式无需 VPN。
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

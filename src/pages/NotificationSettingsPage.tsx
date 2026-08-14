import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Button,
  Input,
  InputNumber,
  Switch,
  Select,
  Table,
  Tag,
  MessagePlugin,
  Space,
  Dialog,
  Tooltip,
  Collapse,
} from 'tdesign-react';
import {
  NotificationIcon,
  MailIcon,
  MobileIcon,
  RefreshIcon,
} from 'tdesign-icons-react';
import { confirmDialog } from '../utils/dialog';

interface NotifyConfig {
  orderAlertsEnabled: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
  pollIntervalMinutes: number;
}

type WebhookType = 'generic' | 'dingtalk' | 'wecom' | 'bark';

interface SmsConfig {
  provider: 'none' | 'twilio' | 'webhook';
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  toNumber?: string;
  webhookUrl?: string;
  webhookType?: WebhookType;
}

interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

interface AlertItem {
  storeId: string;
  storeName: string;
  orderId: string;
  at: string;
  channels: string[];
  total?: string;
  status?: 'success' | 'failed' | 'skipped';
  content?: string;
  results?: Array<{ channel: string; success: boolean; message: string }>;
}

const DEFAULT_NOTIFY: NotifyConfig = { orderAlertsEnabled: false, emailEnabled: true, smsEnabled: false, pollIntervalMinutes: 30 };

const sortAlertsDesc = (list: AlertItem[]) =>
  [...list].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

export function NotificationSettingsPage() {
  const [notifyCfg, setNotifyCfg] = useState<NotifyConfig>(DEFAULT_NOTIFY);
  const [smsCfg, setSmsCfg] = useState<SmsConfig>({ provider: 'none' });
  const [smsForm, setSmsForm] = useState<SmsConfig>({ provider: 'none' });
  const [emailCfg, setEmailCfg] = useState<EmailConfig>({ enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', to: '' });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [testingSms, setTestingSms] = useState(false);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [pageInfo, setPageInfo] = useState({ current: 1, pageSize: 20 });
  const [emailOk, setEmailOk] = useState<boolean | null>(null);
  const [detailItem, setDetailItem] = useState<AlertItem | null>(null);
  const [testWithLastOrder, setTestWithLastOrder] = useState(false);
  const [testWithLastOrderEmail, setTestWithLastOrderEmail] = useState(false);
  const [smsPreview, setSmsPreview] = useState('');
  const [emailPreview, setEmailPreview] = useState('');
  const [previewVisible, setPreviewVisible] = useState(false);
  const inflightRef = useRef<AbortController[]>([]);

  const fetchJson = useCallback(async (url: string, init: RequestInit = {}, timeoutMs = 20000) => {
    const controller = new AbortController();
    inflightRef.current.push(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return await r.json();
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError') throw new Error('请求超时，请检查后端是否正常运行');
      throw err;
    } finally {
      inflightRef.current = inflightRef.current.filter((c) => c !== controller);
    }
  }, []);

  const loadWithRetry = useCallback(async (url: string, init: RequestInit = {}, timeoutMs = 20000, retries = 2) => {
    let lastErr: any = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fetchJson(url, init, timeoutMs);
      } catch (err: any) {
        lastErr = err;
        if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    throw lastErr;
  }, [fetchJson]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const errors: string[] = [];
    try {
      // 顺序加载，单个失败不影响其它；配置接口给 20s，日志接口给 10s；每个接口最多重试 2 次
      const n = await loadWithRetry('/api/ml/notify-config', {}, 20000).catch((e: any) => { errors.push('通知配置'); return null; });
      const s = await loadWithRetry('/api/ml/sms-config', {}, 20000).catch((e: any) => { errors.push('短信配置'); return null; });
      const e = await loadWithRetry('/api/ml/email', {}, 20000).catch((err: any) => { errors.push('邮件配置'); return null; });
      const a = await loadWithRetry('/api/ml/orders/alerts', {}, 10000).catch((err: any) => { errors.push('提醒日志'); return null; });

      if (n?.success) setNotifyCfg({ ...DEFAULT_NOTIFY, ...n.config });
      if (s?.success) { setSmsCfg(s.config); setSmsForm(s.config); }
      if (e && typeof e === 'object' && (e.host !== undefined || e.user !== undefined || e.to !== undefined)) {
        setEmailCfg({ enabled: !!e.enabled, host: e.host || '', port: Number(e.port) || 465, secure: !!e.secure, user: e.user || '', pass: e.pass ? '******' : '', from: e.from || '', to: e.to || '' });
      }
      if (a?.success) setAlerts(sortAlertsDesc(a.alerts || []));

      if (errors.length) {
        MessagePlugin.warning(`加载 ${errors.join('、')} 失败，请刷新重试或检查后端是否正常运行`);
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [loadWithRetry]);

  useEffect(() => {
    loadAll();
    return () => {
      inflightRef.current.forEach((c) => c.abort());
      inflightRef.current = [];
    };
  }, [loadAll]);

  // 数据变化时（如删除记录），避免当前页码超出总页数导致空白
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(alerts.length / pageInfo.pageSize));
    if (pageInfo.current > maxPage) {
      setPageInfo((p) => ({ ...p, current: maxPage }));
    }
  }, [alerts.length, pageInfo.current, pageInfo.pageSize]);

  // 自行按当前页切片（配合 disableDataPage，分页完全由本组件控制，避免 tdesign 内部重置导致翻页失灵）
  const pagedAlerts = alerts.slice(
    (pageInfo.current - 1) * pageInfo.pageSize,
    pageInfo.current * pageInfo.pageSize,
  );

  const saveAll = async () => {
    setSaving(true);
    try {
      await fetchJson('/api/ml/notify-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notifyCfg),
      });
      await fetchJson('/api/ml/sms-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(smsForm),
      });
      const emailBody: any = { ...emailCfg };
      if (emailBody.pass === '******') {
        const cur = await fetchJson('/api/ml/email');
        emailBody.pass = cur.pass || '';
      }
      await fetchJson('/api/ml/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(emailBody),
      });
      MessagePlugin.success('通知配置已保存（轮询间隔已生效）');
      loadAll();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const testEmail = async () => {
    setTestingEmail(true);
    setEmailOk(null);
    try {
      const r = await fetchJson('/api/ml/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLastOrder: testWithLastOrderEmail }),
      }, 30000);
      setEmailOk(r.success);
      if (r.success) MessagePlugin.success(r.message);
      else MessagePlugin.warning(r.message || '测试失败');
      if (r.success && r.preview?.text) {
        setEmailPreview(r.preview.text);
        setPreviewVisible(true);
      }
      await appendTestAlert({ channel: 'email', content: r.preview?.text || '', message: r.message || (r.success ? '测试邮件已发送' : '测试失败'), success: !!r.success });
    } catch (err: any) {
      setEmailOk(false);
      MessagePlugin.error(err?.message || '测试失败');
    } finally {
      setTestingEmail(false);
    }
  };

  // 把一次测试发送的结果写入「发送记录」列表（含详情/删除），方便回溯
  const appendTestAlert = useCallback(async (params: { channel: 'sms' | 'email'; content: string; message: string; success: boolean }) => {
    const alert: AlertItem = {
      storeId: 'test',
      storeName: '测试',
      orderId: `test-${Date.now()}`,
      at: new Date().toISOString(),
      channels: [params.channel],
      total: undefined,
      status: params.success ? 'success' : 'failed',
      content: params.content || params.message,
      results: [{ channel: params.channel, success: params.success, message: params.message }],
    };
    try {
      await fetchJson('/api/ml/orders/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert }),
      }, 15000);
      // 重新拉取列表，并按时间倒序排列
      const a = await loadWithRetry('/api/ml/orders/alerts', {}, 10000).catch(() => null);
      if (a?.success) setAlerts(sortAlertsDesc(a.alerts || []));
    } catch {
      // 写入失败不影响测试结果显示：直接挂到内存列表，仍保持倒序
      setAlerts((prev) => sortAlertsDesc([alert, ...prev]));
    }
  }, [fetchJson, loadWithRetry]);

  const testSms = async () => {
    setTestingSms(true);
    try {
      const r = await fetchJson('/api/ml/sms/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useLastOrder: testWithLastOrder, config: smsForm }),
      }, 30000);
      if (r.success) {
        MessagePlugin.success(r.message);
        if (r.preview?.smsText) {
          setSmsPreview(r.preview.smsText);
          setPreviewVisible(true);
        }
        await appendTestAlert({ channel: 'sms', content: r.preview?.smsText || '', message: r.message || '测试发送成功', success: true });
      } else {
        MessagePlugin.warning(r.message || '测试失败');
        await appendTestAlert({ channel: 'sms', content: '', message: r.message || '测试失败', success: false });
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '测试失败');
      await appendTestAlert({ channel: 'sms', content: '', message: err?.message || '测试失败', success: false });
    } finally {
      setTestingSms(false);
    }
  };

  const deleteAlert = async (orderId: string) => {
    const confirmed = await confirmDialog({
      header: '删除提醒记录',
      body: `确定删除订单「${orderId}」的提醒记录吗？该操作不可恢复。`,
      confirmText: '删除',
    });
    if (!confirmed) return;
    try {
      const r = await fetchJson(`/api/ml/orders/alerts/${encodeURIComponent(orderId)}`, { method: 'DELETE' }, 15000);
      if (r?.success) {
        setAlerts((prev) => prev.filter((a) => a.orderId !== orderId));
        MessagePlugin.success('已删除该记录');
      } else {
        MessagePlugin.warning('删除失败，记录可能不存在');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '删除失败');
    }
  };

  const alertColumns = [
    { colKey: 'storeName', title: '店铺', width: 120, ellipsis: true },
    { colKey: 'orderId', title: '订单号', width: 160, ellipsis: true },
    { colKey: 'total', title: '金额', width: 120, cell: ({ row }: any) => row.total || '-' },
    { colKey: 'at', title: '时间', width: 180, cell: ({ row }: any) => new Date(row.at).toLocaleString() },
    {
      colKey: 'status',
      title: '状态',
      width: 100,
      cell: ({ row }: any) => {
        const st = row.status || 'skipped';
        if (st === 'success') return <Tag theme="success" variant="light" size="small">成功</Tag>;
        if (st === 'failed') return <Tag theme="danger" variant="light" size="small">失败</Tag>;
        return <Tag theme="default" variant="light" size="small">未发送</Tag>;
      },
    },
    {
      colKey: 'content',
      title: '通知内容',
      minWidth: 200,
      ellipsis: true,
      cell: ({ row }: any) => (
        <Tooltip content={row.content || '无内容'} placement="top" showArrow>
          <span style={{ cursor: 'pointer' }}>{row.content || '-'}</span>
        </Tooltip>
      ),
    },
    {
      colKey: 'channels',
      title: '通知渠道',
      width: 150,
      cell: ({ row }: any) => {
        const chs = row.channels || [];
        const results = row.results || [];
        if (!chs.length && !results.length) return <span style={{ color: 'var(--td-text-color-placeholder)' }}>-</span>;
        return results.map((r: any) => (
          <Tag key={r.channel} size="small" theme={r.success ? 'success' : 'danger'} variant="light" style={{ marginRight: 4 }}>
            {r.channel === 'email' ? '邮件' : r.channel === 'sms' ? '短信' : r.channel}
          </Tag>
        ));
      },
    },
    {
      colKey: 'action',
      title: '操作',
      width: 140,
      cell: ({ row }: any) => (
        <Space size={4}>
          <Button theme="primary" variant="text" size="small" onClick={() => setDetailItem(row)}>详情</Button>
          <Button theme="danger" variant="text" size="small" onClick={() => deleteAlert(row.orderId)}>删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-4 space-y-4" style={{ overflowY: 'auto', height: '100%' }}>
      {/* 总开关 + 轮询间隔 */}
      <Card title={<span><NotificationIcon /> 提醒总开关与轮询频率</span>} bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2">
            <Switch value={notifyCfg.orderAlertsEnabled} onChange={(v: boolean) => setNotifyCfg({ ...notifyCfg, orderAlertsEnabled: v })} />
            <span>启用新订单提醒（关闭后即使有配置也不会下发任何通知）</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span>自动轮询间隔</span>
            <InputNumber
              value={notifyCfg.pollIntervalMinutes}
              min={5}
              max={240}
              step={5}
              theme="column"
              onChange={(v: any) => setNotifyCfg({ ...notifyCfg, pollIntervalMinutes: Number(v) })}
              style={{ width: 120 }}
            />
            <span>分钟（建议 30 分钟，过小会触发美客多接口限流）</span>
          </div>
          <Collapse style={{ width: '100%' }}>
            <Collapse.Panel value="pollHelp" header="工作原理说明（点击展开）">
              <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                后台会按此间隔自动拉取各店铺订单，发现新付款订单后，按下方启用的渠道（邮件/短信）推送提醒。保存后即时生效，无需重启。首次运行或超过 7 天未轮询时，会自动跳过历史订单，只同步最新订单时间，避免旧订单轰炸。
              </div>
            </Collapse.Panel>
          </Collapse>
        </Space>
      </Card>

      {/* 邮件 */}
      <Card title={<span><MailIcon /> 邮件提醒（SMTP）</span>} bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2">
            <Switch value={notifyCfg.emailEnabled} onChange={(v: boolean) => setNotifyCfg({ ...notifyCfg, emailEnabled: v })} />
            <span>启用邮件提醒</span>
            {emailOk === true && <Tag theme="success" variant="light">上次测试成功</Tag>}
            {emailOk === false && <Tag theme="danger" variant="light">上次测试失败</Tag>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ maxWidth: 760 }}>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>SMTP 服务器</label>
              <Input value={emailCfg.host} onChange={(v: string) => setEmailCfg({ ...emailCfg, host: v })} placeholder="如 smtp.qq.com" />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>端口（SSL 465 / TLS 587）</label>
              <InputNumber value={emailCfg.port} min={1} max={65535} onChange={(v: any) => setEmailCfg({ ...emailCfg, port: Number(v) })} style={{ width: '100%' }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>登录账号</label>
              <Input value={emailCfg.user} onChange={(v: string) => setEmailCfg({ ...emailCfg, user: v })} placeholder="发件邮箱完整地址" />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>授权码/密码（非邮箱登录密码）</label>
              <Input type="password" value={emailCfg.pass} onChange={(v: string) => setEmailCfg({ ...emailCfg, pass: v })} placeholder="QQ/163 用授权码" />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>收件邮箱（可多个，逗号分隔）</label>
              <Input value={emailCfg.to} onChange={(v: string) => setEmailCfg({ ...emailCfg, to: v })} placeholder="接收提醒的邮箱" />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>发件人显示（可选）</label>
              <Input value={emailCfg.from} onChange={(v: string) => setEmailCfg({ ...emailCfg, from: v })} placeholder="留空则用登录账号" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch value={emailCfg.secure} onChange={(v: boolean) => setEmailCfg({ ...emailCfg, secure: v })} />
            <span>使用 SSL/TLS（端口 465 时开启；587 时关闭用 STARTTLS）</span>
          </div>
          <Button variant="outline" icon={<RefreshIcon />} onClick={testEmail} loading={testingEmail}>发送测试邮件</Button>
          <div className="flex items-center gap-2">
            <Switch value={testWithLastOrderEmail} onChange={(v: boolean) => setTestWithLastOrderEmail(v)} size="small" />
            <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>用最近一条真实订单测试（与短信预览一致，发送真实订单通知样例）</span>
          </div>
          <Collapse style={{ width: '100%' }}>
            <Collapse.Panel value="emailHelp" header="免费 SMTP 推荐与授权码/专用密码获取（点击展开）">
              <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                {`免费 SMTP 推荐与授权码/专用密码获取：
• QQ 邮箱：smtp.qq.com:465，SSL 开启。QQ 邮箱设置 → 账户 → 开启「IMAP/SMTP服务」→ 按提示发短信 → 复制生成的 16 位授权码填到「授权码/密码」。
• 163 邮箱：smtp.163.com:465，SSL 开启。163 邮箱设置 → POP3/SMTP/IMAP → 开启 SMTP → 设置客户端授权码。
• Gmail：smtp.gmail.com:587，SSL 关闭（用 STARTTLS）。
  找不到「应用专用密码」？必须先开启「两步验证」：Google 账号 → 安全性 → 两步验证 → 按提示绑定手机 → 开启后才会出现「应用专用密码」入口 → 生成 16 位密码填到这里。`}
              </div>
            </Collapse.Panel>
          </Collapse>
        </Space>
      </Card>

      {/* 短信 */}
      <Card title={<span><MobileIcon /> 短信提醒</span>} bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2">
            <Switch value={notifyCfg.smsEnabled} onChange={(v: boolean) => setNotifyCfg({ ...notifyCfg, smsEnabled: v })} />
            <span>启用短信提醒</span>
          </div>
          <Select
            value={smsForm.provider}
            options={[
              { label: '不发送 (none)', value: 'none' },
              { label: 'Twilio（海外，付费，有试用额度）', value: 'twilio' },
              { label: '通用 Webhook（国内云短信/自建皆可，推荐）', value: 'webhook' },
            ]}
            onChange={(v: any) => setSmsForm({ ...smsForm, provider: v as SmsConfig['provider'] })}
            style={{ maxWidth: 520 }}
          />
          {smsForm.provider === 'twilio' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" style={{ maxWidth: 760 }}>
              <Input value={smsForm.accountSid} onChange={(v: string) => setSmsForm({ ...smsForm, accountSid: v })} placeholder="Twilio Account SID" />
              <Input type="password" value={smsForm.authToken} onChange={(v: string) => setSmsForm({ ...smsForm, authToken: v })} placeholder="Twilio Auth Token" />
              <Input value={smsForm.fromNumber} onChange={(v: string) => setSmsForm({ ...smsForm, fromNumber: v })} placeholder="发送号码 From（+国家码）" />
              <Input value={smsForm.toNumber} onChange={(v: string) => setSmsForm({ ...smsForm, toNumber: v })} placeholder="接收号码 To（+国家码）" />
            </div>
          )}
          {smsForm.provider === 'webhook' && (
            <div style={{ maxWidth: 760 }}>
              <div className="mb-2">
                <label className="text-xs block mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>Webhook 类型</label>
                <Select
                  value={smsForm.webhookType || 'generic'}
                  options={[
                    { label: '通用/自建云函数（text/content/message）', value: 'generic' },
                    { label: '钉钉群机器人', value: 'dingtalk' },
                    { label: '企业微信群机器人', value: 'wecom' },
                    { label: 'Bark 推送', value: 'bark' },
                  ]}
                  onChange={(v: any) => setSmsForm({ ...smsForm, webhookType: v as WebhookType })}
                  style={{ width: '100%' }}
                />
              </div>
              <Input value={smsForm.webhookUrl} onChange={(v: string) => setSmsForm({ ...smsForm, webhookUrl: v })} placeholder="Webhook URL" />
              <Collapse style={{ width: '100%', marginTop: 8 }}>
                <Collapse.Panel value="smsHelp" header="免费/低成本通知方案说明 + 新订单内容示例（点击展开）">
                  <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                    {`免费/低成本通知方案（短信/推送）详细说明：
① 钉钉群机器人（免费）
   • 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义（通过 Webhook 接入）→ 复制 Webhook 地址。
   • Webhook 类型选「钉钉群机器人」，系统会按钉钉格式 POST：
     { "msgtype": "markdown", "markdown": { "title":"新订单提醒", "text":"..." } }
   • 如需加签，请先用一个中间云函数验证签名后再转发。
② 企业微信群机器人（免费，适合团队/多人群收）
   • 电脑端企业微信 → 进入一个群 → 右上角「...」→ 添加机器人 → 复制 Webhook 地址。
   • Webhook 类型选「企业微信群机器人」，系统会按企微格式 POST：
     { "msgtype": "markdown", "markdown": { "content":"..." } }
③ Bark（iOS/Android 都支持，完全免费，推荐个人用）
   • iOS：App Store 搜索「Bark」安装；安卓：酷安/GitHub 搜索 Bark 安装 APK。
   • 打开 App → 复制形如 https://api.day.app/你的KEY/ 的地址。
   • 在这里 Webhook URL 填： https://api.day.app/你的KEY/
   • Webhook 类型选「Bark 推送」，系统会 POST：{ "title":"新订单提醒", "body":"..." }
④ 阿里云/腾讯云短信（按量付费，正式商用）
   • 在云函数写一个 HTTP 接口：接收本系统的 POST JSON，调用对应 SMS SDK 发送短信。
   • Webhook 类型选「通用/自建云函数」，系统会 POST：
     { "text": "...", "content": "...", "message": "..." }（三字段内容相同）

📱 新订单短信/推送内容示例（未设置模板，系统自动拼接）：
新订单 2000012345678 | 店铺:大江 | 金额:MXN 123.45 | 买家:PAULA_GONZALEZ
商品：
1. 商品标题A x1 (MXN 50.00)
![商品图](https://...jpg)
2. 商品标题B x2 (MXN 73.45)
![商品图](https://...jpg)

钉钉/企微会以 markdown 形式展示，图片会直接显示在消息里。`}
                  </div>
                </Collapse.Panel>
              </Collapse>
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="outline" icon={<RefreshIcon />} onClick={testSms} loading={testingSms} disabled={smsForm.provider === 'none'}>发送测试短信</Button>
            <div className="flex items-center gap-2">
              <Switch value={testWithLastOrder} onChange={(v: boolean) => setTestWithLastOrder(v)} size="small" />
              <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>用最近一条真实订单测试（带完整商品与图片，方便调试）</span>
            </div>
          </div>
        </Space>
      </Card>

      <div className="flex justify-end">
        <Button theme="primary" onClick={saveAll} loading={saving}>保存全部通知配置</Button>
      </div>

      <Card title="最近提醒记录" bordered>
        <Table
          data={pagedAlerts}
          columns={alertColumns}
          rowKey="orderId"
          size="small"
          disableDataPage
          pagination={{
            ...pageInfo,
            total: alerts.length,
            pageSizeOptions: [5, 10, 20, 50],
            showJumper: true,
          }}
          onPageChange={(info) => setPageInfo({ current: info.current, pageSize: info.pageSize })}
          empty="暂无提醒记录"
          loading={loading}
        />
      </Card>

      <Dialog
        visible={!!detailItem}
        onClose={() => setDetailItem(null)}
        header="提醒详情"
        footer={false}
        width="min(640px, 92vw)"
      >
        {detailItem && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div><b>店铺：</b>{detailItem.storeName}</div>
            <div><b>订单号：</b>{detailItem.orderId}</div>
            <div><b>金额：</b>{detailItem.total || '-'}</div>
            <div><b>时间：</b>{new Date(detailItem.at).toLocaleString()}</div>
            <div>
              <b>状态：</b>
              {detailItem.status === 'success' && <Tag theme="success" variant="light" size="small">成功</Tag>}
              {detailItem.status === 'failed' && <Tag theme="danger" variant="light" size="small">失败</Tag>}
              {detailItem.status === 'skipped' && <Tag theme="default" variant="light" size="small">未发送</Tag>}
            </div>
            <div>
              <b>实际发送内容：</b>
              <div style={{ background: 'var(--td-bg-color-component)', padding: 12, borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 8 }}>
                {detailItem.content || '（未生成内容）'}
              </div>
            </div>
            {detailItem.results && detailItem.results.length > 0 && (
              <div>
                <b>各渠道结果：</b>
                <div style={{ marginTop: 8 }}>
                  {detailItem.results.map((r: any, idx: number) => (
                    <div key={idx} style={{ marginBottom: 8, padding: 10, background: 'var(--td-bg-color-component)', borderRadius: 6 }}>
                      <Tag theme={r.success ? 'success' : 'danger'} variant="light" size="small">
                        {r.channel === 'email' ? '邮件' : r.channel === 'sms' ? '短信/Webhook' : r.channel}
                      </Tag>
                      <div style={{ marginTop: 4, fontSize: 12, color: r.success ? 'var(--td-success-color)' : 'var(--td-error-color)' }}>
                        {r.success ? '成功' : '失败'}：{r.message}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Space>
        )}
      </Dialog>

      <Dialog
        visible={previewVisible}
        onClose={() => setPreviewVisible(false)}
        header="通知内容预览"
        footer={false}
        width="min(680px, 92vw)"
      >
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 13, lineHeight: 1.7 }}>
          {emailPreview || smsPreview}
        </div>
        <div className="text-xs mt-3" style={{ color: 'var(--td-text-color-placeholder)' }}>
          上面是实际发送的内容（邮件为纯文本/HTML；钉钉/企微会以 markdown 渲染，图片会显示为图片；通用/短信为纯文本）。
        </div>
      </Dialog>
    </div>
  );
}

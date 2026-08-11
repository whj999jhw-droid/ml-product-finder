import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Button,
  Input,
  Select,
  Switch,
  Tag,
  Table,
  Dialog,
  MessagePlugin,
  Loading,
  Space,
} from 'tdesign-react';
import { ShopIcon, NotificationIcon, RefreshIcon, DeleteIcon, EditIcon } from 'tdesign-icons-react';
import { confirmDialog } from '../utils/dialog';

interface StoreRow {
  id: string;
  nickname: string;
  site: string;
  mlUserId?: string;
  mlUserNick?: string;
  mlUserEmail?: string;
  mlSeller?: boolean;
  lastOrderCheck?: string;
  enabled: boolean;
  createdAt: string;
}

interface AlertItem {
  storeId: string;
  storeName: string;
  orderId: string;
  at: string;
  channels: string[];
  total?: string;
}

interface CallbackStatus {
  mode: 'env' | 'fixed' | 'tunnel';
  uri: string;
  reachable: boolean;
  fixedDomain: string;
  notice: string;
  tunnelRunning: boolean;
  tunnelUrl: string;
}

export function StoreManagementPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newNick, setNewNick] = useState('');
  const [adding, setAdding] = useState(false);
  const [polling, setPolling] = useState(false);

  // OAuth 回调地址状态（自动探测固定域名 / 临时隧道回退）
  const [cb, setCb] = useState<CallbackStatus>({
    mode: 'fixed',
    uri: 'https://ml-callback.w999w.dpdns.org/api/ml/oauth/store-callback',
    reachable: false,
    fixedDomain: 'https://ml-callback.w999w.dpdns.org/api/ml/oauth/store-callback',
    notice: '',
    tunnelRunning: false,
    tunnelUrl: '',
  });
  const [testing, setTesting] = useState(false);
  const [beginMsg, setBeginMsg] = useState(''); // 弹窗第二阶段提示
  const [beginDone, setBeginDone] = useState(false); // 是否已生成授权链接
  const [beginUrl, setBeginUrl] = useState(''); // 生成的授权链接（用于手动点击打开）
  const [newSite, setNewSite] = useState('MLM'); // 新增店铺选择的站点

  // 通知配置
  const [notifyCfg, setNotifyCfg] = useState({ orderAlertsEnabled: false, emailEnabled: true, smsEnabled: false });
  const [smsCfg, setSmsCfg] = useState<any>({ provider: 'none' });
  const [smsForm, setSmsForm] = useState<any>({ provider: 'none' });
  const [savingNotify, setSavingNotify] = useState(false);

  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<StoreRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pollTimer = useRef<number | null>(null);

  const loadStores = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/stores');
      const d = await r.json();
      if (d.success) setStores(d.stores || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadNotify = useCallback(async () => {
    try {
      const n = await fetch('/api/ml/notify-config').then((r) => r.json());
      if (n.success) setNotifyCfg(n.config);
      const s = await fetch('/api/ml/sms-config').then((r) => r.json());
      if (s.success) {
        setSmsCfg(s.config);
        setSmsForm(s.config);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/orders/alerts');
      const d = await r.json();
      if (d.success) setAlerts(d.alerts || []);
    } catch {
      /* ignore */
    }
  }, []);

  const loadCallbackStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/oauth/callback-status');
      const d = await r.json();
      setCb({
        mode: d.mode || 'fixed',
        uri: d.uri || '',
        reachable: !!d.reachable,
        fixedDomain: d.fixedDomain || '',
        notice: d.notice || '',
        tunnelRunning: !!d.tunnelRunning,
        tunnelUrl: d.tunnelUrl || '',
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadStores();
    loadNotify();
    loadAlerts();
    loadCallbackStatus();
  }, [loadStores, loadNotify, loadAlerts, loadCallbackStatus]);

  // 添加店铺：后端已自动探测固定域名 / 回退隧道 → 返回授权 URL
  const handleAddStore = async () => {
    setAdding(true);
    setBeginMsg('');
    try {
      const r = await fetch('/api/ml/oauth/store-begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: newNick, site: newSite }),
      });
      const d = await r.json();
      if (!r.ok || !d.url) {
        MessagePlugin.error(d.error || '生成授权链接失败');
        if (d.detail) console.error('[store-begin]', d.detail);
        return;
      }
      setBeginUrl(d.url);
      // 同步回调地址状态
      setCb({
        mode: d.mode || 'fixed',
        uri: d.callbackUrl || '',
        reachable: !!d.reachable,
        fixedDomain: 'https://ml-callback.w999w.dpdns.org/api/ml/oauth/store-callback',
        notice: d.notice || '',
        tunnelRunning: d.mode === 'tunnel',
        tunnelUrl: d.tunnelUrl || '',
      });
      setBeginDone(true);
      // 固定域名 / 环境变量模式：无需隧道
      const isFixed = d.mode === 'fixed' || d.mode === 'env';
      setBeginMsg(
        isFixed
          ? '已使用固定回调域名，无需隧道。① 请确认下方「回调地址」已配置到美客多开发者后台（仅首次需配置）；② 点击下方按钮打开授权页。\n\n【授权说明】授权页会自动使用浏览器当前登录的美客多账号。如果账号不对，请直接在授权页点「取消」，然后在浏览器里退出当前账号、重新登录卖家账号，再回来重新点击「添加店铺」。授权成功后系统会自动检测该账号是否为卖家账号。'
          : (d.callbackUrl
            ? '① 请先把下方「回调地址」复制到美客多开发者后台（仅首次需配置）；② 点击下方按钮打开授权页，登录并点「同意」；③ 若跳到 localtunnel 的 "click to continue" 页面，点一下继续即可。\n\n【授权说明】授权页会自动使用浏览器当前登录的美客多账号。如果账号不对，请直接在授权页点「取消」，然后在浏览器里切换到卖家账号后重新授权。'
            : '已生成授权链接，点击下方按钮打开美客多授权页，登录并点「同意」即可。\n\n【授权说明】授权页会自动使用浏览器当前登录的美客多账号。如果账号不对，请直接在授权页点「取消」，然后在浏览器里切换到卖家账号后重新授权。')
      );
      // 先把授权页打开
      window.open(d.url, '_blank');
      MessagePlugin.info('已打开美客多授权页，请登录并点击「同意」，授权后会自动回到本页');
      // 轮询店铺列表，直到数量增加
      const before = stores.length;
      let tries = 0;
      if (pollTimer.current) window.clearInterval(pollTimer.current);
      pollTimer.current = window.setInterval(async () => {
        tries += 1;
        const now = await fetch('/api/ml/stores').then((x) => x.json());
        if (now.success && (now.stores || []).length > before) {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
          setAddOpen(false);
          setBeginDone(false);
          MessagePlugin.success('店铺已添加成功！');
          loadStores();
          loadCallbackStatus();
        }
        if (tries > 60) {
          if (pollTimer.current) window.clearInterval(pollTimer.current);
        }
      }, 2000);
    } catch (err: any) {
      MessagePlugin.error(err?.message || '添加失败');
    } finally {
      setAdding(false);
    }
  };

  // 重新测试固定域名可达性（启动 cloudflared 后点此恢复固定域名）
  const handleRetest = async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/ml/oauth/callback-test', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        setCb({
          mode: d.mode || 'fixed',
          uri: d.uri || '',
          reachable: !!d.reachable,
          fixedDomain: d.fixedDomain || '',
          notice: d.notice || '',
          tunnelRunning: !!d.tunnelRunning,
          tunnelUrl: d.tunnelUrl || '',
        });
        if (d.mode === 'fixed' || d.mode === 'env') {
          MessagePlugin.success('固定回调域名已恢复可用');
        } else {
          MessagePlugin.warning('固定域名仍不可达，继续使用临时隧道地址');
        }
      } else {
        MessagePlugin.error(d.message || '测试失败');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '测试失败');
    } finally {
      setTesting(false);
    }
  };

  // 手动启动 / 停止隧道（临时覆盖）
  const handleToggleTunnel = async () => {
    try {
      if (cb.tunnelRunning) {
        const confirmed = await confirmDialog({
          header: '关闭公网隧道',
          body: '确定关闭公网隧道吗？关闭后 OAuth 回调将使用固定/本地地址，远程设备可能无法完成授权回调。',
          confirmText: '关闭',
        });
        if (!confirmed) return;
        await fetch('/api/ml/oauth/tunnel', { method: 'DELETE' });
        MessagePlugin.info('隧道已关闭');
      } else {
        const r = await fetch('/api/ml/oauth/tunnel', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) {
          MessagePlugin.error(d.message || '隧道启动失败');
          return;
        }
        MessagePlugin.success('隧道已启动');
      }
      loadCallbackStatus();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '操作失败');
    }
  };

  const copyText = (text: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => MessagePlugin.success('已复制'),
      () => MessagePlugin.warning('复制失败，请手动选择')
    );
  };

  const handleToggleEnabled = async (store: StoreRow, val: boolean) => {
    await fetch(`/api/ml/stores/${store.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: val }),
    });
    loadStores();
  };

  // 删除店铺：用受控 Dialog 做确认闸门（tdesign 的 Dialog.confirm 返回的是节点而非 Promise，
  // 直接 await 会立即通过、确认框形同虚设）。这里点击删除只打开弹窗，真正删除在 onConfirm 内执行。
  const handleDelete = (store: StoreRow) => {
    setDeleteTarget(store);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    try {
      const r = await fetch(`/api/ml/stores/${target.id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({ success: false, message: '后端返回异常' }));
      if (d.success) {
        MessagePlugin.success(`已删除「${target.nickname}」`);
        loadStores();
      } else {
        MessagePlugin.error(d.message || '删除失败');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '删除失败');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleManualPoll = async () => {
    setPolling(true);
    try {
      const r = await fetch('/api/ml/orders/poll', { method: 'POST' });
      const d = await r.json();
      if (d.success) {
        const total = (d.report || []).reduce((s: number, x: any) => s + (x.newOrders || 0), 0);
        MessagePlugin.success(`轮询完成，本次新订单 ${total} 笔`);
        loadAlerts();
      } else {
        MessagePlugin.error(d.message || '轮询失败');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '轮询失败');
    } finally {
      setPolling(false);
    }
  };

  const saveNotify = async () => {
    setSavingNotify(true);
    try {
      await fetch('/api/ml/notify-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notifyCfg),
      });
      await fetch('/api/ml/sms-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(smsForm),
      });
      MessagePlugin.success('通知配置已保存');
      loadNotify();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '保存失败');
    } finally {
      setSavingNotify(false);
    }
  };

  const storeColumns = [
    { colKey: 'nickname', title: '店铺备注简称', width: 200 },
    { colKey: 'mlUserNick', title: '授权账号昵称', width: 160 },
    { colKey: 'mlUserEmail', title: '授权账号邮箱', width: 220 },
    {
      colKey: 'mlSeller',
      title: '卖家资质',
      width: 110,
      cell: ({ row }: any) =>
        row.mlSeller ? (
          <Tag theme="success" variant="light">已识别</Tag>
        ) : (
          <Tag theme="warning" variant="light" title="未检测到卖家声誉/销售权限，订单可能为空">未识别</Tag>
        ),
    },
    {
      colKey: 'enabled',
      title: '启用',
      width: 90,
      cell: ({ row }: any) => <Switch value={row.enabled} onChange={(v: boolean) => handleToggleEnabled(row, v)} />,
    },
    {
      colKey: 'lastOrderCheck',
      title: '上次检查',
      width: 180,
      cell: ({ row }: any) => (row.lastOrderCheck ? new Date(row.lastOrderCheck).toLocaleString() : '—'),
    },
    {
      colKey: 'op',
      title: '操作',
      width: 140,
      cell: ({ row }: any) => (
        <Space>
          <Button theme="danger" variant="text" icon={<DeleteIcon />} onClick={() => handleDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const alertColumns = [
    { colKey: 'storeName', title: '店铺', width: 140 },
    { colKey: 'orderId', title: '订单号', width: 140 },
    { colKey: 'total', title: '金额', width: 120 },
    { colKey: 'at', title: '时间', width: 180, cell: ({ row }: any) => new Date(row.at).toLocaleString() },
    { colKey: 'channels', title: '通知渠道', width: 200, cell: ({ row }: any) => (row.channels || []).join('; ') || '未发送' },
  ];

  const isFixed = cb.mode === 'fixed' || cb.mode === 'env';

  return (
    <div className="p-4 space-y-4" style={{ overflowY: 'auto', height: '100%' }}>
      <Card title={<span><ShopIcon /> 店铺管理（多店铺）</span>} bordered>
        <div className="mb-3 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
          点击「添加店铺」会跳转到美客多授权页，登录并同意后即把该账号的 token 安全地存到本工具（支持备注简称、可随时停用/删除）。
          一个 Mercado Libre 账号授权一次即可管理其所有站点订单；如需管理不同账号，可添加多个店铺。
        </div>
        <div className="mb-3">
          <Button theme="primary" onClick={() => setAddOpen(true)}>添加店铺</Button>
          <Button variant="outline" icon={<RefreshIcon />} onClick={handleManualPoll} loading={polling} style={{ marginLeft: 8 }}>
            立即拉取新订单
          </Button>
        </div>
        <Loading loading={loading}>
          <Table data={stores} columns={storeColumns} rowKey="id" size="small" pagination={{ pageSize: 20 }} empty="还没有店铺，点「添加店铺」开始" />
        </Loading>
      </Card>

      <Card title={<span><NotificationIcon /> 授权回调设置（OAuth 回调地址）</span>} bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Tag theme={isFixed ? 'success' : 'warning'} variant="light">
              {cb.mode === 'env' ? '环境变量固定域名' : cb.mode === 'fixed' ? '固定回调域名（可达）' : '临时隧道（回退）'}
            </Tag>
            <Tag theme={cb.reachable ? 'success' : 'danger'} variant="light">
              {cb.reachable ? '地址可达' : '地址不可达'}
            </Tag>
            <Button size="small" variant="outline" onClick={handleRetest} loading={testing}>
              重新测试回调地址
            </Button>
            <Button size="small" variant="text" onClick={loadCallbackStatus}>刷新状态</Button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm">回调地址：</span>
            <Input value={cb.uri} readonly style={{ width: 480 }} />
            <Button size="small" theme="default" variant="outline" onClick={() => copyText(cb.uri)}>复制</Button>
          </div>

          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {isFixed
              ? '已使用固定回调域名，地址永久不变。请把它粘贴到 美客多开发者后台 → 你的应用 → 重定向 URI（只需配置一次，之后添加店铺零操作）。'
              : '当前固定域名不可达，已自动回退到临时 localtunnel 地址（每次启动可能变化）。请把它粘贴到 美客多开发者后台 → 你的应用 → 重定向 URI，并启动 cloudflared 后点「重新测试回调地址」恢复固定域名。'}
          </div>

          {/* 不可达 / 隧道回退：醒目提示去美客多后台改重定向 URI */}
          {!isFixed && cb.notice && (
            <div className="p-3 rounded text-sm" style={{ backgroundColor: 'var(--td-warning-color-light)', color: 'var(--td-warning-color)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
              {cb.notice}
            </div>
          )}
          {isFixed && cb.mode === 'env' && (
            <div className="p-2 rounded text-xs" style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}>
              当前由环境变量 <code>ML_REDIRECT_URI</code> 指定固定回调域名，优先级最高；如需改用项目默认域名，可清除该变量并重启后端。
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button size="small" variant="outline" onClick={handleToggleTunnel}>
              {cb.tunnelRunning ? '停止隧道' : '手动启动隧道（临时）'}
            </Button>
            <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              固定域名 = https://ml-callback.w999w.dpdns.org/api/ml/oauth/store-callback（cloudflared 自定义域名）
            </span>
          </div>
        </Space>
      </Card>

      <Card title="新订单提醒日志" bordered>
        <Table data={alerts} columns={alertColumns} rowKey="orderId" size="small" pagination={{ pageSize: 20 }} empty="暂无提醒记录" />
      </Card>

      <Dialog
        header="添加店铺"
        visible={addOpen}
        onClose={() => {
          setAddOpen(false);
          setBeginDone(false);
          setBeginMsg('');
        }}
        onConfirm={handleAddStore}
        confirmBtn={beginDone ? null : { loading: adding, content: '生成授权链接并打开' }}
      >
        {!beginDone ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className="mb-1 text-sm">店铺备注简称（便于区分多个店）</div>
              <Input value={newNick} onChange={(v: string) => setNewNick(v)} placeholder="如：墨西哥主店" />
            </div>
            <div>
              <div className="mb-1 text-sm">站点 / 账号类型</div>
              <Select value={newSite} onChange={(v: any) => setNewSite(String(v))} style={{ width: '100%' }}>
                <Select.Option key="MLM" label="MLM - 墨西哥" value="MLM" />
                <Select.Option key="MLB" label="MLB - 巴西" value="MLB" />
                <Select.Option key="MLC" label="MLC - 智利" value="MLC" />
                <Select.Option key="MCO" label="MCO - 哥伦比亚" value="MCO" />
                <Select.Option key="CBT" label="CBT - Global Selling 跨境卖家" value="CBT" />
              </Select>
            </div>
            <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {isFixed
                ? '点击确认后会打开美客多授权页。系统会自动使用浏览器当前的美客多登录状态——如果已登录卖家账号，无需重新输入密码，直接点「同意」即可。首次使用需把下方生成的「回调地址」粘贴到美客多开发者后台（仅需一次）。'
                : '点击确认后会自动探测并打开美客多授权页。系统会自动使用浏览器当前的美客多登录状态——如果已登录卖家账号，无需重新输入密码，直接点「同意」即可。若固定域名不可达，会自动用临时隧道地址，首次使用需把生成的「回调地址」粘贴到美客多开发者后台（仅需一次）。'}
            </div>
            <div className="text-xs" style={{ color: 'var(--td-success-color)', marginTop: 4 }}>
              💡 提示：如果你的卖家账号是 <b>Global Selling / CBT 跨境账号</b>，请务必选择「CBT - Global Selling 跨境卖家」，否则美客多会提示「这是 Mercado Libre CBT 的数据」而无法登录。授权页会显示当前账号的昵称/邮箱，如果不对请点「取消」并切换账号。
            </div>
          </Space>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            <div className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>{beginMsg}</div>
            <div>
              <a href={beginUrl} target="_blank" rel="noopener" style={{ color: 'var(--td-brand-color)', fontWeight: 500 }}>
                👉 点击此处打开美客多授权页（若上方已自动弹出请忽略）
              </a>
            </div>
            {!isFixed && (
              <div className="p-3 rounded text-sm" style={{ backgroundColor: 'var(--td-warning-color-light)', color: 'var(--td-warning-color)', whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
                {cb.notice || '当前为临时 localtunnel 地址，重启或子域名被占时会变化。请在美客多后台把重定向 URI 改为上方「回调地址」，启动 cloudflared 后点「重新测试回调地址」即可恢复固定域名。'}
              </div>
            )}
            <div>
              <div className="mb-1 text-sm font-medium">回调地址（复制到美客多后台 → 应用 → 重定向 URI）</div>
              <Space>
                <Input value={cb.uri} readonly style={{ width: 440 }} />
                <Button theme="default" variant="outline" onClick={() => copyText(cb.uri)}>复制</Button>
              </Space>
            </div>
            <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              授权完成后本弹窗会自动关闭。若长时间未自动关闭，请确认已在美客多后台配置上面的回调地址并重新授权。
            </div>
          </Space>
        )}
      </Dialog>

      {/* 删除店铺确认弹窗（受控，点击「删除」才真正执行） */}
      <Dialog
        header="删除店铺"
        visible={!!deleteTarget}
        confirmBtn={{ content: '删除', theme: 'danger', loading: deleting }}
        cancelBtn="取消"
        onConfirm={confirmDelete}
        onClose={() => setDeleteTarget(null)}
      >
        <p>确定删除「{deleteTarget?.nickname}」？其 token 将被清除，且无法恢复。</p>
      </Dialog>
    </div>
  );
}

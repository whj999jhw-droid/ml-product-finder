import { useState, useEffect, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { Card, Tabs, Table, Tag, Dialog, Button, Loading, MessagePlugin, Space, Image } from 'tdesign-react';
import { ShopIcon, RefreshIcon, TranslateIcon } from 'tdesign-icons-react';

interface StoreRow {
  id: string;
  nickname: string;
  site: string;
  mlUserNick?: string;
  enabled: boolean;
}

interface StoreOrders {
  orders: any[];
  counts: { total: number; unshipped: number; shipped: number; cancelled: number };
  loading: boolean;
  loaded: boolean;
}

const STATUS_TEXT: Record<string, string> = {
  unshipped: '待发货',
  paid: '待发货',
  handling: '处理中',
  ready_to_ship: '待出库',
  ready_to_print: '待打印面单',
  shipped: '已发货',
  delivered: '已送达',
  closed: '已完成',
  cancelled: '已取消',
};

const SHIP_STATUS_TEXT: Record<string, string> = {
  ready_to_ship: '待出库',
  ready_to_print: '待打印面单',
  shipped: '已发货',
  delivered: '已送达',
  not_delivered: '未送达',
  closed: '已完成',
  cancelled: '已取消',
  handling: '处理中',
};

function fmtDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

function formatAddress(addr: any): string {
  if (!addr || typeof addr !== 'object') return '';
  // 标准 ML 站点格式
  if (addr.address_line) {
    return [addr.address_line, addr.city, addr.state, addr.country?.id || addr.country, addr.zip_code].filter(Boolean).join('，');
  }
  // CBT destination 格式
  const sa = addr.shipping_address;
  if (sa && typeof sa === 'object') {
    const line = sa.address_line || [sa.street_name, sa.street_number].filter(Boolean).join(' ');
    return [
      line,
      sa.neighborhood?.name,
      sa.city?.name,
      sa.state?.name,
      sa.country?.name || sa.country?.id,
      sa.zip_code,
    ].filter(Boolean).join('，');
  }
  return '';
}

function categoryOf(status: string): 'unshipped' | 'shipped' | 'cancelled' | 'other' {
  // 兼容后端返回的分类后状态（unshipped / shipped / cancelled）
  if (status === 'unshipped' || status === 'paid' || status === 'handling' || status === 'ready_to_ship') return 'unshipped';
  if (status === 'shipped' || status === 'delivered' || status === 'closed') return 'shipped';
  if (status === 'cancelled') return 'cancelled';
  return 'other';
}

export function OrdersPage() {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [activeStore, setActiveStore] = useState('');
  const [ordersMap, setOrdersMap] = useState<Record<string, StoreOrders>>({});
  const [activeTab, setActiveTab] = useState('unshipped');
  const [detail, setDetail] = useState<{ orderId: string; storeId: string; data?: any; shipments?: any[]; itemsDetail?: any[]; category?: 'unshipped' | 'shipped' | 'cancelled'; shippingAddress?: any; loading: boolean } | null>(null);
  const [ordersError, setOrdersError] = useState<Record<string, string>>({});
  const [translated, setTranslated] = useState<Record<string, string>>({});
  const [translating, setTranslating] = useState(false);
  const loadingStoresRef = useRef<Set<string>>(new Set());

  const loadStores = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/stores');
      const d = await r.json();
      if (d.success) {
        setStores(d.stores || []);
        if (!activeStore && (d.stores || []).length) setActiveStore((d.stores as StoreRow[])[0].id);
      }
    } catch {
      /* ignore */
    }
  }, [activeStore]);

  useEffect(() => {
    loadStores();
  }, [loadStores]);

  const loadOrders = useCallback(async (storeId: string) => {
    if (loadingStoresRef.current.has(storeId)) return;
    loadingStoresRef.current.add(storeId);
    setOrdersError((e) => ({ ...e, [storeId]: '' }));
    setOrdersMap((m) => ({ ...m, [storeId]: { ...(m[storeId] || { orders: [], counts: { total: 0, unshipped: 0, shipped: 0, cancelled: 0 } }), loading: true, loaded: false } }));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const r = await fetch(`/api/ml/stores/${storeId}/all-orders`, { signal: controller.signal });
      clearTimeout(timer);
      const d = await r.json();
      if (d.success) {
        setOrdersMap((m) => ({ ...m, [storeId]: { orders: d.orders || [], counts: d.counts || { total: 0, unshipped: 0, shipped: 0, cancelled: 0 }, loading: false, loaded: true } }));
      } else {
        const msg = d.message || '订单拉取失败';
        MessagePlugin.error(msg);
        setOrdersError((e) => ({ ...e, [storeId]: msg }));
        setOrdersMap((m) => ({ ...m, [storeId]: { ...(m[storeId] || { orders: [] } as any), loading: false, loaded: true } }));
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError' ? '请求超时（120秒），请重试' : (err?.message || '订单拉取失败');
      MessagePlugin.error(msg);
      setOrdersError((e) => ({ ...e, [storeId]: msg }));
      setOrdersMap((m) => ({ ...m, [storeId]: { ...(m[storeId] || { orders: [] } as any), loading: false, loaded: true } }));
    } finally {
      loadingStoresRef.current.delete(storeId);
    }
  }, []);

  // 切到某店铺时拉取其订单
  useEffect(() => {
    if (activeStore && !ordersMap[activeStore]?.loaded) {
      loadOrders(activeStore);
    }
  }, [activeStore, ordersMap, loadOrders]);

  const openDetail = useCallback(async (orderId: string, storeId: string) => {
    setDetail({ orderId, storeId, loading: true });
    setTranslated({});
    try {
      const r = await fetch(`/api/ml/orders/${orderId}/detail?storeId=${storeId}`);
      const d = await r.json();
      if (d.success) {
        setDetail({ orderId, storeId, data: d.order, shipments: d.shipments || [], itemsDetail: d.itemsDetail || d.order?.order_items || [], category: d.category, shippingAddress: d.shippingAddress, loading: false });
      } else {
        MessagePlugin.error(d.message || '详情获取失败');
        setDetail(null);
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '详情获取失败');
      setDetail(null);
    }
  }, []);

  const current = ordersMap[activeStore];
  const filtered = (current?.orders || []).filter((o) =>
    activeTab === 'all' ? true : categoryOf(o.mlStatus) === activeTab
  );
  const activeSite = stores.find((s) => s.id === activeStore)?.site || 'MLM';

  const orderColumns = [
    { colKey: 'id', title: '订单号', width: 160, cell: ({ row }: any) => <span className="font-mono">{row.id}</span> },
    { colKey: 'date_created', title: '下单时间', width: 170, cell: ({ row }: any) => fmtDate(row.date_created) },
    {
      colKey: 'buyer',
      title: '买家',
      width: 160,
      cell: ({ row }: any) => row.buyer?.nickname || row.buyer?.email || '—',
    },
    {
      colKey: 'items',
      title: '商品',
      width: 280,
      cell: ({ row }: any) => {
        const items: any[] = row.order_items || [];
        const first = items[0]?.item?.title || '—';
        const qty = items.reduce((s: number, i: any) => s + (i.quantity || 0), 0);
        return (
          <div className="truncate" title={first}>
            {first}
            {items.length > 1 ? ` 等${items.length}件` : ''}（共{qty}）
          </div>
        );
      },
    },
    {
      colKey: 'total',
      title: '金额',
      width: 130,
      cell: ({ row }: any) => `${row.currency_id || ''} ${(row.total_amount ?? 0).toFixed(2)}`,
    },
    {
      colKey: 'status',
      title: '状态',
      width: 110,
      cell: ({ row }: any) => {
        const cat = categoryOf(row.mlStatus);
        const theme = cat === 'unshipped' ? 'warning' : cat === 'shipped' ? 'success' : cat === 'cancelled' ? 'danger' : 'default';
        return <Tag theme={theme as any} variant="light">{STATUS_TEXT[row.mlStatus] || row.mlStatus}</Tag>;
      },
    },
  ];

  const detailItems = detail?.data;
  const ship = detailItems?.shipping || {};
  const addr = detail?.shippingAddress || ship.receiver_address || detailItems?.shipping_address || {};
  const items: any[] = detail?.itemsDetail || detailItems?.order_items || [];
  const payments: any[] = detailItems?.payments || [];

  const getText = (text?: string) => (text && translated[text] ? translated[text] : text);

  const handleTranslate = useCallback(async () => {
    if (!detailItems) return;
    const texts: string[] = [];
    for (const it of items) {
      if (it.item?.title) texts.push(it.item.title);
      if (it.item?.seller_custom_field) texts.push(it.item.seller_custom_field);
    }
    if (detailItems.buyer?.nickname) texts.push(detailItems.buyer.nickname);
    if (addr.comments) texts.push(addr.comments);
    if (addr.receiver_name) texts.push(addr.receiver_name);
    for (const sp of detail?.shipments || []) {
      if (sp.shipping_option?.name) texts.push(sp.shipping_option.name);
      if (sp.logistic_type) texts.push(sp.logistic_type);
      if (sp.tracking_method) texts.push(sp.tracking_method);
      if (sp.carrier?.name) texts.push(sp.carrier.name);
    }
    const unique = [...new Set(texts.filter(Boolean))];
    if (!unique.length) return;
    setTranslating(true);
    try {
      const r = await fetch('/api/ml/translate-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: unique, site: activeSite }),
      });
      const d = await r.json();
      if (d.success) {
        setTranslated(d.translations || {});
        MessagePlugin.success('翻译完成');
      } else {
        MessagePlugin.error(d.message || '翻译失败');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '翻译失败');
    } finally {
      setTranslating(false);
    }
  }, [detailItems, items, addr, detail?.shipments, activeSite]);

  return (
    <div className="p-4 space-y-4" style={{ overflowY: 'auto', height: '100%' }}>
      <Card title={<span><ShopIcon /> 订单管理（每店铺独立）</span>} bordered>
        {stores.length === 0 ? (
          <div className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            还没有授权任何店铺。请先到「店铺管理」添加并授权店铺，授权后即可在此查看各店订单。
          </div>
        ) : (
          <Tabs value={activeStore} onChange={(v: string) => setActiveStore(v)}>
            {stores.map((s) => (
              <Tabs.TabPanel key={s.id} value={s.id} label={s.nickname || s.mlUserNick || '未命名店铺'}>
                <div className="mt-3">
                  <Space className="mb-3">
                    <Button size="small" variant="outline" icon={<RefreshIcon />} loading={ordersMap[s.id]?.loading} onClick={() => loadOrders(s.id)}>
                      刷新订单
                    </Button>
                    <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      共 {ordersMap[s.id]?.counts.total || 0} 单 · 未发货 {ordersMap[s.id]?.counts.unshipped || 0} · 已发货 {ordersMap[s.id]?.counts.shipped || 0} · 已取消 {ordersMap[s.id]?.counts.cancelled || 0}
                    </span>
                  </Space>

                  {ordersError[s.id] && (
                    <div
                      className="text-xs p-2 rounded mb-3"
                      style={{ background: 'var(--td-error-color-light)', color: 'var(--td-error-color)' }}
                    >
                      拉取失败：{ordersError[s.id]}
                    </div>
                  )}

                  {ordersMap[s.id]?.loading && (
                    <div
                      className="text-xs p-2 rounded mb-3"
                      style={{ background: 'var(--td-info-color-light)', color: 'var(--td-info-color)' }}
                    >
                      正在拉取全部订单，CBT 跨境账号首次加载约 10~30 秒，请稍候……
                    </div>
                  )}
                  {!ordersError[s.id] && !ordersMap[s.id]?.loading && ordersMap[s.id]?.loaded && (ordersMap[s.id]?.counts.total || 0) === 0 && (
                    <div
                      className="text-xs p-2 rounded mb-3"
                      style={{ background: 'var(--td-success-color-light)', color: 'var(--td-success-color)' }}
                    >
                      ✓ 订单已拉取成功，该账号当前没有「已付款 / 已取消」订单。若预期有订单，请确认：① 授权的是卖家账号；② 账号已有真实成交；③ CBT 跨境账号订单会自动走专用接口查。
                    </div>
                  )}

                  <Tabs value={activeTab} onChange={(v: string) => setActiveTab(v)}>
                    <Tabs.TabPanel value="unshipped" label={`未发货 (${ordersMap[s.id]?.counts.unshipped || 0})`}>
                      <OrderTable rows={filtered} loading={!!ordersMap[s.id]?.loading} onOpen={(id) => openDetail(id, s.id)} columns={orderColumns} />
                    </Tabs.TabPanel>
                    <Tabs.TabPanel value="shipped" label={`已发货 (${ordersMap[s.id]?.counts.shipped || 0})`}>
                      <OrderTable rows={filtered} loading={!!ordersMap[s.id]?.loading} onOpen={(id) => openDetail(id, s.id)} columns={orderColumns} />
                    </Tabs.TabPanel>
                    <Tabs.TabPanel value="cancelled" label={`已取消 (${ordersMap[s.id]?.counts.cancelled || 0})`}>
                      <OrderTable rows={filtered} loading={!!ordersMap[s.id]?.loading} onOpen={(id) => openDetail(id, s.id)} columns={orderColumns} />
                    </Tabs.TabPanel>
                    <Tabs.TabPanel value="all" label={`全部 (${ordersMap[s.id]?.counts.total || 0})`}>
                      <OrderTable rows={filtered} loading={!!ordersMap[s.id]?.loading} onOpen={(id) => openDetail(id, s.id)} columns={orderColumns} />
                    </Tabs.TabPanel>
                  </Tabs>
                </div>
              </Tabs.TabPanel>
            ))}
          </Tabs>
        )}
      </Card>

      {/* 订单详情弹窗 */}
      <Dialog
        header={
          <div className="flex items-center justify-between" style={{ width: '100%' }}>
            <span>订单详情</span>
            <Button
              size="small"
              variant="outline"
              icon={<TranslateIcon />}
              loading={translating}
              onClick={handleTranslate}
            >
              翻译
            </Button>
          </div>
        }
        visible={!!detail}
        onClose={() => setDetail(null)}
        footer={false}
        width={780}
      >
        {detail?.loading && <Loading loading text="加载中..." />}
        {detail && !detail.loading && detailItems && (
          <div className="space-y-4 text-sm">
            <Section title="基本信息">
              <div className="grid grid-cols-2 gap-x-4">
                <KV k="订单号" v={String(detailItems.id)} />
                <KV k="状态" v={STATUS_TEXT[detail?.category || detailItems.status] || detail?.category || detailItems.status} />
                <KV k="下单时间" v={fmtDate(detailItems.date_created)} />
                <KV k="关闭/发货时间" v={fmtDate(detailItems.date_closed || detailItems.date_last_updated)} />
                <KV k="订单总额" v={`${detailItems.currency_id || ''} ${(detailItems.total_amount ?? 0).toFixed(2)}`} />
                <KV k="买家已付" v={`${detailItems.currency_id || ''} ${(detailItems.paid_amount ?? 0).toFixed(2)}`} />
              </div>
            </Section>

            <Section title="买家">
              <KV k="昵称" v={getText(detailItems.buyer?.nickname) || '—'} />
              <KV k="姓名" v={[detailItems.buyer?.first_name, detailItems.buyer?.last_name].filter(Boolean).join(' ') || '—'} />
              <KV k="邮箱" v={detailItems.buyer?.email || '—'} />
              <KV k="电话" v={detailItems.buyer?.phone ? `${detailItems.buyer.phone.area_code || ''} ${detailItems.buyer.phone.number || ''}` : '—'} />
            </Section>

            <Section title="收货地址">
              <KV k="收货人" v={getText(addr.receiver_name || addr.receiver?.name) || '—'} />
              <KV k="电话" v={addr.receiver_phone ? String(addr.receiver_phone) : '—'} />
              <KV k="地址" v={formatAddress(addr) || '—'} />
              <KV k="备注" v={getText(addr.comments || addr.shipping_address?.comment) || '—'} />
            </Section>

            <Section title={`商品明细（共${items.length}项）`}>
              <Table
                data={items}
                columns={[
                  {
                    colKey: 'image',
                    title: '图片',
                    width: 70,
                    cell: ({ row }: any) =>
                      row.itemThumbnail || row.item?.thumbnail ? (
                        <Image
                          src={row.itemThumbnail || row.item?.thumbnail}
                          style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4 }}
                          fit="cover"
                          alt=""
                        />
                      ) : (
                        <div
                          style={{
                            width: 48,
                            height: 48,
                            borderRadius: 4,
                            background: 'var(--td-bg-color-component)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--td-text-color-placeholder)',
                            fontSize: 12,
                          }}
                        >
                          无图
                        </div>
                      ),
                  },
                  {
                    colKey: 'title',
                    title: '商品',
                    cell: ({ row }: any) => (
                      <div>
                        <div>{getText(row.item?.title) || row.item?.title || '—'}</div>
                        {row.item?.seller_custom_field && (
                          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                            SKU: {getText(row.item.seller_custom_field) || row.item.seller_custom_field}
                          </div>
                        )}
                      </div>
                    ),
                  },
                  { colKey: 'qty', title: '数量', width: 70, cell: ({ row }: any) => row.quantity },
                  { colKey: 'price', title: '单价', width: 110, cell: ({ row }: any) => `${detailItems.currency_id || ''} ${(row.unit_price ?? 0).toFixed(2)}` },
                  { colKey: 'fee', title: '销售费', width: 100, cell: ({ row }: any) => `${detailItems.currency_id || ''} ${(row.sale_fee ?? 0).toFixed(2)}` },
                ]}
                rowKey="item.id"
                size="small"
                pagination={items.length > 8 ? { pageSize: 8 } : undefined}
              />
            </Section>

            <Section title="支付与到手金额">
              {payments.length ? (
                <>
                  <Table
                    data={payments}
                    columns={[
                      { colKey: 'status', title: '状态', width: 90, cell: ({ row }: any) => row.status },
                      { colKey: 'method', title: '方式', width: 120, cell: ({ row }: any) => row.payment_method_id || '—' },
                      { colKey: 'amount', title: '交易金额', width: 120, cell: ({ row }: any) => `${(row.transaction_amount ?? 0).toFixed(2)}` },
                      { colKey: 'paid', title: '实付金额', width: 120, cell: ({ row }: any) => `${(row.total_paid_amount ?? 0).toFixed(2)}` },
                      { colKey: 'fee', title: '平台佣金', width: 120, cell: ({ row }: any) => `${(row.marketplace_fee ?? 0).toFixed(2)}` },
                      { colKey: 'tax', title: '税费', width: 100, cell: ({ row }: any) => `${(row.taxes_amount ?? 0).toFixed(2)}` },
                      { colKey: 'ship', title: '运费', width: 100, cell: ({ row }: any) => `${(row.shipping_cost ?? 0).toFixed(2)}` },
                    ]}
                    rowKey="id"
                    size="small"
                  />
                  <div className="mt-2 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    注：CBT 跨境订单可能包含多币种/分期信息，「实得金额」以 Mercado Libre 后台结算为准。
                  </div>
                </>
              ) : (
                <span style={{ color: 'var(--td-text-color-placeholder)' }}>无支付明细</span>
              )}
            </Section>

            <Section title="物流">
              {detail.shipments && detail.shipments.length ? (
                detail.shipments.map((sp: any, i: number) => (
                  <div key={i} className="mb-3 p-2 rounded" style={{ background: 'var(--td-bg-color-component)' }}>
                    <div className="grid grid-cols-2 gap-x-4">
                      <KV k="物流公司" v={sp.carrier?.name || sp.tracking_method || sp.logistic_type || '—'} />
                      <KV k="物流方式" v={getText(sp.shipping_option?.name) || sp.shipping_option?.name || '—'} />
                      <KV k="物流单号" v={sp.tracking_number || '—'} />
                      <KV k="物流状态" v={SHIP_STATUS_TEXT[sp.status] || sp.status || sp.shipping_status || '—'} />
                      <KV k="发货时间" v={fmtDate(sp.date_created || sp.ship_date)} />
                      <KV k="预计送达" v={fmtDate(sp.estimated_delivery_time?.date || sp.estimated_delivery_limit?.date)} />
                      <KV k="最后更新" v={fmtDate(sp.last_updated)} />
                      <KV
                        k="查询链接"
                        v={
                          sp.tracking_number ? (
                            <a
                              href={`https://www.mercadolibre.com/track/${sp.tracking_number}`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: 'var(--td-brand-color)' }}
                            >
                              点击查询
                            </a>
                          ) : (
                            '—'
                          )
                        }
                      />
                    </div>
                  </div>
                ))
              ) : (
                <span style={{ color: 'var(--td-text-color-placeholder)' }}>无物流信息（未发货或暂不可用）</span>
              )}
            </Section>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function OrderTable({ rows, loading, onOpen, columns }: { rows: any[]; loading: boolean; onOpen: (id: string) => void; columns: any[] }) {
  return (
    <Loading loading={loading}>
      <Table
        data={rows}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={rows.length > 15 ? { pageSize: 15 } : undefined}
        onRowClick={(ctx: any) => onOpen(String(ctx.row.id))}
        empty="该分类下暂无订单"
      />
    </Loading>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-medium mb-1" style={{ color: 'var(--td-brand-color)' }}>{title}</div>
      <div className="pl-1">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span style={{ color: 'var(--td-text-color-placeholder)', minWidth: 72 }}>{k}：</span>
      <span style={{ color: 'var(--td-text-color-primary)' }}>{v ?? '—'}</span>
    </div>
  );
}

/**
 * src/pages/MiaoshouBoxPage.tsx
 * 妙手采集箱页面
 * 读取妙手美客多采集箱的「未发布」商品，表格展示，可多选预览，
 * 一键发布到选定店铺的选定站点（CBT 全球售）
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Divider,
  Drawer,
  Image,
  Input,
  Loading,
  MessagePlugin,
  Pagination,
  Space,
  Table,
  Tag,
} from 'tdesign-react';
import type { PrimaryTableCol } from 'tdesign-react';
import { FeatureIntro } from '../components/FeatureIntro';
import { Inbox, RefreshCw } from 'lucide-react';

// ============ 类型定义 ============

interface MiaoshouBoxItem {
  collectBoxDetailId: string;
  itemNum: string | null;
  breadcrumb: string;
  cid: string;
  globalPrice: string;
  stock: string;
  price: string;
  thumbnail: string;
  gmtCreate: string;
  title: string;
  platform: string;
  appAccountId: string;
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    siteAndMaxPriceMap: Record<string, string>;
    siteAndMinPriceMap: Record<string, string>;
    siteAndPriceMap: Record<string, string>;
    sites: string[];
  };
  sourceList?: Array<{ source: string; sourceItemId: string; sourceItemUrl: string }>;
}

interface MiaoshouBoxDetail {
  title: string;
  itemNum: string | null;
  notesFull: string;
  notes: string;
  price: string;
  globalPrice: string;
  originPrice: string;
  cid: string;
  cateList: string[];
  breadcrumb: string;
  sourceImgUrls: string[];
  videoUrl?: string;
  mainImgVideoUrl?: string;
  source: string;
  sourceItemId: string;
  sourceItemUrl: string;
  skuMap?: Record<string, any>;
  attributes?: Array<{ name: string; valueType: string; values: string[] }>;
  siteAndListingTypeList?: string[];
  siteAndTitleList?: string[];
  pricingMode: string;
  siteAndPriceMap?: Record<string, string>;
  collectBoxDetailShop: {
    shopId: string;
    pricingMode: string;
    sites: string[];
    siteAndPriceMap: Record<string, string>;
  };
}

interface Store {
  id: string;
  nickname: string;
  site: string;
  authorized: boolean;
  enabled: boolean;
}

interface PublishTarget {
  storeId: string;
  sites: string[];
}

const SITE_OPTIONS = [
  { label: '🇲🇽 墨西哥 MLM', value: 'MLM' },
  { label: '🇧🇷 巴西 MLB', value: 'MLB' },
  { label: '🇨🇱 智利 MLC', value: 'MLC' },
  { label: '🇨🇴 哥伦比亚 MCO', value: 'MCO' },
];

const SITE_LABEL: Record<string, string> = {
  MLM: '🇲🇽 墨西哥',
  MLB: '🇧🇷 巴西',
  MLC: '🇨🇱 智利',
  MCO: '🇨🇴 哥伦比亚',
};

// ============ 主组件 ============

export function MiaoshouBoxPage() {
  // 数据状态
  const [items, setItems] = useState<MiaoshouBoxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // 分页
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // 搜索过滤
  const [searchKw, setSearchKw] = useState('');
  const [filteredItems, setFilteredItems] = useState<MiaoshouBoxItem[]>([]);

  // 多选
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionLoading, setSelectionLoading] = useState(false);

  // 店铺列表
  const [stores, setStores] = useState<Store[]>([]);

  // 详情抽屉
  const [detailItem, setDetailItem] = useState<MiaoshouBoxItem | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailData, setDetailData] = useState<MiaoshouBoxDetail | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);

  // 发布弹窗
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishResults, setPublishResults] = useState<any[]>([]);
  const [publishDone, setPublishDone] = useState(false);

  // 每行的发布目标（storeId → sites[]）
  const [targets, setTargets] = useState<Record<string, PublishTarget>>({});

  // ============ 加载采集箱列表 ============

  const loadBox = useCallback(async (force = false, keepPage = false) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: 'notPublished', filterCidSite: 'CBT' });
      if (force) params.set('refresh', '1');
      params.set('pageSize', '2000'); // 一次拉完，后端分页
      const resp = await fetch(`/api/ml/miaoshou/box?${params}`);
      const json = await resp.json();
      if (!json.success) throw new Error(json.message || '加载失败');
      setItems(json.items || []);
      setTotal(json.total || json.items?.length || 0);
      if (!keepPage) setCurrent(1); // 刷新本页时保持当前页码，其余回第1页
    } catch (e: any) {
      MessagePlugin.error(e.message || '加载采集箱失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 加载店铺列表
  const loadStores = useCallback(async () => {
    try {
      const resp = await fetch('/api/ml/stores');
      const json = await resp.json();
      if (json.success) {
        setStores(json.stores.filter((s: Store) => s.authorized && s.enabled));
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadBox();
    loadStores();
  }, [loadBox, loadStores]);

  // 搜索过滤（分页前过滤全部）
  useEffect(() => {
    if (!searchKw.trim()) {
      setFilteredItems(items);
    } else {
      const kw = searchKw.toLowerCase();
      setFilteredItems(
        items.filter(
          (it) =>
            it.title.toLowerCase().includes(kw) ||
            it.breadcrumb.toLowerCase().includes(kw) ||
            it.collectBoxDetailId.includes(kw)
        )
      );
    }
    setCurrent(1); // 搜索后回第1页
  }, [searchKw, items]);

  // 当前页数据
  const pagedItems = filteredItems.slice((current - 1) * pageSize, current * pageSize);

  // ============ 打开商品详情 ============

  const handlePreview = useCallback(async (item: MiaoshouBoxItem) => {
    setDetailItem(item);
    setDetailDrawerOpen(true);
    setDetailLoading(true);
    setDetailData(null);
    try {
      const resp = await fetch(
        `/api/ml/miaoshou/box/${item.collectBoxDetailId}/detail?shopId=${item.collectBoxDetailShop.shopId}&cid=${item.cid}`
      );
      const json = await resp.json();
      if (!json.success) throw new Error(json.message);
      setDetailData(json.detail);
    } catch (e: any) {
      MessagePlugin.error('加载详情失败: ' + (e.message || ''));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // ============ 全选 / 取消全选 ============

  const allChecked = filteredItems.length > 0 && selected.size === filteredItems.length;
  const someChecked = selected.size > 0 && selected.size < filteredItems.length;

  const toggleAll = () => {
    if (allChecked) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredItems.map((it) => it.collectBoxDetailId)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  // ============ 初始化 targets（默认每个店铺全站点）============

  const initTargetsForItem = (item: MiaoshouBoxItem) => {
    const newTargets: Record<string, PublishTarget> = {};
    // 妙手配置的站点
    const shopSites: string[] = item.collectBoxDetailShop?.sites || [];
    // 映射：MX(Up) → MLM, BR(Up) → MLB ...
    const siteMap: Record<string, string> = {
      'MX(Up)': 'MLM',
      'BR(Up)': 'MLB',
      'CL(Up)': 'MLC',
      'CO(Up)': 'MCO',
    };
    const availableSites = shopSites
      .map((s) => siteMap[s] || s)
      .filter((s) => ['MLM', 'MLB', 'MLC', 'MCO'].includes(s));

    stores.forEach((store) => {
      // CBT 店铺可发任意站点：默认勾商品妙手配置的站点；未配置则全选 4 站
      const initSites =
        availableSites.length > 0 ? [...availableSites] : SITE_OPTIONS.map((o) => o.value);
      newTargets[store.id] = { storeId: store.id, sites: initSites };
    });
    return newTargets;
  };

  // 打开发布弹窗前，对所有选中商品初始化 targets
  const handleOpenPublish = () => {
    if (selected.size === 0) {
      MessagePlugin.warning('请先勾选要发布的商品');
      return;
    }
    // 以第一件的店铺配置初始化所有选中商品的 targets
    const firstItem = items.find((it) => selected.has(it.collectBoxDetailId));
    if (firstItem) {
      setTargets(initTargetsForItem(firstItem));
    }
    setPublishDone(false);
    setPublishResults([]);
    setPublishOpen(true);
  };

  // 切换某店铺的某个站点
  const toggleSite = (storeId: string, site: string) => {
    setTargets((prev) => {
      const t = prev[storeId] || { storeId, sites: [] };
      const sites = t.sites.includes(site)
        ? t.sites.filter((s) => s !== site)
        : [...t.sites, site];
      return { ...prev, [storeId]: { storeId, sites } };
    });
  };

  // 全选 / 取消某店铺所有站点
  const toggleAllSitesForStore = (storeId: string) => {
    const allSites = SITE_OPTIONS.map((o) => o.value);
    const current = targets[storeId]?.sites || [];
    const next = current.length === allSites.length ? [] : allSites;
    setTargets((prev) => ({ ...prev, [storeId]: { storeId, sites: next } }));
  };

  // ============ 执行发布 ============

  const handlePublish = async () => {
    const validTargets = Object.values(targets)
      .filter((t) => t.sites.length > 0)
      .map((t) => ({ storeId: t.storeId, sites: t.sites }));

    if (validTargets.length === 0) {
      MessagePlugin.warning('请至少选择一个店铺+站点的发布目标');
      return;
    }

    const selectedItems = items.filter((it) => selected.has(it.collectBoxDetailId));
    const payload = {
      items: selectedItems.map((it) => ({
        detailId: it.collectBoxDetailId,
        shopId: it.collectBoxDetailShop.shopId,
        cid: it.cid,
      })),
      targets: validTargets,
    };

    setPublishLoading(true);
    try {
      const resp = await fetch('/api/ml/miaoshou/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      if (!json.success && json.successCount === 0) {
        throw new Error(json.message || '发布失败');
      }
      setPublishResults(json.results || []);
      setPublishDone(true);
      const ok = json.successCount || 0;
      const fail = json.failCount || 0;
      MessagePlugin.success(`发布完成：成功 ${ok}，失败 ${fail}`);
    } catch (e: any) {
      MessagePlugin.error('发布失败: ' + (e.message || ''));
    } finally {
      setPublishLoading(false);
    }
  };

  // ============ 表格列定义 ============

  const columns: PrimaryTableCol<MiaoshouBoxItem>[] = [
    {
      colKey: 'row-select',
      title: (
        <Checkbox
          checked={allChecked}
          indeterminate={someChecked}
          onChange={toggleAll}
        />
      ),
      width: 48,
    },
    {
      colKey: 'thumbnail',
      title: '图片',
      width: 80,
      cell({ row }) {
        return (
          <Image
            src={row.thumbnail}
            style={{ width: 60, height: 60, objectFit: 'cover', borderRadius: 4 }}
            fit="cover"
            referrerPolicy="no-referrer"
          />
        );
      },
    },
    {
      colKey: 'title',
      title: '商品标题',
      ellipsis: { showTooltip: true },
      cell({ row }) {
        return (
          <div>
            <div className="font-medium text-sm">{row.title}</div>
            <div className="text-xs text-gray-500 mt-0.5">{row.breadcrumb}</div>
          </div>
        );
      },
    },
    {
      colKey: 'price',
      title: '全球净收益(USD)',
      width: 130,
      cell({ row }) {
        const p = parseFloat(row.globalPrice || row.price || '0');
        return (
          <span className="font-semibold text-orange-600">
            ${p.toFixed(2)}
          </span>
        );
      },
    },
    {
      colKey: 'stock',
      title: '库存',
      width: 70,
      cell({ row }) {
        return <Tag>{row.stock || '-'}</Tag>;
      },
    },
    {
      colKey: 'sites',
      title: '目标站点',
      width: 160,
      cell({ row }) {
        const shopSites: string[] = row.collectBoxDetailShop?.sites || [];
        const siteMap: Record<string, string> = {
          'MX(Up)': 'MLM',
          'BR(Up)': 'MLB',
          'CL(Up)': 'MLC',
          'CO(Up)': 'MCO',
        };
        return (
          <Space size={4}>
            {shopSites.map((s) => (
              <Tag key={s} theme="primary" variant="outline">
                {SITE_LABEL[siteMap[s] || s] || s}
              </Tag>
            ))}
            {shopSites.length === 0 && <span className="text-gray-400 text-xs">未配置</span>}
          </Space>
        );
      },
    },
    {
      colKey: 'gmtCreate',
      title: '采集时间',
      width: 140,
      cell({ row }) {
        const d = new Date(row.gmtCreate);
        return (
          <span className="text-xs text-gray-500">
            {d.toLocaleString('zh-CN')}
          </span>
        );
      },
    },
    {
      colKey: 'action',
      title: '操作',
      width: 80,
      fixed: 'right',
      cell({ row }) {
        return (
          <Button size="small" variant="text" onClick={() => handlePreview(row)}>
            预览
          </Button>
        );
      },
    },
  ];

  // ============ 渲染 ============

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 顶部功能说明 */}
      <FeatureIntro
        icon={<Inbox size={20} />}
        title="妙手采集箱"
        defaultCollapsed
        content={
          <div className="text-sm leading-relaxed space-y-1">
            <p>
              从妙手 ERP 美客多「采集箱-未发布」列表拉取商品，在本系统预览、勾选后，
              通过您自己的 <strong>Mercado Libre CBT 官方通道</strong>直接上架到选定店铺，
              <strong>彻底绕开妙手共享 App 的 429 限流</strong>。
            </p>
            <ul className="list-disc list-inside space-y-0.5 text-gray-600">
              <li>数据来源：妙手采集箱（状态=未发布，站点类型=CBT）</li>
              <li>发布通道：美客多 CBT 全球售 <code>POST /global/items</code></li>
              <li>价格单位：USD（全球净收益 globalPrice）</li>
              <li>发布间隔：每商品 1 秒节流，避免触发平台限流</li>
            </ul>
          </div>
        }
      />

      {/* 操作栏 */}
      <div className="flex items-center gap-3 px-5 py-3 flex-shrink-0">
        <Button
          icon={<Inbox size={16} />}
          onClick={() => loadBox(true)}
          loading={loading}
        >
          刷新列表
        </Button>
        <Button
          icon={<RefreshCw size={16} />}
          onClick={() => loadBox(true, true)}
          loading={loading}
          variant="outline"
        >
          刷新本页
        </Button>
        <Input
          placeholder="搜索标题 / 类目 / ID..."
          value={searchKw}
          onChange={(v) => setSearchKw(String(v))}
          style={{ width: 240 }}
          clearable
        />
        <span className="text-sm text-gray-500 ml-auto">
          共 {total} 件（搜索命中 {filteredItems.length} 件）
          {selected.size > 0 && (
            <span className="ml-2 text-blue-600 font-medium">已选 {selected.size} 件</span>
          )}
        </span>
        <Button
          theme="primary"
          disabled={selected.size === 0}
          onClick={handleOpenPublish}
        >
          一键发布({selected.size})
        </Button>
      </div>

      {/* 表格 */}
      <div className="flex-1 overflow-auto px-5 pb-3">
        <Table
          data={pagedItems}
          columns={columns}
          rowKey="collectBoxDetailId"
          loading={loading}
          hover
          stripe
          bordered
          selectedRowKeys={[...selected]}
          onSelectChange={(value) => setSelected(new Set(value as string[]))}
        />
        {/* 分页 */}
        {filteredItems.length > 0 && (
          <div className="flex justify-end mt-3">
            <Pagination
              current={current}
              pageSize={pageSize}
              total={filteredItems.length}
              showJumper
              pageSizeOptions={[20, 50, 100, 200]}
              onChange={({ current: c }) => setCurrent(c)}
              onPageSizeChange={(size) => {
                // 换每页数量后，尽量停留在原数据位置附近
                const firstItem = (current - 1) * pageSize;
                setPageSize(size);
                setCurrent(Math.floor(firstItem / size) + 1);
              }}
            />
          </div>
        )}
      </div>

      {/* 商品详情抽屉 */}
      <Drawer
        header="商品详情预览"
        visible={detailDrawerOpen}
        onClose={() => setDetailDrawerOpen(false)}
        size="640px"
        footer={null}
      >
        {detailLoading ? (
          <div className="flex justify-center py-20">
            <Loading />
          </div>
        ) : detailData ? (
          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <Image
                src={detailData.sourceImgUrls?.[0] || detailItem?.thumbnail || ''}
                style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }}
                fit="cover"
                referrerPolicy="no-referrer"
              />
              <div className="flex-1">
                <div className="font-semibold text-base">{detailData.title}</div>
                <div className="text-sm text-gray-500 mt-1">{detailData.breadcrumb}</div>
                <div className="flex gap-3 mt-2">
                  <Tag theme="success">净收益 ${parseFloat(detailData.globalPrice || '0').toFixed(2)}</Tag>
                  <Tag theme="warning">货源价 ¥{detailData.price}</Tag>
                  <Tag>库存 {detailData.stock || '-'}</Tag>
                </div>
              </div>
            </div>

            {detailData.sourceImgUrls && detailData.sourceImgUrls.length > 1 && (
              <div>
                <div className="text-sm font-medium mb-2">货源图片（共 {detailData.sourceImgUrls.length} 张）</div>
                <div className="flex gap-2 flex-wrap">
                  {detailData.sourceImgUrls.slice(0, 9).map((url, i) => (
                    <Image
                      key={i}
                      src={url}
                      style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 4 }}
                      fit="cover"
                      referrerPolicy="no-referrer"
                    />
                  ))}
                </div>
              </div>
            )}

            {detailData.notesFull && (
              <div>
                <div className="text-sm font-medium mb-1">完整描述</div>
                <div
                  className="text-sm text-gray-600 p-3 rounded bg-gray-50"
                  style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}
                >
                  {detailData.notesFull}
                </div>
              </div>
            )}

            {/* SKU 明细：尺寸/重量/库存（妙手编辑过的数据，发布时原样传美客多 PACKAGE_* 属性） */}
            {(() => {
              const skuEntries = Object.entries(detailData.skuMap || {}).filter(
                ([, v]: any) => !v.isDelete
              );
              if (skuEntries.length === 0) return null;
              return (
                <div>
                  <div className="text-sm font-medium mb-2">
                    SKU 明细（{skuEntries.length} 个，发布时尺寸/重量写入包裹属性）
                  </div>
                  <div className="space-y-2">
                    {skuEntries.map(([k, v]: any, i: number) => (
                      <div key={k} className="p-2 bg-gray-50 rounded text-xs space-y-1">
                        <div className="flex items-center gap-2">
                          {v.imgUrls?.[0] && (
                            <Image
                              src={v.imgUrls[0]}
                              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 3 }}
                              fit="cover"
                              referrerPolicy="no-referrer"
                            />
                          )}
                          <span className="font-medium">{v.itemNum || `SKU ${i + 1}`}</span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-600">
                          <span>库存：{v.stock ?? '-'}</span>
                          <span>货源价：{v.originPrice != null ? `¥${v.originPrice}` : '-'}</span>
                          <span>
                            尺寸：{[v.length, v.width, v.height].filter(Boolean).join('×') || '-'}
                            {v.lengthWidthHeightUnit ? ` ${v.lengthWidthHeightUnit}` : ''}
                          </span>
                          <span>
                            重量：{v.weight || '-'}
                            {v.weightUnit ? ` ${v.weightUnit}` : ''}
                          </span>
                          {v.upc && <span>UPC：{v.upc}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {detailData.sourceItemUrl && (
              <div>
                <div className="text-sm font-medium mb-1">货源链接</div>
                <a
                  href={detailData.sourceItemUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 underline break-all"
                >
                  {detailData.sourceItemUrl}
                </a>
              </div>
            )}

            {detailData.siteAndPriceMap && Object.keys(detailData.siteAndPriceMap).length > 0 && (
              <div>
                <div className="text-sm font-medium mb-2">各站点定价</div>
                <div className="space-y-1">
                  {Object.entries(detailData.siteAndPriceMap).map(([site, price]) => (
                    <div key={site} className="flex justify-between text-sm p-2 bg-gray-50 rounded">
                      <span>{SITE_LABEL[site] || site}</span>
                      <span className="font-medium">${price}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detailItem && (
              <div>
                <Button
                  theme="primary"
                  onClick={() => {
                    toggleOne(detailItem.collectBoxDetailId);
                  }}
                  className="mr-2"
                >
                  {selected.has(detailItem.collectBoxDetailId) ? '取消勾选' : '勾选此商品'}
                </Button>
                <Button
                  disabled={!selected.has(detailItem.collectBoxDetailId)}
                  onClick={() => {
                    setDetailDrawerOpen(false);
                    handleOpenPublish();
                  }}
                >
                  发布已选商品
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>

      {/* 发布弹窗 */}
      <Dialog
        header="一键发布到美客多"
        visible={publishOpen}
        onClose={() => !publishLoading && setPublishOpen(false)}
        footer={null}
        width={640}
      >
        {!publishDone ? (
          <div className="space-y-4">
            <div className="bg-blue-50 rounded p-3 text-sm text-blue-700">
              即将发布 <strong>{selected.size}</strong> 件商品到以下店铺
            </div>

            {stores.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                暂无已授权店铺，请先在「店铺管理」添加并授权
              </div>
            ) : (
              <div className="space-y-3">
                {stores.map((store) => {
                  const currentSites = targets[store.id]?.sites || [];
                  const checked = currentSites.length === SITE_OPTIONS.length;
                  const someChecked = currentSites.length > 0;
                  return (
                    <Card key={store.id} size="small" className="border">
                      <div className="flex items-center gap-3 mb-2">
                        <Checkbox
                          checked={checked}
                          indeterminate={someChecked && !checked}
                          onChange={() => toggleAllSitesForStore(store.id)}
                        />
                        <span className="font-medium text-sm">
                          {store.nickname}
                        </span>
                        <Tag size="small">CBT</Tag>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 ml-7">
                        {SITE_OPTIONS.map((opt) => (
                          <Checkbox
                            key={opt.value}
                            checked={currentSites.includes(opt.value)}
                            onChange={() => toggleSite(store.id, opt.value)}
                            label={opt.label}
                          />
                        ))}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}

            <Divider />

            <div className="flex justify-end gap-3">
              <Button onClick={() => setPublishOpen(false)} disabled={publishLoading}>
                取消
              </Button>
              <Button
                theme="primary"
                loading={publishLoading}
                onClick={handlePublish}
                disabled={stores.length === 0}
              >
                确认发布
              </Button>
            </div>
          </div>
        ) : (
          // 发布结果
          <div className="space-y-3">
            <div className="flex gap-3 flex-wrap">
              <Tag theme="success">
                成功 {publishResults.filter((r) => r.success).length}
              </Tag>
              <Tag theme="danger">
                失败 {publishResults.filter((r) => !r.success).length}
              </Tag>
            </div>
            <div className="max-h-80 overflow-y-auto space-y-2">
              {publishResults.map((r, i) => (
                <div
                  key={i}
                  className={`p-2 rounded text-sm flex justify-between items-center ${
                    r.success ? 'bg-green-50' : 'bg-red-50'
                  }`}
                >
                  <div>
                    <span className="mr-2">{r.storeNick}</span>
                    <Tag size="small">{r.site}</Tag>
                    {!r.success && r.error && (
                      <span className="text-red-500 ml-2">{r.error}</span>
                    )}
                  </div>
                  {r.success ? (
                    r.permalink ? (
                      <a
                        href={r.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 underline text-xs"
                      >
                        查看
                      </a>
                    ) : (
                      <Tag theme="success" size="small">已上架</Tag>
                    )
                  ) : (
                    <Tag theme="danger" size="small">失败</Tag>
                  )}
                </div>
              ))}
            </div>
            <Divider />
            <div className="flex justify-end gap-3">
              <Button
                onClick={() => {
                  setPublishOpen(false);
                  setSelected(new Set());
                  loadBox();
                }}
              >
                完成并刷新
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

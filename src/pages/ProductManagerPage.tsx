import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Select,
  Input,
  Button,
  Dialog,
  Loading,
  MessagePlugin,
  Image,
  ImageViewer,
  Textarea,
  Tag,
  Space,
} from 'tdesign-react';
import { SearchIcon, EditIcon, ShopIcon, RefreshIcon } from 'tdesign-icons-react';

interface StoreItem {
  id: string;
  nickname: string;
  site: string;
  mlUserNick?: string;
  authorized: boolean;
}

interface ProductHit {
  id: string;
  title: string;
  seller_sku?: string;
  price: number;
  currency_id: string;
  thumbnail: string;
  permalink: string;
  available_quantity: number;
  status?: string;
  pictures: string[];
  matchType?: 'title' | 'sku';
}

interface ProductPicture {
  id?: string;
  url: string;
}

interface ProductSiteToSell {
  site_id: string;
  price: number;
  currency_id?: string;
  listing_type_id?: string;
  logistic_type?: string;
}

interface ProductDetail extends ProductHit {
  description: string;
  dimensions: { length: string; width: string; height: string; weight: string };
  condition?: string;
  site_id?: string;
  localized_title?: string;
  localized_price?: number;
  localized_site_id?: string;
  localized_item_id?: string;
  marketplace_items?: { site_id: string; item_id: string }[];
  // CBT 保存必须用 global 根 ID（CBT...），搜索/详情可能返回本地站点 ID（MLM...）
  root_item_id?: string;
  // 主要特性
  brand?: string;
  model?: string;
  // 图片带 id（CBT 更新必须用 id）
  pictures_with_id?: ProductPicture[];
  // CBT 按国家价格
  sites_to_sell?: ProductSiteToSell[];
}

export function ProductManagerPage() {
  const [stores, setStores] = useState<StoreItem[]>([]);
  const [storeId, setStoreId] = useState<string>('');
  const [query, setQuery] = useState<string>('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ProductHit[]>([]);
  const [searched, setSearched] = useState(false);

  // 编辑弹窗状态
  const [editOpen, setEditOpen] = useState(false);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editPictures, setEditPictures] = useState<ProductPicture[]>([]);
  const [editDesc, setEditDesc] = useState('');
  const [editLen, setEditLen] = useState('');
  const [editWid, setEditWid] = useState('');
  const [editHei, setEditHei] = useState('');
  const [editWeight, setEditWeight] = useState('');
  const [editQuantity, setEditQuantity] = useState('');
  const [editBrand, setEditBrand] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editSitesToSell, setEditSitesToSell] = useState<ProductSiteToSell[]>([]);
  const [saving, setSaving] = useState(false);

  // 图片放大查看
  const [previewVisible, setPreviewVisible] = useState(false);
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const openViewer = (images: string[], index: number) => {
    const valid = images.filter(Boolean);
    if (!valid.length) return;
    setPreviewImages(valid);
    setPreviewIndex(index);
    setPreviewVisible(true);
  };

  useEffect(() => {
    fetch('/api/ml/stores')
      .then((r) => r.json())
      .then((d) => {
        const list: StoreItem[] = (d.stores || []).filter((s: StoreItem) => s.authorized);
        setStores(list);
        if (list.length && !storeId) setStoreId(list[0].id);
      })
      .catch(() => MessagePlugin.error('获取店铺列表失败'));
  }, []);

  const doSearch = useCallback(async () => {
    if (!storeId) {
      MessagePlugin.warning('请先选择店铺');
      return;
    }
    setSearching(true);
    setSearched(true);
    try {
      const r = await fetch(
        `/api/ml/stores/${storeId}/products/search?q=${encodeURIComponent(query.trim())}`,
      );
      const d = await r.json();
      if (!d.success) {
        MessagePlugin.error(d.message || '搜索失败');
        setResults([]);
      } else {
        setResults(d.products || []);
      }
    } catch (e: any) {
      MessagePlugin.error('搜索失败: ' + (e?.message || e));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [storeId, query]);

  const openEdit = useCallback(async (hit: ProductHit) => {
    if (!storeId) return;
    setEditOpen(true);
    setDetail(null);
    try {
      const r = await fetch(`/api/ml/stores/${storeId}/products/${hit.id}`);
      const d = await r.json();
      if (!d.success) {
        MessagePlugin.error(d.message || '获取详情失败');
        setEditOpen(false);
        return;
      }
      const p: ProductDetail = d.product;
      setDetail(p);
      // CBT 商品在本地站点（如 MLM）的标题/价格往往与 global 不同，优先展示本地站点的值，和美客多后台保持一致
      setEditTitle(p.localized_title || p.title || '');
      // 优先使用带 id 的图片对象（CBT 保存需要 id）
      const pics: ProductPicture[] =
        p.pictures_with_id && p.pictures_with_id.length
          ? p.pictures_with_id
          : (p.pictures && p.pictures.length
              ? p.pictures.map((url) => ({ url }))
              : p.thumbnail
                ? [{ url: p.thumbnail }]
                : []);
      setEditPictures(pics);
      setEditDesc(p.description || '');
      setEditLen(p.dimensions?.length || '');
      setEditWid(p.dimensions?.width || '');
      setEditHei(p.dimensions?.height || '');
      setEditWeight(p.dimensions?.weight || '');
      setEditQuantity(p.available_quantity !== undefined ? String(p.available_quantity) : '');
      setEditBrand(p.brand || '');
      setEditModel(p.model || '');
      setEditSitesToSell(p.sites_to_sell || []);
    } catch (e: any) {
      MessagePlugin.error('获取详情失败: ' + (e?.message || e));
      setEditOpen(false);
    }
  }, [storeId]);

  const saveEdit = useCallback(async () => {
    if (!storeId || !detail) return;
    setSaving(true);
    const saveItemId = detail.root_item_id || detail.id;
    try {
      const r = await fetch(`/api/ml/stores/${storeId}/products/${saveItemId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          pictures: editPictures,
          sites_to_sell: editSitesToSell,
          length: editLen,
          width: editWid,
          height: editHei,
          weight: editWeight,
          description: editDesc,
          site_id: detail.site_id || '',
          available_quantity: editQuantity,
          brand: editBrand,
          model: editModel,
        }),
      });
      const d = await r.json();
      if (!d.success) {
        MessagePlugin.error(d.message || '保存失败');
      } else {
        MessagePlugin.success('保存成功，已提交到美客多');
        setEditOpen(false);
        // 刷新搜索结果中的标题/缩略图/价格
        const firstLocalPrice = editSitesToSell[0]?.price;
        setResults((prev) =>
          prev.map((x) =>
            x.id === detail.id
              ? {
                  ...x,
                  title: editTitle,
                  price: firstLocalPrice ?? x.price,
                  thumbnail: editPictures[0]?.url || x.thumbnail,
                }
              : x,
          ),
        );
      }
    } catch (e: any) {
      MessagePlugin.error('保存失败: ' + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }, [
    storeId,
    detail,
    editTitle,
    editPictures,
    editSitesToSell,
    editLen,
    editWid,
    editHei,
    editWeight,
    editDesc,
    editQuantity,
    editBrand,
    editModel,
  ]);

  const updatePicture = (idx: number, val: string) => {
    setEditPictures((prev) => prev.map((p, i) => (i === idx ? { ...p, url: val } : p)));
  };
  const removePicture = (idx: number) => {
    setEditPictures((prev) => prev.filter((_, i) => i !== idx));
  };
  const addPicture = () => setEditPictures((prev) => [...prev, { url: '' }]);

  return (
    <div className="p-5 max-w-[1200px] mx-auto">
      <div className="flex items-center gap-2 mb-1">
        <ShopIcon size={20} />
        <h1 className="text-xl font-semibold">商品管理</h1>
      </div>
      <p className="text-sm mb-4" style={{ color: 'var(--td-text-color-secondary)' }}>
        按商品 SKU 或标题模糊查询，可编辑图片、标题、按国家价格、库存、品牌、模型、重量、长宽高、描述并提交到美客多。
      </p>

      {/* 搜索栏 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={storeId}
            onChange={(v) => setStoreId(v as string)}
            style={{ width: 240 }}
            placeholder="选择店铺"
            options={stores.map((s) => ({
              value: s.id,
              label: `${s.nickname || s.mlUserNick || s.site}（${s.site}）`,
            }))}
          />
          <Input
            value={query}
            onChange={(v) => setQuery(v as string)}
            onEnter={doSearch}
            placeholder="输入 SKU 或商品标题关键字"
            style={{ width: 320 }}
            clearable
          />
          <Button theme="primary" icon={<SearchIcon />} loading={searching} onClick={doSearch}>
            搜索
          </Button>
        </div>
      </Card>

      {/* 结果区 */}
      {!searched && (
        <Card>
          <div className="text-center py-16" style={{ color: 'var(--td-text-color-placeholder)' }}>
            选择一个已授权店铺，输入 SKU 或标题关键字开始搜索。
          </div>
        </Card>
      )}

      {searched && searching && (
        <Card>
          <Loading loading={true} text="正在搜索商品…" style={{ width: '100%', height: 200 }} />
        </Card>
      )}

      {searched && !searching && results.length === 0 && (
        <Card>
          <div className="text-center py-16" style={{ color: 'var(--td-text-color-placeholder)' }}>
            没有找到匹配的商品，试试更短的关键字。
          </div>
        </Card>
      )}

      {searched && !searching && results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {results.map((hit) => (
            <div
              key={hit.id}
              className="cursor-pointer"
              onClick={() => openEdit(hit)}
            >
              <Card className="hover:shadow-lg transition-shadow">
                <div className="flex flex-col gap-2">
                  <div className="flex justify-center bg-gray-50 rounded" style={{ height: 160 }}>
                    {hit.thumbnail ? (
                      <Image
                        src={hit.thumbnail}
                        fit="contain"
                        style={{ width: 160, height: 160, cursor: 'pointer' }}
                        onClick={() => openViewer([hit.thumbnail], 0)}
                      />
                    ) : (
                      <div className="flex items-center text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                        无图
                      </div>
                    )}
                  </div>
                <div className="flex items-center gap-1">
                  {hit.matchType === 'sku' && <Tag size="small" theme="success">SKU</Tag>}
                  {hit.matchType === 'title' && <Tag size="small" theme="primary">标题</Tag>}
                  <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                    {hit.currency_id} {hit.price}
                  </span>
                </div>
                <div className="text-sm line-clamp-2" style={{ minHeight: 40 }} title={hit.title}>
                  {hit.title || '（无标题）'}
                </div>
                {hit.seller_sku && (
                  <div className="text-xs truncate" style={{ color: 'var(--td-text-color-secondary)' }}>
                    SKU: {hit.seller_sku}
                  </div>
                )}
                <Button size="small" variant="text" icon={<EditIcon />} theme="primary">
                  编辑
                </Button>
              </div>
              </Card>
            </div>
          ))}
        </div>
      )}

      {/* 编辑弹窗 */}
      <Dialog
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        header="编辑商品"
        width="min(720px, 92vw)"
        footer={
          <Space>
            <Button theme="default" variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button theme="primary" loading={saving} onClick={saveEdit}>
              保存到美客多
            </Button>
          </Space>
        }
      >
        {!detail ? (
          <Loading loading={true} text="加载商品详情…" style={{ height: 200 }} />
        ) : (
          <div className="space-y-5 max-h-[70vh] overflow-auto pr-2">
            {/* 图片 */}
            <div>
              <div className="text-sm font-medium mb-2">商品图片（点击可放大；可编辑/删除/新增图片地址）</div>
              <div className="flex flex-wrap gap-2 mb-3">
                {editPictures.map((pic, idx) =>
                  pic.url ? (
                    <Image
                      key={idx}
                      src={pic.url}
                      fit="cover"
                      style={{ width: 72, height: 72, cursor: 'pointer' }}
                      onClick={() => openViewer(editPictures.map((p) => p.url), idx)}
                    />
                  ) : (
                    <div
                      key={idx}
                      className="flex items-center justify-center bg-gray-100 text-xs"
                      style={{ width: 72, height: 72 }}
                    >
                      空
                    </div>
                  ),
                )}
              </div>
              <div className="space-y-2">
                {editPictures.map((pic, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={pic.url}
                      onChange={(v) => updatePicture(idx, v as string)}
                      placeholder="图片 URL（https://...）"
                      style={{ flex: 1 }}
                    />
                    {pic.id && (
                      <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                        ID:{pic.id.slice(0, 16)}…
                      </span>
                    )}
                    <Button size="small" variant="text" theme="danger" onClick={() => removePicture(idx)}>
                      删除
                    </Button>
                  </div>
                ))}
                <Button size="small" variant="dashed" onClick={addPicture}>
                  + 新增图片
                </Button>
              </div>
            </div>

            {/* 标题 */}
            <div>
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <span>标题</span>
                {detail?.localized_site_id && (
                  <Tag size="small" theme="warning">{detail.localized_site_id} 站点</Tag>
                )}
                {detail?.localized_title && detail.title !== detail.localized_title && (
                  <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                    全局标题：{detail.title}
                  </span>
                )}
              </div>
              <Input value={editTitle} onChange={(v) => setEditTitle(v as string)} placeholder="商品标题" />
            </div>

            {/* 价格：按国家（CBT） */}
            <div>
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <span>按国家的价格</span>
                {detail?.price !== undefined && (
                  <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                    全局参考价：{detail.currency_id || 'USD'} {detail.price}
                  </span>
                )}
              </div>
              {editSitesToSell.length === 0 ? (
                <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  未获取到站点价格数据。
                </div>
              ) : (
                <div className="space-y-2">
                  {editSitesToSell.map((s, idx) => (
                    <div key={s.site_id} className="flex items-center gap-2">
                      <Tag size="small" theme="primary">{s.site_id}</Tag>
                      <Input
                        value={String(s.price)}
                        onChange={(v) => {
                          const price = Number(v);
                          setEditSitesToSell((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, price: Number.isFinite(price) ? price : 0 } : x)),
                          );
                        }}
                        placeholder={`${s.site_id} 价格`}
                        style={{ flex: 1 }}
                      />
                      <span className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
                        {s.currency_id || 'USD'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 尺寸 / 重量：与美客多后台顺序一致（高 × 宽 × 长，重量 g） */}
            <div>
              <div className="text-sm font-medium mb-2">尺寸与重量（单位：厘米 / 克）</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-secondary)' }}>高</div>
                  <Input value={editHei} onChange={(v) => setEditHei(v as string)} placeholder="高" />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-secondary)' }}>宽</div>
                  <Input value={editWid} onChange={(v) => setEditWid(v as string)} placeholder="宽" />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-secondary)' }}>长</div>
                  <Input value={editLen} onChange={(v) => setEditLen(v as string)} placeholder="长" />
                </div>
                <div>
                  <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-secondary)' }}>重量</div>
                  <Input value={editWeight} onChange={(v) => setEditWeight(v as string)} placeholder="克" />
                </div>
              </div>
            </div>

            {/* 库存 / 品牌 / 模型 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <div className="text-sm font-medium mb-2">库存</div>
                <Input
                  value={editQuantity}
                  onChange={(v) => setEditQuantity(v as string)}
                  placeholder="可售数量"
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-2">品牌</div>
                <Input
                  value={editBrand}
                  onChange={(v) => setEditBrand(v as string)}
                  placeholder="BRAND"
                />
              </div>
              <div>
                <div className="text-sm font-medium mb-2">模型</div>
                <Input
                  value={editModel}
                  onChange={(v) => setEditModel(v as string)}
                  placeholder="MODEL"
                />
              </div>
            </div>

            {/* 描述 */}
            <div>
              <div className="text-sm font-medium mb-2">描述</div>
              <Textarea
                value={editDesc}
                onChange={(v) => setEditDesc(v as string)}
                placeholder="商品描述（纯文本）"
                autosize={{ minRows: 4, maxRows: 10 }}
              />
            </div>

            <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
              商品 ID：{detail.id}
              {detail.root_item_id && detail.root_item_id !== detail.id ? `（根 ID：${detail.root_item_id}）` : ''}
              ｜ 状态：{detail.status || '—'} ｜ SKU：{detail.seller_sku || '—'}
            </div>
          </div>
        )}
      </Dialog>

      <ImageViewer
        images={previewImages}
        visible={previewVisible}
        index={previewIndex}
        onClose={() => setPreviewVisible(false)}
      />
    </div>
  );
}

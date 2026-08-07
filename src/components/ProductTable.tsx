import { useState, useMemo, useCallback } from 'react';
import { Table, Button, Input, Tag, Checkbox, Select, Tooltip, MessagePlugin } from 'tdesign-react';
import {
  DownloadIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ImageIcon,
  ImageSearchIcon,
  FileCopyIcon,
} from 'tdesign-icons-react';
import { ShoppingBag, Image } from 'lucide-react';

// 商品数据类型（与后端 MLProduct 接口对齐）
export interface ProductItem {
  site: string;
  siteName: string;
  categoryId: string;
  categoryName: string;
  rank: number;
  itemId: string;
  title: string;
  price: number;
  currency: string;
  priceUSD: number;
  permalink: string;
  thumbnail: string;
  pictures: string[];
  soldQuantity: number;
  availableQuantity: number;
  condition: string;
  weight: string;
  height: string;
  width: string;
  length: string;
  sellerName: string;
  sellerLink: string;
  brand: string;
  model: string;
}

interface ProductTableProps {
  products: ProductItem[];
  isFetching: boolean;
  onExportSelected: (products: ProductItem[]) => void;
}

// 格式化货币
function fmtPrice(price: number, currency: string) {
  return `${currency} ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 站点标签颜色
const siteColors: Record<string, string> = {
  MLM: '#2ba471',
  MLB: '#0052d9',
  MLC: '#e37318',
  MCO: '#d54941',
};

// 站点标签中文名
const siteNames: Record<string, string> = {
  MLM: '墨西哥',
  MLB: '巴西',
  MLC: '智利',
  MCO: '哥伦比亚',
};

export function ProductTable({ products, isFetching, onExportSelected }: ProductTableProps) {
  // ===== 筛选状态 =====
  const [searchText, setSearchText] = useState('');
  const [priceMin, setPriceMin] = useState<string>('');
  const [priceMax, setPriceMax] = useState<string>('');
  const [minSales, setMinSales] = useState<string>('');
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);

  // ===== 排序状态 =====
  const [sortKey, setSortKey] = useState<'priceUSD' | 'soldQuantity' | 'rank' | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // ===== 选择状态 =====
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 所有分类（用于过滤下拉）
  const allCategories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => set.add(p.categoryName));
    return Array.from(set).sort();
  }, [products]);

  // ===== 筛选 + 排序 =====
  const filteredProducts = useMemo(() => {
    let result = [...products];

    // 搜索
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.itemId.toLowerCase().includes(q) ||
          p.sellerName.toLowerCase().includes(q) ||
          (p.brand && p.brand.toLowerCase().includes(q))
      );
    }

    // 价格区间
    if (priceMin !== '') {
      const min = parseFloat(priceMin);
      if (!isNaN(min)) result = result.filter((p) => p.priceUSD >= min);
    }
    if (priceMax !== '') {
      const max = parseFloat(priceMax);
      if (!isNaN(max)) result = result.filter((p) => p.priceUSD <= max);
    }

    // 最低销量
    if (minSales !== '') {
      const s = parseInt(minSales);
      if (!isNaN(s)) result = result.filter((p) => p.soldQuantity >= s);
    }

    // 站点过滤
    if (selectedSites.length > 0) {
      result = result.filter((p) => selectedSites.includes(p.site));
    }

    // 分类过滤
    if (selectedCategories.length > 0) {
      result = result.filter((p) => selectedCategories.includes(p.categoryName));
    }

    // 排序
    if (sortKey) {
      result.sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortDir === 'desc' ? vb - va : va - vb;
        }
        return 0;
      });
    } else {
      // 默认按 rank 排序
      result.sort((a, b) => {
        // 同站点按 rank
        if (a.site === b.site) return a.rank - b.rank;
        return a.site.localeCompare(b.site);
      });
    }

    return result;
  }, [products, searchText, priceMin, priceMax, minSales, selectedSites, selectedCategories, sortKey, sortDir]);

  // ===== 汇总统计 =====
  const stats = useMemo(() => {
    const total = filteredProducts.length;
    if (total === 0) return { total, avgPrice: 0, maxPrice: 0, minPrice: 0, totalSales: 0, catCount: 0, siteCount: 0 };
    const prices = filteredProducts.map((p) => p.priceUSD);
    const cats = new Set(filteredProducts.map((p) => p.categoryName));
    const sites = new Set(filteredProducts.map((p) => p.site));
    return {
      total,
      avgPrice: prices.reduce((a, b) => a + b, 0) / total,
      maxPrice: Math.max(...prices),
      minPrice: Math.min(...prices),
      totalSales: filteredProducts.reduce((a, p) => a + p.soldQuantity, 0),
      catCount: cats.size,
      siteCount: sites.size,
    };
  }, [filteredProducts]);

  // ===== 排序切换 =====
  const handleSort = useCallback(
    (key: 'priceUSD' | 'soldQuantity' | 'rank') => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
      } else {
        setSortKey(key);
        setSortDir('desc');
      }
    },
    [sortKey]
  );

  // ===== 选择 =====
  const handleSelectAll = useCallback(
    (checked: boolean) => {
      if (checked) {
        setSelectedIds(new Set(filteredProducts.map((p) => p.itemId)));
      } else {
        setSelectedIds(new Set());
      }
    },
    [filteredProducts]
  );

  const handleSelectOne = useCallback((itemId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }, []);

  // ===== 排序图标 =====
  const SortIcon = ({ colKey }: { colKey: string }) => {
    if (sortKey !== colKey) return <ChevronDownIcon size={12} style={{ opacity: 0.3, marginLeft: 2 }} />;
    return sortDir === 'desc' ? (
      <ChevronDownIcon size={12} style={{ color: 'var(--td-brand-color)', marginLeft: 2 }} />
    ) : (
      <ChevronUpIcon size={12} style={{ color: 'var(--td-brand-color)', marginLeft: 2 }} />
    );
  };

  // ===== 导出选中 =====
  const selectedProducts = useMemo(
    () => products.filter((p) => selectedIds.has(p.itemId)),
    [products, selectedIds]
  );

  // ===== 表格列定义 =====
  const columns = [
    {
      colKey: 'select',
      title: () => (
        <Checkbox
          checked={filteredProducts.length > 0 && selectedIds.size === filteredProducts.length}
          indeterminate={selectedIds.size > 0 && selectedIds.size < filteredProducts.length}
          onChange={handleSelectAll}
        />
      ),
      width: 50,
      render: ({ row }: any) => (
        <Checkbox
          checked={selectedIds.has(row.itemId)}
          onChange={(checked: boolean) => handleSelectOne(row.itemId, checked)}
        />
      ),
    },
    {
      colKey: 'image',
      title: '商品图片',
      width: 130,
      render: ({ row }: any) => (
        <div className="flex flex-col items-center gap-1">
          {row.thumbnail ? (
            <>
              <Tooltip content="点击查看大图">
                <a
                  href={row.thumbnail}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded border overflow-hidden"
                  style={{
                    width: 80,
                    height: 80,
                    borderColor: 'var(--td-component-border)',
                    backgroundColor: 'var(--td-bg-color-component)',
                  }}
                >
                  <img
                    src={row.thumbnail}
                    alt={row.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    loading="lazy"
                  />
                </a>
              </Tooltip>
              <div className="flex gap-1">
                <Tooltip content="复制图片链接">
                  <Button
                    size="small"
                    variant="text"
                    shape="square"
                    onClick={(e: any) => {
                      e.stopPropagation();
                      const imgUrl = row.pictures?.[0] || row.thumbnail;
                      if (imgUrl) {
                        navigator.clipboard.writeText(imgUrl).then(
                          () => MessagePlugin.success('图片链接已复制'),
                          () => MessagePlugin.warning('复制失败，请手动复制')
                        );
                      }
                    }}
                    style={{ padding: '2px' }}
                  >
                    <FileCopyIcon size={14} />
                  </Button>
                </Tooltip>
                <Tooltip content="打开 1688 以图搜款（需在 1688 页面粘贴或上传图片）">
                  <a
                    href="https://s.1688.com/youyuan/index.htm?tab=imageSearch"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e: any) => e.stopPropagation()}
                    style={{ display: 'inline-flex', alignItems: 'center', padding: '2px', color: '#ff6b00', textDecoration: 'none' }}
                    title="打开 1688 以图搜款"
                  >
                    <ImageSearchIcon size={14} />
                  </a>
                </Tooltip>
                <Tooltip content="下载图片">
                  <a
                    href={`/api/ml/image-proxy?url=${encodeURIComponent(row.pictures?.[0] || row.thumbnail)}`}
                    download
                    onClick={(e: any) => e.stopPropagation()}
                    style={{ display: 'inline-flex', alignItems: 'center', padding: '2px', color: 'var(--td-brand-color)', textDecoration: 'none' }}
                    title="下载图片"
                  >
                    <DownloadIcon size={13} />
                  </a>
                </Tooltip>
              </div>
            </>
          ) : (
            <div
              className="rounded flex items-center justify-center"
              style={{
                width: 80,
                height: 80,
                backgroundColor: 'var(--td-bg-color-component)',
                border: '1px solid var(--td-component-border)',
              }}
            >
              <Image size={24} style={{ color: 'var(--td-text-color-placeholder)', opacity: 0.5 }} />
            </div>
          )}
        </div>
      ),
    },
    {
      colKey: 'title',
      title: '商品标题',
      ellipsis: true,
      width: 260,
      render: ({ row }: any) => (
        <div>
          <a
            href={row.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm line-clamp-2"
            style={{ color: 'var(--td-brand-color)' }}
            title={row.title}
          >
            {row.title}
          </a>
        </div>
      ),
    },
    {
      colKey: 'priceUSD',
      title: () => (
        <span className="cursor-pointer select-none" onClick={() => handleSort('priceUSD')}>
          USD价格 <SortIcon colKey="priceUSD" />
        </span>
      ),
      width: 100,
      sorter: true,
      render: ({ row }: any) => (
        <div>
          <div className="font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            ${row.priceUSD.toFixed(2)}
          </div>
          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            {fmtPrice(row.price, row.currency)}
          </div>
        </div>
      ),
    },
    {
      colKey: 'soldQuantity',
      title: () => (
        <span className="cursor-pointer select-none" onClick={() => handleSort('soldQuantity')}>
          销量 <SortIcon colKey="soldQuantity" />
        </span>
      ),
      width: 80,
      sorter: true,
      render: ({ row }: any) => (
        <span className="font-mono" style={{ color: row.soldQuantity > 1000 ? '#e37318' : 'var(--td-text-color-primary)' }}>
          {row.soldQuantity.toLocaleString()}
        </span>
      ),
    },
    {
      colKey: 'site',
      title: '站点',
      width: 80,
      render: ({ row }: any) => (
        <Tag
          size="small"
          variant="light"
          style={{ backgroundColor: siteColors[row.site] + '1a', color: siteColors[row.site], borderColor: 'transparent' }}
        >
          {siteNames[row.site] || row.site}
        </Tag>
      ),
    },
    {
      colKey: 'categoryName',
      title: '分类',
      width: 140,
      ellipsis: true,
    },
    {
      colKey: 'sellerName',
      title: '卖家',
      width: 120,
      ellipsis: true,
      render: ({ row }: any) => (
        <a
          href={row.sellerLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs"
          style={{ color: 'var(--td-text-color-secondary)' }}
        >
          {row.sellerName || '-'}
        </a>
      ),
    },
    {
      colKey: 'condition',
      title: '成色',
      width: 60,
      render: ({ row }: any) =>
        row.condition === 'new' ? (
          <Tag size="small" theme="success" variant="light">全新</Tag>
        ) : (
          <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>{row.condition || '-'}</span>
        ),
    },
    {
      colKey: 'weight',
      title: '重量',
      width: 80,
      render: ({ row }: any) => (
        <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {row.weight || '-'}
        </span>
      ),
    },
  ];

  // 空状态
  if (products.length === 0 && !isFetching) {
    return (
      <div className="py-16 text-center">
        <ShoppingBag size={56} style={{ opacity: 0.15, margin: '0 auto', color: 'var(--td-text-color-placeholder)' }} />
        <p className="mt-4 text-sm font-medium" style={{ color: 'var(--td-text-color-secondary)' }}>
          暂无商品数据
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
          请在上方配置 API 认证，选择目标站点后点击「开始抓取」
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ===== 统计卡片 ===== */}
      {filteredProducts.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="商品总数" value={stats.total.toLocaleString()} color="var(--td-brand-color)" />
          <StatCard
            label="均价 USD"
            value={`$${stats.avgPrice.toFixed(2)}`}
            sub={`$${stats.minPrice.toFixed(2)} ~ $${stats.maxPrice.toFixed(2)}`}
            color="#2ba471"
          />
          <StatCard label="覆盖分类" value={stats.catCount.toString()} color="#e37318" />
          <StatCard label="总销量" value={stats.totalSales.toLocaleString()} color="#0052d9" />
        </div>
      )}

      {/* ===== 筛选栏 ===== */}
      {products.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-lg" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
          <Input
            prefixIcon={<SearchIcon />}
            placeholder="搜索标题/卖家/品牌..."
            value={searchText}
            onChange={(v) => setSearchText(v as string)}
            clearable
            style={{ width: 200 }}
          />
          <Input
            placeholder="价格≥"
            value={priceMin}
            onChange={(v) => setPriceMin(v as string)}
            style={{ width: 80 }}
          />
          <Input
            placeholder="价格≤"
            value={priceMax}
            onChange={(v) => setPriceMax(v as string)}
            style={{ width: 80 }}
          />
          <Input
            placeholder="最低销量"
            value={minSales}
            onChange={(v) => setMinSales(v as string)}
            style={{ width: 90 }}
          />
          <Select
            value={selectedSites}
            onChange={(v) => setSelectedSites(v as string[])}
            multiple
            placeholder="站点"
            style={{ width: 140 }}
            options={[
              { label: '墨西哥', value: 'MLM' },
              { label: '巴西', value: 'MLB' },
              { label: '智利', value: 'MLC' },
              { label: '哥伦比亚', value: 'MCO' },
            ]}
            clearable
          />
          <Select
            value={selectedCategories}
            onChange={(v) => setSelectedCategories(v as string[])}
            multiple
            placeholder="分类"
            style={{ width: 180 }}
            options={allCategories.map((c) => ({ label: c, value: c }))}
            clearable
            filterable
          />
          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)', marginLeft: 'auto' }}>
            显示 {filteredProducts.length} / {products.length} 条
            {isFetching && <span className="ml-2" style={{ color: 'var(--td-brand-color)' }}>● 抓取中...</span>}
          </div>
        </div>
      )}

      {/* ===== 导出按钮 ===== */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
            已选 <b>{selectedIds.size}</b> 个商品
          </span>
          <Button
            theme="primary"
            size="small"
            icon={<DownloadIcon />}
            onClick={() => onExportSelected(selectedProducts)}
          >
            导出选中商品
          </Button>
        </div>
      )}

      {/* ===== 商品表格 ===== */}
      <div style={{ maxHeight: '500px', overflowY: 'auto' }}>
        <Table
          data={filteredProducts.map((p) => ({ ...p, key: p.itemId }))}
          columns={columns}
          rowKey="key"
          bordered
          size="small"
          hover
          stripe
          tableLayout="fixed"
          pagination={{
            defaultPageSize: 50,
            pageSizeOptions: [20, 50, 100, 200],
            showJumper: true,
          }}
        />
      </div>
    </div>
  );
}

// 统计卡片子组件
function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div
      className="p-3 rounded-lg"
      style={{ backgroundColor: color + '0d', border: `1px solid ${color}22` }}
    >
      <div className="text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
        {label}
      </div>
      <div className="text-lg font-bold mt-1" style={{ color }}>
        {value}
      </div>
      {sub && (
        <div className="text-xs mt-0.5" style={{ color: 'var(--td-text-color-placeholder)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

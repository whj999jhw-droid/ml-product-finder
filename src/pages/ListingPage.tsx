import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Tag,
  Select,
  Input,
  InputNumber,
  NotificationPlugin,
} from 'tdesign-react';
import { FeatureIntro } from '../components/FeatureIntro';

interface SourceProduct {
  site: string;
  siteName: string;
  categoryName: string;
  categoryId: string;
  itemId: string;
  title: string;
  priceUSD: number;
  permalink: string;
  weight: string;
  height: string;
  width: string;
  length: string;
}

interface DraftState {
  site: string;
  category_id: string;
  title: string;
  price: number;
  available_quantity: number;
  description: string;
  pictureUrls: string;
  brand: string;
  weight: number;
  height: number;
  width: number;
  length: number;
}

const SITE_OPTIONS = [
  { label: '墨西哥 MLM', value: 'MLM' },
  { label: '巴西 MLB', value: 'MLB' },
  { label: '智利 MLC', value: 'MLC' },
  { label: '哥伦比亚 MCO', value: 'MCO' },
];

const emptyDraft: DraftState = {
  site: 'MLM',
  category_id: '',
  title: '',
  price: 0,
  available_quantity: 10,
  description: '',
  pictureUrls: '',
  brand: 'Generic',
  weight: 0.5,
  height: 10,
  width: 10,
  length: 10,
};

export function ListingPage() {
  const [sources, setSources] = useState<SourceProduct[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const [precheck, setPrecheck] = useState<{ ok: boolean; hits: string[]; message: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ itemId: string; permalink: string } | null>(null);

  const loadSources = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/sourcing/export/latest');
      const d = await r.json();
      if (d.success) setSources(d.rows || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadSources(); }, [loadSources]);

  const onSelectSource = (itemId: string) => {
    setSelectedId(itemId);
    const s = sources.find((x) => x.itemId === itemId);
    if (!s) return;
    setDraft({
      ...emptyDraft,
      site: s.site,
      category_id: s.categoryId,
      // 预填仅作起点；标题/描述必须是你自己的文案（合规要求），请务必修改
      title: s.title,
      price: Number(s.priceUSD) || 0,
      description: '',
      // 注意：不预填竞品原图（版权红线），请填入你自有/已授权图片 URL
      pictureUrls: '',
      brand: 'Generic',
      weight: parseFloat(s.weight) || 0.5,
      height: parseFloat(s.height) || 10,
      width: parseFloat(s.width) || 10,
      length: parseFloat(s.length) || 10,
    });
    setPrecheck(null);
    setResult(null);
  };

  const patch = (p: Partial<DraftState>) => setDraft((d) => ({ ...d, ...p }));

  const handlePrecheck = async () => {
    const r = await fetch('/api/ml/listing/precheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...draft,
        pictureUrls: draft.pictureUrls.split('\n').map((s) => s.trim()).filter(Boolean),
      }),
    });
    const d = await r.json();
    setPrecheck(d);
    if (d.ok) NotificationPlugin.success({ title: '预检通过', content: d.message });
    else NotificationPlugin.warning({ title: '预检未通过', content: d.message });
  };

  const handleCreate = async () => {
    if (precheck && !precheck.ok) {
      NotificationPlugin.warning({ title: '请先通过合规预检', content: '修正命中的项后再上架' });
      return;
    }
    setCreating(true);
    try {
      const r = await fetch('/api/ml/listing/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          pictureUrls: draft.pictureUrls.split('\n').map((s) => s.trim()).filter(Boolean),
        }),
      });
      const d = await r.json();
      if (d.success) {
        setResult({ itemId: d.itemId, permalink: d.permalink });
        NotificationPlugin.success({ title: '上架成功', content: `商品ID: ${d.itemId}` });
      } else {
        NotificationPlugin.error({ title: '上架失败', content: d.message });
      }
    } catch (err: any) {
      NotificationPlugin.error({ title: '上架失败', content: err?.message || '未知错误' });
    } finally {
      setCreating(false);
    }
  };

  const textAreaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: 90,
    padding: 8,
    borderRadius: 6,
    border: '1px solid var(--td-component-border)',
    background: 'var(--td-bg-color-container)',
    color: 'var(--td-text-color-primary)',
    fontFamily: 'inherit',
    resize: 'vertical',
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <FeatureIntro
          title="合规上架（M3）"
          summary="基于 M1 爆款自建 Listing，红线与操作步骤"
          defaultOpen={false}
        >
          <p>本页用于把「美客多商品抓取（M1）」导出的爆款，做成<strong>你自己的</strong> Listing 上架。核心原则：</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><b>内容必须自建</b>：标题、描述、图片、品牌均需自行撰写 / 自有或已授权，<b style={{ color: '#E34D59' }}>严禁复制竞品的销量、评论、原图</b>。</li>
            <li><b>图片红线</b>：不可使用从美客多抓到的竞品原图（版权风险），请填入你自有或已授权的图床 URL。</li>
            <li><b>上架凭证</b>：使用卖家 write token；非 Full 官方仓店铺走 <code>shipping.mode=custom</code>。</li>
          </ul>
          <p className="pt-1 font-medium" style={{ color: 'var(--td-text-color-primary)' }}>操作流程</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>从「M1 导出」选择爆款作分类 / 定价参考（仅参考，内容仍需自建）。</li>
            <li>在「编辑草稿」填写标题 / 描述 / 图片 / 规格 / 价格 / 库存。</li>
            <li>点「运行合规预检」，通过后点「确认上架」。</li>
          </ol>
          <p className="pt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>⚠️ 上架会真实写入店铺（不可逆），建议先小批量灰度。</p>
        </FeatureIntro>

        <Card title="1. 选择源爆款（仅取分类/定价参考，内容须自建）" bordered>
          <Select
            value={selectedId}
            onChange={(v) => onSelectSource(v as string)}
            filterable
            placeholder="从 M1 导出中选择一个爆款"
            options={sources.map((s) => ({
              label: `[${s.site}] ${s.title.slice(0, 50)}`,
              value: s.itemId,
            }))}
            style={{ width: '100%' }}
          />
          {sources.length === 0 && (
            <p className="mt-2 text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
              暂无 M1 导出数据，请先到「美客多商品抓取」运行一次。也可直接在下方手动填写。
            </p>
          )}
        </Card>

        <Card title="2. 编辑你的 Listing 草稿" bordered>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span>站点</span>
              <Select value={draft.site} onChange={(v) => patch({ site: v as string })} options={SITE_OPTIONS} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>分类ID（ML 分类代码，如 MLM1051）</span>
              <Input value={draft.category_id} onChange={(v) => patch({ category_id: v as string })} />
            </label>
            <label className="flex flex-col gap-1 text-sm col-span-2">
              <span>商品标题（必须为你自己撰写，含关键词）</span>
              <Input value={draft.title} onChange={(v) => patch({ title: v as string })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>售价 (USD)</span>
              <InputNumber value={draft.price} min={0} step={0.5} theme="column" onChange={(v) => patch({ price: Number(v) || 0 })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>可售数量</span>
              <InputNumber value={draft.available_quantity} min={1} step={1} theme="column" onChange={(v) => patch({ available_quantity: Number(v) || 1 })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>品牌（你的品牌或 Generic）</span>
              <Input value={draft.brand} onChange={(v) => patch({ brand: v as string })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>重量 (kg)</span>
              <InputNumber value={draft.weight} min={0} step={0.1} theme="column" onChange={(v) => patch({ weight: Number(v) || 0 })} />
            </label>
            <label className="flex flex-col gap-1 text-sm col-span-2">
              <span>商品描述（plain_text，自己写）</span>
              <textarea style={textAreaStyle} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-sm col-span-2">
              <span>商品图片 URL（每行一个，须为你自有/已授权图，<b style={{ color: '#E34D59' }}>禁止用竞品原图</b>）</span>
              <textarea style={textAreaStyle} value={draft.pictureUrls} onChange={(e) => patch({ pictureUrls: e.target.value })} placeholder={'https://你的图床/xxx.jpg\nhttps://你的图床/yyy.jpg'} />
            </label>
            <div className="col-span-2 flex gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span>高(cm)</span>
                <InputNumber value={draft.height} min={0} step={1} theme="column" onChange={(v) => patch({ height: Number(v) || 0 })} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>宽(cm)</span>
                <InputNumber value={draft.width} min={0} step={1} theme="column" onChange={(v) => patch({ width: Number(v) || 0 })} />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>长(cm)</span>
                <InputNumber value={draft.length} min={0} step={1} theme="column" onChange={(v) => patch({ length: Number(v) || 0 })} />
              </label>
            </div>
          </div>
        </Card>

        <Card title="3. 合规预检 & 上架" bordered>
          <div className="flex items-center gap-3 flex-wrap">
            <Button theme="default" variant="outline" onClick={handlePrecheck}>运行合规预检</Button>
            <Button theme="primary" onClick={handleCreate} loading={creating}>确认上架</Button>
            {precheck && (
              precheck.ok ? (
                <Tag theme="success" variant="light">预检通过</Tag>
              ) : (
                <Tag theme="danger" variant="light">预检未通过：{precheck.hits.join(', ')}</Tag>
              )
            )}
          </div>
          {precheck && !precheck.ok && (
            <p className="mt-3 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>{precheck.message}</p>
          )}
          {result && (
            <div className="mt-4 p-4 rounded-lg" style={{ backgroundColor: 'rgba(103,194,58,0.1)' }}>
              <div className="font-semibold" style={{ color: '#67c23a' }}>上架成功 ✅</div>
              <div className="text-sm mt-1">商品ID: {result.itemId}</div>
              <a href={result.permalink} target="_blank" rel="noreferrer" className="text-sm" style={{ color: 'var(--td-brand-color)' }}>
                查看商品页 ↗
              </a>
            </div>
          )}
          <p className="mt-3 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            ⚠️ 上架会真实写入你的美客多店铺（不可逆）。请确保标题/描述/图片均为你自建内容，且已通过合规预检。建议先小批量灰度。
          </p>
        </Card>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Tabs, Tag, Button, Loading, MessagePlugin, Space, Input } from 'tdesign-react';
import { RefreshIcon, CopyIcon, SearchIcon, AddIcon, DeleteIcon, ChevronUpIcon, ChevronDownIcon } from 'tdesign-icons-react';

interface TrendItem {
  keyword: string;
  url?: string;
  translation?: string;
  segment: 'fastest-growing' | 'most-wanted' | 'most-popular';
  index: number;
}

interface SiteInfo {
  code: string;
  name: string;
}

const SITES: SiteInfo[] = [
  { code: 'MLM', name: '墨西哥' },
  { code: 'MLB', name: '巴西' },
  { code: 'MLC', name: '智利' },
  { code: 'MCO', name: '哥伦比亚' },
];

const SEGMENT_TEXT: Record<TrendItem['segment'], string> = {
  'fastest-growing': '增长最快',
  'most-wanted': '用户最想要',
  'most-popular': '最受欢迎',
};

const SEGMENT_THEME: Record<TrendItem['segment'], 'danger' | 'warning' | 'success'> = {
  'fastest-growing': 'danger',
  'most-wanted': 'warning',
  'most-popular': 'success',
};

function segmentOfIndex(i: number): TrendItem['segment'] {
  if (i < 10) return 'fastest-growing';
  if (i < 30) return 'most-wanted';
  return 'most-popular';
}

function copyText(text: string) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise<void>((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(ta);
    }
  });
}

export function TrendsPage() {
  const [activeSite, setActiveSite] = useState('MLM');
  const [itemsMap, setItemsMap] = useState<Record<string, TrendItem[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const [copiedMap, setCopiedMap] = useState<Record<string, boolean>>({});
  // 后台补全翻译的轮询：返回后若仍有未翻译词，隔段时间再拉一次以显示中文
  const translatePollRef = useRef<number | null>(null);
  const translatePollCountRef = useRef(0);

  const copiedKey = (site: string, keyword: string, part: 'en' | 'zh') => `${site}:${keyword}:${part}`;

  const loadTrends = useCallback(async (site: string, refresh = false) => {
    setLoadingMap((m) => ({ ...m, [site]: true }));
    setErrorMap((m) => ({ ...m, [site]: '' }));
    try {
      const controller = new AbortController();
      // 本接口只拉热搜词（通常 1~2s），超时留足余量即可；中文由后台补全、前端轮询显示
      const timer = setTimeout(() => controller.abort(), 55000);
      const r = await fetch(`/api/ml/trends/${site}?limit=50${refresh ? '&refresh=1' : ''}`, { signal: controller.signal });
      clearTimeout(timer);
      const d = await r.json();
      if (d.success) {
        setItemsMap((m) => ({ ...m, [site]: d.items || [] }));
        // 若仍有未翻译词，且后台正在补全，则安排后续轮询（最多 4 次，间隔递增）
        const hasUntranslated = (d.items || []).some((x: any) => !x.translation);
        if (hasUntranslated) {
          const scheduleNext = () => {
            translatePollCountRef.current += 1;
            if (translatePollCountRef.current > 4) return;
            const delay = translatePollCountRef.current * 15000; // 15s, 30s, 45s, 60s
            translatePollRef.current = window.setTimeout(() => {
              loadTrends(site, false);
            }, delay);
          };
          scheduleNext();
        }
      } else {
        const msg = d.message || `获取 ${site} 热搜失败`;
        MessagePlugin.error(msg);
        setErrorMap((m) => ({ ...m, [site]: msg }));
      }
    } catch (err: any) {
      const msg = err?.name === 'AbortError' ? '请求超时，请稍后重试' : (err?.message || `获取 ${site} 热搜失败`);
      MessagePlugin.error(msg);
      setErrorMap((m) => ({ ...m, [site]: msg }));
    } finally {
      setLoadingMap((m) => ({ ...m, [site]: false }));
    }
  }, []);

  // 切换站点：重置轮询计数并清掉旧定时器，重新拉取
  useEffect(() => {
    translatePollCountRef.current = 0;
    if (translatePollRef.current) window.clearTimeout(translatePollRef.current);
    loadTrends(activeSite);
  }, [activeSite, loadTrends]);

  // 离开页面时清理轮询定时器
  useEffect(() => {
    return () => {
      if (translatePollRef.current) window.clearTimeout(translatePollRef.current);
    };
  }, []);

  const handleCopy = async (site: string, text: string, keyword: string, part: 'en' | 'zh') => {
    try {
      await copyText(text);
      const key = copiedKey(site, keyword, part);
      setCopiedMap((m) => ({ ...m, [key]: true }));
      MessagePlugin.success('已复制');
    } catch {
      MessagePlugin.error('复制失败');
    }
  };

  const items = itemsMap[activeSite] || [];
  const loading = loadingMap[activeSite];

  // ===== AI 多平台配置（LLM：热搜词翻译 / 标题 / 描述 / 订单翻译）=====
  interface LlmProviderForm {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }
  const emptyProvider = (): LlmProviderForm => ({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: '',
    baseUrl: '',
    apiKey: '',
    model: '',
  });
  const [llmProviders, setLlmProviders] = useState<LlmProviderForm[]>([emptyProvider()]);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{
    success: boolean;
    message: string;
    perProvider?: Array<{
      name: string;
      baseUrl: string;
      model: string;
      reachable: boolean;
      success: boolean;
      message?: string;
    }>;
  } | null>(null);

  const loadLlmStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/llm-config');
      const d = await r.json();
      setLlmConfigured(!!d.configured);
      if (d.providers?.length) {
        setLlmProviders(
          d.providers.map((p: any, i: number) => ({
            id: `${Date.now()}-${i}`,
            name: p.name || `平台 ${i + 1}`,
            baseUrl: p.baseUrl || '',
            apiKey: '',
            model: p.model || '',
          })),
        );
      } else if (d.configured && d.baseUrl && d.model) {
        // 兼容旧版单平台
        setLlmProviders([
          {
            id: `${Date.now()}-0`,
            name: '平台 1',
            baseUrl: d.baseUrl,
            apiKey: '',
            model: d.model,
          },
        ]);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadLlmStatus();
  }, [loadLlmStatus]);

  const addProvider = () => setLlmProviders((prev) => [...prev, emptyProvider()]);
  const removeProvider = (idx: number) =>
    setLlmProviders((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  const moveProvider = (idx: number, direction: -1 | 1) => {
    setLlmProviders((prev) => {
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };
  const updateProvider = (idx: number, field: keyof Omit<LlmProviderForm, 'id'>, value: string) => {
    setLlmProviders((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  };

  const validateProviders = (providers: LlmProviderForm[]) => {
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      if (!p.baseUrl.trim() || !p.model.trim()) {
        return `第 ${i + 1} 个平台必须填写 baseUrl 和 model`;
      }
      if (!llmConfigured && !p.apiKey.trim()) {
        return `第 ${i + 1} 个平台首次保存必须填写 apiKey`;
      }
    }
    return '';
  };

  const handleSaveLlm = async () => {
    const msg = validateProviders(llmProviders);
    if (msg) {
      MessagePlugin.warning(msg);
      return;
    }
    setLlmSaving(true);
    try {
      const providers = llmProviders.map((p, i) => ({
        name: p.name.trim() || `平台 ${i + 1}`,
        baseUrl: p.baseUrl.trim(),
        apiKey: p.apiKey.trim(),
        model: p.model.trim(),
      }));
      const r = await fetch('/api/ml/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      const d = await r.json();
      if (d.success) {
        MessagePlugin.success(d.message || '已保存');
        loadLlmStatus();
      } else {
        MessagePlugin.error(d.message || '保存失败');
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '保存失败');
    } finally {
      setLlmSaving(false);
    }
  };

  const handleTestLlm = async () => {
    const msg = validateProviders(llmProviders);
    if (msg) {
      MessagePlugin.warning(msg);
      return;
    }
    setLlmTesting(true);
    setLlmTestResult(null);
    try {
      const providers = llmProviders.map((p, i) => ({
        name: p.name.trim() || `平台 ${i + 1}`,
        baseUrl: p.baseUrl.trim(),
        apiKey: p.apiKey.trim(),
        model: p.model.trim(),
      }));
      const r = await fetch('/api/ml/llm-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers }),
      });
      let body: any = null;
      const contentType = r.headers.get('content-type') || '';
      if (r.ok && contentType.includes('application/json')) {
        body = await r.json();
      } else {
        const text = await r.text().catch(() => '');
        body = {
          success: false,
          message: `后端返回异常 HTTP ${r.status} ${r.statusText}（可能是后端未重启或路由不存在）`,
          raw: text.slice(0, 800),
        };
      }
      setLlmTestResult(body);
      if (body.success) {
        MessagePlugin.success(body.message || '至少有一个平台可用');
        loadLlmStatus();
      } else {
        MessagePlugin.error(body.message || '测试失败');
      }
    } catch (err: any) {
      const msg = err?.message || '测试失败';
      MessagePlugin.error(msg);
      setLlmTestResult({
        success: false,
        message: `${msg}。常见原因：后端未启动、Vite 代理异常、浏览器拦截跨域请求。请按 F12 → Network 查看实际请求。`,
      });
    } finally {
      setLlmTesting(false);
    }
  };

  // 按 segment 分组展示，顺序：增长最快 -> 用户最想要 -> 最受欢迎
  const groups: TrendItem['segment'][] = ['fastest-growing', 'most-wanted', 'most-popular'];

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="max-w-7xl mx-auto space-y-4">
      <Card title="AI 多平台配置（自动降级）" bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2 flex-wrap">
            <Tag theme={llmConfigured ? 'success' : 'default'} variant="light">
              {llmConfigured ? `已配置 ${llmProviders.length} 个平台` : '未配置（仅显示英文）'}
            </Tag>
            {llmConfigured && (
              <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                调用顺序：{llmProviders.map((p) => p.name.trim() || '未命名').join(' → ')}，一个失败自动换下一个
              </span>
            )}
          </div>
          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            支持配置多个 OpenAI 兼容平台（硅基流动 / DeepSeek / 智谱 / 阿里百炼等）。系统按列表顺序调用，
            <b>一个平台不通自动降级到下一个</b>。baseUrl 填到 /v1 或不带 /v1 均可。
          </div>

          {llmProviders.map((p, idx) => (
            <div
              key={p.id}
              className="p-3 rounded border"
              style={{ backgroundColor: 'var(--td-bg-color-secondarycontainer)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-medium">平台 {idx + 1}</div>
                <div className="flex items-center gap-1">
                  <Button
                    size="small"
                    variant="outline"
                    icon={<ChevronUpIcon />}
                    disabled={idx === 0}
                    onClick={() => moveProvider(idx, -1)}
                    title="上移"
                  />
                  <Button
                    size="small"
                    variant="outline"
                    icon={<ChevronDownIcon />}
                    disabled={idx === llmProviders.length - 1}
                    onClick={() => moveProvider(idx, 1)}
                    title="下移"
                  />
                  <Button
                    size="small"
                    variant="outline"
                    icon={<DeleteIcon />}
                    disabled={llmProviders.length <= 1}
                    onClick={() => removeProvider(idx)}
                    title="删除"
                  />
                </div>
              </div>
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
                <Input
                  value={p.name}
                  onChange={(v: string) => updateProvider(idx, 'name', v)}
                  placeholder="平台名称（如：硅基流动）"
                />
                <Input
                  value={p.baseUrl}
                  onChange={(v: string) => updateProvider(idx, 'baseUrl', v)}
                  placeholder="https://api.siliconflow.cn"
                />
                <Input
                  value={p.apiKey}
                  type="password"
                  onChange={(v: string) => updateProvider(idx, 'apiKey', v)}
                  placeholder={llmConfigured ? 'Api Key（留空=不修改）' : 'Api Key'}
                />
                <Input
                  value={p.model}
                  onChange={(v: string) => updateProvider(idx, 'model', v)}
                  placeholder="Model，如 Qwen/Qwen2.5-7B-Instruct"
                />
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2 items-center">
            <Button variant="outline" icon={<AddIcon />} onClick={addProvider}>
              添加平台
            </Button>
            <Button theme="primary" onClick={handleSaveLlm} loading={llmSaving}>
              保存配置
            </Button>
            <Button variant="outline" onClick={handleTestLlm} loading={llmTesting}>
              测试连接
            </Button>
          </div>

          {llmTestResult && (
            <div
              className="text-xs p-2 rounded"
              style={{ background: 'var(--td-bg-color-container-active)', color: 'var(--td-text-color-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
            >
              <div style={{ color: llmTestResult.success ? 'var(--td-success-color)' : 'var(--td-error-color)' }}>
                {llmTestResult.message}
              </div>
              {llmTestResult.perProvider?.length && (
                <div className="mt-2 space-y-1">
                  {llmTestResult.perProvider.map((p, i) => (
                    <div key={i} className="flex items-center gap-2 flex-wrap">
                      <Tag theme={p.success ? 'success' : 'danger'} variant="light" size="small">
                        {p.success ? '可用' : '不可用'}
                      </Tag>
                      <span className="font-medium">{p.name}</span>
                      <span style={{ color: 'var(--td-text-color-placeholder)' }}>
                        {p.baseUrl} · {p.model}
                      </span>
                      <span>{p.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Space>
      </Card>

      <Card title="美客多热搜词（Trends）" bordered className="mt-4">
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="text-sm" style={{ color: 'var(--td-text-color-secondary)', lineHeight: 1.7 }}>
            这是 Mercado Libre 官方提供的 <b>/trends/{'{site_id}'}</b> 接口，每周更新一次各站点买家搜索量最高的 50 个关键词。
            接口把 50 个词分成三类：前 10 个是「增长最快」的搜索；接下来 20 个是「用户最想要」的搜索；最后 20 个是「最受欢迎」的搜索。
            你可以把它当成选品灵感：哪些词最近被搜得最多、增长最快，往往对应潜在爆款。点击任意关键词可直接复制，用于后续的商品标题、广告词或到 1688/淘宝做图搜货源。
          </div>
          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            支持站点：墨西哥（MLM）、巴西（MLB）、智利（MLC）、哥伦比亚（MCO）。数据来自 api.mercadolibre.com，本地缓存 1 小时，点刷新可强制重新拉取。
          </div>
        </Space>
      </Card>

      <Card className="mt-4" bordered>
        <Tabs value={activeSite} onChange={(v: string) => setActiveSite(v)}>
          {SITES.map((s) => (
            <Tabs.TabPanel key={s.code} value={s.code} label={s.name} />
          ))}
        </Tabs>

        <div className="flex items-center justify-between mt-4 mb-3">
          <div className="text-base font-medium">
            {SITES.find((s) => s.code === activeSite)?.name} 热搜榜
          </div>
          <div className="flex items-center gap-2">
            {llmConfigured && items.length > 0 && items.some((x) => !x.translation) && (
              <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                中文翻译补全中…
              </span>
            )}
            <Button
              icon={<RefreshIcon />}
              loading={loading}
              onClick={() => {
                translatePollCountRef.current = 0;
                if (translatePollRef.current) window.clearTimeout(translatePollRef.current);
                loadTrends(activeSite, true);
              }}
              size="small"
              variant="outline"
            >
              刷新
            </Button>
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className="py-10 text-center">
            <Loading text="正在拉取热搜词..." />
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm" style={{ color: errorMap[activeSite] ? 'var(--td-error-color)' : 'var(--td-text-color-placeholder)' }}>
            {errorMap[activeSite] || '暂无数据，点击右上角「刷新」重试。'}
          </div>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {groups.map((seg) => {
              const groupItems = items.filter((x) => x.segment === seg);
              if (groupItems.length === 0) return null;
              return (
                <div key={seg}>
                  <div className="mb-2 mt-3 flex items-center gap-2">
                    <Tag theme={SEGMENT_THEME[seg]} variant="light">
                      {SEGMENT_TEXT[seg]}
                    </Tag>
                    <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      {seg === 'fastest-growing' ? '近两周增长最快' : seg === 'most-wanted' ? '上周搜索量最大' : '近一周热度显著上升'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {groupItems.map((item) => {
                      const copiedEn = copiedMap[copiedKey(activeSite, item.keyword, 'en')];
                      const copiedZh = copiedMap[copiedKey(activeSite, item.keyword, 'zh')];
                      const hasZh = !!item.translation;
                      return (
                        <Tag
                          key={item.index}
                          theme={copiedEn || copiedZh ? 'default' : SEGMENT_THEME[seg]}
                          variant={copiedEn || copiedZh ? 'light' : 'outline'}
                          style={{
                            cursor: 'default',
                            userSelect: 'none',
                            padding: '4px 8px',
                          }}
                          title={item.url ? '点击英文复制英文，点击中文复制中文' : '点击复制关键词'}
                        >
                          <span className="flex items-center gap-1">
                            {copiedEn || copiedZh ? <CopyIcon size="small" /> : <SearchIcon size="small" />}
                            <span
                              className="cursor-pointer hover:underline"
                              style={{
                                opacity: copiedEn ? 0.5 : 1,
                                transition: 'opacity 0.2s',
                              }}
                              onClick={() => handleCopy(activeSite, item.keyword, item.keyword, 'en')}
                            >
                              {item.keyword}
                            </span>
                            {hasZh && (
                              <>
                                <span style={{ color: 'var(--td-text-color-placeholder)', margin: '0 2px' }}>/</span>
                                <span
                                  className="cursor-pointer hover:underline"
                                  style={{
                                    color: 'var(--td-text-color-secondary)',
                                    opacity: copiedZh ? 0.5 : 1,
                                    transition: 'opacity 0.2s',
                                  }}
                                  onClick={() => handleCopy(activeSite, item.translation!, item.keyword, 'zh')}
                                >
                                  {item.translation}
                                </span>
                              </>
                            )}
                          </span>
                        </Tag>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </Space>
        )}
        </Card>
      </div>
    </div>
  );
}

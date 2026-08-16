import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Tabs, Tag, Button, Loading, MessagePlugin, Space, Input } from 'tdesign-react';
import { RefreshIcon, CopyIcon, SearchIcon } from 'tdesign-icons-react';

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

  // ===== AI 翻译配置（LLM：用于热搜词中文翻译）=====
  const [llmForm, setLlmForm] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [llmStatus, setLlmStatus] = useState<{ configured: boolean; baseUrl: string; model: string }>({ configured: false, baseUrl: '', model: '' });
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestDetail, setLlmTestDetail] = useState<{ message: string; raw?: string; url?: string } | null>(null);

  const loadLlmStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/ml/llm-config');
      const d = await r.json();
      setLlmStatus({ configured: !!d.configured, baseUrl: d.baseUrl || '', model: d.model || '' });
      if (d.configured) {
        // 已配置则回填表单（apiKey 不回传，留空表示不修改）
        setLlmForm((f) => ({ ...f, baseUrl: d.baseUrl || f.baseUrl, model: d.model || f.model }));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadLlmStatus();
  }, [loadLlmStatus]);

  const handleSaveLlm = async () => {
    if (!llmForm.baseUrl || !llmForm.model) {
      MessagePlugin.warning('请填写 baseUrl 和 model');
      return;
    }
    // 已配置时 apiKey 留空表示不修改；未配置时后端会校验必须有 key
    if (!llmStatus.configured && !llmForm.apiKey) {
      MessagePlugin.warning('首次保存必须填写 apiKey');
      return;
    }
    setLlmSaving(true);
    try {
      const r = await fetch('/api/ml/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llmForm),
      });
      const d = await r.json();
      if (d.success) {
        MessagePlugin.success('已保存，点「测试连接」验证；之后刷新热搜词即可显示中文');
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
    setLlmTesting(true);
    setLlmTestDetail(null);
    try {
      const r = await fetch('/api/ml/llm-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 没保存过也允许带配置先试（apiKey 为空则用已保存配置）
        body: JSON.stringify(llmForm.apiKey ? llmForm : {}),
      });
      // 如果后端没有该接口（比如没重启），会返回 HTML 404，这里先捕获 HTTP 状态
      let body: any = null;
      const contentType = r.headers.get('content-type') || '';
      if (r.ok && contentType.includes('application/json')) {
        body = await r.json();
      } else {
        const text = await r.text().catch(() => '');
        body = {
          success: false,
          message: `后端返回异常 HTTP ${r.status} ${r.statusText}（可能是后端未重启、路由不存在或返回了 HTML 错误页）`,
          raw: text.slice(0, 800),
        };
      }
      if (body.success) {
        MessagePlugin.success('连接成功！' + (body.message || ''));
        loadLlmStatus();
      } else {
        MessagePlugin.error(body.message || '连接失败');
        setLlmTestDetail({ message: body.message || '连接失败', raw: body.raw || body.networkError, url: body.url });
      }
    } catch (err: any) {
      // fetch 本身抛错（网络不通、CORS、后端未启动等）
      const msg = err?.message || '测试失败';
      MessagePlugin.error(msg);
      setLlmTestDetail({
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
      <Card title="AI 翻译配置（热搜词中文翻译用）" bordered>
        <Space direction="vertical" style={{ width: '100%' }}>
          <div className="flex items-center gap-2">
            <Tag theme={llmStatus.configured ? 'success' : 'default'} variant="light">
              {llmStatus.configured ? '已配置' : '未配置（仅显示英文）'}
            </Tag>
            {llmStatus.configured && (
              <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }} title={`完整 baseUrl：${llmStatus.baseUrl}`}>
                {llmStatus.baseUrl} · {llmStatus.model}
              </span>
            )}
          </div>
          <div className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
            填一个 OpenAI 兼容的大模型（硅基流动 / DeepSeek / 智谱 / 阿里百炼等均可）。配置后热搜词会自动补中文，AI 标题/描述生成也依赖它。详见项目 docs/llm-translation-setup.md。
            <span style={{ color: 'var(--td-text-color-secondary)' }}> 提示：baseUrl 填到 /v1 或不带 /v1 均可，系统会自动处理。</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <Input
              value={llmForm.baseUrl}
              onChange={(v: string) => setLlmForm({ ...llmForm, baseUrl: v })}
              placeholder="https://api.siliconflow.cn"
              style={{ flex: '1 1 240px', minWidth: 0 }}
            />
            <Input
              value={llmForm.apiKey}
              type="password"
              onChange={(v: string) => setLlmForm({ ...llmForm, apiKey: v })}
              placeholder={llmStatus.configured ? 'Api Key（留空=不修改）' : 'Api Key'}
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <Input
              value={llmForm.model}
              onChange={(v: string) => setLlmForm({ ...llmForm, model: v })}
              placeholder="Model，如 Qwen/Qwen2.5-7B-Instruct"
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <Button theme="primary" onClick={handleSaveLlm} loading={llmSaving}>保存</Button>
            <Button variant="outline" onClick={handleTestLlm} loading={llmTesting}>测试连接</Button>
          </div>
          {llmTestDetail && (
            <div
              className="text-xs p-2 rounded"
              style={{ background: 'var(--td-bg-color-container-active)', color: 'var(--td-text-color-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
            >
              <div style={{ color: 'var(--td-error-color)' }}>{llmTestDetail.message}</div>
              {llmTestDetail.raw && (
                <div className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  原始响应：{llmTestDetail.raw}
                </div>
              )}
              {llmTestDetail.url && (
                <div className="mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  实际请求 URL：{llmTestDetail.url}
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
            {llmStatus.configured && items.length > 0 && items.some((x) => !x.translation) && (
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

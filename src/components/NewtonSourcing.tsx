/**
 * 云牛顿 AI 智能找货源 组件
 * 交互式多轮：提需求 -> 牛顿可能直接返回货源(END)，或先弹澄清卡(WAIT_USER) -> 用户选完 resume 续跑。
 * 解析出的 1688 商品链接/进货价可「采用」回填到选中的 M2 货源行（与现有 1688 搜款共用同一套字段）。
 */
import { useRef, useState } from 'react';
import {
  Button,
  Card,
  Tag,
  Input,
  Select,
  Radio,
  Loading,
  NotificationPlugin,
  MessagePlugin,
} from 'tdesign-react';
import { FeatureIntro } from './FeatureIntro';

interface SourcingRowLite {
  itemId: string;
  title?: string;
  sourcePriceCNY: number;
  sourceLink: string;
  supplier: string;
  sourceTitle?: string;
  sourceImages?: string[];
}

interface NewtonItem {
  title: string;
  priceCNY: number;
  moq: number;
  supplier: string;
  url: string;
  imageUrl?: string;
}

interface Clarification {
  toolCallId: string;
  selectionType: string;
  questions: { question: string; options: string[]; allowMultiple?: boolean }[];
}

interface Props {
  rows: SourcingRowLite[];
  updateRow: (itemId: string, patch: Partial<SourcingRowLite>) => void;
}

export function NewtonSourcing({ rows, updateRow }: Props) {
  const [message, setMessage] = useState('帮我在1688找手机壳的跨境无货源货源，列出2-3个具体商品链接和进货价');
  const [phase, setPhase] = useState<'idle' | 'thinking' | 'waiting' | 'done' | 'error'>('idle');
  const [content, setContent] = useState('');
  const [items, setItems] = useState<NewtonItem[]>([]);
  const [clarification, setClarification] = useState<Clarification | null>(null);
  const [answers, setAnswers] = useState<(string | string[])[]>([]);
  const [freeText, setFreeText] = useState('');
  const [targetRowId, setTargetRowId] = useState<string>('');
  const [errMsg, setErrMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const taskRef = useRef<{ taskId: string; sessionId: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const pollOnce = async () => {
    const task = taskRef.current;
    if (!task) return;
    try {
      const r = await fetch('/api/ml/newton/sourcing/get', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(task),
      });
      const d = await r.json();
      if (!d.success) {
        setPhase('error');
        setErrMsg(d.message || '查询失败');
        stopTimer();
        return;
      }
      if (d.content) setContent(d.content);
      if (d.status === 'END') {
        setPhase('done');
        setItems(d.items || []);
        stopTimer();
        NotificationPlugin.success({ title: '牛顿找货源完成', content: `状态 END，解析到 ${(d.items || []).length} 个 1688 商品链接` });
      } else if (d.status === 'WAIT_USER') {
        setPhase('waiting');
        setClarification(d.clarification || null);
        setAnswers((d.clarification?.questions || []).map(() => []));
        stopTimer();
        NotificationPlugin.info({ title: '牛顿需要补充信息', content: '请选择下方选项或文字回答后继续' });
      }
    } catch (e: any) {
      setErrMsg(e?.message || '网络错误');
    }
  };

  const startPolling = () => {
    stopTimer();
    timerRef.current = setInterval(pollOnce, 2500);
  };

  const send = async () => {
    if (!message.trim()) {
      MessagePlugin.warning({ content: '请输入找货源的需求描述' });
      return;
    }
    setBusy(true);
    setPhase('thinking');
    setContent('');
    setItems([]);
    setClarification(null);
    setErrMsg('');
    try {
      const r = await fetch('/api/ml/newton/sourcing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });
      const d = await r.json();
      if (!d.success || !d.taskId) {
        setPhase('error');
        setErrMsg(d.message || '创建任务失败');
        setBusy(false);
        return;
      }
      taskRef.current = { taskId: d.taskId, sessionId: d.sessionId };
      startPolling();
    } catch (e: any) {
      setPhase('error');
      setErrMsg(e?.message || '网络错误');
    } finally {
      setBusy(false);
    }
  };

  const submitAnswers = async () => {
    const task = taskRef.current;
    const cl = clarification;
    if (!task || !cl) return;
    // 优先用选项 selectedData；若都没选但有自由文本则用 userInput
    const hasSelection = answers.some((a) => (Array.isArray(a) ? a.length : !!a));
    let answer: any;
    if (hasSelection) {
      answer = { kind: 'selectedData', values: answers };
    } else if (freeText.trim()) {
      answer = { kind: 'userInput', text: freeText.trim() };
    } else {
      MessagePlugin.warning({ content: '请选择至少一个选项，或在下方用文字回答' });
      return;
    }
    setBusy(true);
    setPhase('thinking');
    try {
      const r = await fetch('/api/ml/newton/sourcing/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...task, toolCallId: cl.toolCallId, answer }),
      });
      const d = await r.json();
      if (!d.success) {
        setPhase('error');
        setErrMsg(d.message || '续跑失败');
        setBusy(false);
        return;
      }
      startPolling();
    } catch (e: any) {
      setPhase('error');
      setErrMsg(e?.message || '网络错误');
    } finally {
      setBusy(false);
    }
  };

  const adopt = (item: NewtonItem) => {
    const id = targetRowId || rows[0]?.itemId;
    if (!id) {
      MessagePlugin.warning({ content: '请先在上方选择要回填的货源行' });
      return;
    }
    updateRow(id, {
      sourcePriceCNY: Number(item.priceCNY) || 0,
      sourceLink: item.url || '',
      supplier: item.supplier || '',
      sourceTitle: item.title || '',
      sourceImages: item.imageUrl ? [item.imageUrl] : [],
    });
    NotificationPlugin.success({ title: '已采用牛顿货源', content: `已回填到行 ${id}（${item.priceCNY} CNY）` });
  };

  const rowOptions = rows.map((r) => ({ value: r.itemId, label: `${r.itemId} · ${(r.title || '').slice(0, 24) || '(无标题)'}` }));

  return (
    <Card title="云牛顿 · AI 智能找货源" style={{ marginBottom: 16 }}>
      <FeatureIntro
        title="牛顿是什么 / 怎么用"
        summary="牛顿是 1688 官方 AI 货源 Agent：用自然语言描述需求（品类/站点/预算/体积），它去1688帮你找跨境无货源货源，返回商品链接和进货价。"
        defaultOpen={false}
      >
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>在输入框写需求，例如「在1688找手机壳的跨境无货源货源，列2-3个商品链接和进货价」。</li>
          <li>牛顿可能直接返回结果，也可能先问预算/材质等（澄清卡），选完或文字回答后自动续跑。</li>
          <li>结果里的 1688 商品可「采用」回填到上方选中的货源行，参与利润测算与上架。</li>
        </ol>
      </FeatureIntro>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-start' }}>
        <Input
          value={message}
          onChange={(v) => setMessage(v as string)}
          placeholder="描述你的货源需求（自然语言）"
          style={{ flex: 1 }}
          autosize={{ minRows: 2, maxRows: 4 }}
        />
        <Button theme="primary" loading={busy} onClick={send}>
          发送需求
        </Button>
      </div>

      {rowOptions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <span style={{ color: '#888', fontSize: 13 }}>回填到行：</span>
          <Select
            value={targetRowId || (rows[0]?.itemId || '')}
            onChange={(v) => setTargetRowId(v as string)}
            options={rowOptions}
            style={{ width: 360 }}
          />
          <span style={{ color: '#888', fontSize: 12 }}>（采用货源时写入该行 sourcePriceCNY/链接/供应商）</span>
        </div>
      )}

      {phase === 'thinking' && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, color: '#888' }}>
          <Loading loading size="small" /> 牛顿正在思考/搜索中（约 30~120 秒）…
        </div>
      )}

      {phase === 'waiting' && clarification && (
        <div style={{ marginTop: 12, border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafafa' }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>牛顿需要补充信息：</div>
          {clarification.questions.map((q, qi) => (
            <div key={qi} style={{ marginBottom: 10 }}>
              <div style={{ marginBottom: 4 }}>{q.question}</div>
              {q.allowMultiple ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {q.options.map((opt) => {
                    const cur = (answers[qi] as string[]) || [];
                    const checked = cur.includes(opt);
                    return (
                      <Tag
                        key={opt}
                        theme={checked ? 'primary' : 'default'}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          const next = [...answers];
                          const set = new Set(cur);
                          if (set.has(opt)) set.delete(opt);
                          else set.add(opt);
                          next[qi] = [...set];
                          setAnswers(next);
                        }}
                      >
                        {opt}
                      </Tag>
                    );
                  })}
                </div>
              ) : (
                <Radio.Group
                  value={answers[qi] as string}
                  onChange={(v) => {
                    const next = [...answers];
                    next[qi] = v as string;
                    setAnswers(next);
                  }}
                >
                  {q.options.map((opt) => (
                    <Radio key={opt} value={opt}>
                      {opt}
                    </Radio>
                  ))}
                </Radio.Group>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <Input
              value={freeText}
              onChange={(v) => setFreeText(v as string)}
              placeholder="或在这里用文字直接回答（可选）"
              style={{ flex: 1 }}
            />
            <Button theme="primary" loading={busy} onClick={submitAnswers}>
              提交并继续
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && <div style={{ marginTop: 12, color: '#E34D59' }}>出错：{errMsg}</div>}

      {phase === 'done' && (
        <div style={{ marginTop: 12 }}>
          {content && (
            <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fff', whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto', fontSize: 13, lineHeight: 1.6 }}>
              {content}
            </div>
          )}
          <div style={{ marginTop: 10, fontWeight: 600 }}>解析到的 1688 货源（{items.length}）：</div>
          {items.length === 0 && <div style={{ color: '#888', marginTop: 4 }}>牛顿未返回可解析的 1688 商品链接（可能只给了文字建议）。</div>}
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((it, i) => (
              <div key={i} style={{ border: '1px solid #eee', borderRadius: 8, padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{it.title || '(无标题)'}</div>
                  <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>
                    进货价 ¥{it.priceCNY || '?'} · 起订 {it.moq || '?'} · {it.supplier || '供应商未知'}
                  </div>
                  <a href={it.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#0052d9', wordBreak: 'break-all' }}>
                    {it.url}
                  </a>
                </div>
                <Button size="small" theme="primary" variant="outline" onClick={() => adopt(it)}>
                  采用
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * server/i2v.ts
 * 图生视频（image-to-video）：用「AI 配置」里已启用的视频模型，把商品主图生成一段动态短视频。
 *
 * 用途：ml-finder 的视频链路最后兜底 —— 商品既没有 1688 源视频、服务器也没有历史备份时，
 * 用美客多商品主图现场生成一条，再转成 ML Clips 合规格式上传。
 *
 * 平台调用形态（2026-09 实测，详见 skill `china-i2v-video-gen`）：
 *  - 火山 ARK：POST {base}/contents/generations/tasks  → GET {base}/contents/generations/tasks/{id}
 *  - 智谱      ：POST {base}/videos/generations         → GET {base}/async-result/{id}
 *                （免费档 cogvideox-flash 会烧「AI生成」水印，归一化时裁掉底部 8%）
 *  - Agnes     ：POST {base}/video/generations（单数 video）→ GET {base}/videos/{id}
 *  - 其它 OpenAI 兼容：POST {base}/videos/generations → GET {base}/videos/{id}
 *
 * 失败要能说清原因：每个平台单独回报 HTTP 状态 + 原始响应片段，并做「永久性失败熔断」
 * （限额/无权限/余额不足/模型不存在），避免批量任务里每件商品都白等一轮。
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { getLlmProviders, detectProviderType, LlmProvider } from './aiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp', 'i2v');
const execFileAsync = promisify(execFile);

export interface I2VOutcome {
  ok: boolean;
  outputPath?: string;
  providerName?: string;
  model?: string;
  /** 生成平台（ark / zhipu / agnes / qiniu / generic） */
  platform?: string;
  /** 该平台需要裁掉底部水印的比例（智谱免费档） */
  cropBottomPct?: number;
  /** 原始片段时长（秒），失败时为 undefined */
  durationSec?: number;
  /** 逐平台尝试记录，失败时前端可看到每一步的具体原因 */
  attempts: Array<{ provider: string; model: string; platform: string; ok: boolean; stage: string; error?: string }>;
  error?: string;
}

type Platform = 'ark' | 'zhipu' | 'agnes' | 'qiniu' | 'generic';

function platformOf(p: LlmProvider): Platform {
  const u = (p.baseUrl || '').toLowerCase();
  if (u.includes('volces.com')) return 'ark';
  if (u.includes('bigmodel.cn')) return 'zhipu';
  if (u.includes('agnes-ai.com')) return 'agnes';
  if (u.includes('qnaigc.com')) return 'qiniu';
  return 'generic';
}

/** 永久性失败（换模型也没用）：熔断该平台，别在批量任务里反复等 */
const PERMANENT = /SetLimitExceeded|余额不足|无可用资源包|AccountOverdueError|overdue balance|InvalidEndpointOrModel|does not exist|无权限|not authorized|invalid api key|unauthorized|model_not_found|invalid mode/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============ 图片准备 ============

/**
 * 把商品主图压成 ≤1280px 的 JPEG 再 base64。
 * 为什么必须压：原图 3MB+ → base64 4MB，ARK 上传会直接 `The write operation timed out`；
 * 压到 720p/JPEG(q88) 约 250KB。
 */
export async function prepareImage(src: { url?: string; filePath?: string }): Promise<{
  b64: string;
  dataUri: string;
  tmpPath: string;
  error?: string;
}> {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let workPath = src.filePath || '';

  if (!workPath) {
    if (!src.url) return { b64: '', dataUri: '', tmpPath: '', error: '既没有图片 URL 也没有本地图片路径' };
    workPath = path.join(TMP_DIR, `src_${stamp}`);
    try {
      // 美客多图片 CDN 是公开的，但对 UA/Referer 敏感，用 curl 更稳
      await execFileAsync('curl', [
        '-s', '-L', '--max-time', '40', '-o', workPath,
        '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        src.url,
      ], { timeout: 45000 });
      const st = fs.statSync(workPath);
      if (st.size < 500) {
        const head = fs.readFileSync(workPath, 'utf-8').slice(0, 160);
        return { b64: '', dataUri: '', tmpPath: workPath, error: `主图下载失败（${st.size}B）：${head}` };
      }
    } catch (e: any) {
      return { b64: '', dataUri: '', tmpPath: workPath, error: `主图下载异常：${e?.message}` };
    }
  }

  const outPath = path.join(TMP_DIR, `img_${stamp}.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', workPath,
      '-vf', "scale='min(1280,iw)':-2",
      '-q:v', '4',
      outPath,
    ], { timeout: 30000 });
  } catch (e: any) {
    return { b64: '', dataUri: '', tmpPath: outPath, error: `主图转码失败：${String(e?.message || e).slice(0, 200)}` };
  }
  try {
    const buf = fs.readFileSync(outPath);
    const b64 = buf.toString('base64');
    return { b64, dataUri: `data:image/jpeg;base64,${b64}`, tmpPath: outPath };
  } catch (e: any) {
    return { b64: '', dataUri: '', tmpPath: outPath, error: `主图读取失败：${e?.message}` };
  }
}

// ============ 提交 / 轮询 ============

interface SubmitResult {
  ok: boolean;
  taskId?: string;
  /** 同步返回视频地址的情况 */
  directUrl?: string;
  error?: string;
  raw?: string;
}

async function submitTask(
  p: LlmProvider,
  platform: Platform,
  img: { b64: string; dataUri: string },
  prompt: string,
  durationSec: number,
): Promise<SubmitResult> {
  const base = (p.baseUrl || '').trim().replace(/\/+$/, '');
  let url = '';
  let body: any = {};

  if (platform === 'ark') {
    url = base.endsWith('/contents/generations/tasks') ? base : `${base}/contents/generations/tasks`;
    body = {
      model: p.model,
      content: [
        { type: 'text', text: `${prompt} --resolution 720p --duration ${durationSec} --watermark false` },
        { type: 'image_url', image_url: { url: img.dataUri } },
      ],
    };
  } else if (platform === 'zhipu') {
    url = `${base}/videos/generations`;
    // 智谱要求「纯 base64，不带 data: 前缀」
    body = { model: p.model, image_url: img.b64, prompt, quality: 'speed', with_audio: false, fps: 30 };
  } else if (platform === 'agnes') {
    // 实测：字段名是 image；路径是单数 /video/generations
    url = base.includes('/video/generations') ? base : `${base}/video/generations`;
    body = { model: p.model, image: img.dataUri, prompt, mode: 'ti2vid' };
  } else if (platform === 'qiniu') {
    url = base.includes('/videos') ? base : `${base}/videos`;
    body = { model: p.model, prompt, image: img.dataUri, mode: 'std' };
  } else {
    url = base.includes('/videos') ? base : `${base}/videos/generations`;
    body = { model: p.model, prompt, image: img.dataUri };
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const text = await resp.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!resp.ok && resp.status !== 202) {
      return { ok: false, error: `提交失败 HTTP ${resp.status}：${text.slice(0, 300)}`, raw: text };
    }
    const taskId = data?.id || data?.task_id || data?.data?.id || data?.output?.task_id;
    const directUrl = deepFindVideoUrl(data);
    if (!taskId && !directUrl) {
      return { ok: false, error: `提交返回中没有任务 id 或视频地址：${text.slice(0, 300)}`, raw: text };
    }
    return { ok: true, taskId: taskId ? String(taskId) : undefined, directUrl, raw: text };
  } catch (e: any) {
    return { ok: false, error: `提交异常：${e?.message || String(e)}` };
  }
}

/**
 * 在任意嵌套 JSON 里找视频地址。
 * 为什么不能写死字段名：各平台返回结构差异极大（agnes 实测顶层没有 video_url，
 * 视频地址藏在别的字段/数组里；写死字段名会得出「任务成功但没返回视频地址」的假失败）。
 * 策略：广度优先遍历，优先 key 含 video/url 的字符串值，其次任何像视频文件链接的字符串。
 */
function deepFindVideoUrl(root: any): string {
  const looksLikeVideo = (v: string) =>
    /^https?:\/\/\S+/i.test(v) && (/\.(mp4|mov|webm|m4v|m3u8)(\?|#|$)/i.test(v) || /video|\/videos?\//i.test(v));
  const seen = new Set<any>();
  const queue: Array<{ val: any; keyHint: string }> = [{ val: root, keyHint: '' }];
  const candidates: string[] = [];
  while (queue.length) {
    const { val, keyHint } = queue.shift()!;
    if (val === null || val === undefined) continue;
    if (typeof val === 'string') {
      if (looksLikeVideo(val)) {
        // key 里带 video 的优先返回，否则先记下来兜底
        if (/video|url|link|output|result/i.test(keyHint)) return val;
        candidates.push(val);
      }
      continue;
    }
    if (typeof val !== 'object') continue;
    if (seen.has(val)) continue;
    seen.add(val);
    if (Array.isArray(val)) {
      val.forEach((v, i) => queue.push({ val: v, keyHint }));
      continue;
    }
    for (const [k, v] of Object.entries(val)) {
      queue.push({ val: v, keyHint: k });
    }
  }
  return candidates[0] || '';
}

async function pollTask(
  p: LlmProvider,
  platform: Platform,
  taskId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; videoUrl?: string; error?: string; lastRaw?: string }> {
  const base = (p.baseUrl || '').trim().replace(/\/+$/, '');
  const urls =
    platform === 'ark'
      ? [base.endsWith('/contents/generations/tasks') ? `${base}/${taskId}` : `${base}/contents/generations/tasks/${taskId}`]
      : platform === 'zhipu'
        ? [`${base}/async-result/${taskId}`]
        : platform === 'agnes'
          ? [`${base}/videos/${taskId}`, `${base}/video/generations/${taskId}`]
          : [`${base}/videos/${taskId}`, `${base}/videos/generations/${taskId}`];

  const deadline = Date.now() + timeoutMs;
  let lastRaw = '';
  let urlIdx = 0;
  let delay = 5000;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.2), 12000);
    const url = urls[Math.min(urlIdx, urls.length - 1)];
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      const text = await resp.text();
      lastRaw = text.slice(0, 400);
      let d: any = {};
      try { d = JSON.parse(text); } catch { /* ignore */ }
      if (!resp.ok) {
        if (resp.status === 404 && urlIdx < urls.length - 1) { urlIdx++; continue; }
        if (resp.status === 429) continue; // 限流：继续等
        return { ok: false, error: `查询失败 HTTP ${resp.status}：${lastRaw}`, lastRaw };
      }
      const status = String(d?.status || d?.task_status || d?.state || '').toUpperCase();
      const videoUrl = deepFindVideoUrl(d);
      // 完成标志：显式 status，或平台用「完成时间 / 进度 100」表示（agnes 实测无 status，只有 completed_at）
      const done =
        ['SUCCESS', 'SUCCEEDED', 'SUCCESSFUL', 'OK', 'FINISHED', 'COMPLETED'].includes(status) ||
        !!d?.completed_at ||
        !!d?.finished_at ||
        Number(d?.progress) >= 100 ||
        (!status && !!videoUrl);
      if (done) {
        if (!videoUrl) {
          return { ok: false, error: `任务已完成但响应里找不到视频地址：${lastRaw}`, lastRaw };
        }
        return { ok: true, videoUrl, lastRaw };
      }
      if (['FAIL', 'FAILED', 'ERROR', 'CANCELED', 'CANCELLED'].includes(status)) {
        const msg = d?.error?.message || d?.error || d?.message || lastRaw;
        return { ok: false, error: `任务失败：${String(msg).slice(0, 300)}`, lastRaw };
      }
      // QUEUED / RUNNING / PROCESSING / IN_PROGRESS → 继续轮询
    } catch (e: any) {
      lastRaw = String(e?.message || e);
    }
  }
  return { ok: false, error: `等待超时（${Math.round(timeoutMs / 1000)}s 内未出片），最后状态：${lastRaw.slice(0, 200)}`, lastRaw };
}

// ============ 对外主函数 ============

export interface GenerateVideoOptions {
  imageUrl?: string;
  imagePath?: string;
  outPath: string;
  /** 目标时长（秒），默认 10（ML Clips 下限） */
  durationSec?: number;
  prompt?: string;
  /** 本次运行内已熔断的平台（批量任务复用，避免重复白等） */
  disabledPlatforms?: Set<string>;
}

const DEFAULT_PROMPT =
  '商品展示短视频：镜头极缓慢推近并轻微环绕，产品本体保持完全不变（外观、颜色、文字、Logo 一律不动），' +
  '背景光影与反光自然流动，整体干净明亮。画面里不要出现任何文字、水印、价格或联系方式。';

/** 把平台报错翻译成「下一步该做什么」 */
export function hintForError(err: string): string {
  const e = err || '';
  if (/AccountOverdueError|overdue balance|欠费/i.test(e)) return '火山方舟账号欠费，需到 ARK 控制台充值';
  if (/rate_limit_exceeded|reached the API rate limit/i.test(e)) return '该平台免费档限流，稍后重试或升级套餐';
  if (/余额不足|无可用资源包/i.test(e)) return '平台余额/资源包不足，需充值';
  if (/SetLimitExceeded/i.test(e)) return '火山账号处于「安全体验模式」，视频模型被暂停，需到 ARK 控制台关闭该模式';
  if (/InvalidEndpointOrModel|model_not_found|does not exist/i.test(e)) return '该账号没有这个模型的权限（在 ARK 控制台开通，或换一个模型）';
  if (/invalid mode/i.test(e)) return '接口 mode 取值不被支持，需换模型';
  if (/invalid api key|unauthorized|not authorized/i.test(e)) return 'API Key 无效或无权限';
  return '';
}

/** 当前配置里可用的视频模型（供前端提示「会用哪些平台生成」） */
export function listVideoProviders(): Array<{ name: string; model: string; platform: string }> {
  return getLlmProviders()
    .filter((p) => p.apiKey && detectProviderType(p.baseUrl, p.model) === 'video')
    .map((p) => ({ name: p.name || '', model: p.model, platform: platformOf(p) }));
}

/**
 * 用已配置的视频模型生成一段短视频。
 * 按「AI 配置」里的顺序逐个平台尝试（第一个跑通的就用它），全程记录每个平台的失败原因。
 */
export async function generateVideoFromImage(opts: GenerateVideoOptions): Promise<I2VOutcome> {
  const attempts: I2VOutcome['attempts'] = [];
  const durationSec = Math.max(5, Math.min(opts.durationSec || 10, 12));
  const prompt = opts.prompt || DEFAULT_PROMPT;
  const disabled = opts.disabledPlatforms || new Set<string>();

  const providers = getLlmProviders().filter(
    (p) => p.apiKey && (detectProviderType(p.baseUrl, p.model) === 'video'),
  );
  if (!providers.length) {
    return {
      ok: false,
      attempts,
      error: 'AI 配置里没有可用的「视频」模型，请到「配置中心 → AI 配置」添加（如 火山 arl Seedance / 智谱 cogvideox-flash）',
    };
  }

  const img = await prepareImage({ url: opts.imageUrl, filePath: opts.imagePath });
  if (!img.b64) {
    return { ok: false, attempts, error: `主图准备失败：${img.error || '未知原因'}` };
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });

  for (const p of providers) {
    const platform = platformOf(p);
    const name = p.name || `${platform}:${p.model}`;
    if (disabled.has(platform)) {
      attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'skip', error: `本次运行该平台已熔断（前一次失败为永久性错误）` });
      continue;
    }

    const sub = await submitTask(p, platform, img, prompt, durationSec);
    if (!sub.ok) {
      attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'submit', error: sub.error });
      if (sub.error && PERMANENT.test(sub.error)) disabled.add(platform);
      continue;
    }

    // 直接返回视频地址的情况（少数平台同步出片）
    let videoUrl = sub.directUrl || '';
    if (!videoUrl && sub.taskId) {
      const polled = await pollTask(p, platform, sub.taskId, 6 * 60 * 1000);
      if (!polled.ok) {
        attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'poll', error: polled.error });
        if (polled.error && PERMANENT.test(polled.error)) disabled.add(platform);
        continue;
      }
      videoUrl = polled.videoUrl || '';
    }
    if (!videoUrl) {
      attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'poll', error: '任务完成但没有视频地址' });
      continue;
    }

    try {
      await execFileAsync('curl', ['-s', '-L', '--max-time', '120', '-o', opts.outPath, videoUrl], { timeout: 130000 });
      const st = fs.statSync(opts.outPath);
      if (st.size < 5000) {
        attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'download', error: `视频下载异常（${st.size}B）` });
        continue;
      }
    } catch (e: any) {
      attempts.push({ provider: name, model: p.model, platform, ok: false, stage: 'download', error: `视频下载失败：${e?.message}` });
      continue;
    }

    attempts.push({ provider: name, model: p.model, platform, ok: true, stage: 'done' });
    return {
      ok: true,
      outputPath: opts.outPath,
      providerName: name,
      model: p.model,
      platform,
      // 智谱免费档有「AI生成」水印（纵向 95.0%~97.7%），归一化时裁掉底部 8%
      cropBottomPct: platform === 'zhipu' ? 0.08 : 0,
      attempts,
    };
  }

  const last = attempts[attempts.length - 1];
  const detail = attempts.map((a) => {
    const hint = hintForError(a.error || '');
    return `${a.provider}（${a.stage}）：${a.error}${hint ? `\n   👉 ${hint}` : ''}`;
  }).join('\n');
  return {
    ok: false,
    attempts,
    error: attempts.length
      ? `所有视频平台均失败：\n${detail}`
      : (last?.error || '所有视频平台均失败'),
  };
}

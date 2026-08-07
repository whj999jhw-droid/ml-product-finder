/**
 * AI 图像处理模块 — 通过 Python 子进程调用 rembg + Pillow
 *
 * 功能：
 *   1. removeBackground() — 用 rembg 移除背景（AI 模型，本地推理）
 *   2. enhanceImage() — 用 Pillow 增强亮度/对比度/锐度
 *   3. compositeOnWhite() — 将透明背景合成到白底上（ML 要求白底图）
 *   4. processImageAI() — 完整管线：去背 → 白底 → 增强 → 尺寸校正 → (水印)
 *
 * Python 路径：使用 managed venv（C:\Users\whj87\.workbuddy\binaries\python\envs\default）
 * 如果 venv 不存在或 rembg 未安装，函数会抛出可读错误，调用方可回退到普通水印模式。
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PYTHON_VENV = 'C:/Users/whj87/.workbuddy/binaries/python/envs/default/Scripts/python.exe';
const TMP_DIR = path.join(process.cwd(), 'data', 'img-ai-tmp');

function ensureTmp() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

function checkPythonAvailable(): boolean {
  return fs.existsSync(PYTHON_VENV);
}

/** 生成唯一临时文件名 */
function tmpFile(prefix: string, ext: string): string {
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  return path.join(TMP_DIR, name);
}

export interface ProcessImageAIOptions {
  /** 是否移除背景（默认 true） */
  removeBg?: boolean;
  /** 是否合成白底（默认 true，移除背景后自动白底） */
  whiteBg?: boolean;
  /** 是否增强（亮度/对比度/锐度，默认 true） */
  enhance?: boolean;
  /** 目标宽度（像素），保持比例缩放，默认 1000 */
  targetWidth?: number;
  /** 水印文字（可选） */
  watermarkText?: string;
}

export interface ProcessImageAIResult {
  success: boolean;
  buffer?: Buffer;
  error?: string;
}

/**
 * 生成一个独立的 Python 处理脚本文件到临时目录。
 * 这是正确做法：Python 用缩进表达代码块，不能用 `;` 把 if/else 拼成一行。
 */
function writeProcessScript(inFile: string, outFile: string, config: Record<string, any>): string {
  const scriptPath = tmpFile('proc', '.py');
  const inPath = inFile.replace(/\\/g, '/');
  const outPath = outFile.replace(/\\/g, '/');
  // 把配置以 JSON 文件形式传参，避免命令行注入与转义问题
  const cfgPath = tmpFile('cfg', '.json');
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const cfgPathSafe = cfgPath.replace(/\\/g, '/');

  const script = `
import json, sys
cfg = json.load(open(r'''${cfgPathSafe}''', 'r', encoding='utf-8'))

from PIL import Image, ImageEnhance, ImageDraw, ImageFont

try:
    img = Image.open(r'''${inPath}''').convert('RGBA')
except Exception as e:
    sys.stderr.write('open failed: %s' % e)
    sys.exit(1)

# 1. 去背景（AI 模型；失败则保留原图）
if cfg.get('remove_bg'):
    try:
        from rembg import remove
        img = remove(img)
        img = img.convert('RGBA')
    except Exception as e:
        sys.stderr.write('rembg failed: %s' % e)

# 2. 白底合成（ML 要求白底图）
if cfg.get('white_bg') and img.mode == 'RGBA':
    bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
    bg.paste(img, (0, 0), img)
    img = bg.convert('RGB')
else:
    img = img.convert('RGB')

# 3. 增强（亮度/对比度/锐度）
if cfg.get('enhance'):
    img = ImageEnhance.Brightness(img).enhance(1.08)
    img = ImageEnhance.Contrast(img).enhance(1.12)
    img = ImageEnhance.Sharpness(img).enhance(1.15)

# 4. 尺寸校正（按比例缩放到目标宽度，居中留白到 1:1 对 ML 更友好）
tw = int(cfg.get('target_width', 1000))
if img.width > tw:
    h = int(img.height * tw / img.width)
    img = img.resize((tw, h), Image.LANCZOS)

# 5. 水印（可选）
wm = cfg.get('watermark', '')
if wm:
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype('arial.ttf', max(16, img.width // 30))
    except Exception:
        f = ImageFont.load_default()
    bw, bh = d.textbbox((0, 0), wm, font=f)[2:]
    x = img.width - bw - 12
    y = img.height - bh - 8
    d.rectangle([x - 6, y - 4, x + bw + 6, y + bh + 4], fill=(0, 0, 0, 128))
    d.text((x, y), wm, fill=(255, 255, 255), font=f)

# 6. 保存
img.save(r'''${outPath}''', 'JPEG', quality=95)
print('OK')
`;
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return scriptPath;
}

/**
 * AI 图像处理完整管线：
 * 输入原始图片 Buffer → 去背景 → 白底合成 → 增强 → 尺寸校正 → (水印) → 输出 Buffer
 *
 * 失败时返回 { success: false, error }，调用方可回退到普通 jimp 水印模式。
 */
export async function processImageAI(
  inputBuf: Buffer,
  opts?: ProcessImageAIOptions
): Promise<ProcessImageAIResult> {
  if (!checkPythonAvailable()) {
    return { success: false, error: 'Python venv not found. Please install rembg and Pillow first.' };
  }

  ensureTmp();
  const inFile = tmpFile('in', '.jpg');
  const outFile = tmpFile('out', '.jpg');

  try {
    fs.writeFileSync(inFile, inputBuf);

    const config = {
      remove_bg: opts?.removeBg !== false,
      white_bg: opts?.whiteBg !== false,
      enhance: opts?.enhance !== false,
      target_width: opts?.targetWidth ?? 1000,
      watermark: opts?.watermarkText || '',
    };

    const scriptPath = writeProcessScript(inFile, outFile, config);

    // 首次运行 rembg 会下载模型（约 150MB），给足 180s 超时
    const { stderr } = await execFileAsync(PYTHON_VENV, [scriptPath], {
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stderr && 'Error' in stderr) {
      // rembg 的 warn 也会打到 stderr，仅当明确失败时返回错误
      return { success: false, error: `Python error: ${stderr.slice(0, 240)}` };
    }

    if (!fs.existsSync(outFile)) {
      return { success: false, error: 'Python did not produce output file' };
    }

    const outputBuf = fs.readFileSync(outFile);
    return { success: true, buffer: outputBuf };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Image AI processing failed' };
  } finally {
    // 清理临时文件（脚本、配置、输入输出）
    for (const f of [inFile, outFile]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
}

/**
 * 检查 rembg 是否已安装（用于前端显示可用性）
 */
export async function checkRembgAvailable(): Promise<{ available: boolean; error?: string }> {
  if (!checkPythonAvailable()) {
    return { available: false, error: 'Python venv not found' };
  }
  try {
    await execFileAsync(PYTHON_VENV, ['-c', "import rembg; print('ok')"], { timeout: 10000 });
    return { available: true };
  } catch (err: any) {
    return { available: false, error: err?.message || 'rembg not installed' };
  }
}

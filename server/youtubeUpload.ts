/**
 * YouTube 视频上传
 * 仅负责「把本地视频文件上传到 YouTube 并回写链接」，图生视频由外部服务生成后传入。
 *
 * 凭证存于 app_config 表（key: yt_client_id / yt_client_secret / yt_refresh_token），
 * 不在代码中硬编码。首次授权用 OAuth2 的 out-of-band 流程：
 *   1) GET /api/ml/youtube/auth-url 拿到授权链接
 *   2) 浏览器打开、同意，复制 code
 *   3) POST /api/ml/youtube/exchange { code } 换取 refresh_token 并保存
 * 之后上传用 refresh_token 静默拿 access_token，无需再次交互。
 */
import fs from 'fs';
import { google } from 'googleapis';
import { getAppConfig, setAppConfig } from './db.js';

const CFG = {
  clientId: 'yt_client_id',
  clientSecret: 'yt_client_secret',
  refreshToken: 'yt_refresh_token',
};

// out-of-band：适合无公网回调地址的服务器，用户手动复制 code
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function loadYouTubeConfig(): YouTubeConfig | null {
  const clientId = getAppConfig(CFG.clientId);
  const clientSecret = getAppConfig(CFG.clientSecret);
  const refreshToken = getAppConfig(CFG.refreshToken);
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export function isYouTubeConfigured(): boolean {
  return loadYouTubeConfig() !== null;
}

function makeOAuth2(cfg: Pick<YouTubeConfig, 'clientId' | 'clientSecret'>) {
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, REDIRECT_URI);
}

/** 保存 client_id / client_secret（尚未拿到 refresh_token 时） */
export function saveYouTubeClient(clientId: string, clientSecret: string): void {
  setAppConfig(CFG.clientId, clientId.trim());
  setAppConfig(CFG.clientSecret, clientSecret.trim());
}

/** 生成首次授权链接（需先保存 client_id/secret） */
export function buildAuthUrl(): string {
  const cfg = loadYouTubeConfig();
  if (!cfg?.clientId || !cfg?.clientSecret) {
    throw new Error('请先保存 YouTube 的 client_id 与 client_secret');
  }
  const oauth2 = makeOAuth2(cfg);
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // 强制返回 refresh_token
    scope: SCOPES,
  });
}

/** 用浏览器返回的 code 换取 refresh_token 并保存 */
export async function exchangeCodeForRefreshToken(code: string): Promise<string> {
  const cfg = loadYouTubeConfig();
  if (!cfg?.clientId || !cfg?.clientSecret) {
    throw new Error('请先保存 YouTube 的 client_id 与 client_secret');
  }
  const oauth2 = makeOAuth2(cfg);
  const { tokens } = await oauth2.getToken(code.trim());
  if (!tokens.refresh_token) {
    throw new Error('未返回 refresh_token（请确认授权链接使用了 prompt=consent，且同一账号未重复授权）');
  }
  setAppConfig(CFG.refreshToken, tokens.refresh_token);
  return tokens.refresh_token;
}

export interface UploadVideoOptions {
  filePath: string;
  title: string;
  description?: string;
  tags?: string[];
  privacy?: 'private' | 'unlisted' | 'public';
}

export interface UploadVideoResult {
  videoId: string;
  url: string;
}

/** 上传本地视频到 YouTube，返回视频链接 */
export async function uploadVideoToYouTube(opts: UploadVideoOptions): Promise<UploadVideoResult> {
  const cfg = loadYouTubeConfig();
  if (!cfg) throw new Error('YouTube 未配置（缺少 client_id/secret/refresh_token）');
  if (!opts.filePath || !fs.existsSync(opts.filePath)) {
    throw new Error(`视频文件不存在: ${opts.filePath}`);
  }
  if (!opts.title?.trim()) throw new Error('视频标题不能为空');

  const oauth2 = makeOAuth2(cfg);
  oauth2.setCredentials({ refresh_token: cfg.refreshToken });
  const youtube = google.youtube({ version: 'v3', auth: oauth2 });

  const res = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: {
          title: opts.title,
          description: opts.description || '',
          tags: opts.tags || [],
        },
        status: { privacyStatus: opts.privacy || 'unlisted' },
      },
      media: { body: fs.createReadStream(opts.filePath) },
    },
    { onUploadProgress: (evt: any) => {
      const pct = evt?.bytesRead && evt?.params?.lengthComputancy
        ? Math.round((evt.bytesRead / evt.params.lengthComputancy) * 100)
        : 0;
      if (pct && pct % 25 === 0) console.log(`[YouTube] 上传进度 ${pct}%`);
    } }
  );

  const videoId = res.data.id;
  if (!videoId) throw new Error('YouTube 未返回 videoId');
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

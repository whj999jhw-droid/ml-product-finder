/**
 * 公网隧道管理（localtunnel）
 * 用于为本地 OAuth2 回调提供 HTTPS 公网地址
 */

import localtunnel from 'localtunnel';

export interface TunnelInfo {
  url: string;
  callbackUrl: string;
  startedAt: string;
}

let tunnelInstance: localtunnel.Tunnel | null = null;
let tunnelInfo: TunnelInfo | null = null;

// 固定子域名：让隧道 URL 在多次重启后保持不变，避免每次都要重配 ML 控制台
// 若该子域名被占用，localtunnel 会分配随机名（此时需重新配置 ML）
const FIXED_SUBDOMAIN = process.env.ML_TUNNEL_SUBDOMAIN || 'ml-product-finder-mx';

/**
 * 启动隧道，将本地 HTTP 后端暴露为公网 HTTPS
 */
export async function startTunnel(port: number = 3000): Promise<TunnelInfo> {
  if (tunnelInstance) {
    return tunnelInfo!;
  }

  // 优先尝试固定子域名，失败则退回随机子域名
  try {
    tunnelInstance = await localtunnel({ port, subdomain: FIXED_SUBDOMAIN });
    if (!tunnelInstance.url.includes(FIXED_SUBDOMAIN)) {
      console.warn(`[Tunnel] 固定子域名 ${FIXED_SUBDOMAIN} 未分配成功，使用随机地址`);
    }
  } catch (e) {
    console.warn('[Tunnel] 固定子域名请求失败，退回随机子域名:', (e as Error).message);
    tunnelInstance = await localtunnel({ port });
  }

  const callbackUrl = `${tunnelInstance.url}/api/ml/oauth/store-callback`;
  tunnelInfo = {
    url: tunnelInstance.url,
    callbackUrl,
    startedAt: new Date().toISOString(),
  };

  console.log(`[Tunnel] 公网隧道已启动: ${tunnelInstance.url}`);
  console.log(`[Tunnel] OAuth 回调地址: ${callbackUrl}`);

  tunnelInstance.on('close', () => {
    console.log('[Tunnel] 公网隧道已关闭');
    tunnelInstance = null;
    tunnelInfo = null;
  });

  tunnelInstance.on('error', (err) => {
    console.error('[Tunnel] 隧道错误:', err);
    tunnelInstance = null;
    tunnelInfo = null;
  });

  return tunnelInfo;
}

/**
 * 关闭隧道
 */
export function stopTunnel(): void {
  if (tunnelInstance) {
    tunnelInstance.close();
    tunnelInstance = null;
    tunnelInfo = null;
  }
}

/**
 * 获取当前隧道信息
 */
export function getTunnelInfo(): TunnelInfo | null {
  return tunnelInfo;
}

/**
 * 隧道是否运行中
 */
export function isTunnelRunning(): boolean {
  return tunnelInstance !== null && tunnelInfo !== null;
}

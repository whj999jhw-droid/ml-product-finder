// 独立代理诊断脚本（不依赖 App，直接验证真实代理地址）
// 用法（在项目根目录 ml-product-finder/ 下执行）：
//   node server/diag-proxy.mjs "http://用户名:密码@proxy.proxying.io:8080"
//   node server/diag-proxy.mjs "http://用户名-country-mx:密码@proxy.proxying.io:8080"
//   node server/diag-proxy.mjs "socks5://登录名__cr.mx:密码@gw.dataimpulse.com:824"
import https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const proxyUrl = process.argv[2];
if (!proxyUrl) {
  console.error('用法: node server/diag-proxy.mjs "<代理URL>"');
  process.exit(1);
}

function makeAgent(u) {
  return u.startsWith('socks') ? new SocksProxyAgent(u) : new HttpsProxyAgent(u);
}

function req(opts) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(20000, () => { r.destroy(); reject(new Error('请求超时')); });
    r.end();
  });
}

(async () => {
  const agent = makeAgent(proxyUrl);
  console.log('代理(已打码):', proxyUrl.replace(/\/\/.*@/, '//***:***@'));

  // 1) 先确认代理本身通 + 出口国家（这一步能区分：连不上 vs 认证失败 vs 正常）
  try {
    const ip = await req({
      hostname: 'ip-api.com', path: '/json', method: 'GET',
      headers: { 'User-Agent': 'curl/8.0' }, agent, timeout: 20000,
    });
    console.log('\n[1] ip-api.com 状态:', ip.status);
    console.log('    出口信息:', ip.body.slice(0, 400));
    if (ip.status === 200) {
      const j = JSON.parse(ip.body);
      console.log(`    → 代理生效，出口国家: ${j.country} (${j.countryCode})，ISP: ${j.isp}`);
      if (j.countryCode !== 'MX') console.log('    ⚠️ 出口不是墨西哥，抓 MLM 可能仍被限，建议用 -country-mx / __cr.mx');
    }
  } catch (e) {
    console.log('\n[1] ip-api.com 失败:', e.message);
    console.log('    → 代理本身连不上/认证失败。407 = 用户名密码或格式错；ECONNREFUSED = 端点/端口错；超时 = 网络或被墙');
  }

  // 2) 测 ML 分类接口（与 App“测试连通”同一目标）
  try {
    const ml = await req({
      hostname: 'api.mercadolibre.com', path: '/sites/MLM/categories', method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, agent, timeout: 20000,
    });
    console.log('\n[2] ML /sites/MLM/categories 状态:', ml.status);
    console.log('    返回前 200 字符:', ml.body.slice(0, 200));
    if (ml.status === 200) console.log('    ✅ 代理 + ML 都通，可以回 App 保存代理并开始抓取');
    else if (ml.status === 403) console.log('    ⚠️ 403：代理通了但 ML 仍封锁——确认出口国家是 MX/BR/CL/CO');
    else if (ml.status === 407) console.log('    ❌ 407：代理拒绝认证——用户名/密码/国家码格式错');
  } catch (e) {
    console.log('\n[2] ML 失败:', e.message);
  }
})();

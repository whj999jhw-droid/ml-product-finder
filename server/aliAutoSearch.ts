/**
 * 1688 免密钥自动找同款（best-effort）
 *
 * 用途：未配置 1688 开放平台密钥（ML_1688_APPKEY/SECRET/TOKEN）时，用本机浏览器
 * 走 1688 关键词搜索，自动抓回首条货源的进货价 / MOQ / 供应商 / 链接，回填到 M2 表格。
 *
 * 合规：只抓取「供应商的客观供货信息」（价格、起订量、商家名、链接）用于卖家自己的
 * 货源决策；绝不把 1688 商品图/描述原样搬到美客多 Listing（那属于盗用他人素材）。
 *
 * 质量说明：
 *  - 关键词搜索远不如「开放平台 API 的以图搜货」准确，且 1688 对无登录的自动化
 *    浏览器可能弹验证/登录墙。因此本函数是「免密钥兜底」，推荐优先走 /api/ml/sourcing/1688/search（API 图搜）。
 *  - 1688 商品以中文为主，建议传入中文品名（keyword）。直接拿西/葡语竞品标题搜效果较差。
 */

export interface AliAutoItem {
  title: string;
  priceCNY: number;
  moq: number;
  supplier: string;
  url: string;
  /** 货源主图 URL（供应商图，可用于自动配图；非美客多竞品图） */
  imageUrl?: string;
}

export interface AliAutoResult {
  available: boolean;
  message: string;
  items?: AliAutoItem[];
  /** 是否被 1688 验证/登录墙拦截 */
  blocked?: boolean;
}

export async function autoSearch1688ByKeyword(keyword: string): Promise<AliAutoResult> {
  const kw = (keyword || '').trim();
  if (!kw) return { available: false, message: '未提供搜索关键词' };

  let chromium: any;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e: any) {
    return {
      available: false,
      message:
        '未安装 Playwright（npm install playwright），无法使用免密钥搜索。建议：① 配置 1688 开放平台密钥走 /api/ml/sourcing/1688/search（图搜更准）；② 在本机登录 1688 后手动图搜。',
    };
  }

  let browser: any;
  const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
  try {
    // 优先用本机已安装的 Edge（无需匹配 Playwright 的 chromium 版本）
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: launchArgs });
  } catch (e: any) {
    try {
      browser = await chromium.launch({ headless: true, args: launchArgs });
    } catch (e2: any) {
      return {
        available: false,
        message: `无法启动浏览器（Edge 或 Playwright Chromium 均失败）：${(e2 as any)?.message || ''}。请改用 1688 开放平台 API。`,
      };
    }
  }

  const items: AliAutoItem[] = [];
  let blocked = false;
  let msg = '';

  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });
    const page = await ctx.newPage();
    // 拦截图片/字体等，加快加载
    await page.route('**/*', (route: any) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort().catch(() => {});
      return route.continue().catch(() => {});
    });

    const url = `https://s.1688.com/?keywords=${encodeURIComponent(kw)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.waitForSelector('.sm-offer-item, .offer-item, .list-item, .offer-list', { timeout: 15000 });
    } catch {
      /* 可能触发验证墙，下面再判断 */
    }

    const html: string = await page.content();
    if (/滑动验证|请拖动|验证|anti\-spider|账号登录|请登录/.test(html)) {
      blocked = true;
    }

    const cards = await page.$$('.sm-offer-item, .offer-item, .list-item');
    for (const card of cards.slice(0, 10)) {
      try {
        const title = (
          (await card.$eval('.title, .offer-title, a.title, .name', (el: any) => el.textContent?.trim()).catch(() => '')) || ''
        ).replace(/\s+/g, ' ');
        const priceText =
          (await card.$eval('.price, .price-num, .sm-offer-price, .price-info', (el: any) => el.textContent?.trim()).catch(() => '')) || '';
        const priceCNY = parseFloat((priceText.replace(/[^\d.]/g, '').match(/[\d.]+/) || ['0'])[0]) || 0;
        const moqText =
          (await card.$eval('.moq, .min-order-quantity, .quantity, .min-num', (el: any) => el.textContent?.trim()).catch(() => '')) || '';
        const moq = parseInt((moqText.replace(/[^\d]/g, '').match(/\d+/) || ['1'])[0]) || 1;
        const supplier = (
          (await card.$eval('.supplier-name, .company-name, .shop-name, .company', (el: any) => el.textContent?.trim()).catch(() => '')) || ''
        ).replace(/\s+/g, ' ');
        const href = (await card.$eval('a', (el: any) => el.href).catch(() => '')) || '';
        const itemUrl = href.startsWith('http') ? href : href ? `https:${href}` : '';
        const img = (await card.$eval('.offer-img img, img', (el: any) => el.src).catch(() => '')) || '';
        if (title) items.push({ title, priceCNY, moq, supplier, url: itemUrl, imageUrl: img });
      } catch {
        /* 单卡解析失败跳过 */
      }
    }

    if (items.length > 0) {
      msg = `找到 ${items.length} 条货源`;
    } else if (blocked) {
      msg =
        '1688 触发了验证/登录墙，免密钥搜索被拦截。建议：① 配置 1688 开放平台密钥走 /api/ml/sourcing/1688/search（以图搜货更准）；② 在本机登录 1688 后手动图搜。';
    } else {
      msg = '未在 1688 搜索结果中解析到货源（可能页面结构变化或被拦截）。建议改用 1688 开放平台 API 或手动搜索。';
    }
  } catch (e: any) {
    msg = `搜索异常：${e?.message || ''}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { available: items.length > 0, message: msg, items, blocked };
}

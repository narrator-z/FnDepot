// 以 CDP 调试端口启动 Loomy 持久化浏览器会话
// 用法: node cdp-launch.js
// 作用: 用无头 headless 方式后台保持会话，供代理复用；首次需在浏览器登录
const { chromium } = require('playwright');
const path = require('path');

// profile 目录：容器化时指向挂载卷（持久化登录态），否则落在脚本旁
const UDD = process.env.LOOMY_PROFILE_DIR || path.join(__dirname, 'loomy-profile');
const PORT = process.env.CDP_PORT || 9222;

// 无头开关：桌面端默认有头（便于登录/调试），无头 Linux 设 LOOMY_HEADLESS=1
const HEADLESS = process.env.LOOMY_HEADLESS === '1' || process.env.LOOMY_HEADLESS === 'true';
// 容器/root 用户跑 Chromium 必须 --no-sandbox，设 LOOMY_NO_SANDBOX=1 开启
const NO_SANDBOX = process.env.LOOMY_NO_SANDBOX === '1' || process.env.LOOMY_NO_SANDBOX === 'true';
const args = [`--remote-debugging-port=${PORT}`];
if (NO_SANDBOX) args.push('--no-sandbox', '--disable-setuid-sandbox');

(async () => {
  const ctx = await chromium.launchPersistentContext(UDD, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log(`[launch] CDP 端口 ${PORT}，profile=${UDD}`);
  console.log('[launch] 打开 Loomy Web ...');
  await page.goto('https://loomy.xunfei.cn/web', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('[launch] 加载警告:', e.message));
  console.log('[launch] 就绪。保持运行中，供代理复用。Ctrl+C 停止。');
})();
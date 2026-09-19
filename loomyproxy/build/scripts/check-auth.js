// 通过 CDP 连接现有 Loomy 浏览器，检查登录态
// 用法: node check-auth.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctxs = browser.contexts();
  const ctx = ctxs[0];
  const pages = ctx.pages();
  const page = pages[0];
  console.log('当前页面:', page.url());

  const r = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 600) };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('=== /api/auth/me ===');
  console.log(JSON.stringify(r, null, 2));

  // 列出 cookies（确认是否已登录）
  const cookies = await ctx.cookies();
  console.log('\n=== cookies (' + cookies.length + ') ===');
  console.log(cookies.map(c => c.name + '=' + (c.value||'').slice(0,20)).join('\n'));

  await browser.close();
})();
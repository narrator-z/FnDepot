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
// 渲染减负开关：默认关闭（0），保持与 1.0.x 完全一致的行为。
// 打开（1）会禁用软件 GPU / 光栅化 / 2D 加速画布，实测可把空闲常驻 CPU 从 25~60%（单核口径）
// 压到 5% 以下，并消除 SwiftShader 着色器缓存带来的磁盘写放大。
// 风险：若 Loomy 页面依赖 WebGL/Canvas 做视觉渲染，打开后可能出现界面异常。
// 因此做成开关而非硬编码——出问题可在应用向导里改回 0，无需重新出镜像。
const DISABLE_GPU = process.env.LOOMY_DISABLE_GPU === '1' || process.env.LOOMY_DISABLE_GPU === 'true';

const args = [`--remote-debugging-port=${PORT}`];
if (NO_SANDBOX) args.push('--no-sandbox', '--disable-setuid-sandbox');
if (DISABLE_GPU) {
  args.push(
    '--disable-gpu',                    // 关掉 GPU 进程（容器内本就无 GPU，走的是 SwiftShader 软件渲染）
    '--disable-software-rasterizer',    // 关掉软件光栅化，消除 GrShaderCache 反复落盘
    '--disable-accelerated-2d-canvas',
    '--disable-gpu-compositing',
    '--disable-lcd-text',
    '--force-device-scale-factor=1',
  );
}

(async () => {
  const ctx = await chromium.launchPersistentContext(UDD, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  console.log(`[launch] CDP 端口 ${PORT}，profile=${UDD}`);
  console.log(`[launch] 渲染减负(LOOMY_DISABLE_GPU)=${DISABLE_GPU ? '开' : '关'}${DISABLE_GPU ? ' -> ' + args.filter(a => a.startsWith('--disable-gpu') || a.includes('rasterizer')).join(' ') : ''}`);
  console.log('[launch] 打开 Loomy Web ...');
  await page.goto('https://loomy.xunfei.cn/web', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => console.log('[launch] 加载警告:', e.message));
  console.log('[launch] 就绪。保持运行中，供代理复用。Ctrl+C 停止。');
})();
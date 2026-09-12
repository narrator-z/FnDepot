#!/usr/bin/env bash
# 在容器内执行的构建脚本（由 build/build-server.sh 挂载进 node:22-slim 镜像调用）。
#
# 职责：
#   1) 安装依赖（Linux + glibc，原生模块可用）
#   2) electron-vite build → out/main（主进程）、out/renderer（前端）
#   3) 产出落位：
#        out/renderer/*  → /out/public/     （管理界面静态文件，直接可用）
#        out/main/*      → /out/core/raw/   （主进程编译产物，待 IPC→HTTP 改造）
#        *.wasm          → /out/core/
#   4) 生成 core/index.js 适配器骨架

set -euo pipefail

SRC="${SRC_DIR:-/src}"
OUT="${OUT_DIR:-/out}"

echo "==== build-inner 开始 ===="
echo "SRC=$SRC OUT=$OUT node=$(node -v)"

cd "$SRC"

# ---------- 1. 安装依赖 ----------
# ELECTRON_SKIP_BINARY_DOWNLOAD=1：跳过 Electron 二进制下载（fnOS 上不启动 GUI，
# 这个包几百 MB 且下载极慢，纯属浪费）。electron 包本身仍会装，源码 require 它不报错。
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export CYPRESS_INSTALL_BINARY=0

echo "---- npm install ----"
if npm install --no-audit --no-fund 2>&1 | tail -20; then
    echo "依赖安装完成"
else
    echo "WARN: 完整安装失败，改用 --ignore-scripts 后单独重建原生模块"
    npm install --no-audit --no-fund --ignore-scripts 2>&1 | tail -10
    # canvas 是本项目唯一的重量级原生模块，缺了它部分功能不可用
    npm rebuild canvas 2>&1 | tail -5 || echo "WARN: canvas 重建失败，继续（非致命）"
fi

# ---------- 2. 构建 ----------
# 直接用 electron-vite build，跳过 npm run build 里的 check:source-artifacts
# （该检查针对发布流程，构建产物场景可能误报）
echo "---- electron-vite build ----"
npx electron-vite build 2>&1 | tail -30

# ---------- 3. 产出落位 ----------
mkdir -p "$OUT/public" "$OUT/core"

# 清空上一轮的前端产物：electron-vite 输出的 JS/CSS 带内容 hash，
# 不清会越攒越多（旧版本文件永远留着，包越来越大且可能命中过期资源）。
if [ -n "${OUT:-}" ] && [ "$OUT" != "/" ]; then
    rm -rf "$OUT/public"
    mkdir -p "$OUT/public"
fi

if [ -d "$SRC/out/renderer" ]; then
    cp -r "$SRC/out/renderer/." "$OUT/public/"
    echo "前端产物 → $OUT/public"
else
    echo "WARN: 未找到 out/renderer，前端产物缺失"
fi

if [ -d "$SRC/out/main" ]; then
    rm -rf "$OUT/core/raw"
    mkdir -p "$OUT/core/raw"
    cp -r "$SRC/out/main/." "$OUT/core/raw/"
    echo "主进程产物 → $OUT/core/raw"
else
    echo "WARN: 未找到 out/main，主进程产物缺失"
fi

# sha3 wasm：extraResources 里声明过，运行时按文件名加载，必须一并带走
find "$SRC" -maxdepth 1 -name 'sha3_wasm_bg.*.wasm' -exec cp {} "$OUT/core/" \; 2>/dev/null || true
if ls "$OUT/core"/*.wasm >/dev/null 2>&1; then
    echo "wasm → $OUT/core"
fi

# 运行时依赖：先 prune 掉 devDependencies（electron 等几百 MB，fnOS 上不需要），
# 再整体带走。必须在 build 之后执行 —— 构建本身依赖 electron-vite 这类 devDep。
echo "---- 提取运行时依赖 ----"
npm prune --omit=dev 2>&1 | tail -3 || echo "WARN: npm prune 失败，将带走完整 node_modules"
if [ -d "$SRC/node_modules" ]; then
    rm -rf "$OUT/node_modules"
    mkdir -p "$OUT/node_modules"
    cp -r "$SRC/node_modules/." "$OUT/node_modules/" 2>/dev/null || echo "WARN: node_modules 复制不完整"
    echo "依赖 → $OUT/node_modules ($(du -sh "$OUT/node_modules" 2>/dev/null | cut -f1))"
else
    echo "WARN: 未找到 node_modules"
fi

# ---------- 4. core/index.js 适配器骨架 ----------
# server-entry.js 的逻辑：core/index.js 存在则 require，并检查是否导出了
# handleManagement / handleApi。未完成改造时这里导出 null，服务端自动回退占位实现，
# 因此骨架包始终可用，不会因改造未完成而崩溃。
cat > "$OUT/core/index.js" <<'COREEOF'
// 由 build/build-inner.sh 生成 —— 每次构建会被覆盖，请勿在此写业务代码。
//
// 接入方式：
//   把 IPC→HTTP 改造后的服务端入口写成同目录的 adapter.js，导出：
//     module.exports = {
//       handleManagement(req, res, ctx) {},  // 管理界面 /api/*（Unix Socket 侧）
//       handleApi(req, res, ctx) {}          // OpenAI 兼容 /v1/*（TCP 26800 侧）
//     };
//   本文件会自动转交；adapter.js 不存在时导出 null，服务端回退占位实现。
'use strict';

const fs = require('fs');
const path = require('path');

const ADAPTER = path.join(__dirname, 'adapter.js');

if (fs.existsSync(ADAPTER)) {
  try {
    module.exports = require(ADAPTER);
  } catch (err) {
    console.error('[chat2api] core adapter 加载失败，回退占位实现:', err && err.message);
    module.exports = null;
  }
} else {
  module.exports = null;
}
COREEOF

cat > "$OUT/core/adapter.example.js" <<'ADAPTEREOF'
// 改造模板：把 Electron 主进程的 Koa 代理与 IPC handler 搬到纯 Node.js 环境。
//
// 改造原则（切勿重写业务逻辑）：
//   1) 只换传输层。把 ipcMain.handle(name, handler) 里的 handler 抽成纯函数，
//      Koa 路由直接包装同一个函数，业务代码零改动。
//   2) 剥离 electron：store 改用 conf/electron-store 的纯 Node 分支（原版 fnOS 包
//      已验证过这条路），tray / window / updater / preload 整体移除。
//   3) 数据目录统一用 ctx 传入的 CHAT2API_DATA_DIR，不要写死路径。
'use strict';

module.exports = {
  // 管理界面：网关已校验 NAS 登录态，ctx.user 即 X-Trim-* 解析结果
  handleManagement(req, res, ctx) {
    // ctx: { pathname, user, sendJson, readBody }
    ctx.sendJson(res, 501, { error: 'adapter 尚未实现' });
  },

  // OpenAI 兼容 API：由外部客户端直连 TCP 26800，需自行校验 API Key
  handleApi(req, res, ctx) {
    // ctx: { pathname, sendJson, readBody }
    ctx.sendJson(res, 501, { error: 'adapter 尚未实现' });
  }
};
ADAPTEREOF

echo "core 适配器骨架 → $OUT/core/"
echo "==== build-inner 结束 ===="

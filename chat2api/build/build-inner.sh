#!/usr/bin/env bash
# 在 Linux/容器中执行的构建脚本（由 build/build-server.sh 挂载进 node:22-bookworm-slim
# 镜像，或由 .github/workflows/build-chat2api.yml 在 node:22-bookworm-slim 容器内调用）。
#
# 职责：
#   1) 安装依赖（Linux + glibc，原生模块可用）
#   2) 注入 fnOS 适配 shim：
#        - electron            → 纯 Node 替身（electron-node.ts）
#        - electron-updater    → no-op stub
#        - fnos-entry          → core-dev 提供的主进程入口（缺失则跳过）
#        - inject-renderer.sh  → ui-dev 提供的 renderer web-ipc 注入（缺失则跳过）
#   3) 生成 fnOS 专用 vite 配置（electron.vite.fnos.config.ts）并执行
#        npx electron-vite build -c electron.vite.fnos.config.ts
#      产出 out/main（主进程 CJS）、out/renderer（前端）
#   4) 落位：
#        out/renderer/*  → /out/public/     （管理界面静态文件，直接可用）
#        out/main/*      → /out/core/raw/   （主进程编译产物，含 fnos-entry）
#        *.wasm          → /out/core/
#   5) 把 build/shim/adapter.js 复制到 /out/core/adapter.js（team-lead 负责，缺则告警）
#   6) npm prune --omit=dev 后把 node_modules 复制到 /out/node_modules
#   7) 生成 core/index.js 适配器骨架（逻辑由 server-entry.js 引用）
#   8) 产物完整性校验 + 末尾汇总

set -euo pipefail

SRC="${SRC_DIR:-/src}"
OUT="${OUT_DIR:-/out}"
# shim 目录：默认取本脚本同级的 shim/；可用 SHIM_DIR 覆盖
# （Docker 挂载路径、CI checkout 路径与本脚本位置不同，需显式指定）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_DIR="${SHIM_DIR:-$SCRIPT_DIR/shim}"

echo "==== build-inner 开始 ===="
echo "SRC=$SRC OUT=$OUT SHIM_DIR=$SHIM_DIR node=$(node -v) npm=$(npm -v)"

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
  npm install --no-audit --no-fund --ignore-scripts 2>&1 | tail -10 || echo "WARN: --ignore-scripts 安装也失败，继续尝试构建"
  # canvas 在源码里实际未被真正引用（仅 tray 里一个 Buffer 变量名），带上纯属防御。
  # 若装不上也不致命：构建与运行都不依赖它。
  npm rebuild canvas 2>&1 | tail -5 || echo "WARN: canvas 重建失败，继续（非致命）"
fi

# ---------- 2. 注入 fnOS shim（electron / electron-updater / fnos-entry）----------
echo "---- 准备 fnOS shim ----"
SHIM_OK=1

ELECTRON_SHIM_SRC="$SHIM_DIR/electron-node.ts"
if [ -f "$ELECTRON_SHIM_SRC" ]; then
  cp "$ELECTRON_SHIM_SRC" "$SRC/src/main/electron-node.ts"
  echo "  ✓ electron 替身 → src/main/electron-node.ts"
else
  echo "  ✗ 未找到 $ELECTRON_SHIM_SRC（electron 替代实现缺失，构建将失败）"
  SHIM_OK=0
fi

# vite alias 把 'electron-updater' 指向 src/main/electron-updater-stub.ts（见下方配置），
# 因此这里必须复制 .ts 版本，否则 alias 目标缺失、构建直接失败。
# 若 .ts 缺失则回退 .js（避免 shim 只提供了 .js 的情况），并同步修正目标扩展名。
if [ -f "$SHIM_DIR/electron-updater-stub.ts" ]; then
  UPDATER_STUB_SRC="$SHIM_DIR/electron-updater-stub.ts"
  UPDATER_STUB_DST="$SRC/src/main/electron-updater-stub.ts"
elif [ -f "$SHIM_DIR/electron-updater-stub.js" ]; then
  UPDATER_STUB_SRC="$SHIM_DIR/electron-updater-stub.js"
  UPDATER_STUB_DST="$SRC/src/main/electron-updater-stub.js"
else
  UPDATER_STUB_SRC=""
fi
if [ -n "$UPDATER_STUB_SRC" ]; then
  cp "$UPDATER_STUB_SRC" "$UPDATER_STUB_DST"
  echo "  ✓ electron-updater stub → $UPDATER_STUB_DST"
else
  echo "  ✗ 未找到 $SHIM_DIR/electron-updater-stub.{ts,js}（electron-updater 替身缺失，构建将失败）"
  SHIM_OK=0
fi

# core-dev 提供的新主进程入口。放到 src/main/ 与 index.ts 同级，
# 其相对 import（如 './proxy/server'）可直接对上；若 core-dev 用了别的层级，
# 需用 sed 修正这里的相对路径。缺失则跳过，仅构建原 index 入口以跑通。
FNOS_ENTRY_SRC="$SHIM_DIR/fnos-entry.ts"
if [ -f "$FNOS_ENTRY_SRC" ]; then
  cp "$FNOS_ENTRY_SRC" "$SRC/src/main/fnos-entry.ts"
  echo "  ✓ fnos-entry → src/main/fnos-entry.ts"
else
  echo "  ⚠ 未找到 $FNOS_ENTRY_SRC（core-dev 尚未交付）。将仅构建原 index 入口，fnos-entry 产物暂缺。"
fi

# ---------- 2.5 运行期 electron 替身包 ----------
# electron-vite 的 main 构建把 `electron` 当 external，产物 CJS 会原样保留
# `require("electron")`；而 fpk 里没有真正的 electron 包（devDep 被 prune 掉）。
# 因此把纯 CJS 替身落成 node_modules/electron/index.js，让那条 require 命中它。
# 必须在 npm prune 之后执行（见第 6 步末尾的兜底），这里只做拷贝准备。
ELECTRON_CJS_SRC="$SHIM_DIR/electron-node.cjs"
ELECTRON_PKG_SRC="$SHIM_DIR/electron-shim-package.json"
if [ -f "$ELECTRON_CJS_SRC" ] && [ -f "$ELECTRON_PKG_SRC" ]; then
  SHIM_ELECTRON_OK=1
else
  SHIM_ELECTRON_OK=0
  echo "  ⚠ 未找到 $ELECTRON_CJS_SRC 或 $ELECTRON_PKG_SRC（运行期 electron 替身缺失，产物 require('electron') 可能失败）"
fi

if [ "$SHIM_OK" = "0" ]; then
  echo "ERROR: 关键 shim 缺失，无法继续。"
  exit 1
fi

# ---------- 3. 注入 renderer 的 web-ipc（ui-dev 提供）----------
# 必须在构建前对 .src 执行：把 preload 转成 web-api 并注入 renderer 入口。
# inject-renderer.sh 尚未交付时仅告警、不硬失败（web-ipc 能力缺失但构建仍可跑通）。
INJECT_SH="$SHIM_DIR/inject-renderer.sh"
if [ -f "$INJECT_SH" ]; then
  echo "---- 注入 renderer web-ipc（inject-renderer.sh）----"
  if bash "$INJECT_SH" "$SRC"; then
    echo "  ✓ inject-renderer 完成"
  else
    echo "WARN: inject-renderer.sh 返回非 0，继续（web-ipc 可能未注入）"
  fi
else
  echo "  ⚠ 未找到 $INJECT_SH（ui-dev 尚未交付）。跳过 renderer 注入，渲染进程将不含 web-ipc 适配。"
fi

# ---------- 4. 生成 fnOS 专用 vite 配置并执行构建 ----------
echo "---- 生成 electron.vite.fnos.config.ts ----"
cat > "$SRC/electron.vite.fnos.config.ts" <<'FNOSVITEEOF'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// fnOS 专用构建配置：用纯 Node 替身替换 Electron，并把 electron-updater 指向 no-op stub。
// 由 build/build-inner.sh 在构建容器内生成，不会提交（build/.src 在 .gitignore 中）。

const exclude = [
  'axios',
  '@koa/router',
  'koa',
  'koa-bodyparser',
  'koa-router',
  'eventsource-parser',
  'js-sha3',
  'mime-types',
  'zstd-codec',
  'electron-store',
  'electron-updater',
  // 把 electron 显式纳入打包（而非 external）：alias 已把它指向纯 Node 替身
  'electron'
]

// 主进程入口：fnos-entry 存在时【只用它】，不要再保留 src/main/index.ts。
//
// 为什么必须单入口：electron shim 里的 ipcRegistry / eventBus 是模块级单例。
// 同时保留 index（Electron 启动流程）和 fnos 两个入口时，rollup 可能把 shim
// 分别内联进两个 bundle，于是 ipcMain.handle 注册进 A 实例、dispatchIpc 去 B
// 实例查表 —— 结果是所有管理界面调用全部 "channel not found"，且日志看不出
// 任何报错，极难排查。单入口从根上消除这个隐患，顺便省掉一份死代码。
const mainInputs = {}
const fnosEntry = resolve(__dirname, 'src/main/fnos-entry.ts')
const legacyEntry = resolve(__dirname, 'src/main/index.ts')
if (existsSync(fnosEntry)) {
  // key 决定输出文件名：core/raw/fnos-entry.js
  mainInputs['fnos-entry'] = fnosEntry
} else if (existsSync(legacyEntry)) {
  mainInputs.index = legacyEntry
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude })],
    resolve: {
      alias: [
        // 用正则精确匹配：字符串形式的 alias 会做前缀替换，
        // 万一命中 'electron-store' 之类的同名前缀就会指向错误文件。
        { find: /^electron$/, replacement: resolve(__dirname, 'src/main/electron-node.ts') },
        // 'electron-updater' → no-op stub（fnOS 走应用市场更新）
        { find: /^electron-updater$/, replacement: resolve(__dirname, 'src/main/electron-updater-stub.ts') }
      ]
    },
    build: {
      rollupOptions: {
        input: mainInputs,
        output: {
          format: 'cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // 绝对 base：index.html 里的静态资源用 /app/chat2api/assets/xxx 绝对路径，
    // 避免相对路径 ./assets/ 在无尾斜杠 URL（/app/chat2api）下被解析到 /app/assets/。
    base: '/app/chat2api/',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    server: {
      host: '0.0.0.0',
      port: 5173
    }
  }
})
FNOSVITEEOF
echo "  ✓ 配置已写入 $SRC/electron.vite.fnos.config.ts"

# 清掉上一轮产物，避免 stale 的 fnos 入口残留
rm -rf "$SRC/out"

echo "---- electron-vite build（fnos 配置）----"
if ! npx electron-vite build -c electron.vite.fnos.config.ts 2>&1 | tail -40; then
  echo "ERROR: electron-vite build 失败，详见上方日志"
  exit 1
fi
echo "  ✓ electron-vite build 完成"

# ---------- 5. 产出落位 ----------
mkdir -p "$OUT/public" "$OUT/core"
rm -rf "$OUT/public" "$OUT/core/raw"
mkdir -p "$OUT/public" "$OUT/core/raw"

if [ -d "$SRC/out/renderer" ]; then
  cp -r "$SRC/out/renderer/." "$OUT/public/"
  echo "前端产物 → $OUT/public"
else
  echo "WARN: 未找到 out/renderer，前端产物缺失"
fi

if [ -d "$SRC/out/main" ]; then
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

# adapter.js：team-lead 负责写（core-dev 的 IPC→HTTP 改造结果）。
# 暂不存在则告警而非崩溃 —— core/index.js 会自动回退占位实现，包仍可用。
ADAPTER_SRC="$SHIM_DIR/adapter.js"
if [ -f "$ADAPTER_SRC" ]; then
  cp "$ADAPTER_SRC" "$OUT/core/adapter.js"
  echo "✓ adapter.js → $OUT/core/adapter.js"
else
  echo "⚠ 未找到 $ADAPTER_SRC（team-lead 尚未交付）。core/index.js 会回退占位实现，包仍可用。"
fi

# ---------- 6. 提取运行时依赖 ----------
# 先 prune 掉 devDependencies（electron / electron-vite 等几百 MB，fnOS 上不需要），
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

# 在上面的 prune + 复制之后，把运行期 electron 替身落进 node_modules。
# 必须在 prune 之后，否则会被 npm prune --omit=dev 当作未声明依赖清掉。
if [ "$SHIM_ELECTRON_OK" = "1" ]; then
  mkdir -p "$OUT/node_modules/electron"
  cp "$ELECTRON_CJS_SRC" "$OUT/node_modules/electron/index.js"
  cp "$ELECTRON_PKG_SRC" "$OUT/node_modules/electron/package.json"
  echo "✓ electron 运行期替身 → $OUT/node_modules/electron/（index.js + package.json）"
else
  echo "⚠ 跳过 electron 运行期替身落位：源文件缺失，require('electron') 将失败"
fi

# ---------- 7. core/index.js 适配器骨架 ----------
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

# ---------- 8. 产物完整性校验 + 汇总 ----------
echo "---- 产物完整性校验 ----"
ok=1
[ -f "$OUT/public/index.html" ] && echo "  ✓ 前端 index.html" || { echo "  ✗ 前端 index.html 缺失"; ok=0; }
[ -f "$OUT/core/index.js" ] && echo "  ✓ core/index.js" || { echo "  ✗ core/index.js 缺失"; ok=0; }
if [ -f "$OUT/core/adapter.js" ]; then
  echo "  ✓ core/adapter.js"
else
  echo "  ⚠ core/adapter.js 缺失（team-lead 待交付，服务端回退占位）"
fi
[ -d "$OUT/core/raw" ] && echo "  ✓ core/raw" || { echo "  ✗ core/raw 缺失"; ok=0; }
[ -d "$OUT/node_modules" ] && echo "  ✓ node_modules" || { echo "  ✗ node_modules 缺失"; ok=0; }

echo "==== build-inner 结束 ===="
if [ "$ok" = "1" ]; then
  echo "SUMMARY: public=$(du -sh "$OUT/public" 2>/dev/null | cut -f1) core=$(du -sh "$OUT/core" 2>/dev/null | cut -f1) node_modules=$(du -sh "$OUT/node_modules" 2>/dev/null | cut -f1)"
  echo "产物已就绪：$OUT"
else
  echo "WARN: 产物不完整，请查看上方日志。"
fi

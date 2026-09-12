#!/usr/bin/env bash
# =============================================================================
# inject-renderer.sh
# -----------------------------------------------------------------------------
# 构建期把 WXS 的 Electron preload（src/preload/index.ts）机械转换成浏览器版
# web-api（src/renderer/src/web-api.ts），并把 shim 注入 renderer 入口。
#
# 核心策略：不改动 renderer 业务代码一行。preload 里 80+ 个
#   ipcRenderer.invoke(...) / .on(...) / .send(...)
# 方法体原样复用，只是把 `ipcRenderer` 换成走 HTTP 的同源对象、把
# `contextBridge` 换成直接挂 window.electronAPI。
#
# 用法:
#   ./inject-renderer.sh <源码根目录，例如 build/.src>
#
# 该脚本会被 CI 的 Linux 容器执行，也会被 Windows Git Bash 调用做 dry-run。
# 设计原则：
#   - 纯 sed/awk/cat 做最小机械替换，不解析 TS。
#   - 幂等：可重复执行，结果稳定（始终从不可变的上游 preload 重新生成 web-api）。
#   - 任一关键步骤失败立即 exit 1，不静默继续。
# =============================================================================

set -e
trap 'echo "ERROR: inject-renderer.sh 在上一行失败，已中止（详见上方日志）。"' ERR

# ---------------------------------------------------------------------------
# 0. 入参与路径
# ---------------------------------------------------------------------------
SRC_ROOT="${1:-}"
if [ -z "$SRC_ROOT" ]; then
  echo "用法: $0 <源码根目录，例如 build/.src>"
  exit 1
fi

# 脚本自身所在目录（用来定位同目录的 shim/web-ipc.ts，与调用时的 cwd 无关）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PRELOAD="$SRC_ROOT/src/preload/index.ts"
RENDERER_SRC="$SRC_ROOT/src/renderer/src"
WEB_API="$RENDERER_SRC/web-api.ts"
WEB_IPC_SRC="$SCRIPT_DIR/web-ipc.ts"
DEST_WEB_IPC="$RENDERER_SRC/web-ipc.ts"
MAIN_TSX="$RENDERER_SRC/main.tsx"

# ---------------------------------------------------------------------------
# 1. 前置校验：关键文件必须存在，否则直接失败
# ---------------------------------------------------------------------------
[ -f "$PRELOAD" ]      || { echo "ERROR: 找不到 preload 源文件: $PRELOAD"; exit 1; }
[ -f "$WEB_IPC_SRC" ]  || { echo "ERROR: 找不到 shim/web-ipc.ts: $WEB_IPC_SRC"; exit 1; }
[ -f "$MAIN_TSX" ]     || { echo "ERROR: 找不到 renderer 入口: $MAIN_TSX"; exit 1; }
[ -d "$RENDERER_SRC" ] || { echo "ERROR: 找不到 renderer src 目录: $RENDERER_SRC"; exit 1; }

# 临时文件（退出时清理）。用 helper 兼容那些要求模板的 mktemp（部分 Git Bash 版本）。
new_tmp() {
  mktemp 2>/dev/null || mktemp -t webipc.XXXXXX 2>/dev/null || echo "/tmp/webipc.$$.$RANDOM"
}
TMP1="$(new_tmp)"
HEADER_FILE="$(new_tmp)"
MAIN_TMP="$(new_tmp)"
cleanup() { rm -f "$TMP1" "$HEADER_FILE" "$MAIN_TMP"; }
trap 'cleanup; echo "ERROR: inject-renderer.sh 在上一行失败，已中止（详见上方日志）。"' ERR
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 2. 从上游 preload 机械转换出 web-api.ts
#    始终以“不可变的上游 preload”为源，因此重复执行是幂等的（不会重复插入头部）。
#    这里做 4 件事：
#      (a) 删除  import { contextBridge, ipcRenderer } from 'electron'
#      (b) 把   Electron.IpcRendererEvent  ->  unknown  （esbuild 不检查类型，但保险）
#      (c) 修正相对路径：文件从 src/preload/ 移到了 src/renderer/src/，
#          需要多上一层目录：
#            '../main/ipc/channels'  ->  '../../main/ipc/channels'
#            '../shared/types'       ->  '../../shared/types'
#          （注意：是两级 ../，不是三级。三级会解析到 .src/main 而非
#            .src/src/main，导致模块找不到。详见交付汇报。）
#      (d) 在头部插入 web 版的 ipcRenderer / contextBridge 替身（见 HEADER_FILE）。
# ---------------------------------------------------------------------------
sed -e "/import { contextBridge, ipcRenderer } from 'electron'/d" \
    -e 's#Electron\.IpcRendererEvent#unknown#g' \
    -e "s#'../main/ipc/channels'#'../../main/ipc/channels'#g" \
    -e "s#'../shared/types'#'../../shared/types'#g" \
    "$PRELOAD" > "$TMP1"

# 头部替身：把 electron 的 ipcRenderer/contextBridge 换成 web 版。
# 用 quoted heredoc（'HEADEOF'）避免 shell 展开其中的 $ 等字符。
cat > "$HEADER_FILE" <<'HEADEOF'
import { createRendererIpc } from './web-ipc'
const ipcRenderer = createRendererIpc()
const contextBridge = { exposeInMainWorld: (key: string, value: unknown) => { (window as any)[key] = value } }
HEADEOF

# 头部 + 转换后的主体 -> web-api.ts
cat "$HEADER_FILE" "$TMP1" > "$WEB_API"

# 末尾确保有默认导出，保证被 import 时副作用（挂 window.electronAPI）触发。
# 由于每次都是基于上游 preload 重新生成，这里用 grep 判断做幂等保护。
if ! grep -q "export default electronAPI" "$WEB_API"; then
  printf '\nexport default electronAPI\n' >> "$WEB_API"
fi

# 防御性校验：sed 若静默失败，下面两处必有一个不成立，必须尽早失败而非产出坏文件。
grep -q "createRendererIpc" "$WEB_API" || { echo "ERROR: 生成的 web-api.ts 缺少 createRendererIpc（sed 替换可能失败）"; exit 1; }
grep -q "from 'electron'" "$WEB_API" && { echo "ERROR: 生成的 web-api.ts 仍包含 electron import（sed 删除失败）"; exit 1; }

# 复制 shim/web-ipc.ts 到 renderer 源码目录，供 web-api 的 import './web-ipc' 使用。
cp "$WEB_IPC_SRC" "$DEST_WEB_IPC" \
  || { echo "ERROR: 复制 web-ipc.ts 到 $DEST_WEB_IPC 失败"; exit 1; }

# ---------------------------------------------------------------------------
# 3. 幂等注入 renderer 入口：在 main.tsx 第一行插入 import './web-api'
#    副作用 import 会触发 web-api 模块顶层执行 exposeInMainWorld，挂上 window.electronAPI。
# ---------------------------------------------------------------------------
if grep -q "import './web-api'" "$MAIN_TSX"; then
  echo "[inject] main.tsx 已包含 import './web-api'，跳过插入（幂等）"
else
  # 借助临时文件在文件最前面插入一行，避免依赖各平台 sed '1i' 语法差异。
  { echo "import './web-api'"; cat "$MAIN_TSX"; } > "$MAIN_TMP" \
    && mv "$MAIN_TMP" "$MAIN_TSX" \
    || { echo "ERROR: 向 main.tsx 注入 import './web-api' 失败"; exit 1; }
  echo "[inject] 已在 main.tsx 首行注入 import './web-api'"
fi

# ---------------------------------------------------------------------------
# 4. 打印转换结果便于 CI 日志排查（前 20 行 + 含 createRendererIpc 的行）
# ---------------------------------------------------------------------------
echo "===== web-api.ts 前 20 行 (来源: $WEB_API) ====="
sed -n '1,20p' "$WEB_API"
echo "===== 含 createRendererIpc 的行 ====="
grep -n "createRendererIpc" "$WEB_API" || true
echo "===== 注入检查 ====="
grep -n "import './web-api'" "$MAIN_TSX" || true

echo "[inject] 完成：web-api.ts 与 web-ipc.ts 已就绪，main.tsx 已注入。"

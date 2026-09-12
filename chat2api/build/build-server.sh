#!/usr/bin/env bash
# 在 Linux 容器中构建 Chat2API-WXS 的服务端与前端产物。
#
# 用法：
#   bash build/build-server.sh              # 默认 main 分支
#   CHAT2API_REF=v1.6.5 bash build/build-server.sh
#
# 为什么不能在 Windows 上直接 npm install：
#   依赖里的 canvas 是原生模块（.node）。Windows 下装出来的二进制放到飞牛
#   （Debian + glibc）上必然加载失败。必须在本镜像（node:22-slim）里构建。
#   同理不能用 alpine —— musl libc 与 glibc 不兼容。
#
# 产物：
#   app/server/public/   前端（可直接用）
#   app/server/core/     主进程编译产物 + 适配器骨架（需完成 IPC→HTTP 改造）

set -euo pipefail

REPO="${CHAT2API_REPO:-https://github.com/narrator-z/Chat2API-WXS.git}"
REF="${CHAT2API_REF:-main}"
IMAGE="${CHAT2API_BUILD_IMAGE:-chat2api-builder:22}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/build/.src"
OUT="$ROOT/app/server"

# Git Bash 路径 → Docker 可识别的 Windows 路径
towin() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

echo "==== Chat2API 构建 ===="
echo "仓库: $REPO @ $REF"
echo "源码: $SRC"
echo "产物: $OUT"

# ---------- 1. 检查 docker ----------
if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: 未找到 docker。请先安装 Docker Desktop 并确保已启动。"
    exit 1
fi
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: docker 守护进程未运行，请启动 Docker Desktop 后重试。"
    exit 1
fi

# ---------- 2. 准备源码 ----------
if [ -d "$SRC/.git" ]; then
    echo "---- 更新源码 ----"
    git -C "$SRC" fetch --depth 1 origin "$REF" 2>/dev/null || true
    git -C "$SRC" checkout --force "$REF" 2>/dev/null || true
else
    echo "---- 克隆源码 ----"
    rm -rf "$SRC"
    git clone --depth 1 --branch "$REF" "$REPO" "$SRC"
fi
echo "版本: $(git -C "$SRC" log -1 --format='%h %ad' --date=short 2>/dev/null || echo unknown)"

# ---------- 3. 构建镜像 ----------
echo "---- 构建镜像 $IMAGE ----"
docker build -t "$IMAGE" -f "$SCRIPT_DIR/Dockerfile" "$ROOT"

# ---------- 4. 执行构建 ----------
echo "---- 容器内构建（首次耗时较长，需下载依赖）----"
mkdir -p "$OUT"
docker run --rm \
    -e SRC_DIR=/src \
    -e OUT_DIR=/out \
    -v "$(towin "$SRC")":/src \
    -v "$(towin "$OUT")":/out \
    -v "$(towin "$SCRIPT_DIR/build-inner.sh")":/usr/local/bin/build-inner.sh:ro \
    "$IMAGE"

# ---------- 5. 校验产物 ----------
echo "---- 产物校验 ----"
ok=1
[ -f "$OUT/public/index.html" ] && echo "  ✓ 前端 index.html" || { echo "  ✗ 前端 index.html 缺失"; ok=0; }
[ -d "$OUT/core" ] && echo "  ✓ core 目录" || { echo "  ✗ core 目录缺失"; ok=0; }
[ -f "$OUT/core/index.js" ] && echo "  ✓ core 适配器" || { echo "  ✗ core 适配器缺失"; ok=0; }

echo "==== 构建结束 ===="
if [ "$ok" = "1" ]; then
    echo "产物已就绪。下一步："
    echo "  1) 参考 app/server/core/adapter.example.js 完成 IPC→HTTP 改造，输出 core/adapter.js"
    echo "  2) 在仓库根目录执行打包："
    echo "       bash scripts/build_fpk.sh chat2api chat2api all"
else
    echo "WARN: 产物不完整，请查看上方日志。"
fi

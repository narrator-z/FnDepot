#!/usr/bin/env bash
set -euo pipefail

echo "[start] profile=${LOOMY_PROFILE_DIR} headless=${LOOMY_HEADLESS} no-sandbox=${LOOMY_NO_SANDBOX}"
mkdir -p "${LOOMY_PROFILE_DIR}"

# 1) 持久化浏览器会话（后台，带 CDP）。登录态在挂载的 profile 目录里，重启不丢。
node /app/cdp-launch.js &
BROWSER_PID=$!

# 等 CDP 就绪，最多 60 秒
READY=0
for i in $(seq 1 60); do
  if curl -s -m 2 "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
    READY=1
    echo "[start] CDP 就绪（第 ${i} 秒）"
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "[start] 警告：CDP 未就绪，代理启动后可能报无法连接浏览器" >&2
fi

# 2) 代理前台运行
exec node /app/proxy.js

# 为什么必须是 bookworm：
#   飞牛 fnOS 是 Debian 12（glibc 2.36）。在高版本 glibc（如 Ubuntu 24.04 / 2.39）上
#   构建的原生库，放到低版本上会因符号版本缺失而加载失败（glibc 只向后兼容）。
#   node:20-bookworm 即 Debian 12，与飞牛同源。
FROM node:20-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
    LOOMY_HEADLESS=1 \
    LOOMY_NO_SANDBOX=1 \
    LOOMY_PROFILE_DIR=/data/loomy-profile \
    PROXY_HOST=0.0.0.0 \
    PROXY_PORT=19999 \
    CDP_PORT=9222

WORKDIR /app

# curl 供 start.sh 探测 CDP 端口
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# 先装依赖（利于构建缓存分层），playwright install --with-deps 会补齐 Chromium 所需的系统库
COPY scripts/package.json /app/
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && npm cache clean --force \
 && rm -rf /root/.npm

COPY scripts/ /app/
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 19999 9222
ENTRYPOINT ["bash", "/app/start.sh"]

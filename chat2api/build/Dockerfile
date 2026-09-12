# 用于构建 Chat2API 服务端与前端产物的 Linux 构建镜像。
#
# 为什么必须用 Docker：
#   飞牛 fnOS 跑在 Debian 上，而本机是 Windows。含原生模块（.node）的依赖在 Windows 下
#   构建出来的二进制放到飞牛上必定加载失败（ABI / glibc 不匹配）。必须用与目标系统
#   一致的 Linux + glibc 环境构建 node_modules。
#
# 为什么是 slim 而不是 alpine：
#   alpine 用的是 musl libc，与飞牛的 glibc 不兼容，原生模块装上会直接崩。
#   这是同类 Electron→fnOS 移植项目明确踩过的坑。
#
# 版本须与 manifest 的 install_dep_apps=nodejs_v22 保持一致，避免 ABI 不匹配。
#
# 为什么是 bookworm 而不是默认的 slim：
#   slim 的底层 Debian 版本会随 node 基础镜像升级而漂移；显式写 bookworm（Debian 12）
#   才能与飞牛 fnOS 的 glibc 版本锁定一致，也与 build-chat2api.yml 的 container 保持一致。
FROM node:22-bookworm-slim

# 原生模块编译所需工具链，以及 git（clone 源码）。
# cairo/pango/jpeg/gif/rsvg 是 canvas 的编译依赖。
# 注意：经核对，WXS 源码实际并未真正引用 canvas（仅 tray 里一个 Buffer 变量名），
# 保留这组系统库仅为防御性 —— 万一将来引入真实原生模块、或 canvas 的某个传递依赖
# 回退源码编译时，工具链已就绪不会直接失败。装上没有坏处。
# （与 .github/workflows/build-chat2api.yml 里安装的同一组，两处必须一致。）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        make \
        g++ \
        pkg-config \
        git \
        ca-certificates \
        libcairo2-dev \
        libpango1.0-dev \
        libjpeg-dev \
        libgif-dev \
        librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work

# 容器内执行的构建脚本，由 build-server.sh 挂载进来调用
COPY build-inner.sh /usr/local/bin/build-inner.sh
RUN chmod +x /usr/local/bin/build-inner.sh

ENTRYPOINT ["/usr/local/bin/build-inner.sh"]

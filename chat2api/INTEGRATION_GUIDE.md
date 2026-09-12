# Chat2API fnOS 集成方案

> 目标：以 [Chat2API-WXS](https://github.com/narrator-z/Chat2API-WXS) (v1.6.5) 为主体框架，将其核心功能迁移为飞牛 fnOS 原生应用，打包为 `.fpk` 并集成到本仓库。

---

> ## ⚠️ 阅读前必读：本文档与已落地实现的差异
>
> 本文档写于方案设计阶段，**部分细节已被实际落地时修正**。以下为准，与正文冲突时以此为准：
>
> | 项目 | 文档旧写法 | **实际落地（以此为准）** |
> |------|-----------|------------------------|
> | UI 目录 | `chat2api/ui/`（包根） | **`chat2api/app/ui/`** —— 官方 `scripts/build_fpk.sh` 只打包 `app/ cmd/ config/ wizard/ ICON manifest`，根级 `ui/` 不会进包，装完没有桌面入口 |
> | 打包命令 | `python _build_fpk.py` | **`bash scripts/build_fpk.sh chat2api chat2api all`**（在仓库根目录执行） |
> | 打包脚本 | `chat2api/_build_fpk.py` | 已删除，统一用仓库级 `scripts/build_fpk.sh` |
> | 入口图标 | `icon-{0}.png`（连字符） | **`icon_{0}.png`**（下划线，与 moviepilot / traefik 一致） |
> | 核心构建 | 本地 Docker | **GitHub Actions**：`.github/workflows/build-chat2api.yml`（`node:22-bookworm-slim`，本机无 Docker 也能构建） |
> | 骨架发布 | 手动 | **自动**：`fnpack.json` 里 chat2api 的 version 一变更，`publish.yml` 自动打包并发 Release |
>
> 下文正文中仍出现 `ui/`（根级）、`_build_fpk.py` 的地方，均按上表理解。
>
> ### 发布前检查清单（接入真实核心后逐项确认）
>
> 1. **`platform` 与原生模块的架构冲突（必查）**
>    当前 `platform = all`。骨架是纯 JS，没问题；但接入 Chat2API-WXS 后 `app/server/node_modules`
>    会带上 `canvas` 的 `.node` 原生二进制，而 `build-chat2api.yml` 跑在 **x86_64** runner 上。
>    届时包就是 x86_64 专属，ARM 飞牛装上必然加载失败。
>    → 接入核心后：把 manifest 改为 `arch = x86_64`（对齐 moviepilot），或按架构分别构建分包。
> 2. **图标**：已按规范生成 64×64 / 256×256（原素材保留在 `build/icon-source.png`，需重新生成时用）。
> 3. **端口**：向导值 `wizard_app_port` 优先级高于 `TRIM_SERVICE_PORT`（后者是 manifest 静态值，不随向导变）。
> 4. **共享目录**：`chat2api` / `chat2api/data`，运行用户 `chat2api`（`config/privilege` 显式声明）。

---

## 零、前置：案例验证与端口策略（重要）

在动手前，先解决两个核心疑问：**架构是否可行** 与 **端口如何避让常规端口**。

### 0.1 架构可行性：已有成功案例验证

检索到 **[Comic_Management（资源平台）](https://gitee.com/wujiawei1207537021/comic_management)** —— 一个 Vue 3 + Electron + Express 的跨平台应用，已成功打包为飞牛 fnOS `.fpk` 应用。其架构与 Chat2API-WXS 高度同构（前端框架 + Electron 壳 + Node.js 服务）。

**该案例验证的关键结论：**

| 结论 | 说明 |
|------|------|
| ✅ Electron 应用可移植 fnOS | 已量产验证，非理论推演 |
| ✅ fnOS 上跑"Web 服务模式" | 该项目提供 `npm run web` 命令：**仅启动 Express 服务，不启动 Electron GUI** |
| ✅ 无需自建 Node.js | `manifest` 声明 `install_dep_apps=nodejs_v22`，复用飞牛官方运行时 |
| ✅ 目录结构可保留 Electron 布局 | `app/server/` 下同时保留 `main/`、`preload/`、`dist/renderer/` |
| ⚠️ 原生模块需 Linux 重建 | 必须用 Docker **Debian 系**镜像（如 `node:22-slim`）重建，`Alpine(musl)` 不兼容 |

**对我们的直接指导**：fnOS 上运行时**不启动 BrowserWindow**，改为 Koa 同时提供 API + 静态文件服务。这与本方案"Headless 服务端提取"思路完全一致，且已被工程验证。

### 0.2 端口策略：规避常规端口

**飞牛端口占用现状（实测）：**

| 端口 | 占用方 | 结论 |
|------|--------|------|
| 5666 / 5667 | fnOS 系统 HTTP/HTTPS（V0.8.22+ 默认） | 禁用 |
| 8000 / 8001 | fnOS 系统占用 | 禁用 |
| 80 / 443 | fnOS 系统占用（可重定向） | 禁用 |
| **8080–8099** | **第三方应用重灾区**：Open WebUI 8080、Medusa 8081、FreshRSS 8082、MaxKB 8083、Miniflux 8084、qBittorrent 8085、CoPaw 8088、FileBrowser 8089、Emby 8096、Jellyfin 8097 | **绝对禁用** |
| 3000–3010 | MoviePilot 3000、Uptime Kuma 3001、Sun-Panel 3002、Homepage 3003、Grafana 3010 | 禁用 |
| 9000 / 9090 / 9091 | Nginx UI / Prometheus / Transmission | 禁用 |

**本方案端口设计（仅需 1 个端口）：**

| 通道 | 方案 | 端口 | 冲突风险 |
|------|------|------|----------|
| **管理 UI** | **统一网关** `/app/chat2api`（Unix Socket） | **0（不占端口）** | 无 |
| **OpenAI API 代理** | 独立 TCP 端口 | **26800** | 极低 |

**设计理由：**

1. **管理 UI 走统一网关** —— 飞牛官方机制：应用监听 `gatewaySocket` Unix Socket，由 fnOS 挂载到 `/app/chat2api` 路径并**代做登录态校验**，转发 `X-Trim-Userid` 等用户 Header。`port` 字段被忽略，**彻底消除端口冲突**。
2. **API 代理用 26800** —— 外部 OpenAI 客户端（Cline / Cherry Studio）必须走 `http://nas-ip:port/v1`，无法走需登录态的网关，故保留独立端口。选 `2xxxx` 段是延续您仓库的既有惯例（moviepilot `service_port=20669`、容器 47901），且完全避开上表所有拥挤区间。
3. 保留 `checkport=true`（默认），让 fnOS 启动前自动检测端口冲突。

> ⚠️ **原 FnDepot 版用的 8080/8081 正是最危险的选择**，本方案必须改掉。若用户从旧版升级，需在 `upgrade_callback` 中做端口迁移提示。

### 0.3 风险总评

| 风险项 | 等级 | 说明 | 缓解措施 |
|--------|------|------|----------|
| 架构可行性 | 🟢 **低** | 已有同构案例量产验证 | 照搬 Comic_Management 的 `web` 模式 |
| 端口冲突 | 🟢 **低** | 统一网关 + 非常规端口 | 管理 UI 零端口；API 用 26800 |
| IPC→HTTP 改造 | 🟡 **中** | 工作量大但机械重复 | **只在传输层改，业务逻辑零改动**（见 0.4） |
| 原生模块 Linux 兼容 | 🟡 **中** | Windows 构建的 `node_modules` 在 Linux 不可跑 | Docker Debian 镜像重建 |
| Electron 依赖残留 | 🟢 **低** | 保留依赖但 fnOS 上不加载 | 仅 `web` 模式启动，不 `require('electron')` |
| OAuth 回调 | 🟡 **中** | 需浏览器跳转替代 BrowserWindow | 回调地址设为网关路径 `/app/chat2api/oauth/callback` |

> **结论：整体风险可控，建议推进。** 最大的工作量是 IPC→HTTP 传输层改造，但可通过 0.4 的策略把风险压到最低。

### 0.4 降低 IPC 改造风险的关键策略

**不要重写业务逻辑，只替换传输层。**

```
原架构:  renderer --IPC--> ipcMain.handle('get-providers', handler)
新架构:  renderer --HTTP--> router.get('/api/providers', handler)
                              ↑ 同一个 handler 函数，零改动
```

操作步骤：
1. 把每个 `ipcMain.handle(name, handler)` 的 `handler` 提取为独立的纯函数（`async (args) => result`）。
2. 用 Koa 路由包装同一个函数：`router.post('/api/xxx', async ctx => { ctx.body = await handler(ctx.request.body) })`。
3. 前端 `window.electronAPI.xxx()` → `fetch('/api/xxx')`，只改调用层。
4. 桌面端保留 IPC 通道不动 —— **一套业务逻辑，两种传输层**，fnOS 版与桌面版可共用代码。

这样改造是"机械映射"而非"重写"，风险大幅降低，且未来上游 Chat2API-WXS 更新时可低成本合并。

---

## 一、两套项目对比分析

### 1.1 原 FnDepot chat2api（nx5888 版，v1.3.4）

| 维度 | 内容 |
|------|------|
| 类型 | fnOS 原生应用（micro_app），打包为 `.fpk` |
| 架构 | Headless 服务端 + Web 管理界面 |
| 入口 | `cmd/main`（守护进程）→ systemd 管理 |
| API 端口 | 8080（OpenAI 兼容代理） |
| 管理端口 | 8081（独立管理 UI） |
| UI 方式 | fnOS 桌面图标 → 浏览器打开 Web 管理界面 |
| 数据目录 | `/usr/local/apps/@appcenter/chat2api/` |

**目录结构：**
```
chat2api/
├── app/server/           # 服务端代码（Koa 代理 + 管理接口）
├── cmd/                  # fnOS 生命周期脚本
│   ├── main              # 守护进程入口（二进制/shell）
│   ├── install_callback  # 安装后回调：创建 systemd 服务
│   ├── config_callback   # 配置变更回调
│   ├── config_init       # 配置初始化
│   ├── uninstall_callback
│   └── uninstall_init
├── config/               # 配置文件
├── ui/                   # 桌面 Web UI（fnOS desktop_uidir）
├── wizard/               # 安装向导
├── www/                  # Web 静态文件
├── manifest              # fnOS 应用清单
├── ICON.PNG / ICON_256.PNG
├── app.tgz               # 打包后的服务端（tar.gz）
├── chat2api.fpk          # 最终 fnOS 安装包
├── _build_fpk.py         # 构建脚本
├── _deploy_fpk.py / _deploy_nas.py / _hotfix_nas.py
└── prompt_yuanbao.json   # 提示词配置
```

**manifest 关键字段：**
```
appname               = chat2api
display_name          = Chat2API
main                  = cmd/main
desktop_uidir         = ui
desktop_applaunchname = chat2api.Application
micro_app             = true
platform              = all
version               = 1.3.4
```

**install_callback 逻辑：**
- 复制管理 UI 脚本到 `/usr/local/bin/chat2api-mgmt.js`
- 创建 `chat2api-mgmt.service`（systemd），监听 8081 端口
- 设置环境变量：`MGMT_PORT=8081`, `API_PORT=8080`, `API_KEY=chat2api-fpk-secret-2026`

### 1.2 Chat2API-WXS（v1.6.5）

| 维度 | 内容 |
|------|------|
| 类型 | Electron 桌面应用 |
| 架构 | Electron 主进程（Koa 代理）+ BrowserWindow（React UI） |
| 入口 | `src/main/index.ts` → Electron app.whenReady() |
| API 端口 | 8080（可配置） |
| 管理方式 | Electron 窗口内 React UI + 系统托盘 |
| 数据目录 | `~/.chat2api/`（config.json, providers.json, accounts.json, logs/） |
| 技术栈 | Electron 43+, React 18, TypeScript, Tailwind CSS, Zustand, Koa, Vite |

**核心目录结构：**
```
Chat2API-WXS/
├── src/
│   ├── main/                     # Electron 主进程
│   │   ├── index.ts              # 入口：app.whenReady, BrowserWindow, tray
│   │   ├── tray.ts               # 系统托盘
│   │   ├── proxy/                # ★ Koa 代理服务器核心
│   │   │   ├── server.ts          #   服务器启动
│   │   │   ├── loadbalancer.ts    #   负载均衡
│   │   │   ├── sessionManager.ts  #   会话管理
│   │   │   ├── stream.ts          #   SSE 流式
│   │   │   ├── status.ts          #   代理状态
│   │   │   ├── types.ts           #   类型定义
│   │   │   ├── promptToolUse.ts   #   工具调用提示
│   │   │   ├── adapters/          #   服务商适配器
│   │   │   ├── config/            #   代理配置
│   │   │   ├── constants/         #   常量
│   │   │   ├── middleware/        #   Koa 中间件
│   │   │   ├── prompt/            #   提示词模板
│   │   │   ├── routes/            #   API 路由
│   │   │   ├── services/          #   业务逻辑
│   │   │   ├── toolCalling/       #   工具调用实现
│   │   │   └── utils/             #   工具函数
│   │   ├── providers/            # AI 服务商管理
│   │   ├── oauth/                 # OAuth 登录流程
│   │   ├── ipc/                   # IPC 处理器（main↔renderer）
│   │   ├── store/                # electron-store 持久化
│   │   ├── data/                  # 数据管理
│   │   ├── logger/                # 日志
│   │   ├── appLogs/               # 应用日志
│   │   ├── requestLogs/           # 请求日志
│   │   ├── tray/                  # 托盘管理器
│   │   ├── updater/               # 自动更新
│   │   ├── window/                # 窗口管理器
│   │   └── lib/                   # 工具库
│   ├── preload/                  # 上下文桥接（IPC API 暴露）
│   ├── renderer/                  # ★ React 前端
│   │   ├── src/
│   │   │   ├── App.tsx            #   应用根组件
│   │   │   ├── main.tsx           #   React 入口
│   │   │   ├── index.css          #   全局样式
│   │   │   ├── components/        #   UI 组件
│   │   │   ├── pages/             #   页面组件
│   │   │   ├── stores/            #   Zustand 状态
│   │   │   ├── hooks/             #   自定义 Hooks
│   │   │   ├── i18n/              #   国际化
│   │   │   ├── lib/               #   工具库
│   │   │   └── assets/            #   静态资源
│   │   └── favicon.png
│   └── shared/                   # 共享类型（main ↔ renderer）
├── build/                        # 构建资源（图标等）
├── scripts/                      # 构建脚本
├── tests/                        # 测试
├── package.json                  # ★ 依赖与构建配置
├── electron.vite.config.ts        # Vite + Electron 配置
├── tsconfig.json                 # TypeScript 配置
├── tailwind.config.js            # Tailwind 配置
├── components.json                # shadcn/ui 配置
└── sha3_wasm_bg.*.wasm            # SHA3 WASM 模块
```

### 1.3 核心差异总结

| 维度 | FnDepot chat2api (v1.3.4) | Chat2API-WXS (v1.6.5) | 集成方向 |
|------|---------------------------|------------------------|----------|
| 运行模式 | Headless 服务端 | Electron GUI 桌面 | 提取为 Headless |
| 代理核心 | 自定义 Koa 服务 | `src/main/proxy/` Koa | ★ 采用 WXS 版 |
| 前端 UI | 独立 Web 页面 | React 18 SPA | 构建为静态文件 |
| 服务商支持 | 较少 | DeepSeek/GLM/Kimi/Qwen 等 + OAuth | ★ 采用 WXS 版 |
| 工具调用 | 无 | promptToolUse + toolCalling | ★ 采用 WXS 版 |
| 上下文管理 | 无 | 滑动窗口 + Token 限制 + 总结压缩 | ★ 采用 WXS 版 |
| 系统托盘 | 不适用 | tray.ts | 剥离（fnOS 无桌面托盘） |
| 自动更新 | 不适用 | electron-updater | 剥离（fnOS 有自己的更新机制） |
| 数据存储 | 应用目录 | `~/.chat2api/` | 改为应用目录 |

---

## 二、集成策略

### 2.1 总体思路

**Headless 服务端提取 + fnOS 包装**

将 Chat2API-WXS 的核心服务端逻辑（`src/main/proxy/`, `src/main/providers/`, `src/main/oauth/`, `src/main/store/` 等）从 Electron 框架中提取出来，创建一个独立的 Node.js Headless 入口；将 React 前端构建为静态 Web 文件，通过 Koa 静态文件服务提供；最后用 fnOS 生命周期脚本和 manifest 包装为 `.fpk` 包。

### 2.2 需要保留的模块

| 模块 | 源路径 | 作用 |
|------|--------|------|
| proxy/ | `src/main/proxy/` | Koa 代理服务器、路由、中间件、负载均衡、会话管理、流式响应 |
| providers/ | `src/main/providers/` | AI 服务商适配器（DeepSeek/GLM/Kimi/Qwen 等） |
| oauth/ | `src/main/oauth/` | OAuth 登录流程 |
| store/ | `src/main/store/` | electron-store 数据持久化 |
| data/ | `src/main/data/` | 数据管理 |
| requestLogs/ | `src/main/requestLogs/` | 请求日志 |
| logger/ | `src/main/logger/` | 日志系统 |
| renderer/ | `src/renderer/` | React 18 前端 UI |
| shared/ | `src/shared/` | 共享类型定义 |

### 2.3 需要剥离/替换的模块

| 模块 | 原因 | 替代方案 |
|------|------|----------|
| `src/main/index.ts` | Electron app 生命周期 | 新建 headless 入口 `server-entry.ts` |
| `src/main/tray.ts` + `tray/` | 系统托盘（fnOS 无桌面环境） | 删除 |
| `src/main/window/` | BrowserWindow 窗口管理 | 删除，改用 Koa 静态文件服务 |
| `src/main/updater/` | electron-updater 自动更新 | 删除，使用 fnOS 自带更新机制 |
| `src/preload/` | Electron contextBridge | 删除，renderer 改用 HTTP API 通信 |
| `src/main/ipc/` | Electron IPC 通信 | 改造为 HTTP API 路由 |

---

## 三、具体操作步骤

### 步骤 1：在本地仓库创建 chat2api 目录骨架

```bash
cd D:/project/FnDepot
mkdir -p chat2api/{app/server,cmd,config,ui,wizard,www}
```

目标目录结构：
```
D:\project\FnDepot\
├── chat2api/                    # 新建的 chat2api fnOS 应用
│   ├── app/
│   │   └── server/              # Chat2API-WXS 提取后的服务端代码
│   ├── cmd/                     # fnOS 生命周期脚本
│   │   ├── main
│   │   ├── install_callback
│   │   ├── config_callback
│   │   ├── config_init
│   │   ├── uninstall_callback
│   │   └── uninstall_init
│   ├── config/                  # 配置文件
│   ├── ui/                      # React 构建产物（fnOS 桌面 UI）
│   ├── wizard/                  # 安装向导
│   ├── www/                     # Web 静态文件
│   ├── manifest                 # fnOS 应用清单
│   ├── ICON.PNG
│   ├── ICON_256.PNG
│   ├── _build_fpk.py            # 打包脚本
│   └── README.md
├── fnpack.json                  # 已有，需追加 chat2api 条目
├── moviepilot/
├── scripts/
└── traefik/
```

### 步骤 2：克隆 Chat2API-WXS 作为构建源

```bash
cd D:/project/FnDepot/chat2api
git clone https://github.com/narrator-z/Chat2API-WXS.git ../Chat2API-WXS-src
```

将源码克隆到仓库外的临时目录（或 `.workbuddy` 缓存目录），用于提取和构建。

### 步骤 3：创建 Headless 服务端入口

在 `app/server/` 下创建新的入口文件，替代 Electron 的 `index.ts`：

**`app/server/server-entry.ts`** — 核心 Headless 入口：

```typescript
// 替代 src/main/index.ts 的 Electron 入口
// 直接启动 Koa 代理服务器 + 管理 API，无 Electron 依赖

import { ProxyServer } from './proxy/server';
import { storeManager } from './store/store';
import { ProviderManager } from './providers';
import { RequestLogger } from './requestLogs';
import { Logger } from './logger';

// fnOS 环境变量
// API_PORT: OpenAI 代理端口，取 manifest.service_port（默认 26800，避开常规端口段）
// GATEWAY_SOCKET: 管理 UI 的 Unix Socket（统一网关，不占 TCP 端口）
const API_PORT = parseInt(process.env.API_PORT || '26800', 10);
const GATEWAY_SOCKET = process.env.GATEWAY_SOCKET;
const DATA_DIR = process.env.CHAT2API_DATA_DIR;

// 初始化数据目录
storeManager.setDataDir(DATA_DIR);

async function bootstrap() {
  const logger = new Logger();
  logger.info('Chat2API fnOS server starting...');

  // 1) 启动 OpenAI API 代理服务器 —— 唯一占用的 TCP 端口
  const proxyServer = new ProxyServer({
    port: API_PORT,
    dataDir: DATA_DIR,
  });
  await proxyServer.start();
  logger.info(`API proxy server started on port ${API_PORT}`);

  // 2) 启动管理 UI 服务 —— 监听 Unix Socket，由 fnOS 统一网关挂载到 /app/chat2api
  //    不占用任何 TCP 端口，彻底规避端口冲突
  if (GATEWAY_SOCKET) {
    const mgmtServer = new MgmtServer({
      socketPath: GATEWAY_SOCKET,   // 而非 port
      staticDir: process.env.STATIC_DIR || `${process.env.TRIM_APPDEST}/ui`,
      proxyServer,
    });
    await mgmtServer.start();
    // Socket 文件需让 fnOS 网关进程可访问
    await fs.chmod(GATEWAY_SOCKET, 0o666);
    logger.info(`Management UI listening on unix socket ${GATEWAY_SOCKET}`);
  }

  // 3) 优雅退出：清理 socket 文件，避免下次启动残留
  const shutdown = async () => {
    logger.info('Shutting down...');
    await proxyServer.stop();
    if (GATEWAY_SOCKET) { try { await fs.unlink(GATEWAY_SOCKET); } catch {} }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
```

### 步骤 4：将 IPC 处理器改造为 HTTP API 路由

原 Electron 应用通过 `ipc/handlers.ts` 进行 main↔renderer 通信。fnOS 模式下前端是 Web 页面，需改为 HTTP API。

**改造原则：**
- IPC handler → Koa 路由
- `ipcMain.handle('get-providers', ...)` → `router.get('/api/providers', ...)`
- `ipcMain.handle('add-provider', ...)` → `router.post('/api/providers', ...)`
- 前端 `window.electronAPI.getProviders()` → `fetch('/api/providers')`

**`app/server/routes/mgmt-routes.ts`** — 管理路由示例：

```typescript
import Koa from 'koa';
import Router from '@koa/router';
import serve from 'koa-static';
import { storeManager } from '../store/store';
import { ProviderManager } from '../providers';

const app = new Koa();
const router = new Router();

// 静态文件服务（React 构建产物）
app.use(serve('/usr/local/apps/@appcenter/chat2api/ui'));

// API 路由
router.get('/api/status', async (ctx) => {
  ctx.body = { running: proxyServer.isRunning(), port: API_PORT };
});

router.get('/api/providers', async (ctx) => {
  ctx.body = await storeManager.getProviders();
});

router.post('/api/providers', async (ctx) => {
  const provider = ctx.request.body;
  await storeManager.addProvider(provider);
  ctx.body = { success: true };
});

router.post('/api/proxy/start', async (ctx) => {
  await proxyServer.start();
  ctx.body = { success: true, port: API_PORT };
});

router.post('/api/proxy/stop', async (ctx) => {
  await proxyServer.stop();
  ctx.body = { success: true };
});

// ... 更多路由（accounts, models, sessions, logs 等）

app.use(router.routes());
app.use(router.allowedMethods());
```

### 步骤 5：修改前端 preload 通信层

**`src/renderer/src/lib/api.ts`** — 替代 Electron preload API：

```typescript
// 原来通过 window.electronAPI 调用 IPC
// 改为通过 HTTP API 调用后端

const API_BASE = '/api';  // 同源，Koa 代理管理端口

export const api = {
  // 状态
  getStatus: () => fetch(`${API_BASE}/status`).then(r => r.json()),

  // 服务商
  getProviders: () => fetch(`${API_BASE}/providers`).then(r => r.json()),
  addProvider: (data: any) =>
    fetch(`${API_BASE}/providers`, { method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }).then(r => r.json()),

  // 代理控制
  startProxy: () => fetch(`${API_BASE}/proxy/start`, { method: 'POST' }).then(r => r.json()),
  stopProxy: () => fetch(`${API_BASE}/proxy/stop`, { method: 'POST' }).then(r => r.json()),

  // 账户
  getAccounts: () => fetch(`${API_BASE}/accounts`).then(r => r.json()),

  // 日志
  getRequestLogs: (page = 1) => fetch(`${API_BASE}/logs?page=${page}`).then(r => r.json()),
};
```

然后全局搜索替换 `window.electronAPI.xxx` → `api.xxx`。

### 步骤 6：剥离 Electron 依赖，修改 package.json

创建 `app/server/package.json`，移除 Electron 相关依赖：

```json
{
  "name": "chat2api-server",
  "version": "1.6.5",
  "description": "Chat2API fnOS server - headless Koa proxy",
  "main": "server-entry.js",
  "scripts": {
    "start": "node server-entry.js",
    "build:frontend": "cd ../Chat2API-WXS-src && npm run build"
  },
  "dependencies": {
    "@koa/router": "^15.3.0",
    "koa": "^2.15.3",
    "koa-bodyparser": "^4.4.1",
    "koa-router": "^12.0.1",
    "koa-static": "^5.0.0",
    "axios": "^1.7.7",
    "eventsource-parser": "^3.0.6",
    "mime-types": "^3.0.2",
    "js-sha3": "^0.9.3",
    "zstd-codec": "^0.1.5",
    "electron-store": "^10.0.0"
  }
}
```

**移除的依赖（仅 Electron 桌面端需要）：**
- `electron` (核心框架)
- `electron-updater` (自动更新)
- `electron-builder` (打包工具)
- `electron-vite` (Electron 专用构建)
- `@vitejs/plugin-react` (前端构建改用 vite 直接构建)
- `canvas` (Electron 测试用)
- 所有 `@radix-ui/*` (前端组件，仅 renderer 构建时需要)

### 步骤 7：创建 fnOS manifest

**`chat2api/manifest`**：

⚠️ **注意**：管理 UI 走统一网关（不占端口），仅 API 代理占用 26800。声明 `nodejs_v22` 复用飞牛官方 Node.js 运行时。

```
appname               = chat2api
display_name          = Chat2API
desc                  = 统一管理多个AI服务商：DeepSeek、GLM、Kimi、Qwen等，提供OpenAI兼容API接口<br>• OpenAI API 代理端口：26800<br>• 管理界面：系统域名 /app/chat2api（统一网关，无需端口）<br>• 支持 OAuth 登录、上下文管理、工具调用、模型映射
source                = thirdparty
maintainer            = narrator-z
maintainer_url        = https://github.com/narrator-z
distributor           = narrator-z
distributor_url       = https://github.com/narrator-z/FnDepot
desktop_uidir         = ui
desktop_applaunchname = chat2api.Application
icon                  = ICON.PNG
main                  = cmd/main
platform              = all
micro_app             = true
os_min_version        = 1.0.0
version               = 1.6.5
ctl_stop              = true
service_port          = 26800
checkport             = true
install_dep_apps      = nodejs_v22
changelog             = 基于 Chat2API-WXS v1.6.5 重新构建：新增 OAuth 登录、上下文管理、工具调用、模型映射、自定义供应商支持；管理界面改用统一网关，API 端口改为 26800 以避开常规端口冲突
```

**关键字段说明：**

| 字段 | 值 | 说明 |
|------|-----|------|
| `service_port` | `26800` | 仅 API 代理使用；系统通过 `TRIM_SERVICE_PORT` 注入 |
| `checkport` | `true` | 启动前由 fnOS 检测端口冲突（默认值，建议保留） |
| `install_dep_apps` | `nodejs_v22` | 复用飞牛官方 Node.js 22 运行时，路径 `/var/apps/nodejs_v22/target/bin` |
| `ctl_stop` | `true` | 允许用户在应用中心启停应用 |

**统一网关入口配置 `ui/config`** —— 管理 UI 走网关，不占端口：

```json
{
  ".url": {
    "chat2api.main": {
      "title": "Chat2API",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "gatewayPrefix": "/app/chat2api",
      "gatewaySocket": "app.sock",
      "url": "/app/chat2api",
      "allUsers": true
    }
  }
}
```

> `protocol` 和 `port` 在统一网关入口中**会被忽略**。应用需监听 `${TRIM_APPDEST}/target/app.sock` 这个 Unix Socket。

### 步骤 8：创建生命周期脚本

**`chat2api/cmd/main`**（守护进程入口）：

⚠️ 要点：使用 `TRIM_*` 变量定位目录、读 `TRIM_SERVICE_PORT` 取端口、把 `nodejs_v22` 加入 PATH、**管理 UI 监听 Unix Socket**。

```bash
#!/bin/bash
# Chat2API fnOS 守护进程入口
# 生命周期脚本遵循 fnOS 约定：start / stop / status

# 飞牛官方 Node.js 22 运行时（manifest 中 install_dep_apps=nodejs_v22）
export PATH=/var/apps/nodejs_v22/target/bin:$PATH

APP_DIR="${TRIM_APPDEST}"
SERVER_DIR="$APP_DIR/server"
SOCKET_PATH="$APP_DIR/target/app.sock"

# 端口：仅 API 代理使用，取 manifest.service_port 注入的值
# 管理 UI 走统一网关 Unix Socket，不占端口
export API_PORT="${TRIM_SERVICE_PORT:-26800}"
export GATEWAY_SOCKET="$SOCKET_PATH"
export CHAT2API_DATA_DIR="${TRIM_PKGVAR}/data"

case "$1" in
  start)
    echo "Starting $TRIM_APPNAME $TRIM_APPVER"
    mkdir -p "$(dirname "$SOCKET_PATH")" "$CHAT2API_DATA_DIR" "$CHAT2API_DATA_DIR/logs"
    # 清理残留 socket
    rm -f "$SOCKET_PATH"
    cd "$SERVER_DIR"
    exec node "$SERVER_DIR/server-entry.js" >> "$CHAT2API_DATA_DIR/info.log" 2>&1 &
    ;;

  stop)
    pkill -f "server-entry.js"
    rm -f "$SOCKET_PATH"
    ;;

  status)
    if pgrep -f "server-entry.js" > /dev/null; then
      exit 0    # 运行中
    fi
    exit 3      # 已停止
    ;;

  *)
    echo "Unknown command: $1" > "$TRIM_TEMP_LOGFILE"
    exit 1
    ;;
esac
```

> 💡 **生命周期脚本约定**：不要单独维护日志文件，直接输出到标准输出/标准错误，fnOS 框架会统一收集。上面的 `info.log` 仅用于应用自身诊断，启动信息仍走 stdout。

**`chat2api/cmd/install_callback`**（安装后回调）：

> ⚠️ **重要修正**：fnOS 由框架通过 `cmd/main` 管理应用生命周期，**不应自建 systemd 服务**（原 FnDepot 版那样做是变通做法）。本阶段只做初始化：准备目录、安装 Node 依赖、校验环境。

```bash
#!/bin/bash
# Post-install: 初始化运行环境
# install_callback 是应用正式安装阶段，此时框架环境变量目录才生成

export PATH=/var/apps/nodejs_v22/target/bin:$PATH

echo "[FPK] Preparing Chat2API environment..."

# 1. 准备数据/日志/socket 目录
#    用 TRIM_PKGVAR(运行时数据) 而非硬编码路径
DATA_DIR="${TRIM_PKGVAR}/data"
SOCKET_DIR="${TRIM_APPDEST}/target"
mkdir -p "$DATA_DIR/logs" "$SOCKET_DIR"

# 2. 校验 Node.js 运行时
if ! command -v node > /dev/null 2>&1; then
  echo "错误：未找到 Node.js 运行时，请确认已安装 nodejs_v22 依赖应用" > "$TRIM_TEMP_LOGFILE"
  exit 1
fi
echo "[FPK] Node version: $(node -v)"

# 3. 校验 API 端口是否被占用（checkport 之外的二次保险）
API_PORT="${TRIM_SERVICE_PORT:-26800}"
if ss -tuln 2>/dev/null | grep -q ":$API_PORT "; then
  echo "错误：API 端口 ${API_PORT} 已被占用，请在应用设置中更换端口" > "$TRIM_TEMP_LOGFILE"
  exit 1
fi

# 4. 安装/校验 Node 依赖
#    注意：依赖必须在 Linux(Debian) 下构建，Windows/Mac 构建的原生模块不可用
cd "${TRIM_APPDEST}/server" || exit 1
if [ ! -d "node_modules" ]; then
  echo "[FPK] Installing dependencies..."
  npm install --production --no-audit --no-fund 2>&1 | tail -5
fi

# 5. 初始化默认配置（若首次安装）
if [ ! -f "$DATA_DIR/config.json" ]; then
  cat > "$DATA_DIR/config.json" << 'CONFIGEOF'
{
  "apiPort": 26800,
  "apiKey": "",
  "autoStart": true
}
CONFIGEOF
  echo "[FPK] Default config created"
fi

echo "[FPK] Chat2API install complete"
exit 0
```

> 💡 **`TRIM_TEMP_LOGFILE`**：脚本失败时把清晰的错误信息写入该变量指向的文件再 `exit 1`，fnOS 会以对话框形式展示给用户。这是 fnOS V1.1.8+ 的标准错误处理约定。

**`chat2api/cmd/uninstall_callback`**：

```bash
#!/bin/bash
# Pre-uninstall: 停止应用进程并清理 socket
# 进程由 fnOS 框架通过 cmd/main stop 管理，此处做兜底清理
pkill -f "server-entry.js" 2>/dev/null
sleep 1
rm -f "${TRIM_APPDEST}/target/app.sock" 2>/dev/null
# 注意：不要删除 TRIM_PKGVAR 数据目录 —— fnOS 卸载时保留 var 和 shares 以保护用户数据
echo "[FPK] Chat2API uninstalled (data preserved in var/)"
exit 0
```

**`chat2api/cmd/config_callback`**（配置变更回调）：

```bash
#!/bin/bash
# 配置变更后重启服务
systemctl restart chat2api.service
exit 0
```

### 步骤 9：创建安装向导

**`chat2api/wizard/`** — fnOS 安装向导配置（JSON 格式）：

```json
[
  {
    "title": "管理密钥设置",
    "desc": "设置 Chat2API 管理 API 的访问密钥，请妥善保管",
    "fields": [
      {
        "name": "chat2api_api_key",
        "label": "管理 API Key",
        "type": "password",
        "required": true,
        "default": "chat2api-fpk-secret-2026",
        "desc": "用于管理接口鉴权，建议修改默认值"
      }
    ]
  },
  {
    "title": "端口配置",
    "desc": "仅需配置 API 代理端口。管理界面通过系统统一网关 /app/chat2api 访问，不占用端口。",
    "fields": [
      {
        "name": "chat2api_api_port",
        "label": "OpenAI API 代理端口",
        "type": "number",
        "required": true,
        "default": "26800",
        "desc": "外部客户端（Cline/Cherry Studio 等）通过 http://NAS-IP:此端口/v1 接入。已避开 8080/8090/3000/9000 等常规端口段"
      }
    ]
  }
]
```

### 步骤 10：构建前端为静态文件

```bash
# 在 Chat2API-WXS 源码目录
cd D:/project/FnDepot/../Chat2API-WXS-src

# 修改 vite.config.ts，将构建输出指向 chat2api/ui/
# base: '/chat2api/'  (fnOS 桌面 UI 路径前缀)

# 构建前端
npx vite build --outDir ../FnDepot/chat2api/ui --emptyOutDir

# 或使用 electron-vite 仅构建 renderer 部分
npx electron-vite build --renderer
```

构建产物（`index.html`, `assets/`, JS/CSS bundles）输出到 `chat2api/ui/` 目录，fnOS 通过 `desktop_uidir = ui` 自动识别。

### 步骤 11：编译服务端（⚠️ 必须在 Linux 容器内构建）

> 🔴 **踩坑警告（来自 Comic_Management 案例）**：在 Windows / macOS 上 `npm install` 得到的 `node_modules` 含有平台相关原生模块，**直接在飞牛（Debian Linux）上运行会崩溃**。必须用 Docker **Debian 系**镜像重建。
>
> **绝对不能用 Alpine 镜像** —— musl libc 与 glibc 不兼容，原生模块会加载失败。

```bash
# 在 chat2api/app/server/ 目录
cd D:/project/FnDepot/chat2api/app/server

# 复制 Chat2API-WXS 的服务端源码
cp -r ../../../Chat2API-WXS-src/src/main/proxy ./proxy
cp -r ../../../Chat2API-WXS-src/src/main/providers ./providers
cp -r ../../../Chat2API-WXS-src/src/main/oauth ./oauth
cp -r ../../../Chat2API-WXS-src/src/main/store ./store
cp -r ../../../Chat2API-WXS-src/src/main/data ./data
cp -r ../../../Chat2API-WXS-src/src/main/requestLogs ./requestLogs
cp -r ../../../Chat2API-WXS-src/src/main/logger ./logger
cp -r ../../../Chat2API-WXS-src/src/shared ./shared
cp ../../../Chat2API-WXS-src/src/main/lib ./lib

# 复制非 TS 资源（wasm, json 等）
cp ../../../Chat2API-WXS-src/sha3_wasm_bg.*.wasm .

# ★ 关键：用 Debian 系镜像在 Linux 容器内完成 依赖安装 + TypeScript 编译
#    （前端构建见步骤 10，也可在此一并完成）
docker run -it --rm \
  -v "$(pwd)":/app \
  -w /app \
  node:22-slim \
  sh -c "npm install --production --no-audit --no-fund && npx tsc --outDir . --module commonjs --target es2020"
```

**构建产物校验清单：**
- [ ] `node_modules/` 是在 Linux 下生成的（检查 `.node` 后缀的原生模块）
- [ ] `sha3_wasm_bg.*.wasm` 已复制到产物目录
- [ ] TypeScript 已编译为 `.js`（`server-entry.js` 存在）
- [ ] 在容器内跑一次 `node server-entry.js` 冒烟测试

> 💡 `node:22-slim` 对应 manifest 中声明的 `install_dep_apps=nodejs_v22`，版本需保持一致，避免 ABI 不兼容。

### 步骤 12：创建打包脚本

**`chat2api/_build_fpk.py`**（基于原版改造）：

```python
"""Build chat2api.fpk from app/ directory + ui/ + cmd/ etc."""
import tarfile
import os
import shutil
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE_DIR, 'app')
APP_TGZ = os.path.join(BASE_DIR, 'app.tgz')
FPK_FILE = os.path.join(BASE_DIR, 'chat2api.fpk')

def build_app_tgz():
    """Create app.tgz from app/ directory"""
    print('Building app.tgz...')
    with tarfile.open(APP_TGZ, 'w:gz') as tgz:
        for root, dirs, files in os.walk(APP_DIR):
            for fname in files:
                # 跳过 node_modules
                if 'node_modules' in root:
                    continue
                full_path = os.path.join(root, fname)
                arcname = os.path.relpath(full_path, os.path.dirname(APP_DIR))
                tgz.add(full_path, arcname)
                print(f'  + {arcname} ({os.path.getsize(full_path)} bytes)')
    print(f'  -> {os.path.getsize(APP_TGZ)} bytes')

def build_fpk():
    """Create final chat2api.fpk"""
    print('Building chat2api.fpk...')
    includes = [
        'app.tgz', 'config', 'cmd', 'ICON.PNG', 'ICON_256.PNG',
        'manifest', 'ui', 'wizard', 'www',
    ]
    with tarfile.open(FPK_FILE, 'w:gz') as fpk:
        for name in includes:
            path = os.path.join(BASE_DIR, name)
            if os.path.exists(path):
                fpk.add(path, name)
                size = os.path.getsize(path) if os.path.isfile(path) else 0
                print(f'  + {name} ({size if size else "dir"} bytes)')
            else:
                print(f'  - {name} (not found, skipped)')
    print(f'  -> {os.path.getsize(FPK_FILE)} bytes')

if __name__ == '__main__':
    if os.path.exists(APP_TGZ):
        os.remove(APP_TGZ)
    build_app_tgz()
    if os.path.exists(FPK_FILE):
        os.remove(FPK_FILE)
    build_fpk()
    print('\nBUILD COMPLETE')
```

### 步骤 13：在 fnpack.json 中注册应用

在 `D:\project\FnDepot\fnpack.json` 中追加 chat2api 条目：

```json
{
  "traefik": { ... },
  "moviepilot": { ... },
  "chat2api": {
    "display_name": "Chat2API",
    "platform": "all",
    "version": "1.6.5",
    "desc": "统一管理多个AI服务商：DeepSeek、GLM、Kimi、Qwen 等，提供 OpenAI 兼容 API 接口转发，支持 OAuth 登录、上下文管理、工具调用、模型映射、负载均衡。API 代理端口 26800（已避开常规端口段），管理界面经系统统一网关 /app/chat2api 访问、不占端口。",
    "labels": "AI,API代理,OpenAI兼容,大模型",
    "distributor": "narrator-z",
    "distributor_url": "https://github.com/narrator-z/FnDepot",
    "bug_report_url": "https://github.com/narrator-z/FnDepot/issues",
    "install_type": "系统空间",
    "isdocker": "false",
    "size": "",
    "download_url": "https://github.com/narrator-z/FnDepot/releases/download/vchat2api-1.6.5/chat2api_all.fpk",
    "changelog": "基于 Chat2API-WXS v1.6.5 重新构建：新增 OAuth 登录、上下文管理、工具调用、模型映射、自定义供应商支持"
  }
}
```

---

## 四、关键修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `chat2api/manifest` | 新建 | fnOS 应用清单，version=1.6.5 |
| `chat2api/cmd/main` | 新建 | 守护进程入口，启动 Node.js Koa 服务 |
| `chat2api/cmd/install_callback` | 新建 | 安装后初始化：目录/依赖/端口校验（**不建 systemd**） |
| `chat2api/cmd/uninstall_callback` | 新建 | 卸载时兜底清理进程与 socket（**保留 var 数据**） |
| `chat2api/cmd/config_callback` | 新建 | 配置变更后重启服务 |
| `chat2api/app/server/server-entry.ts` | 新建 | Headless 入口，替代 Electron index.ts |
| `chat2api/app/server/routes/mgmt-routes.ts` | 新建 | 管理 API 路由（IPC→HTTP 改造） |
| `chat2api/app/server/proxy/*` | 从 WXS 复制 | Koa 代理服务器核心（直接复用） |
| `chat2api/app/server/providers/*` | 从 WXS 复制 | 服务商适配器（直接复用） |
| `chat2api/app/server/oauth/*` | 从 WXS 复制 | OAuth 登录（直接复用） |
| `chat2api/app/server/store/*` | 从 WXS 复制 | 数据持久化（修改默认路径） |
| `chat2api/ui/*` | 构建生成 | React 构建产物（静态文件） |
| `chat2api/wizard/` | 新建 | fnOS 安装向导配置 |
| `chat2api/ICON.PNG` | 复制 | 应用图标 |
| `chat2api/_build_fpk.py` | 新建 | fpk 打包脚本 |
| `chat2api/app/server/package.json` | 新建 | 服务端依赖声明（无 Electron） |
| `fnpack.json` | 修改 | 追加 chat2api 条目 |
| WXS `src/renderer/src/lib/api.ts` | 修改 | preload API → HTTP fetch 改造 |
| WXS `src/renderer/src/stores/*.ts` | 修改 | 将 IPC 调用改为 HTTP API |
| WXS `src/main/store/store.ts` | 修改 | 数据目录改为 fnOS 路径 |
| WXS `vite.config.ts` | 修改 | 构建输出到 ui/ 目录 |

---

## 五、依赖配置

### 5.1 服务端依赖（app/server/package.json）

**保留（运行时必需）：**

| 依赖 | 版本 | 用途 |
|------|------|------|
| koa | ^2.15.3 | HTTP 服务器框架 |
| @koa/router | ^15.3.0 | 路由 |
| koa-bodyparser | ^4.4.1 | 请求体解析 |
| koa-static | ^5.0.0 | 静态文件服务 |
| axios | ^1.7.7 | HTTP 客户端（调用 AI API） |
| eventsource-parser | ^3.0.6 | SSE 流式响应解析 |
| mime-types | ^3.0.2 | MIME 类型 |
| js-sha3 | ^0.9.3 | SHA3 哈希（认证用） |
| zstd-codec | ^0.1.5 | Zstandard 压缩 |
| electron-store | ^10.0.0 | JSON 持久化存储 |

**移除（Electron 桌面端专用）：**

| 依赖 | 移除原因 |
|------|----------|
| electron | 核心框架，fnOS 无需 |
| electron-updater | fnOS 自带更新机制 |
| electron-builder | 桌面打包工具 |
| electron-vite | Electron 专用构建 |
| @radix-ui/* | 前端组件库，仅构建时需要 |
| react / react-dom | 前端框架，仅构建时需要 |
| zustand | 前端状态管理，仅构建时需要 |
| recharts | 图表库，仅构建时需要 |
| i18next / react-i18next | 国际化，仅构建时需要 |
| canvas | 测试用 |

### 5.2 前端构建依赖（开发时）

前端构建时仍需完整依赖（在 Chat2API-WXS 源码目录执行 `npm install` + `npm run build`），但构建产物（静态 JS/CSS/HTML）不包含这些依赖，仅作为静态文件被 Koa 服务。

### 5.3 fnOS 运行时要求

- Node.js 18+（fnOS 系统自带或通过应用依赖声明）
- **Node.js 22**：通过 `install_dep_apps=nodejs_v22` 声明，路径 `/var/apps/nodejs_v22/target/bin`（**不依赖 systemd**，进程由 fnOS 框架经 `cmd/main` 管理）
- **端口 26800**（仅 API 代理，可在安装向导/应用设置中调整）；管理 UI 走统一网关 Unix Socket，**不占用 TCP 端口**

---

## 六、目录结构最终形态

```
D:\project\FnDepot\
├── fnpack.json                    # 追加了 chat2api 条目
├── chat2api/                      # ★ 新的 fnOS 应用
│   ├── app/
│   │   └── server/                # 编译后的服务端
│   │       ├── server-entry.js    # Headless 入口
│   │       ├── proxy/             # Koa 代理核心
│   │       │   ├── server.js
│   │       │   ├── loadbalancer.js
│   │       │   ├── sessionManager.js
│   │       │   ├── stream.js
│   │       │   ├── adapters/
│   │       │   ├── routes/
│   │       │   ├── middleware/
│   │       │   ├── services/
│   │       │   ├── toolCalling/
│   │       │   ├── prompt/
│   │       │   └── ...
│   │       ├── providers/         # AI 服务商
│   │       ├── oauth/             # OAuth 登录
│   │       ├── store/             # 数据持久化
│   │       ├── routes/            # 管理 API 路由
│   │       │   └── mgmt-routes.js
│   │       ├── data/
│   │       ├── requestLogs/
│   │       ├── logger/
│   │       ├── lib/
│   │       ├── shared/
│   │       ├── sha3_wasm_bg.*.wasm
│   │       └── package.json       # 服务端依赖
│   ├── cmd/                       # fnOS 生命周期脚本
│   │   ├── main
│   │   ├── install_callback
│   │   ├── uninstall_callback
│   │   ├── config_callback
│   │   ├── config_init
│   │   └── uninstall_init
│   ├── config/                    # 配置文件
│   ├── ui/                        # ★ React 构建产物 + 网关入口配置
│   │   ├── config                # 入口配置（统一网关 gatewayPrefix/gatewaySocket）
│   │   ├── images/               # 桌面图标
│   │   │   ├── icon_64.png
│   │   │   └── icon_256.png
│   │   ├── index.html
│   │   ├── assets/
│   │   │   ├── index-*.js
│   │   │   └── index-*.css
│   │   └── favicon.png
│   ├── target/                   # 运行时生成：app.sock（统一网关 Unix Socket）
│   ├── wizard/                    # 安装向导
│   ├── www/                       # Web 静态文件
│   ├── manifest                   # fnOS 清单
│   ├── ICON.PNG
│   ├── ICON_256.PNG
│   ├── _build_fpk.py
│   └── README.md
├── moviepilot/                    # 已有
├── scripts/                       # 已有
└── traefik/                       # 已有
```

---

## 七、构建与部署流程

```bash
# 1. 构建前端
cd Chat2API-WXS-src && npm install && npm run build
# 构建产物输出到 ../FnDepot/chat2api/app/ui/

# 2. 编译服务端
cd ../FnDepot/chat2api/app/server
npx tsc --outDir . --module commonjs --target es2020

# 3. 打包 fpk
cd ../FnDepot/chat2api
python _build_fpk.py
# 生成 chat2api.fpk

# 4. 部署到 NAS
python _deploy_fpk.py
# 或手动: scp chat2api.fpk narratorz@192.168.31.145:/tmp/
#         ssh 192.168.31.145 "appcenter-cli install-local /tmp/chat2api.fpk"
```

---

## 八、注意事项与风险

1. **OAuth 登录流程**（🟡 中风险）：原 Electron 用 BrowserWindow 打开 OAuth。fnOS 模式改为在用户浏览器中直接跳转，回调地址设为网关路径 `/app/chat2api/oauth/callback`。需注意网关会做登录态校验，OAuth 回调路径必须允许已登录用户访问，且路径要"窄而明确"（只开放必要的方法和数据）。

2. **electron-store 兼容性**（🟢 低）：底层是 Node.js `fs`，纯 Node 环境可正常工作，但默认数据路径（`~/.chat2api/`）需改为 `${TRIM_PKGVAR}/data`。

3. **WASM 模块**（🟡 中）：`sha3_wasm_bg.*.wasm` 需确保在 fnOS 的 Node.js 22 下正确加载，路径建议运行时基于 `TRIM_APPDEST` 动态解析而非硬编码。

4. **端口冲突**（🟢 低，已解决）：管理 UI 走统一网关不占端口；API 代理用 `26800`，并保留 `checkport=true` 由 fnOS 启动前检测，`install_callback` 中再做二次校验。**从旧版 8080/8081 升级时，需在 `upgrade_callback` 提示端口变更**。

5. **Node.js 版本**（🟢 低，已解决）：声明 `install_dep_apps=nodejs_v22` 复用飞牛官方运行时，无需手动安装 NodeSource。脚本中记得 `export PATH=/var/apps/nodejs_v22/target/bin:$PATH`。

6. **原生模块 Linux 兼容**（🟡 中，易踩坑）：**必须**用 Docker Debian 系镜像（`node:22-slim`）重建 `node_modules`，Windows/Mac 构建的产物在飞牛上会崩溃；**禁止 Alpine**（musl libc 不兼容）。

7. **IPC→HTTP 改造量**（🟡 中，但可机械完成）：按 0.4 节策略 —— **只替换传输层，业务逻辑提取为纯函数复用**，不做重写。建议先生成完整的 `IPC channel → HTTP route` 映射表再动手。

8. **统一网关鉴权**（🟡 中）：网关只校验 NAS 登录态，**不负责业务权限**。管理接口仍需自行校验 `X-Trim-Isadmin`，普通用户不应能改服务商/账户配置。切勿信任客户端传入的用户 ID，一律用网关转发的 `X-Trim-Userid`。

9. **数据保护**（🟢 低）：卸载时 fnOS 会保留 `var` 和 `shares` 目录，`uninstall_callback` 中**不要**删除 `${TRIM_PKGVAR}`，避免用户配置丢失。

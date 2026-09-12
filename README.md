# FnDepot 第三方应用源

为**飞牛 fnOS** 收录可用 `.fpk` 应用的第三方源，由社区维护（发布者：narrator-z）。

> **先搞清楚这里是什么**：本仓库是 **FnDepot 生态里的一个「源」**，而不是商店客户端本身。
> **FnDepot 商店客户端**是另一个独立项目（上游：[`EWEDLCM/FnDepot`](https://github.com/EWEDLCM/FnDepot)）——
> 你需要先装上那个客户端，再把本仓库的地址添加为**源**，才能在里面看到并安装本仓库收录的应用。
> 同类源的地址都形如 `https://github.com/<作者>/FnDepot`。

本仓库因此有两重身份：

- **一个源**：根目录 `fnpack.json` 即源清单，客户端读取它来展示应用列表，`download_url` 指向本仓库自己的 Release；
- **一个源码仓库**：每个应用一个子目录，可复现地从源码重新打包成 `.fpk`。

- 本仓库（源）地址：<https://github.com/narrator-z/FnDepot>
- 商店客户端（需先安装）：<https://github.com/EWEDLCM/FnDepot>
- 问题反馈：<https://github.com/narrator-z/FnDepot/issues>

---

## 应用清单

版本以仓库根目录 `fnpack.json` 与各应用 `manifest` 为准。

| 应用 | 目录 | 版本 | 说明 | 状态 |
|------|------|------|------|------|
| **Traefik 反向代理** | `traefik/` | 1.1.1 | 轻量级反向代理 / 负载均衡，标准 80/443 入口，支持自签 / 自有证书 / Let's Encrypt (ACME) 三种 TLS 模式 | 🚧 **未完成，功能不完善，暂不推荐使用** |
| **MoviePilot** | `moviepilot/` | 3.1.2 | NAS 媒体库自动化管理（订阅、刮削、下载管理） | ✅ 可用 |
| **Chat2API** | `chat2api/` | 1.6.10 | 统一管理多个 AI 服务商，对外提供 OpenAI 兼容 API | ✅ 可用 |

三个应用均为 `install_type = 系统空间`（安装到系统空间，数据目录独立保存）。

---

## 安装方法

### 方式一：通过 FnDepot 商店客户端添加本「源」（推荐）

完整链路分三步。全程在飞牛的图形界面里完成，不需要 SSH。

**第 1 步：先安装 FnDepot 商店客户端**

FnDepot 客户端是一个单独的 `.fpk`（不是本仓库提供的），需要先从上游项目获取并安装：

<https://github.com/EWEDLCM/FnDepot>

安装方式同下方「方式二」的飞牛应用中心手动安装流程（**注意：手动安装入口默认是关闭的，需先开启，见方式二**）。

**第 2 步：在客户端里添加本仓库为源**

打开 FnDepot → 进入**源管理 / 添加源** → 填入本仓库地址：

```
https://github.com/narrator-z/FnDepot
```

**第 3 步：同步并安装**

保存后等待客户端同步（约 1 分钟）。同步完成后，即可在商店里看到本源的三个应用并正常安装、升级。

客户端会读取 `fnpack.json`，按其中的 `version` / `size` / `download_url` 展示与下载对应 fpk。

> 不同版本的 FnDepot 客户端菜单文案可能略有差异，请以你界面上的实际名称为准（大致是「源管理」「添加源」这类入口）。

### 方式二：直接手动安装 `.fpk`

这条路是**绕过客户端、单装某一个应用**的备用方式，也适合自用测试。

**前置条件（重要）：手动安装入口默认是关闭的**

飞牛 fnOS 出于安全考虑默认隐藏「手动安装」。需要先 SSH 登录 NAS，执行以下命令开启：

```bash
appcenter-cli manual-install enable
```

未执行这一步的话，应用中心里**根本看不到**手动安装入口。

**安装步骤**

1. 从 [Releases](https://github.com/narrator-z/FnDepot/releases) 下载对应应用的 `.fpk` 文件（文件名形如 `moviepilot_all.fpk`）；也可直接使用仓库内已发布的同名 fpk。
2. 打开飞牛「**应用中心**」→ 左下角「**手动安装**」→ 选择「**从电脑上传**」或「**从 NAS 添加**」。
3. 选中刚才下载的 `.fpk` 文件，按提示完成安装向导。

> 官方对该入口的明确定位是「**仅用于应用测试用途，不得用于应用分发**」，并提示后续系统更新将补充签名校验逻辑。若你只是想长期使用这些应用，请优先走方式一。

### 安装时的通用注意

- **Docker 依赖**：Traefik 与 MoviePilot 为 Docker 应用（`isdocker = true`）。首次安装需拉取镜像，若拉取失败，请在飞牛的 Docker 配置中设置镜像加速源。
- **Chat2API 依赖 Node.js v22**：`manifest` 中声明 `install_dep_apps = nodejs_v22`，安装时会自动拉取飞牛官方「Node.js v22」运行时；若安装后无法启动，请先在应用中心确认该依赖已就绪。
- **安装向导**：三个应用都会在安装时弹出向导（端口、账号密码、目录等），请按提示填写；这些值写入配置后可在应用「设置」中随时修改。

---

## 各应用安装要点

### Traefik 反向代理（🚧 未完成）

> 当前处于**开发未完成**状态：功能不完善，安装后能否正常使用尚未验证，设计仍在调整中。
> **建议暂时不要安装**，也不要用在需要稳定运行的场景。详见下方「已知问题」。
> 后续实现稳定后会更新此处状态说明。

| 项目 | 值 |
|------|-----|
| Dashboard 端口 | `8080`（飞牛桌面入口，内网直连） |
| 反代入口 | HTTP `80` / HTTPS `443`（可在向导中修改） |
| TLS 模式 | 自签证书（默认）/ 自有证书 / Let's Encrypt (ACME) |
| 类型 | Docker（`isdocker = true`） |

完整的端口、TLS 模式、反代 Docker 应用 / 本机服务 / 局域网设备、自有证书、HTTPS Only 开关等说明，请见 **[`traefik/README.md`](traefik/README.md)**。

> 注意：`traefik/README.md` 部分内容与当前实现不一致（版本号、向导字段名等），见本文档「已知问题」一节的说明。

### MoviePilot

| 项目 | 值 |
|------|-----|
| Web 端口 | `20669`（飞牛桌面入口） |
| 容器内 API 端口 | `47901`（仅容器/回升调使用，通常无需手动访问） |
| 网络模式 | `host`（容器与宿主机共用网络栈） |
| 类型 | Docker（`isdocker = true`） |

- 安装向导会要求填写**管理员用户名 / 密码**，安装完成后由回调脚本调用 MoviePilot 官方初始化接口自动建号，无需再手动注册。
- 安装向导可自定义**媒体库挂载路径**（默认 `./media`，即应用自身存储；填共享文件夹绝对路径如 `/vol1/1000/影视` 时，需先在飞牛中授权本应用访问该共享文件夹）。
- 数据目录为 `./moviepilot/config` 与 `./moviepilot/core`，升级时保留。

### Chat2API

| 项目 | 值 |
|------|-----|
| 管理界面 | 飞牛统一网关 `/app/chat2api`（Unix Socket，**不占端口**，复用 NAS 登录态） |
| OpenAI 兼容 API | `http://<飞牛地址>:26800/v1` |
| 依赖 | 飞牛官方「Node.js v22」运行时（`nodejs_v22`） |
| 类型 | 非 Docker（`isdocker = false`） |

- 外部客户端（Cline / Cherry Studio / NextChat 等）填 API 地址 `http://<飞牛地址>:26800/v1`，API Key 填安装向导中设置的**访问密钥**（留空表示不鉴权）。
- 若从旧版（1.3.4 及更早）升级：管理界面端口由 `8081` 改为统一网关，API 端口由 `8080` 改为 `26800`，外部客户端需同步改地址。
- 集成 / 二次开发文档见 [`chat2api/INTEGRATION_GUIDE.md`](chat2api/INTEGRATION_GUIDE.md)（方案设计文档，部分细节已过时，文件开头有「与已落地实现的差异」对照表）。

---

## 仓库结构

```
FnDepot/
├── README.md                    # 本文件
├── fnpack.json                  # 应用源清单：应用中心读取（version / size / download_url / changelog）
├── scripts/build_fpk.sh         # 可复现的 fpk 打包脚本
├── .github/workflows/            # CI：自动发版与上游同步
│   ├── publish.yml               # 版本变更 → 重建 fpk → 建 Release
│   ├── build-chat2api.yml        # 构建 Chat2API 核心产物
│   └── auto-update-chat2api.yml  # 定时同步上游 Chat2API-WXS
├── traefik/  moviepilot/  chat2api/   # 各应用源码目录
└── ref/                          # 本地参考草稿（已 gitignore，不入库）
```

---

## 开发者：打包自己的 fpk

### 应用目录约定

每个应用是一个独立子目录，必须满足以下结构（`scripts/build_fpk.sh` 会强制校验，缺一即报错）：

```
<app>/
├── manifest              # 必需。应用元信息（appname / version / display_name / desc / service_port / install_type ...）
├── ICON.PNG              # 必需，文件名必须大写
├── ICON_256.PNG          # 可选，256×256 图标
├── app/                  # 必需。运行内容，打包时整体压成 app.tgz
│   ├── docker/           #   Docker 应用：docker-compose.yaml、traefik.yaml、dynamic/ 等
│   ├── ui/               #   桌面入口配置：config + images/icon_{0}.png
│   └── config/           #   其它随包配置
├── cmd/                  # 必需。生命周期脚本
│   ├── main              #   start / stop / status
│   ├── install_init      install_callback
│   ├── config_init       config_callback
│   ├── upgrade_init      upgrade_callback
│   └── uninstall_init    uninstall_callback
├── config/               # 必需。
│   ├── privilege         #   运行身份（run-as / username / groupname）
│   └── resource          #   资源声明（docker-project / data-share）
└── wizard/               # 必需。安装 / 设置 / 卸载向导定义
    ├── install  config  uninstall
    └── upgrade           #   可选
```

### fpk 包结构

`.fpk` 本质是 **gzip 压缩的 tar**，内含：

| 条目 | 说明 |
|------|------|
| `app.tgz` | `app/` 子树的 tar.gz（去掉 `app/` 前缀） |
| `cmd/` `config/` `wizard/` | 原样打入 |
| `manifest` | 原样打入 |
| `ICON.PNG` | 必需 |
| `ICON_256.PNG` | 可选 |

打包时会自动剔除 `.DS_Store` / `._*` / `.git` / `__MACOSX`，并将包内文件 owner 归一化为 `0:0`。

### 打包命令

```bash
bash scripts/build_fpk.sh <应用目录> <输出目录> [架构]

# 例：
bash scripts/build_fpk.sh chat2api chat2api all
# 产物：chat2api/chat2api_all.fpk
```

### 发布流程（CI）

| 工作流 | 触发 | 作用 |
|--------|------|------|
| `publish.yml` | 推送到 `main` 且 `fnpack.json` 中某应用 `version` 变化（或手动 `workflow_dispatch`） | 从源码重建 fpk、更新 `size` / `download_url`、提交回仓库（`[skip ci]`）、为该版本创建 GitHub Release 并附 fpk |
| `build-chat2api.yml` | 推送 `chat2api/**` 或手动 | 在 `node:22-bookworm-slim` 容器内构建 Chat2API 核心产物并上传 Artifact；手动勾选 `pack_fpk` 时同时打包 fpk |
| `auto-update-chat2api.yml` | 每天定时（UTC 06:00）或手动 | 检查上游 `Chat2API-WXS` 新 tag → 构建 → 验证产物 → 打包 → 发 Release → bump 版本 → 提交 |

要点：

- **仅在版本号变更时自动发布**。改了源码但没 bump `version`，不会发新包（避免 WIP 被提前发布）。
- `download_url` 始终指向该版本**固定的 Release 资产链接**，可回滚、不随分支漂移。Release tag 格式为 `v<app>-<version>`（如 `vmoviepilot-3.1.2`）。
- **Chat2API 是例外**：它的核心产物（`app/server/` 下的 `core/` + `node_modules/`，含 `canvas` 等必须在 Linux + glibc 下编译的原生模块）由 `build-chat2api.yml` / `auto-update-chat2api.yml` 在 Debian 12 容器内构建——因为飞牛 fnOS 同为 Debian 12（glibc 2.36），在高版本 glibc 上编译的原生模块在低版本上会加载失败。仓库里只保留骨架，因此 `publish.yml` 中**有守卫跳过 chat2api**；它的 fpk 需由 `build-chat2api.yml`（勾选 `pack_fpk`）或手动发布。

---

## 已知问题

### 1. Traefik 开发未完成，暂不推荐使用

`traefik` 目前处于**开发未完成**状态，功能不完善，安装与使用流程尚未验证通过，设计仍在调整。历史尝试中曾出现安装报错（错误码 **16001** / **10266**），该问题是否已解决**未经验证**。

因此：

- 建议**暂时不要安装**，尤其不要用于生产环境或承载关键流量；
- `traefik/README.md` 描述的部分能力属于**设计目标**，不代表当前实现可用的功能；
- 该应用的状态与文档会在实现稳定后一并更新。

### 2. `traefik/README.md` 与当前实现不一致

`traefik/README.md` 描述的是**设计目标与规划中的用法**，不是已实现并验证的功能。它与当前 `manifest` / `wizard/` 存在多处不一致（版本号停留在 1.1.0、向导字段名与实际不符、部分配置项在代码中并不存在等）。

请以 `manifest` 与 `wizard/` 下的定义为唯一事实来源；该文档会在 traefik 实现稳定后重写。

### 3. Chat2API 管理界面白屏（已修复）

1.6.8 之前，管理界面会出现白屏：根因是 fpk 内缺少 `electron` 包导致 `require("electron")` 抛错，且错误被 `locateEntry()` 静默吞掉。1.6.8 引入随包附带的纯 Node `electron` 替身包并让错误抛出真实原因；1.6.9 至 **1.6.10** 继续修复了无尾斜杠网关前缀下静态资源路径解析错误的问题（`/app/chat2api` 相对路径被解析到 `/app/assets/`，服务端 fallback 返回 HTML 而非 JS）。当前版本 1.6.10 已修复，若你仍遇到白屏，请确认安装的是 1.6.10。

### 4. MoviePilot 历史数据迁移风险（已修复）

3.0.0 ~ 3.0.2 期间目录名曾误改为大写 `MoviePilot`，可能导致升级时卸载旧应用并删除其配置数据目录。3.0.4 起目录名与 `fnpack.json` 键统一为小写 `moviepilot`，与 `manifest` 的 `appname` 一致。使用 3.1.2 不受影响。

---

## 反馈与贡献

- **问题反馈 / Bug 报告**：<https://github.com/narrator-z/FnDepot/issues>
- **贡献新应用或修复**：欢迎提交 PR。建议结构：
  1. 在仓库根目录新建 `<appname>/` 子目录，按上文「应用目录约定」补齐 `manifest` / `ICON.PNG` / `app/` / `cmd/` / `config/` / `wizard/`；
  2. 在 `fnpack.json` 中新增该应用条目（`display_name` / `version` / `desc` / `size` / `download_url` / `changelog` 等）；
  3. 本地用 `bash scripts/build_fpk.sh <appname> <appname> all` 验证能正常出包并安装；
  4. 提交 PR，由维护者合并后由 CI 自动发版。

---

## 免责声明

**关于分发方式**：本文档中的「方式二：直接手动安装 `.fpk`」按照飞牛官方定位**仅供应用测试与个人自用**。飞牛官方明确要求该入口「不得用于应用分发」，且系统后续更新将补充签名校验逻辑（届时未签名的手动安装包可能失效）。若你需要长期使用或向他人分发，请走「方式一」的第三方源，或官方应用中心渠道。

**关于上游组件**：本仓库仅提供应用的索引、打包与安装入口，各应用所含上游组件（Traefik、MoviePilot、Chat2API-WXS 等）的版权与安全性由其上游项目负责。请在生产环境使用前充分测试，并妥善保管证书、密钥与管理员凭据。

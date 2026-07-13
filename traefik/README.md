# Traefik 反向代理

轻量级、高性能的开源反向代理与负载均衡器，支持 Docker、Kubernetes 等多种后端，提供自动化服务发现与路由。本应用针对 **FNOS（飞牛）** 做了专门适配，开箱即用，适合在家庭或私有网络中统一管理多条服务的入口流量与 TLS。

> 设计参考成熟的飞牛 Traefik 部署（`ref/traefik-proxy`），已覆盖其全部功能点，并去除个性化配置（域名 / 证书路径 / 公网 IP 等），改为可勾选的通用模板，适配任意飞牛用户。

## 特性

- **标准 80/443 入口**：默认 HTTP `80` / HTTPS `443` 入口（飞牛系统 Web 默认占用 5666/5667，80/443 通常空闲）；若被占用可在安装/设置向导中改为其它端口（如 8088/8443）。
- **基础域名必填**：安装向导要求填写基础域名（如 `nas.example.com`），用于 TLS 证书(ACME 的 SAN)与反代路由的 Host 匹配。
- **三种 TLS 模式**：
  - **自签证书**（默认）：Traefik 自动生成自签证书，开箱即用，浏览器会提示不受信任；
  - **自有证书**：把 `cert/key` 放到飞牛共享目录 `traefik/certificates/` 下（容器内 `/data/certificates`，由 config_callback 自动加载为默认证书），对所有 HTTPS 域名生效；
  - **Let's Encrypt (ACME)**：自动申请可信证书，支持 HTTP-01 挑战（需 80 端口对外可达），可选 Staging 环境调试。
- **自动化服务发现**：对接 Docker provider，仅代理显式打 `traefik.enable=true` 标签的容器，启停后自动更新路由（需将容器连接到 `traefik` 网络，见下文）。
- **内置 Dashboard**：可视化控制面板，飞牛桌面经 `8080` 端口内网直连访问；亦支持经 `443` + BasicAuth 远程访问。
- **真实客户端 IP**：信任 Docker / 内网网段的 `X-Forwarded-*`，后端能拿到真实来源。
- **桌面内嵌支持**：注入 `frame-ancestors *` 等安全头，确保可被飞牛桌面以 iframe 正常内嵌。
- **通用服务目录**：内置常见自建服务（Home Assistant / Emby / Gitea / AList / Vaultwarden 等）的可勾选反代模板。
- **飞牛系统主页反代**：访问 `https://你的域名` 即反代到飞牛主页（复用飞牛 HTTPS 5667）。
- **HTTPS Only 开关**：一键将 HTTP 全量跳转至 HTTPS，默认开启。
- **安装向导**：安装与「设置」页面提供向导，覆盖端口、域名、TLS 模式、HTTPS Only、远程 Dashboard 等，自动写入配置，无需手改文件。

## 文件结构

```
traefik/
├── app/docker/
│   ├── docker-compose.yaml        # 容器编排（端口、挂载、网络、时区、ACME 环境变量）
│   ├── traefik.yaml               # 静态配置（入口 / API / Provider / 日志 / ACME resolver）
│   └── dynamic/                   # ⭐ 种子模板（首次安装时拷贝到数据目录，之后保留修改）
│       ├── middlewares.yml        # secure-headers（内嵌头）、basic-auth、可选 TLS Store
│       └── external-service.yml   # 反代「本机 / 局域网」非 Docker 应用的通用目录（默认注释）
├── cmd/
│   ├── config_callback           # 安装/设置后：依据向导输入生成动态配置（fnos/dashboard/auth/redirect/middlewares）
│   ├── install_callback          # 安装后：调用 config_callback
│   └── uninstall_callback        # 卸载后：按选择保留/删除数据
└── wizard/                       # 安装 / 设置 / 卸载 向导
    ├── install
    ├── config
    └── uninstall
```

> **动态配置生成机制**：`fnos.yml` / `dashboard.yml` / `auth.yml` / `redirect.yml` / `middlewares.yml` 由安装/设置向导（而非手写）生成，写入飞牛**数据目录** `traefik/data/dynamic/`，由 Traefik file provider 热加载，无需重启。修改端口、域名、TLS 模式、HTTPS Only、远程 Dashboard 等，在应用「设置」中改向导值即可，保存后自动重生成。

## 端口

| 容器端口 | 主机映射 | 说明 |
|----------|----------|------|
| 8080 | `${TRIM_SERVICE_PORT}` | Traefik Dashboard（飞牛桌面入口，内网直连） |
| 80 | `${http_port:-80}` | HTTP 入口（web，默认 80，向导可改） |
| 443 | `${https_port:-443}` | HTTPS 入口（websecure，默认 443，向导可改） |

> 飞牛系统 Web 默认占用 `5666` / `5667`，因此 `80` / `443` 在大多数飞牛上空闲、可直接用作标准反代入口。若你的环境 80/443 已被占用（例如其它反代或 lucky），请在安装/设置向导中将 `http_port` / `https_port` 改为其它端口（如 8088/8443）。

## 快速使用

1. 在飞牛应用中心安装并启动本应用。
2. 打开飞牛桌面中的 Traefik，即可访问 Dashboard（端口 8080）。
3. 通过 `https://<你的域名>`（默认 443 端口）访问被代理的服务（默认自签证书，浏览器提示不安全属正常现象）。
4. 安装或首次启动后，建议进入应用「设置」确认**飞牛系统端口**与你的实际端口一致（见下「安装向导」）。

## 安装向导（必需设置）

安装与「设置」页面提供向导，覆盖启动本应用必须的配置项；这些项经 `config_callback` 自动写入动态配置，无需手动改文件。

| 向导字段 | 默认值 | 说明 |
|----------|--------|------|
| 飞牛系统 HTTP 端口 | 5666 | 飞牛「设置 → 网络/常规」的 HTTP 端口（V0.8.22 起默认 5666，更早 8000）。用于反代飞牛主页。 |
| 飞牛系统 HTTPS 端口 | 5667 | 同上，HTTPS 端口（V0.8.22 起 5667，更早 8001）。 |
| 反代域名（必填） | - | 必填。用于 TLS 证书(ACME 的 SAN)与反代路由的 Host 匹配；访问 `https://你的域名` 即反代到飞牛主页。 |
| 时区 | Asia/Shanghai | 容器时区，影响日志时间。 |
| 启用 HTTPS Only | 开 | 开 = HTTP(80) 全量跳转 HTTPS(443)；关 = 双入口并存。 |
| 启用远程 Dashboard | 关 | 开 = 经 443 + BasicAuth 远程访问 Dashboard，需设置账号密码。 |
| Dashboard 账号 / 密码 | admin / 自定义 | 远程 Dashboard 的 BasicAuth 凭据（密码在飞牛侧不会回显）。 |

> 修改任意向导项后保存，应用会自动重生成动态配置并热加载；仅静态 `traefik.yaml`（入口/Provider）不受影响，无需改动。

## 反代分类

本应用的反代对象分为两大类，按需选择配置方式：

| 类别 | 反代对象 | 配置方式 |
|------|----------|----------|
| **A. Docker 应用** | 其它 FnOS 应用容器（运行在 Docker 中） | 由 Docker Provider **自动发现**（其它 FnOS 应用默认就在 `trim-default` 共享网络，只需打标签即可，无需手动写配置）。见下方「反代其它 FnOS 应用容器」。 |
| **B. 非 Docker 应用** | 飞牛系统本身、飞牛本机原生应用、局域网设备 | 配置式：`fnos.yml`（由向导生成的飞牛系统主页，复用飞牛 5666/5667）+ 文件式 `dynamic/external-service.yml`（本机 / 局域网 / 通用目录）。 |

> 入口统一为 `80`(HTTP) 与 `443`(HTTPS)；是否强制 HTTPS 见「HTTPS Only 开关」。

### 飞牛系统主页反代（非 Docker · 特殊目标）

飞牛系统在「设置 → 网络/常规」中可配置自身的 HTTP / HTTPS 端口（**V0.8.22 起默认 `5666` / `5667`**，更早公测版为 `8000` / `8001`）。本应用可直接复用这些端口，把飞牛主页也收编进 Traefik 统一入口。

- 该反代由**安装/设置向导自动生成**（`fnos.yml`），无需手改文件。
- 在向导填写「飞牛系统 HTTP/HTTPS 端口」即可（默认 5666/5667；若你在飞牛设置中改过系统端口，请同步改向导值）。
- 填写「基础域名」后，Traefik 按 Host 匹配反代飞牛主页（经 `80` / `443` 入口访问）；若未填写，则作为兜底网关直接反代飞牛主页。
  - `80` → 转发到飞牛 HTTP 端口（默认 `5666`）
  - `443` → 转发到飞牛 HTTPS 端口（默认 `5667`，自签证书，已跳过校验）
- 若同时开启了「远程 Dashboard」，远程经 `443` 访问飞牛主页会叠加 `dash-auth` 密码保护。

> 端口默认值来自社区整理的 NAS 默认端口表，请以你飞牛「设置 → 网络/常规」中的实际值为准。

## 配置

### 反代其它 FnOS 应用容器（自动发现，类别 A）

Traefik 通过 Docker Provider 读取飞牛应用的共享网络 `trim-default`（取该网络 IP 作为后端地址）。其它 FnOS 应用容器默认就在该网络，只要打上标签即可被自动发现，无需手写 IP：

```yaml
services:
  myapp:
    image: myapp:latest
    networks:
      - trim-default          # 接入飞牛默认应用网络（external）
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.myapp.rule=Host(`app.你的域名.com`)"
      - "traefik.http.routers.myapp.entrypoints=websecure"
networks:
  trim-default:
    external: true
    name: trim-default
```

### 反代飞牛本机 / 局域网服务

编辑 `dynamic/external-service.yml`，按后端所在位置选择地址（三种场景）：

| 场景 | 后端地址写法 |
|------|--------------|
| ① 飞牛本机服务（原生应用 / 宿主机端口） | `http://host.docker.internal:端口` |
| ② 其它 FnOS 应用容器（同 `trim-default` 网络） | `http://容器名:端口`（Traefik 经 Docker DNS 解析） |
| ③ 局域网其它设备 | `http://内网IP:端口` |

```yaml
http:
  routers:
    myservice:
      rule: "Host(`svc.你的域名.com`)"
      entryPoints: [web, websecure]
      service: myservice
  services:
    myservice:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:18080"   # ① 飞牛本机服务
        passHostHeader: true
```

该文件内置 20+ 常见服务的可勾选模板，**默认全部注释**，复制所需条目取消注释即可。保存后 Traefik 会**热加载**，无需重启。

### 使用自有证书（可选）

1. 将证书 `your-domain.crt` / `your-domain.key` 放入飞牛共享目录 `traefik/certificates/`（容器内 `/data/certificates`）。
2. 取消 `dynamic/middlewares.yml` 中 `tls.stores.default.defaultCertificate` 注释并填好文件名。
3. 证书将作为默认证书对所有 `443` 域名自动生效。

> 也可直接挂载飞牛「证书中心」签发的证书：在 `docker-compose.yaml` 取消 `- /vol1/1000/cloud/cert:/cert:ro` 并改为实际路径。

### 修改 Dashboard 远程访问密码

远程 Dashboard（经 `443`）受 BasicAuth 保护，其账号密码在**安装/设置向导**中设置（「启用远程 Dashboard」+ 账号/密码）。修改后保存即生效，哈希由应用自动生成（`auth.yml`）。

若你还需要对 `external-service.yml` 中的**其它服务**做 BasicAuth 保护，可在 `dynamic/middlewares.yml` 的 `basic-auth` 中填入自己的哈希（生成方式）：

```bash
htpasswd -nbB 用户名 密码
```

> 飞牛桌面走 `8080` 内网直连，不经过 BasicAuth；仅远程通过 `443` 访问时需要认证。

### 跳过后端证书校验（可选）

反代使用自签证书的后端（如 PVE）时，在 `external-service.yml` 的 `serversTransports` 中已有 `insecure-skip`，于 service 引用即可：

```yaml
services:
  pve:
    loadBalancer:
      serversTransport: insecure-skip
      servers: [{ url: "https://host.docker.internal:8006" }]
      passHostHeader: true
```

### 真实客户端 IP（进阶，可选）

Traefik 已通过 `forwardedHeaders.trustedIPs` 信任内网网段的 `X-Forwarded-*`。若你的后端**只读取 `X-Real-IP`**（而非 `X-Forwarded-For`），可启用本地插件 `traefik-xff-to-xrealip` 将 XFF 转为 X-Real-IP：

1. 在 `traefik.yaml` 取消 `experimental.localPlugins` 注释；
2. 在 `docker-compose.yaml` 取消 `- ${TRIM_PKGVAR}/plugins:/plugins-local/src` 挂载，并将插件源码放入该目录；
3. 在 `dynamic/middlewares.yml` 取消 `xff2realip` 中间件注释，并将其加入 `secure-headers` 链或单独引用。

> 注意：官方 `traefik:latest` 镜像不含 Go 构建环境，本地插件需在构建镜像时预编译插件，否则会启动失败。生产环境建议用 `forwardedHeaders` 方案，仅在对 `X-Real-IP` 有强需求时启用插件。

### HTTPS Only 开关

默认情况下，应用**同时提供 HTTP(80) 与 HTTPS(443) 两个入口**，局域网明文访问可用。

若希望**仅保留 HTTPS（强制加密）**，在向导中开启「启用 HTTPS Only」开关（或应用「设置」中修改）。开启后应用会自动生成 `redirect.yml`：所有经 `80`(HTTP) 的访问被 `301` 跳转至 `443`(HTTPS)，HTTP 入口不再直出内容。

> **443 为 HTTPS 入口端口**。关闭开关即恢复 HTTP / HTTPS 双入口并存。该行为由 `redirect-to-https` 中间件实现，无需逐条路由配置，也无需手动改 `traefik.yaml`。

## 使用建议

1. 部署前请确认 FNOS 已安装并运行 Docker。
2. 将示例中的 `你的域名.com` 替换为你自己的域名。
3. 动态配置修改后 Traefik 会自动热加载，通常无需重启容器。
4. 日志写入飞牛共享目录 `traefik/data/traefik.log`，便于排查。

## 版本与反馈

- 当前版本：1.1.0
- 问题反馈：https://github.com/narrator-z/FnDepot/issues
- 发布者：narrator-z

> 免责声明：本应用仅提供索引与安装入口，Traefik 版权及安全性由上游项目负责。请在生产环境使用前充分测试，并妥善保管证书与认证凭据。

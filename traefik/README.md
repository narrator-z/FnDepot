# Traefik 反向代理

轻量级、高性能的开源反向代理与负载均衡器，支持 Docker、Kubernetes 等多种后端，提供自动化服务发现与路由。本应用针对 **FNOS（飞牛）** 做了专门适配，开箱即用，适合在家庭或私有网络中统一管理多条服务的入口流量与 TLS。

> 设计参考成熟的飞牛 Traefik 部署（`ref/traefik-proxy`），已覆盖其全部功能点，并去除个性化配置（域名 / 证书路径 / 公网 IP 等），改为可勾选的通用模板，适配任意飞牛用户。

## 特性

- **飞牛端口避让**：入口使用 `50080` / `50443`，避开飞牛系统占用的 `80` / `443`，避免端口冲突导致无法启动。
- **跨应用自动发现**：Traefik 接入飞牛默认应用网络 `trim-default`，自动发现**其它 FnOS 应用容器**并直接以容器名反代（无需手动写 IP）。
- **自动化服务发现**：对接 Docker provider，仅代理显式打 `traefik.enable=true` 标签的容器，启停后自动更新路由。
- **内置 Dashboard**：可视化控制面板，飞牛桌面经 `8080` 端口内网直连访问；亦支持经 `50443` + BasicAuth 远程访问。
- **默认 HTTPS**：`websecure` 入口启用默认自签证书，开箱即用；可替换为自有证书。
- **真实客户端 IP**：信任 Docker / 内网网段的 `X-Forwarded-*`，后端能拿到真实来源（进阶见「真实客户端 IP」）。
- **桌面内嵌支持**：注入 `frame-ancestors *` 等安全头，确保可被飞牛桌面以 iframe 正常内嵌。
- **通用服务目录**：内置 20+ 常见自建服务（Home Assistant / Emby / Gitea / AList / Vaultwarden 等）的可勾选反代模板。
- **飞牛系统主页反代**：直接复用飞牛自身的 HTTP/HTTPS 端口（默认 5666/5667）经 Traefik 访问飞牛主页，无需额外暴露端口。
- **HTTPS Only 开关**：一键将 HTTP(50080) 全量跳转至 HTTPS(50443)，默认关闭（HTTP / HTTPS 双入口并存）。

## 文件结构

```
traefik/app/docker/
├── docker-compose.yaml        # 容器编排（端口、挂载、网络）
├── traefik.yaml               # 静态配置（入口 / API / Provider / 日志 / 可选插件）
└── dynamic/
    ├── middlewares.yml        # secure-headers（内嵌头）、basic-auth、可选中间件与 TLS Store
    ├── dashboard.yml          # 远程 Dashboard 路由（50443 + BasicAuth）
    ├── fnos.yml               # 飞牛系统主页反代（复用飞牛 HTTP/HTTPS 端口 5666/5667）
    └── external-service.yml   # 反代「本机 / 局域网」非 Docker 应用的通用目录（默认注释）
```

## 端口

| 容器端口 | 主机映射 | 说明 |
|----------|----------|------|
| 8080 | `${TRIM_SERVICE_PORT}` | Traefik Dashboard（飞牛桌面入口，内网直连） |
| 50080 | 50080 | HTTP 入口（web，避开系统 80） |
| 50443 | 50443 | HTTPS 入口（websecure，避开系统 443） |

> 飞牛系统默认占用 `80` / `443`，因此本应用不再绑定这两个端口。对外暴露标准 80/443 时，可在飞牛的 lucky 等系统反代中做一层转发，或自行修改 `traefik.yaml` 的 entryPoints。

## 快速使用

1. 在飞牛应用中心安装并启动本应用。
2. 打开飞牛桌面中的 Traefik，即可访问 Dashboard（端口 8080）。
3. 通过 `https://<飞牛IP>:50443` 访问被代理的服务（默认自签证书，浏览器提示不安全属正常现象）。

## 反代分类

本应用的反代对象分为两大类，按需选择配置方式：

| 类别 | 反代对象 | 配置方式 |
|------|----------|----------|
| **A. Docker 应用** | 其它 FnOS 应用容器（运行在 Docker 中） | 由 Docker Provider **自动发现**（接入 `trim-default` 网络 + 打标签），无需手动写配置。见下方「反代其它 FnOS 应用容器」。 |
| **B. 非 Docker 应用** | 飞牛系统本身、飞牛本机原生应用、局域网设备 | 文件式配置：`dynamic/fnos.yml`（飞牛系统主页）+ `dynamic/external-service.yml`（本机 / 局域网 / 通用目录）。 |

> 入口统一为 `50080`(HTTP) 与 `50443`(HTTPS)；是否强制 HTTPS 见「HTTPS Only 开关」。

### 飞牛系统主页反代（非 Docker · 特殊目标）

飞牛系统在「设置 → 网络/常规」中可配置自身的 HTTP / HTTPS 端口（**V0.8.22 起默认 `5666` / `5667`**，更早公测版为 `8000` / `8001`）。本应用可直接复用这些端口，把飞牛主页也收编进 Traefik 统一入口：

- 配置文件：`dynamic/fnos.yml`（默认已写好，仅 Host 为占位域名）。
- 启用：把 `rule` 的 `Host(\`fnos.your-domain.example\`)` 改成你的域名（或飞牛 IP），取消注释即可。
  - `50080` → 转发到飞牛 HTTP 端口（默认 `5666`）
  - `50443` → 转发到飞牛 HTTPS 端口（默认 `5667`，自签证书，已跳过校验）
- 远程经 `50443` 访问会叠加 `basic-auth` 密码保护。

> 若你在飞牛设置中修改过系统端口，请同步改 `fnos.yml` 里的 `5666` / `5667` 两个数字（端口值来自社区整理的 NAS 默认端口表，请以你飞牛设置中的实际值为准）。

## 配置

### 反代其它 FnOS 应用容器（自动发现，类别 A）

Traefik 已接入飞牛默认网络 `trim-default`。只要在**其它**应用的容器上打标签，即可被自动发现，无需手写 IP：

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

1. 将证书 `your-domain.crt` / `your-domain.key` 放入飞牛共享目录 `traefik/data/certificates/`。
2. 取消 `dynamic/middlewares.yml` 中 `tls.stores.default.defaultCertificate` 注释并填好文件名。
3. 证书将作为默认证书对所有 `50443` 域名自动生效。

> 也可直接挂载飞牛「证书中心」签发的证书：在 `docker-compose.yaml` 取消 `- /vol1/1000/cloud/cert:/cert:ro` 并改为实际路径。

### 修改 Dashboard 远程访问密码

`websecure`（50443）上的 Dashboard 受 BasicAuth 保护。请生成自己的哈希并替换 `dynamic/middlewares.yml` 中 `basic-auth` 的值：

```bash
htpasswd -nbB 用户名 密码
```

> 飞牛桌面走 `8080` 内网直连，不经过 BasicAuth；仅远程通过 `50443` 访问时需要认证。

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

### HTTPS Only 开关（可选）

默认情况下，应用**同时提供 HTTP(50080) 与 HTTPS(50443) 两个入口**，局域网明文访问可用。

若希望**仅保留 HTTPS（强制加密）**，开启「HTTPS Only」：

1. 打开 `traefik.yaml`，在 `entryPoints.web.http` 下取消 `middlewares` 注释：

   ```yaml
   web:
     address: ":50080"
     http:
       middlewares:
         - redirect-to-https@file   # 开启后：所有 50080(HTTP) 访问 301 跳转至 50443(HTTPS)
   ```

2. 保存后 Traefik 自动热加载。此后所有经 `50080`(HTTP) 的访问将被 `301` 跳转至 `50443`(HTTPS)。

> **50443 为独立定义的 HTTPS 端口**；关闭本开关（保持注释）即恢复 HTTP / HTTPS 双入口并存。该跳转即 `redirect-to-https` 中间件，由 `web` 入口统一引用，无需逐条路由配置。

## 使用建议

1. 部署前请确认 FNOS 已安装并运行 Docker。
2. 将示例中的 `你的域名.com` 替换为你自己的域名。
3. 动态配置修改后 Traefik 会自动热加载，通常无需重启容器。
4. 日志写入飞牛共享目录 `traefik/data/traefik.log`，便于排查。

## 版本与反馈

- 当前版本：1.0.0
- 问题反馈：https://github.com/narrator-z/FnDepot/issues
- 发布者：narratorz

> 免责声明：本应用仅提供索引与安装入口，Traefik 版权及安全性由上游项目负责。请在生产环境使用前充分测试，并妥善保管证书与认证凭据。

# Traefik 反向代理

轻量级、高性能的开源反向代理和负载均衡器，支持 Docker、Kubernetes 等多种后端，提供自动化服务发现和路由。本应用以 Docker 容器方式部署在 FNOS 上，开箱即用，适合在家庭或私有网络中统一管理多条服务的入口流量与 TLS 证书。

## 特性

- **自动化服务发现**：对接 Docker provider，容器启停后自动更新路由，无需手动维护映射。
- **内置 Dashboard**：提供可视化控制面板，实时查看路由、服务、中间件与健康状态。
- **自动 HTTPS**：集成 ACME（TLS Challenge）自动签发与续期 Let's Encrypt 证书。
- **多 EntryPoint**：默认开放 `80`（web）与 `443`（websecure）入口，并暴露 Dashboard 端口。
- **中间件支持**：基础认证（BasicAuth）、重定向、压缩等中间件开箱即用。

## 部署说明

应用通过 Docker Compose 启动，核心配置如下：

- 镜像：`traefik:latest`
- 容器名：`traefik`
- 重启策略：`unless-stopped`
- 挂载：Docker socket（只读）、`traefik.yaml` 动态配置、`acme.json` 证书存储、共享数据目录 `/data`

### 端口

| 容器端口 | 主机映射 | 说明 |
|----------|----------|------|
| 8080 | `${TRIM_SERVICE_PORT}` | Traefik Dashboard / Web UI |
| 80 | 80 | HTTP 入口（web） |
| 443 | 443 | HTTPS 入口（websecure） |

> Dashboard 地址默认通过 `Host(`traefik.yourdomain.com`)` 与 `Host(`dashboard.yourdomain.com`)` 路由，并启用 BasicAuth 中间件保护。

## 配置

安装后可在应用数据目录中编辑以下文件：

- `traefik.yaml`：Traefik 动态配置文件，用于定义 router / service / middleware。文件内置示例（已注释），按需取消注释并填写你的域名与服务地址即可生效。
- `acme.json`：ACME 证书存储，由 Traefik 自动维护，请勿手动编辑。

### 启用自动 HTTPS

在 `docker-compose.yaml` 的 `command` 段落已预置 ACME 配置：

- 邮箱：`--certificatesresolvers.myresolver.acme.email`（请替换为你的真实邮箱）
- 解析器：`myresolver`，使用 `tlschallenge`
- 在动态配置中将路由的 `tls.certResolver` 指向 `myresolver` 即可自动签发证书

### 修改 Dashboard 密码

默认 BasicAuth 用户为 `user:password`（示例哈希）。请使用 `htpasswd` 生成新哈希并替换 `docker-compose.yaml` 中 `traefik.http.middlewares.auth.basicauth.users` 的值。

## 使用建议

1. 部署前请确认 FNOS 已安装并运行 Docker。
2. 将示例中的 `yourdomain.com`、`your-email@example.com` 替换为你自己的域名与邮箱。
3. 如需对外暴露 Dashboard，请确保域名已正确解析到本机，并配置好防火墙/端口转发。
4. 动态配置修改后，Traefik 会热加载，通常无需重启容器。

## 版本与反馈

- 当前版本：1.0.0（首次发布）
- 问题反馈：https://github.com/narrator-z/FnDepot/issues
- 发布者：narratorz

> 免责声明：本应用仅提供索引与安装入口，Traefik 版权及安全性由上游项目负责。请在生产环境使用前充分测试，并妥善保管证书与认证凭据。

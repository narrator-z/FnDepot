# Traefik 反向代理

轻量级、高性能的开源反向代理和负载均衡器，支持 Docker、Kubernetes 等多种后端，提供自动化服务发现和路由。本应用针对 **FNOS（飞牛）** 做了专门适配，以 Docker 容器方式部署，开箱即用，适合在家庭或私有网络中统一管理多条服务的入口流量与 TLS。

## 特性

- **飞牛端口避让**：入口使用 `50080` / `50443`，避开飞牛系统占用的 `80` / `443`，避免端口冲突导致无法启动。
- **自动化服务发现**：对接 Docker provider，仅代理显式打标签的容器，启停后自动更新路由。
- **内置 Dashboard**：可视化控制面板，飞牛桌面经 `8080` 端口内网直连访问。
- **默认 HTTPS**：`websecure` 入口启用默认自签证书，开箱即用；可替换为自有证书（见下文）。
- **真实客户端 IP**：信任 Docker / 内网网段的 `X-Forwarded-*`，后端能拿到真实来源。
- **桌面内嵌支持**：注入 `frame-ancestors *` 等安全头，确保可被飞牛桌面以 iframe 正常内嵌。

## 文件结构

```
traefik/app/docker/
├── docker-compose.yaml        # 容器编排（端口、挂载、网络）
├── traefik.yaml               # 静态配置（入口/API/Provider/日志）
└── dynamic/
    ├── middlewares.yml        # secure-headers（内嵌头）、basic-auth、TLS Store 模板
    └── external-service.yml   # 反代飞牛本机/局域网服务的示例（默认注释）
```

## 端口

| 容器端口 | 主机映射 | 说明 |
|----------|----------|------|
| 8080 | `${TRIM_SERVICE_PORT}` | Traefik Dashboard（飞牛桌面入口，内网直连） |
| 50080 | 50080 | HTTP 入口（web，避开系统 80） |
| 50443 | 50443 | HTTPS 入口（websecure，避开系统 443） |

> 飞牛系统默认占用 `80` / `443`，因此本应用不再绑定这两个端口。如需对外暴露标准 80/443，请在飞牛的「lucky」等系统反代中做一层转发，或自行修改 `traefik.yaml` 的 entryPoints。

## 快速使用

1. 在飞牛应用中心安装并启动本应用。
2. 打开飞牛桌面中的 Traefik，即可访问 Dashboard（端口 8080）。
3. 通过 `https://<飞牛IP>:50443` 访问被代理的服务（默认自签证书，浏览器会提示不安全，属正常现象）。

## 配置

### 反代 Docker 容器

在**其它** compose 服务中加入 `traefik` 网络并打标签即可被自动发现：

```yaml
services:
  myapp:
    image: myapp:latest
    networks:
      - traefik
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.myapp.rule=Host(`app.你的域名.com`)"
      - "traefik.http.routers.myapp.entrypoints=websecure"
networks:
  traefik:
    external: true
```

### 反代飞牛本机 / 局域网服务

编辑 `dynamic/external-service.yml`，使用 `host.docker.internal` 指向飞牛本机端口（compose 已配置 `host.docker.internal:host-gateway`）：

```yaml
http:
  routers:
    myservice:
      rule: "Host(`svc.你的域名.com`)"
      entryPoints: [websecure]
      service: myservice
  services:
    myservice:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:18080"
        passHostHeader: true
```

保存后 Traefik 会**热加载**，无需重启。

### 使用自有证书（可选）

1. 将证书 `your-domain.crt` / `your-domain.key` 放入飞牛共享目录 `traefik/data`。
2. 取消 `dynamic/middlewares.yml` 中 `tls.stores.default.defaultCertificate` 注释并填好路径。
3. 在 `traefik.yaml` 的 `websecure` 入口引用该 TLS Store。

### 修改 Dashboard 远程访问密码

`websecure`（50443）上的 Dashboard 受 BasicAuth 保护。请生成自己的哈希并替换 `dynamic/middlewares.yml` 中 `basic-auth` 的值：

```bash
htpasswd -nbB 用户名 密码
```

> 飞牛桌面走 `8080` 内网直连，不经过 BasicAuth；仅远程通过 `50443` 访问时需要认证。

## 使用建议

1. 部署前请确认 FNOS 已安装并运行 Docker。
2. 将示例中的 `你的域名.com` 替换为你自己的域名。
3. 动态配置修改后 Traefik 会自动热加载，通常无需重启容器。
4. 日志写入飞牛共享目录 `traefik/data/traefik.log`，便于排查。

## 版本与反馈

- 当前版本：1.0.0（首次发布）
- 问题反馈：https://github.com/narrator-z/FnDepot/issues
- 发布者：narratorz

> 免责声明：本应用仅提供索引与安装入口，Traefik 版权及安全性由上游项目负责。请在生产环境使用前充分测试，并妥善保管证书与认证凭据。

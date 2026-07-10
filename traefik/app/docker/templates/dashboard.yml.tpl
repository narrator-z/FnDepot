# 远程访问 Dashboard —— 由向导「启用远程 Dashboard」生成，经 50443 + BasicAuth 保护
# 飞牛桌面使用 :8080 内网直连（api.insecure=true），无需此路由。
# 仅走 HTTPS(50443)，不暴露明文 HTTP。
# 未填域名时作为 50443 兜底路由；已填域名则按 Host 匹配。

http:
  routers:
    dashboard:
      entryPoints: [websecure]
      __FNOS_RULE__
      service: api@internal
      middlewares:
        - secure-headers@file
        - dash-auth@file
      tls: {}
      priority: 100

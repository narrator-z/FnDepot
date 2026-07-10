# ⭐ 飞牛(FnOS) 系统主页反代 —— 由安装/设置向导自动生成，改向导值后重生成
# 后端复用飞牛系统自身 HTTP/HTTPS 端口（默认 5666/5667，V0.8.22 起）。
# 若你在飞牛设置中改过系统端口，请在向导「飞牛系统端口」填写实际值。
# 用法：
#   - 未填域名：本路由作为兜底网关，直接反代飞牛主页（经 50080 / 50443 均可访问）。
#   - 已填域名：仅当 Host 命中该域名时反代飞牛主页。
# 远程经 50443 访问时叠加 dash-auth 保护（见 auth.yml，由向导生成）。

http:
  routers:
    fnos-system-http:
      entryPoints: [web]
      __FNOS_RULE__
      service: fnos-system-http
      middlewares:
        - secure-headers@file
      priority: 1
    fnos-system-https:
      entryPoints: [websecure]
      __FNOS_RULE__
      service: fnos-system-https
      middlewares:
        - secure-headers@file
      priority: 1

  services:
    fnos-system-http:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:__FNOS_HTTP_PORT__"
        passHostHeader: true
    fnos-system-https:
      loadBalancer:
        serversTransport: fnos-skip-tls          # 飞牛 HTTPS 为自签证书，跳过校验
        servers:
          - url: "https://host.docker.internal:__FNOS_HTTPS_PORT__"
        passHostHeader: true

  serversTransports:
    fnos-skip-tls:
      insecureSkipVerify: true

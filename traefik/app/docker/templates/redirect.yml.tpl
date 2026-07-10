# HTTP → HTTPS 全量跳转 —— 由向导「HTTPS Only」生成，关闭时整文件被删除。
# 开启后：所有经 50080(HTTP) 的访问被 301 跳转到 50443(HTTPS)。
# 该路由优先级(2)高于飞牛兜底路由(1)，确保 HTTP 入口只做跳转、不直出内容。

http:
  routers:
    http-to-https:
      entryPoints: [web]
      rule: "HostRegexp(`.*`)"
      middlewares: [redirect-to-https@file]
      service: dummy-svc
      priority: 2

  services:
    # 跳转路由在发出 301 前不会真正请求后端，dummy 仅用于满足 Traefik 语法要求。
    dummy-svc:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:65535"

  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        port: "50443"
        permanent: true

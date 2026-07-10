# Dashboard 远程访问 BasicAuth —— 由向导自动生成（哈希来自 openssl passwd -apr1），请勿手改。
# 由 dynamic/dashboard.yml 通过 dash-auth@file 引用。

http:
  middlewares:
    dash-auth:
      basicAuth:
        users:
          - "__DASH_USER__:__DASH_HASH__"

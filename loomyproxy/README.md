# Loomy Proxy（飞牛 fnOS 应用）

把 Loomy（讯飞星火 Athena）Web 版模型接成 **OpenAI 兼容接口**，装到飞牛后，局域网内任意客户端可用 `loomy/<模型ID>` 调用。

## 原理

Loomy Web 的登录态是 **HttpOnly Cookie**，外部进程读不到。因此本应用不是一个直连 HTTP 的转发器，而是：

```
客户端 ──HTTP :19999──> proxy.js（容器内）
                            │ connectOverCDP
                            ▼
                   Chromium（loomy-profile/ 持有登录态）
                            │ page.evaluate(fetch('/web/api/chat/completions'))
                            ▼
                   loomy.xunfei.cn/web/api/...
```

Cookie 始终留在浏览器里，代理进程不接触它。

## 登录态：异机生成 + 迁移（关键）

飞牛无图形会话，**不能**在设备上扫码登录。流程：

1. 在有界面的电脑上（脚本来自 `loomy-proxy-integration` 技能的 `scripts/`）：
   ```bash
   npm install playwright && npx playwright install chromium
   node login.js        # 弹出浏览器，扫码/验证码登录，关窗即保存
   ```
2. 把生成的 `loomy-profile/` **目录内的全部内容**拷到飞牛：
   ```
   /var/apps/loomyproxy/target/docker/data/loomy-profile/
   ```
3. 应用中心重启本应用，验证：
   ```bash
   curl http://<飞牛IP>:19999/v1/models    # 返回非空 data 数组即有效
   ```

登录态过期（401 / 模型列表变空）时，重做第 1 步再覆盖拷贝。

## 目录结构

```
loomyproxy/
├── manifest                     # 应用配置（service_port=19999）
├── config/{privilege,resource}  # docker-project 声明
├── cmd/                         # 生命周期脚本（main 从 compose 解析容器名做状态检查）
├── wizard/                      # 安装/配置/升级/卸载向导
├── app/
│   ├── docker/docker-compose.yaml
│   └── ui/{config,images/}
└── build/
    ├── Dockerfile               # node:20-bookworm + Playwright Chromium
    ├── start.sh                 # 先起 CDP 浏览器，再起代理
    └── scripts/                 # proxy.js / cdp-launch.js / check-auth.js
```

## 构建与发布

镜像由 GitHub Actions 构建并推送到 GHCR（多架构 amd64/arm64）：

- 触发：改动 `loomyproxy/build/**` 或手动 `workflow_dispatch`
- 目标：`ghcr.io/narrator-z/loomyproxy:latest`

打包 fpk：

```bash
bash scripts/build_fpk.sh loomyproxy loomyproxy all
```

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `/v1/models` 返回空数组 | 登录态缺失或过期 → 重新生成并拷贝 `loomy-profile` |
| 调用 401 | 同上 |
| 代理报无法连接浏览器 | 容器内 CDP 未起来 → 看容器日志 `launch.log`/stdout |
| 镜像拉取失败 | 检查设备网络与 GHCR 连通性，必要时配置镜像代理 |
| 内存吃紧 | compose 已设 `mem_limit: 1g`，可按 NAS 配置调整 |

/**
 * Chat2API-WXS 的 fnOS 主进程入口。
 *
 * 构建时由 build/build-inner.sh 通过 vite 以 CJS 格式打包进 `core/raw/`，
 * 由飞牛侧的服务端（server-entry.js）require 后调用。
 *
 * ⚠️ 路径约定：本文件会被复制到 WXS 源码树的 `src/main/fnos-entry.ts` 再参与构建，
 *    因此下方相对导入（./proxy/server 等）以 `src/main/` 为基准。
 *    若 build-dev 把它放到其它层级，请相应调整相对路径（或改用 vite alias）。
 *
 * 设计要点：
 *  1. 绝不监听任何 TCP 端口。OpenAI 兼容 API 由飞牛统一服务端监听 26800，
 *     再把 (req, res) 转交本入口 getApiCallback() 返回的 Koa callback 处理。
 *  2. 复用 WXS 真正的 Koa 服务（ProxyServer 单例），只取其实例上的 app.callback()。
 *  3. 通过 electron shim（构建时 'electron' 被 alias 到 shim/electron-node.ts）
 *     拿到与 WXS 业务代码同一套 ipcRegistry / eventBus，把 IPC 调用与事件推送
 *     桥接到 HTTP / SSE。
 */

import { proxyServer } from './proxy/server'
import { proxyStatusManager } from './proxy/status'
import { sessionManager } from './proxy/sessionManager'
import { storeManager } from './store/store'
import { registerIpcHandlers } from './ipc/handlers'

// 来自 electron shim 的桥接原语（构建时 'electron' -> shim/electron-node.ts）
import { ipcRegistry, eventBus, getMainWindow } from 'electron'
import type { IncomingMessage, ServerResponse } from 'http'

let initialized = false

/**
 * 让 ProxyServer.start/stop 只切换 proxyStatusManager 状态、绝不 bind 端口。
 * 飞牛场景下，代理由外部网关（26800）接管，WXS 自带的监听必须禁用，
 * 否则会与飞牛网关抢端口。
 */
function patchProxyServerNeverBinds(): void {
  const PS: any = (proxyServer as any).constructor
  if (PS.prototype.__fnosPatched) return
  let sessionReady = false

  PS.prototype.start = async function (port?: number, host?: string) {
    if (!sessionReady) {
      try {
        sessionManager.initialize()
        sessionReady = true
      } catch (err) {
        console.error('[fnos] sessionManager.initialize failed:', err)
      }
    }
    proxyStatusManager.start()
    proxyStatusManager.setPort(typeof port === 'number' ? port : proxyStatusManager.getPort())
    proxyStatusManager.setHost(host || proxyStatusManager.getHost())
    console.log('[fnos] proxy status marked running (no port bound)')
    return true
  }

  PS.prototype.stop = async function () {
    try {
      sessionManager.destroy()
    } catch (err) {
      console.error('[fnos] sessionManager.destroy failed:', err)
    }
    proxyStatusManager.stop()
    return true
  }

  PS.prototype.__fnosPatched = true
}

/**
 * 初始化（必须在任何 API/IPC 调用之前 await 完成）。
 * 失败会向上抛出，由调用方记录，绝不 process.exit。
 */
export async function init(opts?: { dataDir?: string; version?: string }): Promise<void> {
  if (initialized) {
    console.log('[fnos] init() already called, skipping')
    return
  }

  const dataDir = opts?.dataDir
  if (dataDir) {
    // store 用 os.homedir()（POSIX 下读 HOME），把 HOME 指向 fnOS 数据区。
    // 必须在 storeManager.initialize() 之前设置。
    process.env.HOME = dataDir
    process.env.CHAT2API_DATA_DIR = dataDir
  }
  if (opts?.version) {
    process.env.CHAT2API_UPSTREAM_VERSION = opts.version
  }

  console.log('[fnos] init(): dataDir =', dataDir || '(unset, using HOME)')

  // 安装“只改状态不监听端口”的补丁（需在存储初始化前完成）
  patchProxyServerNeverBinds()

  // 1) 存储（必须最先）
  await storeManager.initialize()

  // 2) 注册 IPC handler。传一个窗口 stub，其 webContents.send 会转 eventBus。
  const mainWindow = getMainWindow()
  await registerIpcHandlers(mainWindow)

  // 3) 手动补齐 ProxyServer.start() 本应做的初始化（我们不走真 start 监听）。
  //    用单例 proxyServer 触发补丁 start，使 /health、状态管理器反映“运行中”。
  const ps = proxyServer as any
  const cfg = storeManager.getConfig()
  const apiPort = (typeof cfg.proxyPort === 'number' && cfg.proxyPort > 0) ? cfg.proxyPort : 26800
  await ps.start(apiPort, '127.0.0.1')

  initialized = true
  console.log(
    '[fnos] initialized. storagePath =',
    typeof storeManager.getStorePath === 'function' ? storeManager.getStorePath() : '(n/a)',
    '| ipcChannels =', ipcRegistry.channels().length
  )
}

/**
 * 把一个 IPC channel 调用分发给 WXS 注册的 handler（供 HTTP /api/ipc 端点调用）。
 * args 必须与 WXS 渲染进程 invoke 时传入的参数顺序一致。
 */
export async function dispatchIpc(channel: string, args: unknown[]): Promise<unknown> {
  if (!ipcRegistry.has(channel)) {
    throw new Error(`[fnos] unknown IPC channel: ${channel}`)
  }
  return ipcRegistry.invoke(channel, Array.isArray(args) ? args : [])
}

/** fire-and-forget 型 IPC 分发（对应 ipcMain.on 注册的 handler）。 */
export function dispatchIpcSend(channel: string, args: unknown[]): void {
  ipcRegistry.send(channel, Array.isArray(args) ? args : [])
}

/**
 * 订阅事件总线（供 SSE /api/events 广播）。返回取消订阅函数。
 * WXS 里 mainWindow.webContents.send(channel, payload) 都会汇聚到这里。
 */
export function subscribeEvents(
  fn: (evt: { channel: string; payload: unknown; timestamp: number }) => void
): () => void {
  return eventBus.subscribe(fn as any)
}

/**
 * 返回 OpenAI 兼容 API 的 Koa handler: (req, res) => void。
 * 飞牛统一服务端监听 26800 后，把每个请求转交此回调处理（流式响应会原样透传）。
 *
 * 取法：ProxyServer 单例上的 Koa 实例（TS 里 private app，编译后是普通属性）。
 */
export function getApiCallback(): (req: IncomingMessage, res: ServerResponse) => void {
  const ps = proxyServer as any
  const koaApp =
    ps?.app ||
    (typeof ps?.getApp === 'function' ? ps.getApp() : null) ||
    (typeof (proxyServer as any).app === 'function' ? (proxyServer as any).app() : null)

  if (!koaApp || typeof koaApp.callback !== 'function') {
    throw new Error('[fnos] cannot obtain Koa app from ProxyServer (app missing after build)')
  }
  return koaApp.callback()
}

/** 便于排查的导出。 */
export function getDiagnostics(): Record<string, unknown> {
  const ps = proxyServer as any
  return {
    initialized,
    storagePath:
      typeof storeManager.getStorePath === 'function' ? storeManager.getStorePath() : null,
    storeInitialized: (storeManager as any).isInitialized === true,
    storageHasError:
      typeof (storeManager as any).hasInitializationError === 'function'
        ? (storeManager as any).hasInitializationError()
        : false,
    ipcChannelCount: ipcRegistry.channels().length,
    ipcChannels: ipcRegistry.channels(),
    eventListenerCount: (eventBus as any).size,
    proxyRunning: proxyStatusManager.getRunningStatus().isRunning,
    proxyPort: proxyStatusManager.getPort(),
    proxyHost: proxyStatusManager.getHost(),
    hasKoaApp: !!(ps && ps.app),
    dataDir: process.env.CHAT2API_DATA_DIR || process.env.HOME || null,
    electronShim: 'electron-node',
  }
}

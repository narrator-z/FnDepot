/**
 * web-ipc.ts
 * ---------------------------------------------------------------------------
 * 浏览器环境下对 Electron `ipcRenderer` 的兼容替身（shim）。
 *
 * 移植策略（团队统一，不要另发明方案）：
 *   不改动 renderer 业务代码一行。构建期把 `preload/index.ts` 机械转换成
 *   `renderer/src/web-api.ts`，把 `ipcRenderer` 换成走 HTTP 的同名对象，
 *   把 `contextBridge` 换成直接挂 `window.electronAPI`。这样 80+ 个
 *   `ipcRenderer.invoke(...)` / `.on(...)` 方法体原样复用。
 *
 * 本文件导出的 `createRendererIpc()` 返回一个“形状与 Electron ipcRenderer 兼容”
 * 的对象，必须至少提供：invoke / send / on / off / removeListener /
 * removeAllListeners，且 on(...) 返回的回调能被 removeListener(...) 精确移除。
 *
 * 与服务端的通信契约（团队统一，必须严格遵守）：
 *   POST {base}/api/ipc        -> invoke 型（有返回值）
 *   POST {base}/api/ipc/send   -> send 型（fire-and-forget）
 *   GET  {base}/api/events     -> SSE 事件流（所有频道共用一条连接）
 *
 * {base} 自适应：经过飞牛统一网关访问时路径带 /app/chat2api 前缀，
 * 本地直连调试时（pathname 不以它开头）前缀为空串。必须在运行时（浏览器里）
 * 计算，不能用构建期常量。
 *
 * 零依赖，纯 TS，能在 vite 的 renderer 构建（浏览器环境）中编译通过；
 * 兼容 Node 18+ / 现代浏览器，不使用过新的 API。
 * ---------------------------------------------------------------------------
 */

// 动态计算网关前缀。必须在浏览器运行时计算（不能用构建期常量）。
function resolveBase(): string {
  try {
    const p = window.location.pathname || ''
    // 网关前缀固定为 /app/chat2api；本地直连（pathname 不以它开头）则无前缀。
    if (p.indexOf('/app/chat2api') === 0) return '/app/chat2api'
  } catch (_) {
    /* 非浏览器环境兜底，保持空串，避免抛出 */
  }
  return ''
}

// 合成一个最小化的 IpcRendererEvent，作为回调第一个参数使用。
// 原 preload 里的 handler 一律形如 (_event, payload) => cb(payload)，
// _event 在业务里被忽略，因此这里只需一个占位对象。
function makeEvent(channel: string): { channel: string; type: string } {
  return { channel, type: 'ipc-message' }
}

// 与 Electron IpcRenderer 兼容的最小接口形状。
export interface RendererIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, callback: (...args: unknown[]) => void): void
  off(channel: string, callback: (...args: unknown[]) => void): void
  removeListener(channel: string, callback: (...args: unknown[]) => void): void
  removeAllListeners(channel?: string): void
}

export function createRendererIpc(): RendererIpc {
  const base = resolveBase()

  // channel -> 该 channel 上的所有回调集合。on/off 都操作这里。
  // 注意：用 Set 保存“原始 callback 引用”，removeListener 才能精确移除
  // （preload 里的清理逻辑会传入当初注册时的同一个函数引用）。
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>()

  // 共享的一条 EventSource 连接。任意 on() 触发首次连接，之后所有频道复用。
  // 浏览器同域并发 EventSource 连接数有限，必须共用一条。
  let es: EventSource | null = null
  let reconnectTimer: any = null // 重连定时器句柄（跨环境类型不同，用 any 兜底）

  function connect(): void {
    if (es && (es.readyState === EventSource.OPEN || es.readyState === EventSource.CONNECTING)) {
      return // 已在连接中，避免重复建连
    }
    try {
      // 服务端 SSE 会把所有频道的事件按 {"channel","payload","timestamp"} 推过来，
      // 我们在前端按 channel 过滤分发，因此只需一条连接即可覆盖全部订阅。
      es = new EventSource(base + '/api/events', { withCredentials: true })
    } catch (err) {
      // 极端情况下 EventSource 构造抛错（如不支持），延迟重试。
      console.warn('[web-ipc] 创建 EventSource 失败，1s 后重试:', err)
      scheduleReconnect()
      return
    }

    es.onmessage = (ev: MessageEvent): void => {
      // 服务端每条 data 都是 JSON；解析失败不应影响其它事件，故 try/catch 包裹。
      let msg: { channel?: string; payload?: unknown; timestamp?: number }
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        console.warn('[web-ipc] SSE 消息 JSON 解析失败，已忽略:', ev.data, e)
        return
      }
      if (!msg || typeof msg.channel !== 'string') return
      dispatch(msg.channel, msg.payload)
    }

    es.onerror = (): void => {
      // EventSource 对瞬时断线会自动重连（readyState 会回到 CONNECTING），无需我们介入。
      // 只有当连接彻底 CLOSED 时（如被服务端关闭、或发生致命错误），自动重连停止，
      // 这时需要我们手动重建连接。
      if (es && es.readyState === EventSource.CLOSED) {
        // 连接已死：关闭旧实例并延迟重建。listeners 映射始终保留，
        // 重建后新事件仍会分发到既有回调——即“重新订阅”的语义由前端映射保证，
        // 不需要向服务端单独声明订阅。
        try { es.close() } catch (_) { /* noop */ }
        es = null
        scheduleReconnect()
      }
      // 若是 CONNECTING / 瞬时错误，交给 EventSource 自带重连即可。
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      // 仅当仍有监听者时才值得重连，避免空连接空转。
      if (listeners.size > 0) connect()
    }, 1000)
  }

  function dispatch(channel: string, payload: unknown): void {
    const set = listeners.get(channel)
    if (!set || set.size === 0) return
    // 还原 Electron 的 (event, ...args) 调用形状：
    //   - 若服务端 payload 是数组，则视为多个参数（Electron 的 send(channel, a, b)）
    //   - 否则视为单个参数（绝大多数频道只发一个值）
    // 这样无论服务端发单值还是数组，preload 里的
    //   const handler = (_event, x) => cb(x)
    // 都能正确收到 x。
    const args = Array.isArray(payload) ? payload : [payload]
    const event = makeEvent(channel)
    set.forEach((cb) => {
      try {
        cb(event, ...args)
      } catch (e) {
        console.error('[web-ipc] 事件回调执行异常（channel=' + channel + '）:', e)
      }
    })
  }

  return {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      const url = base + '/api/ipc'
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 管理接口走同源网关，带 cookie 以便服务端鉴权。
        credentials: 'include',
        body: JSON.stringify({ channel, args }),
      })
        .then(async (resp) => {
          let data: any = null
          try {
            data = await resp.json()
          } catch (_) {
            data = null
          }
          if (!resp.ok) {
            // HTTP 层失败（如 500/404）。优先使用服务端返回的 error 文案。
            const msg = data && data.error ? String(data.error) : 'HTTP ' + resp.status
            throw new Error(msg)
          }
          if (data && data.ok === false) {
            // 业务层失败（ok:false）。服务端会在 error 中给出可读文案。
            throw new Error(data.error ? String(data.error) : 'invoke failed: ' + channel)
          }
          // ok:true -> 返回 result。result 可能为空（undefined），原样返回。
          return data ? data.result : undefined
        })
        .catch((err) => {
          // 网络异常 / 解析异常 / 上述 reject 都汇总到这里，统一 reject 成 Error，
          // 让调用方 .catch 拿到可读错误。
          if (err instanceof Error) throw err
          throw new Error('invoke error: ' + String(err))
        })
    },

    send(channel: string, ...args: unknown[]): void {
      const url = base + '/api/ipc/send'
      // fire-and-forget：不等待结果、不把异常抛到业务层；仅 console.warn 便于排查。
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ channel, args }),
      }).catch((err) => {
        console.warn('[web-ipc] send 失败（channel=' + channel + '）:', err)
      })
    },

    on(channel: string, callback: (...args: unknown[]) => void): void {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(callback as (event: unknown, ...args: unknown[]) => void)
      // 首次有监听者时建立共享 SSE 连接。
      if (!es) connect()
    },

    off(channel: string, callback: (...args: unknown[]) => void): void {
      removeListener(channel, callback)
    },

    removeListener(channel: string, callback: (...args: unknown[]) => void): void {
      const set = listeners.get(channel)
      if (!set) return
      set.delete(callback as (event: unknown, ...args: unknown[]) => void)
      if (set.size === 0) listeners.delete(channel)
    },

    removeAllListeners(channel?: string): void {
      if (channel) {
        listeners.delete(channel)
      } else {
        listeners.clear()
      }
    },
  }
}

export default createRendererIpc

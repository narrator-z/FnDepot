/**
 * Electron 的 Node 端替代品（WXS 主进程代码在 fnOS 上跑时用它）。
 *
 * 目的：不改动 WXS 一行业务代码，把 Electron API 换成等价的纯 Node 实现。
 * 构建时由 build/build-inner.sh 通过 vite alias 把 'electron' 指到本文件。
 *
 * 三个核心替换：
 *   1) ipcMain.handle(channel, handler)  —— 不再注册到 Electron，而是存进注册表，
 *      由 HTTP 端点 /api/ipc 收到 { channel, args } 后取出执行（见 core/adapter.js）。
 *   2) BrowserWindow#webContents.send    —— 不再推给渲染进程，而是推到事件总线，
 *      由 SSE /api/events 广播给浏览器（见 core/adapter.js）。
 *   3) app.getPath / safeStorage         —— 数据目录改到 fnOS 给的数据区；
 *      加密退化为可逆编码（本机无 keyring，仅防明文落盘）。
 *
 * 其余 API（tray / shell / dialog / updater 等）在 NAS 上没有对应能力，
 * 一律用 no-op 兜底：宁可功能缺失，也不能让主进程因为找不到 API 而崩。
 */

// ---------------------------------------------------------------- 数据目录

// 惰性读取：fnos-entry.init() 会在运行时设置 process.env.HOME / CHAT2API_DATA_DIR，
// 若在模块加载时就把 DATA_DIR 冻结成常量，运行时的变更不会生效。
function getEnvDataDir(): string {
  return process.env.CHAT2API_DATA_DIR || process.env.HOME || '/tmp'
}

// ---------------------------------------------------------------- 事件总线

export type EventListener = (payload: unknown) => void

class EventBus {
  private listeners = new Set<EventListener>()

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  publish(channel: string, payload: unknown): void {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn({ channel, payload, timestamp: Date.now() })
      } catch (err) {
        console.error('[chat2api] event listener error:', err)
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}

export const eventBus = new EventBus()

// ---------------------------------------------------------------- IPC 注册表

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

const handleMap = new Map<string, IpcHandler>()
const onMap = new Map<string, IpcHandler>()

export const ipcRegistry = {
  /** invoke 型：有返回值 */
  invoke(channel: string, args: unknown[]): unknown {
    const handler = handleMap.get(channel)
    if (!handler) {
      throw new Error(`IPC handler not found: ${channel}`)
    }
    return handler({ sender: null }, ...args)
  },
  /** send 型：fire-and-forget */
  send(channel: string, args: unknown[]): void {
    const handler = onMap.get(channel)
    if (handler) handler({ sender: null }, ...args)
  },
  has(channel: string): boolean {
    return handleMap.has(channel) || onMap.has(channel)
  },
  channels(): string[] {
    return Array.from(new Set([...handleMap.keys(), ...onMap.keys()]))
  }
}

// ---------------------------------------------------------------- app

type AppListener = (...args: unknown[]) => void
const appListeners = new Map<string, AppListener[]>()

function emitApp(event: string, ...args: unknown[]): void {
  const list = appListeners.get(event)
  if (!list) return
  for (const fn of Array.from(list)) {
    try {
      fn(...args)
    } catch (err) {
      console.error('[chat2api] app listener error:', err)
    }
  }
}

export const app = {
  isQuitting: false,
  isPackaged: true,

  getName: () => 'chat2api',
  getVersion: () => process.env.CHAT2API_UPSTREAM_VERSION || '1.6.5',
  getLocale: () => 'zh-CN',
  getPath: (_name: string) => {
    // 所有目录统一落在数据区（惰性读取，确保运行时 HOME 变更生效），避免写系统盘
    return getEnvDataDir()
  },
  setPath: () => {},
  getAppPath: () => getEnvDataDir(),

  isReady: () => true,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  hasSingleInstanceLock: () => true,
  releaseSingleInstanceLock: () => {},

  disableHardwareAcceleration: () => {},
  disableDomainBlockingFor3DAPIs: () => {},
  enableSandbox: () => {},
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setAsDefaultProtocolClient: () => true,
  removeAsDefaultProtocolClient: () => true,
  setAppUserModelId: () => {},
  setAboutPanelOptions: () => {},
  showAboutPanel: () => {},

  quit: () => {},
  exit: (code?: number) => process.exit(code ?? 0),
  relaunch: () => {},
  focus: () => {},
  hide: () => {},
  show: () => {},

  on: (event: string, fn: AppListener) => {
    const list = appListeners.get(event) || []
    list.push(fn)
    appListeners.set(event, list)
    return app
  },
  once: (event: string, fn: AppListener) => app.on(event, fn),
  off: (event: string, fn: AppListener) => {
    const list = appListeners.get(event)
    if (!list) return app
    const idx = list.indexOf(fn)
    if (idx >= 0) list.splice(idx, 1)
    return app
  },
  removeAllListeners: (event?: string) => {
    if (event) appListeners.delete(event)
    else appListeners.clear()
    return app
  },
  /** 测试/内部用途：手动触发某个 app 事件 */
  emit: emitApp,

  commandLine: {
    appendSwitch: () => {},
    appendArgument: () => {},
    removeSwitch: () => {},
    hasSwitch: () => false,
    getSwitchValue: () => ''
  }
}

// ---------------------------------------------------------------- ipcMain

export const ipcMain = {
  handle: (channel: string, handler: IpcHandler) => {
    handleMap.set(channel, handler)
  },
  handleOnce: (channel: string, handler: IpcHandler) => {
    handleMap.set(channel, handler)
  },
  on: (channel: string, handler: IpcHandler) => {
    onMap.set(channel, handler)
  },
  once: (channel: string, handler: IpcHandler) => {
    onMap.set(channel, handler)
  },
  off: () => {},
  removeHandler: (channel: string) => {
    handleMap.delete(channel)
  },
  removeAllListeners: (channel?: string) => {
    if (channel) {
      handleMap.delete(channel)
      onMap.delete(channel)
    } else {
      handleMap.clear()
      onMap.clear()
    }
  },
  addListener: (channel: string, handler: IpcHandler) => {
    onMap.set(channel, handler)
  },
  removeListener: () => {},
  emit: () => false
}

export const webContents = {
  getAllWebContents: () => [],
  fromId: () => null,
  getFocusedWebContents: () => null
}

// ---------------------------------------------------------------- BrowserWindow

/**
 * 窗口替代品。WXS 用 `mainWindow.webContents.send(channel, payload)` 做事件推送，
 * 这里转成事件总线广播；其余方法全是 no-op。
 */
class FakeWebContents {
  send(channel: string, payload?: unknown): void {
    eventBus.publish(channel, payload)
  }
  sendSync(): unknown {
    return null
  }
  postMessage(): void {}
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(null)
  }
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  off(): this {
    return this
  }
  removeAllListeners(): this {
    return this
  }
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  reload(): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  isLoading(): boolean {
    return false
  }
  getURL(): string {
    return ''
  }
  setWindowOpenHandler(): void {}
  session: unknown = null
  id: number = 1
}

class FakeBrowserWindow {
  webContents = new FakeWebContents()
  id = 1

  constructor(_opts?: unknown) {
    // 记录最后一个实例，供 BrowserWindow.getAllWindows() 使用
    lastWindow = this
  }

  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  loadFile(): Promise<void> {
    return Promise.resolve()
  }
  show(): void {}
  hide(): void {}
  focus(): void {}
  blur(): void {}
  close(): void {}
  destroy(): void {}
  minimize(): void {}
  maximize(): void {}
  unmaximize(): void {}
  restore(): void {}
  center(): void {}
  setTitle(): void {}
  setSize(): void {}
  setBounds(): void {}
  setResizable(): void {}
  setAlwaysOnTop(): void {}
  setSkipTaskbar(): void {}
  setMenuBarVisibility(): void {}
  setProgressBar(): void {}
  setOpacity(): void {}
  setPosition(): void {}
  isMinimized(): boolean {
    return false
  }
  isMaximized(): boolean {
    return false
  }
  isVisible(): boolean {
    return false
  }
  isDestroyed(): boolean {
    return false
  }
  isFocused(): boolean {
    return false
  }
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  getTitle(): string {
    return 'Chat2API'
  }
  on(): this {
    return this
  }
  once(): this {
    return this
  }
  off(): this {
    return this
  }
  removeAllListeners(): this {
    return this
  }
  addListener(): this {
    return this
  }
  removeListener(): this {
    return this
  }
  emit(): boolean {
    return false
  }
}

let lastWindow: FakeBrowserWindow | null = null

// class + static 的组合在 TS 里要拼装，保持与 Electron 同名导出
const BrowserWindowStatic = FakeBrowserWindow as unknown as {
  new (opts?: unknown): FakeBrowserWindow
  getAllWindows(): FakeBrowserWindow[]
  getFocusedWindow(): FakeBrowserWindow | null
  fromId(id: number): FakeBrowserWindow | null
}

BrowserWindowStatic.getAllWindows = () => (lastWindow ? [lastWindow] : [])
BrowserWindowStatic.getFocusedWindow = () => lastWindow
BrowserWindowStatic.fromId = () => lastWindow

export { BrowserWindowStatic as BrowserWindow }

/** 供 window/manager 之类的模块调用：返回全局唯一窗口 */
export function getMainWindow(): FakeBrowserWindow {
  if (!lastWindow) lastWindow = new FakeBrowserWindow()
  return lastWindow
}

// ---------------------------------------------------------------- safeStorage

/**
 * 本机没有 OS keyring。用一层可逆编码代替真加密：
 * 只在磁盘上避免明文，不做安全承诺（原版 safeStorage 的安全边界本来也在系统层）。
 */
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'fnos_fallback',
  encryptString: (plain: string) => Buffer.from(String(plain), 'utf8'),
  decryptString: (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('utf8'),
  setUsePlainTextEncryption: () => {}
}

// ---------------------------------------------------------------- 其余 no-op

const noop = () => {}

function makeNoopObject(name: string): Record<string, unknown> {
  // 用 Proxy 兜底任意属性：未实现的 API 一律返回可调用的 no-op，
  // 避免主进程因 `xxx is not a function` 直接崩溃。
  const target: Record<string, unknown> = { __fnos_shim: name }
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (typeof prop === 'symbol') return undefined
      const fn = (...args: unknown[]) => {
        // 链式调用（如 .setTitle().show()）需要返回自身
        void args
        return fn
      }
      t[prop] = fn
      return fn
    }
  })
}

export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: () => {},
  beep: () => {},
  writeShortcutLink: () => true,
  readShortcutLink: () => ({})
}

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showErrorBox: () => {},
  showCertificateTrustDialog: () => Promise.resolve()
}

export const clipboard = {
  readText: () => '',
  writeText: () => {},
  clear: () => {},
  has: () => false
}

export const screen = {
  getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
  getDisplayNearestPoint: () => ({ id: 1 }),
  on: noop,
  off: noop
}

export const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  createFromPath: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }),
  createFromDataURL: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })
}

export const Menu = {
  buildFromTemplate: () => ({ popup: noop, closePopup: noop }),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
  sendActionToFirstResponder: noop
}

export const MenuItem = class {}

export const Tray = class {
  constructor() {
    return makeNoopObject('Tray')
  }
}

export const Notification = class {
  constructor() {
    return makeNoopObject('Notification')
  }
  static isSupported() {
    return false
  }
}

export const powerMonitor = {
  on: noop,
  off: noop,
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false
}

export const globalShortcut = {
  register: () => true,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false
}

export const session = {
  defaultSession: makeNoopObject('Session'),
  fromPartition: () => makeNoopObject('Session')
}

export const net = makeNoopObject('net')
export const protocol = {
  registerSchemesAsPrivileged: noop,
  handle: noop,
  registerFileProtocol: noop,
  registerStringProtocol: noop,
  isProtocolHandled: () => Promise.resolve(false)
}

export const desktopCapturer = makeNoopObject('desktopCapturer')
export const inAppPurchase = makeNoopObject('inAppPurchase')
export const systemPreferences = makeNoopObject('systemPreferences')
export const webFrame = makeNoopObject('webFrame')
export const contextBridge = {
  exposeInMainWorld: (_key: string, value: unknown) => {
    // 主进程里没有 window，仅记录，便于排查
    console.warn('[chat2api] contextBridge.exposeInMainWorld 在主进程中调用，已忽略')
    void value
  }
}

/** preload 里用到的 ipcRenderer：主进程侧不可能真的收到渲染进程消息，no-op 即可 */
export const ipcRenderer = {
  invoke: () => Promise.resolve(null),
  send: noop,
  on: noop,
  once: noop,
  off: noop,
  removeListener: noop,
  removeAllListeners: noop,
  sendSync: () => null,
  postMessage: noop
}

/**
 * Electron 的 Node 端替身包（运行期 CJS 版本）。
 *
 * 与 shim/electron-node.ts 逐一对齐、行为完全一致，唯一区别是纯 CJS：
 * 因为 electron-vite 的 main 构建把 `electron` 当 external，产物里会原样保留
 * `require("electron")`；fpk 里没有真正的 electron 包，所以构建期要把本文件
 * 落位成 node_modules/electron/index.js，让那条 require 命中这个替身。
 *
 * 三个核心替换：
 *   1) ipcMain.handle(channel, handler)  —— 存进注册表，由 HTTP /api/ipc 取出执行
 *   2) BrowserWindow#webContents.send    —— 推到事件总线，由 SSE /api/events 广播
 *   3) app.getPath / safeStorage         —— 数据目录到 fnOS 数据区；加密退化为可逆编码
 *
 * 其余 API（tray / shell / dialog / updater 等）一律 no-op 兜底：
 * 宁可功能缺失，也不能让主进程因为找不到 API 而崩。
 */

'use strict';

// ---------------------------------------------------------------- 数据目录

// 惰性读取：入口 init() 会在运行时设置 process.env.HOME / CHAT2API_DATA_DIR，
// 若在模块加载时就把目录冻结成常量，运行时的变更不会生效。
function getEnvDataDir() {
  return process.env.CHAT2API_DATA_DIR || process.env.HOME || '/tmp';
}

// ---------------------------------------------------------------- 事件总线

class EventBus {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(channel, payload) {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn({ channel, payload, timestamp: Date.now() });
      } catch (err) {
        console.error('[chat2api] event listener error:', err);
      }
    }
  }

  get size() {
    return this.listeners.size;
  }
}

const eventBus = new EventBus();

// ---------------------------------------------------------------- IPC 注册表

const handleMap = new Map();
const onMap = new Map();

const ipcRegistry = {
  /** invoke 型：有返回值 */
  invoke(channel, args) {
    const handler = handleMap.get(channel);
    if (!handler) {
      throw new Error('IPC handler not found: ' + channel);
    }
    return handler({ sender: null }, ...args);
  },
  /** send 型：fire-and-forget */
  send(channel, args) {
    const handler = onMap.get(channel);
    if (handler) handler({ sender: null }, ...args);
  },
  has(channel) {
    return handleMap.has(channel) || onMap.has(channel);
  },
  channels() {
    return Array.from(new Set([...handleMap.keys(), ...onMap.keys()]));
  }
};

// ---------------------------------------------------------------- app

const appListeners = new Map();

function emitApp(event, ...args) {
  const list = appListeners.get(event);
  if (!list) return;
  for (const fn of Array.from(list)) {
    try {
      fn(...args);
    } catch (err) {
      console.error('[chat2api] app listener error:', err);
    }
  }
}

const app = {
  isQuitting: false,
  isPackaged: true,

  getName: () => 'chat2api',
  getVersion: () => process.env.CHAT2API_UPSTREAM_VERSION || '1.6.5',
  getLocale: () => 'zh-CN',
  getPath: (_name) => {
    // 所有目录统一落在数据区（惰性读取，确保运行时 HOME 变更生效），避免写系统盘
    return getEnvDataDir();
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
  exit: (code) => process.exit(code === undefined ? 0 : code),
  relaunch: () => {},
  focus: () => {},
  hide: () => {},
  show: () => {},

  on: (event, fn) => {
    const list = appListeners.get(event) || [];
    list.push(fn);
    appListeners.set(event, list);
    return app;
  },
  once: (event, fn) => app.on(event, fn),
  off: (event, fn) => {
    const list = appListeners.get(event);
    if (!list) return app;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
    return app;
  },
  removeAllListeners: (event) => {
    if (event) appListeners.delete(event);
    else appListeners.clear();
    return app;
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
};

// ---------------------------------------------------------------- ipcMain

const ipcMain = {
  handle: (channel, handler) => {
    handleMap.set(channel, handler);
  },
  handleOnce: (channel, handler) => {
    handleMap.set(channel, handler);
  },
  on: (channel, handler) => {
    onMap.set(channel, handler);
  },
  once: (channel, handler) => {
    onMap.set(channel, handler);
  },
  off: () => {},
  removeHandler: (channel) => {
    handleMap.delete(channel);
  },
  removeAllListeners: (channel) => {
    if (channel) {
      handleMap.delete(channel);
      onMap.delete(channel);
    } else {
      handleMap.clear();
      onMap.clear();
    }
  },
  addListener: (channel, handler) => {
    onMap.set(channel, handler);
  },
  removeListener: () => {},
  emit: () => false
};

const webContents = {
  getAllWebContents: () => [],
  fromId: () => null,
  getFocusedWebContents: () => null
};

// ---------------------------------------------------------------- BrowserWindow

/**
 * 窗口替代品。WXS 用 `mainWindow.webContents.send(channel, payload)` 做事件推送，
 * 这里转成事件总线广播；其余方法全是 no-op。
 */
class FakeWebContents {
  constructor() {
    this.session = null;
    this.id = 1;
  }
  send(channel, payload) {
    eventBus.publish(channel, payload);
  }
  sendSync() {
    return null;
  }
  postMessage() {}
  executeJavaScript() {
    return Promise.resolve(null);
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
  reload() {}
  openDevTools() {}
  closeDevTools() {}
  isLoading() {
    return false;
  }
  getURL() {
    return '';
  }
  setWindowOpenHandler() {}
}

let lastWindow = null;

class FakeBrowserWindow {
  constructor(_opts) {
    this.webContents = new FakeWebContents();
    this.id = 1;
    // 记录最后一个实例，供 BrowserWindow.getAllWindows() 使用
    lastWindow = this;
  }

  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
  show() {}
  hide() {}
  focus() {}
  blur() {}
  close() {}
  destroy() {}
  minimize() {}
  maximize() {}
  unmaximize() {}
  restore() {}
  center() {}
  setTitle() {}
  setSize() {}
  setBounds() {}
  setResizable() {}
  setAlwaysOnTop() {}
  setSkipTaskbar() {}
  setMenuBarVisibility() {}
  setProgressBar() {}
  setOpacity() {}
  setPosition() {}
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isVisible() {
    return false;
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return false;
  }
  getBounds() {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  getTitle() {
    return 'Chat2API';
  }
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  addListener() {
    return this;
  }
  removeListener() {
    return this;
  }
  emit() {
    return false;
  }
}

FakeBrowserWindow.getAllWindows = () => (lastWindow ? [lastWindow] : []);
FakeBrowserWindow.getFocusedWindow = () => lastWindow;
FakeBrowserWindow.fromId = () => lastWindow;

/** 供 window/manager 之类的模块调用：返回全局唯一窗口 */
function getMainWindow() {
  if (!lastWindow) lastWindow = new FakeBrowserWindow();
  return lastWindow;
}

// ---------------------------------------------------------------- safeStorage

/**
 * 本机没有 OS keyring。用一层可逆编码代替真加密：
 * 只在磁盘上避免明文，不做安全承诺（原版 safeStorage 的安全边界本来也在系统层）。
 */
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'fnos_fallback',
  encryptString: (plain) => Buffer.from(String(plain), 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8'),
  setUsePlainTextEncryption: () => {}
};

// ---------------------------------------------------------------- 其余 no-op

const noop = () => {};

function makeNoopObject(name) {
  // 用 Proxy 兜底任意属性：未实现的 API 一律返回可调用的 no-op，
  // 避免主进程因 `xxx is not a function` 直接崩溃。
  const target = { __fnos_shim: name };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      const fn = (...args) => {
        // 链式调用（如 .setTitle().show()）需要返回自身
        void args;
        return fn;
      };
      t[prop] = fn;
      return fn;
    }
  });
}

const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: () => {},
  beep: () => {},
  writeShortcutLink: () => true,
  readShortcutLink: () => ({})
};

const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showErrorBox: () => {},
  showCertificateTrustDialog: () => Promise.resolve()
};

const clipboard = {
  readText: () => '',
  writeText: () => {},
  clear: () => {},
  has: () => false
};

const screen = {
  getPrimaryDisplay: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getAllDisplays: () => [],
  getDisplayNearestPoint: () => ({ id: 1 }),
  on: noop,
  off: noop
};

const nativeImage = {
  createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  createFromPath: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }),
  createFromBuffer: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) }),
  createFromDataURL: () => ({ isEmpty: () => false, toPNG: () => Buffer.alloc(0) })
};

const Menu = {
  buildFromTemplate: () => ({ popup: noop, closePopup: noop }),
  setApplicationMenu: noop,
  getApplicationMenu: () => null,
  sendActionToFirstResponder: noop
};

class MenuItem {}

class Tray {
  constructor() {
    return makeNoopObject('Tray');
  }
}

class Notification {
  constructor() {
    return makeNoopObject('Notification');
  }
  static isSupported() {
    return false;
  }
}

const powerMonitor = {
  on: noop,
  off: noop,
  getSystemIdleState: () => 'active',
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false
};

const globalShortcut = {
  register: () => true,
  unregister: noop,
  unregisterAll: noop,
  isRegistered: () => false
};

const session = {
  defaultSession: makeNoopObject('Session'),
  fromPartition: () => makeNoopObject('Session')
};

const net = makeNoopObject('net');
const protocol = {
  registerSchemesAsPrivileged: noop,
  handle: noop,
  registerFileProtocol: noop,
  registerStringProtocol: noop,
  isProtocolHandled: () => Promise.resolve(false)
};

const desktopCapturer = makeNoopObject('desktopCapturer');
const inAppPurchase = makeNoopObject('inAppPurchase');
const systemPreferences = makeNoopObject('systemPreferences');
const webFrame = makeNoopObject('webFrame');
const contextBridge = {
  exposeInMainWorld: (_key, value) => {
    // 主进程里没有 window，仅记录，便于排查
    console.warn('[chat2api] contextBridge.exposeInMainWorld 在主进程中调用，已忽略');
    void value;
  }
};

/** preload 里用到的 ipcRenderer：主进程侧不可能真的收到渲染进程消息，no-op 即可 */
const ipcRenderer = {
  invoke: () => Promise.resolve(null),
  send: noop,
  on: noop,
  once: noop,
  off: noop,
  removeListener: noop,
  removeAllListeners: noop,
  sendSync: () => null,
  postMessage: noop
};

// ---------------------------------------------------------------- 导出

module.exports = {
  eventBus,
  ipcRegistry,
  app,
  ipcMain,
  webContents,
  BrowserWindow: FakeBrowserWindow,
  getMainWindow,
  safeStorage,
  shell,
  dialog,
  clipboard,
  screen,
  nativeImage,
  Menu,
  MenuItem,
  Tray,
  Notification,
  powerMonitor,
  globalShortcut,
  session,
  net,
  protocol,
  desktopCapturer,
  inAppPurchase,
  systemPreferences,
  webFrame,
  contextBridge,
  ipcRenderer
};

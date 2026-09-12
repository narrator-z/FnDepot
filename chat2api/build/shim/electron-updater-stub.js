'use strict';

// electron-updater 的 fnOS 替身（no-op stub）。
//
// 飞牛 fnOS 上应用更新走 fnOS 应用市场，没有 Electron 的自动更新通道，
// 因此 autoUpdater 全部 no-op，仅保证主进程代码 require 时不报错、不抛异常。
//
// 构建期由 build/build-inner.sh 生成的 electron.vite.fnos.config.ts 把
// 'electron-updater' alias 到本文件，从而把原 electron-updater 从 bundle 里剔除。

function noop() { return undefined; }

const autoUpdater = {
  // ---- 可写属性（UpdaterManager 会对其赋值）----
  autoDownload: false,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  allowDowngrade: false,
  currentVersion: undefined,
  feedURL: undefined,

  // ---- 事件订阅：no-op，永不触发 ----
  on: noop,
  once: noop,
  off: noop,
  removeListener: noop,
  removeAllListeners: noop,
  addListener: noop,
  emit: noop,

  // ---- 更新操作（全部返回已 resolved 的 Promise，绝不抛错）----
  checkForUpdates: function () { return Promise.resolve(null); },
  checkForUpdatesAndNotify: function () { return Promise.resolve(null); },
  downloadUpdate: function () { return Promise.resolve([]); },
  quitAndInstall: noop,
  getFeedURL: function () { return ''; },
  setFeedURL: noop,
  isUpdaterActive: function () { return false; },

  // ---- 兼容字段占位（部分代码会读取）----
  channel: undefined,
  forceDevUpdateConfig: false,
  logger: undefined,
  netSession: undefined,
  requestHeaders: undefined,
  updaterCacheDirName: 'chat2api-updater'
};

module.exports = { autoUpdater };

// 兼容 `import { autoUpdater, UpdateInfo } from 'electron-updater'` 中的类型命名导出。
// UpdateInfo 在 WXS 里仅作类型使用，这里导出任意值即可，构建期会被擦除。
module.exports.UpdateInfo = {};

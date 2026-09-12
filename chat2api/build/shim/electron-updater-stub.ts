/**
 * electron-updater 的 fnOS 替身（stub）。
 *
 * 飞牛 NAS 上没有 Electron 应用自更新机制——更新由飞牛应用市场负责，
 * 因此 autoUpdater 全部退化为 no-op。这里保留 WXS（UpdaterManager）用到的
 * 全部属性与方法签名，避免构建/运行期因找不到 API 而崩溃。
 *
 * 构建时由 vite alias 把 'electron-updater' 指到本文件即可：
 *   alias: { 'electron-updater': path.resolve(__dirname, 'shim/electron-updater-stub.ts') }
 */

import { EventEmitter } from 'events'

class AutoUpdaterStub extends EventEmitter {
  // WXS 会写入这些属性，必须可赋值
  autoDownload = false
  autoInstallOnAppQuit = true
  allowPrerelease = false
  allowDowngrade = false
  channel: string | null = null
  currentVersion = '0.0.0'

  /**
   * 触发一次检查：直接告知“无可用更新”，避免管理界面卡在 checking 状态。
   * 若需要更明显的提示，可改为 emit('error', new Error('...'))。
   */
  async checkForUpdates(): Promise<unknown> {
    this.emit('update-not-available', {
      version: this.currentVersion,
      releaseDate: '',
      releaseName: '',
      releaseNotes: '',
    })
    return null
  }

  async downloadUpdate(): Promise<string[]> {
    this.emit('error', new Error('[fnos] electron-updater is disabled on fnOS'))
    return []
  }

  quitAndInstall(_isSilent = false, _isForceRunAfter = false): void {
    // 飞牛应用由市场更新，这里什么都不做
  }
}

export const autoUpdater = new AutoUpdaterStub()
export default autoUpdater

// WXS 以 `import { autoUpdater, UpdateInfo } from 'electron-updater'` 引入。
// UpdateInfo 仅作类型使用；但为兼容 esbuild 可能保留的值导入，同时导出同名常量。
export type UpdateInfo = Record<string, unknown>
export const UpdateInfo = {} as Record<string, unknown>

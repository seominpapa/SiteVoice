import { BrowserWindow, nativeTheme, screen, session, type WebContents } from 'electron'
import type { Theme } from '../shared.ts'
import { trustedView } from './boundary.ts'

export const dashboardColor = (theme: Theme) => theme === 'dark' ? '#181818' : '#ffffff'

export function createWindows(name: string, page: string, preload: string) {
  const dashboard = new BrowserWindow({
    title: name, show: false, width: 980, height: 760, minWidth: 690, minHeight: 545,
    backgroundColor: dashboardColor(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'), autoHideMenuBar: true,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  const overlay = new BrowserWindow({
    title: name, show: false, width: 480, height: 116, frame: false, focusable: false,
    skipTaskbar: true, acceptFirstMouse: true, resizable: false, movable: false, fullscreenable: false,
    alwaysOnTop: true, transparent: true, hasShadow: false,
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, spellcheck: false }
  })
  if (process.platform === 'darwin') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })

  function view(contents: WebContents | null, url: string, isMain: boolean) {
    return contents && trustedView({ url, sender: contents.id, isMain }, page, dashboard.webContents.id, overlay.webContents.id)
  }
  function trustedMedia(contents: WebContents | null, isMain: boolean, url?: string) {
    if (!contents || !isMain) return false
    const loaded = contents.getURL()
    return !!view(contents, loaded, true) && (!url || url === loaded || url === page)
  }
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission === 'media' && details.mediaType === 'audio' &&
      trustedMedia(contents, details.isMainFrame, details.requestingUrl))
  session.defaultSession.setPermissionRequestHandler((contents, permission, reply, details) => {
    reply(permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === 'audio' && trustedMedia(contents, details.isMainFrame, details.requestingUrl))
  })
  for (const win of [dashboard, overlay]) {
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.on('will-frame-navigate', event => event.preventDefault())
    win.webContents.on('will-attach-webview', event => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  }

  return {
    dashboard,
    overlay,
    view,
    load: () => Promise.all([dashboard.loadURL(page), overlay.loadURL(page + '#overlay')]),
    showOverlay() {
      const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      const [w, h] = overlay.getSize()
      overlay.setPosition(Math.round(x + (width - w) / 2), y + height - h - 18)
      overlay.showInactive()
    }
  }
}

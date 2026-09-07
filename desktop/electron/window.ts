import { app, BrowserWindow, nativeTheme, shell, type WebContents } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setAuthCallbackWindow } from './protocol-handler'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (!process.env.APP_ROOT) {
  process.env.APP_ROOT = path.join(__dirname, '..')
}

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT!, 'public')
  : RENDERER_DIST

export let win: BrowserWindow | null = null
let authWin: BrowserWindow | null = null
let dashboardWin: BrowserWindow | null = null
let allowAuthClose = false
let allowDashboardClose = false
let dashboardHiddenHandler: (() => void) | null = null
let isAppQuitting = false

const TITLE_BAR_HEIGHT = 48
const TITLE_BAR_BACKGROUND = '#ffffff00'
const AUTH_WINDOW_WIDTH = 480
const AUTH_WINDOW_HEIGHT = 540
const AUTH_WINDOW_MAX_WIDTH = 1254
const AUTH_WINDOW_MAX_HEIGHT = 842

function getTitleBarColors() {
  const isDarkMode = nativeTheme.shouldUseDarkColors
  return {
    backgroundColor: TITLE_BAR_BACKGROUND,
    symbolColor: isDarkMode ? '#ffffff' : '#000000',
  }
}

function updateDashboardTitleBarColors() {
  if (!dashboardWin || dashboardWin.isDestroyed()) return
  const titleBarColors = getTitleBarColors()
  dashboardWin.setTitleBarOverlay({
    color: titleBarColors.backgroundColor,
    symbolColor: titleBarColors.symbolColor,
    height: TITLE_BAR_HEIGHT,
  })
}

function updateAuthTitleBarColors() {
  if (!authWin || authWin.isDestroyed()) return
  const titleBarColors = getTitleBarColors()
  authWin.setTitleBarOverlay({
    color: titleBarColors.backgroundColor,
    symbolColor: titleBarColors.symbolColor,
    height: TITLE_BAR_HEIGHT,
  })
}

function preventRefreshShortcuts(window: BrowserWindow) {
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const isRefreshShortcut = key === 'r' && (input.control || input.meta)

    if (isRefreshShortcut) {
      event.preventDefault()
    }
  })
}

function lockOverlayZoom(window: BrowserWindow) {
  const resetZoom = () => {
    window.webContents.setZoomFactor(1)
    void window.webContents.setVisualZoomLevelLimits(1, 1)
  }

  resetZoom()
  window.webContents.on('did-finish-load', resetZoom)
  window.webContents.on('zoom-changed', (event) => {
    event.preventDefault()
    resetZoom()
  })
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const isZoomShortcut = (input.control || input.meta)
      && (key === '+' || key === '=' || key === '-' || key === '_' || key === '0')
    if (!isZoomShortcut) return
    event.preventDefault()
    resetZoom()
  })
}

export function isAppNavigationUrl(rawUrl: string) {
  try {
    const target = new URL(rawUrl)
    if (VITE_DEV_SERVER_URL) {
      return target.origin === new URL(VITE_DEV_SERVER_URL).origin
    }

    if (target.protocol !== 'file:') return false
    const targetPath = path.resolve(fileURLToPath(target))
    const rendererEntryPath = path.resolve(RENDERER_DIST, 'index.html')
    return targetPath === rendererEntryPath
  } catch {
    return false
  }
}

function openExternalUrl(rawUrl: string) {
  try {
    const target = new URL(rawUrl)
    if (target.protocol !== 'https:' && target.protocol !== 'http:' && target.protocol !== 'mailto:') {
      return
    }
    void shell.openExternal(target.toString())
  } catch {
    // Ignore malformed external navigation requests.
  }
}

function routeExternalLinksToBrowser(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppNavigationUrl(url)) {
      openExternalUrl(url)
    }
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigationUrl(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })
}

export function setAppQuitting(value: boolean) {
  isAppQuitting = value
}

export function createWindow(options: { show?: boolean } = {}) {
  const shouldShow = options.show ?? true

  if (win && !win.isDestroyed()) {
    if (shouldShow) {
      win.show()
      win.focus()
    }
    return win
  }

  win = new BrowserWindow({
    width: 656,
    height: 140,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: shouldShow,
    icon: path.join(process.env.VITE_PUBLIC!, 'orion-app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
    backgroundColor: '#00000000',
  })

  preventRefreshShortcuts(win)
  lockOverlayZoom(win)
  routeExternalLinksToBrowser(win)

  // Make window visible on all workspaces/desktops
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Platform-specific configuration
  if (process.platform === 'darwin') {
    // macOS: hide from mission control
    win.setHiddenInMissionControl(true)
  } else if (process.platform === 'win32') {
    // Windows: set highest always-on-top level
    win.setAlwaysOnTop(true, 'screen-saver')
  }

  // Test active push message to Renderer-process.
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  win.on('closed', () => {
    win = null
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  return win
}

export function createAuthWindow(options: { show?: boolean } = {}) {
  const shouldShow = options.show ?? false

  if (authWin && !authWin.isDestroyed()) {
    setAuthCallbackWindow(authWin)
    if (shouldShow) {
      authWin.show()
      authWin.focus()
    }
    return authWin
  }

  authWin = new BrowserWindow({
    width: AUTH_WINDOW_WIDTH,
    height: AUTH_WINDOW_HEIGHT,
    minWidth: AUTH_WINDOW_WIDTH,
    minHeight: AUTH_WINDOW_HEIGHT,
    maxWidth: AUTH_WINDOW_MAX_WIDTH,
    maxHeight: AUTH_WINDOW_MAX_HEIGHT,
    transparent: false,
    hasShadow: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: false,
    show: shouldShow,
    icon: path.join(process.env.VITE_PUBLIC!, 'orion-app-icon.png'),
    title: 'Orion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#171417',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: {
      color: getTitleBarColors().backgroundColor,
      symbolColor: getTitleBarColors().symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
  })

  setAuthCallbackWindow(authWin)
  preventRefreshShortcuts(authWin)
  routeExternalLinksToBrowser(authWin)
  authWin.setMenuBarVisibility(false)

  // Keep the auth renderer alive when the user clicks the native X so the
  // tray's Log in action can reveal the same window without reloading it.
  authWin.on('close', (event) => {
    if (isAppQuitting || allowAuthClose) {
      return
    }
    event.preventDefault()
    authWin?.hide()
  })

  authWin.on('closed', () => {
    nativeTheme.removeListener('updated', updateAuthTitleBarColors)
    setAuthCallbackWindow(null)
    authWin = null
    allowAuthClose = false
  })

  nativeTheme.on('updated', updateAuthTitleBarColors)

  if (VITE_DEV_SERVER_URL) {
    authWin.loadURL(`${VITE_DEV_SERVER_URL}?view=auth`)
  } else {
    authWin.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: { view: 'auth' },
    })
  }

  return authWin
}

export function closeAuthWindow() {
  if (!authWin || authWin.isDestroyed()) return
  allowAuthClose = true
  authWin.close()
}

export function showAuthWindow() {
  const auth = createAuthWindow({ show: true })
  if (auth.isMinimized()) auth.restore()
  auth.show()
  auth.focus()
  return auth
}

export function createDashboardWindow(noteId?: string) {
  if (dashboardWin && !dashboardWin.isDestroyed()) {
    dashboardWin.show()
    dashboardWin.focus()
    return dashboardWin
  }

  dashboardWin = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    transparent: false,
    hasShadow: true,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    icon: path.join(process.env.VITE_PUBLIC!, 'orion-app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: getTitleBarColors().backgroundColor,
      symbolColor: getTitleBarColors().symbolColor,
      height: TITLE_BAR_HEIGHT,
    },
  })

  dashboardWin.setMenuBarVisibility(false)
  preventRefreshShortcuts(dashboardWin)
  routeExternalLinksToBrowser(dashboardWin)

  // Clicking the native window "X" should hide the dashboard on every
  // platform, not destroy its renderer. Programmatic closes (e.g. during an
  // auth transition) and app quit are still allowed to proceed.
  dashboardWin.on('close', (event) => {
    if (isAppQuitting || allowDashboardClose) {
      return
    }
    event.preventDefault()
    dashboardWin?.hide()
  })

  dashboardWin.on('hide', () => {
    dashboardHiddenHandler?.()
  })

  dashboardWin.on('closed', () => {
    nativeTheme.removeListener('updated', updateDashboardTitleBarColors)
    dashboardWin = null
    allowDashboardClose = false
  })

  nativeTheme.on('updated', updateDashboardTitleBarColors)

  const query = new URLSearchParams({ view: 'dashboard' })
  if (noteId) {
    query.set('noteId', noteId)
  }

  if (VITE_DEV_SERVER_URL) {
    dashboardWin.loadURL(`${VITE_DEV_SERVER_URL}?${query.toString()}`)
  } else {
    dashboardWin.loadFile(path.join(RENDERER_DIST, 'index.html'), {
      query: Object.fromEntries(query.entries()),
    })
  }

  return dashboardWin
}

export function closeDashboardWindow() {
  if (!dashboardWin || dashboardWin.isDestroyed()) return
  allowDashboardClose = true
  dashboardWin.close()
}

export function destroyOverlayWindow() {
  if (!win || win.isDestroyed()) return
  const overlay = win
  win = null
  overlay.destroy()
}

export function getWindow() {
  return win
}

export function getAuthWindow() {
  return authWin
}

export function getDashboardWindow() {
  return dashboardWin
}

export function hideOverlayWindow() {
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setOpacity(0)
  win.hide()
}

function restoreMacOSDock() {
  if (process.platform !== 'darwin') return
  app.setActivationPolicy('regular')
  void app.dock?.show()
}

export function revealDashboardWindow(noteId?: string) {
  hideOverlayWindow()
  restoreMacOSDock()

  if (dashboardWin && !dashboardWin.isDestroyed()) {
    if (noteId) dashboardWin.webContents.send('dashboard:select-note', { noteId })
    if (dashboardWin.isMinimized()) dashboardWin.restore()
    dashboardWin.show()
    dashboardWin.focus()
    return dashboardWin
  }

  const dashboard = createDashboardWindow(noteId)
  dashboard.show()
  dashboard.focus()
  return dashboard
}

export function setDashboardHiddenHandler(handler: (() => void) | null) {
  dashboardHiddenHandler = handler
}

function isWindowSender(window: BrowserWindow | null, sender: WebContents) {
  return Boolean(window && !window.isDestroyed() && window.webContents.id === sender.id)
}

export function isKnownRendererSender(sender: WebContents) {
  return isWindowSender(win, sender) || isWindowSender(authWin, sender) || isWindowSender(dashboardWin, sender)
}

export function isAuthRendererSender(sender: WebContents) {
  return isWindowSender(authWin, sender)
}

export function isOverlayRendererSender(sender: WebContents) {
  return isWindowSender(win, sender)
}

export function isDashboardRendererSender(sender: WebContents) {
  return isWindowSender(dashboardWin, sender)
}

export function setWindow(window: BrowserWindow | null) {
  win = window
}

export function setAuthWindow(window: BrowserWindow | null) {
  authWin = window
}

export function setDashboardWindow(window: BrowserWindow | null) {
  dashboardWin = window
}

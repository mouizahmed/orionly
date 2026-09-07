import { app, desktopCapturer, session } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getCurrentAuthToken, isRendererAuthenticated, setupAuthHandlers } from './auth-handlers'
import {
  setupProtocolHandler,
  setupProtocolEvents,
  setAuthCallbackWindow,
  setBillingWindowRevealHandler,
  setIntegrationWindowRevealHandler,
  isAuthCallbackInProgress,
} from './protocol-handler'
import {
  closeAuthWindow,
  closeDashboardWindow,
  createAuthWindow,
  destroyOverlayWindow,
  isAuthRendererSender,
  isAppNavigationUrl,
  isKnownRendererSender,
  revealDashboardWindow,
  setAppQuitting,
  setAuthWindow,
  setWindow,
  showAuthWindow,
} from './window'
import { setupAttachmentHandlers } from './attachments'
import { setupIpcHandlers } from './ipc-handlers'
import { flushRecordingDraftPersistence, getPendingRecordingNoteId, resetRecordingUiSnapshot, revealDashboardWithDraftFlush } from './recording-ipc'
import { config } from './config'
import { destroyTray, refreshTrayMenu, setupTray } from './tray'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

function isBackendImageProxy(rawUrl: string): boolean {
  try {
    const requestUrl = new URL(rawUrl)
    const backendUrl = new URL(config.backendUrl)
    return requestUrl.origin === backendUrl.origin
      && /^\/api\/notes\/[^/]+\/images\/[^/]+$/.test(requestUrl.pathname)
  } catch {
    return false
  }
}

function configureContentSecurityPolicy() {
  if (!config.isProduction) return

  const backend = new URL(config.backendUrl)
  const websocketBackend = new URL(config.backendUrl)
  websocketBackend.protocol = websocketBackend.protocol === 'https:' ? 'wss:' : 'ws:'

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${backend.origin} ${websocketBackend.origin} https://*.googleapis.com`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame' || !isAppNavigationUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

// Setup protocol handler before app is ready (for OS protocol registration)
setupProtocolHandler()

// Single instance lock - ensure only one instance of the app runs
// This is critical for protocol handling (orion:// URLs)
const gotTheLock = app.requestSingleInstanceLock()
let isQuitting = false
let isReadyForActivation = false

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit()
} else {
  // Setup protocol event listeners (for handling orion:// URLs from second instance)
  setupProtocolEvents()

  app.whenReady().then(async () => {
    configureContentSecurityPolicy()

    // Route renderer getDisplayMedia() requests through Electron desktopCapturer on Windows.
    if (process.platform === 'win32') {
      session.defaultSession.setDisplayMediaRequestHandler(
        async (_request, callback) => {
          if (!isRendererAuthenticated()) {
            callback({})
            return
          }

          try {
            const sources = await desktopCapturer.getSources({ types: ['screen'] })
            const source = sources[0]
            if (!source) {
              callback({})
              return
            }
            callback({
              video: source,
              audio: 'loopback',
            })
          } catch (error) {
            console.error('Failed to handle display media request:', error)
            callback({})
          }
        },
        { useSystemPicker: false },
      )
    }

    // Setup attachment handlers
    setupAttachmentHandlers()
    setIntegrationWindowRevealHandler(() => {
      if (!isRendererAuthenticated()) {
        showAuthWindow()
        return
      }

      revealDashboardWithDraftFlush()
    })
    setBillingWindowRevealHandler(() => {
      if (!isRendererAuthenticated()) {
        showAuthWindow()
        return
      }
      revealDashboardWithDraftFlush()
    })

    // Setup IPC handlers
    setupIpcHandlers()

    // Inject Authorization header on image proxy requests. <img> tags don't send
    // auth headers automatically, so the main process adds them here.
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        const isImageProxy = isBackendImageProxy(details.url)
        const token = getCurrentAuthToken()
        if (isImageProxy && token) {
          callback({
            requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` },
          })
        } else {
          callback({ requestHeaders: details.requestHeaders })
        }
      },
    )

    // Register auth IPC and validate the encrypted main-process session before
    // loading any renderer that could show authenticated application state.
    await setupAuthHandlers({
      isKnownRendererSender,
      isAuthRendererSender,
      onSignedIn: () => {
        closeAuthWindow()
        refreshTrayMenu()
        revealDashboardWindow(getPendingRecordingNoteId())
      },
      onSignedOut: () => {
        refreshTrayMenu()
        resetRecordingUiSnapshot({ clearDraft: false })
        closeDashboardWindow()
        destroyOverlayWindow()
        showAuthWindow()
      },
      onOAuthPending: () => {
        refreshTrayMenu()
        resetRecordingUiSnapshot({ clearDraft: false })
        closeDashboardWindow()
        destroyOverlayWindow()
        showAuthWindow()
      },
    })

    // Create the logged-out auth window first. The recording overlay is
    // created lazily only after an authenticated recording start command.
    createAuthWindow({ show: false })

    // Keep the system tray/status item available while signed out so the user
    // can reopen the login window or quit the application.
    setupTray({
      onQuit: () => {
        isQuitting = true
        setAppQuitting(true)
        app.quit()
      },
    })

    // macOS can emit `activate` while the saved session is still being
    // restored. The auth callbacks above have already revealed the correct
    // initial window, so dock activation is safe to handle from this point on.
    isReadyForActivation = true
  })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // With a tray icon we keep the app running. Only quit when explicitly requested.
  if (isQuitting) {
    app.quit()
    setWindow(null)
    setAuthWindow(null)
    setAuthCallbackWindow(null)
  }
})

app.on('activate', () => {
  if (!isReadyForActivation) return
  // A hidden window still counts as an open BrowserWindow, so checking for
  // zero windows would leave the dock icon unable to reveal a window after
  // the user clicks its native X. Both helpers reuse an existing hidden
  // renderer and only create a window when none exists.
  if (isAuthCallbackInProgress()) return
  if (isRendererAuthenticated()) {
    revealDashboardWindow(getPendingRecordingNoteId())
  } else {
    showAuthWindow()
  }
})

app.on('will-quit', () => {
  isQuitting = true
  setAppQuitting(true)
  destroyTray()
  flushRecordingDraftPersistence()
})

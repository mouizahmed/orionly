import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { RecordingNoteDraft, RecordingSessionSnapshot, RecordingTranscriptSegment, RecordingUiSnapshot } from '../src/features/recording/recording-types'
import { applyRecordingTranscriptUpdate } from '../src/features/recording/recording-state'
import { canApplyRecordingUiSnapshot, isRecordingSessionSnapshot, isRecordingTranscriptSegment } from '../src/features/recording/recording-snapshot'
import { createWindow, destroyOverlayWindow, getDashboardWindow, getWindow, isDashboardRendererSender, isOverlayRendererSender, revealDashboardWindow, setDashboardHiddenHandler, showAuthWindow } from './window'
import { getCurrentAuthUserId, isRendererAuthenticated } from './auth-handlers'
import { loadRecordingDraft, saveRecordingDraft } from './recording-draft-store'

const EMPTY_RECORDING_UI_SNAPSHOT: RecordingUiSnapshot = { session: null, transcript: [] }
const MAX_RECORDING_NOTE_DRAFT_LENGTH = 5_000_000
let recordingUiSnapshot: RecordingUiSnapshot = EMPTY_RECORDING_UI_SNAPSHOT
let recordingNoteDraft: RecordingNoteDraft | null = null
let recordingDraftAccountId: string | null = null
let recordingNoteDraftVersion = 0
let overlayRendererReadyId: number | null = null
let recordingStartPending = false
let recordingDraftPersistenceTimer: ReturnType<typeof setTimeout> | null = null
const overlayReadyWaiters = new Map<number, Set<() => void>>()
const overlaySurfaceReadyWaiters = new Map<string, Set<() => void>>()
const observedOverlayRenderers = new Set<number>()
const draftFlushWaiters = new Map<string, () => void>()

function publishRecordingUiSnapshot(
  snapshot: RecordingUiSnapshot,
  { notifyDashboard = true }: { notifyDashboard?: boolean } = {},
) {
  const previous = recordingUiSnapshot
  recordingUiSnapshot = snapshot
  const dashboard = getDashboardWindow()
  if (notifyDashboard && dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send('recording:session', snapshot.session)
  }

  if (
    snapshot.session?.phase === 'finalizing'
    && previous.session?.phase !== 'finalizing'
  ) {
    revealDashboardWithDraftFlush(snapshot.session.noteId)
  }

  if (
    snapshot.session?.phase === 'complete'
    && previous.session?.phase !== 'complete'
  ) {
    flushRecordingDraftPersistence()
    setTimeout(() => {
      if (recordingUiSnapshot.session?.sessionId === snapshot.session?.sessionId) {
        destroyOverlayWindow()
      }
    }, 0)
  }
}

function publishRecordingNoteDraft(draft: RecordingNoteDraft | null, excludeSenderId?: number) {
  const previousAccountId = recordingDraftAccountId
  recordingNoteDraft = draft
  if (!draft) {
    recordingDraftAccountId = null
    if (previousAccountId) saveRecordingDraft(previousAccountId, null)
  } else {
    scheduleRecordingDraftPersistence()
  }
  const dashboard = getDashboardWindow()
  if (dashboard && !dashboard.isDestroyed() && dashboard.webContents.id !== excludeSenderId) {
    dashboard.webContents.send('recording:note-draft', draft)
  }
  const overlay = getWindow()
  if (overlay && !overlay.isDestroyed() && overlay.webContents.id !== excludeSenderId) {
    overlay.webContents.send('recording:note-draft', draft)
  }
}

function scheduleRecordingDraftPersistence() {
  if (recordingDraftPersistenceTimer) clearTimeout(recordingDraftPersistenceTimer)
  recordingDraftPersistenceTimer = setTimeout(() => {
    recordingDraftPersistenceTimer = null
    if (recordingNoteDraft && recordingDraftAccountId) {
      saveRecordingDraft(recordingDraftAccountId, recordingNoteDraft)
    }
  }, 250)
}

export function flushRecordingDraftPersistence() {
  if (recordingDraftPersistenceTimer) {
    clearTimeout(recordingDraftPersistenceTimer)
    recordingDraftPersistenceTimer = null
  }
  if (recordingNoteDraft && recordingDraftAccountId) {
    saveRecordingDraft(recordingDraftAccountId, recordingNoteDraft)
  }
}

export function getPendingRecordingNoteId() {
  restoreRecordingDraftForCurrentAccount()
  return recordingNoteDraft?.noteId
}

function restoreRecordingDraftForCurrentAccount() {
  const accountId = getCurrentAuthUserId()
  if (!accountId || recordingDraftAccountId === accountId) return
  flushRecordingDraftPersistence()
  recordingDraftAccountId = accountId
  recordingNoteDraft = loadRecordingDraft(accountId)
  recordingNoteDraftVersion = Math.max(recordingNoteDraftVersion, recordingNoteDraft?.version ?? 0)
}

// Draft-flush handshake: before a window-visibility swap, ask the outgoing
// renderer for its final editor value and wait for the reply. Same-renderer
// IPC is ordered, so the reply doubles as a fence behind any draft updates
// that renderer had already sent. Resolves (never rejects) after a timeout so
// an unresponsive renderer cannot wedge navigation.
function flushRendererNoteDraft(contents: WebContents, timeoutMs = 1_000) {
  if (contents.isDestroyed() || contents.isLoadingMainFrame()) return Promise.resolve()

  return new Promise<void>((resolve) => {
    const flushId = randomUUID()
    const timeout = setTimeout(() => {
      if (draftFlushWaiters.delete(flushId)) {
        console.warn('Recording draft flush timed out before the window swap')
      }
      resolve()
    }, timeoutMs)
    draftFlushWaiters.set(flushId, () => {
      clearTimeout(timeout)
      draftFlushWaiters.delete(flushId)
      resolve()
    })
    try {
      contents.send('recording:request-draft-flush', { flushId })
    } catch {
      // The renderer died between the destroyed-check and the send (e.g. the
      // post-complete overlay teardown). Navigation must still proceed.
      clearTimeout(timeout)
      draftFlushWaiters.delete(flushId)
      resolve()
    }
  })
}

async function flushOutgoingDashboardDraft() {
  const dashboard = getDashboardWindow()
  if (!dashboard || dashboard.isDestroyed()) return
  if (!recordingUiSnapshot.session && !recordingNoteDraft) return
  await flushRendererNoteDraft(dashboard.webContents)
}

async function flushOutgoingOverlayDraft() {
  const overlay = getWindow()
  if (!overlay || overlay.isDestroyed()) return
  if (!recordingUiSnapshot.session && !recordingNoteDraft) return
  await flushRendererNoteDraft(overlay.webContents)
}

// Reveal the dashboard only after the overlay's final draft value has landed.
// Every overlay-hiding path outside a recording IPC handler (tray, protocol
// reveals) must come through here rather than calling revealDashboardWindow.
export function revealDashboardWithDraftFlush(noteId?: string) {
  void flushOutgoingOverlayDraft().then(() => {
    revealDashboardWindow(noteId)
  })
}

function applyNoteDraftUpdate(
  sender: WebContents,
  input: { sessionId?: string; noteId?: string; value?: string } | null | undefined,
) {
  if (recordingDraftAccountId !== getCurrentAuthUserId()) return
  const session = recordingUiSnapshot.session
  const pendingDraftScope = isDashboardRendererSender(sender) && recordingNoteDraft
    ? { sessionId: recordingNoteDraft.sessionId, noteId: recordingNoteDraft.noteId }
    : null
  const scope = session && session.phase !== 'complete'
    ? { sessionId: session.sessionId, noteId: session.noteId }
    : pendingDraftScope
  if (
    !scope
    || input?.sessionId !== scope.sessionId
    || input.noteId !== scope.noteId
    || typeof input.value !== 'string'
    || input.value.length > MAX_RECORDING_NOTE_DRAFT_LENGTH
  ) return

  if (recordingNoteDraft?.value === input.value) return
  publishRecordingNoteDraft(
    {
      sessionId: scope.sessionId,
      noteId: scope.noteId,
      value: input.value,
      version: ++recordingNoteDraftVersion,
    },
    sender.id,
  )
}

function revealOverlayWindow(overlay: BrowserWindow) {
  if (overlay.isMinimized()) overlay.restore()
  overlay.setIgnoreMouseEvents(false)
  overlay.setOpacity(1)
  overlay.show()
  overlay.moveTop()
  overlay.focus()
  return overlay.isVisible()
}

async function hideDashboardAfterOverlayPaint(overlay: BrowserWindow) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    // Wait on the visible renderer, not the hidden surface's layout effect.
    // The next frame can paint before the following frame acknowledges it.
    await Promise.race([
      overlay.webContents.executeJavaScript(`new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })`),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Overlay paint timed out')), 5_000)
      }),
    ])
    if (isRendererAuthenticated() && !overlay.isDestroyed() && overlay.isVisible()) {
      getDashboardWindow()?.hide()
    }
  } catch (error) {
    // Keep the dashboard available if the overlay cannot draw or was closed.
    console.warn('Keeping dashboard visible after overlay reveal:', error)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function resetRecordingUiSnapshot({ clearDraft = true }: { clearDraft?: boolean } = {}) {
  publishRecordingUiSnapshot(EMPTY_RECORDING_UI_SNAPSHOT)
  if (clearDraft) publishRecordingNoteDraft(null)
}

function releaseOverlayReadyWaiters(senderId: number) {
  for (const resolve of overlayReadyWaiters.get(senderId) ?? []) resolve()
  overlayReadyWaiters.delete(senderId)
}

function markOverlayRendererReady(sender: WebContents) {
  const senderId = sender.id
  overlayRendererReadyId = senderId

  if (!observedOverlayRenderers.has(senderId)) {
    observedOverlayRenderers.add(senderId)
    const recoverFromUnavailableRenderer = () => {
      if (overlayRendererReadyId === senderId) overlayRendererReadyId = null
      const interruptedSession = recordingUiSnapshot.session
      if (interruptedSession && interruptedSession.phase !== 'complete') {
        publishRecordingUiSnapshot(EMPTY_RECORDING_UI_SNAPSHOT)
        revealDashboardWindow(interruptedSession.noteId)
      }
    }
    sender.on('did-start-loading', recoverFromUnavailableRenderer)
    sender.on('did-finish-load', () => {
      if (overlayRendererReadyId === senderId) releaseOverlayReadyWaiters(senderId)
    })
    sender.on('render-process-gone', recoverFromUnavailableRenderer)
    sender.once('destroyed', () => {
      recoverFromUnavailableRenderer()
      observedOverlayRenderers.delete(senderId)
      overlayReadyWaiters.delete(senderId)
    })
  }

  if (!sender.isLoadingMainFrame()) releaseOverlayReadyWaiters(senderId)
}

function waitForOverlayRenderer(overlay: BrowserWindow, timeoutMs = 5_000) {
  const senderId = overlay.webContents.id
  if (overlayRendererReadyId === senderId && !overlay.webContents.isLoadingMainFrame()) {
    return Promise.resolve()
  }

  return new Promise<void>((resolve, reject) => {
    const waiters = overlayReadyWaiters.get(senderId) ?? new Set<() => void>()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      waiters.delete(finish)
      if (waiters.size === 0) overlayReadyWaiters.delete(senderId)
      resolve()
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      waiters.delete(finish)
      if (waiters.size === 0) overlayReadyWaiters.delete(senderId)
      reject(new Error('Recording overlay did not become ready'))
    }, timeoutMs)

    waiters.add(finish)
    overlayReadyWaiters.set(senderId, waiters)
  })
}

function waitForOverlaySurface(sessionId: string, timeoutMs = 5_000) {
  return new Promise<void>((resolve, reject) => {
    const waiters = overlaySurfaceReadyWaiters.get(sessionId) ?? new Set<() => void>()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      waiters.delete(finish)
      if (waiters.size === 0) overlaySurfaceReadyWaiters.delete(sessionId)
      resolve()
    }
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      waiters.delete(finish)
      if (waiters.size === 0) overlaySurfaceReadyWaiters.delete(sessionId)
      reject(new Error('Recording overlay surface did not become ready'))
    }, timeoutMs)

    waiters.add(finish)
    overlaySurfaceReadyWaiters.set(sessionId, waiters)
  })
}

function releaseOverlaySurfaceReadyWaiters(sessionId: string) {
  for (const resolve of overlaySurfaceReadyWaiters.get(sessionId) ?? []) resolve()
  overlaySurfaceReadyWaiters.delete(sessionId)
}

export function setupRecordingIpc() {
  setDashboardHiddenHandler(() => {
    const session = recordingUiSnapshot.session
    if (
      !isRendererAuthenticated()
      || !session
      || !['starting', 'recording', 'error'].includes(session.phase)
    ) {
      return
    }

    // Hiding was initiated outside the dashboard renderer (title-bar X), so
    // its last keystrokes may still be in flight; fence them before the
    // overlay becomes the visible editing surface. Hidden renderers stay live.
    void flushOutgoingDashboardDraft().then(() => {
      const currentSession = recordingUiSnapshot.session
      if (
        !isRendererAuthenticated()
        || !currentSession
        || !['starting', 'recording', 'error'].includes(currentSession.phase)
      ) {
        return
      }
      // The dashboard may have been reopened (tray, protocol reveal) while the
      // flush was in flight; revealing the overlay now would cover it.
      const dashboard = getDashboardWindow()
      if (dashboard && !dashboard.isDestroyed() && dashboard.isVisible()) return
      const overlay = getWindow()
      if (
        overlay
        && !overlay.isDestroyed()
        && overlayRendererReadyId === overlay.webContents.id
      ) {
        revealOverlayWindow(overlay)
      }
    })
  })

  ipcMain.on('dashboard:open', (event, payload?: { noteId?: string }) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) {
      showAuthWindow()
      return
    }

    const noteId = typeof payload?.noteId === 'string' ? payload.noteId : undefined
    revealDashboardWithDraftFlush(noteId)
  })

  // Preload buffers commands until React subscribes, so this is the earliest
  // safe point at which main can release a pending start request.
  ipcMain.on('recording:preload-ready', (event) => {
    if (!isOverlayRendererSender(event.sender) || !isRendererAuthenticated()) return
    markOverlayRendererReady(event.sender)
  })

  ipcMain.on('recording:surface-ready', (event, input?: { sessionId?: string }) => {
    if (!isOverlayRendererSender(event.sender) || !isRendererAuthenticated()) return
    const sessionId = input?.sessionId
    if (!sessionId || recordingUiSnapshot.session?.sessionId !== sessionId) return
    releaseOverlaySurfaceReadyWaiters(sessionId)
  })

  ipcMain.handle('recording:start', async (event, input?: { noteId?: string; noteTitle?: string; noteMarkdown?: string }) => {
    if (!isDashboardRendererSender(event.sender) || !isRendererAuthenticated()) {
      throw new Error('Unauthorized IPC sender')
    }
    const noteId = input?.noteId?.trim()
    const noteTitle = input?.noteTitle?.trim()
    const noteMarkdown = typeof input?.noteMarkdown === 'string' ? input.noteMarkdown : ''
    const accountId = getCurrentAuthUserId()
    if (!noteId || !noteTitle) throw new Error('A valid recording note is required')
    if (noteMarkdown.length > MAX_RECORDING_NOTE_DRAFT_LENGTH) throw new Error('The note is too large to record')
    if (!accountId) throw new Error('Authentication is unavailable')
    restoreRecordingDraftForCurrentAccount()
    if (recordingUiSnapshot.session && recordingUiSnapshot.session.phase !== 'complete') {
      throw new Error('Another recording is already active')
    }
    if (recordingStartPending) throw new Error('A recording is already starting')
    if (recordingNoteDraft) throw new Error('The previous recording note is still saving')
    const existingOverlay = getWindow()
    const overlay = existingOverlay && !existingOverlay.isDestroyed()
      ? existingOverlay
      : createWindow({ show: false })

    recordingStartPending = true
    try {
      await waitForOverlayRenderer(overlay)
      if (!isRendererAuthenticated() || overlay.isDestroyed()) {
        throw new Error('Recording overlay became unavailable')
      }
      if (recordingUiSnapshot.session && recordingUiSnapshot.session.phase !== 'complete') {
        throw new Error('Another recording is already active')
      }

      const startedAt = Date.now()
      const startInput = { sessionId: randomUUID(), noteId, noteTitle, startedAt }
      publishRecordingUiSnapshot(
        {
          session: {
            ...startInput,
            phase: 'starting',
            transcriptPhase: 'connecting',
            stoppedAt: null,
            micMuted: false,
            systemAudioMuted: false,
            recoverableError: null,
          },
          transcript: [],
        },
        // This bootstrap state only guards the main-process start transaction.
        // Broadcasting it while the dashboard is visible makes its dock animate
        // immediately before the window is hidden.
        { notifyDashboard: false },
      )
      recordingDraftAccountId = accountId
      publishRecordingNoteDraft({
        sessionId: startInput.sessionId,
        noteId,
        value: noteMarkdown,
        version: ++recordingNoteDraftVersion,
      })

      const surfaceReady = waitForOverlaySurface(startInput.sessionId)
      overlay.webContents.send('recording:start', startInput)
      try {
        await surfaceReady
      } catch (error) {
        resetRecordingUiSnapshot()
        destroyOverlayWindow()
        throw error
      }

      // Keystrokes typed in the dashboard between requesting the start and
      // this point land before the overlay hydrates.
      await flushOutgoingDashboardDraft()
      if (overlay.isDestroyed()) throw new Error('Recording overlay became unavailable')

      if (!revealOverlayWindow(overlay)) {
        resetRecordingUiSnapshot()
        throw new Error('Could not show the recording overlay')
      }
      await hideDashboardAfterOverlayPaint(overlay)
    } finally {
      recordingStartPending = false
    }
  })

  ipcMain.handle('recording:show-overlay', async (event) => {
    if (!isDashboardRendererSender(event.sender) || !isRendererAuthenticated()) {
      throw new Error('Unauthorized IPC sender')
    }
    if (
      !recordingUiSnapshot.session
      || !['starting', 'recording', 'error'].includes(recordingUiSnapshot.session.phase)
    ) {
      throw new Error('There is no active recording')
    }
    const overlay = getWindow()
    if (!overlay || overlay.isDestroyed()) throw new Error('Recording overlay is unavailable')
    await waitForOverlayRenderer(overlay)
    // The dashboard is the outgoing editor; land its final draft value before
    // the overlay becomes the visible editing surface.
    await flushOutgoingDashboardDraft()
    if (overlay.isDestroyed()) throw new Error('Recording overlay is unavailable')
    if (!revealOverlayWindow(overlay)) throw new Error('Could not show the recording overlay')
    await hideDashboardAfterOverlayPaint(overlay)
  })

  ipcMain.handle('recording:stop', async (event) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) {
      throw new Error('Unauthorized IPC sender')
    }
    let session = recordingUiSnapshot.session
    if (!session || session.phase === 'stopping' || session.phase === 'finalizing' || session.phase === 'complete') return
    const overlay = getWindow()
    if (!overlay || overlay.isDestroyed()) throw new Error('Recording overlay is unavailable')
    await waitForOverlayRenderer(overlay)
    session = recordingUiSnapshot.session
    if (!session || session.phase === 'stopping' || session.phase === 'finalizing' || session.phase === 'complete') return
    const stoppedAt = Date.now()
    publishRecordingUiSnapshot({
      ...recordingUiSnapshot,
      session: {
        ...session,
        phase: 'stopping',
        stoppedAt,
      },
    })
    overlay.webContents.send('recording:stop', { stoppedAt })
  })

  ipcMain.handle('recording:get-snapshot', (event) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) {
      throw new Error('Unauthorized IPC sender')
    }
    return recordingUiSnapshot
  })

  ipcMain.handle('recording:get-note-draft', (event) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) {
      throw new Error('Unauthorized IPC sender')
    }
    restoreRecordingDraftForCurrentAccount()
    return recordingNoteDraft
  })

  ipcMain.on('recording:update-note-draft', (event, input?: { sessionId?: string; noteId?: string; value?: string }) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) return
    applyNoteDraftUpdate(event.sender, input)
  })

  ipcMain.on('recording:flush-draft', (event, input?: {
    flushId?: string
    draft?: { sessionId?: string; noteId?: string; value?: string } | null
  }) => {
    if (
      (!isOverlayRendererSender(event.sender) && !isDashboardRendererSender(event.sender))
      || !isRendererAuthenticated()
    ) return
    // Apply the renderer's final value before releasing the waiter so the
    // incoming window hydrates from a draft that already includes it.
    if (input?.draft) applyNoteDraftUpdate(event.sender, input.draft)
    const flushId = input?.flushId
    if (typeof flushId === 'string') draftFlushWaiters.get(flushId)?.()
  })

  ipcMain.on('recording:ack-note-draft', (event, input?: { sessionId?: string; noteId?: string; value?: string }) => {
    if (!isDashboardRendererSender(event.sender) || !isRendererAuthenticated()) return
    if (recordingDraftAccountId !== getCurrentAuthUserId()) return
    if (
      !recordingNoteDraft
      || input?.sessionId !== recordingNoteDraft.sessionId
      || input.noteId !== recordingNoteDraft.noteId
      || input.value !== recordingNoteDraft.value
    ) return
    if (
      !recordingUiSnapshot.session
      || recordingUiSnapshot.session.phase === 'complete'
      || recordingUiSnapshot.session.sessionId !== recordingNoteDraft.sessionId
    ) {
      publishRecordingNoteDraft(null)
      flushRecordingDraftPersistence()
    }
  })

  // A pending draft blocks new recordings until it is acknowledged as saved.
  // When its note no longer exists (deleted locally or on another device),
  // that save can never happen, so the dashboard discards the draft instead —
  // otherwise the encrypted persisted draft would block recording forever.
  ipcMain.on('recording:discard-note-draft', (event, input?: { noteId?: string }) => {
    if (!isDashboardRendererSender(event.sender) || !isRendererAuthenticated()) return
    if (recordingDraftAccountId !== getCurrentAuthUserId()) return
    if (!recordingNoteDraft || input?.noteId !== recordingNoteDraft.noteId) return
    // Never discard the live session's draft out from under an active recording.
    if (
      recordingUiSnapshot.session
      && recordingUiSnapshot.session.phase !== 'complete'
      && recordingUiSnapshot.session.sessionId === recordingNoteDraft.sessionId
    ) return
    publishRecordingNoteDraft(null)
    flushRecordingDraftPersistence()
  })

  ipcMain.on('recording:publish-session', (event, session: RecordingSessionSnapshot) => {
    if (!isOverlayRendererSender(event.sender) || !isRendererAuthenticated()) return
    if (!isRecordingSessionSnapshot(session)) return
    const transcript = recordingUiSnapshot.session?.sessionId === session.sessionId
      ? recordingUiSnapshot.transcript
      : []
    const next = { session, transcript }
    if (!canApplyRecordingUiSnapshot(recordingUiSnapshot, next)) return
    publishRecordingUiSnapshot(next)
  })

  ipcMain.on('recording:publish-transcript-update', (event, segment: RecordingTranscriptSegment) => {
    if (!isOverlayRendererSender(event.sender) || !isRendererAuthenticated()) return
    const session = recordingUiSnapshot.session
    if (
      !session
      || !isRecordingTranscriptSegment(segment)
      || segment.sessionId !== session.sessionId
      || segment.noteId !== session.noteId
    ) return
    const transcript = applyRecordingTranscriptUpdate(recordingUiSnapshot.transcript, segment)
    if (transcript === recordingUiSnapshot.transcript) return
    recordingUiSnapshot = { session, transcript }
    const dashboard = getDashboardWindow()
    if (dashboard && !dashboard.isDestroyed()) {
      dashboard.webContents.send('recording:transcript-update', segment)
    }
  })
}

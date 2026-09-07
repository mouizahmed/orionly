import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { CalendarDays, Check, ChevronDown, Folder, Loader2, Share2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownIconSlot,
  DropdownItem,
  DropdownLabel,
  DropdownPopover,
  DropdownSeparator,
} from '@/components/ui/dropdown-list'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import { ViewSwitch } from '@/components/ui/view-switch'
import { toast } from 'sonner'
import MarkdownEditor from '@/features/notes/MarkdownEditor'
import NoteAssistantDock from '@/features/notes/NoteAssistantDock'
import { useDashboardNotes } from '@/features/notes/DashboardNotesContext'
import NoteAttendeesDropdown from '@/features/notes/NoteAttendeesDropdown'
import { FolderOptionsList } from '@/features/notes/FolderOptionsList'
import ShareNoteDialog from '@/features/notes/dialogs/ShareNoteDialog'
import { useLinkNoteEventMutation, useMoveNoteMutation, useUpdateNoteMutation } from '@/features/notes/queries/useNoteMutations'
import { useCalendarEventSearchQuery } from '@/features/calendar/useCalendarEventSearchQuery'
import { useDebouncedValue } from '@/lib/use-debounced-value'
import { reconcileCanonicalDraft } from '@/features/notes/draft-reconciliation'
import { useDashboardRecording } from '@/features/recording/DashboardRecordingContext'
import { getRecordingOverlayStatus } from '@/features/recording/recording-overlay-presenter'
import { isRecordingCaptureActive } from '@/features/recording/recording-state'


type MeetingOption = {
  id: string
  title: string
  start: string
  color: string
}

type NoteEditorViewProps = {
  userId?: string
}

type NoteView = 'notes' | 'summary'

const NOTE_VIEW_OPTIONS = [
  { value: 'notes', label: 'Notes' },
  { value: 'summary', label: 'Summary' },
] as const

function NoteLoadingSkeleton() {
  return (
    <div className="h-full space-y-3 p-5" aria-hidden="true">
      <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="h-3 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="mt-6 h-3 w-full animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
    </div>
  )
}

export default function NoteEditorView({
  userId,
}: NoteEditorViewProps) {
  const { folders, selectedId, selectedNote, selectedNoteLoading, selectNote } = useDashboardNotes()
  const {
    snapshot,
    noteDraft: recordingNoteDraft,
    resume,
    updateNoteDraft: updateRecordingNoteDraft,
    acknowledgeNoteDraft,
    discardNoteDraft,
  } = useDashboardRecording()
  const { mutateAsync: updateNoteAsync } = useUpdateNoteMutation(userId ?? '')
  const { mutateAsync: moveNoteAsync } = useMoveNoteMutation(userId ?? '')
  const { mutateAsync: linkNoteEventAsync } = useLinkNoteEventMutation(userId ?? '')

  const [draftTitle, setDraftTitle] = useState('')
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const folderPickerRef = useRef<HTMLDivElement | null>(null)
  const [draftFolderId, setDraftFolderId] = useState('')
  const [draftNote, setDraftNote] = useState('')
  const [hydratedNoteId, setHydratedNoteId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<NoteView>('notes')
  const [shareDialogOpen, setShareDialogOpen] = useState(false)

  const [meetingPickerOpen, setMeetingPickerOpen] = useState(false)
  const meetingPickerRef = useRef<HTMLDivElement | null>(null)
  const meetingSearchRef = useRef<HTMLInputElement | null>(null)
  const [meetingSearch, setMeetingSearch] = useState('')
  const [linkingMeeting, setLinkingMeeting] = useState(false)
  const debouncedMeetingSearch = useDebouncedValue(meetingSearch, 300)
  const meetingResultsQuery = useCalendarEventSearchQuery(
    userId,
    selectedId,
    debouncedMeetingSearch,
    meetingPickerOpen,
  )
  const meetingResults = meetingResultsQuery.data ?? []
  const meetingResultsLoading = meetingResultsQuery.isLoading

  const titleSaveTimerRef = useRef<number | null>(null)
  const bodySaveTimerRef = useRef<number | null>(null)
  const canonicalTitleRef = useRef('')
  const canonicalBodyRef = useRef('')
  // Revision the canonical refs were last synchronized at. Query refetches can
  // resolve out of order, so canonical content older than this must not be
  // adopted back into the drafts (it would resurrect just-overwritten text).
  const canonicalRevisionRef = useRef(0)
  const lastLoadedIdRef = useRef<string | null>(null)
  const recordingNoteDraftRef = useRef(recordingNoteDraft)
  recordingNoteDraftRef.current = recordingNoteDraft

  // Hydrate drafts when selected note detail arrives from context
  useEffect(() => {
    if (!selectedNote) {
      lastLoadedIdRef.current = null
      setHydratedNoteId(null)
      setDraftTitle('')
      setDraftFolderId('')
      setDraftNote('')
      return
    }
    if (lastLoadedIdRef.current === selectedNote.id) return
    lastLoadedIdRef.current = selectedNote.id
    setDraftTitle(selectedNote.title)
    setDraftFolderId(selectedNote.folderId ?? '')
    setDraftNote(selectedNote.noteMarkdown)
    canonicalTitleRef.current = selectedNote.title
    canonicalBodyRef.current = selectedNote.noteMarkdown
    canonicalRevisionRef.current = selectedNote.revision
    setMeetingSearch('')
    setHydratedNoteId(selectedNote.id)
  }, [selectedNote])

  useEffect(() => {
    setActiveView('notes')
  }, [selectedId])

  // Folder moves can also originate from the sidebar while this editor stays open.
  useEffect(() => {
    if (!selectedNote || selectedNote.id !== selectedId) return
    setDraftFolderId(selectedNote.folderId ?? '')
  }, [selectedId, selectedNote])

  // Reconcile canonical title changes without overwriting a dirty title draft.
  useEffect(() => {
    if (!selectedNote || selectedNote.id !== selectedId) return
    if (selectedNote.revision < canonicalRevisionRef.current) return
    const nextTitle = reconcileCanonicalDraft(
      canonicalTitleRef.current,
      draftTitle,
      selectedNote.title,
    )
    if (nextTitle === null) return
    canonicalTitleRef.current = nextTitle
    canonicalRevisionRef.current = Math.max(canonicalRevisionRef.current, selectedNote.revision)
    setDraftTitle(nextTitle)
  }, [draftTitle, selectedId, selectedNote])

  // Reconcile canonical body changes (including chat/AI updates) without overwriting a dirty draft.
  useEffect(() => {
    if (!selectedNote || selectedNote.id !== selectedId) return
    if (selectedNote.revision < canonicalRevisionRef.current) return
    const nextBody = reconcileCanonicalDraft(
      canonicalBodyRef.current,
      draftNote,
      selectedNote.noteMarkdown,
    )
    if (nextBody === null) return
    canonicalBodyRef.current = nextBody
    canonicalRevisionRef.current = Math.max(canonicalRevisionRef.current, selectedNote.revision)
    setDraftNote(nextBody)
    updateRecordingNoteDraft(selectedId, nextBody)
  }, [draftNote, selectedId, selectedNote, updateRecordingNoteDraft])

  // The overlay lives in a separate renderer. Apply its latest in-memory draft
  // after this note hydrates; dashboard edits publish through the same channel.
  useEffect(() => {
    if (
      !recordingNoteDraft
      || recordingNoteDraft.noteId !== selectedId
      || hydratedNoteId !== selectedId
      || (snapshot.session && (
        snapshot.session.sessionId !== recordingNoteDraft.sessionId
        || snapshot.session.noteId !== selectedId
      ))
    ) return
    setDraftNote((current) => current === recordingNoteDraft.value ? current : recordingNoteDraft.value)
    if (canonicalBodyRef.current === recordingNoteDraft.value) {
      acknowledgeNoteDraft(recordingNoteDraft)
    }
  }, [acknowledgeNoteDraft, hydratedNoteId, recordingNoteDraft, selectedId, snapshot.session])

  // Close pickers on outside click / escape
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (folderPickerRef.current && !folderPickerRef.current.contains(event.target as Node)) {
        setFolderPickerOpen(false)
      }
      if (meetingPickerRef.current && !meetingPickerRef.current.contains(event.target as Node)) {
        setMeetingPickerOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFolderPickerOpen(false)
        setMeetingPickerOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  const openMeetingPicker = () => {
    setMeetingSearch('')
    setMeetingPickerOpen(true)
    setTimeout(() => meetingSearchRef.current?.focus(), 0)
  }

  const handleMeetingSearchChange = (q: string) => {
    setMeetingSearch(q)
  }

  const selectedCalendarEventId = selectedNote?.calendarEventId ?? selectedNote?.linkedEvent?.id
  const linkedMeetingFromDetail: MeetingOption | null = selectedNote?.linkedEvent
    ? { id: selectedNote.linkedEvent.id, title: selectedNote.linkedEvent.title, start: selectedNote.linkedEvent.start, color: selectedNote.linkedEvent.color }
    : null
  const linkedMeeting = selectedCalendarEventId
    ? (meetingResults.find((m) => m.id === selectedCalendarEventId) ?? linkedMeetingFromDetail ?? null)
    : null
  const displayedMeetingResults =
    linkedMeeting && !meetingSearch.trim() && !meetingResults.some((m) => m.id === linkedMeeting.id)
      ? [linkedMeeting, ...meetingResults]
      : meetingResults

  const handleLinkMeeting = async (meeting: MeetingOption | null) => {
    if (!selectedId || linkingMeeting) return
    setLinkingMeeting(true)
    setMeetingPickerOpen(false)
    try {
      await linkNoteEventAsync({
        noteID: selectedId,
        eventID: meeting?.id ?? null,
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'note not found') {
        selectNote(null)
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to link event')
      }
    } finally {
      setLinkingMeeting(false)
    }
  }

  // Title and body are independent drafts. Relationship changes use dedicated mutations.
  useEffect(() => {
    if (!selectedId) return
    if (lastLoadedIdRef.current !== selectedId) return
    if (draftTitle === canonicalTitleRef.current) return
    if (titleSaveTimerRef.current) window.clearTimeout(titleSaveTimerRef.current)
    const noteID = selectedId
    titleSaveTimerRef.current = window.setTimeout(() => {
      void updateNoteAsync({ noteID, patch: { title: draftTitle } })
        .then((note) => {
          if (!note) return
          canonicalTitleRef.current = note.title
          canonicalRevisionRef.current = Math.max(canonicalRevisionRef.current, note.revision)
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'note not found') selectNote(null)
          else if (error instanceof Error && error.message === 'note has changed') toast.error('This note changed elsewhere. Your title draft was kept.')
        })
    }, 400)
    return () => {
      if (titleSaveTimerRef.current) window.clearTimeout(titleSaveTimerRef.current)
    }
  }, [draftTitle, selectNote, selectedId, updateNoteAsync])

  useEffect(() => {
    if (!selectedId) return
    if (lastLoadedIdRef.current !== selectedId) return
    if (draftNote === canonicalBodyRef.current) return
    if (bodySaveTimerRef.current) window.clearTimeout(bodySaveTimerRef.current)
    const noteID = selectedId
    bodySaveTimerRef.current = window.setTimeout(() => {
      void updateNoteAsync({ noteID, patch: { noteMarkdown: draftNote } })
        .then((note) => {
          if (!note) return
          canonicalBodyRef.current = note.noteMarkdown
          canonicalRevisionRef.current = Math.max(canonicalRevisionRef.current, note.revision)
          const pendingDraft = recordingNoteDraftRef.current
          if (pendingDraft?.noteId === noteID && pendingDraft.value === note.noteMarkdown) {
            acknowledgeNoteDraft(pendingDraft)
          }
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'note not found') {
            // The note is gone, so its pending recording draft can never be
            // saved or acknowledged; discard it or it blocks recording forever.
            if (recordingNoteDraftRef.current?.noteId === noteID) discardNoteDraft(noteID)
            selectNote(null)
          } else if (error instanceof Error && error.message === 'note has changed') {
            toast.error('This note changed elsewhere. Your note draft was kept.')
          }
        })
    }, 400)
    return () => {
      if (bodySaveTimerRef.current) window.clearTimeout(bodySaveTimerRef.current)
    }
  }, [acknowledgeNoteDraft, discardNoteDraft, draftNote, selectNote, selectedId, updateNoteAsync])

  const handleMoveNote = useCallback((folderID: string | null) => {
    if (!selectedId) return
    setDraftFolderId(folderID ?? '')
    setFolderPickerOpen(false)
    void moveNoteAsync({ noteID: selectedId, folderID }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to move note')
    })
  }, [moveNoteAsync, selectedId])

  const handleNoteChange = useCallback((value: string) => {
    setDraftNote(value)
    if (selectedId) updateRecordingNoteDraft(selectedId, value)
  }, [selectedId, updateRecordingNoteDraft])

  if (!selectedId) return null
  const noteIsLoading = selectedNoteLoading || hydratedNoteId !== selectedId
  const activeRecordingSession = snapshot.session?.phase !== 'complete' ? snapshot.session : null
  const recordingSession = activeRecordingSession?.noteId === selectedId ? activeRecordingSession : null
  // Keep the session around while its transcript finishes, but return the dock to
  // its idle layout as soon as audio capture has ended. Otherwise the dashboard
  // briefly renders a disabled stop control and then shifts again on completion.
  const recordingSessionActive = isRecordingCaptureActive(recordingSession)
  const recordingIndicatorActive = recordingSession
    ? getRecordingOverlayStatus(recordingSession).activityActive
    : false
  const canStopRecording = Boolean(recordingSession && (
    recordingSession.phase === 'starting'
    || recordingSession.phase === 'recording'
    || recordingSession.phase === 'error'
  ))
  const canShowRecordingOverlay = canStopRecording
  const noteViewSwitch = (
    <ViewSwitch
      options={NOTE_VIEW_OPTIONS}
      ariaLabel="Note view"
    />
  )

  return (
    <Tabs
      value={activeView}
      onValueChange={(value) => setActiveView(value === 'summary' ? 'summary' : 'notes')}
      className="h-full w-full min-h-0 min-w-0 max-w-full gap-0 [contain:inline-size]"
    >
      <div className="relative flex h-full min-h-0 min-w-0">

      {/* ── Main panel ── */}
      <div className="relative flex min-w-0 flex-1 flex-col rounded-lg border border-neutral-300/70 bg-white/82 shadow-[inset_0_1px_0_rgba(255,255,255,0.68),0_18px_46px_-34px_rgba(15,23,42,0.5)] backdrop-blur-md dark:border-white/10 dark:bg-[#171417]/80 dark:shadow-none">

        {/* Title row */}
        <div className="flex min-w-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-white/10">
          {noteIsLoading ? (
            <div className="flex h-8 w-full items-center gap-2" aria-hidden="true">
              <div className="h-3 w-28 animate-pulse rounded bg-neutral-200/80 dark:bg-white/10" />
              <div className="ml-auto h-8 w-24 animate-pulse rounded-full bg-neutral-200/70 dark:bg-white/8" />
              <div className="h-8 w-32 animate-pulse rounded-full bg-neutral-200/70 dark:bg-white/8" />
              <div className="h-8 w-24 animate-pulse rounded-full bg-neutral-200/70 dark:bg-white/8" />
            </div>
          ) : (
            <>
              <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Untitled note"
            disabled={!selectedId}
            className="h-8 min-w-0 flex-1 truncate bg-transparent text-xs font-medium text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-neutral-50 dark:placeholder:text-neutral-500"
          />
          {noteViewSwitch}
          <div ref={folderPickerRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
            <Button
              type="button"
              variant="secondary"
              disabled={!selectedId}
              onClick={() => setFolderPickerOpen((v) => !v)}
              className="h-8 gap-1.5"
            >
              <Folder className="h-3.5 w-3.5" />
              <span>{draftFolderId ? (folders.find((f) => f.id === draftFolderId)?.name ?? 'Folder') : 'No folder'}</span>
            </Button>
            {folderPickerOpen && (
              <DropdownPopover width="md">
                <DropdownLabel>Add to folder</DropdownLabel>
                <FolderOptionsList
                  folders={folders}
                  selectedFolderId={draftFolderId || null}
                  onSelect={handleMoveNote}
                />
              </DropdownPopover>
            )}
          </div>
          {/* Meeting link picker */}
          <div ref={meetingPickerRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
            <Button
              type="button"
              variant="secondary"
              disabled={!selectedId || linkingMeeting}
              onClick={() => meetingPickerOpen ? setMeetingPickerOpen(false) : openMeetingPicker()}
              className="h-8 gap-1.5"
            >
              {selectedNoteLoading && selectedCalendarEventId && !linkedMeeting ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <CalendarDays className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="max-w-[140px] truncate leading-4">
                {linkingMeeting
                  ? 'Saving…'
                  : selectedNoteLoading && selectedCalendarEventId && !linkedMeeting
                  ? 'Loading…'
                  : !selectedCalendarEventId
                  ? 'Select event'
                  : linkedMeeting
                  ? linkedMeeting.title
                  : meetingResults.length > 0 && !meetingResultsLoading
                  ? 'No longer linked'
                  : 'Linked to event'}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
            </Button>
            {meetingPickerOpen && (
              <DropdownPopover width="md" className="w-52 min-w-52">
                <DropdownLabel>
                  <input
                    ref={meetingSearchRef}
                    value={meetingSearch}
                    onChange={(e) => handleMeetingSearchChange(e.target.value)}
                    placeholder="Search events…"
                    className="w-full bg-transparent outline-none placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                  />
                </DropdownLabel>
                {selectedCalendarEventId && !meetingSearch ? (
                  <>
                    <DropdownSeparator />
                    <DropdownItem
                      onClick={() => void handleLinkMeeting(null)}
                    >
                      <DropdownIconSlot><X className="h-3.5 w-3.5" /></DropdownIconSlot>
                      Remove event link
                    </DropdownItem>
                  </>
                ) : null}
                <DropdownSeparator />
                {meetingResultsLoading ? (
                  <div className="flex items-center gap-2 px-4 py-2 text-xs text-neutral-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Searching…
                  </div>
                ) : displayedMeetingResults.length === 0 ? (
                  <div className="px-3 py-1.5 text-xs text-neutral-400 dark:text-neutral-500">
                    {meetingSearch.trim() ? 'No matching events' : 'No events found'}
                  </div>
                ) : (
                  <div className="max-h-56 overflow-y-auto sidebar-scrollbar">
                    {displayedMeetingResults.map((meeting) => {
                      const isLinked = selectedCalendarEventId === meeting.id
                      const date = new Date(meeting.start)
                      const dateLabel = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      return (
                        <DropdownItem
                          key={meeting.id}
                          onClick={() => void handleLinkMeeting(meeting)}
                          layout="multiline"
                        >
                          <DropdownIconSlot>{isLinked ? <Check className="h-3.5 w-3.5" /> : null}</DropdownIconSlot>
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meeting.color }} />
                          <span className="min-w-0 text-left">
                            <span className="block truncate leading-4">{meeting.title}</span>
                            <span className="block text-[11px] text-neutral-400 dark:text-neutral-500">{dateLabel}</span>
                          </span>
                        </DropdownItem>
                      )
                    })}
                  </div>
                )}
              </DropdownPopover>
            )}
          </div>

          {/* Attendees and note sharing stay at the end of the header actions. */}
          {selectedNote && (
            <NoteAttendeesDropdown note={selectedNote} />
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShareDialogOpen(true)}
            title="Share note"
            aria-label="Share note"
            className="h-8 w-8 rounded-full p-0"
            style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          >
            <Share2 className="h-3.5 w-3.5" />
          </Button>

            </>
          )}
        </div>

        {/* Editor */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {noteIsLoading ? (
            <NoteLoadingSkeleton />
          ) : (
            <>
              <TabsContent value="notes" className="h-full min-h-0">
                <MarkdownEditor
              markdown={draftNote}
              onChange={handleNoteChange}
              placeholder="Markdown notes…"
              theme="auto"
              className="h-full dashboard-editor"
              noteId={selectedId}
              bottomOverlayInset={88}
            />
              </TabsContent>

              <TabsContent value="summary" className="h-full min-h-0">
                <div className="flex h-full min-h-0 items-center justify-center px-6 text-center">
                  <div className="max-w-xs">
                    <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">No summary yet</p>
                    <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                      A summary generated from the transcript will appear here.
                    </p>
                  </div>
                </div>
              </TabsContent>
            </>
          )}
        </div>

        {!noteIsLoading && selectedNote ? (
          <NoteAssistantDock
            accountId={userId}
            noteId={selectedId}
            noteTitle={draftTitle || selectedNote.title}
            isRecording={recordingSessionActive}
            canResumeRecording={!activeRecordingSession && !recordingNoteDraft}
            recordingIndicatorActive={recordingIndicatorActive}
            canStopRecording={canStopRecording}
            canShowRecordingOverlay={canShowRecordingOverlay}
            liveSegments={recordingSession ? snapshot.transcript : undefined}
            transcriptPhase={recordingSession?.transcriptPhase}
            onResumeRecording={async () => {
              try {
                await resume(selectedId, draftTitle || selectedNote.title, draftNote)
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not resume recording')
              }
            }}
          />
        ) : null}

      </div>

      </div>

      {selectedNote ? (
        <ShareNoteDialog
          note={selectedNote}
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
        />
      ) : null}
    </Tabs>
  )
}

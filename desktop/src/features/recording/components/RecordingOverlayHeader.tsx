import type { CSSProperties } from 'react'
import {
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Square,
} from 'lucide-react'

import { RecordingBars } from '@/components/ui/recording-bars'
import { Button } from '@/components/ui/button'
import { ViewSwitch } from '@/components/ui/view-switch'
import {
  formatRecordingElapsedTime,
  getRecordingOverlayStatus,
} from '@/features/recording/recording-overlay-presenter'
import type {
  RecordingSessionSnapshot,
  RecordingUiController,
} from '@/features/recording/recording-types'
import { useRecordingElapsedTime } from '@/features/recording/components/useRecordingElapsedTime'
import { cn } from '@/lib/utils'
import { desktopApi } from '@/lib/desktop-api'

type RecordingOverlayHeaderProps = {
  collapsed: boolean
  controller: RecordingUiController
  session: RecordingSessionSnapshot
  onToggleCollapsed: () => void
}

const toneClassNames = {
  live: 'text-[#7c3aed] dark:text-[#9f73f2]',
  working: 'text-neutral-500 dark:text-neutral-400',
  warning: 'text-amber-600 dark:text-amber-300',
  error: 'text-red-500 dark:text-red-300',
  complete: 'text-neutral-500 dark:text-neutral-400',
} as const

const OVERLAY_VIEW_OPTIONS = [
  { value: 'notepad', label: 'Notepad' },
  { value: 'transcript', label: 'Transcript' },
] as const

export default function RecordingOverlayHeader({
  collapsed,
  controller,
  session,
  onToggleCollapsed,
}: RecordingOverlayHeaderProps) {
  const elapsedMs = useRecordingElapsedTime(session)
  const status = getRecordingOverlayStatus(session)
  const ending = session.phase === 'stopping' || session.phase === 'finalizing' || session.phase === 'complete'

  return (
    <header
      // The 48px collapsed surface includes two 1px borders. Keep its header
      // at that inner height in both states so controls never follow the
      // animated body height during collapse.
      className="grid h-[46px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1.5 px-1.5"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div className="flex h-8 min-w-0 flex-col justify-center px-1">
        <div className="font-mono text-[11px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200">
          {formatRecordingElapsedTime(elapsedMs)}
        </div>
        {collapsed && (status.tone === 'warning' || status.tone === 'error') && (
          <div className={cn('truncate text-[9px] leading-3', toneClassNames[status.tone])}>
            {status.label}
          </div>
        )}
      </div>

      <div
        className="flex h-8 items-stretch overflow-hidden rounded-full border border-neutral-200/80 bg-neutral-100/80 dark:border-white/10 dark:bg-white/5"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <span
          className={cn(
            'flex w-9 items-center justify-center',
            status.tone === 'error'
              ? 'text-red-500 dark:text-red-300'
              : 'text-[#7c3aed] dark:text-[#9f73f2]',
          )}
          title={status.label}
        >
          <RecordingBars isRecording={status.activityActive} className="h-4 w-4 scale-75" />
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-full w-9 rounded-none border-l border-neutral-200/80 bg-transparent text-neutral-600 shadow-none hover:bg-white/25 hover:text-neutral-900 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/3 dark:hover:text-white"
          disabled={ending}
          onClick={() => {
            void desktopApi.recording.stop().catch((error) => {
              console.error('Could not stop recording:', error)
            })
          }}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <Square className="h-2.5 w-2.5 fill-current" />
        </Button>
      </div>

      <div
        className="flex justify-end gap-0.5"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        {!collapsed && (
          <ViewSwitch
            options={OVERLAY_VIEW_OPTIONS}
            ariaLabel="Overlay view"
            className="mr-1"
          />
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-8 w-8 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/8"
          onClick={() => void controller.showDashboard()}
          aria-label="Open dashboard"
          title="Open dashboard"
        >
          <LayoutGrid />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-8 w-8 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-white/8"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? 'Expand recording overlay' : 'Collapse recording overlay'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>
    </header>
  )
}

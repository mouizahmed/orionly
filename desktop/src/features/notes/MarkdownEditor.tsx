import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type CSSProperties,
  type ForwardedRef,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { Camera, Loader2 } from 'lucide-react'
import EditorContextMenu, { type EditorCommand } from '@/features/notes/EditorContextMenu'
import {
  MDXEditor,
  createRootEditorSubscription$,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  realmPlugin,
  linkPlugin,
  linkDialogPlugin,
  markdownShortcutPlugin,
  thematicBreakPlugin,
  tablePlugin,
  imagePlugin,
  type MDXEditorMethods,
  type ToMarkdownOptions,
} from '@mdxeditor/editor'
import { addImportVisitor$, type MdastImportVisitor } from '@mdxeditor/editor'
import { $createLineBreakNode, $createParagraphNode, type ElementNode } from 'lexical'
import type * as Mdast from 'mdast'
import '@mdxeditor/editor/style.css'
import { resolveNoteImagePreview, uploadNoteImage } from '@/features/notes/api/notes-client'

type MarkdownEditorProps = {
  markdown: string
  onChange: (value: string) => void
  placeholder?: string
  theme?: 'dark' | 'auto'
  className?: string
  noteId?: string
  bottomOverlayInset?: number
}

export type MarkdownEditorHandle = {
  focus: () => void
  blur: () => void
  isFocused: () => boolean
}

const preserveEmptyParagraph: NonNullable<NonNullable<ToMarkdownOptions['handlers']>['paragraph']> = (
  node,
  parent,
  state,
  info,
) => {
  const exitParagraph = state.enter('paragraph')
  const exitPhrasing = state.enter('phrasing')
  const value = state.containerPhrasing(node, info)
  exitPhrasing()
  exitParagraph()
  // A trailing empty paragraph is an editor artifact: MDXEditor re-appends one
  // on every import, so persisting it as `<br />` would grow the document by a
  // blank line per load/save cycle — and would turn an empty document into a
  // non-empty one. Only interior blank paragraphs need the `<br />` marker.
  if (!value && (!parent || (parent.type === 'root' && parent.children[parent.children.length - 1] === node))) {
    return ''
  }
  return value || '<br />'
}

const NOTE_MARKDOWN_OPTIONS: ToMarkdownOptions = {
  handlers: { paragraph: preserveEmptyParagraph },
}

function isBrJsxElement(node: { type: string }): node is Mdast.Nodes & { name?: string | null } {
  return (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement')
    && (node as { name?: string | null }).name === 'br'
}

// The `<br />` produced by preserveEmptyParagraph must import back as a real,
// editable empty paragraph. Without this visitor MDXEditor's fallback HTML
// visitor (priority -100) wraps it in a GenericHTMLNode, which renders as a
// phantom blank line the caret cannot type into.
const importEmptyParagraphVisitor: MdastImportVisitor<Mdast.Nodes> = {
  testNode: (node) => isBrJsxElement(node),
  visitNode({ mdastNode, mdastParent, lexicalParent, actions }) {
    if (mdastNode.type === 'mdxJsxFlowElement') {
      // A standalone `<br />` block is a serialized empty paragraph.
      actions.addAndStepInto($createParagraphNode())
      return
    }
    // Inline `<br />` inside a paragraph of nothing but breaks: leave the
    // paragraph genuinely empty. Amid other content: a normal line break.
    const emptyParagraphMarker = mdastParent?.type === 'paragraph'
      && mdastParent.children.every((child) => isBrJsxElement(child))
    if (!emptyParagraphMarker) {
      const parent = lexicalParent as ElementNode
      parent.append($createLineBreakNode())
    }
  },
}

const emptyParagraphImportPlugin = realmPlugin({
  init(realm) {
    realm.pub(addImportVisitor$, importEmptyParagraphVisitor)
  },
})

type BottomOverlayCaretPluginParams = {
  getContainer: () => HTMLDivElement | null
  getInset: () => number
}

function keepCaretAboveBottomOverlay(container: HTMLDivElement | null, bottomInset: number) {
  if (!container || bottomInset <= 0) return

  const selection = document.getSelection()
  if (!selection?.isCollapsed || selection.rangeCount === 0) return

  const editable = container.querySelector<HTMLElement>('.mdx-content-editable')
  const anchorNode = selection.anchorNode
  if (!editable || !anchorNode || !editable.contains(anchorNode)) return

  const scrollContainer = editable.closest<HTMLElement>('.mdxeditor-root-contenteditable')
  if (!scrollContainer) return

  const rangeRect = selection.getRangeAt(0).getBoundingClientRect()
  const anchorElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement
  const caretRect = rangeRect.bottom > 0 ? rangeRect : anchorElement?.getBoundingClientRect()
  if (!caretRect) return

  const safeBottom = scrollContainer.getBoundingClientRect().bottom - bottomInset
  if (caretRect.bottom > safeBottom) {
    scrollContainer.scrollTop += caretRect.bottom - safeBottom + 4
  }
}

const bottomOverlayCaretPlugin = realmPlugin<BottomOverlayCaretPluginParams>({
  init(realm, params) {
    if (!params) return
    realm.pub(createRootEditorSubscription$, (editor) =>
      editor.registerUpdateListener(() => {
        keepCaretAboveBottomOverlay(params.getContainer(), params.getInset())
      }),
    )
  },
})

function useDarkMode(theme: 'dark' | 'auto') {
  const [isDark, setIsDark] = useState(() => {
    if (theme === 'dark') return true
    return document.documentElement.classList.contains('dark')
  })

  useEffect(() => {
    if (theme === 'dark') { setIsDark(true); return }
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [theme])

  return isDark
}

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function getImageFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files).filter((f) => IMAGE_MIME_TYPES.has(f.type))
}

function MarkdownEditorInner(
  {
    markdown,
    onChange,
    placeholder,
    theme = 'auto',
    className,
    noteId,
    bottomOverlayInset = 0,
  }: MarkdownEditorProps,
  ref: ForwardedRef<MarkdownEditorHandle>,
) {
  const editorRef = useRef<MDXEditorMethods>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomOverlayInsetRef = useRef(bottomOverlayInset)
  bottomOverlayInsetRef.current = bottomOverlayInset
  const isDark = useDarkMode(theme)
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // True while this component itself is writing into the editor. Change
  // events emitted during those writes are re-serializations, not user edits;
  // reporting them upward creates save churn and cross-window echo loops.
  const applyingExternalMarkdownRef = useRef(false)
  const pendingLocalMarkdownRef = useRef<string[]>([])
  const syncedNoteIdRef = useRef(noteId)

  const applyMarkdownToEditor = useCallback((value: string) => {
    const editor = editorRef.current
    if (!editor) return
    applyingExternalMarkdownRef.current = true
    editor.setMarkdown(value)
    // Lexical may flush its update listeners a microtask later; a user
    // keystroke always arrives in a later task, so this cannot swallow input.
    queueMicrotask(() => queueMicrotask(() => {
      applyingExternalMarkdownRef.current = false
    }))
  }, [])

  // Older saves serialized an empty document as `<br />`. Treat that stored
  // form as empty so those notes open with a usable, placeholder-showing editor.
  const externalMarkdown = markdown.trim() === '<br />' ? '' : markdown

  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const dragCounterRef = useRef(0)

  // Plugins are stateful — each editor instance needs its own fresh array
  const plugins = useMemo(() => {
    const base = [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      markdownShortcutPlugin(),
      thematicBreakPlugin(),
      tablePlugin(),
      // Resize is disabled so notes never store pixel dimensions: the same
      // markdown renders in the wide dashboard and the narrow overlay, and a
      // width chosen against one container misrenders in the other. Sizing is
      // responsive CSS on .mdx-content-editable img instead.
      imagePlugin({ imagePreviewHandler: resolveNoteImagePreview, disableImageResize: true }),
      emptyParagraphImportPlugin(),
      bottomOverlayCaretPlugin({
        getContainer: () => containerRef.current,
        getInset: () => bottomOverlayInsetRef.current,
      }),
    ]
    return base
  }, [])

  const handleImageFiles = useCallback(async (files: File[]) => {
    const currentNoteId = noteIdRef.current
    if (!currentNoteId || !editorRef.current || files.length === 0) return

    setIsUploading(true)
    try {
      for (const file of files) {
        try {
          const url = await uploadNoteImage(currentNoteId, file)
          const imageMarkdown = `![${file.name}](${url})`
          const current = editorRef.current?.getMarkdown() ?? ''
          const updated = current ? `${current}\n\n${imageMarkdown}` : imageMarkdown
          pendingLocalMarkdownRef.current.push(updated)
          onChangeRef.current(updated)
          applyMarkdownToEditor(updated)
        } catch (e) {
          console.error('Image upload failed:', e)
        }
      }
    } finally {
      setIsUploading(false)
    }
  }, [applyMarkdownToEditor])

  const handleDragEnter = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    const images = getImageFiles(e.dataTransfer)
    if (images.length === 0) return
    void handleImageFiles(images)
  }, [handleImageFiles])

  const handleDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const images = getImageFiles(e.clipboardData)
    if (images.length === 0) return
    e.preventDefault()
    void handleImageFiles(images)
  }, [handleImageFiles])

  const focusEditorEnd = useCallback(() => {
    editorRef.current?.focus(() => {
      const editable = containerRef.current?.querySelector<HTMLElement>('.mdx-content-editable')
      const selection = window.getSelection()
      if (!editable || !selection) return
      const range = document.createRange()
      range.selectNodeContents(editable)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }, {
      defaultSelection: 'rootEnd',
      preventScroll: true,
    })
  }, [])

  const handleEditorCanvasMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) return

    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('button, input, textarea, select, a, [role="dialog"], [role="menu"]')) return

    const editable = containerRef.current?.querySelector<HTMLElement>('.mdx-content-editable')
    if (!editable) return

    const contentBlocks = editable.querySelectorAll<HTMLElement>(
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table, hr, img',
    )
    const lastBlock = contentBlocks.item(contentBlocks.length - 1)
    if (lastBlock && event.clientY < lastBlock.getBoundingClientRect().bottom) return

    event.preventDefault()
    focusEditorEnd()
  }, [focusEditorEnd])

  const handleEditorContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.mdx-content-editable')) return
    if (!window.editorContextMenu?.run) return
    event.preventDefault()
    const selection = window.getSelection()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      hasSelection: Boolean(selection && !selection.isCollapsed && selection.toString()),
    })
  }, [])

  const runEditorCommand = useCallback((command: EditorCommand) => {
    window.editorContextMenu?.run(command)
  }, [])

  // Parent props also echo our own edits. An older echo must not overwrite
  // input Lexical has already accepted while React was catching up.
  useLayoutEffect(() => {
    if (syncedNoteIdRef.current !== noteId) {
      syncedNoteIdRef.current = noteId
      pendingLocalMarkdownRef.current = []
    } else {
      const echoIndex = pendingLocalMarkdownRef.current.lastIndexOf(externalMarkdown)
      if (echoIndex !== -1) {
        pendingLocalMarkdownRef.current.splice(0, echoIndex + 1)
        return
      }
    }
    pendingLocalMarkdownRef.current = []
    const editor = editorRef.current
    if (!editor || editor.getMarkdown() === externalMarkdown) return
    applyMarkdownToEditor(externalMarkdown)
  }, [applyMarkdownToEditor, externalMarkdown, noteId])

  const handleChange = (value: string, initialMarkdownNormalize: boolean) => {
    // MDXEditor identifies its own mount-time normalization. A generic
    // "ignore first change" flag can swallow the user's first real keystroke
    // whenever no normalization event is emitted.
    if (initialMarkdownNormalize || applyingExternalMarkdownRef.current) return
    pendingLocalMarkdownRef.current.push(value)
    onChange(value)
  }

  useImperativeHandle(ref, () => ({
    focus: focusEditorEnd,
    blur: () => {
      const activeElement = document.activeElement
      if (activeElement instanceof HTMLElement && containerRef.current?.contains(activeElement)) {
        activeElement.blur()
      }
    },
    isFocused: () => {
      const activeElement = document.activeElement
      return Boolean(activeElement && containerRef.current?.contains(activeElement))
    },
  }), [focusEditorEnd])

  return (
    <div
      ref={containerRef}
      onDragEnter={noteId ? handleDragEnter : undefined}
      onDragLeave={noteId ? handleDragLeave : undefined}
      onDrop={noteId ? handleDrop : undefined}
      onDragOver={noteId ? handleDragOver : undefined}
      onPaste={noteId ? handlePaste : undefined}
      onMouseDownCapture={handleEditorCanvasMouseDown}
      onContextMenu={handleEditorContextMenu}
      className="relative h-full min-w-0 max-w-full overflow-hidden"
      style={{ '--editor-bottom-overlay-inset': `${bottomOverlayInset}px` } as CSSProperties}
    >
      <MDXEditor
        ref={editorRef}
        markdown={externalMarkdown}
        onChange={handleChange}
        toMarkdownOptions={NOTE_MARKDOWN_OPTIONS}
        placeholder={placeholder}
        plugins={plugins}
        contentEditableClassName="mdx-content-editable"
        className={`mdx-editor-root ${isDark ? 'dark-theme dark-editor' : ''} ${className ?? ''}`}
      />

      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-900/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <div className="absolute -left-3 -top-1 h-16 w-20 rotate-[-8deg] rounded-lg border border-neutral-600 bg-neutral-800" />
              <div className="absolute -right-3 -top-1 h-16 w-20 rotate-[8deg] rounded-lg border border-neutral-600 bg-neutral-800" />
              <div className="relative z-10 flex h-16 w-20 items-center justify-center rounded-lg border border-neutral-500 bg-neutral-700">
                <Camera className="h-6 w-6 text-teal-400" />
              </div>
            </div>
            <div className="mt-2 text-center">
              <p className="text-sm font-semibold text-white">Attach images</p>
              <p className="text-xs text-neutral-400">Add visual context to your notes</p>
            </div>
          </div>
        </div>
      )}

      {isUploading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-900/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-teal-400" />
            <p className="text-sm font-medium text-white">Uploading image...</p>
          </div>
        </div>
      )}

      {contextMenu ? (
        <EditorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hasSelection={contextMenu.hasSelection}
          onCommand={runEditorCommand}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

    </div>
  )
}

const MarkdownEditor = memo(forwardRef(MarkdownEditorInner))
export default MarkdownEditor

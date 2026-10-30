import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  ChevronDownIcon,
  ClipboardCheckIcon,
  CopyIcon,
  HistoryIcon,
  Loader2Icon,
  MicIcon,
  SendHorizontalIcon,
  SparklesIcon,
  SquareIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react"
import { cn } from "cn"

import { api, type AppConfig, type Thread } from "@/lib/api"
import {
  pending,
  storage,
  type PendingRecording,
  type Settings,
  type ThreadChoice,
} from "@/lib/storage"
import { formatDuration, useRecorder, type Recording } from "@/lib/use-recorder"
import { HistorySheet } from "@/components/history-sheet"
import { ThreadPicker } from "@/components/thread-picker"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Toaster } from "@/components/ui/sonner"

type Busy = null | "transcribing" | "cleaning" | "sending"

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

export function App() {
  const [text, setText] = useState(storage.draft)
  const [settings, setSettingsState] = useState<Settings>(storage.settings)
  const [thread, setThreadState] = useState<ThreadChoice | null>(storage.thread)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [failed, setFailed] = useState<{
    recording: PendingRecording
    message: string
  } | null>(null)
  // The latest transcription, while it is still in the text unchanged, so the
  // clean-up can be undone.
  const [lastSegment, setLastSegment] = useState<{
    raw: string
    cleaned: string
  } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Reused if a send is retried, so T3 never gets the same message twice.
  const sendIds = useRef<{
    text: string
    threadId: string
    commandId: string
    messageId: string
  } | null>(null)

  useEffect(() => storage.setDraft(text), [text])

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => {})
    // A recording that never got transcribed (the page closed, the network dropped).
    pending.load().then((rec) => {
      if (rec)
        setFailed({
          recording: rec,
          message: "A recording from earlier wasn't transcribed.",
        })
    })
  }, [])

  const setSettings = (next: Settings) => {
    setSettingsState(next)
    storage.setSettings(next)
  }

  const setThread = (t: Thread) => {
    const choice = {
      id: t.id,
      title: t.title,
      projectTitle: t.projectTitle,
      url: t.url,
    }
    setThreadState(choice)
    storage.setThread(choice)
    setPickerOpen(false)
  }

  const insert = useCallback((addition: string) => {
    setText((current) => {
      const base = current.replace(/\s+$/, "")
      return base ? `${base}\n\n${addition}` : addition
    })
  }, [])

  const transcribe = useCallback(
    async (recording: PendingRecording) => {
      setBusy("transcribing")
      setFailed(null)
      try {
        const result = await api.transcribe(recording.blob, settings.cleanup)
        await pending.clear()
        const finalText = result.cleaned ?? result.raw
        if (!finalText) {
          toast("No speech heard in that recording.")
          return
        }
        insert(finalText)
        setLastSegment(
          result.cleaned && result.cleaned !== result.raw
            ? { raw: result.raw, cleaned: result.cleaned }
            : null
        )
      } catch (err) {
        setFailed({ recording, message: (err as Error).message })
      } finally {
        setBusy(null)
      }
    },
    [insert, settings.cleanup]
  )

  const onRecorded = useCallback(
    async ({ blob, durationMs }: Recording) => {
      if (durationMs < 600) {
        toast("That was too short to transcribe.")
        return
      }
      const rec = {
        blob,
        type: blob.type,
        at: new Date().toISOString(),
        durationMs,
      }
      await pending.save(rec)
      await transcribe(rec)
    },
    [transcribe]
  )

  const recorder = useRecorder({
    maxBytes: config?.maxAudioBytes ?? DEFAULT_MAX_BYTES,
    onStop: onRecorded,
    onError: (message) => toast.error(message),
  })
  const recording = recorder.state !== "idle"

  const toggleRecording = () => {
    if (recorder.state === "recording") recorder.stop()
    else if (recorder.state === "idle" && !busy) {
      textarea.current?.blur()
      recorder.start()
    }
  }

  const useOriginal = () => {
    if (!lastSegment) return
    setText((current) => {
      const i = current.lastIndexOf(lastSegment.cleaned)
      return i === -1
        ? current
        : current.slice(0, i) +
            lastSegment.raw +
            current.slice(i + lastSegment.cleaned.length)
    })
    setLastSegment(null)
  }
  const segmentStillThere =
    lastSegment !== null && text.includes(lastSegment.cleaned)

  const cleanUpAll = async () => {
    if (!text.trim() || busy) return
    setBusy("cleaning")
    try {
      const before = text
      const { text: cleaned } = await api.clean(before)
      setText(cleaned)
      setLastSegment(null)
      toast("Cleaned up", {
        action: { label: "Undo", onClick: () => setText(before) },
      })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const clear = () => {
    if (!text) return
    const before = text
    setText("")
    setLastSegment(null)
    toast("Cleared", {
      action: { label: "Undo", onClick: () => setText(before) },
    })
  }

  const copy = async () => {
    const value = text.trim()
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Older Safari: copy from a selection instead.
      const el = textarea.current
      if (!el) return
      el.select()
      document.execCommand("copy")
      el.setSelectionRange(el.value.length, el.value.length)
    }
    storage.addHistory({ text: value, action: "copied" })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    toast.success("Copied")
  }

  const send = async () => {
    const value = text.trim()
    if (!value || busy || recording) return
    if (!thread) {
      setPickerOpen(true)
      return
    }
    if (
      sendIds.current?.text !== value ||
      sendIds.current.threadId !== thread.id
    ) {
      sendIds.current = {
        text: value,
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
      }
    }
    setBusy("sending")
    try {
      const { commandId, messageId } = sendIds.current
      await api.send({
        threadId: thread.id,
        text: value,
        mode: settings.sendMode,
        commandId,
        messageId,
      })
      sendIds.current = null
      storage.addHistory({
        text: value,
        action: "sent",
        thread: { id: thread.id, title: thread.title },
      })
      setText("")
      setLastSegment(null)
      toast.success(`Sent to ${thread.title}`, {
        action: thread.url
          ? { label: "Open", onClick: () => window.open(thread.url, "_blank") }
          : undefined,
      })
    } catch (err) {
      toast.error((err as Error).message, {
        action: { label: "Retry", onClick: () => send() },
      })
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault()
        send()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const hasText = text.trim() !== ""

  return (
    <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex items-center justify-between gap-2 px-4 pt-2 pb-1">
        <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" className="size-6 rounded-[7px]" />
          Voice memo
        </h1>
        <div className="flex items-center gap-1">
          <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted-foreground select-none">
            <SparklesIcon className="size-4" />
            Clean up
            <Switch
              checked={settings.cleanup}
              onCheckedChange={(cleanup) =>
                setSettings({ ...settings, cleanup })
              }
            />
          </label>
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-9"
            onClick={() => setHistoryOpen(true)}
            aria-label="Recent messages"
          >
            <HistoryIcon />
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-3">
        {failed && (
          <div className="mx-1 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              {failed.message}{" "}
              <span className="text-muted-foreground">
                ({formatDuration(failed.recording.durationMs)} saved on this
                device)
              </span>
            </span>
            <Button
              size="lg"
              className="h-8 px-3 text-sm"
              onClick={() => transcribe(failed.recording)}
              disabled={busy !== null}
            >
              Transcribe
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="h-8 px-2 text-sm"
              onClick={() => {
                pending.clear()
                setFailed(null)
              }}
            >
              Discard
            </Button>
          </div>
        )}

        <div className="relative flex min-h-0 flex-1 flex-col rounded-xl border bg-card shadow-xs">
          <textarea
            ref={textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            readOnly={busy === "cleaning"}
            placeholder={
              "Tap the mic and talk.\n\nYour words land here, ready to read over, fix, then copy or send."
            }
            aria-label="Message"
            className="min-h-0 w-full flex-1 resize-none rounded-xl bg-transparent px-4 py-3 text-[17px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
            spellCheck
            autoCapitalize="sentences"
          />
          {(busy === "transcribing" || busy === "cleaning") && (
            <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center">
              <span className="flex items-center gap-2 rounded-full border bg-popover px-3 py-1.5 text-sm shadow-sm">
                <Loader2Icon className="size-4 animate-spin" />
                {busy === "transcribing"
                  ? settings.cleanup
                    ? "Transcribing and cleaning up…"
                    : "Transcribing…"
                  : "Cleaning up…"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-1 border-t px-2 py-1.5">
            <span className="px-2 text-xs text-muted-foreground tabular-nums">
              {words} {words === 1 ? "word" : "words"}
            </span>
            <div className="ml-auto flex items-center gap-1">
              {segmentStillThere && (
                <Button
                  variant="ghost"
                  size="lg"
                  className="h-8 px-2 text-sm"
                  onClick={useOriginal}
                >
                  <Undo2Icon /> Original
                </Button>
              )}
              <Button
                variant="ghost"
                size="lg"
                className="h-8 px-2 text-sm"
                onClick={cleanUpAll}
                disabled={!hasText || busy !== null}
              >
                <SparklesIcon /> Clean up
              </Button>
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-8"
                onClick={clear}
                disabled={!text || busy !== null}
                aria-label="Clear"
              >
                <Trash2Icon />
              </Button>
            </div>
          </div>
        </div>
      </main>

      <footer className="px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex h-10 items-center justify-center px-1">
          {recording ? (
            <div className="flex w-full items-center gap-3">
              <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
              <span className="text-sm font-medium tabular-nums">
                {formatDuration(recorder.elapsedMs)}
              </span>
              <LevelMeter level={recorder.level} />
              <Button
                variant="ghost"
                size="lg"
                className="h-9 px-3 text-sm"
                onClick={recorder.cancel}
              >
                <XIcon /> Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex h-10 max-w-full min-w-0 items-center gap-1.5 rounded-full px-3 text-sm hover:bg-muted active:bg-muted"
            >
              <span className="shrink-0 text-muted-foreground">To</span>
              {thread ? (
                <>
                  <span className="truncate font-medium">{thread.title}</span>
                  <span className="hidden shrink truncate text-muted-foreground min-[380px]:inline">
                    · {thread.projectTitle}
                  </span>
                </>
              ) : (
                <span className="font-medium">pick a thread</span>
              )}
              <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          )}
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <Button
            variant="outline"
            className="h-12 rounded-xl text-[15px]"
            onClick={copy}
            disabled={!hasText || recording}
          >
            {copied ? (
              <ClipboardCheckIcon className="size-5" />
            ) : (
              <CopyIcon className="size-5" />
            )}
            Copy
          </Button>

          <button
            type="button"
            onClick={toggleRecording}
            disabled={
              recorder.state === "starting" || (busy !== null && !recording)
            }
            aria-label={recording ? "Stop recording" : "Start recording"}
            className={cn(
              "relative flex size-[72px] items-center justify-center rounded-full text-white shadow-lg transition-transform outline-none active:scale-95 disabled:opacity-60",
              "focus-visible:ring-4 focus-visible:ring-ring/40",
              recording
                ? "bg-red-500"
                : "bg-gradient-to-b from-[#ff6a3d] to-[#e5372a]"
            )}
          >
            {recording && (
              <span
                className="absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-75"
                style={{ transform: `scale(${1 + recorder.level * 0.45})` }}
              />
            )}
            {busy === "transcribing" ? (
              <Loader2Icon className="relative size-8 animate-spin" />
            ) : recording ? (
              <SquareIcon className="relative size-7 fill-current" />
            ) : (
              <MicIcon className="relative size-8" />
            )}
          </button>

          <Button
            className="h-12 rounded-xl text-[15px]"
            onClick={send}
            disabled={!hasText || recording || busy !== null}
          >
            {busy === "sending" ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : (
              <SendHorizontalIcon className="size-5" />
            )}
            Send
          </Button>
        </div>
      </footer>

      <ThreadPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selected={thread}
        onSelect={setThread}
        sendMode={settings.sendMode}
        onSendModeChange={(sendMode) => setSettings({ ...settings, sendMode })}
      />
      <HistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestore={(value) => {
          insert(value)
          setHistoryOpen(false)
        }}
      />
      <Toaster
        position="top-center"
        offset={{ top: "calc(env(safe-area-inset-top) + 8px)" }}
      />
    </div>
  )
}

function LevelMeter({ level }: { level: number }) {
  // A row of bars that rise with the voice, so it's obvious the mic hears you.
  const bars = 24
  return (
    <div className="flex h-6 flex-1 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, i) => {
        const shape = 0.35 + 0.65 * Math.sin((i / (bars - 1)) * Math.PI)
        const h = Math.max(0.12, Math.min(1, level * shape * 1.6))
        return (
          <span
            key={i}
            className="flex-1 rounded-full bg-red-500/80 transition-[height] duration-75"
            style={{ height: `${h * 100}%` }}
          />
        )
      })}
    </div>
  )
}

export default App

import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckIcon, RefreshCwIcon, SearchIcon } from "lucide-react"
import { cn } from "cn"

import { api, type Thread } from "@/lib/api"
import type { SendMode, ThreadChoice } from "@/lib/storage"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: ThreadChoice | null
  onSelect: (thread: Thread) => void
  sendMode: SendMode
  onSendModeChange: (mode: SendMode) => void
}

export function ThreadPicker({ open, onOpenChange, ...rest }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[88svh] rounded-t-xl pb-[env(safe-area-inset-bottom)]"
        showCloseButton={false}
      >
        {/* Mounted on each open, so the list is fresh and the search is empty. */}
        <PickerBody onClose={() => onOpenChange(false)} {...rest} />
      </SheetContent>
    </Sheet>
  )
}

function PickerBody({
  onClose,
  selected,
  onSelect,
  sendMode,
  onSendModeChange,
}: Omit<Props, "open" | "onOpenChange"> & { onClose: () => void }) {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState("")
  const [showSettled, setShowSettled] = useState(false)

  const fetchThreads = useCallback(
    () =>
      api
        .threads()
        .then((r) => {
          setThreads(r.threads)
          setError(null)
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false)),
    []
  )
  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])
  const refresh = () => {
    setLoading(true)
    fetchThreads()
  }

  const { active, settled } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (t: Thread) =>
      !q ||
      t.title.toLowerCase().includes(q) ||
      t.projectTitle.toLowerCase().includes(q)
    const list = (threads ?? []).filter(match)
    return {
      active: list.filter((t) => !t.settled),
      settled: list.filter((t) => t.settled),
    }
  }, [threads, query])

  const searching = query.trim() !== ""

  return (
    <>
      <SheetHeader className="gap-3 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between gap-2">
          <SheetTitle className="text-base">Send to thread</SheetTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-lg"
              onClick={refresh}
              disabled={loading}
              aria-label="Refresh threads"
            >
              <RefreshCwIcon className={cn(loading && "animate-spin")} />
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="h-9 px-3 text-sm"
              onClick={onClose}
            >
              Done
            </Button>
          </div>
        </div>
        <SheetDescription className="sr-only">
          Pick the T3 Code thread that messages go to.
        </SheetDescription>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads and projects"
            aria-label="Search threads"
            className="h-10 pl-9 text-base md:text-sm"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-2 py-2">
        {error && (
          <p className="px-2 py-6 text-center text-sm text-destructive">
            {error}
          </p>
        )}
        {!error && threads === null && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            Loading threads…
          </p>
        )}
        {threads !== null && active.length === 0 && settled.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No threads match.
          </p>
        )}
        <ThreadList
          threads={active}
          selectedId={selected?.id}
          onSelect={onSelect}
        />
        {settled.length > 0 && (
          <>
            {searching || showSettled ? (
              <>
                <div className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">
                  Settled
                </div>
                <ThreadList
                  threads={settled}
                  selectedId={selected?.id}
                  onSelect={onSelect}
                />
              </>
            ) : (
              <Button
                variant="ghost"
                className="mt-1 h-10 w-full text-sm text-muted-foreground"
                onClick={() => setShowSettled(true)}
              >
                Show {settled.length} settled
              </Button>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">If the agent is busy</div>
          <div className="text-xs text-muted-foreground">
            {sendMode === "auto"
              ? "Steer the running turn, like T3's composer"
              : "Wait until the running turn ends"}
          </div>
        </div>
        <ToggleGroup
          variant="outline"
          spacing={0}
          value={[sendMode]}
          onValueChange={(value) =>
            value[0] && onSendModeChange(value[0] as SendMode)
          }
          aria-label="When the agent is busy"
        >
          <ToggleGroupItem value="auto" className="h-9 px-3 text-sm">
            Steer
          </ToggleGroupItem>
          <ToggleGroupItem value="queue" className="h-9 px-3 text-sm">
            Queue
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </>
  )
}

function ThreadList({
  threads,
  selectedId,
  onSelect,
}: {
  threads: Thread[]
  selectedId?: string
  onSelect: (t: Thread) => void
}) {
  return (
    <ul className="flex flex-col">
      {threads.map((t) => {
        const selected = t.id === selectedId
        return (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onSelect(t)}
              aria-pressed={selected}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted active:bg-muted",
                selected && "bg-muted"
              )}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  t.busy
                    ? "animate-pulse bg-emerald-500"
                    : t.status === "failed"
                      ? "bg-destructive"
                      : "bg-border"
                )}
                aria-label={t.busy ? "Agent is working" : undefined}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">
                  {t.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t.projectTitle} ·{" "}
                  <span className="tabular-nums">
                    {relativeTime(t.lastMessageAt)}
                  </span>
                  {t.busy && " · working"}
                </span>
              </span>
              {selected && (
                <CheckIcon className="size-4 shrink-0 text-foreground" />
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function relativeTime(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

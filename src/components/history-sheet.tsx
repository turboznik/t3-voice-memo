import { useState } from "react"
import { toast } from "sonner"
import { CopyIcon, CornerDownLeftIcon } from "lucide-react"

import { storage, type HistoryEntry } from "@/lib/storage"
import { relativeTime } from "@/components/thread-picker"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

// The last 30 messages copied or sent, kept on this device only, so nothing
// is lost if a paste goes wrong.
export function HistorySheet({
  open,
  onOpenChange,
  onRestore,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestore: (text: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[88svh] rounded-t-xl pb-[env(safe-area-inset-bottom)]"
        showCloseButton={false}
      >
        <HistoryBody
          onClose={() => onOpenChange(false)}
          onRestore={onRestore}
        />
      </SheetContent>
    </Sheet>
  )
}

// Mounted on each open, so it reads the latest history.
function HistoryBody({
  onClose,
  onRestore,
}: {
  onClose: () => void
  onRestore: (text: string) => void
}) {
  const [entries, setEntries] = useState<HistoryEntry[]>(storage.history)

  return (
    <>
      <SheetHeader className="flex-row items-center justify-between gap-2 px-4 pt-4 pb-3">
        <div>
          <SheetTitle className="text-base">Recent</SheetTitle>
          <SheetDescription>Kept on this device only.</SheetDescription>
        </div>
        <div className="flex items-center gap-1">
          {entries.length > 0 && (
            <Button
              variant="ghost"
              size="lg"
              className="h-9 px-3 text-sm text-muted-foreground"
              onClick={() => {
                storage.clearHistory()
                setEntries([])
              }}
            >
              Clear all
            </Button>
          )}
          <Button
            variant="secondary"
            size="lg"
            className="h-9 px-3 text-sm"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
        {entries.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing yet. Messages you copy or send show up here.
          </p>
        )}
        <ul className="divide-y">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {e.action === "sent"
                    ? `Sent to ${e.thread?.title ?? "a thread"}`
                    : "Copied"}
                </span>
                <span>·</span>
                <span className="tabular-nums">{relativeTime(e.at)}</span>
              </div>
              <p className="line-clamp-4 text-sm whitespace-pre-wrap">
                {e.text}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  size="lg"
                  className="h-8 px-3 text-sm"
                  onClick={async () => {
                    await navigator.clipboard.writeText(e.text).catch(() => {})
                    toast.success("Copied")
                  }}
                >
                  <CopyIcon /> Copy
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="h-8 px-3 text-sm"
                  onClick={() => onRestore(e.text)}
                >
                  <CornerDownLeftIcon /> Put back in editor
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

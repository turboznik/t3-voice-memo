// What the page remembers between visits. Small things live in localStorage;
// the last recording lives in IndexedDB until it has been transcribed, so a
// dropped connection never loses a long memo.

export type ThreadChoice = {
  id: string
  title: string
  projectTitle: string
  url?: string
}
export type SendMode = "auto" | "queue"
export type Settings = { cleanup: boolean; sendMode: SendMode }
export type HistoryEntry = {
  id: string
  text: string
  at: string
  action: "sent" | "copied"
  thread?: { id: string; title: string }
}

const KEYS = {
  thread: "voice-memo.thread",
  settings: "voice-memo.settings",
  draft: "voice-memo.draft",
  history: "voice-memo.history",
}

const HISTORY_LIMIT = 30

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked: losing a preference is not worth an error.
  }
}

export const storage = {
  thread(): ThreadChoice | null {
    const value = read<Partial<ThreadChoice>>(KEYS.thread, {})
    return value.id ? (value as ThreadChoice) : null
  },
  setThread(choice: ThreadChoice | null) {
    if (choice) write(KEYS.thread, choice)
    else localStorage.removeItem(KEYS.thread)
  },
  settings(): Settings {
    return read<Settings>(KEYS.settings, { cleanup: true, sendMode: "auto" })
  },
  setSettings(settings: Settings) {
    write(KEYS.settings, settings)
  },
  draft(): string {
    return localStorage.getItem(KEYS.draft) ?? ""
  },
  setDraft(text: string) {
    if (text) localStorage.setItem(KEYS.draft, text)
    else localStorage.removeItem(KEYS.draft)
  },
  history(): HistoryEntry[] {
    try {
      const value = JSON.parse(localStorage.getItem(KEYS.history) ?? "[]")
      return Array.isArray(value) ? value : []
    } catch {
      return []
    }
  },
  addHistory(entry: Omit<HistoryEntry, "id" | "at">): HistoryEntry[] {
    const list = storage.history()
    // Copying the same text twice is one entry.
    const rest = list.filter(
      (e) =>
        !(
          e.text === entry.text &&
          e.action === entry.action &&
          e.thread?.id === entry.thread?.id
        )
    )
    const next = [
      { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() },
      ...rest,
    ].slice(0, HISTORY_LIMIT)
    write(KEYS.history, next)
    return next
  },
  clearHistory() {
    localStorage.removeItem(KEYS.history)
  },
}

// --- the pending recording (IndexedDB) ---

export type PendingRecording = {
  blob: Blob
  type: string
  at: string
  durationMs: number
}

const DB = "voice-memo"
const STORE = "pending"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export const pending = {
  async save(recording: PendingRecording) {
    try {
      await tx("readwrite", (s) => s.put(recording, "last"))
    } catch {
      // Private mode or no IndexedDB: the upload still goes ahead.
    }
  },
  async load(): Promise<PendingRecording | null> {
    try {
      return (
        (await tx<PendingRecording | undefined>("readonly", (s) =>
          s.get("last")
        )) ?? null
      )
    } catch {
      return null
    }
  },
  async clear() {
    try {
      await tx("readwrite", (s) => s.delete("last"))
    } catch {
      // nothing to clear
    }
  },
}

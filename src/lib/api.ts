export type Thread = {
  id: string
  title: string
  projectId: string
  projectTitle: string
  status: string
  busy: boolean
  settled: boolean
  lastMessageAt: string
  url: string
}

export type AppConfig = {
  login: string
  transcribeModel: string
  cleanupModel: string
  maxAudioBytes: number
  t3Url: string
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    throw new Error("Can't reach the server. Check that Tailscale is connected.")
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`)
  return body as T
}

const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
})

export const api = {
  config: () => call<AppConfig>("/api/config"),
  threads: () => call<{ threads: Thread[] }>("/api/threads"),
  transcribe: (audio: Blob, clean: boolean) =>
    call<{ raw: string; cleaned: string | null }>(
      `/api/transcribe${clean ? "?clean=1" : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": audio.type || "application/octet-stream" },
        body: audio,
      }
    ),
  clean: (text: string) => call<{ text: string }>("/api/clean", json({ text })),
  send: (input: {
    threadId: string
    text: string
    mode: "auto" | "queue"
    commandId: string
    messageId: string
  }) => call<{ ok: true }>("/api/send", json(input)),
}

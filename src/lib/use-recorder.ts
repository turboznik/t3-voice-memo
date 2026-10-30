import { useCallback, useEffect, useRef, useState } from "react"

// Opus in WebM where the browser has it (Chrome, Firefox, Android); Safari and
// iOS record AAC in MP4. Both go straight to the transcription API.
const TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
]

export type Recording = { blob: Blob; durationMs: number }
export type RecorderState = "idle" | "starting" | "recording"

type Options = {
  // Stop on our own before the upload limit (the API takes 25 MB).
  maxBytes: number
  onStop: (recording: Recording) => void
  onError: (message: string) => void
}

export function useRecorder({ maxBytes, onStop, onError }: Options) {
  const [state, setState] = useState<RecorderState>("idle")
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const live = useRef<{
    recorder: MediaRecorder
    stream: MediaStream
    audio: AudioContext | null
    chunks: Blob[]
    bytes: number
    startedAt: number
    cancelled: boolean
    timer: number
    frame: number
    wakeLock: WakeLockSentinel | null
  } | null>(null)
  const callbacks = useRef({ onStop, onError })
  useEffect(() => {
    callbacks.current = { onStop, onError }
  })

  const teardown = useCallback(() => {
    const r = live.current
    if (!r) return
    clearInterval(r.timer)
    cancelAnimationFrame(r.frame)
    r.stream.getTracks().forEach((t) => t.stop())
    r.audio?.close().catch(() => {})
    r.wakeLock?.release().catch(() => {})
    live.current = null
    setLevel(0)
  }, [])

  const start = useCallback(async () => {
    if (live.current) return
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      callbacks.current.onError(
        "This browser can't record audio here. Open the page over https."
      )
      return
    }
    setState("starting")
    let stream: MediaStream
    try {
      // The browser's own noise suppression and gain control clean up the
      // audio before it is uploaded.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      setState("idle")
      const name = (err as DOMException)?.name
      callbacks.current.onError(
        name === "NotAllowedError"
          ? "Microphone access is blocked. Allow it for this site in Settings, then try again."
          : "Couldn't open the microphone."
      )
      return
    }

    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64_000,
    })

    // Only for the level meter; recording works without it.
    let audio: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    try {
      const ctx = new AudioContext()
      analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      audio = ctx
    } catch {
      analyser = null
    }

    const r = {
      recorder,
      stream,
      audio,
      chunks: [] as Blob[],
      bytes: 0,
      startedAt: performance.now(),
      cancelled: false,
      timer: 0,
      frame: 0,
      wakeLock: null as WakeLockSentinel | null,
    }
    live.current = r

    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return
      r.chunks.push(e.data)
      r.bytes += e.data.size
      if (r.bytes > maxBytes * 0.95 && recorder.state === "recording") {
        callbacks.current.onError(
          "That's as long as one recording can be. It stopped on its own."
        )
        recorder.stop()
      }
    }
    recorder.onstop = () => {
      const durationMs = performance.now() - r.startedAt
      const blob = new Blob(r.chunks, {
        type: recorder.mimeType || mimeType || "audio/webm",
      })
      const cancelled = r.cancelled
      teardown()
      setState("idle")
      if (!cancelled && blob.size > 0)
        callbacks.current.onStop({ blob, durationMs })
    }
    recorder.onerror = () => {
      if (recorder.state !== "inactive") recorder.stop()
    }
    // The mic can be taken away (a phone call, the app going to the background).
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (recorder.state !== "inactive") recorder.stop()
      }
    })

    recorder.start(1000)
    setState("recording")
    setElapsedMs(0)
    r.timer = window.setInterval(
      () => setElapsedMs(performance.now() - r.startedAt),
      200
    )

    if (analyser) {
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser!.getByteTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += ((v - 128) / 128) ** 2
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4))
        r.frame = requestAnimationFrame(tick)
      }
      tick()
    }
    // Keep the screen on during long dictation.
    navigator.wakeLock
      ?.request("screen")
      .then((lock) => {
        if (live.current === r) r.wakeLock = lock
        else lock.release().catch(() => {})
      })
      .catch(() => {})
  }, [maxBytes, teardown])

  const stop = useCallback(() => {
    const r = live.current
    if (r && r.recorder.state !== "inactive") r.recorder.stop()
  }, [])

  const cancel = useCallback(() => {
    const r = live.current
    if (!r) return
    r.cancelled = true
    if (r.recorder.state !== "inactive") r.recorder.stop()
    else {
      teardown()
      setState("idle")
    }
  }, [teardown])

  useEffect(
    () => () => {
      if (live.current) {
        live.current.cancelled = true
        live.current.recorder.stop()
      }
    },
    []
  )

  return { state, elapsedMs, level, start, stop, cancel }
}

export function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

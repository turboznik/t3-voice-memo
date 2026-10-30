# T3 voice memo

A small phone-first web app for talking to your [T3 Code](https://github.com/pingdotgg/t3code) agents. Tap the mic and talk. OpenAI transcribes the recording and, if you like, cleans up the transcript (filler words, false starts, punctuation). The text lands in a large editable box. From there you can **Copy** it, or **Send** it to any T3 Code thread, where it appears as a normal user message, the same as one typed in T3.

It's meant to be saved to an iPhone's home screen, but works in any modern browser.

## Using it

- **Record:** tap the red mic, talk, tap again to stop. Recording again adds the new text below what's there. Cancel throws the recording away.
- **Clean up** (switch at the top, on by default): removes filler words and self-corrections and fixes punctuation, keeping your words. **Original** under the text swaps the latest cleaned-up piece back to the raw transcript. The **Clean up** button under the text cleans up everything in the box, for example after you've typed into it.
- **Edit** in the box, then **Copy** or **Send**. ⌘/Ctrl+Enter sends.
- **Thread:** tap "To …" above the buttons. The list is T3's top-level threads, the ones you wrote in most recently first, with a search box. The choice is remembered on the device. A green dot means the agent is working.
- **If the agent is busy** (in the thread picker): **Steer** puts the message into the running turn, as T3's composer does by default. **Queue** waits for the turn to end.
- **Recent** (clock icon): the last 30 messages you copied or sent, kept on the device, so a lost paste can be recovered.
- **Nothing gets lost:** the draft is saved as you type. A recording stays on the device until it has been transcribed, so if the upload fails you can try again, even after closing the app.

## What you need

- A Linux machine running the **T3 Code** server (tested with T3 Code 0.1.2), with **Node 24** or newer.
- **Tailscale** on that machine and on your phone. The app is served over your tailnet only. Tailscale also tells the app who is asking, and that is how it checks that it's you.
- An **OpenAI API key**.

## Setup

**1. Get the code and build it.**

```bash
git clone <this repo> ~/t3-voice-memo && cd ~/t3-voice-memo
npm install
npm run build
```

**2. Give it your OpenAI key.** It reads `OPENAI_API_KEY` from the environment, or else the file `~/.config/openai/api-key`:

```bash
mkdir -p ~/.config/openai && chmod 700 ~/.config/openai
umask 077; printf '%s\n' 'sk-...' > ~/.config/openai/api-key
```

**3. Give it a T3 token.** This is a T3 session limited to reading threads and sending messages:

```bash
mkdir -p ~/.config/voice-memo
umask 077; t3 auth session issue \
  --scope orchestration:read --scope orchestration:operate \
  --ttl 3650d --label voice-memo --subject voice-memo --token-only > ~/.config/voice-memo/t3-token
```

Use the `t3` binary of the version your T3 server runs. To revoke the token later: `t3 auth session list`, then `t3 auth session revoke <id>`.

**4. Find your Tailscale login.** From the machine, run `tailscale whois <your phone's tailnet IP>`. The `Name` under `User` is your login, for example `you@github`. Only the logins you list in `ALLOWED_LOGINS` can use the app.

**5. Run it as a service.** Copy [`deploy/voice-memo.service`](deploy/voice-memo.service) to `~/.config/systemd/user/`. Set `WorkingDirectory` and `ALLOWED_LOGINS` in it, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now voice-memo
loginctl enable-linger "$USER"     # keep it running after you log out
```

**6. Publish it on your tailnet** (HTTPS, because browsers only open the microphone on a secure page). Pick any free HTTPS port:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
```

If `tailscale serve` needs root, use `sudo`, or run `sudo tailscale set --operator=$USER` once. Don't use `tailscale funnel`: that would put the app on the public internet.

**7. On the iPhone:** open `https://<machine>.<tailnet>.ts.net:8443` in Safari, allow the microphone, then Share → **Add to Home Screen**.

## Settings

Environment variables, set in the unit file:

| Variable | Default | |
|---|---|---|
| `ALLOWED_LOGINS` | none (required) | comma-separated Tailscale logins, e.g. `you@github` |
| `PORT`, `HOST` | `8787`, `127.0.0.1` | keep `HOST` on 127.0.0.1 (see Security) |
| `T3_PUBLIC_URL` | none | where you open T3 in the browser, e.g. `https://machine.tailnet.ts.net`; adds an "Open" link after a send |
| `T3_BASE_URL` | `http://127.0.0.1:3773` | the local T3 server |
| `T3_TOKEN_FILE` | `~/.config/voice-memo/t3-token` | |
| `OPENAI_API_KEY` / `OPENAI_API_KEY_FILE` | `~/.config/openai/api-key` | |
| `TRANSCRIBE_MODEL` | `gpt-transcribe` | `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` also work |
| `CLEANUP_MODEL` | `gpt-5.4-mini` | |
| `VOCABULARY` | a list of common coding-tool names | names the transcriber should spell your way, comma-separated |
| `AUTH` | `tailscale` | `off` only for local tests |
| `SPEECH_PROVIDER`, `T3_PROVIDER` | `openai`, `t3` | `mock` for either, for trying it with no keys or threads |

**Deploy a change:** `npm run build && systemctl --user restart voice-memo`. Logs: `journalctl --user -u voice-memo -f`.

## How it works

```
phone ──https (tailscale serve, adds Tailscale-User-Login)──▶ server/server.mjs on 127.0.0.1:8787
   ├─ GET  /                the built SPA (dist/)
   ├─ POST /api/transcribe  → OpenAI transcription (+ clean-up)
   ├─ POST /api/clean       → OpenAI clean-up
   ├─ GET  /api/threads     → T3  GET /api/orchestration/shell
   └─ POST /api/send        → T3  WebSocket RPC orchestration.dispatchCommand {type: "message.dispatch", createdBy: "user"}
```

- **Front end:** Vite, React, Tailwind v4 and shadcn/ui (`src/`). `MediaRecorder` records Opus/WebM or, on iOS, AAC/MP4, with the browser's noise suppression and auto gain on. A wake lock keeps the screen on while recording.
- **Server:** plain Node with no runtime dependencies (`server/`). `t3.mjs` is the T3 client and `openai.mjs` does speech to text and clean-up. `mock-t3.mjs` and `SPEECH_PROVIDER=mock` let it run with no keys and no real threads.
- **Sending to T3:** the server sends the same `message.dispatch` command T3's web client sends from its composer: `createdBy: "user"`, `creationSource: "mobile"`, and `dispatchMode: start_immediately` with `deliveryIntent: "auto"` (or `queue_after_active` in Queue mode). T3 starts, steers or queues the turn. The browser makes a command ID per message, so a retried send is never posted twice. This uses T3's internal API, which can change between T3 versions; if sending breaks after a T3 update, look there first.

## Security

Anyone who can use this page can instruct your agents, and they may run with full permissions on the machine. So:
- The server listens on 127.0.0.1 only. Only `tailscale serve` on the same machine can reach it.
- It answers only requests whose `Tailscale-User-Login` header (which `tailscale serve` sets) is in `ALLOWED_LOGINS`. It refuses to start if `ALLOWED_LOGINS` is empty. Requests from tagged devices carry no login, so they get a 403.
- The OpenAI key and the T3 token stay on the server and never reach the browser.
- Recordings and text aren't stored on the server, and the logs record only sizes and timings. OpenAI calls use `store: false`.

## Development

```bash
AUTH=off SPEECH_PROVIDER=mock T3_PROVIDER=mock PORT=8899 npm start   # the built app, no keys, fake threads
npm run typecheck && npm run lint
npm test                           # vitest: server logic, auth check, T3 command shape
npm run build && npm run e2e       # Chrome with a fake mic: pick thread, record, edit, copy, send, reload
```

The e2e test and `npm run icons` drive your installed Google Chrome through `playwright-core`. Without Chrome, run `npx playwright install chromium` and set `CHROME_CHANNEL=chromium`. Screenshots go to `test-results/e2e/`.

**Icons:** edit `icons/icon-full.svg` (full-bleed, for the home screen) and `public/favicon.svg` (rounded), then run `npm run icons`.

## Cost

OpenAI transcription bills per second of audio, and the clean-up is a small call. Together that's well under a cent for a one-minute memo.


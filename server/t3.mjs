// A small client for the local T3 Code server (127.0.0.1:3773).
//
// It reads threads over HTTP (GET /api/orchestration/shell) and sends messages
// over T3's WebSocket RPC (orchestration.dispatchCommand with message.dispatch),
// the same command T3's own web client sends when you type in the composer. So
// a message sent from here shows up as a normal user message.
//
// Auth is a scoped bearer token (orchestration:read + orchestration:operate),
// issued with `t3 auth session issue` and kept in ~/.config/voice-memo/t3-token.
// It never reaches the browser.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PROTOCOL = '2'; // T3's orchestration protocol version (x-t3-orchestration-protocol)

export function createT3Client({ baseUrl, tokenFile, environmentIdFile, publicUrl }) {
  // Read on each use so a re-issued token works without a restart.
  const token = () => {
    const value = readFileSync(tokenFile, 'utf8').trim();
    if (!value) throw new Error(`T3 token file is empty: ${tokenFile}`);
    return value;
  };
  const environmentId = () => {
    try { return readFileSync(environmentIdFile, 'utf8').trim(); } catch { return null; }
  };

  async function shell() {
    const res = await fetch(`${baseUrl}/api/orchestration/shell`, {
      headers: { authorization: `Bearer ${token()}`, 'x-t3-orchestration-protocol': PROTOCOL },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`T3 shell snapshot: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async function listThreads() {
    const snapshot = await shell();
    const env = environmentId();
    return summarizeShell(snapshot, (threadId) => (!publicUrl ? undefined : env ? `${publicUrl}/${env}/${encodeURIComponent(threadId)}` : publicUrl));
  }

  // One short-lived socket per call: sends are rare, and this keeps no state.
  async function rpc(method, payload, { timeoutMs = 20_000 } = {}) {
    const ticketRes = await fetch(`${baseUrl}/api/auth/websocket-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!ticketRes.ok) throw new Error(`T3 websocket ticket: HTTP ${ticketRes.status}`);
    const { ticket } = await ticketRes.json();
    const wsUrl = new URL('/ws', baseUrl.replace(/^http/, 'ws'));
    wsUrl.searchParams.set('orchestrationProtocol', PROTOCOL);
    wsUrl.searchParams.set('wsTicket', ticket);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const id = '1';
      const timer = setTimeout(() => finish(new Error(`T3 ${method}: timed out`)), timeoutMs);
      let done = false;
      function finish(err, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        if (err) reject(err); else resolve(value);
      }
      ws.onopen = () => ws.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }));
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg._tag === 'Ping') { ws.send(JSON.stringify({ _tag: 'Pong' })); return; }
        if (msg._tag !== 'Exit' || msg.requestId !== id) return;
        if (msg.exit?._tag === 'Success') finish(null, msg.exit.value);
        else finish(Object.assign(new Error(`T3: ${describeFailure(msg.exit)}`), { status: 502 }));
      };
      ws.onerror = () => finish(new Error(`T3 ${method}: websocket error`));
      ws.onclose = (event) => finish(new Error(`T3 ${method}: socket closed (${event.code})`));
    });
  }

  // mode "auto" does what T3's composer does: start the agent if the thread is
  // idle, otherwise steer the running turn (or queue, if steering isn't possible).
  // mode "queue" waits for the running turn to finish first.
  async function sendMessage({ threadId, text, mode = 'auto', commandId = randomUUID(), messageId = randomUUID() }) {
    const command = buildDispatchCommand({ threadId, text, mode, commandId, messageId });
    const result = await rpc('orchestration.dispatchCommand', command);
    return { commandId, messageId, sequence: result?.sequence ?? null };
  }

  return { listThreads, sendMessage, environmentId };
}

export function buildDispatchCommand({ threadId, text, mode, commandId, messageId }) {
  return {
    type: 'message.dispatch',
    commandId,
    createdBy: 'user',
    creationSource: 'mobile',
    threadId,
    messageId,
    text,
    attachments: [],
    ...(mode === 'queue'
      ? { dispatchMode: { type: 'queue_after_active' } }
      : { deliveryIntent: 'auto', dispatchMode: { type: 'start_immediately' } }),
  };
}

// Effect RPC failures arrive as {cause: [{_tag: "Fail", error: {...}}]}.
export function describeFailure(exit) {
  const causes = Array.isArray(exit?.cause) ? exit.cause : [exit?.cause];
  const first = causes.find(Boolean);
  const error = first?.error ?? first?.defect ?? first;
  if (!error) return 'failed';
  if (typeof error === 'string') return error;
  const message = error.message ?? error.detail ?? error._tag ?? JSON.stringify(error).slice(0, 300);
  if (/No orchestration projection exists for thread/.test(message)) return 'That thread no longer exists. Pick another.';
  return message;
}

// The shell snapshot is T3's sidebar: every project and thread. Keep top-level
// threads (not subagents) that aren't archived or deleted, newest first.
export function summarizeShell(snapshot, linkFor) {
  const projects = new Map((snapshot.projects ?? []).filter((p) => !p.deletedAt).map((p) => [p.id, p.title]));
  const threads = (snapshot.threads ?? [])
    .filter((t) => !t.archivedAt && !t.deletedAt && !t.lineage?.parentThreadId && projects.has(t.projectId))
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectTitle: projects.get(t.projectId),
      status: t.status,
      busy: Boolean(t.activeRunId),
      settled: t.settledAt != null,
      // when the owner last wrote in it: the order they think of threads in
      lastMessageAt: t.latestUserMessageAt ?? t.createdAt,
      url: linkFor(t.id),
    }))
    .sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt)));
  return { threads };
}

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { buildDispatchCommand, summarizeShell } from '../server/t3.mjs';
import { extensionFor } from '../server/openai.mjs';
import { createApp, loadConfig } from '../server/server.mjs';

describe('buildDispatchCommand', () => {
  const base = { threadId: 't1', text: 'hello', commandId: 'c', messageId: 'm' };
  it('sends like T3 composer: start now, let the server steer if busy', () => {
    const cmd = buildDispatchCommand({ ...base, mode: 'auto' });
    expect(cmd).toMatchObject({
      type: 'message.dispatch', createdBy: 'user', creationSource: 'mobile', threadId: 't1', text: 'hello',
      attachments: [], deliveryIntent: 'auto', dispatchMode: { type: 'start_immediately' },
    });
  });
  it('queues behind a running turn in queue mode', () => {
    const cmd = buildDispatchCommand({ ...base, mode: 'queue' });
    expect(cmd.dispatchMode).toEqual({ type: 'queue_after_active' });
    expect(cmd.deliveryIntent).toBeUndefined();
  });
});

describe('summarizeShell', () => {
  const snapshot = {
    projects: [{ id: 'p1', title: 'One' }, { id: 'p2', title: 'Gone', deletedAt: '2026-01-01' }],
    threads: [
      { id: 'a', title: 'Old', projectId: 'p1', status: 'completed', latestUserMessageAt: '2026-10-01T00:00:00Z', lineage: {} },
      { id: 'b', title: 'New', projectId: 'p1', status: 'running', activeRunId: 'r', latestUserMessageAt: '2026-10-29T00:00:00Z', lineage: {} },
      { id: 'c', title: 'Sub', projectId: 'p1', status: 'idle', createdAt: '2026-10-30T00:00:00Z', lineage: { parentThreadId: 'b' } },
      { id: 'd', title: 'Archived', projectId: 'p1', archivedAt: '2026-10-02', lineage: {} },
      { id: 'e', title: 'Deleted project', projectId: 'p2', lineage: {} },
      { id: 'f', title: 'Settled', projectId: 'p1', settledAt: '2026-10-03', createdAt: '2026-09-01T00:00:00Z', lineage: {} },
    ],
  };
  it('keeps live top-level threads, newest first, with links', () => {
    const { threads } = summarizeShell(snapshot, (id) => `https://t3/${id}`);
    expect(threads.map((t) => t.id)).toEqual(['b', 'a', 'f']);
    expect(threads[0]).toMatchObject({ projectTitle: 'One', busy: true, settled: false, url: 'https://t3/b' });
    expect(threads[2].settled).toBe(true);
  });
});

describe('extensionFor', () => {
  it('maps recorder types to names the API decodes', () => {
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionFor('audio/mp4')).toBe('mp4');
    expect(extensionFor('audio/x-m4a')).toBe('m4a');
    expect(extensionFor('text/plain')).toBe(null);
  });
});

// Drive the request handler without a socket.
async function request(app, { method = 'GET', path, headers = {}, body }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url: path, headers: { ...headers } });
  let status = 0;
  const chunks = [];
  const res = {
    headersSent: false,
    writeHead(s) { status = s; this.headersSent = true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); },
  };
  await app.handle(req, res);
  const text = Buffer.concat(chunks).toString();
  return { status, json: text.startsWith('{') ? JSON.parse(text) : text };
}

describe('server', () => {
  const config = { ...loadConfig({ ALLOWED_LOGINS: 'You@github' }), speechProvider: 'mock', t3Provider: 'mock', dist: '/nonexistent' };
  const owner = { 'tailscale-user-login': 'you@GitHub' };

  it('refuses requests without an allowed tailnet login', async () => {
    const app = createApp(config);
    expect((await request(app, { path: '/api/threads' })).status).toBe(403);
    expect((await request(app, { path: '/api/threads', headers: { 'tailscale-user-login': 'someone@github' } })).status).toBe(403);
    expect((await request(app, { path: '/' })).status).toBe(403);
    expect((await request(app, { path: '/api/threads', headers: owner })).status).toBe(200);
  });

  it('transcribes and cleans up', async () => {
    const app = createApp(config);
    const r = await request(app, { method: 'POST', path: '/api/transcribe?clean=1', headers: { ...owner, 'content-type': 'audio/webm' }, body: 'fake-audio' });
    expect(r.status).toBe(200);
    expect(r.json.raw).toMatch(/^Um, so this is a mock transcript/);
    expect(r.json.cleaned).toMatch(/^So this is a mock transcript/);
  });

  it('rejects recordings over the upload limit', async () => {
    const app = createApp({ ...config, maxAudioBytes: 4 });
    const r = await request(app, { method: 'POST', path: '/api/transcribe', headers: { ...owner, 'content-type': 'audio/webm' }, body: 'too long' });
    expect(r.status).toBe(413);
  });

  it('sends once per command id', async () => {
    const app = createApp(config);
    const body = { threadId: 'mock-thread-2', text: ' hi there ', mode: 'queue', commandId: '00000000-0000-4000-8000-000000000001', messageId: '00000000-0000-4000-8000-000000000002' };
    expect((await request(app, { method: 'POST', path: '/api/send', headers: owner, body })).status).toBe(200);
    expect((await request(app, { method: 'POST', path: '/api/send', headers: owner, body })).status).toBe(200);
    expect(app.t3.sent).toEqual([{ ...body, text: 'hi there' }]);
  });

  it('validates sends', async () => {
    const app = createApp(config);
    expect((await request(app, { method: 'POST', path: '/api/send', headers: owner, body: { threadId: 'x', text: '  ' } })).status).toBe(400);
    expect((await request(app, { method: 'POST', path: '/api/send', headers: owner, body: { text: 'hi' } })).status).toBe(400);
    expect((await request(app, { method: 'POST', path: '/api/send', headers: owner, body: { threadId: 'nope', text: 'hi' } })).status).toBe(404);
  });
});

import { describeFailure } from '../server/t3.mjs';
describe('describeFailure', () => {
  it('reads Effect RPC failures', () => {
    expect(describeFailure({ cause: [{ _tag: 'Fail', error: { _tag: 'X', message: 'No orchestration projection exists for thread x.' } }] })).toBe('That thread no longer exists. Pick another.');
    expect(describeFailure({ cause: [{ _tag: 'Fail', error: { _tag: 'X', message: 'Nope' } }] })).toBe('Nope');
    expect(describeFailure({})).toBe('failed');
  });
});

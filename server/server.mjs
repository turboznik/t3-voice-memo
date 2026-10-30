// voice-memo: record on the phone, transcribe with OpenAI, then copy the text
// or send it to a T3 Code thread as if typed there.
//
// Plain Node (24+) with no dependencies. It serves the built SPA from dist/ and
// a small JSON API, on 127.0.0.1 only; `tailscale serve` publishes it over HTTPS
// (browsers only open the microphone on a secure page).
//
// Access: anyone who can open this page can instruct the owner's agents, which
// run with full permissions. So every request must carry a Tailscale-User-Login
// that `tailscale serve` adds, naming an allowed login. Because the server only
// listens on 127.0.0.1, requests can't reach it without passing through the proxy.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createT3Client } from './t3.mjs';
import { createSpeech } from './openai.mjs';
import { createMockT3 } from './mock-t3.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = homedir();

export function loadConfig(env = process.env) {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 8787),
    dist: env.DIST_DIR ?? join(ROOT, 'dist'),
    // "off" only for local tests: the server must never be reachable without the proxy then.
    auth: env.AUTH ?? 'tailscale',
    allowedLogins: (env.ALLOWED_LOGINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    speechProvider: env.SPEECH_PROVIDER ?? 'openai',
    openaiKeyFile: env.OPENAI_API_KEY_FILE ?? join(HOME, '.config/openai/api-key'),
    transcribeModel: env.TRANSCRIBE_MODEL ?? 'gpt-transcribe',
    cleanupModel: env.CLEANUP_MODEL ?? 'gpt-5.4-mini',
    // Names the transcriber should spell your way (comma-separated); empty for none.
    vocabulary: env.VOCABULARY,
    // the API's own upload limit
    maxAudioBytes: Number(env.MAX_AUDIO_BYTES ?? 25 * 1024 * 1024),
    maxTextChars: Number(env.MAX_TEXT_CHARS ?? 100_000),
    t3Provider: env.T3_PROVIDER ?? 't3',
    t3BaseUrl: env.T3_BASE_URL ?? 'http://127.0.0.1:3773',
    // Where T3's web UI is, for "Open" links after a send (optional).
    t3PublicUrl: env.T3_PUBLIC_URL?.replace(/\/+$/, '') || null,
    t3TokenFile: env.T3_TOKEN_FILE ?? join(HOME, '.config/voice-memo/t3-token'),
    t3EnvironmentIdFile: env.T3_ENVIRONMENT_ID_FILE ?? join(HOME, '.t3/userdata/environment-id'),
  };
}

export function createApp(config) {
  const speech = createSpeech({
    provider: config.speechProvider,
    keyFile: config.openaiKeyFile,
    transcribeModel: config.transcribeModel,
    cleanupModel: config.cleanupModel,
    vocabulary: config.vocabulary,
  });
  const t3 = config.t3Provider === 'mock'
    ? createMockT3()
    : createT3Client({
      baseUrl: config.t3BaseUrl,
      tokenFile: config.t3TokenFile,
      environmentIdFile: config.t3EnvironmentIdFile,
      publicUrl: config.t3PublicUrl,
    });

  const routes = {
    'GET /api/config': async ({ login }) => ({
      login,
      transcribeModel: config.transcribeModel,
      cleanupModel: config.cleanupModel,
      maxAudioBytes: config.maxAudioBytes,
      t3Url: config.t3PublicUrl,
    }),

    'GET /api/threads': async () => t3.listThreads(),

    // Body: the raw recording. ?clean=1 also returns a cleaned-up version.
    'POST /api/transcribe': async ({ req, url }) => {
      const mime = req.headers['content-type'] ?? '';
      const audio = await readBody(req, config.maxAudioBytes, 'Recording');
      if (audio.length === 0) throw httpError(400, 'The recording is empty.');
      const started = Date.now();
      const raw = await speech.transcribe(audio, mime);
      const transcribedMs = Date.now() - started;
      const cleaned = url.searchParams.get('clean') === '1' && raw ? await speech.cleanup(raw) : null;
      log(`transcribe bytes=${audio.length} type=${mime.split(';')[0]} chars=${raw.length} stt=${transcribedMs}ms clean=${cleaned === null ? 'no' : `${Date.now() - started - transcribedMs}ms`}`);
      return { raw, cleaned };
    },

    // Body: {text}. Clean up text the owner edited or recorded earlier.
    'POST /api/clean': async ({ req }) => {
      const { text } = await readJson(req, config.maxTextChars * 4);
      if (typeof text !== 'string' || !text.trim()) throw httpError(400, 'Nothing to clean up.');
      const started = Date.now();
      const cleaned = await speech.cleanup(text);
      log(`clean chars=${text.length} ${Date.now() - started}ms`);
      return { text: cleaned };
    },

    // Body: {threadId, text, mode: "auto"|"queue", commandId?, messageId?}.
    // commandId makes a retried send idempotent on T3's side.
    'POST /api/send': async ({ req }) => {
      const body = await readJson(req, config.maxTextChars * 4);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw httpError(400, 'Nothing to send.');
      if (text.length > config.maxTextChars) throw httpError(413, 'The message is too long.');
      if (typeof body.threadId !== 'string' || !body.threadId) throw httpError(400, 'Pick a thread first.');
      const ids = ['commandId', 'messageId'].map((k) => body[k]);
      if (ids.some((v) => v !== undefined && !/^[0-9a-f-]{36}$/i.test(v))) throw httpError(400, 'Bad request id.');
      const started = Date.now();
      const result = await t3.sendMessage({
        threadId: body.threadId,
        text,
        mode: body.mode === 'queue' ? 'queue' : 'auto',
        ...(body.commandId ? { commandId: body.commandId } : {}),
        ...(body.messageId ? { messageId: body.messageId } : {}),
      });
      log(`send chars=${text.length} mode=${body.mode === 'queue' ? 'queue' : 'auto'} ${Date.now() - started}ms`);
      return { ok: true, ...result };
    },
  };
  if (config.t3Provider === 'mock') routes['GET /api/_mock/sent'] = async () => ({ sent: t3.sent });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const login = String(req.headers['tailscale-user-login'] ?? '').toLowerCase();
    if (config.auth !== 'off' && !config.allowedLogins.includes(login)) {
      log(`refused ${req.method} ${url.pathname} login=${login || '(none)'}`);
      const message = `This page is only for its owner. Tailscale says you are ${login || 'nobody (a tagged device, or not through tailscale serve)'}.`;
      if (url.pathname.startsWith('/api/')) return sendJson(res, 403, { error: message });
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(message + '\n');
    }

    const route = routes[`${req.method} ${url.pathname}`];
    if (route) {
      try {
        return sendJson(res, 200, await route({ req, url, login }));
      } catch (err) {
        const status = err.status ?? 500;
        log(`error ${req.method} ${url.pathname} ${status}: ${err.message}`);
        return sendJson(res, status, { error: status === 500 ? `Server error: ${err.message}` : err.message });
      }
    }
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic(config.dist, url.pathname, req, res);
  }

  return { handle, t3 };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(dist, pathname, req, res) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(dist, rel);
  if (!file.startsWith(dist + sep) && file !== dist) return sendJson(res, 400, { error: 'Bad path' });
  let info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    // A missing asset is a 404; anything else is a client route and gets the app.
    if (rel.startsWith('assets/') || extname(rel)) return sendJson(res, 404, { error: 'Not found' });
    rel = 'index.html';
    file = join(dist, rel);
    info = await stat(file).catch(() => null);
    if (!info) return sendJson(res, 503, { error: 'The app is not built yet: run npm run build.' });
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // Hashed bundles never change; everything else is checked on each load.
    'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit, what = 'Request') {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw httpError(413, `${what} is too large (over ${Math.round(limit / 1024 / 1024)} MB).`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, `${what} is too large (over ${Math.round(limit / 1024 / 1024)} MB).`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { throw httpError(400, 'Bad JSON.'); }
}

function log(line) {
  console.log(`[voice-memo] ${line}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const config = loadConfig();
  if (config.auth !== 'off' && config.allowedLogins.length === 0) {
    console.error('[voice-memo] Set ALLOWED_LOGINS to your Tailscale login (for example you@github). Run `tailscale whois <your phone\'s tailnet IP>` to see it.');
    process.exit(1);
  }
  const app = createApp(config);
  const server = createServer((req, res) => {
    app.handle(req, res).catch((err) => {
      log(`unhandled: ${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
      else res.end();
    });
  });
  server.listen(config.port, config.host, () => {
    log(`listening on http://${config.host}:${server.address().port} (auth ${config.auth}, speech ${config.speechProvider}, t3 ${config.t3Provider})`);
  });
}

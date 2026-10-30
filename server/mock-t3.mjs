// A stand-in for T3 (T3_PROVIDER=mock), so the app and its tests run without
// touching real threads. Sends are kept in memory for the tests to check.

import { randomUUID } from 'node:crypto';

export function createMockT3() {
  const now = Date.now();
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
  const threads = [
    { id: 'mock-thread-1', title: 'Fix the login redirect', projectId: 'p1', projectTitle: 'web-app', status: 'running', busy: true, settled: false, lastMessageAt: at(3) },
    { id: 'mock-thread-2', title: 'Tidy up the settings page', projectId: 'p2', projectTitle: 'web-app', status: 'completed', busy: false, settled: false, lastMessageAt: at(45) },
    { id: 'mock-thread-3', title: 'Write the release notes', projectId: 'p3', projectTitle: 'docs', status: 'completed', busy: false, settled: true, lastMessageAt: at(60 * 26) },
  ].map((t) => ({ ...t, url: `https://example.invalid/${t.id}` }));
  const sent = [];

  return {
    sent,
    async listThreads() {
      return { threads };
    },
    async sendMessage({ threadId, text, mode, commandId = randomUUID(), messageId = randomUUID() }) {
      if (!threads.some((t) => t.id === threadId)) throw Object.assign(new Error('Thread not found.'), { status: 404 });
      // Same command id twice is one message, like T3.
      if (!sent.some((s) => s.commandId === commandId)) sent.push({ threadId, text, mode, commandId, messageId });
      return { commandId, messageId, sequence: sent.length };
    },
  };
}

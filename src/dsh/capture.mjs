/**
 * Session capture buffer.
 *
 * DSH emits `session/event` synchronously for every appended message. Writing
 * and embedding on that path would slow the agent loop, so the buffer keeps a
 * small per-session exchange, coalesces user+assistant messages of one turn, and
 * flushes after a short idle window (or when the turn boundary is visible).
 *
 * Flushes are serialized: the embedding provider sees one request at a time,
 * and a failed flush is logged without ever surfacing into the session.
 *
 * @module dsh-memory-tree/dsh/capture
 */

import { createLogger } from '../engine/log.mjs';

/**
 * @param {{ engine: object, config: object, logger?: object }} deps
 */
export function createCaptureBuffer({ engine, config, logger = createLogger({ level: 'warn' }) }) {
  /** @type {Map<string, { cwd: string, entries: Array<{role: string, text: string, time: string}>, timer: any }>} */
  const sessions = new Map();
  let chain = Promise.resolve();
  let disposed = false;
  let flushedExchanges = 0;
  let failedFlushes = 0;

  const excluded = (sessionId, cwd) =>
    config.capture.excludeSessions.some(
      (needle) => needle && (String(sessionId ?? '').includes(needle) || String(cwd ?? '').includes(needle)),
    );

  const flush = (sessionId) => {
    if (disposed) return;
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    if (state.timer) clearTimeout(state.timer);
    const entries = state.entries;
    if (entries.length === 0) return;
    const payload = { sessionId, cwd: state.cwd, messages: entries };
    logger.debug?.(`flush ${sessionId}: ${entries.length} message(s)`);
    chain = chain
      .then(async () => {
        try {
          await engine.rememberExchange(payload);
          flushedExchanges += 1;
          logger.debug?.(`flush ok ${sessionId} (total ${flushedExchanges})`);
        } catch (error) {
          failedFlushes += 1;
          logger.warn?.(`memory capture failed for session ${sessionId}: ${error?.message ?? error}`);
        }
      })
      .catch(() => undefined);
  };

  const schedule = (sessionId, state) => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => flush(sessionId), config.capture.flushIdleMs);
    // Never keep the host process alive just for a pending memory flush.
    state.timer.unref?.();
  };

  return {
    /**
     * Feed one captured message.
     * @param {{ sessionId: string, cwd?: string, role: 'user'|'assistant', text: string, time?: string }} entry
     */
    push(entry) {
      if (disposed || !config.capture.enabled) return;
      const text = String(entry.text ?? '').trim();
      if (text.length < config.capture.minChars) {
        logger.debug?.(`skip ${entry.role}: ${text.length} < ${config.capture.minChars} chars`);
        return;
      }
      const sessionId = String(entry.sessionId ?? '') || 'unknown';
      const cwd = String(entry.cwd ?? '') || process.cwd();
      if (excluded(sessionId, cwd)) return;
      logger.debug?.(`buffer ${entry.role} (${text.length} chars) for ${sessionId}`);

      let state = sessions.get(sessionId);
      if (!state) {
        state = { cwd, entries: [], timer: null };
        sessions.set(sessionId, state);
      }
      state.cwd = cwd;

      // A new user message after an assistant reply is a turn boundary: the
      // previous exchange is complete and can be persisted immediately.
      const last = state.entries[state.entries.length - 1];
      if (entry.role === 'user' && last && last.role === 'assistant') {
        flush(sessionId);
        state = sessions.get(sessionId);
        if (!state) {
          state = { cwd, entries: [], timer: null };
          sessions.set(sessionId, state);
        }
      }

      state.entries.push({ role: entry.role, text, time: entry.time ?? new Date().toISOString() });
      if (state.entries.length > config.capture.maxBufferedMessages) {
        flush(sessionId);
        return;
      }
      schedule(sessionId, state);
    },

    flush,
    flushAll() {
      for (const sessionId of [...sessions.keys()]) flush(sessionId);
    },
    stats() {
      return { sessions: sessions.size, flushedExchanges, failedFlushes };
    },
    async dispose() {
      disposed = true;
      for (const state of sessions.values()) if (state.timer) clearTimeout(state.timer);
      sessions.clear();
      // Deliberately NOT awaiting `chain`: an in-flight embedding request can
      // take seconds, and DSH reports a close timeout when a plugin delays host
      // shutdown. Documents are persisted before embedding, so an interrupted
      // flush is retried as `pending` on the next start.
    },
  };
}

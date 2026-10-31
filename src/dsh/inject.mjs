/**
 * Pre-step recall injection helpers.
 *
 * The plugin never mutates the user's message: it appends one additional
 * `user`-role message carrying the `<memory-recall>` block, tagged with a
 * producer-owned source so it is (a) durable like any other context and
 * (b) recognisable on replay, so the capture path can skip it.
 *
 * Session format v4 rejects the retired `{ kind: 'plugin', plugin: '<name>' }`
 * wrapper ("format v4 message requires a producer-owned source kind") and
 * migrates it to `plugin:<name>`. A third-party plugin must emit the migrated
 * shape directly, or every turn that injects a recall block fails to load.
 *
 * @module dsh-memory-tree/dsh/inject
 */

import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Producer-owned source kind for the injected recall block.
 *
 * Session format v4 derives exactly this value (`plugin:` + package name) when
 * it migrates the retired wrapper, and refuses to load a message whose source
 * kind is the bare string `plugin`.
 */
export const RECALL_SOURCE_KIND = 'plugin:dsh-memory-tree';

/** Concatenate the text blocks of one message. */
export function textOfMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Extract the message from one `session/event` payload.
 *
 * DSH does not use one envelope for every message event:
 *   - `user/message`    → `data` IS the message ({ role, content, source, id });
 *   - `assistant/message` → `data` = { turn, step, message, usage, stream }.
 * Treating the assistant envelope as a message silently produced empty text and
 * dropped every assistant reply from memory. Normalize here, in one place.
 */
export function messageOfEvent(event) {
  const data = event?.data ?? event;
  if (!data || typeof data !== 'object') return null;
  const candidate = data.message && typeof data.message === 'object' ? data.message : data;
  if (!candidate || typeof candidate !== 'object') return null;
  if (!Array.isArray(candidate.content)) return null;
  return candidate;
}

/** True for messages a human actually typed (not tool results / injected context). */
export function isHumanMessage(message) {
  if (!message || message.role !== 'user') return false;
  const kind = message.source?.kind;
  return kind === 'user' || kind === undefined;
}

/** True for messages this plugin injected earlier. */
export function isMemoryMessage(message) {
  const source = message?.source;
  if (!source) return false;
  // v4 producer-owned kind; falls back to the retired v3 wrapper so memories
  // written by 0.4.0 and earlier stay recognisable.
  if (source.kind === RECALL_SOURCE_KIND) return true;
  return source.kind === 'plugin' && source.plugin === 'dsh-memory-tree';
}

/**
 * Whether a message may enter the memory store.
 *
 * DSH injects model-facing context as user-role messages with *custom* source
 * kinds (`time-context`, `system-prompt`, `agent-instructions`, `plugin`, …).
 * Only a real user message (`kind: 'user'`, or untyped in tests) and a real
 * model reply (`kind: 'model'`) carry conversation worth remembering.
 */
export function isCapturable(message, role) {
  if (!message || typeof message !== 'object') return false;
  const kind = message?.source?.kind;
  if (role === 'user') return kind === 'user' || kind === undefined;
  if (role === 'assistant') return kind === 'model' || kind === undefined;
  return false;
}

/**
 * The query used for auto-recall: the newest human message entering this step.
 * @param {Array<object>} messages
 */
export function extractUserQuery(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!isHumanMessage(message)) continue;
    const text = textOfMessage(message);
    if (text) return text;
  }
  return '';
}

/** Cheap gate before spending an embedding call. */
export function shouldSkipQuery(query, config) {
  const text = String(query ?? '').trim();
  if (text.length < config.recall.minQueryChars) return true;
  if (config.recall.skipQueryPrefixes.some((prefix) => prefix && text.startsWith(prefix))) return true;
  return false;
}

/** Build the injected context message. */
export function buildRecallMessage(block) {
  return createUserMessage({
    content: [{ type: 'text', text: block }],
    source: { kind: RECALL_SOURCE_KIND, form: 'recall' },
  });
}

/**
 * Insert the recall message right after the last claimed message so it lands at
 * the end of this step's batch, never before the user's own words.
 */
export function insertRecallMessage(decision, claimed, message) {
  const messages = Array.isArray(decision?.messages) ? [...decision.messages] : [];
  let lastClaimed = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (claimed.includes(messages[index])) {
      lastClaimed = index;
      break;
    }
  }
  if (lastClaimed === -1) messages.push(message);
  else messages.splice(lastClaimed + 1, 0, message);
  return { ...decision, messages };
}

/** Bounded per-turn de-duplication of injections (no unbounded memory growth). */
export function createInjectionGuard({ maxEntries = 500 } = {}) {
  const keys = new Set();
  return {
    seen(sessionId, turn, query) {
      const digest = createHash('sha1').update(String(query ?? '')).digest('hex').slice(0, 16);
      return keys.has(`${sessionId}:${turn}:${digest}`);
    },
    remember(sessionId, turn, query) {
      const digest = createHash('sha1').update(String(query ?? '')).digest('hex').slice(0, 16);
      keys.add(`${sessionId}:${turn}:${digest}`);
      while (keys.size > maxEntries) {
        const oldest = keys.values().next().value;
        keys.delete(oldest);
      }
    },
    clear() {
      keys.clear();
    },
  };
}

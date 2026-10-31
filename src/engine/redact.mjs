/**
 * Credential redaction for captured text.
 *
 * Capture is unconditional: whatever the human typed or the model printed lands
 * in the store and is embedded. A pasted token is then retrievable forever and
 * can resurface inside a prompt. Redact at the ingestion boundary instead of
 * relying on the agent to avoid printing secrets.
 *
 * The redaction is deliberately conservative: only well-known credential shapes
 * with long, high-entropy bodies are touched, so ordinary prose ("npm_package",
 * "sk-learn") is left alone.
 *
 * @module dsh-memory-tree/engine/redact
 */

/** @type {Array<{ name: string, pattern: RegExp }>} */
const RULES = [
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'github_pat', pattern: /github_pat_[A-Za-z0-9_]{40,}/g },
  { name: 'npm_token', pattern: /npm_[A-Za-z0-9]{30,}/g },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9_-]{24,}/g },
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * Replace credential-shaped substrings with a stable marker.
 *
 * @param {string} text
 * @returns {{ text: string, redacted: boolean, kinds: string[] }}
 */
export function redactSecrets(text) {
  let value = String(text ?? '');
  /** @type {string[]} */
  const kinds = [];
  for (const rule of RULES) {
    value = value.replace(rule.pattern, () => {
      kinds.push(rule.name);
      return `[REDACTED:${rule.name}]`;
    });
  }
  const unique = [...new Set(kinds)];
  return { text: value, redacted: unique.length > 0, kinds: unique };
}

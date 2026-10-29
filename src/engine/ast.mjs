/**
 * AST "soft decision tree" for memory text.
 *
 * Deterministic structural parse (headings / numbered sections / bullets /
 * paragraphs) builds a stable, addressable tree. Softness comes later: every
 * node is embedded and linked to its nearest semantic neighbours, so recall can
 * leave the hard parent/child path and jump across the tree by similarity.
 *
 * Node shape (flat list, tree expressed through `path`/`parentPath`):
 *   { ordinal, kind, path, parentPath, depth, title, content, hash, segment }
 *
 * @module dsh-memory-tree/engine/ast
 */

import { createHash } from 'node:crypto';

const MD_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const NUM_HEADING = /^[ \t]{0,3}(\d{1,2})[.、)][ \t]+(\S.*)$/;
const CJK_HEADING = /^[ \t]{0,3}([一二三四五六七八九十百]+)[、.．][ \t]*(\S.*)$/;
const BULLET = /^[ \t]{0,6}([-*+•·])[ \t]+(\S.*)$/;
const MAX_TITLE = 48;

/** Collapse whitespace and strip control characters. */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Stable 12-hex-character content hash used for dedupe. */
export function shortHash(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 24);
}

/** First sentence-ish slice, used as a node title. */
export function deriveTitle(text, max = MAX_TITLE) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const cut = flat.split(/(?<=[。！？!?.;；])/)[0] ?? flat;
  const title = (cut || flat).trim();
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/** Filesystem/path-safe segment for one tree level. */
export function slugSegment(text, fallback) {
  const flat = String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = flat.replace(/^[.．]+|[.．]+$/g, '').slice(0, 40).trim();
  return cleaned || fallback;
}

/**
 * Tokenizer used for lexical recall: latin/number words plus CJK bigrams.
 * Deliberately dependency-free and CJK-friendly (FTS5's unicode61 does not
 * segment Chinese, so we score in JS over SQL-selected candidates).
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const terms = new Set();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9_+#.-]{1,}/g)) {
    if (match[0].length >= 2) terms.add(match[0]);
  }
  for (const run of lower.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) terms.add(run.slice(i, i + 2));
  }
  return [...terms];
}

/** SQL LIKE pattern that is safe for terms containing wildcards. */
export function likePattern(term) {
  return `%${String(term).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Strip a leading YAML front-matter block (common in notes and mirrors). */
export function stripFrontMatter(text) {
  const value = String(text ?? '').replace(/^\uFEFF/, '');
  if (!value.startsWith('---')) return value;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(value);
  return match ? value.slice(match[0].length) : value;
}

/**
 * Parse one document into tree nodes.
 *
 * @param {string} rawText - normalized or raw memory text.
 * @param {{ title?: string, baseImportance?: number }} [options]
 * @returns {{ root: { title: string, path: string }, nodes: Array<object> }}
 */
export function parseMemoryTree(rawText, options = {}) {
  const text = normalizeText(stripFrontMatter(rawText));
  const docTitle = deriveTitle(options.title || text.split('\n')[0] || 'memory', 64);
  const rootSegment = slugSegment(docTitle, 'memory');
  const rootPath = `/${rootSegment}`;
  /** @type {Array<object>} */
  const nodes = [];
  const usedPaths = new Set([rootPath]);
  /** @type {Array<{ depth: number, path: string, segment: string }>} */
  const stack = [{ depth: 0, path: rootPath, segment: rootSegment }];
  let paragraph = [];
  let ordinal = 0;

  const uniquePath = (parentPath, segment) => {
    let candidate = `${parentPath}/${segment}`;
    let suffix = 2;
    while (usedPaths.has(candidate)) {
      candidate = `${parentPath}/${segment}~${suffix}`;
      suffix += 1;
    }
    usedPaths.add(candidate);
    return candidate;
  };

  const currentParent = () => stack[stack.length - 1];

  const emit = (kind, title, content, depth, parentPath) => {
    const cleanContent = normalizeText(content);
    if (!cleanContent) return null;
    const segment = slugSegment(title || cleanContent, `${kind}-${ordinal + 1}`);
    const path = uniquePath(parentPath, segment);
    const node = {
      ordinal,
      kind,
      path,
      parentPath,
      depth,
      title: (title || deriveTitle(cleanContent)).slice(0, 120),
      content: cleanContent,
      segment,
      hash: shortHash(`${kind}\u0000${cleanContent}`),
    };
    ordinal += 1;
    nodes.push(node);
    return node;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const body = paragraph.join('\n').trim();
    paragraph = [];
    if (!body) return;
    // Split oversized paragraphs on sentence boundaries so one node stays
    // embeddable and citable, instead of producing one giant vector.
    for (const piece of splitLongParagraph(body, 900)) {
      const parent = currentParent();
      emit('paragraph', deriveTitle(piece), piece, parent.depth + 1, parent.path);
    }
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const md = MD_HEADING.exec(line.trim());
    const num = md ? null : NUM_HEADING.exec(line);
    const cjk = md || num ? null : CJK_HEADING.exec(line);
    const bullet = md || num || cjk ? null : BULLET.exec(line.trim());

    if (md || num || cjk) {
      flushParagraph();
      const depth = md ? md[1].length : num ? 2 : 1;
      const headingText = (md ? md[2] : num ? num[2] : cjk[2]).trim();
      while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = currentParent();
      const node = emit('section', headingText, headingText, depth, parent.path);
      if (node) stack.push({ depth, path: node.path, segment: node.segment });
      continue;
    }

    if (bullet) {
      flushParagraph();
      const parent = currentParent();
      const item = bullet[2].trim();
      emit('point', deriveTitle(item), item, parent.depth + 1, parent.path);
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();

  // Give sections a body for embedding: their heading plus the direct
  // paragraph children, so a heading node is retrievable by its content. A
  // section whose children are themselves sections degrades to a small table of
  // contents instead of a title-only vector.
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  for (const node of nodes) {
    if (node.kind !== 'section') continue;
    const children = nodes.filter(
      (child) => child.parentPath === node.path && child.kind === 'paragraph',
    );
    let body = children.map((child) => child.content).join('\n');
    if (!body) {
      const childSections = nodes
        .filter((child) => child.parentPath === node.path && child.kind === 'section')
        .map((child) => child.title);
      body = childSections.join('\n');
    }
    if (!body) continue;
    node.content = normalizeText(`${node.title}\n${body}`).slice(0, 1200);
    node.hash = shortHash(`section\u0000${node.content}`);
  }

  if (nodes.length === 0) {
    emit('paragraph', deriveTitle(text), text || '(empty)', 1, rootPath);
  }

  for (const node of nodes) {
    node.body = node.parentPath ? byPath.get(node.parentPath)?.title ?? '' : '';
  }

  return { root: { title: docTitle, path: rootPath }, nodes };
}

/** Split one long paragraph into <= `max` char pieces at sentence boundaries. */
export function splitLongParagraph(text, max = 900) {
  const body = String(text ?? '').trim();
  if (body.length <= max) return [body];
  const sentences = body.split(/(?<=[。！？!?.;；\n])/).filter((part) => part.trim());
  const out = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > max) {
      out.push(buffer.trim());
      buffer = '';
    }
    buffer += sentence;
    while (buffer.length > max * 1.5) {
      out.push(buffer.slice(0, max).trim());
      buffer = buffer.slice(max);
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/** Render the tree as an indented outline (used by CLI/debug output). */
export function outline(nodes, limit = 40) {
  const byParent = new Map();
  for (const node of nodes) {
    const key = node.parentPath ?? '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  const lines = [];
  const walk = (parentPath, indent) => {
    for (const node of byParent.get(parentPath) ?? []) {
      if (lines.length >= limit) return;
      lines.push(`${'  '.repeat(indent)}- [${node.kind}] ${node.title}`);
      walk(node.path, indent + 1);
    }
  };
  walk(nodes[0]?.parentPath ?? '', 0);
  return lines.join('\n');
}

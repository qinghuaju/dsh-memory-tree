#!/usr/bin/env node
/**
 * Plugin dry-run: mounts the DSH plugin against a stub Cordis-like context and
 * exercises tool registration, session capture, and pre-step recall injection
 * without starting the harness.
 *
 *   node scripts/dryrun-plugin.mjs [--keep]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import memoryPlugin, { Config, apply, inject, name } from '../src/plugin.mjs';

const keep = process.argv.includes('--keep');
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StubContext {
  constructor() {
    this.tools = [];
    this.sections = [];
    this.listeners = new Map();
    this.effects = [];
    this.services = new Map();
    this.logs = [];
    this.logger = {
      debug: (...args) => this.logs.push(['debug', ...args]),
      info: (...args) => this.logs.push(['info', ...args]),
      warn: (...args) => this.logs.push(['warn', ...args]),
      error: (...args) => this.logs.push(['error', ...args]),
    };
    this.tools.register = (tool) => {
      this.tools.push(tool);
      return () => {};
    };
    this.systemPrompt = {
      section: (section) => {
        this.sections.push(section);
        return () => {};
      },
    };
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return () => {};
  }

  effect(body) {
    this.effects.push(body);
    return () => {};
  }

  get(service) {
    return this.services.get(service);
  }

  emit(event, ...args) {
    return (this.listeners.get(event) ?? []).map((handler) => handler(...args));
  }

  async runWaterfall(event, payload) {
    const handlers = this.listeners.get(event) ?? [];
    const base = async () => ({
      kind: 'enter',
      messages: Array.isArray(payload.messages) ? [...payload.messages] : [],
    });
    let index = 0;
    const next = async () => {
      if (index >= handlers.length) return base();
      const handler = handlers[index];
      index += 1;
      return handler(payload, next);
    };
    return next();
  }

  async dispose() {
    for (const body of [...this.effects].reverse()) {
      const disposer = body();
      if (typeof disposer === 'function') await disposer();
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-tree-dryrun-'));
const ctx = new StubContext();

const config = Config({
  dataDir: join(dir, 'data'),
  logging: { level: 'warn' },
  embedding: { fake: true, dimensions: 256 },
  capture: { flushIdleMs: 50, minChars: 4 },
  recall: { autoInject: true, timeoutMs: 5000, maxNodes: 4 },
  mirror: { enabled: true },
});

try {
  console.log('Plugin surface');
  check('exports a name', name === 'dsh-memory-tree');
  check('declares injected services', inject.includes('tools') && inject.includes('systemPrompt'));
  check('default export matches named exports', memoryPlugin.apply === apply);
  check('config schema accepts partial input', config.embedding.fake === true && config.recall.autoInject === true);

  console.log('\nMount');
  apply(ctx, config);
  await sleep(20);
  check('registers tools', ctx.tools.length >= 3, `tools=${ctx.tools.map((tool) => tool.name).join(',')}`);
  check(
    'expects mem_recall/mem_store/mem_stats',
    ['mem_recall', 'mem_store', 'mem_stats'].every((toolName) =>
      ctx.tools.some((tool) => tool.name === toolName),
    ),
    ctx.tools.map((tool) => tool.name).join(','),
  );
  check('registers a system prompt section', ctx.sections.some((section) => section.name === 'tool:memory-tree'));
  check('attaches session/event listener', (ctx.listeners.get('session/event') ?? []).length === 1);
  check('attaches agent/pre-step listener', (ctx.listeners.get('agent/pre-step') ?? []).length === 1);

  console.log('\nTool execution');
  const store = ctx.tools.find((tool) => tool.name === 'mem_store');
  const recallTool = ctx.tools.find((tool) => tool.name === 'mem_recall');
  const statsTool = ctx.tools.find((tool) => tool.name === 'mem_stats');
  const exec = { agent: { session: { id: 'dryrun-session', header: { cwd: process.cwd() } } } };

  const stored = await store.execute(
    {
      content:
        '# 光遗传学与生物显示\n\n## 艺术应用\n用感光绿藻构建无需电驱动的生物显示装置，属于慢交互生物艺术。\n\n## 工程约束\n响应速度是秒级，只适合慢交互，不适合视频。',
      title: '光遗传学与生物显示',
      scope: 'project',
    },
    exec,
  );
  check('mem_store writes nodes', stored.stored === true && stored.nodeCount > 0, JSON.stringify(stored));

  const recalled = await recallTool.execute({ query: '不需要电的生物显示装置怎么做', limit: 3 }, exec);
  check('mem_recall finds the note', recalled.count > 0, JSON.stringify(recalled.nodes));
  check('mem_recall returns a framed context', recalled.context.startsWith('<memory-recall'), recalled.context.slice(0, 40));

  const stats = await statsTool.execute({}, exec);
  check('mem_stats reports nodes', stats.nodes > 0, JSON.stringify(stats));

  console.log('\nSession capture');
  const workspace = { id: 'dryrun-session', header: { cwd: process.cwd() } };
  const userText = '我昨天讨论过用感光绿藻做无电显示装置，你觉得可以怎么落地？';
  const assistantText = '可以先把绿藻培养成像素阵列，再用光照序列驱动它缓慢显示图案，属于慢交互生物艺术装置。';
  // Mirror real DSH payload shapes: user/message data IS the message, while
  // assistant/message data wraps it as { turn, step, message, usage, stream }.
  ctx.emit('session/event', workspace, {
    type: 'user/message',
    time: new Date().toISOString(),
    data: createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }),
  });
  ctx.emit('session/event', workspace, {
    type: 'assistant/message',
    time: new Date().toISOString(),
    data: {
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 20 },
      stream: false,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        source: { kind: 'model', provider: 'stub', model: 'stub' },
      },
    },
  });
  await sleep(400);
  const statsAfterCapture = await statsTool.execute({}, exec);
  check('capture persisted as a document', statsAfterCapture.documents >= 2, JSON.stringify(statsAfterCapture));
  const assistantRecall = await recallTool.execute({ query: '绿藻 像素阵列 光照序列', limit: 3 }, exec);
  check(
    'assistant reply is captured and retrievable',
    assistantRecall.count > 0 && assistantRecall.context.includes('像素'),
    assistantRecall.context.slice(0, 120),
  );

  console.log('\nPre-step auto-recall');
  const query = createUserMessage({
    content: [{ type: 'text', text: '上次我们说的绿藻显示装置，现在要继续做原型' }],
    source: { kind: 'user' },
  });
  const decision = await ctx.runWaterfall('agent/pre-step', {
    agent: exec.agent,
    messages: [query],
    turn: 7,
    step: 1,
    signal: AbortSignal.timeout(10_000),
  });
  check('injects one extra message', decision.messages.length === 2, `len=${decision.messages.length}`);
  const injected = decision.messages.at(-1);
  check('injected message is a recall', injected?.source?.kind === 'plugin' && injected?.source?.form === 'recall');
  check(
    'injected text is a memory block',
    injected?.content?.[0]?.text?.startsWith('<memory-recall'),
    injected?.content?.[0]?.text?.slice(0, 40),
  );

  const again = await ctx.runWaterfall('agent/pre-step', {
    agent: exec.agent,
    messages: [query],
    turn: 7,
    step: 2,
    signal: AbortSignal.timeout(10_000),
  });
  check('does not re-inject in later steps', again.messages.length === 1);

  console.log('\nCross-session recall');
  const otherSession = { id: 'second-session', header: { cwd: process.cwd() } };
  const newTask = createUserMessage({
    content: [{ type: 'text', text: '绿藻像素阵列那个想法，帮我想想第一步先做什么实验' }],
    source: { kind: 'user' },
  });
  const crossSession = await ctx.runWaterfall('agent/pre-step', {
    agent: { session: otherSession },
    messages: [newTask],
    turn: 1,
    step: 1,
    signal: AbortSignal.timeout(10_000),
  });
  const crossText = crossSession.messages.at(-1)?.content?.[0]?.text ?? '';
  check('second session receives recall', crossSession.messages.length === 2, `len=${crossSession.messages.length}`);
  check(
    'recalled content comes from the captured earlier exchange',
    crossText.includes('绿藻') || crossText.includes('像素'),
    crossText.slice(0, 120),
  );

  console.log('\nCapture hygiene');
  const beforeSkip = (await statsTool.execute({}, exec)).documents;
  ctx.emit('session/event', workspace, {
    type: 'user/message',
    time: new Date().toISOString(),
    data: createUserMessage({
      content: [{ type: 'text', text: '这是插件自己注入的召回块，不应该被再次捕获'.repeat(3) }],
      source: { kind: 'plugin', plugin: 'dsh-memory-tree', form: 'recall' },
    }),
  });
  // Harness-injected context uses custom source kinds (the real DSH time-context
  // plugin uses `kind: 'time-context'`), which must never be remembered as a
  // user message.
  ctx.emit('session/event', workspace, {
    type: 'user/message',
    time: new Date().toISOString(),
    data: createUserMessage({
      content: [{ type: 'text', text: 'Time sampled while preparing turn 9, step 1: 2026-10-26T21:00:00+08:00' }],
      source: { kind: 'time-context', form: 'snapshot', sections: [] },
    }),
  });
  await sleep(300);
  const afterSkip = (await statsTool.execute({}, exec)).documents;
  check('plugin-sourced messages are not captured', afterSkip === beforeSkip, `${beforeSkip} -> ${afterSkip}`);
  check('harness context (time-context) is not captured', afterSkip === beforeSkip, `documents=${afterSkip}`);

  // A genuine short Chinese message above the 8-char threshold must be captured.
  const beforeUser = afterSkip;
  ctx.emit('session/event', workspace, {
    type: 'user/message',
    time: new Date().toISOString(),
    data: createUserMessage({
      content: [{ type: 'text', text: '把绿藻显示装置的原型计划记一下，下周继续' }],
      source: { kind: 'user' },
    }),
  });
  await sleep(300);
  const afterUser = (await statsTool.execute({}, exec)).documents;
  check('genuine user message is captured', afterUser === beforeUser + 1, `${beforeUser} -> ${afterUser}`);

  console.log('\nDisposal');
  await ctx.dispose();
  check('disposes without throwing', true);
  check('logged no errors', !ctx.logs.some(([level]) => level === 'error'), JSON.stringify(ctx.logs.filter(([level]) => level === 'error')));
} finally {
  if (keep) console.log(`\nkept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

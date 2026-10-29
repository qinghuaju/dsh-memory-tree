/**
 * Model-facing tool definitions. Each tool is a thin adapter over the engine;
 * schemas are declared with DSH's author-facing value schema so the registry
 * validates arguments and output before the model sees them.
 *
 * @module dsh-memory-tree/dsh/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** Human-readable byte size for tool output. */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Session context helper: cwd and session id for one tool execution. */
export function contextOf(exec, fallbackCwd = process.cwd()) {
  const session = exec?.agent?.session;
  const cwd = session?.header?.cwd ?? fallbackCwd;
  const sessionId = session?.id ?? exec?.agent?.id ?? null;
  return { cwd, sessionId };
}

/**
 * @param {{ engine: object, config: object, logger: object, cwd?: string }} deps
 */
export function createMemoryTools({ engine, config, logger, cwd: fallbackCwd = process.cwd() }) {
  const tools = [];

  tools.push(
    defineTool({
      name: 'mem_recall',
      description:
        'Search the local long-term memory tree (project memory plus shared global notes) for notes, decisions and past discussions relevant to a query. Use this before asking the user to repeat older context, before re-deriving a decision made in an earlier session, or when the current task may connect to earlier material. Returns ranked nodes with their AST path, date and a ready-to-read context block.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Natural-language description of what you are trying to recall (Chinese or English).',
        },
        limit: { type: 'number', description: 'Maximum nodes to return (1-20, default from config).' },
        scope: {
          type: 'string',
          description: "Which spaces to search: 'project', 'global', or 'project+global' (default).",
          enum: ['project', 'global', 'project+global'],
        },
        path: { type: 'string', description: 'Optional AST path substring filter, e.g. "光遗传学/艺术应用".' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            count: { type: 'number', required: true },
            context: { type: 'string', required: true },
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'number' },
                  path: { type: 'string' },
                  title: { type: 'string' },
                  createdAt: { type: 'string' },
                  score: { type: 'number' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.context }],
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const { cwd, sessionId } = contextOf(exec, fallbackCwd);
        const result = await engine.recall({
          query: String(args.query ?? ''),
          cwd,
          scope: args.scope ? String(args.scope) : undefined,
          limit: args.limit ? Number(args.limit) : undefined,
          pathPrefix: args.path ? String(args.path) : undefined,
          sessionId,
        });
        return {
          query: result.query,
          count: result.results.length,
          context: result.block || result.text || '未在长期记忆中找到相关内容。',
          nodes: result.results.map((node) => ({
            id: node.nodeId,
            path: node.path,
            title: node.title,
            createdAt: node.createdAt,
            score: node.score,
          })),
        };
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: '检索长期记忆',
        kind: 'read',
        rawInput: { query: String(args.query ?? '').slice(0, 60) },
      }),
    }),
  );

  if (config.tools.allowStore) {
    tools.push(
      defineTool({
        name: 'mem_store',
        description:
          'Persist a durable note into the local long-term memory tree so later sessions can recall it. Use for decisions, user preferences, project facts, or a summary of an investigation the user will want again. Pass scope="global" for knowledge that should follow the user across every project. Do not store secrets, credentials, or transient small talk.',
        parameters: {
          content: {
            type: 'string',
            required: true,
            description: 'Markdown text to remember. Headings become tree sections, so structure helps retrieval.',
          },
          title: { type: 'string', description: 'Short title (defaults to the first heading or sentence).' },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description: "Default 'project' (this working directory); 'global' is shared across all projects.",
          },
          importance: { type: 'number', description: '0-1 relevance prior (default 0.55).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              stored: { type: 'boolean', required: true },
              deduped: { type: 'boolean' },
              documentId: { type: 'number' },
              nodeCount: { type: 'number' },
              space: { type: 'string' },
              note: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.note ?? (value.stored ? '已写入长期记忆。' : '未写入。') }],
        },
        timeoutMs: 120_000,
        async execute(args, exec) {
          const { cwd, sessionId } = contextOf(exec, fallbackCwd);
          const stored = await engine.remember({
            text: String(args.content ?? ''),
            title: args.title ? String(args.title) : undefined,
            cwd,
            scope: args.scope === 'global' ? 'global' : 'project',
            source: 'tool',
            sessionId,
            importance: args.importance === undefined ? 0.6 : Number(args.importance),
          });
          return {
            stored: true,
            deduped: Boolean(stored.deduped),
            documentId: stored.documentId,
            nodeCount: stored.nodeCount,
            space: stored.space?.key,
            note: stored.deduped
              ? `内容已存在（文档 #${stored.documentId}），未重复写入。`
              : `已写入 ${stored.nodeCount} 个记忆节点到 ${stored.space?.key}。`,
          };
        },
        presentCall: () => ({ card: 'generic', title: '写入长期记忆', kind: 'other' }),
      }),
    );
  }

  tools.push(
    defineTool({
      name: 'mem_stats',
      description:
        'Report the local memory tree status: database path, embedding model, per-space document/node counts and the number of documents still waiting to be embedded. Use it when memory seems empty or stale.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dbPath: { type: 'string', required: true },
            model: { type: 'string' },
            documents: { type: 'number' },
            nodes: { type: 'number' },
            pending: { type: 'number' },
            sizeBytes: { type: 'number' },
            tiers: { type: 'string' },
            spaces: { type: 'string' },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      timeoutMs: 15_000,
      async execute() {
        const stats = await engine.stats(undefined);
        const totals = stats.totals ?? { documents: 0, nodes: 0, pending: 0, sizeBytes: 0 };
        const tierLines = (stats.tiers ?? [])
          .map(
            (tier) =>
              `${tier.tier}: docs=${tier.documents} nodes=${tier.nodes} vectors=${tier.vectors} ` +
              `size=${formatBytes(tier.sizeBytes)} (${tier.dbPath})`,
          )
          .join('\n');
        const spaceLines = (stats.spaces ?? [])
          .map((space) => `${space.tier}/${space.key} · docs=${space.documents} nodes=${space.nodes}`)
          .join('\n');
        return {
          dbPath: stats.dbPath,
          model: String(stats.embedding?.model ?? 'unknown'),
          documents: totals.documents,
          nodes: totals.nodes,
          pending: totals.pending,
          sizeBytes: totals.sizeBytes,
          tiers: tierLines,
          spaces: spaceLines,
          summary: [
            `数据库(热层): ${stats.dbPath}`,
            `嵌入模型: ${stats.embedding?.model ?? 'unknown'} (${stats.embedding?.dimensions ?? '?'} 维)`,
            `合计 文档 ${totals.documents} · 节点 ${totals.nodes} · 待嵌入 ${totals.pending} · 占用 ${formatBytes(totals.sizeBytes)}`,
            tierLines ? `分层:\n${tierLines}` : '分层: （未启用或为空）',
            spaceLines ? `空间:\n${spaceLines}` : '空间: （空）',
          ].join('\n'),
        };
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: '记忆库状态', kind: 'read' }),
    }),
  );

  if (config.tools.allowRotate) {
    tools.push(
      defineTool({
        name: 'mem_rotate',
        description:
          'Rotate aged memories between storage tiers (hot → warm → cold) to keep the active SQLite file small. Whole documents move with their nodes and embeddings; nothing is deleted. Safe to run manually; the plugin also rotates on a timer.',
        parameters: {
          limitPerHop: { type: 'number', description: 'Maximum documents moved per hop (default from config).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean', required: true },
              movedDocuments: { type: 'number', required: true },
              movedNodes: { type: 'number' },
              detail: { type: 'string', required: true },
              lastRotation: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.detail }],
        },
        timeoutMs: 300_000,
        async execute(args) {
          const result = await engine.rotate({
            reason: 'tool',
            limitPerHop: args.limitPerHop ? Number(args.limitPerHop) : undefined,
          });
          const movedDocuments = result.moved.reduce((sum, hop) => sum + (hop.documents ?? 0), 0);
          const movedNodes = result.moved.reduce((sum, hop) => sum + (hop.nodes ?? 0), 0);
          const detail = !result.enabled
            ? '分层存储未启用（storage.tiered=false）。'
            : result.moved.length === 0
              ? '没有需要迁移的记忆（全部还在热层保留期内）。'
              : result.moved
                  .map((hop) => `${hop.from} → ${hop.to}: ${hop.documents} 个文档 / ${hop.nodes} 个节点`)
                  .join('；');
          return {
            enabled: Boolean(result.enabled),
            movedDocuments,
            movedNodes,
            detail: `分层迁移完成：${detail}`,
            lastRotation: result.lastRotation ?? undefined,
          };
        },
        presentCall: () => ({ card: 'generic', title: '整理记忆分层', kind: 'other' }),
      }),
    );
  }

  if (config.tools.allowDream) {
    tools.push(
      defineTool({
        name: 'mem_dream',
        description:
          'Consolidate the memory tree: remove exact duplicate nodes and rebuild the soft similarity edges used for cross-topic recall. Safe to run occasionally (for example after a long research session); it never deletes documents or source text.',
        parameters: {
          scope: {
            type: 'string',
            enum: ['project', 'global', 'project+global'],
            description: 'Spaces to consolidate (default project+global).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              removedNodes: { type: 'number', required: true },
              edges: { type: 'number', required: true },
              spaces: { type: 'array', items: { type: 'string' } },
              note: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.note }],
        },
        timeoutMs: 300_000,
        async execute(args, exec) {
          const { cwd } = contextOf(exec, fallbackCwd);
          const result = await engine.dream({ cwd, scope: args.scope ? String(args.scope) : undefined });
          return {
            removedNodes: result.removedNodes,
            edges: result.edges,
            spaces: result.spaces,
            note: `整理完成：移除重复节点 ${result.removedNodes} 个，重建相似边 ${result.edges} 条（空间：${result.spaces.join(', ') || '无'}）。`,
          };
        },
        presentCall: () => ({ card: 'generic', title: '整理记忆库', kind: 'other' }),
      }),
    );
  }

  if (config.tools.enabled === false) return [];
  return tools;
}

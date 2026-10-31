import fs from 'node:fs';
import path from 'node:path';
import { createMemoryEngine } from '../src/engine/engine.mjs';

const SNAP = 'D:/dshMemo/eval/snapB';
const OUT = 'D:/dshMemo/eval/blocks2';
fs.mkdirSync(OUT, { recursive: true });

const TASKS = [
  [161, '我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？'],
  [80, 'AI 生成的视频前后不一致，用本地模型怎么稳住？'],
  [57, '90-90 法则讲的是什么，怎么用在项目收尾？'],
  [108, 'ComfyUI 换一台机器，怎么快速迁移部署？'],
  [352, '想做定制设计工作室，选哪个城市、用什么模型能跑通？'],
  [286, '我是前端出身，想给 AI 做一套知识引擎和记忆插件，架构该怎么搭？'],
];

const logger = { debug() {}, info() {}, warn() {}, error: console.error };
const engine = createMemoryEngine(
  {
    dataDir: SNAP,
    embedding: { preset: 'dashscope', model: 'qwen3.7-text-embedding', dimensions: 1024, sendDimensions: true },
    storage: { rotateOnOpen: false },
    recall: { scope: 'global', maxNodes: 6, conclusionBias: { enabled: true, slots: 1 } },
  },
  { logger },
);

for (const [docId, query] of TASKS) {
  const res = await engine.recall({ query, limit: 6, cwd: 'D:/dshMemo', scope: 'global' });
  const ids = res.results.map((r) => r.nodeId);
  const docs = [...new Set(res.results.map((r) => r.docId))];
  fs.writeFileSync(path.join(OUT, `${docId}.txt`), `QUERY: ${query}\n\n=== 记忆块 ===\n${res.block}\n`, 'utf8');
  console.log(`doc ${docId}: nodes=${ids.length} docs=${docs.join('/')} chars=${res.block.length}`);
}
engine.close();

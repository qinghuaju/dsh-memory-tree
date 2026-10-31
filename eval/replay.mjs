import fs from 'node:fs';
import path from 'node:path';
import { createMemoryEngine } from '../src/engine/engine.mjs';

const BASE = 'D:/dshMemo/eval/snapshot/memory.db';
const TESTS = [
  '我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？',
  '孩子文化课是强项、美术也还行，走艺考该怎么规划？',
  '想做定制设计工作室，选哪个城市、用什么模型能跑通？',
  '我是前端出身，想给 AI 做一套知识引擎和记忆插件，架构该怎么搭？',
  '带类型化世界观的幻想故事，媒介和创作方向会怎么演进？',
  'AI 生成的视频前后不一致，用本地模型怎么稳住？',
  '明朝大航海如果不走官方路线，民间能怎么参与？',
  'B站视频被第三方 AI 账号搬运评论，这是什么现象？',
  '人脑的真实结构到底是怎样的？',
  '定格动画工具的教学研究，思路该怎么设计？',
  '这两年这轮技术变革和上一轮有什么异同，机会在哪？',
  '现在的技术能做到自复制制造了吗？',
  'AI Agent 的终端形态会从桌面走到眼镜吗？',
  '90-90 法则讲的是什么，怎么用在项目收尾？',
  '华强北的 AI 眼镜反向拆解之后，能做什么应用？',
  '帮我生成一首短歌行风格的音乐提示词。',
  'DSH 里多模型协作、自动切换该怎么配置？',
  'DSH 记忆插件崩溃了，是什么原因、怎么修？',
  'ComfyUI 换一台机器，怎么快速迁移部署？',
  '6GB 显卡能跑哪些生图和生视频工作流？',
];

const logger = { debug() {}, info() {}, warn() {}, error: console.error };

function engineFor(dir, biasEnabled) {
  return createMemoryEngine(
    {
      dataDir: dir,
      embedding: { preset: 'dashscope', model: 'qwen3.7-text-embedding', dimensions: 1024, sendDimensions: true },
      storage: { rotateOnOpen: false },
      recall: { scope: 'project+global', conclusionBias: { enabled: biasEnabled, slots: 1 } },
    },
    { logger },
  );
}

for (const [dir, name] of [['D:/dshMemo/eval/snapA', 'A'], ['D:/dshMemo/eval/snapB', 'B']]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(BASE, path.join(dir, 'memory.db'));
}

const off = engineFor('D:/dshMemo/eval/snapA', false);
const on = engineFor('D:/dshMemo/eval/snapB', true);

const out = [];
for (const limit of [6, 10]) {
  const rows = { off: [], on: [] };
  for (const query of TESTS) {
    for (const [key, engine] of [['off', off], ['on', on]]) {
      const res = await engine.recall({ query, limit, cwd: 'D:/dshMemo', scope: 'project+global' });
      const docs = {};
      for (const r of res.results) docs[r.docId] = (docs[r.docId] ?? 0) + 1;
      const mainDoc = Number(Object.entries(docs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1);
      rows[key].push({ query, mainDoc, ids: res.results.map((r) => r.nodeId), chars: res.block.length, docs: Object.keys(docs).length });
    }
  }
  const changed = rows.on.filter((r, i) => r.ids.join() !== rows.off[i].ids.join()).length;
  const avg = (k, f) => (rows[k].reduce((s, r) => s + f(r), 0) / rows[k].length);
  console.log(`\n=== limit=${limit} ===`);
  for (const k of ['off', 'on']) {
    console.log(`${k}: 节点 ${avg(k, (r) => r.ids.length).toFixed(1)} | 文档数 ${avg(k, (r) => r.docs).toFixed(2)} | 字符 ${Math.round(avg(k, (r) => r.chars))}`);
  }
  console.log(`changed: ${changed}/20`);
  out.push({ limit, ...rows });
}

fs.writeFileSync('D:/dshMemo/eval/replay.json', JSON.stringify(out, null, 1));
off.close(); on.close();
console.log('\nok -> eval/replay.json');

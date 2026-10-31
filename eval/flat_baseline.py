"""Flat dense-retrieval baseline at equal budget.

The paper claims the bias is not an artifact of document-level aggregation.
This script tests that: it ranks *individual nodes* across every tier by cosine
similarity to the query, takes the top-k, and computes the same position
statistics. No document grouping, no AST expansion, no lexical channel, no prior.
"""
import hashlib
import json
import sqlite3
import statistics as st
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8")

TIERS = {
    "hot": r"C:\Users\admin\.dsh\memory-tree\memory.db",
    "warm": r"C:\Users\admin\.dsh\memory-tree\memory-warm.db",
    "cold": r"C:\Users\admin\.dsh\memory-tree\memory-cold.db",
}
MODEL, DIM = "qwen3.7-text-embedding", 1024

TESTS = [
    ("我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？", 161),
    ("孩子文化课是强项、美术也还行，走艺考该怎么规划？", 400),
    ("想做定制设计工作室，选哪个城市、用什么模型能跑通？", 352),
    ("我是前端出身，想给 AI 做一套知识引擎和记忆插件，架构该怎么搭？", 286),
    ("带类型化世界观的幻想故事，媒介和创作方向会怎么演进？", 477),
    ("AI 生成的视频前后不一致，用本地模型怎么稳住？", 80),
    ("明朝大航海如果不走官方路线，民间能怎么参与？", 404),
    ("B站视频被第三方 AI 账号搬运评论，这是什么现象？", 206),
    ("人脑的真实结构到底是怎样的？", 341),
    ("定格动画工具的教学研究，思路该怎么设计？", 355),
    ("这两年这轮技术变革和上一轮有什么异同，机会在哪？", 236),
    ("现在的技术能做到自复制制造了吗？", 454),
    ("AI Agent 的终端形态会从桌面走到眼镜吗？", 63),
    ("90-90 法则讲的是什么，怎么用在项目收尾？", 57),
    ("华强北的 AI 眼镜反向拆解之后，能做什么应用？", 523),
    ("帮我生成一首短歌行风格的音乐提示词。", 460),
    ("DSH 里多模型协作、自动切换该怎么配置？", 117),
    ("DSH 记忆插件崩溃了，是什么原因、怎么修？", 115),
    ("ComfyUI 换一台机器，怎么快速迁移部署？", 108),
    ("6GB 显卡能跑哪些生图和生视频工作流？", 53),
]

node_ids, node_docs, mat = [], [], []
ranges = {}
query_vecs = {}

for tier, path in TIERS.items():
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    for r in con.execute("select doc_id, min(id) lo, max(id) hi from nodes group by doc_id"):
        ranges[(tier, r["doc_id"])] = (r["lo"], r["hi"])
    rows = con.execute(
        "select n.id, n.doc_id, v.vec, v.norm from nodes n join vectors v on v.node_id=n.id "
        "where n.archived=0"
    ).fetchall()
    for r in rows:
        v = np.frombuffer(r["vec"], dtype=np.float32, count=DIM)
        nrm = float(r["norm"]) or 1.0
        mat.append(v / nrm)
        node_ids.append((tier, r["id"]))
        node_docs.append((tier, r["doc_id"]))
    con.close()

M = np.vstack(mat)
print(f"载入 {M.shape[0]} 个节点向量，维度 {M.shape[1]}")

con = sqlite3.connect(f"file:{TIERS['hot']}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
for q, _ in TESTS:
    key = hashlib.sha256(f"{MODEL}|{DIM}|{q}".encode()).hexdigest()
    row = con.execute("select vec from embed_cache where key=?", (key,)).fetchone()
    if row:
        v = np.frombuffer(row["vec"], dtype=np.float32, count=DIM)
        query_vecs[q] = v / (np.linalg.norm(v) or 1.0)
con.close()
print(f"查询向量命中 {len(query_vecs)}/20（未命中的查询会被跳过）")


def evaluate(k):
    doc_hits = top1 = concl = 0
    pcts = []
    used = 0
    for q, target in TESTS:
        qv = query_vecs.get(q)
        if qv is None:
            continue
        used += 1
        sims = M @ qv
        idx = np.argpartition(-sims, k)[:k]
        idx = idx[np.argsort(-sims[idx])]
        picks = [node_docs[i] for i in idx]

        if any(d == target for _, d in picks):
            doc_hits += 1
        if picks[0][1] == target:
            top1 += 1

        lo, hi = ranges.get(picks[0][:1] + (target,) if False else ("hot", target), (0, 0))
        span = max(1, hi - lo)
        hit_concl = False
        for tier, doc in picks:
            if doc != target:
                continue
            nid = node_ids[idx[picks.index((tier, doc))]][1]
            frac = (nid - lo) / span
            pcts.append(frac)
            if frac >= 0.7:
                hit_concl = True
        if hit_concl:
            concl += 1
    return used, doc_hits, top1, concl, pcts


print(f"\n{'预算':>4} {'文档级':>7} {'Top1':>6} {'结论级':>7} {'平均位置分位':>12}")
for k in (6, 10):
    used, d, t, c, p = evaluate(k)
    print(f"{k:>4} {d/used:>6.0%} {t/used:>6.0%} {c/used:>6.0%} {st.mean(p) if p else 0:>12.2f}")

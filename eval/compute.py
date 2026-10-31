import sqlite3, json, statistics as st, sys

sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

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

def norm(s):
    return "".join(s.split())

def parse_ids(raw):
    if not raw:
        return []
    try:
        v = json.loads(raw)
        if isinstance(v, list):
            return [int(x) for x in v]
    except Exception:
        pass
    return [int(x) for x in str(raw).strip("[] ").split(",") if x.strip().isdigit()]

rows = con.execute(
    "select id, query, node_ids, scores, created_at from recalls order by created_at desc"
).fetchall()

by_q = {}
for r in rows:
    by_q.setdefault(norm(r["query"]), []).append(r)

print(f"recalls 总行数 {len(rows)}；匹配到测试查询 {sum(1 for q,_ in TESTS if norm(q) in by_q)}/20\n")

OVERHEAD = 96  # 前言约 96 字符
res = []
for q, target in TESTS:
    hit = by_q.get(norm(q))
    if not hit:
        res.append({"q": q, "target": target, "found": False})
        continue
    r = hit[0]
    ids = parse_ids(r["node_ids"])
    nodes = con.execute(
        f"select id, doc_id, path, title, length(content) clen, ordinal, depth, "
        f"(select max(ordinal) from nodes where doc_id=doc_id) maxord "
        f"from nodes where id in ({','.join('?'*len(ids))})", ids
    ).fetchall() if ids else []
    nmap = {n["id"]: n for n in nodes}
    ordered = [nmap[i] for i in ids if i in nmap]

    same = [n for n in ordered if n["doc_id"] == target]
    concl = [n for n in ordered if n["doc_id"] == target and n["ordinal"] >= 0.7 * n["maxord"]]
    others = {n["doc_id"] for n in ordered} - {target}

    chars = OVERHEAD + sum(len(f'[{i+1}] 0000-00-00 · {n["path"]}\n') + n["clen"] + 2
                           for i, n in enumerate(ordered))
    res.append({
        "q": q, "target": target, "found": True, "n": len(ordered),
        "same_doc": len(same), "conclusion_hit": len(concl) > 0,
        "top1": bool(ordered and ordered[0]["doc_id"] == target),
        "other_docs": len(others), "chars": chars,
        "rank1_path": ordered[0]["path"][:40] if ordered else "",
    })

ok = [r for r in res if r.get("found")]
doc_hit = sum(1 for r in ok if r["same_doc"] > 0) / len(ok)
concl_hit = sum(1 for r in ok if r["conclusion_hit"]) / len(ok)
top1 = sum(1 for r in ok if r["top1"]) / len(ok)
avg_same = st.mean(r["same_doc"] for r in ok)
avg_other = st.mean(r["other_docs"] for r in ok)

print(f"{'#':>2} 目标  同文  结论  Top1  异文  字符")
for i, r in enumerate(res, 1):
    if not r.get("found"):
        print(f"{i:>2}  --  未找到该查询的检索记录"); continue
    print(f'{i:>2} {r["target"]:>4} {r["same_doc"]:>4} {int(r["conclusion_hit"]):>4} '
          f'{int(r["top1"]):>5} {r["other_docs"]:>4} {r["chars"]:>5}')

chars_sorted = sorted(r["chars"] for r in ok)
print(f"\n=== 命中率 ===")
print(f"文档级命中率 : {doc_hit:.0%}  ({sum(1 for r in ok if r['same_doc']>0)}/{len(ok)})")
print(f"结论级命中率 : {concl_hit:.0%}  ({sum(1 for r in ok if r['conclusion_hit'])}/{len(ok)})")
print(f"Top1 命中率  : {top1:.0%}  ({sum(1 for r in ok if r['top1'])}/{len(ok)})")
print(f"平均同文档节点 {avg_same:.1f}/10，平均跨 {avg_other:.1f} 个其他文档")

print(f"\n=== 注入体积（10 节点/次） ===")
print(f"字符: 中位 {st.median(chars_sorted):.0f}  P10 {chars_sorted[int(.1*len(chars_sorted))]}  P90 {chars_sorted[int(.9*len(chars_sorted))]}  均值 {st.mean(chars_sorted):.0f}")
lo, mid, hi = st.median(chars_sorted) / 2.0, st.median(chars_sorted) / 1.5, st.median(chars_sorted) / 1.2
print(f"估算 token（中位）: {lo:.0f} ~ {mid:.0f} ~ {hi:.0f}  (按 1 token ≈ 1.2/1.5/2.0 字符)")

hist = con.execute(
    "select query, node_ids, created_at from recalls where created_at < '2026-10-29T10:00' order by created_at"
).fetchall()
sizes = []
for r in hist:
    ids = parse_ids(r["node_ids"])
    if not ids:
        continue
    tot = con.execute(
        f"select coalesce(sum(length(content)+length(path)+14),0) from nodes where id in ({','.join('?'*len(ids))})",
        ids).fetchone()[0]
    sizes.append(OVERHEAD + tot)
if sizes:
    sizes.sort()
    print(f"\n历史真实调用 {len(sizes)} 次，注入字符：中位 {st.median(sizes):.0f}，P10 {sizes[int(.1*len(sizes))]:.0f}，P90 {sizes[int(.9*len(sizes))]:.0f}，最大 {sizes[-1]:.0f}")
    print(f"对应 token 中位 ≈ {st.median(sizes)/1.5:.0f}")

with open(r"D:\dshMemo\eval\result.json", "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)


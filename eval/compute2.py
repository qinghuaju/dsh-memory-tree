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

rows = con.execute("select id, query, node_ids, created_at from recalls order by created_at desc").fetchall()
by_q = {}
for r in rows:
    by_q.setdefault(norm(r["query"]), []).append(r)

maxid = {}
for r in con.execute("select doc_id, max(id) m, min(id) n from nodes group by doc_id"):
    maxid[r["doc_id"]] = (r["n"], r["m"])

OVERHEAD = 96
res = []
for q, target in TESTS:
    r = by_q[norm(q)][0]
    ids = parse_ids(r["node_ids"])
    ph = ",".join("?" * len(ids))
    nodes = con.execute(
        f"select id, doc_id, path, title, kind, length(content) clen, content from nodes where id in ({ph})", ids
    ).fetchall()
    nmap = {n["id"]: n for n in nodes}
    ordered = [nmap[i] for i in ids if i in nmap]

    lo, hi = maxid[target]
    cut = lo + 0.7 * (hi - lo)
    same = [n for n in ordered if n["doc_id"] == target]
    concl = [n for n in same if n["id"] >= cut]
    others = {n["doc_id"] for n in ordered} - {target}

    texts = ["".join((n["content"] or "").split()) for n in ordered]
    dup = len(texts) - len(set(texts))
    toc = sum(1 for n in ordered if n["kind"] not in ("leaf", "paragraph", "text") and n["clen"] < 400)

    chars = OVERHEAD + sum(len(f'[{i+1}] 0000-00-00 · {n["path"]}\n') + n["clen"] + 2
                           for i, n in enumerate(ordered))
    res.append({"q": q, "target": target, "n": len(ordered), "same": len(same),
                "concl": len(concl), "top1": bool(ordered[0]["doc_id"] == target),
                "others": len(others), "chars": chars, "dup": dup, "toc": toc})

n = len(res)
print(f"{'#':>2} 目标  同文 结论 Top1 异文 重复 目录 字符")
for i, r in enumerate(res, 1):
    print(f'{i:>2} {r["target"]:>4} {r["same"]:>4} {r["concl"]:>4} {int(r["top1"]):>4} '
          f'{r["others"]:>4} {r["dup"]:>4} {r["toc"]:>4} {r["chars"]:>5}')

ch = sorted(r["chars"] for r in res)
print("\n=== 指标 1：检索命中率（10 节点注入） ===")
print(f"文档级命中率   : {sum(1 for r in res if r['same']>0)/n:.0%}  ({sum(1 for r in res if r['same']>0)}/{n})")
print(f"结论级命中率   : {sum(1 for r in res if r['concl']>0)/n:.0%}  ({sum(1 for r in res if r['concl']>0)}/{n})  <- 召回到该文档后 30% 的结论节点")
print(f"Top1 命中率    : {sum(1 for r in res if r['top1'])/n:.0%}  ({sum(1 for r in res if r['top1'])}/{n})")
print(f"平均同文档节点 : {st.mean(r['same'] for r in res):.1f}/10")
print(f"平均异文档数   : {st.mean(r['others'] for r in res):.1f} 个")

print("\n=== 指标 2：注入 token ===")
print(f"字符 中位 {st.median(ch):.0f}  P10 {ch[int(.1*n)]}  P90 {ch[int(.9*n)]}")
print(f"token 中位估算 {st.median(ch)/1.5:.0f} (1 token≈1.5 字符)，区间 {st.median(ch)/2.0:.0f}~{st.median(ch)/1.2:.0f}")
print(f"重复内容 平均 {st.mean(r['dup'] for r in res):.1f} 个/次；目录型节点 平均 {st.mean(r['toc'] for r in res):.1f} 个/次")

hist = con.execute("select node_ids from recalls where created_at < '2026-10-29T10:00'").fetchall()
sizes = []
for r in hist:
    ids = parse_ids(r["node_ids"])
    if not ids:
        continue
    ph = ",".join("?" * len(ids))
    tot = con.execute(f"select coalesce(sum(length(content)+length(path)+14),0) from nodes where id in ({ph})", ids).fetchone()[0]
    sizes.append(OVERHEAD + tot)
if sizes:
    sizes.sort()
    print(f"\n历史真实调用 {len(sizes)} 次字符：中位 {st.median(sizes):.0f}，P10 {sizes[int(.1*len(sizes))]}，P90 {sizes[int(.9*len(sizes))]}")
    print(f"对应 token 中位 ≈ {st.median(sizes)/1.5:.0f}")

with open(r"D:\dshMemo\eval\result.json", "w", encoding="utf-8") as f:
    json.dump(res, f, ensure_ascii=False, indent=1)

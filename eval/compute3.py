import sqlite3, json, statistics as st, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

def parse_ids(raw):
    try:
        v = json.loads(raw)
        if isinstance(v, list): return [int(x) for x in v]
    except Exception: pass
    return [int(x) for x in str(raw).strip("[] ").split(",") if x.strip().isdigit()]

print("=== nodes.kind 分布（全库） ===")
for r in con.execute("select kind, count(*) c, round(avg(length(content))) a from nodes group by kind order by c desc"):
    print(f"  {r['kind']:<12} {r['c']:>6}  平均 {r['a']:.0f} 字符")

print("\n=== 返回节点的 kind 分布（我这次的 20 次召回） ===")
qs = [r["query"] for r in con.execute("select query from recalls order by created_at desc limit 20")]
allids = []
for q in qs:
    r = con.execute("select node_ids from recalls where query=? order by created_at desc limit 1", (q,)).fetchone()
    allids += parse_ids(r["node_ids"])
ph = ",".join("?"*len(allids))
for r in con.execute(f"select kind, count(*) c from nodes where id in ({ph}) group by kind order by c desc", allids):
    print(f"  {r['kind']:<12} {r['c']:>4}")

print("\n=== 返回节点在所属文档中的位置分位（0=最早, 1=最晚） ===")
meta = {}
for r in con.execute("select doc_id, min(id) lo, max(id) hi from nodes group by doc_id"):
    meta[r["doc_id"]] = (r["lo"], r["hi"])

rows = []
for q in qs:
    r = con.execute("select node_ids from recalls where query=? order by created_at desc limit 1", (q,)).fetchone()
    ids = parse_ids(r["node_ids"])
    ph2 = ",".join("?"*len(ids))
    nodes = con.execute(f"select id, doc_id from nodes where id in ({ph2})", ids).fetchall()
    main = {}
    for n in nodes:
        main[n["doc_id"]] = main.get(n["doc_id"], 0) + 1
    tgt = max(main, key=main.get)
    lo, hi = meta[tgt]
    ps = [(n["id"]-lo)/max(1, hi-lo) for n in nodes if n["doc_id"] == tgt]
    rows.append((tgt, st.mean(ps), max(ps)))

meanp = st.mean(r[1] for r in rows)
print(f"  平均分位 {meanp:.2f}（若均匀分布应≈0.50）")
print(f"  最大分位≥0.5 的文档数：{sum(1 for r in rows if r[2]>=0.5)}/20")
print(f"  最大分位≥0.8 的文档数：{sum(1 for r in rows if r[2]>=0.8)}/20")
for th in (0.5, 0.7, 0.9):
    print(f"  含分位≥{th:.0%} 节点的召回：{sum(1 for r in rows if r[2]>=th)}/20")

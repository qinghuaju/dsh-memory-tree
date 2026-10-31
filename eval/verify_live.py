import sqlite3, json, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

Q = "我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？"
r = con.execute("select id, query, node_ids, created_at from recalls where query=? order by created_at desc limit 1", (Q,)).fetchone()
ids = json.loads(r["node_ids"]) if r["node_ids"].strip().startswith("[") else \
      [int(x) for x in r["node_ids"].strip("[] ").split(",") if x.strip().isdigit()]
print("recall id", r["id"], r["created_at"], "返回", len(ids), "个节点")

rng = {x["doc_id"]: (x["lo"], x["hi"]) for x in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}
print(f"\n{'node':>6} {'doc':>5} {'位置分位':>8}  path")
for i in ids:
    n = con.execute("select id, doc_id, path from nodes where id=?", (i,)).fetchone()
    lo, hi = rng[n["doc_id"]]
    frac = (n["id"] - lo) / max(1, hi - lo)
    print(f'{n["id"]:>6} {n["doc_id"]:>5} {frac:>7.2f}  {n["path"][:78]}')

lo, hi = rng[161]
cut = lo + 0.8 * (hi - lo)
print(f"\n文档 161 范围 {lo}-{hi}，尾部阈值(80%) {cut:.0f}")
print("是否含 161 尾部节点:", any(lo <= i <= hi and i >= cut for i in ids))

print("\n=== 今天(10-29)新增的文档（疑似实验污染）===")
for row in con.execute(
    "select id, title, created_at, (select count(*) from nodes where doc_id=documents.id) c "
    "from documents where created_at >= '2026-10-29' order by id desc limit 25"
):
    print(f'  {row["id"]:>5} {row["created_at"][11:16]} {row["c"]:>4}节点 {str(row["title"])[:52]}')

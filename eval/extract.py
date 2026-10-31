import sqlite3, json, os, sys

sys.stdout.reconfigure(encoding="utf-8")

DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
OUT = r"D:\dshMemo\eval"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

rows = con.execute("""
select d.id as doc_id, d.title, d.created_at, d.space_id, s.key as space_key,
       length(d.text) as chars,
       (select count(*) from nodes n where n.doc_id = d.id) as n_nodes
from documents d left join spaces s on s.id = d.space_id
where length(coalesce(d.text,'')) > 600
order by n_nodes desc
""").fetchall()

print(f"候选文档 {len(rows)} 篇（text>600字符）\n")
print("doc_id | 日期 | 节点 | 字符 | 空间 | 标题")
for r in rows[:40]:
    print(f'{r["doc_id"]} | {str(r["created_at"])[:10]} | {r["n_nodes"]:>4} | {r["chars"]:>6} | {r["space_key"]} | {r["title"][:50]}')

docs = []
for r in rows[:30]:
    nodes = con.execute(
        "select id, ordinal, depth, kind, path, title, length(content) as clen "
        "from nodes where doc_id=? order by ordinal", (r["doc_id"],)
    ).fetchall()
    docs.append({
        "doc_id": r["doc_id"], "title": r["title"], "date": str(r["created_at"])[:10],
        "space": r["space_key"], "n_nodes": r["n_nodes"], "chars": r["chars"],
        "nodes": [dict(n) for n in nodes],
    })

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "candidates.json"), "w", encoding="utf-8") as f:
    json.dump(docs, f, ensure_ascii=False)

print(f"\n已写 {os.path.join(OUT, 'candidates.json')}  ({len(docs)} 篇)")
print("meta:", [(r["key"], r["v"]) for r in con.execute("select key, substr(value,1,50) v from meta")])

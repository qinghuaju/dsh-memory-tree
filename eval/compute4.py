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

qs = [r["query"] for r in con.execute("select query from recalls order by created_at desc limit 20")]
ids = []
for q in qs:
    ids += parse_ids(con.execute("select node_ids from recalls where query=? order by created_at desc limit 1", (q,)).fetchone()["node_ids"])
ph = ",".join("?"*len(ids))
rows = con.execute(f"select id, kind, path, content from nodes where id in ({ph})", ids).fetchall()

toc, sect_chars, toc_chars, total = 0, 0, 0, 0
for r in rows:
    c = r["content"] or ""
    total += len(c)
    if r["kind"] == "section":
        sect_chars += len(c)
        lines = [l.strip() for l in c.split("\n") if l.strip()]
        if len(lines) >= 4 and st.median(len(l) for l in lines) < 45:
            toc += 1
            toc_chars += len(c)

print(f"返回节点 {len(rows)} 个，总正文 {total} 字符")
print(f"section {sum(1 for r in rows if r['kind']=='section')} 个 / {sect_chars} 字符 ({sect_chars/total:.0%})")
print(f"其中“标题清单型”（≥4 行且行长中位<45）{toc} 个 / {toc_chars} 字符 ({toc_chars/total:.0%})")
print(f"若把标题清单型折叠为“标题+首行”，按平均省 75% 计 ≈ 省 {toc_chars*0.75:.0f} 字符/20次 ≈ {toc_chars*0.75/20:.0f} 字符/次")
print(f"相当于每次注入的 {toc_chars*0.75/20/3636:.0%}")

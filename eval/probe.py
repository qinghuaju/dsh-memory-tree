import sqlite3, json, sys

DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
con.row_factory = sqlite3.Row

out = {}
cur = con.execute("select name, type from sqlite_master where type in ('table','view') order by name")
tables = [dict(r) for r in cur]
out["tables"] = tables

for t in tables:
    if t["type"] != "table":
        continue
    name = t["name"]
    try:
        n = con.execute(f'select count(*) from "{name}"').fetchone()[0]
    except Exception as e:
        n = f"ERR {e}"
    cols = [r[1] for r in con.execute(f'pragma table_info("{name}")')]
    out.setdefault("schema", {})[name] = {"rows": n, "cols": cols}

print(json.dumps(out, ensure_ascii=False, indent=1)[:6000])

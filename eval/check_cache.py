import sqlite3, hashlib, json, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

MODEL, DIM = "qwen3.7-text-embedding", 1024
q = "我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？"
key = hashlib.sha256(f"{MODEL}|{DIM}|{q}".encode()).hexdigest()
row = con.execute("select key, model, dim, length(vec) n from embed_cache where key=?", (key,)).fetchone()
print("hash 命中:", dict(row) if row else None)
print("cache 总行:", con.execute("select count(*) from embed_cache").fetchone()[0])
print("样例 key:", con.execute("select key, model, dim, length(vec) from embed_cache limit 3").fetchall()[0][:])
print("vectors 样例:", con.execute("select node_id, model, dim, norm, length(vec) from vectors limit 2").fetchall()[0][:])

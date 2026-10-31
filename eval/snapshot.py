import sqlite3, os, sys
sys.stdout.reconfigure(encoding="utf-8")
SRC = r"C:\Users\admin\.dsh\memory-tree\memory.db"
DST = r"D:\dshMemo\eval\snapshot\memory.db"
os.makedirs(os.path.dirname(DST), exist_ok=True)
for f in ("memory.db", "memory.db-wal", "memory.db-shm"):
    p = os.path.join(os.path.dirname(DST), f)
    if os.path.exists(p):
        os.remove(p)
src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
dst = sqlite3.connect(DST)
with dst:
    src.backup(dst)
print("nodes", dst.execute("select count(*) from nodes").fetchone()[0],
      "cache", dst.execute("select count(*) from embed_cache").fetchone()[0],
      "recalls", dst.execute("select count(*) from recalls").fetchone()[0])
dst.close(); src.close()
print("snapshot ->", DST, os.path.getsize(DST) // 1024 // 1024, "MB")

import sqlite3, os, sys
sys.stdout.reconfigure(encoding="utf-8")
SRC = r"C:\Users\admin\.dsh\memory-tree"
BASE = r"D:\dshMemo\eval\snapshot"
os.makedirs(BASE, exist_ok=True)
for tier in ("memory.db", "memory-warm.db", "memory-cold.db"):
    src_path = os.path.join(SRC, tier)
    if not os.path.exists(src_path):
        continue
    dst_path = os.path.join(BASE, tier)
    for suffix in ("", "-wal", "-shm"):
        p = dst_path + suffix
        if os.path.exists(p):
            os.remove(p)
    src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
    dst = sqlite3.connect(dst_path)
    with dst:
        src.backup(dst)
    print(tier, dst.execute("select count(*) from nodes").fetchone()[0], "nodes",
          os.path.getsize(dst_path)//1024//1024, "MB")
    dst.close(); src.close()

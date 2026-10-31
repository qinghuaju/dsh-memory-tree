import sqlite3, hashlib, json, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"; MODEL, DIM = "qwen3.7-text-embedding", 1024
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

def parse_ids(raw):
    try:
        v = json.loads(raw)
        if isinstance(v, list): return [int(x) for x in v]
    except Exception: pass
    return [int(x) for x in str(raw).strip("[] ").split(",") if x.strip().isdigit()]
V = lambda b: np.frombuffer(b, dtype=np.float32, count=DIM)
N = lambda v: float(np.linalg.norm(v))
def qv(t):
    k = hashlib.sha256(f"{MODEL}|{DIM}|{t}".encode()).hexdigest()
    r = con.execute("select vec from embed_cache where key=?", (k,)).fetchone()
    return V(r["vec"]) if r else None
rng = {r["doc_id"]:(r["lo"],r["hi"]) for r in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}

rows = con.execute("select query, node_ids from recalls order by created_at desc limit 20").fetchall()
for r in rows[:8]:
    q, A = r["query"], parse_ids(r["node_ids"])[:6]
    ns = con.execute(f"select id, doc_id from nodes where id in ({','.join('?'*len(A))})", A).fetchall()
    dm = {n["id"]: n["doc_id"] for n in ns}
    cnt = {}
    for d in dm.values(): cnt[d] = cnt.get(d,0)+1
    doc = max(cnt, key=cnt.get); lo,hi = rng[doc]; cut = lo+0.8*(hi-lo)
    v = qv(q)
    cand = con.execute("select n.id,n.path,n.content,v.vec from nodes n join vectors v on v.node_id=n.id "
                       "where n.doc_id=? and n.id>=? and n.archived=0", (doc,cut)).fetchall()
    best = None
    for c in cand:
        if c["id"] in A: continue
        t = (c["content"] or "").strip()
        if len(t) < 80: continue
        s = float(np.dot(v,V(c["vec"]))/(N(v)*N(V(c["vec"])) or 1))
        if best is None or s > best[0]: best = (s, c)
    print(f"\nQ: {q}")
    if best:
        s, c = best
        print(f"  注入尾部节点 sim={s:.3f}  path={c['path'][:70]}")
        print("  内容:", (c["content"] or "")[:180].replace("\n"," ⏎ "))

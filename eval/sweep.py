import sqlite3, hashlib, json, statistics as st, sys
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")

DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
MODEL, DIM = "qwen3.7-text-embedding", 1024
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

def parse_ids(raw):
    try:
        v = json.loads(raw)
        if isinstance(v, list): return [int(x) for x in v]
    except Exception: pass
    return [int(x) for x in str(raw).strip("[] ").split(",") if x.strip().isdigit()]

def vec_of(blob): return np.frombuffer(blob, dtype=np.float32, count=DIM)
def norm(v): return float(np.linalg.norm(v))
def qvec(text):
    k = hashlib.sha256(f"{MODEL}|{DIM}|{text}".encode()).hexdigest()
    r = con.execute("select vec from embed_cache where key=?", (k,)).fetchone()
    return vec_of(r["vec"]) if r else None

rows = con.execute("select query, node_ids from recalls order by created_at desc limit 20").fetchall()
queries = [(r["query"], parse_ids(r["node_ids"])) for r in rows]
rng = {r["doc_id"]: (r["lo"], r["hi"]) for r in con.execute("select doc_id, min(id) lo, max(id) hi from nodes group by doc_id")}

def tail_cands(doc, qv, exclude, frac):
    lo, hi = rng[doc]; cut = lo + frac*(hi-lo)
    cand = con.execute("select n.id, v.vec from nodes n join vectors v on v.node_id=n.id "
                       "where n.doc_id=? and n.id>=? and n.archived=0", (doc, cut)).fetchall()
    out = []
    for c in cand:
        if c["id"] in exclude: continue
        v = vec_of(c["vec"])
        out.append((float(np.dot(qv, v)/(norm(qv)*norm(v) or 1)), c["id"]))
    out.sort(reverse=True)
    return out

def chars(ids):
    ph = ",".join("?"*len(ids))
    m = {r["id"]: r for r in con.execute(f"select id, path, content from nodes where id in ({ph})", ids)}
    return 96 + sum(len(f'[{i+1}] 0000-00-00 · {m[i]["path"]}\n') + len(m[i]["content"] or "") + 2
                     for i in range(len(ids)) if i in m)

print(f"{'槽位':>4} {'k':>2} {'结论命中':>8} {'同文档':>6} {'字符中位':>8} {'尾部相似度中位':>12}")
summary = []
for slots in (6, 10):
    for k in (0, 1, 2, 3):
        hits, same, chs, sims = 0, [], [], []
        for q, A in queries:
            A = A[:slots]
            if not A: continue
            ns = con.execute(f"select id, doc_id from nodes where id in ({','.join('?'*len(A))})", A).fetchall()
            dm = {n["id"]: n["doc_id"] for n in ns}
            cnt = {}
            for d in dm.values(): cnt[d] = cnt.get(d, 0) + 1
            doc = max(cnt, key=cnt.get)
            qv = qvec(q)
            add = []
            if k and qv is not None:
                add = [i for _, i in tail_cands(doc, qv, set(A), 0.8)[:k]]
                sims += [s for s, i in tail_cands(doc, qv, set(A), 0.8)[:k]]
            B = list(A)
            for tid in add:
                di = None
                for i in range(len(B)-1, -1, -1):
                    if dm.get(B[i], doc) != doc: di = i; break
                if di is None:
                    lo, hi = rng[doc]; cut = lo + 0.7*(hi-lo)
                    for i in range(len(B)-1, -1, -1):
                        if B[i] < cut: di = i; break
                if di is not None: B.pop(di)
                B.append(tid)
            lo, hi = rng[doc]; c70 = lo + 0.7*(hi-lo)
            got = con.execute(f"select id, doc_id from nodes where id in ({','.join('?'*len(B))})", B).fetchall()
            gm = {n["id"]: n["doc_id"] for n in got}
            if any(gm.get(i) == doc and i >= c70 for i in B): hits += 1
            same.append(sum(1 for i in B if gm.get(i) == doc))
            chs.append(chars(B))
        n = len(queries)
        print(f"{slots:>4} {k:>2} {hits/n:>7.0%} {st.mean(same):>6.1f} {st.median(chs):>8.0f} "
              f"{(st.median(sims) if sims else 0):>12.3f}")
        summary.append({"slots": slots, "k": k, "hit": hits/n, "chars": st.median(chs),
                        "sim": st.median(sims) if sims else None})
json.dump(summary, open(r"D:\dshMemo\eval\sweep.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)

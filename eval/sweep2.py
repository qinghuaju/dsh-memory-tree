import sqlite3, hashlib, json, statistics as st, sys, re
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
def nrm(v): return float(np.linalg.norm(v))
def qvec(text):
    k = hashlib.sha256(f"{MODEL}|{DIM}|{text}".encode()).hexdigest()
    r = con.execute("select vec from embed_cache where key=?", (k,)).fetchone()
    return vec_of(r["vec"]) if r else None

def useful(txt):
    t = (txt or "").strip()
    if len(t) < 80: return False
    if re.fullmatch(r"[\s\-—–_=*#>|`~·.。、，,;；:：/\\()（）\[\]【】]+", t): return False
    return True

rows = con.execute("select query, node_ids from recalls order by created_at desc limit 20").fetchall()
queries = [(r["query"], parse_ids(r["node_ids"])) for r in rows]
rng = {r["doc_id"]: (r["lo"], r["hi"]) for r in con.execute("select doc_id, min(id) lo, max(id) hi from nodes group by doc_id")}

def tails(doc, qv, exclude, frac):
    lo, hi = rng[doc]; cut = lo + frac*(hi-lo)
    cand = con.execute("select n.id, n.content, v.vec from nodes n join vectors v on v.node_id=n.id "
                       "where n.doc_id=? and n.id>=? and n.archived=0", (doc, cut)).fetchall()
    out = []
    for c in cand:
        if c["id"] in exclude or not useful(c["content"]): continue
        v = vec_of(c["vec"])
        out.append((float(np.dot(qv, v)/(nrm(qv)*nrm(v) or 1)), c["id"]))
    out.sort(reverse=True)
    return out

def block_chars(ids):
    ph = ",".join("?"*len(ids))
    m = {r["id"]: r for r in con.execute(f"select id, path, content from nodes where id in ({ph})", ids).fetchall()}
    total = 96
    for idx, nid in enumerate(ids, 1):
        n = m.get(nid)
        if n: total += len(f'[{idx}] 0000-00-00 · {n["path"]}\n') + len(n["content"] or "") + 2
    return total

print(f"{'槽位':>4} {'k':>2} {'结论命中':>7} {'同文档':>7} {'字符中位':>8} {'+字符/次':>8} {'尾部相似度':>9}")
res = []
for slots in (6, 10):
    base_chars = None
    for k in (0, 1, 2, 3):
        hits, same, chs, sims = 0, [], [], []
        for q, A in queries:
            A = A[:slots]
            ns = con.execute(f"select id, doc_id from nodes where id in ({','.join('?'*len(A))})", A).fetchall()
            dm = {n["id"]: n["doc_id"] for n in ns}
            cnt = {}
            for d in dm.values(): cnt[d] = cnt.get(d, 0) + 1
            doc = max(cnt, key=cnt.get)
            qv = qvec(q)
            add = []
            if k and qv is not None:
                cands = tails(doc, qv, set(A), 0.8)[:k]
                add = [i for _, i in cands]; sims += [s for s, _ in cands]
            B = list(A)
            for tid in add:
                di = None
                for i in range(len(B)-1, -1, -1):
                    if dm.get(B[i], doc) != doc: di = i; break
                if di is None:
                    cut = rng[doc][0] + 0.7*(rng[doc][1]-rng[doc][0])
                    for i in range(len(B)-1, -1, -1):
                        if B[i] < cut: di = i; break
                if di is not None: B.pop(di)
                B.append(tid)
            cut = rng[doc][0] + 0.7*(rng[doc][1]-rng[doc][0])
            gm = {n["id"]: n["doc_id"] for n in con.execute(
                f"select id, doc_id from nodes where id in ({','.join('?'*len(B))})", B).fetchall()}
            if any(gm.get(i) == doc and i >= cut for i in B): hits += 1
            same.append(sum(1 for i in B if gm.get(i) == doc))
            chs.append(block_chars(B))
        med = st.median(chs)
        if k == 0: base_chars = med
        n = len(queries)
        print(f"{slots:>4} {k:>2} {hits/n:>6.0%} {st.mean(same):>7.1f} {med:>8.0f} {med-base_chars:>+8.0f} "
              f"{(st.median(sims) if sims else 0):>9.3f}")
        res.append({"slots":slots,"k":k,"hit":hits/n,"chars":med,"delta":med-base_chars,
                    "sim":st.median(sims) if sims else None})
json.dump(res, open(r"D:\dshMemo\eval\sweep.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)

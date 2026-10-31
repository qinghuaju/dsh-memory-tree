import sqlite3, hashlib, json, struct, sys
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

def vec_of(blob):
    return np.frombuffer(blob, dtype=np.float32, count=DIM)

def qvec(text):
    key = hashlib.sha256(f"{MODEL}|{DIM}|{text}".encode()).hexdigest()
    r = con.execute("select vec from embed_cache where key=?", (key,)).fetchone()
    return vec_of(r["vec"]) if r else None

def cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0

rows = con.execute("select query, node_ids from recalls order by created_at desc limit 20").fetchall()
queries = [(r["query"], parse_ids(r["node_ids"])) for r in rows]

rng = {}
for r in con.execute("select doc_id, min(id) lo, max(id) hi from nodes group by doc_id"):
    rng[r["doc_id"]] = (r["lo"], r["hi"])

def block_chars(ids):
    if not ids: return 0
    ph = ",".join("?"*len(ids))
    rows = con.execute(f"select id, path, content, created_at from nodes where id in ({ph})", ids).fetchall()
    m = {r["id"]: r for r in rows}
    total = 96
    for i, nid in enumerate(ids):
        n = m.get(nid)
        if n:
            total += len(f'[{i+1}] 0000-00-00 · {n["path"]}\n') + len(n["content"] or "") + 2
    return total

def is_tail(nid, doc, frac=0.8):
    lo, hi = rng.get(doc, (0, 0))
    return nid >= lo + frac * (hi - lo)

out = []
for q, A in queries:
    if not A: continue
    nodes = con.execute(f"select id, doc_id, path, content from nodes where id in ({','.join('?'*len(A))})", A).fetchall()
    nm = {n["id"]: n for n in nodes}
    ordered = [nm[i] for i in A if i in nm]
    counts = {}
    for n in ordered: counts[n["doc_id"]] = counts.get(n["doc_id"], 0) + 1
    main_doc = max(counts, key=counts.get)

    qv = qvec(q)
    tail = []
    if qv is not None:
        lo, hi = rng[main_doc]
        cut = lo + 0.8 * (hi - lo)
        cand = con.execute(
            "select n.id, v.vec, v.norm from nodes n join vectors v on v.node_id=n.id "
            "where n.doc_id=? and n.id>=? and n.archived=0", (main_doc, cut)
        ).fetchall()
        have = set(A)
        scored = []
        for c in cand:
            if c["id"] in have: continue
            v = vec_of(c["vec"]); sim = cos(qv, v)
            scored.append((sim, c["id"]))
        scored.sort(reverse=True)
        tail = [i for _, i in scored[:2]]

    B = list(A)
    for tid in tail:
        # 从尾部剔除：优先剔非主导文档节点，其次剔主导文档中最早（分位最低）的
        drop_idx = None
        for i in range(len(B)-1, -1, -1):
            nid = B[i]
            nd = nm.get(nid)
            if nd and nd["doc_id"] != main_doc:
                drop_idx = i; break
        if drop_idx is None:
            for i in range(len(B)-1, -1, -1):
                if not is_tail(B[i], main_doc):
                    drop_idx = i; break
        if drop_idx is not None:
            B.pop(drop_idx)
        B.append(tid)

    def metrics(ids):
        ns = con.execute(f"select id, doc_id from nodes where id in ({','.join('?'*len(ids))})", ids).fetchall()
        m = {n["id"]: n["doc_id"] for n in ns}
        same = sum(1 for i in ids if m.get(i) == main_doc)
        concl = any(is_tail(i, main_doc, 0.7) and m.get(i) == main_doc for i in ids)
        tail20 = any(is_tail(i, main_doc, 0.8) and m.get(i) == main_doc for i in ids)
        return same, concl, tail20, block_chars(ids)

    a10 = metrics(A); a6 = metrics(A[:6]); b10 = metrics(B); b6 = metrics(B[:6])
    out.append({"q": q, "main": main_doc, "A10": a10, "A6": a6, "B10": b10, "B6": b6, "tail": tail})

print(f"{'#':>2} 文档  A6结论 B6结论  A10结论 B10结论  A6字符 B6字符")
for i, r in enumerate(out, 1):
    print(f'{i:>2} {r["main"]:>4} {int(r["A6"][1]):>5} {int(r["B6"][1]):>5} '
          f'{int(r["A10"][1]):>7} {int(r["B10"][1]):>7} {r["A6"][3]:>7} {r["B6"][3]:>7}')

n = len(out)
def rate(k): return sum(1 for r in out if r[k][1]) / n
print(f"\n=== 结论级命中率（含该文档后 30% 节点）===")
print(f"  A 10 节点(本次实测口径): {rate('A10'):.0%}")
print(f"  B 10 节点(结论偏置后)  : {rate('B10'):.0%}")
print(f"  A  6 节点(自动注入默认): {rate('A6'):.0%}")
print(f"  B  6 节点(结论偏置后)  : {rate('B6'):.0%}")
print(f"\n=== 后 20% 节点命中 ===")
print(f"  A10 {sum(1 for r in out if r['A10'][2])}/{n}   B10 {sum(1 for r in out if r['B10'][2])}/{n}")
print(f"\n=== 注入字符（中位）===")
import statistics as st
for k, label in [("A10","A10"),("B10","B10"),("A6","A6"),("B6","B6")]:
    print(f"  {label}: {st.median(r[k][3] for r in out):.0f}")
print(f"\n附加了尾部节点的查询数: {sum(1 for r in out if r['tail'])}/{n}")
json.dump(out, open(r"D:\dshMemo\eval\ab_result.json","w",encoding="utf-8"), ensure_ascii=False, indent=1)

import sqlite3, json, statistics as st, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"D:\dshMemo\eval\snapA\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row
rng = {r["doc_id"]: (r["lo"], r["hi"]) for r in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}
node_doc = {}
for r in con.execute("select id, doc_id from nodes"):
    node_doc[r["id"]] = r["doc_id"]

TARGETS = [161, 400, 352, 286, 477, 80, 404, 206, 341, 355, 236, 454, 63, 57, 523, 460, 117, 115, 108, 53]

data = json.load(open(r"D:\dshMemo\eval\replay.json", encoding="utf-8"))
for block in data:
    print(f"\n=== limit={block['limit']} ===")
    for side in ("off", "on"):
        hits, hits20, chars, same = 0, 0, [], []
        for i, r in enumerate(block[side]):
            t = TARGETS[i]
            lo, hi = rng.get(t, (0, 0))
            c70 = lo + 0.7 * (hi - lo); c80 = lo + 0.8 * (hi - lo)
            owned = [n for n in r["ids"] if node_doc.get(n) == t]
            if any(n >= c70 for n in owned): hits += 1
            if any(n >= c80 for n in owned): hits20 += 1
            chars.append(r["chars"]); same.append(len(owned))
        print(f"  {side:>3}: 结论级(后30%) {hits/20:>3.0%} | 后20% {hits20/20:>3.0%} | 字符中位 {st.median(chars):>4.0f} | 命中目标文档节点 {st.mean(same):.1f}/次")

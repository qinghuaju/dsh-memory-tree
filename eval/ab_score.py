import sqlite3, json, statistics as st, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"D:\dshMemo\eval\snapA\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row
rng = {r["doc_id"]: (r["lo"], r["hi"]) for r in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}

data = json.load(open(r"D:\dshMemo\eval\replay.json", encoding="utf-8"))
for block in data:
    limit = block["limit"]
    print(f"\n=== limit={limit} ===")
    for side in ("off", "on"):
        hits = 0; chars = []; docs = []
        for r in block[side]:
            doc = r["mainDoc"]
            lo, hi = rng.get(doc, (0, 0))
            cut = lo + 0.7 * (hi - lo)
            if any(i >= cut for i in r["ids"]): hits += 1
            chars.append(r["chars"]); docs.append(r["docs"])
        print(f"  {side:>3}: 结论级命中 {hits/20:.0%} ({hits}/20) | 字符中位 {st.median(chars):.0f} | 平均文档数 {st.mean(docs):.2f}")

import sqlite3, json, statistics as st, sys
sys.stdout.reconfigure(encoding="utf-8")
DB = r"D:\dshMemo\eval\snapA\memory.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row
rng = {r["doc_id"]: (r["lo"], r["hi"]) for r in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}
ndoc = {r["id"]: r["doc_id"] for r in con.execute("select id, doc_id from nodes")}
TARGETS = [161, 400, 352, 286, 477, 80, 404, 206, 341, 355, 236, 454, 63, 57, 523, 460, 117, 115, 108, 53]
data = json.load(open(r"D:\dshMemo\eval\replay.json", encoding="utf-8"))

print(f"{'槽':>2} {'版本':<4} {'文档级':>6} {'Top1':>6} {'结论级':>6} {'后20%':>6} {'字符中位':>8} {'token≈':>7}")
for block in data:
    for side in ("off", "on"):
        d = t1 = c70 = c80 = 0; chars = []
        for i, r in enumerate(block[side]):
            t = TARGETS[i]
            lo, hi = rng.get(t, (0, 0))
            owned = [n for n in r["ids"] if ndoc.get(n) == t]
            if owned: d += 1
            if r["ids"] and ndoc.get(r["ids"][0]) == t: t1 += 1
            if any(n >= lo + 0.7 * (hi - lo) for n in owned): c70 += 1
            if any(n >= lo + 0.8 * (hi - lo) for n in owned): c80 += 1
            chars.append(r["chars"])
        med = st.median(chars)
        label = "改前" if side == "off" else "改后"
        print(f"{block['limit']:>2} {label:<4} {d*5:>5}% {t1*5:>5}% {c70*5:>5}% {c80*5:>5}% {med:>8.0f} {med/1.5:>7.0f}")

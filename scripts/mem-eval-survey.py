"""mem-eval survey: measure whether a local memory store has enough data for the study.

Read-only. Prints counts only - no conversation text, titles, paths or ids leave
the machine. Use it to size the experiment before committing to it.
"""
import argparse
import json
import os
import sqlite3
import statistics as st
import sys

MARKERS = ["结论", "建议", "方案", "选型", "决定", "推荐", "取舍", "最终", "确定", "对比", "评估"]


def tiers(data_dir):
    out = []
    for name in ("memory.db", "memory-warm.db", "memory-cold.db"):
        path = os.path.join(data_dir, name)
        if os.path.exists(path):
            out.append((name.replace("memory", "").replace(".db", "").strip("-") or "hot", path))
    return out


def survey(data_dir, min_long_nodes):
    rows = []
    for tier, path in tiers(data_dir):
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        docs = con.execute(
            "select d.id, d.text, (select count(*) from nodes n where n.doc_id=d.id) c "
            "from documents d where d.status is null or d.status != 'archived'"
        ).fetchall()
        for d in docs:
            text = d["text"] or ""
            marks = sum(1 for m in MARKERS if m in text)
            rows.append({
                "tier": tier,
                "nodes": d["c"],
                "chars": len(text),
                "markers": marks,
                "long": d["c"] >= min_long_nodes,
                "decision_like": d["c"] >= min_long_nodes and marks >= 2,
            })
        con.close()
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(os.path.expanduser("~"), ".dsh", "memory-tree"))
    ap.add_argument("--min-long-nodes", type=int, default=40)
    args = ap.parse_args()

    if not os.path.isdir(args.data_dir):
        print(json.dumps({"error": f"data dir not found: {args.data_dir}"}, ensure_ascii=False))
        return 0

    rows = survey(args.data_dir, args.min_long_nodes)
    total = len(rows)
    long_docs = [r for r in rows if r["long"]]
    dec_docs = [r for r in rows if r["decision_like"]]
    nodes = [r["nodes"] for r in rows]

    out = {
        "documents": total,
        "nodes_total": sum(nodes) if nodes else 0,
        "nodes_median_per_doc": int(st.median(nodes)) if nodes else 0,
        "long_docs": len(long_docs),
        "decision_like_docs": len(dec_docs),
        "min_long_nodes": args.min_long_nodes,
        "queries_available": len(dec_docs),
        "verdict": (
            "READY" if len(dec_docs) >= 10
            else "THIN" if len(dec_docs) >= 5
            else "NOT_READY"
        ),
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())

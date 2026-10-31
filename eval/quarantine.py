import sqlite3, json, os, shutil, sys, glob
sys.stdout.reconfigure(encoding="utf-8")

DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"
QUAR = r"D:\dshMemo\eval\quarantine"
os.makedirs(QUAR, exist_ok=True)

SECRET_DOCS = [637, 641, 647, 649]
SCAFFOLD_DOCS = [663, 664, 665, 666, 667, 668, 669, 670, 672, 673, 674, 675, 676, 677,
                 678, 679, 680, 681, 682, 684, 685, 686, 687, 688, 689, 690, 691]
TARGETS = SECRET_DOCS + SCAFFOLD_DOCS

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
rows = con.execute(
    f"select id, title, created_at from documents where id in ({','.join('?'*len(TARGETS))})", TARGETS
).fetchall()
found = {r["id"]: r for r in rows}
missing = [i for i in TARGETS if i not in found]
print(f"命中 {len(rows)}/{len(TARGETS)} 篇，缺失 {missing}")

con.execute(f"update nodes set archived = 1 where doc_id in ({','.join('?'*len(TARGETS))})", TARGETS)
con.execute(f"update documents set status = 'archived' where id in ({','.join('?'*len(TARGETS))})", TARGETS)
con.commit()
print("已标记 archived:", con.execute("select changes()").fetchone()[0])

log = {"archived_docs": [dict(found[i]) for i in found], "undo": f"update nodes set archived=0 where doc_id in ({','.join(map(str,TARGETS))});"}
json.dump(log, open(os.path.join(QUAR, "archived.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

root = r"C:\Users\admin\.dsh\memory-tree\memory"
moved = []
for doc_id in SECRET_DOCS:
    for f in glob.glob(os.path.join(root, "**", f"*{doc_id:06d}*.md"), recursive=True):
        dst = os.path.join(QUAR, f"secret-doc{doc_id}.md")
        shutil.move(f, dst)
        moved.append((f, dst))
print(f"镜像文件已移出 {len(moved)} 个 -> {QUAR}")
for a, b in moved:
    print("  ", os.path.basename(a), "->", os.path.basename(b))
con.close()

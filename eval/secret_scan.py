import sqlite3, re, os, sys, glob
sys.stdout.reconfigure(encoding="utf-8")

TIERS = {
    "hot": r"C:\Users\admin\.dsh\memory-tree\memory.db",
    "warm": r"C:\Users\admin\.dsh\memory-tree\memory-warm.db",
    "cold": r"C:\Users\admin\.dsh\memory-tree\memory-cold.db",
}
PATTERNS = {
    "github_pat": re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    "npm_token": re.compile(r"npm_[A-Za-z0-9]{30,}"),
    "openai_key": re.compile(r"sk-[A-Za-z0-9]{20,}"),
    "aws_key": re.compile(r"AKIA[0-9A-Z]{16}"),
    "slack": re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
}
def mask(m):
    return m[:6] + "…" + f"(len={len(m)})"

print("=== 数据库中的凭证泄露 ===")
hits = []
for tier, path in TIERS.items():
    if not os.path.exists(path):
        continue
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    for row in con.execute("select id, title, text, created_at from documents"):
        text = row[2] or ""
        found = []
        for name, pat in PATTERNS.items():
            for m in pat.findall(text):
                found.append((name, m))
        if found:
            hits.append((tier, row[0], row[1], row[3], found))
            print(f"[{tier}] doc {row[0]} {row[3][:16]} {str(row[1])[:36]}")
            for name, m in found:
                print(f"    {name}: {mask(m)}")
    con.close()

print("\n=== 镜像 Markdown 中的凭证泄露 ===")
root = r"C:\Users\admin\.dsh\memory-tree\memory"
md_hits = []
for f in glob.glob(os.path.join(root, "**", "*.md"), recursive=True):
    try:
        txt = open(f, encoding="utf-8", errors="ignore").read()
    except Exception:
        continue
    for name, pat in PATTERNS.items():
        for m in pat.findall(txt):
            md_hits.append((f, name, m))
            print(f"{f.replace(root,'')}  {name}: {mask(m)}")

print(f"\n合计：数据库 {len(hits)} 篇文档、镜像 {len(md_hits)} 处")

import json, sys, statistics as st
sys.stdout.reconfigure(encoding="utf-8")

rows = json.load(open(r"D:\dshMemo\eval\ab_plans.json", encoding="utf-8"))
n = len(rows)

def rate(key, field, pred):
    return sum(1 for r in rows if pred(r[key][field])) / n

print(f"样本 N = {n}\n")
print(f"{'任务':<14} {'A(core/cov/pit)':<18} {'B(core/cov/pit)':<18} {'判定'}")
for r in rows:
    a, b = r["A"], r["B"]
    print(f'{r["task"]:<14} {a["core"]}/{a["coverage"]}/{a["pitfall"]:<12} {b["core"]}/{b["coverage"]}/{b["pitfall"]:<12} {r["better"]}')

print("\n=== 汇总 ===")
for side in ("A", "B"):
    core = sum(r[side]["core"] for r in rows) / n
    cov = st.mean(r[side]["coverage"] for r in rows)
    pit = sum(r[side]["pitfall"] for r in rows) / n
    strict = sum(1 for r in rows if r[side]["core"] == 1 and r[side]["coverage"] >= 3) / n
    lenient = sum(1 for r in rows if r[side]["core"] == 1) / n
    print(f"{side}: 核心判断一致 {core:.0%} | 平均覆盖 {cov:.1f}/5 | 踩坑命中 {pit:.0%} "
          f"| 可用率(核心一致且覆盖≥3) {strict:.0%} | 可用率(仅核心一致) {lenient:.0%}")

print(f"\n评审偏好：B 胜 {sum(1 for r in rows if r['better']=='B')}/{n}，A 胜 {sum(1 for r in rows if r['better']=='A')}/{n}，平 {sum(1 for r in rows if r['better']=='tie')}/{n}")

import sqlite3, hashlib, json, statistics as st, sys, re
import numpy as np
sys.stdout.reconfigure(encoding="utf-8")
DB = r"C:\Users\admin\.dsh\memory-tree\memory.db"; MODEL, DIM = "qwen3.7-text-embedding", 1024
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True); con.row_factory = sqlite3.Row

TESTS = [
 "我那张 P100 卡，跑 Bonsai 还是 Strata 更合适？",
 "孩子文化课是强项、美术也还行，走艺考该怎么规划？",
 "想做定制设计工作室，选哪个城市、用什么模型能跑通？",
 "我是前端出身，想给 AI 做一套知识引擎和记忆插件，架构该怎么搭？",
 "带类型化世界观的幻想故事，媒介和创作方向会怎么演进？",
 "AI 生成的视频前后不一致，用本地模型怎么稳住？",
 "明朝大航海如果不走官方路线，民间能怎么参与？",
 "B站视频被第三方 AI 账号搬运评论，这是什么现象？",
 "人脑的真实结构到底是怎样的？",
 "定格动画工具的教学研究，思路该怎么设计？",
 "这两年这轮技术变革和上一轮有什么异同，机会在哪？",
 "现在的技术能做到自复制制造了吗？",
 "AI Agent 的终端形态会从桌面走到眼镜吗？",
 "90-90 法则讲的是什么，怎么用在项目收尾？",
 "华强北的 AI 眼镜反向拆解之后，能做什么应用？",
 "帮我生成一首短歌行风格的音乐提示词。",
 "DSH 里多模型协作、自动切换该怎么配置？",
 "DSH 记忆插件崩溃了，是什么原因、怎么修？",
 "ComfyUI 换一台机器，怎么快速迁移部署？",
 "6GB 显卡能跑哪些生图和生视频工作流？",
]
def parse_ids(raw):
    try:
        v = json.loads(raw)
        if isinstance(v, list): return [int(x) for x in v]
    except Exception: pass
    return [int(x) for x in str(raw).strip("[] ").split(",") if x.strip().isdigit()]
V = lambda b: np.frombuffer(b, dtype=np.float32, count=DIM)
NR = lambda v: float(np.linalg.norm(v))
def qv(t):
    k = hashlib.sha256(f"{MODEL}|{DIM}|{t}".encode()).hexdigest()
    r = con.execute("select vec from embed_cache where key=?", (k,)).fetchone()
    return V(r["vec"]) if r else None
rng = {r["doc_id"]:(r["lo"],r["hi"]) for r in con.execute("select doc_id,min(id) lo,max(id) hi from nodes group by doc_id")}
byq = {}
for r in con.execute("select query,node_ids,created_at from recalls order by created_at"):
    if r["query"] in TESTS: byq[r["query"]] = parse_ids(r["node_ids"])
missing = [q for q in TESTS if q not in byq]
print(f"匹配 {len(byq)}/20 条精确查询；缺失 {len(missing)}")

def useful(t):
    t = (t or "").strip()
    return len(t) >= 80 and not re.fullmatch(r"[\s\-—–_=*#>|`~·.。、，,;；:：/\\()（）\[\]【】]+", t)

def block_chars(ids):
    m = {r["id"]: r for r in con.execute(f"select id,path,content from nodes where id in ({','.join('?'*len(ids))})", ids)}
    return 96 + sum(len(f'[{i}] 0000-00-00 · {m[n]["path"]}\n')+len(m[n]["content"] or "")+2
                    for i, n in enumerate(ids, 1) if n in m)

print(f"{'槽':>2} {'k':>2} {'阈值':>5} {'结论命中':>7} {'+字符':>6} {'尾部sim':>7} {'主文档=目标':>10}")
for slots in (6, 10):
    for thr in (0.0, 0.45, 0.55):
        for k in (1,):
            hits = 0; dch = []; sims = []; main_eq = 0
            for q in TESTS:
                A = byq[q][:slots]
                if not A: continue
                ns = con.execute(f"select id,doc_id from nodes where id in ({','.join('?'*len(A))})", A).fetchall()
                dm = {n["id"]: n["doc_id"] for n in ns}
                cnt = {}
                for d in dm.values(): cnt[d] = cnt.get(d,0)+1
                doc = max(cnt, key=cnt.get)
                lo, hi = rng[doc]; cut = lo + 0.8*(hi-lo)
                v = qv(q); add = []
                if v is not None:
                    cand = con.execute("select n.id,n.content,v.vec from nodes n join vectors v on v.node_id=n.id "
                                       "where n.doc_id=? and n.id>=? and n.archived=0", (doc,cut)).fetchall()
                    sc = []
                    for c in cand:
                        if c["id"] in A or not useful(c["content"]): continue
                        s = float(np.dot(v,V(c["vec"]))/(NR(v)*NR(V(c["vec"])) or 1))
                        if s >= thr: sc.append((s, c["id"]))
                    sc.sort(reverse=True)
                    add = [i for _,i in sc[:k]]; sims += [s for s,_ in sc[:k]]
                B = list(A)
                for tid in add:
                    di = None
                    for i in range(len(B)-1,-1,-1):
                        if dm.get(B[i], doc) != doc: di = i; break
                    if di is None:
                        c70 = lo + 0.7*(hi-lo)
                        for i in range(len(B)-1,-1,-1):
                            if B[i] < c70: di = i; break
                    if di is not None: B.pop(di)
                    B.append(tid)
                gm = {n["id"]: n["doc_id"] for n in con.execute(
                    f"select id,doc_id from nodes where id in ({','.join('?'*len(B))})", B).fetchall()}
                if any(gm.get(i)==doc and i >= lo+0.7*(hi-lo) for i in B): hits += 1
                dch.append(block_chars(B) - block_chars(A))
            print(f"{slots:>2} {k:>2} {thr:>5.2f} {hits/20:>6.0%} {st.median(dch):>+6.0f} "
                  f"{(st.median(sims) if sims else 0):>7.3f} {len(add)>0:>10}")

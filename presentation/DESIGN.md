# dsh-memory-tree 讲解演示 · 设计风格方案

> 用途：视频讲解「DSH 记忆插件的原理与功能」。
> 形态：单文件 HTML（离线可跑、无 CDN 依赖、键盘翻页、元素级入场/退场动效）。
> 已选定：**B 纸本档案**。完整 14 页演示见 `presentation/index.html`，使用说明见 `presentation/README.md`。

---

## 一、三套风格（选一套；也可以「A 主体 + C 片头」混搭）

### A. 石墨终端 Graphite Terminal（推荐）

| 维度 | 定义 |
|---|---|
| 气质 | 工程、精确、可信；像在读一个高质量技术文档 + 终端 |
| 背景 | `#0B0E12` 石墨黑（带一点蓝），面板 `#121821`，浮起 `#1A2230` |
| 主色 | 薄荷青 `#4FE3B0`（数据/成功/连线） |
| 辅色 | 钢蓝 `#7AA2FF`（结构/链接），琥珀 `#FFB86B`（警示/冷层） |
| 文本 | 主 `#E7EDF5`，次 `#9FB0C4`，弱 `#6B7A8D` |
| 标题字 | 思源黑体 / Noto Sans SC，600–700 |
| 正文字 | 同上 400，行高 1.7 |
| 数据/代码 | JetBrains Mono / Cascadia Code |
| 动效 | 180–360ms，快而利落，`cubic-bezier(.2,.7,.2,1)`；线条用描边绘制，数字滚动 |
| 辅助元素 | 细网格、方括号标号、节点圆点、状态灯、标尺刻度、代码块 |
| 适用 | 屏幕录制、暗色环境、技术向观众；GPU 压力最小、长时间看不累 |
| 风险 | 偏"开发者向"，对非技术观众略显冷 |

### B. 纸本档案 Paper Ledger

| 维度 | 定义 |
|---|---|
| 气质 | 温暖、叙事、有"记忆是被收藏的档案"的隐喻 |
| 背景 | 米白 `#F6F1E7`，纸面 `#FFFDF8`，墨黑 `#17140F` |
| 主色 | 朱红 `#D6452F`（印章/重点） |
| 辅色 | 墨绿 `#2F6B5A`（结构）、赭黄 `#C98A2E`（注释） |
| 文本 | 主 `#17140F`，次 `#5D5548` |
| 标题字 | 思源宋体 / Noto Serif SC，700 |
| 正文字 | 思源黑体 400；数据用等宽 |
| 动效 | 320–480ms，纸片落下/盖章感（`translateY + rotate(.4deg) + blur(2px)→0`，轻微回弹） |
| 辅助元素 | 纸纹、胶带、印章、手写标注箭头、索引卡、时间戳 |
| 适用 | B 站/科普讲解、需要"人情味"的开场与结尾；投影/明亮环境更清晰 |
| 风险 | 深色代码/终端内容不协调；动效过多会显旧 |

### C. 神经雾 Synapse Mist

| 维度 | 定义 |
|---|---|
| 气质 | 未来、神经网络、概念感 |
| 背景 | 深靛 `#0A0F1E`，渐变 `#101A33 → #0A0F1E` |
| 主色 | 青 `#55D6FF` |
| 辅色 | 紫 `#A78BFA`、暖橙 `#FFC46B` |
| 文本 | 主 `#EAF2FF`，次 `#9DB0CC` |
| 标题字 | Noto Sans SC 600 + 拉丁 Space Grotesk |
| 动效 | 500ms 入场，节点呼吸、粒子连线、光晕（4–6s 循环） |
| 辅助元素 | 光晕、粒子、同心圆、玻璃拟态卡片 |
| 适用 | 片头 3–5 秒、章节过渡；不适合整场 |
| 风险 | 长看疲劳；大面积 blur/粒子在录屏里易掉帧、压缩后发糊 |

---

## 二、推荐组合

> **主体用 A（石墨终端），片头/章节过渡借用 C 的 3 个短镜头，结尾用 B 的"档案"意象。**

理由：

1. 主题是"SQLite / AST / 向量检索"，A 的工程气质与内容同构，观众注意力在图上而不是装饰上；
2. 视频里大量内容是**结构图与数据**，A 的对比度、等宽数字、网格背景最适合；
3. C 的高光镜头只用在 2–3 处（封面、从"上下文失忆"转到"外置记忆"、结尾），避免渲染压力；
4. B 只在最后"记忆是资产"的情感落点用一页，形成温度反差。

---

## 三、动效规范（三套共用一套节奏，只换缓动与时长）

### 入场（每页）

- 元素按 `data-step` 顺序交错：间隔 60–90ms；
- 基础：`opacity 0→1` + `translateY 14px→0`，320ms `cubic-bezier(.2,.7,.2,1)`；
- 标题额外：字距 `-0.02em→0`，轻微；
- 图表：`clip-path: inset(0 100% 0 0)` 从左展开 420ms；折线/连线用 `stroke-dashoffset` 绘制；
- 数字：从 0 滚到目标值（180–260ms/位），等宽字体避免抖动；
- 图片：`scale(1.04)→1` + 淡入，600ms（比文字慢，形成层次）。

### 退场（换页前）

- 反向交错：间隔 40ms；
- 基础：`translateY 0→-10px` + `opacity→0` + `blur(1.5px)`，260ms；
- 图表反向收起或直接淡出（不重放绘制动画，避免"倒放"廉价感）；
- 全部退场结束后 80ms 再切页，避免元素残影。

### 换页

- 背景层交叉淡化 300ms；
- 章节序号做字符级位移（`translateY` 遮罩），只在章节页使用；
- 页面之间禁止横向大位移（录屏压缩后易糊）。

### 降级

- 尊重 `prefers-reduced-motion: reduce`：全部改为 120ms 淡入淡出，不做位移与模糊；
- 关闭动画时保留最终布局，不做"从不可见开始"的隐藏。

---

## 四、版式网格

- 画布 1920×1080（16:9），等比缩放到窗口；录制时全屏；
- 12 列栅格，左右安全边距 96px，上 72px / 下 84px；
- 标题层级：H1 56–64px / H2 40px / 正文 26–28px / 注释 18px；
- 单页信息密度：**一个论点 + 一张主图 + 一行证据**；超过 3 个视觉块就拆页；
- 右下角固定页码与"DSH MEMORY TREE"标记，弱色 40% 透明度。

---

## 五、14 页内容规划（选定风格后逐页实现）

| # | 页面 | 主图 / 动效 | 证据/文案落点 |
|---|---|---|---|
| 1 | 封面 | 标题字符入场 + 记忆树生长（SVG 描边） | 一句话定位 + 3 个徽章（AST / 分层 / 进程隔离） |
| 2 | 问题：会话失忆 | 时间轴，任务结束后上下文块碎裂消失 | "任务结束＝上下文清空" |
| 3 | 目标：从消耗品到资产 | 左右对比卡（上下文 vs 磁盘） | 记忆可继承 |
| 4 | 总览架构 | host / child 双层框图，IPC 连线 | 引擎与宿主隔离 |
| 5 | 捕获 | 消息流 → 过滤器 → 缓冲 → 合并，逐项点亮 | 只记真人+模型，注入过滤 |
| 6 | 结构化（AST） | 树节点逐级生长，路径高亮 `/主题/小节/段落` | 可寻址 |
| 7 | 向量与软边 | 节点散开 → 余弦连线 → 一跳扩散 | 0.72 相似边 |
| 8 | 存储与分层 | 三个文件层叠，30/180 天标记，轮转箭头 | hot/warm/cold |
| 9 | 检索打分 | 公式分项条 + RRF + 扩散 + 预算，条形累积 | 0.55/0.20/0.25 |
| 10 | 注入与安全 | `<memory-recall>` 卡片落入会话，转义示例 | 不可信资料 |
| 11 | 工程保障 | 时序图：崩溃 → 重启 → 日志；关闭 1s 预算 | 进程隔离、自愈 |
| 12 | 实测数据 | 1k/10k/30k 表格 + 折线绘制 + 数字滚动 | 11.6 / 55.9 / 191ms |
| 13 | 使用方式 | 终端打字动效（install / demo / mem_stats） | 一条命令部署 |
| 14 | 路线图 / 结尾 | 三阶段时间线 + 结尾意象图 | L2 巩固 → L3 LoRA → 多机 |

（12 页数据来自 README 的 `bench.mjs` 实测；若录制时数据更新，脚本重跑后替换即可。）

---

## 六、插画规划：哪里用 AI 生图，哪里必须用矢量

### 6.1 规则（重要）

| 内容类型 | 用什么 | 原因 |
|---|---|---|
| 架构图、数据流、AST 树、分层、打分公式、时序图 | **SVG / HTML**（必须） | 需要精确、可动画、可主题化；AI 图里的中文标注会糊成乱码 |
| 图标、箭头、连线、标注、页码、装饰线 | **SVG** | 清晰、体积小、可跟随主题换色 |
| 封面/章节过渡/结尾的情绪背景 | **AI 生图** | 只承担"氛围"，不承载信息 |
| 照片级质感（纸纹、金属、玻璃） | **AI 生图或 CSS 纹理** | 用 CSS 更轻；仅大图用 AI |
| 任何带文字的图 | **禁止 AI** | 中文必糊；文字一律 HTML 叠加 |

**原则：AI 图只做"背景/氛围层"，信息层永远是矢量。**

### 6.2 AI 生图清单（A 风格：石墨终端）

统一前缀（保持系列一致）：

```
editorial 3D render, matte charcoal background (#0B0E12), mint (#4FE3B0) and
steel blue (#7AA2FF) accent light, soft rim light, subtle film grain,
clean minimal composition, lots of negative space, no text, no letters,
no logo, no watermark, 16:9
```

| # | 用途 | 构图提示 | 提示词要点 |
|---|---|---|---|
| P1 | 封面主视觉 | 左侧留白给标题，右下是"记忆层"结构 | isometric stack of translucent memory slabs connected by thin glowing circuit traces to a small abstract agent node |
| P2 | 第 2 页"失忆" | 画面中央一块正在碎裂的发光方块 | a fragmented glowing context cube breaking apart, small particles drifting into darkness |
| P3 | 第 3 页"外置记忆" | 从碎裂处引出一条线，落到一个稳固的档案盒 | broken cube's particles flowing into a solid archive box made of layered glass, one continuous line |
| P4 | 第 4 页架构过渡 | 两个悬浮体之间一条光桥 | two floating machine monoliths connected by a single light bridge, one smaller (child), one larger (host) |
| P5 | 第 8 页分层 | 三层半透明地层，最上层最亮 | three stacked translucent crystal strata, top layer glowing, bottom layer frosted, amber accents on the oldest |
| P6 | 第 14 页结尾 | 一棵由卡片与电路长成的树 | a tree whose leaves are paper cards and whose branches are circuit traces, warm mint light, calm |
| P7 | 章节过渡（3 张） | 极简，仅一个符号 | 可复用 P1 的局部裁切，不必单独生成 |

负向提示（每次都要带）：

```
text, letters, chinese characters, watermark, logo, signature, clutter,
busy background, rainbow neon, human face, hands, low contrast, blurry
```

### 6.3 AI 生图清单（B 风格备用 · 纸本档案）

```
risograph editorial illustration, warm paper (#F6F1E7), vermilion (#D6452F)
and ink green (#2F6B5A), visible paper grain, two-color overprint,
flat shapes, generous margins, no text, no letters, 16:9
```

- B1 封面：一叠索引卡被红线缝成一本册子；
- B2 结尾：一只手（不出现人脸）把一张卡片放进木盒。

### 6.4 尺寸与导出

- 主视觉 1920×1080（或 2560×1440 再缩），sRGB，PNG/WebP；
- 封面与结尾各 1 张，章节过渡 2–3 张即可，**不要每页都生成**（风格会飘）；
- 生成后统一在 HTML 里叠加 10–18% 的暗色渐变遮罩，保证标题可读；
- 同一套图固定 seed（如果工具支持），避免系列色差。

---

## 七、录制与性能

- **离线**：不引用任何 CDN；字体用系统已装（思源黑体/宋体、JetBrains Mono），缺失时回退到 `Microsoft YaHei UI` / `Consolas`；
- 单页动画全部 `transform/opacity`，避免大面积 `filter: blur()`；
- 1920×1080 固定舞台 + `scale` 自适应；录屏时全屏、隐藏鼠标；
- 快捷键：`←/→` 翻页，`空格` 下一段，`R` 重播本页动效，`F` 全屏，`Esc` 退出；
- 鼠标移到右下角显示页码；退出演示后回到第 1 页。

---

## 八、成片交付物（选定后）

```
presentation/
├── index.html            # 14 页演示（单文件，离线）
├── style-preview.html    # 本轮的风格样张（三套可切换）
├── assets/
│   ├── p1-hero.webp …     # AI 氛围图（按选定风格生成后放入）
│   └── (svg 内联，无独立文件)
└── DESIGN.md             # 本文件
```

---

## 九、需要你确认的 4 件事

1. **风格选 A / B / C，还是「A 主体 + C 片头 + B 结尾」？**
2. 视频画幅与分辨率：16:9 1080p 还是 4K？（影响字号与安全边距）
3. 是否有已装的中文字体？（思源黑体/宋体、鸿蒙、方正等；没有我就用系统回退）
4. 视频时长大概几分钟？（决定 14 页是否要压到 10 页、以及每页的讲解节奏）

# HANDOFF：创作模式（Creator Mode）实施提示词

> 用途：如果你想在 DSH 的创作模式会话里继续完善/重写本插件，新开一个创作模式会话，把下面整段提示词粘贴进去即可。
> 本仓库已包含 M0–M4 的全部产出：设计文档、调研笔记、host 半边、聚合引擎、client 产物、价目表与测试（92/92 全绿）。

---

## 粘贴以下内容到创作模式会话

我在开发一个 DeepSeek Harness（DSH）web profile 插件：**Token 台账（dsh-token-tally）**，仓库已克隆到本地（https://github.com/BioAIEvolu/dsh-token-tally ），已完成核心实现。请你帮我继续完善并完成安装验证。

**必读文档（按顺序，路径相对仓库根目录）：**
1. `README.md` —— 产品设计（六页签/热力图/模型对比表/口径）
2. `docs/plugin-spec-notes.md` —— DSH 插件集成规范（bundle/client 契约/路由注册，全部实证）
3. `docs/data-format-notes.md` —— 会话数据格式（zstd 多帧解码配方/事件字段/seed 切断）

**硬约束（不可违背）：**
1. 代码全部原创，禁止复制 new-api（AGPL-3.0）的任何代码，只允许概念级参考其交互设计；
2. client 运行时零第三方依赖（图表手写 SVG，仅可 `require("react")` 作为 UI 壳）；
3. 所有聚合在本机完成，HTTP 路由只接受 loopback；
4. 不修改 DSH 本体，只通过 bundle patch（`- insert: [{id, name}]`）挂载。

**当前状态：**
- host 半边：`src/host.js` + `src/core/*`（回填/磁盘缓存/实时事件/10 条 `/token-tally-api/*` 路由/loopback 守卫）——已在本机真实会话库冒烟通过（101 会话/4 秒）
- client 半边：`src/client/*` → 构建产物 `lib/client.js`（单文件 `window.__ModuleLoader__.load` 工厂）——六页签 UI + 手写 SVG 图表已实现
- 测试：`npm test` 92/92 全绿；构建：`npm run build`

**请帮我做：**
1. 把插件安装到我的 web profile 并重启 `dsh web`，确认「设置 → Token 台账」页签出现且数据正常渲染；
2. 实测六个页签 + 53 周热力图 + 筛选器，修复发现的加载/渲染问题（改动后在 `src/` 改、跑 `npm run build` 重新生成 `lib/`，不要直接编辑 `lib/`）；
3. 跑 `npm test` 保证全绿。

**已知遗留（优先处理）：**
- 对比表 P50/P95 是对数分桶近似值，可考虑细化直方图粒度；
- 价目表 `pricing/models.csv` 只有 3 行示例，需补全我常用模型的价格（按官方定价页核对）；
- 深色主题的 CSS 变量（`--dsw-alias-*`）映射需在真实明/暗两种主题下目检微调。

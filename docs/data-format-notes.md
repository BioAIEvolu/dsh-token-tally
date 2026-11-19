# DSH 会话数据形态笔记（M0-B 调研结论）

> 来源：只读实测（子代理 04d33656，2026-11-07），样本取自本机真实会话文件；参考实现源码为 skkjkk/dsh-usage-dashboard（Apache-2.0）与 AKS1st/model-usage-plugin（MIT）。

## 1. 会话存储布局

- `<~/.dsh/sessions>/<工作区目录>/<会话目录>/<日志文件>`
- 工作区目录名 = cwd 路径分隔符替换为 `-`，首尾加 `--`（如 `--D-Project-DSH--`）
- 会话目录：主会话 `session-<uuid>`；**子代理/委派会话为裸 `<uuid>`**（header 带 `parentSession` + `delegationDepth:1`）
- 日志代际并存：`session.v4.jsonl.zstd`（主流）/ `session.v3.jsonl.zstd` / `session.jsonl.zstd`
- 文件选择规则（参考实现）：`/^session\.v\d+\.jsonl\.zstd$/` 优先，其次 `session.v\d+.jsonl` → `session.jsonl.zstd` → `session.jsonl`

## 2. zstd 解码（关键坑，全部实证）

- 文件为**多帧 zstd 拼接**（4.6MB 样本含 347 帧，按 flush 批次成帧，约 2.8 行/帧）
- `zstdDecompressSync(整文件)` 只解出第一帧；`createZstdDecompress` 流式在第二帧边界报 `ZSTD_error_prefix_unknown`
- **唯一可行路径**：扫描魔数 `28 B5 2F FD` → 相邻偏移切片 → 逐帧 `zlib.zstdDecompressSync`（Node v24.21.0 的 `node:zlib` 自带，机器无 zstd.exe）
- 魔数扫描可能误报（压缩数据随机出现），解失败的切片跳过即可

## 3. JSONL 行结构

- 顶层 `{type, seq(递增), time(epoch ms), data, surfaceOp?('append'), sourceEventSeqs?}`
- 首行必为 session 头：`{type:'session', version:4, id, createdAt, cwd, parentSession?, isSeeded, origin?, delegationDepth?, agentPreset}`
- assistant/message 的 `data`：`{turn, step, message:{role, content[], source:{kind:'model', provider, model}, id}, usage:{...}, stream[]}`
- usage 实测字段：`inputTokens, outputTokens, cacheReadTokens, reasoningTokens`；**`cacheWriteTokens` 可缺省**（provider 未报）→ 用 `hasOwn` 判 cacheKnown/cacheObserved
- **compaction/summary 也带 `data.usage`**（内部压缩调用，真实计费；参考看板漏计）——本项目计入，作为准确性差异点
- fork 播种：`session/end-seed`（data.inherited）与 session 头 `seedLength|isSeeded` → **回填时必须切断继承前缀**，否则 fork 子会话双计
- type 普查（单会话 597 事件）：user-message / assistant-message / tool-call / tool-result / request-header / llm-retry×3 / compaction-* / step-* / turn-* 等

## 4. 延迟与去重（参考实现语义）

- 延迟只认闭合区间：`step/start → assistant/message` 配对；DSH v2+ 持久化会丢 chunk，丢 chunk 时回退消息时间差
- usageSig 去重 = `消息id|time|provider|model|五元token` 拼接，防写端崩溃重放双计（本项目在 host 层实现）
- 无显式 TTFT（首字）字段 → 对比表用 P50/P95 响应时长，不做首字列

## 5. 数据接入的两条路（参考实现各自的选择）

| 路径 | 用法 | 出处 |
| --- | --- | --- |
| sessionPersistence | `ctx.get('sessionPersistence')`（try/catch 包装）；`persist.requireStoredLog(id)`（含老格式迁移）/ `persist.open(id,'read')`；活会话 `ctx.get('sessions').get(id).snapshotEvents()`；`persist.root` = storeRoot | dsh-usage-dashboard host.js |
| sessionQuery | `ctx.inject(['sessionQuery'])`（调用时重新 get，注入实例可能失效）；`listSessions()` 按 header.createdAt 倒序 → `readSession(id)` → 按 `snapshot.inheritedEventCount` 切继承前缀 | model-usage-plugin |
| 实时流 | `ctx.on('session/event', (session, ev) => …)` 逐事件增量折叠（加载期先 buffer 再按 seq 去重 drain） | 两者共用 |
| 另一条实时路 | `ctx.on('llm/stream', (options, next) => …)` 包裹生成器拦 `chunk.type==='usage'`；无 usage 结束计 failed | model-usage-plugin |

## 6. 磁盘缓存契约（skkjkk 模式，本项目沿用）

- 路径：`<storeRoot 同级>/usage-dashboard-cache/<sessionId>.json` → 本项目用 `~/.dsh/token-tally-cache/<sessionId>.json`
- 内容：`{v(格式版本), id, file, mtimeMs, size, seq, rollup}`；命中条件 = v 全等 且 file+mtimeMs+size 三元组全等
- 任何折叠/计价语义变化必须 bump v；写盘 = tmp+rename 原子写 + 权限收紧 + sessionId 白名单 `[A-Za-z0-9._-]{1,200}` + 路径包含断言
- 每 60s reconcile：发现新会话 + 清理孤儿缓存；读失败会话 2^n 退避，3 次永久跳过

## 7. HTTP 路由与 loopback 守卫（model-usage-plugin 实证）

- `webServer.register({kind:'exact', path:'/__musage-stats', handler})`
- 守卫：host 头 hostname ∈ {127.0.0.1, localhost, [::1], ::1} **且** origin hostname === host，否则 403
- 注：skkjkk 未注册原始 HTTP 路由，改用 `harness.handle('usage'|...)` API——两条路都可行，本项目选 HTTP 路由（对齐 M0-A 结论）

## 8. 计价归一（两套对照）

- model-usage-plugin（MIT）：别名表 → 剥 `:batch` → 剥 `-YYYY-MM-DD` → 剥 `provider/` 前缀 → 再查别名；`deepseek-v4-pro` 故意不进别名表（价格迁移用 reroute 表达）
- dsh-usage-dashboard（Apache-2.0）：剥 `provider:model` 冒号作用域 + 末段 `/` + 市场后缀白名单 + `-free` + `-\d{2,8}` + 小写兜底
- 本项目 `src/core/pricing.js`：取两套并集（冒号作用域 + 末段 `/` + batch + 日期后缀两种格式 + 市场后缀白名单 + 四档计价），DeepSeek 峰谷定价留 v1.1

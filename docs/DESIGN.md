# 设计文档（DESIGN）

> 本文档是 dsh-token-tally 的架构与口径权威来源；面向用户的功能介绍见 [README](../README.md)，安装步骤见 [INSTALL](../INSTALL.md)。
> DSH 插件集成规范调研见 [plugin-spec-notes.md](./plugin-spec-notes.md)；会话数据格式调研见 [data-format-notes.md](./data-format-notes.md)。

## 1. 架构

### 1.1 形态

DSH **web profile bundle**：host 半边（Cordis 服务 + 只读 JSON 路由）+ client 半边（主面板与左侧导航入口）。

- 零第三方运行时依赖：图表全部手写 SVG（跟随 DSH 明暗主题 CSS 变量）；
- HTTP 路由：`GET /token-tally-api/usage`、`/token-tally-api/trend`、`/token-tally-api/ranking`、`/token-tally-api/compare`（模型对比表）、`/token-tally-api/heatmap`、`/token-tally-api/models`——全部只读 JSON、**默认仅接受 loopback**（非 loopback 403）；
- 请求级缓存：30s TTL + stale-while-revalidate + 单飞。

### 1.2 数据流

```
实时：ctx.on('session/event') 的 assistant/message 事件；历史回填：直读会话日志（session.v4.jsonl.zstd）或 sessionPersistence（特性探测回退）
  → 归一化用量记录 { ts, provider, model, ok,
                     inputTokens, outputTokens, cacheRead, cacheWrite,
                     cacheObserved, reasoningTokens,
                     genMs, latencyMs, count:1, costEst }
  → 小时桶 rollup：key = (provider, model, hourBucket)
      指标 = { count, okCount, failCount,
               inputTokens, outputTokens, cacheRead, cacheObserved, cacheWrite,
               genMsSum, latencyHist（对数分桶，可并出 P50/P95）, costEst }
  → foldSession（全量）/ foldAppend（单事件增量），两者结果字节级一致
  → 内存 rollup + 磁盘缓存 ~/.dsh/token-tally-cache/<sessionId>.json
      （按日志 mtime + size 失效，带格式版本号）
```

- 延迟用**固定对数分桶直方图**（100ms → 600s 按 ×1.5 步进分桶）而非存样本，保证聚合体积恒定、跨时间窗可合并求分位；
- 速度不落桶存储，查询时按 `outputTokens / genMsSum` 现算；
- 统计范围：主会话与子代理/委派会话默认均纳入；每份日志独立折叠，`delegationDepth > 0` 或 `parentSession` 用于识别继承关系并跳过继承前缀，避免双计；
- 事件驱动刷新：`session/event` 增量写入；60s reconcile 发现新增/移除会话。

### 1.3 计费（估算，非账单）

- 价目表外置：`pricing/models.csv`，列 `provider,model,currency,input,output,cacheRead,cacheWrite`（单价/百万 token，四档分开计价）。Token 台账主面板的「费用设置」可查看默认目录、搜索手动覆盖、添加/删除覆盖、导入 CSV/JSON 并保存；配置落在当前 profile 的 `%USERPROFILE%\.dsh\token-tally-cache\pricing.json`；
- 模型 id 归一：小写、剥 provider 作用域前缀（`global:` / `cn:` / `provider/model`）、剥日期后缀与 `:batch` 变体；归一后必须精确命中才计价。外部 CC Switch / models.dev / LiteLLM 标识不会自动猜测映射为 DSH provider/model，导入前应转换为 DSH 会话实际值；
- **未匹配价格的模型显示「未配置价格」，绝不显示 ¥0**（避免被读成免费）；
- 缓存命中率 = cacheRead / cacheObserved（仅对报告了缓存遥测的行取分母），并展示覆盖率。

## 2. 里程碑

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 插件规范调研 + 会话数据形态调研（并行子代理） | ✅ 完成（docs/plugin-spec-notes.md、docs/data-format-notes.md） |
| M1 | 纯逻辑核心：pricing 归一 + rollup 引擎（含时长/延迟直方图聚合）+ 单测（不依赖 DSH 运行时） | ✅ 完成 |
| M2 | host 半边：服务注册 + 只读路由 + loopback 守卫 | ✅ 完成（真实库冒烟：101 会话/4s） |
| M3 | client 半边：六页签（含模型对比/多维排行/会话明细）+ 热力图 + KPI + 筛选（手写 SVG） | ✅ 完成 |
| M4 | 打包 + 冒烟验证 | ✅ 完成 |
| M5 | 发布材料：npm 查重、LICENSE、安装指引 | ✅ 完成（v0.1.0 公开发布） |

## 3. 已知约束（实现时核实项）

- **已确认（M0-A）**：用量在 `assistant/message` 事件的 `data.usage`（inputTokens / outputTokens / totalTokens / cacheReadTokens? / cacheWriteTokens? / reasoningTokens?），provider/model 在 `data.message.source.{provider, model}`；client 挂载 = `main` 与 `sidebar.panellist` slot；路由 = `webServer.register`（见 docs/plugin-spec-notes.md）；
- **TTFT：DSH 会话遥测无首字字段（M0-B 实证）**，对比表以 P50/P95 响应时长（step 配对）替代，不做首字列；
- 计入 compaction/summary 的 usage（内部压缩调用是真实计费，参考实现漏计）；
- 历史回填：zstd 多帧拼接需逐帧切片解码（整文件/流式均失败，M0-B 实证），优先走 sessionPersistence/sessionQuery 服务；
- 可见粒度：小时 / 天 / 月；旧版「自动或周」偏好会迁移到当前可用选项。

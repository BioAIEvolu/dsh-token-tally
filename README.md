<div align="center">

# 📊 Token 台账 — dsh-token-tally

**DeepSeek Harness 的 Token 用量与费用看板：模型×时间堆叠柱 · 五页签消耗视图 · 多模型对比表 · 53 周热力图**

像 newapi 数据看板那样看「哪个模型、什么时候、花了多少、占多少」，外加一张多模型同屏对比表用于复盘与成本核算。全部统计在**本机**完成，不上传任何会话内容。

[![npm](https://img.shields.io/npm/v/dsh-token-tally)](https://www.npmjs.com/package/dsh-token-tally)
[![npm downloads](https://img.shields.io/npm/dm/dsh-token-tally)](https://www.npmjs.com/package/dsh-token-tally)
[![GitHub stars](https://img.shields.io/github/stars/BioAIEvolu/dsh-token-tally?style=social)](https://github.com/BioAIEvolu/dsh-token-tally/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/BioAIEvolu/dsh-token-tally?style=social)](https://github.com/BioAIEvolu/dsh-token-tally/network/members)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.5-blue)](https://github.com/deepseek-ai/deepseek-harness)

如果这个项目帮到了你，请考虑 ⭐ **Star** 支持一下，让更多人发现它！

</div>

---

## 📸 功能预览

> 以下截图由插件的**真实渲染代码**生成，使用演示数据（非任何真实会话数据）。

![Token 台账主视图：筛选器 + KPI 行 + 模型×时间堆叠柱 + 12 个月用量热力图](docs/images/hero.png)

| 调用趋势（每模型折线） | 调用次数分布（环形图） |
| --- | --- |
| ![调用趋势：每模型折线，点随线尾同步出现](docs/images/trend.png) | ![模型调用次数占比环形图，点击扇区可筛选](docs/images/donut.png) |
| **调用次数排行** | **模型对比表** |
| ![模型调用排行条形图](docs/images/rank.png) | ![模型对比表：费用/单价/速度/P50·P95/缓存命中率](docs/images/compare.png) |

---

## ✨ 你能用它做什么

### 五页签消耗视图（newapi 式布局）

| 页签 | 图表 | 口径切换 |
| --- | --- | --- |
| **消耗分布** | 堆叠柱：X=时间桶（粒度自适应），段=模型 | 费用 / Token；**绝对值 ↔ 100% 占比**一键切换 |
| **调用趋势** | 每模型折线 | 次数 / Token / 费用 |
| **调用次数分布** | 环形图（模型） | 次数 / Token / 费用 |
| **调用次数排行** | 条形排行（模型） | 次数 / Token / 费用 |
| **模型对比** | 单页对比表：每模型一行，多列指标并排 | 列头排序；点击行联动全看板筛选 |

- 堆叠柱支持 **绝对值 / 100% 占比** 切换（newapi 与 cc-switch 都没有的交互）；
- 摘要类页签只随时间范围和筛选变化，不随图表粒度变化；
- 时间桶对齐小时边界（`created_at - created_at % 3600` 语义）。

### 模型对比表（复盘核心）

每行 = 一个模型（provider + model 归一组），受当前时间范围与筛选器影响：

| 列 | 说明 |
| --- | --- |
| 模型（+供应商） | 归一后的模型名；同模型多 provider 分行显示 |
| 调用次数 | 含成功率（悬停显示失败次数） |
| 输入 / 输出 / 缓存 Tokens | 输入含缓存读+写展开（悬停明细） |
| 预估费用 + 占比 | 行内迷你条形显示占比；¥/$ 跟随全局切换 |
| 实际单价 | 预估费用 ÷ 总 Token，折算「每百万 Token」 |
| 输出速度 | outputTokens ÷ 生成时长（tok/s，中位数与均值并列） |
| 响应时长 | P50 / P95（毫秒），对数分桶直方图聚合，跨窗口可比较 |
| 缓存命中率 | cacheRead / cacheObserved；覆盖率 <100% 标注提示 |

- 点列头排序（费用/速度/命中率/单价）；
- 点击行 = 全看板按该模型筛选，再点解除；
- 表格支持导出 CSV（含公式注入防护）。

### 53 周热力图 + KPI + 筛选器

- **热力图**：GitHub 式日历（7 行 × 53 列），按日 Token 分档着色，随供应商/模型筛选联动；
- **KPI 行**：预估费用（¥/$ 切换）、总请求数、总 Tokens、缓存命中率（含遥测覆盖率）；
- **筛选器**：今天 / 24H / 7D / 30D / 90D / 自定义起止；供应商/模型多选（按厂商分组级联下拉）；筛选持久化在 localStorage。

图表全部为手写 SVG，跟随 DSH 明暗主题 CSS 变量，**零第三方运行时依赖**。

## 📦 安装

**方式一 · 插件市场（推荐）**：打开 DSH 设置 → 插件 → 发现，搜索 `token-tally` 安装。

**方式二 · CLI**：

```bash
dsh plugin --profile web add dsh-token-tally
dsh web   # 重启生效
```

**方式三 · 从源码**：`git clone` 本仓库后 `dsh plugin --profile web add "link:<仓库路径>"`。

安装后重启 `dsh web`，打开 **设置 → Token 台账**。完整步骤、卸载与故障排查见 [INSTALL.md](./INSTALL.md)。

## 🧮 口径说明（重要）

- **费用为估算**：token × 本地价目表（`pricing/models.csv` 或设置页手动覆盖），不含折扣/赠送额度/税费，**不代表账单**；
- **未配置价格的模型显示「未配置价格」，绝不显示 ¥0**；
- 仅统计普通会话：子代理会话（`parentSession` / `delegationDepth > 0`）不计入——与生态先例对齐；
- compaction（内部压缩调用）的 token 计入统计（多数参考实现会漏计）；
- 首次启动全量回填历史会话（本机 101 会话实测 ≈4 秒），之后走增量 + 磁盘缓存。

## 🔒 隐私与安全

- 所有聚合在**本机**完成，不上传任何会话内容；
- `/token-tally-api/*` 只读路由默认仅接受 loopback 来源（非 loopback 403）；
- 请勿将带本插件的 WebServer 暴露到公网。

## 🙏 致谢与出处（许可证边界）

本项目代码**全部原创**，以 MIT 发布。

- **[new-api](https://github.com/QuantumNous/new-api)（AGPL-3.0）**：仅概念级参考其数据看板的数据模型与交互布局，零代码复制、零源码引入；
- **dsh-usage-dashboard（Apache-2.0）**：rollup/磁盘缓存思路参考；
- **model-usage-plugin（MIT）**：计费规则参考；
- **cc-switch（MIT）**：信息架构参考。

## 🛠 开发

```bash
npm install
npm run build   # src/ → lib/
npm test        # 全量回归（离线运行）
```

架构设计、数据流与已知约束见 [docs/DESIGN.md](./docs/DESIGN.md)；在 DSH 创作模式会话里继续开发的提示词见 [HANDOFF.md](./HANDOFF.md)。

## 📄 License

[MIT](./LICENSE)

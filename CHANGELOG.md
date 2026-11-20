# Changelog

本项目的所有重要变更将记录在此文件中。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-11-20

### 新增

- README 功能预览：5 张由插件真实渲染代码生成的展示图（演示数据）——主视图（堆叠柱+热力图）、调用趋势、环形占比、调用排行、模型对比表；
- `docs/images` 随 npm 包分发，npm 页面同步展示截图；
- 新增 `scripts/make-readme-shots.mjs` / `shoot-readme.mjs` / `verify-readme-shots.mjs`：截图可复现（`node scripts/make-readme-shots.mjs && node scripts/shoot-readme.mjs`）。

## [0.1.0] - 2026-11-20

### 新增

- 首个公开版本 🎉
- 五页签消耗视图：消耗分布（模型×时间堆叠柱，支持绝对值 ↔ 100% 占比切换）、调用趋势（每模型折线）、调用次数分布（环形图）、调用次数排行（条形）、模型对比表；
- 模型对比表：调用次数/成功率、输入/输出/缓存 Tokens、预估费用与占比、实际单价（每百万 Token）、输出速度（tok/s）、响应时长 P50/P95、缓存命中率，支持列头排序与点击行联动全看板筛选，CSV 导出（含公式注入防护）；
- 53 周 GitHub 式用量热力图，随供应商/模型筛选联动；
- KPI 行：预估费用（¥/$ 切换）、总请求数、总 Tokens、缓存命中率（含遥测覆盖率）；
- 筛选器：今天 / 24H / 7D / 30D / 90D / 自定义起止；供应商/模型多选；筛选持久化 localStorage；
- 费用设置页：查看默认价目目录、手动覆盖、导入 CSV/JSON；
- 实时事件驱动刷新 + 历史会话增量回填 + 磁盘缓存；
- 环形图顺时针单弧生长动画，遵循系统「减弱动态效果」偏好；
- `/token-tally-api/*` 只读路由默认仅接受 loopback 来源。

# 安装与使用

## 前置

- DSH（web profile）≥ 0.2.2-rc.5（声明下限 = 实测验证版本）：`dsh web` 能正常启动；
- Node ≥ 18 仅本地开发需要——npm 包已自带构建产物（`lib/`），直接安装即可使用。

## 安装

### 方式一：DSH 插件市场（推荐）

打开 DSH 设置 → 插件 → 「发现」，搜索 `token-tally`（或 `Token 台账`），安装后**重启 dsh web**。

### 方式二：DSH CLI 从 npm 安装

```bash
dsh plugin --profile web add dsh-token-tally
dsh web   # 重启生效
```

### 方式三：从源码安装

```bash
git clone https://github.com/BioAIEvolu/dsh-token-tally.git
cd dsh-token-tally
npm install        # 仅本地开发需要；仓库已含 lib/ 构建产物
```

```bash
dsh plugin --profile web add "link:<克隆路径>"
dsh web
```

改动源码后在 `src/` 修改、跑 `npm run build` 重新生成 `lib/`（不要直接编辑 `lib/`）。

安装后**重启 dsh web**，打开 **设置 → Token 台账**。

## 使用

- 顶部筛选：时间范围（今天/24H/7D/30D/90D/自定义起止）+ 供应商/模型多选（按厂商分组）；筛选持久化在本地。
- 五个页签：消耗分布（堆叠柱 + 占比 % 切换）、调用趋势、调用次数分布、调用次数排行、模型对比（点表头排序、点行联动筛选全看板）。
- 底部：53 周用量热力图（随筛选联动）。
- KPI：预估费用、总请求、总 Tokens、缓存命中率（含遥测覆盖率）。
- 模型对比表可导出 CSV。

## 价目表（费用列）

编辑 `pricing/models.csv`（每百万 token 单价，四档分开计价）：

```
provider,model,currency,input,output,cacheRead,cacheWrite
```

- 模型名会归一化（小写、剥 provider 前缀/日期后缀/`:batch`），必须精确命中才计价；
- 未命中的模型显示「未配置价格」，**绝不显示 ¥0**；
- 更方便的方式：在插件「费用设置」页直接搜索添加覆盖或导入 CSV/JSON，配置保存在 `%USERPROFILE%\.dsh\token-tally-cache\pricing.json`（改完无需重启，查询期现算）；
- 仓库自带示例价目行，请按你所用模型的官方定价页核对后使用。

## 已知口径

- 仅统计普通会话：子代理会话（裸 `<uuid>` 目录、header 带 `parentSession`/`delegationDepth`）不计入；
- 费用为估算（token × 本地价目表），不含折扣/赠送额度/税费，不代表账单；
- 首次启动全量回填历史会话（本机 101 会话实测 ≈4 秒；更大库为分钟级，之后走增量 + 磁盘缓存）；
- compaction（内部压缩调用）的 token 计入统计（多数参考实现漏计）。

## 隐私与安全

- 所有聚合在本机完成，不上传任何会话内容；
- `/token-tally-api/*` 只读路由默认仅接受 loopback 来源（非 loopback 403）；**请勿将带本插件的 WebServer 暴露到公网**。

## 卸载

```bash
dsh plugin --profile web remove dsh-token-tally
dsh web
```

可选：删除聚合缓存 `%USERPROFILE%\.dsh\token-tally-cache\`。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置里没有页签 | 确认重启了 dsh web；确认插件出现在 profile bundles |
| 费用显示「未配置」 | 在「费用设置」页添加覆盖或往 `pricing/models.csv` 补模型单价（改完无需重启） |
| 数据为 0 | 检查时间范围/筛选器；确认会话库在默认位置（`~/.dsh/sessions`） |
| 首次打开很慢 | 冷启动回填中，等一次即可（缓存命中后秒开） |

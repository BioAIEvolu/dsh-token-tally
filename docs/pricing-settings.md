# Token 台账费用设置

## 设计口径

Token 台账内部沿用 DSH 会话中实际记录的两级标识：

- `provider`：事件里的 provider，例如 `codex`、`ark-agent-plan`、`kimi-coding`
- `model`：事件里的 model，例如 `gpt-6-astra`、`glm-5.3-flash`

不要直接把 OpenCode / models.dev 的 provider 或 model ID 当成 DSH ID。导入外部价格前，应先将外部字段映射到 DSH 实际记录值；设置页不会自动猜测并重命名，以避免错误计费。

## 价格字段

每百万 token（/M）四档：

- 输入：缓存未命中输入
- 输出：模型输出
- 缓存读：缓存命中读取
- 缓存写：缓存写入

缓存读/写可以留空；未匹配价格的模型继续显示“未配置价格”，不会按 0 元计费。

## 默认与覆盖优先级

1. 手动覆盖（`%USERPROFILE%\\.dsh\\token-tally-cache\\pricing.json`，Windows profile 默认路径）
2. 随插件发布的 `pricing/models.csv`
3. LiteLLM 在线目录（网络可用时刷新）
4. 插件内置价格

当前设置页会显示默认目录条数、币种和手动覆盖表。保存覆盖时使用 `provider + model` 精确匹配。

## 导入格式

设置页提示的 CSV 列顺序：

```text
provider,model,currency,input,output,cacheRead,cacheWrite
```

例如：

```text
codex,gpt-6-astra,CNY,30,120,15,
```

设置页支持直接选择 CSV/JSON 文件导入；导入结果先放入可编辑草稿，不会自动保存。外部供应商网页或配置文件需要映射为 DSH 会话实际值，保存前请核对 provider/model；不会无提示地将 OpenCode ID、models.dev ID 或 Pi SDK ID 混用。

## 手工配置持久化

保存后写入：

```text
%USERPROFILE%\.dsh\token-tally-cache\pricing.json
```

该文件属于当前 DSH profile 的本地配置，不上传会话内容。
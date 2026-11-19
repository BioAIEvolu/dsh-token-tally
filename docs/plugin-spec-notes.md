# DSH web profile 插件集成规范笔记（M0-A 调研结论）

> 来源：只读调研（子代理 74694c0f，2026-11-07）。全部结论来自本机已装插件真实代码（web + desktop 两个 profile），已注明出处；`app.asar`（213MB 打包）未解包。本文件是实现的规范依据。

## 1. 打包与安装形态

- 插件 = npm 包，关键字段：
  - `dsh.bundle.patch` → 指向 `cordis.patch.yml`，内容形如 `- insert: [{id, name}]`（一行插入，不改官方行）；
  - 可选 `dsh.client`：`{ inject: [...], platform: 'web' }`；
  - `exports["./client"]` 暴露 client 半边入口。
- 安装形态二选一：
  - profile 的 `package.json` → `dsh.profile.bundles` 数组登记（支持 `patchReload: "live"`）；
  - 或 `plugins/` 手动目录。
- peer 依赖策略（生态先例 dsh-crew）：区间限定 `>=0.2.1-0 <0.3.0-0`，跟随内核升级。

## 2. host 半边（cordis 服务）

模块形态：

```js
export const name = '...';
export const inject = [...];        // 声明依赖的官方服务
export function apply(ctx, config) { ... }
```

- 可注入服务清单（实证）：`agents / sessions / tools / web / webServer / loader / desktopProfiles / desktopPnpm / pluginManager / profileContext / connection / llm`。
- HTTP 路由注册（来源：dsh-skin-market/lib/routes.js:90）：

```js
ctx.inject(['webServer', 'loader'], host => {
  const dispose = host.webServer.register({
    kind: 'exact' | 'prefix',
    path,
    handler(req, res),
  });
  // 返回 disposer，由 ctx.effect 清理
});
```

## 3. client 半边（React，宿主实例）

```js
export const inject = ['slots', 'locale', 'theme'];
// apply(ctx):
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id, order, label, locale, inject,
}, renderFn));   // renderFn 返回 React 元素（用宿主 react 实例）
```

- 实证 slot 清单：`main / sidebar.panellist / shell.overlay / settings.plugin.item / plugins.bundle.config / settings.plugins.tab`；
- `settings.section` 只有 `id / order / label`，**无 icon 字段**；
- 主题跟随：CSS `var(--dsw-alias-*, fallback)` + `ctx.theme.getTheme()` / `ctx.on('theme/change')`。

## 4. 会话用量事件（数据源核心）

```js
ctx.on('session/event', (session, ev) => { ... });
// ev.name === 'assistant/message' 时：
//   ev.data.usage = { inputTokens, outputTokens, totalTokens,
//                     cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
//   ev.data.message.source = { provider, model }
```

- 真实样例已从本机 `session.v4.jsonl.zstd` 解出（3 个 keyset 变体）；dsh-context/lib/index.js 证实读取这些字段。
- 会话日志文件名模式：`session.v4.jsonl.zstd`（zstd 压缩 JSONL）→ **历史回填需要 zstd 解码**（运行时 Node 24.21.0，`node:zlib` 的 zstd 能力待 M1 实测）。

## 5. 定时器与清理实践

- 未见第三方插件挂官方 `timer` 服务；社区通行实践：
  `setInterval(...) + .unref() + ctx.effect(() => clearInterval(...))`（来源：memory-plugin/runtime.mjs:382-399）。

## 6. sessionPersistence / sessionQuery

- 官方核心服务确实存在：
  - `session-persistence-jsonl` 提供 `sessionPersistence`（来源：dshmarket patch.ts:321 注释）；
  - `@deepseek-ai/dsh-session-query-sqlite` 发布 `sessionQuery`，其 patch 注释**点名警告第三方不要挂载**（来源：sessiongraph patch.yml 注释）。
- 本机插件源码中未见第三方调用代码 → **回填路径倾向：直读 zstd 日志；sessionPersistence 仅作可选注入回退**（特性探测）。

## 7. 版本事实

- app 壳 44.7.0；runtime payload：desktop 0.2.2-rc.1（node 24.21.0）；
- web profile 官方依赖 **0.2.1-rc.5**，desktop 0.2.2-rc.1；
- 本项目 peer 目标：web profile `>=0.2.1-0 <0.3.0-0`。

## 8. 对本项目的设计落点

| 设计项 | 结论 |
| --- | --- |
| 数据接入 | 实时：`ctx.on('session/event')`；回填：直读 zstd 日志（Node zlib zstd 实测后定），sessionPersistence 作特性探测回退 |
| 路由 | `webServer.register({kind:'exact', path:'/token-tally-api/...'})` + loopback 守卫 + disposer 清理 |
| UI | `main` + `sidebar.panellist` slots（label「Token 台账」），React（宿主实例），CSS 变量跟随主题 |
| 定时 | setInterval+unref+ctx.effect（60s reconcile） |
| 插件元数据 | bundle patch 一行插入；peer `>=0.2.1-0 <0.3.0-0`；`settings.section` 无图标 |

## 9. client 半边契约（构建产物实证，对照 skkjkk lib/client.js 与本机 dsh-skin-market/client.js）

- **产物形态**：单文件 `lib/client.js`，内容为 `window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports; } })`（懒 CJS 工厂，全量自包含，不能用相对 ESM import）。
- **模块导出**：cordis 形状 `{ inject: ['slots'], apply(ctx) }`。
- **注入包**：package.json `dsh.client.inject` 声明 `@deepseek-ai/dsh-client-*` 运行时包（它们**不在** profile node_modules，由加载器运行时映射进 factory 的 `require`）；`require("react")` 可用（peer 声明 react ^18.2）。
- **注册主面板与侧栏入口**：
  ```js
  const slots = ctx.get('slots');
  ctx.effect(() => injectStyles(), 'id: styles');
  slots.inject('main', () => slots.register(
    { name: 'main', key: 'token-tally', label: () => 'Token 台账' },
    () => React.createElement(App, null),
  ));
  slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: 'token-tally', order: 45, label: () => 'Token 台账' },
    () => null,
  ));
  ```
- **样例佐证**：dsh-skin-market/client.js（`let react = require("react")` 在 factory 内）与 skkjkk lib/client.js 的 `main` / `sidebar.panellist` 注册形态一致。

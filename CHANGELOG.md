# Changelog

## 0.1.1 — 2026-11-16

- 安全：四条设置路由（`/plugins/dsh-connect-loomy/{quota,catalog,status,__save}`）现在入口先过宿主 Connection 的 `requestRejection`：`webServer.register` 挂的顶层路由不经过 DSH 自身的 Host/Origin 与浏览器凭据准入，此前跨站页面（`fetch` 带外来 Origin 会被原有门禁挡住，但顶层导航不带 Origin）仍能读到额度数字。现在未携带 DSH 界面同源凭据的外部请求一律 401/403；宿主没有 `connection` 服务时回落到原有 loopback 门禁，行为与旧版一致。围栏抛错时按 403 处理（fail closed）。

## 0.1.0 — 2026-11-14

- 修复：`apply()` 现在给 pi-ai 的模型描述符带上 shim 的 `/v1` 前缀。此前裸 origin 导致 GUI 实际调用 404（`no route for POST /chat/completions`）——doctor/probe 自带 `/v1` 因此未暴露。新增 `scripts/check-contract.mjs`（CI/prepack 内跑 wiring 契约回归）与 `scripts/real-chain-check.mjs`（本地真实链路验收，消耗一次免费模型调用）。

首个版本。

- 复用本机 Loomy 桌面端登录态（只读 `auth-session.json`），接入 DSH 模型选择器。
- 上游为 OpenAI 兼容网关（`loomyad.xunfei.cn/api/v1`）：对话、reasoning 思考链
  （`reasoning_content`）、结构化工具调用（`tool_calls`）、usage 透传。
- 模型目录自网关发现并缓存，回落内置清单；用户选择不被清空。
- 只读积分额度看板：总余额 / 每日额度 / 可用余额 + 最近变动。
- `doctor`（不消耗额度）与 `probe`（默认免费模型，一次真实流式调用）。
- 仅 Windows x64；`@deepseek-ai/*` 与 `@earendil-works/pi-ai` 为 peerDependencies。

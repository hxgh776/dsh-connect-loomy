# DSH Connect Loomy

把本机已登录的 [Loomy](https://loomy.xunfei.cn)（讯飞）账号接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)：Loomy 的对话模型出现在 DSH 模型选择器，结构化工具调用（`tool_calls`）由 DSH 本地执行，并附带只读积分额度看板。

架构与工程约定参照 `dsh-connect-trae` 与 `dsh-connect-doubao`。

**平台限制：仅 Windows x64。** 插件读取 Loomy 桌面端在 Windows 上的配置根目录（`C:\Users\Public\Loomy\<sha256(用户名)前 12 位>\userData\`），其它平台没有这个布局，也无法复用 Loomy 的登录态。

## 前提：先在 Loomy 桌面端登录

插件**不做登录**，也绝不代登录。它只读取 Loomy 桌面端自己维护的 `auth-session.json`。请先安装并登录 Loomy 桌面客户端，再使用本插件；在 Loomy 里重新登录后，DSH 侧会自动跟随新的会话。

## 工作方式

```
DSH (pi-ai provider, openai-completions)
  → 进程内 loopback shim（127.0.0.1 随机端口 + 进程内随机 secret）
    → Loomy 上游网关（OpenAI 兼容：/api/v1/chat/completions）
```

- **登录态**：只读 Loomy 桌面端自己的 `auth-session.json`。不复制、不密封、不写回；凭据始终留在 Loomy 自己的文件里，本插件不保存任何副本。
- **上游**：Loomy 桌面端的积分网关本身就是 OpenAI 兼容接口 —— `tools`、`reasoning_effort`、`stream_options.include_usage` 原生支持；SSE 里的 `reasoning_content` 思考链、`tool_calls` 增量、usage chunk、`[DONE]` 原样透传，无需协议转换（豆包需要的工具模拟这里不存在）。
- **模型目录**：启动时从 `GET /api/v1/models` 发现并缓存到 `~/.dsh/dsh-connect-loomy.catalog.json`；网关不可达时回落缓存，再回落内置清单；用户勾选（`enabledModelIds`）永不被清空。网关返回的 `auto` 路由行与生图行不进入选择器。
- **隔离**：只读写 `dsh-connect-loomy` 自己的设置命名空间与 `~/.dsh/dsh-connect-loomy.*.json`，不与其它插件共享账号、凭据、目录、开关。

## 模型清单

来自 Loomy 网关实测目录（2026-11-14），以网关实时发现为准：

| 模型 | 计费倍率 | 说明 |
|---|---|---|
| `spark-x2.6` | x0.0（限时免费） | 网关默认模型，1M 上下文 |
| `DeepSeek-V4.1-Flash` | x2.0 | 视觉输入 |
| `deepseek-v4-flash-1017` | x2.0 | 视觉输入 |
| `GLM-5.3-Flash` | x0.8 | 视觉输入 |
| `qwen3.8-flash` | x0.8 | 视觉输入 |
| `mimo-v2.5` | x3.3 | 视觉输入 |

全部支持 function calling 与思考档位（`none`–`xhigh`）。

## 安装

### 方式一：预构建包（推荐）

从 [Releases](https://github.com/hxgh776/dsh-connect-loomy/releases) 下载 `dsh-connect-loomy.tgz`，然后：

```
dsh plugin --profile desktop add <下载路径>\dsh-connect-loomy.tgz
```

### 方式二：从源码

```
git clone https://github.com/hxgh776/dsh-connect-loomy
dsh plugin --profile desktop add <仓库路径>
```

`@deepseek-ai/*` 与 `@earendil-works/pi-ai` 为 peerDependencies，由 DSH 宿主提供，不打包。本插件不发布 npm。

## 额度看板（只读）

设置 → Loomy：

- 可用积分 / 总积分余额 / 每日额度（来自 `GET /api/v1/points/records` 的 `availableBalance` / `balance` / `dailyBalance`）
- 每日额度按 Loomy 业务日重置（展示 `dailyCycleDate`，不臆造重置时刻）
- 最近积分变动（前 8 条流水）
- 模型清单勾选（写入 `enabledModelIds`；不勾选即展示全部）

除查询外全部只读；`POST` 刷新仅重读缓存，不触发任何消耗类调用。

## CLI 诊断

```
node lib/cli-doctor.js [--json] [--config-root <dir>] [--base-url <url>]
node lib/cli-probe.js [--prompt/-p ...] [--model/-m spark-x2.6] [--thinking low] [--tools] [--json] [--timeout-ms ...]
node lib/bin.js doctor | probe
```

- `doctor` 五项检查（登录态文件 → 上游身份 → shim 装配与鉴权守卫 → 额度 → 模型目录），**不消耗推理额度**；退出码 0/1/2。
- `probe` 走完整 shim 链路发起**一次**真实流式对话，默认模型为网关上的限时免费行 `spark-x2.6`（倍率 x0.0）；`--tools` 同时验证工具调用通路。退出码 2/3/4/5/1/0。

## 隐私

- **只读 Loomy 的登录态文件，不复制、不密封、不写回。** 会话 token 只出现在本插件进程到 Loomy 网关的 HTTPS 请求头里，不落盘、不进日志、不出现在任何 web 路由响应中。
- web 路由（`/plugins/dsh-connect-loomy/{quota,catalog,status,__save}`）仅回数字/清单型允许清单视图；loopback Host/Origin + `sec-fetch-site` 门禁；写路由额外要求 `x-dsh-loomy-write` 头（CSRF 防护）。
- loopback shim：随机端口 + 进程内随机 secret（`timingSafeEqual` 校验）+ 64MB 请求体上限 + 300s 流式空闲看门狗。
- 仓库内不含任何凭据与个人数据；协议文档已脱敏（见 [docs/protocol.md](docs/protocol.md)）。

## 协议依据

上游接口、鉴权头、追踪头（必需的 `traceparent` 等）的实测证据见 [docs/protocol.md](docs/protocol.md)。

## 开发

```
npm install
npm run typecheck        # tsc --allowJs --checkJs（JSDoc 检查）
node scripts/check-syntax.mjs   # node --check 全部 lib/*.js + client.js CJS 形状守卫
npm run doctor / npm run probe
```

CI 在 ubuntu + windows 上跑同一组检查。

## License

MIT

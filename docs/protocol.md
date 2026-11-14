# Loomy 上游协议实测记录

本插件的每一条上游约定都来自对 **Loomy 桌面端 0.9.39**（Windows，已登录状态，2026-11-14 实测）的逆向与只读探针，不是猜测。记录如下，供后续维护者核对。本文件只描述协议；任何账号个人数据（用户名、哈希、余额、流水内容）都不入档。

## 1. 登录态与本机存储

- Loomy 主进程把登录会话写在 `auth-session.json`（字段 `session` / `userid` / `phone` / `updatedAt`）。位置由其 `config-path.js` 决定：`C:\Users\Public\Loomy\<sha256(os.userInfo().username) 前 12 位 hex>\userData\`。
- 该哈希算法在多台机器上通用：以当前 Windows 用户名做 `sha256` 取前 12 位十六进制即可定位配置根目录（插件在运行时自行推导，无需写死任何本机值）。
- Loomy 自己在登录、会话轮换时更新该文件（`auth-session-controller.js` 的 `update()`），插件按 10 秒 TTL 重读即可跟随。

## 2. 网关地址

- 安装包内 `resources/.env.prod` 以 `LOOMYENC1` 头 + AES-256-GCM 加密（口令内嵌于客户端 `env-file-crypto.js`，客户端注释自述"混淆而非密钥保密"）。解出 `LOOMY_POINTS_BASE_URL=https://loomyad.xunfei.cn`。
- 积分网关基地址解析顺序（`points-config.js`）：环境变量 > env 文件 > `config/points.config.local.json` > electron-store > 默认值 `https://ossptest.voicecloud.cn/loomy/integration`（测试环境）。生产包 env 文件优先于 store，因此生效地址是 `https://loomyad.xunfei.cn`。
- 对话模型 provider（`imodel`）的 baseURL 由 `bundled-resources.js` 拼接：`${pointsBaseUrl}/api/v1`，`useSessionAuth: true`。

## 3. 鉴权

- 会话 token 以**两种头**同时发送（与客户端 `llm-completion.js` 一致）：
  - `Authorization: Bearer <session>`
  - `token: <session>`
- **`traceparent` 必需**。客户端源码注释明确："实测 Loomy iModel 缺 traceparent 时 chat/completions 会挂死直到超时"。格式 `00-<32hex>-<16hex>-01`。
- 其余追踪头：`ChatId`（`chat-<uuid>`）、`MsgId`、`TurnId`（可缺省）、`X-Loomy-Request-Purpose`（协议值如 `chat.message`）、`InvokeOrigin: user`、`loomy-version: 0.9.39`。
- 登录失效判定：HTTP 401/403，或业务 envelope `code: "100002"`（"登录已失效"，客户端自愈路径同款）。

## 4. 接口

### GET /api/v1/models

`Authorization` + `token` 头，HTTP 200。返回 `{reasoning_enabled, reasoning_catalog_version, object:"list", data:[...]}`，每行含：

- `id` / `name`（name 内含计费倍率，如 `DeepSeek V4.1 Flash(x2.0)`、`Spark-X2.6 正式版(限时免费)(x0.0)`）
- `type`: `chat` | `image`；`protocol`: `openai_chat`
- `context_length` / `max_output_tokens`（`auto` 行两者皆缺 → 插件过滤掉，避免 DSH `INVALID_MODEL_CONTEXT` 整体拒绝）
- `capabilities`: `{reasoning, vision, function_calling, streaming, input_modalities, output_modalities}`
- `reasoning_efforts`: `["none","low","medium","high","xhigh"]`、`default_reasoning_effort`
- `is_default_model` / `is_default_small_model`

实测目录（2026-11-14）：chat 7 行（spark-x2.6、DeepSeek-V4.1-Flash、deepseek-v4-flash-1017、GLM-5.3-Flash、qwen3.8-flash、mimo-v2.5、auto），image 3 行。

### POST /api/v1/chat/completions

OpenAI 兼容，`Content-Type: application/json`，流式返回 `text/event-stream`：

- chunk 形如 `{"id":"cht…","object":"chat.completion.chunk","created":…,"model":…,"choices":[{"index":0,"delta":{…},"finish_reason":null}]}`
- `delta.reasoning_content` = 思考链增量；`delta.content` = 正文增量
- `delta.tool_calls` = 标准结构化工具调用增量（实测出现）
- 末尾 usage chunk：`{"choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…,"total_tokens":…,"completion_tokens_details":{"reasoning_tokens":…},"points_consumed":0}}`
- 终止符 `data: [DONE]`

已实测接受的请求字段：`stream: true`、`stream_options: {include_usage: true}`、`tools: [{type:"function", function:{…}}]`、`reasoning_effort: "low"`。

### GET /api/v1/points/records?pageNo=1&pageSize=N&recordType=all

`token` 头鉴权。成功 envelope `{"code":"000000","desc":"成功","data":{…}}`，data 含：

- `balance`（总余额）、`dailyBalance`（每日额度）、`availableBalance`（两者之和）——均为整数，具体数值随账号而异，不入档
- `list[]`：流水行 `{ledgerId, modelName, direction: "credit"|"debit", description, createdAt, pointsActual, consumeSource, balanceBefore, balanceAfter, dailyCycleDate}`

### GET /api/v1/user/identity

`{"code":"000000","data":{"isInternal":false,"currentTeamId":"","teams":[]}}` —— 最便宜的已鉴权探针，`doctor` 用它验证会话而不消耗推理额度。

### 错误 envelope

- `{"code":"100001","desc":"请求参数错误"}` — 参数错误
- `{"code":"100002","desc":"登录已失效"}`（客户端注释确认 020002/100002 为鉴权错误码族）
- 限流：HTTP 429；5xx：上游错误

## 5. 本插件不使用的部分

- 账号登录接口族（`account.xfinfr.com`，HMAC-SHA1 签名）—— 登录始终在 Loomy 桌面端完成，插件绝不代登录。
- Nexus 设备协同网关、生图接口、ASR —— 不在本插件范围。
- `points.config.local.json` / electron-store 覆盖 —— 插件只读生效的基地址，可经设置 `baseUrl` 覆盖。

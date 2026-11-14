# Zed 输入区对照

调研本地 Zed revision `50304070c283519f2f2338b45671af26374025fe`。
目标：连接后进入 Chat，搭建输入区、消费 agent 的输入配置；发送消息、流式回复、停止生成。

## Zed 消费哪些数据

| 数据 / 状态 | Zed 源码 | 本轮 NSH 实现 |
| --- | --- | --- |
| 草稿、输入法组合、多行输入、编辑区展开 | `crates/agent_ui/src/message_editor.rs`；`conversation_view/thread_view.rs:5319` | 多行草稿、自动增高；输入法组合时隐藏补全；移动端回车换行 |
| `available_commands`：名称、说明、参数 hint | `message_editor.rs:49`、`:111`、`:642` | 输入 `/` 按前缀过滤；点击填入命令；有参数时补空格并展示 hint；命令完全由 agent 提供，支持动态更新 |
| session `config_options`：模型、模式、思考强度等 | `crates/agent_ui/src/config_options.rs`；`thread_view.rs:5453` | 按返回的 ID、名称、选项、当前值生成选择器；支持 select、分组与 boolean；超过 5 项提供搜索；选择后立即显示目标值，等待 agent 确认 |
| 旧版 session modes / models | `mode_selector.rs`、`agent_model_selector.rs` | 无 config options 时回退旧版 mode；模型通过当前共享协议的 model config option 提供 |
| `prompt_capabilities.image`、`embedded_context` | `message_editor.rs:49`；`thread_view.rs:6580` | 暂未接图片 / 文件 / 项目上下文入口；后续按能力启用，并接宿主能力 |
| session 运行状态、草稿是否为空、上下文是否加载完成 | `thread_view.rs:6456` | 生成中显示 Stop；空闲时 Send，空白草稿禁用；session 初始化失败可查看错误并断开 |
| token usage、profile、follow、fast/thinking、自有 skills | `thread_view.rs:5319`、`message_editor.rs:49` | 暂缓；其中部分属于 Zed 的项目或内置 agent 功能，不能假定任意 ACP agent 都会提供 |

Zed 发送按钮：上下文加载中显示 loading；生成中且草稿为空时 Stop；生成中有草稿时 Queue；空闲时 Send，空草稿禁用。NSH 暂不实现 Queue：生成中始终显示 Stop，草稿保留到本轮结束。

## 发送、流式回复与停止

对照 Zed `dd34370114` 的 `crates/acp_thread/src/acp_thread.rs`（prompt-completion，即 ACP v1 会话）；实现在 `state/thread.ts`，界面在 `components/Thread.tsx`。

| 行为 | Zed 源码 | NSH 实现 |
| --- | --- | --- |
| 发送 | `message_editor.rs:976`；`acp_thread.rs:7204` `send`、`:7408` `run_turn` | 去掉末尾空白（`message_editor.rs` `build_chunks_from_creases`），空白草稿不发；先取消并等待上一轮结束，清错误，`turn_id` 自增并进入生成中，乐观插入一条新的用户消息，再发 `session/prompt` |
| 用户消息回显 | `acp_thread.rs:4950` | 乐观消息已含相同 block 且 message ID 可合并时跳过回显；block 按结构比较，不受字段顺序和空字段影响 |
| chunk 合并 | `acp_thread.rs:501` `can_merge_message_chunks` | 任一 ID 为空或两者相等时合并到上一段，否则新起一段 |
| 平滑显示 | `acp_thread.rs:5836` `buffer_streaming_text`、`:5872` `flush_streaming_text` | 追加到已有段落的文本每 16 ms 揭示一部分，200 ms 内显示完待显示文本；插入新条目、结束、取消时立即补全 |
| 思考展开 | `thread_view.rs` auto 模式 | 正在流式的 thought 自动展开，agent 转入下一段后收起；用户手动展开的保持打开 |
| 结束 | `acp_thread.rs:7408` | 只有同一轮才回到空闲；`turn_id` 已变则忽略结果；`max_tokens` 显示 Output Limit Reached；`refusal` 删除最后一条用户消息及之后条目，显示 Request Refused，以 agent 名称指明拒绝方（`thread_view.rs:13036`）；失败显示 An Error Happened，信息按 Markdown 渲染（`thread_view.rs:12710`、`:12756`、`:13052`）；都可关闭，拒绝和失败可复制信息，输出上限不可复制 |
| 停止 | `acp_thread.rs:7588` `cancel`、`:7630` `request_cancellation` | 发 `session/cancel` 通知，立即回到空闲；agent 在回复 `cancelled` 前发来的内容照常显示 |

发送时滚动到底部；之后用户离底部 48 pt 以内才跟随新内容。计划、图片 / 文件附件、编辑和重发、Queue 暂缓。

## 工具调用与权限请求

对照同一 revision 的 `acp_thread.rs`（`ToolCall`、`upsert_tool_call`、`update_tool_call`、`request_tool_call_authorization`、`authorize`、`mark_pending_entries_as_canceled`）和 `thread_view.rs:9605` `render_tool_call`；状态在 `state/tool-call.ts`、`state/thread.ts`，界面在 `components/ToolCall.tsx`，权限请求由 `acp/client.ts` 路由到当前会话。

| 行为 | Zed 源码 | NSH 实现 |
| --- | --- | --- |
| 状态 | `acp_thread.rs:2120` `ToolCallStatus` | agent 上报的状态之外，本地记录 Waiting for confirmation、Rejected、Canceled；有待决权限请求时为等待确认，否则本地决定优先，再到上报状态，默认 Pending |
| `tool_call` | `upsert_tool_call` | 已有同 ID（从末尾查找）时整体覆盖全部字段，缺省 kind other、status pending、content / locations 为空；否则新增条目 |
| `tool_call_update` | `update_tool_call`、`tool_call_index_for_update` | 只改出现的字段，v1 `null` 视为未出现；content 整体替换；ID 不存在时插入一条失败的 “Tool call not found”，不应用更新；上报 completed / failed 时清除并以 cancelled 应答该工具的权限请求，同时清除本地状态 |
| 标题 | `label_text` | 空白标题回退到工具名，再到 “Tool call”；execute 为纯文本命令；edit 转义 Markdown（至少覆盖 `MarkdownEscaped` 的 `` \ ` * _ [ ^ $ ~ & # + = - < > ``）；execute 命令 12 px 等宽、行高 17 px；其余多行标题取首行加 “…” |
| 输出 | `ToolCall::content`、`raw_output_text` | 有结构化 content 时显示它，否则显示 raw output：字符串原样，数字 / 布尔转字符串，其余为 JSON 代码块；raw input 同规则 |
| 权限请求 | `handle_request_permission`（`agent_servers/src/acp/v1.rs`）、`request_tool_call_authorization` | 选项 kind 不是 allow / reject 的 once / always 时以 invalid params 拒绝，不建工具；当前状态取已有工具的本地 / 上报状态，否则取请求里的状态，默认 Pending；按请求更新（新工具须带 title 字段，否则 invalid params），保留当前状态；同一工具已有请求时先以 cancelled 应答旧请求 |
| 选择 | `authorize`、`status_after_permission_grant` | reject 类选项为 Rejected；allow 类把 Pending 推进为 In Progress，其余保持；应答 `selected` 与 option ID |
| 撤回 | `cancel_permission_request` | agent 的 `$/cancel_request` 中止请求时，工具标记 Canceled，以 request cancelled 错误应答 |
| 取消 / 结束 | `request_cancellation`、`cleanup_local_turn`、`truncate_entries` | Stop 把 Pending / 等待确认 / In Progress 的工具标为 Canceled 并以 cancelled 应答其请求；没有运行中的回合时应答全部请求；同一轮以 cancelled、max_tokens 或错误结束时同样处理；拒绝截断时应答被删工具的请求，但最后一条用户消息之后已有完成且有 raw output 的工具时保留历史；会话销毁时全部以 cancelled 应答 |
| 布局 | `render_tool_call` | 等待确认、edit（或含 diff）、execute 用卡片：圆角边框，失败 / 取消 / 拒绝时虚线，头部着色；其他为一行图标加标题，按 kind 选图标；有内容且不在等待确认时可折叠，等待确认时始终展开；已取消且无非空白内容的工具从列表中移除（`thread_view.rs:7601`） |
| 展开内容 | `render_tool_call` | 等待确认：content 和可展开的 “View Raw Input”；Rejected 不显示；其余：非 execute / edit / 图片时先显示 “Raw Input:” 与 “Output:”，再显示 content，非卡片底部有收起按钮；edit 每有新 diff 到达时自动展开（`expand_edit_card`、`ViewEvent::NewDiff`）：同一位置原来不是 diff，或路径、旧文本、新文本有变化，都算新 diff（`update_from_prepared`），用户收起后也会再展开 |
| 状态图标 | `render_tool_call` | 失败 / 取消 / 拒绝显示红色 ×；被取消、diff 无改动的 edit 显示灰色 Interrupted Edit 图标；被取消且已有改动、只有一个位置的 edit，在图标左上角加黄色三角（`render_tool_call_label`）；命令卡片头部不显示状态图标，只以虚线边框表示 |
| 权限按钮 | `render_permission_buttons_flat` | 卡片底部，上边框分隔，纵向排列；allow once ✓、allow always ✓✓（绿色），reject ×（红色），文字为选项名 |
| 等待确认浮条 | `render_main_agent_awaiting_permission`、`render_activity_bar`（`thread_view.rs:4699`、`:3990`） | 最早的待决请求所在工具不在视口内时，在消息列表与错误提示之间显示：转圈、“Awaiting Confirmation”（多个时带数量）、指向其方向的 Scroll 按钮；下方是该工具的无边框副本，内容限高 `max-h-40` 可滚动，权限按钮在外，可直接在此作答；滚到该工具后浮条消失 |
| Diff | `render_diff_editor` | NSH `DiffView`，unified，前后 2 行上下文，按路径高亮；没有改动时不显示，此时只在未失败时保留上边框 |
| 内容块 | `ContentBlock::render_from_source`、`text_resource_render_mode` | 文本按 Markdown；图片只用 base64 data，格式不支持或数据不合法时显示 “Image content could not be displayed.”；文本资源 Markdown 类型原样显示，其他放进代码块并按 MIME 选高亮语言；二进制资源是图片时显示图片，否则只显示 uri（XSmall、muted，为空不显示）；音频显示 “Audio content is not supported.”，未知类型显示 “Unknown content type is not supported.”；隐藏判断与图片判断都以此为准（`visible_content`） |
| 图片输出 | `render_image_output` | 最大 384 pt，按比例缩小不放大（scale-down）；卡片内无框，否则左侧边线缩进 |
| 生成中底栏 | `render_generating`、`is_waiting_for_confirmation` | 从最后一条用户消息往后，有工具在等待确认时，转圈旁显示 “Awaiting Confirmation”；否则只转圈 |

与 Zed 的差异：不声明终端能力，terminal content 显示 “Unsupported tool call content.”，execute 卡片的输出改为头部可展开（Zed 在终端里显示输出，头部无展开按钮）；不提供打开文件或链接（含图片的 “Go to File”、非文件链接的外跳图标）、丢弃中断编辑、停止单个工具、读文件行号和快捷键；头部展开按钮常显（Zed 悬停时才显示，触屏没有悬停）；文件类工具不按扩展名换图标；diff 改动时不提供逐块 Keep / Reject；生成中底栏不显示耗时和 token 数，文字没有省略号动画；图片加载完成前先按 384 pt 正方形（不超过容器宽度）占位。

## 协议与生命周期

1. 通过 `acp/client.ts` 的 `AcpClient` 和 ACP SDK 的 WebSocket transport 发送 `initialize`，等待匹配的 JSON-RPC 响应后进入 Chat。服务端是 Rust CLI 的 `/acp` 端点，只透传标准 JSON-RPC。
2. 连接页要求填写服务端所在机器上的绝对工作目录，作为 `session/new.cwd`；会话创建等待其 RPC 响应取得 ID 和配置。
3. 新建会话对齐 Zed v1（本地 revision `62682ebde9` 的 `agent_servers/src/acp/v1.rs`）：收到 `session/new` 响应后，先初始化配置与 mode，再注册 session 并通知 UI。处理 `session/update` 时尚未注册或 ID 不匹配的通知记录警告并忽略，不缓存、不回放；注册后消费命令、配置和 mode 通知。此行为仅针对新建会话，未来 `session/load` 的响应前历史回放须单独实现。
4. 配置变更发送 `session/set_config_option`，boolean 请求带 `type: "boolean"`；旧 mode 发送 `session/set_mode`。等待对应 RPC 响应结束乐观变更：成功时展示响应的实际值，即使值被规范化或选项被移除，也立即结束等待。期间的匹配通知只更新服务端状态，不提前确认 RPC；后续失败仍可展示。mode 请求期间收到的权威通知会保留，空成功响应只在没有更新时采用请求值。SDK 根据请求 ID 关联错误，迟到失败不会取消后续配置变更。保留乐观目标值和 300 ms 延迟 loading；配置变更没有固定超时，对应 RPC 结束前持续等待并阻止下一次变更。session 创建仍为 30 秒超时。
5. session / 配置错误保留连接并展示错误；连接关闭、Disconnect、Chat 返回操作回到连接页，销毁草稿与 session 监听器。连接页内存中的地址和 token 保留。
6. initialize 信息归属于连接，对齐 Zed v1 的 `AcpConnection.agent_capabilities` 与 `auth_methods`：解码及版本校验成功后保存 agent info、capabilities 和认证方式，再发出 Connected。创建 session 或 session 失败保留这些信息；断开、连接失败及重连前清空。缺省或格式无效的可选字段按 Rust schema 回落默认值；能力布尔值默认 false、认证列表默认空，缺省/null 的可选能力对象与 `{}` 区分。认证方式保留有效 ID、名称、说明、terminal 参数与环境变量以及 `_meta`；Zed 的内部 v2 类型转换不用于这里的存储。本轮只保存与暴露数据，不增加认证执行或能力声明。Zed 为本地 Gemini 启动命令合成的登录方式属于进程启动适配，此 WebSocket 客户端只保存服务端声明的方式。

当前协议行为以 Zed 的 `agent_servers/src/acp/v1.rs` 和 `AcpThread` 的 prompt-completion 路径为对齐基准。Zed 内部共享的 `acp_v2` 类型不代表连接使用 v2 协议；此实现使用 ACP SDK（2.4.0）的 v1 schema 和官方 JSON-RPC 实现。协议模式默认 `v1`，`auto` 为 TODO / unimplemented。

initialize 解码基准是本地 Zed `62682ebde9` 的 Cargo.lock：Rust SDK `5.0.0` 使用 schema `1.15.1`，启用 `unstable`。必须先看 schema 再看 `auth_methods::from_v1`：该版本 v1 的 `AuthMethod` 有 terminal 分支和 untagged agent fallback；字符串 terminal 首先走 terminal 分支；数字标签 0 也会按 serde 的枚举索引先尝试 terminal，字段无效时允许回落 agent。其他 type（包括未知字符串）尝试按 agent 解析。格式无效的认证条目按 `VecSkipError` 跳过；显式字符串 terminal 的无效定义不会降级成 agent。可选字段遵循 `DefaultOnError`，terminal 的 args/env 遵循 `DefaultOnNull`；未知普通字段被忽略，合法 `_meta` 原样保留。`tests/fixtures/initialize-v1.json` 的 38 组输入及预期值由该 Rust schema 实际解码生成，覆盖默认值、错误类型、条目跳过、元数据和 serde 位置序列。必填协议版本无效时初始化失败、清空数据并允许重试。

`state/optimistic-change.ts` 抽出单次乐观 RPC 变更的生命周期：接收 RPC Promise、当前值检查和错误回调，管理临时目标值、延迟 loading 及销毁；当前值检查仅用于跳过重复选择，操作由对应 Promise 的成功或失败结束。`state/composer.ts` 负责 ACP 字段映射和目标值的显示覆盖；服务端数据始终单独保留，因此失败时也能保留等待期间收到的其他配置更新。

本次 RPC 行为另对照本地 Zed `347f171a3f`：`agent_servers/src/acp/v1.rs` 的 `ConfigOptions::set_config_option` 使用响应中的配置；`agent_ui/src/config_options.rs` 的 `set_config_option_and_default` 明确处理规范化选择；`AcpSessionModes::set_mode` 在成功响应后不覆盖期间收到的 mode 通知。NSH 的乐观显示由输入区覆盖层承担，确认后的状态保存在 `AcpClient` 中。

## 验证范围

`node tests/connection.mjs` 覆盖连接、跳转、断开、草稿、命令、配置确认 / 拒绝、旧 mode、无配置以及 session 失败；`tests/thread.test.tsx` 用 mock 按 prompt 文本编排的回合覆盖流式回复与思考展开、回显去重、停止、拒绝、输出上限和失败；`tests/tools.test.tsx` 覆盖工具状态与展开 / 收起、权限允许与拒绝、edit diff 自动展开、停止时取消等待中的请求、agent 撤回请求、工具完成时自动应答、视口外请求的等待确认浮条，以及未知工具更新。mock 记录每个权限请求的应答，由测试核对。独立的乐观变更用例通过手动时钟验证延迟 loading、超过 15 秒仍等待响应并阻止再次变更、取消、销毁和过期请求失败隔离。
`--target android` 在连接的 Android 设备上运行同一组交互（手动时钟用例除外）。UI 测试使用 ACP mock endpoint；`node --test tests/acp-client.mjs` 另外覆盖请求关联、纯响应确认、断线清理和非 ACP 服务端的拒绝，以及 initialize 数据在 Connected 回调前可读、session 生命周期内保留、缺省值、断开清理、初始化失败和取消后重连隔离。真实产品 agent 和真机仍需各自联调。

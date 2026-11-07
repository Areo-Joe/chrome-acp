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

发送时滚动到底部；之后用户离底部 48 pt 以内才跟随新内容。工具调用、权限请求、计划、图片 / 文件附件、编辑和重发、Queue 暂缓。

## 协议与生命周期

1. 通过 `acp/client.ts` 的 `AcpClient` 和 ACP SDK 的 WebSocket transport 发送 `initialize`，等待匹配的 JSON-RPC 响应后进入 Chat。服务端是 Rust CLI 的 `/acp` 端点，只透传标准 JSON-RPC。
2. 连接页要求填写服务端所在机器上的绝对工作目录，作为 `session/new.cwd`；会话创建等待其 RPC 响应取得 ID 和配置。
3. `AcpClient` 在会话创建期间有界缓冲提前到达的 `session/update`，按 session ID 应用命令更新，并消费后续命令、配置和 mode 通知。
4. 配置变更发送 `session/set_config_option`，boolean 请求带 `type: "boolean"`；旧 mode 发送 `session/set_mode`。等待对应 RPC 响应结束乐观变更：成功时展示响应的实际值，即使值被规范化或选项被移除，也立即结束等待。期间的匹配通知只更新服务端状态，不提前确认 RPC；后续失败仍可展示。mode 请求期间收到的权威通知会保留，空成功响应只在没有更新时采用请求值。SDK 根据请求 ID 关联错误，迟到失败不会取消后续配置变更。保留乐观目标值和 300 ms 延迟 loading；配置变更没有固定超时，对应 RPC 结束前持续等待并阻止下一次变更。session 创建仍为 30 秒超时。
5. session / 配置错误保留连接并展示错误；连接关闭、Disconnect、Chat 返回操作回到连接页，销毁草稿与 session 监听器。连接页内存中的地址和 token 保留。

Zed 此 revision 使用 `acp_v2`；此实现使用 nsh-client 自己依赖的 ACP SDK（2.4.0）的 v1 schema 和官方 JSON-RPC 实现。这里对照交互语义，以 SDK 实际类型为准，不复制 Zed v2 的 wire schema。

`state/optimistic-change.ts` 抽出单次乐观 RPC 变更的生命周期：接收 RPC Promise、当前值检查和错误回调，管理临时目标值、延迟 loading 及销毁；当前值检查仅用于跳过重复选择，操作由对应 Promise 的成功或失败结束。`state/composer.ts` 负责 ACP 字段映射和目标值的显示覆盖；服务端数据始终单独保留，因此失败时也能保留等待期间收到的其他配置更新。

本次 RPC 行为另对照本地 Zed `347f171a3f`：`agent_servers/src/acp/v1.rs` 的 `ConfigOptions::set_config_option` 使用响应中的配置；`agent_ui/src/config_options.rs` 的 `set_config_option_and_default` 明确处理规范化选择；`AcpSessionModes::set_mode` 在成功响应后不覆盖期间收到的 mode 通知。NSH 的乐观显示由输入区覆盖层承担，确认后的状态保存在 `AcpClient` 中。

## 验证范围

`node tests/connection.mjs` 覆盖连接、跳转、断开、草稿、命令、配置确认 / 拒绝、旧 mode、无配置以及 session 失败；`tests/thread.test.tsx` 用 mock 按 prompt 文本编排的回合覆盖流式回复与思考展开、回显去重、停止、拒绝、输出上限和失败。独立的乐观变更用例通过手动时钟验证延迟 loading、超过 15 秒仍等待响应并阻止再次变更、取消、销毁和过期请求失败隔离。
`--target android` 在连接的 Android 设备上运行同一组交互（手动时钟用例除外）。UI 测试使用 ACP mock endpoint；`node --test tests/acp-client.mjs` 另外覆盖请求关联、纯响应确认、断线清理和非 ACP 服务端的拒绝。真实产品 agent 和真机仍需各自联调。

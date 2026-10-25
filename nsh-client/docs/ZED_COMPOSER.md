# Zed 输入区对照

调研本地 Zed revision `50304070c283519f2f2338b45671af26374025fe`。
本轮目标：连接后进入 Chat，搭建输入区、消费 agent 的输入配置；暂不发送聊天消息。

## Zed 消费哪些数据

| 数据 / 状态 | Zed 源码 | 本轮 NSH 实现 |
| --- | --- | --- |
| 草稿、输入法组合、多行输入、编辑区展开 | `crates/agent_ui/src/message_editor.rs`；`conversation_view/thread_view.rs:5319` | 多行草稿、自动增高；输入法组合时隐藏补全；移动端回车换行 |
| `available_commands`：名称、说明、参数 hint | `message_editor.rs:49`、`:111`、`:642` | 输入 `/` 按前缀过滤；点击填入命令；有参数时补空格并展示 hint；命令完全由 agent 提供，支持动态更新 |
| session `config_options`：模型、模式、思考强度等 | `crates/agent_ui/src/config_options.rs`；`thread_view.rs:5453` | 按返回的 ID、名称、选项、当前值生成选择器；支持 select、分组与 boolean；超过 5 项提供搜索；选择后立即显示目标值，等待 agent 确认 |
| 旧版 session modes / models | `mode_selector.rs`、`agent_model_selector.rs` | 无 config options 时回退旧版 mode；模型通过当前共享协议的 model config option 提供 |
| `prompt_capabilities.image`、`embedded_context` | `message_editor.rs:49`；`thread_view.rs:6580` | 暂未接图片 / 文件 / 项目上下文入口；后续按能力启用，并接宿主能力 |
| session 运行状态、草稿是否为空、上下文是否加载完成 | `thread_view.rs:6456` | 暂不接发送状态机，发送按钮禁用，草稿保留；session 初始化失败可查看错误并断开 |
| token usage、profile、follow、fast/thinking、自有 skills | `thread_view.rs:5319`、`message_editor.rs:49` | 暂缓；其中部分属于 Zed 的项目或内置 agent 功能，不能假定任意 ACP agent 都会提供 |

Zed 发送按钮：上下文加载中显示 loading；生成中且草稿为空时 Stop；生成中有草稿时 Queue；空闲时 Send，空草稿禁用。后续接聊天时再实现这一状态机。

## 协议与生命周期

1. 通过共享 `DirectACPClient` 和 ACP SDK 的 WebSocket transport 发送 `initialize`，等待匹配的 JSON-RPC 响应后进入 Chat。proxy 以 `--acp` 启动，不使用旧版消息包装。
2. 连接页要求填写 proxy 所在机器上的绝对工作目录，作为 `session/new.cwd`；会话创建等待其 RPC 响应取得 ID 和配置，不发送 prompt。
3. `DirectACPClient` 在会话创建期间有界缓冲提前到达的 `session/update`，按 session ID 应用命令更新，并消费后续命令、配置和 mode 通知。
4. 配置变更发送 `session/set_config_option`，boolean 请求带 `type: "boolean"`；旧 mode 发送 `session/set_mode`。等待对应 RPC 响应结束乐观变更：成功时展示响应的实际值，即使值被规范化或选项被移除，也立即结束等待。期间的匹配通知只更新服务端状态，不提前确认 RPC；后续失败仍可展示。mode 请求期间收到的权威通知会保留，空成功响应只在没有更新时采用请求值。SDK 根据请求 ID 关联错误，迟到失败不会取消后续配置变更。保留乐观目标值和 300 ms 延迟 loading；配置变更没有固定超时，对应 RPC 结束前持续等待并阻止下一次变更。session 创建仍为 30 秒超时。
5. session / 配置错误保留连接并展示错误；连接关闭、Disconnect、Chat 返回操作回到连接页，销毁草稿与 session 监听器。连接页内存中的地址和 token 保留。

Zed 此 revision 使用 `acp_v2`；此实现使用仓库已有 ACP SDK 的 v1 schema 和官方 JSON-RPC 实现。这里对照交互语义，以 SDK 实际类型为准，不复制 Zed v2 的 wire schema。

`state/optimistic-change.ts` 抽出单次乐观 RPC 变更的生命周期：接收 RPC Promise、当前值检查和错误回调，管理临时目标值、延迟 loading 及销毁；当前值检查仅用于跳过重复选择，操作由对应 Promise 的成功或失败结束。`state/composer.ts` 负责 ACP 字段映射和目标值的显示覆盖；服务端数据始终单独保留，因此失败时也能保留等待期间收到的其他配置更新。

本次 RPC 行为另对照本地 Zed `347f171a3f`：`agent_servers/src/acp/v1.rs` 的 `ConfigOptions::set_config_option` 使用响应中的配置；`agent_ui/src/config_options.rs` 的 `set_config_option_and_default` 明确处理规范化选择；`AcpSessionModes::set_mode` 在成功响应后不覆盖期间收到的 mode 通知。NSH 的乐观显示由输入区覆盖层承担，确认后的状态保存在共享 client 中。

## 验证范围

`node tests/connection.mjs` 覆盖连接、跳转、断开、草稿、命令、配置确认 / 拒绝、旧 mode、无配置以及 session 失败；mock 明确拒绝 prompt。独立的乐观变更用例通过手动时钟验证延迟 loading、超过 15 秒仍等待响应并阻止再次变更、取消、销毁和过期请求失败隔离。
`--target android` 在连接的 Android 设备上运行同一组交互（手动时钟用例除外）。UI 测试使用 ACP mock endpoint；`node --test nsh-client/tests/direct-client.mjs` 另外覆盖请求关联、纯响应确认、断线清理，以及通过真实 `--acp` proxy 与 SDK agent 子进程联调本机文件和终端能力。真实产品 agent 和真机仍需各自联调。

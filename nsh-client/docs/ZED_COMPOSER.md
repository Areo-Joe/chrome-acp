# Zed 输入区对照

调研本地 Zed revision `50304070c283519f2f2338b45671af26374025fe`。
本轮目标：连接后进入 Chat，搭建输入区、消费 agent 的输入配置；暂不发送聊天消息。

## Zed 消费哪些数据

| 数据 / 状态 | Zed 源码 | 本轮 NSH 实现 |
| --- | --- | --- |
| 草稿、输入法组合、多行输入、编辑区展开 | `crates/agent_ui/src/message_editor.rs`；`conversation_view/thread_view.rs:5319` | 多行草稿、自动增高；输入法组合时隐藏补全；移动端回车换行 |
| `available_commands`：名称、说明、参数 hint | `message_editor.rs:49`、`:111`、`:642` | 输入 `/` 按前缀过滤；点击填入命令；有参数时补空格并展示 hint；命令完全由 agent 提供，支持动态更新 |
| session `config_options`：模型、模式、思考强度等 | `crates/agent_ui/src/config_options.rs`；`thread_view.rs:5453` | 按返回的 ID、名称、选项、当前值生成选择器；支持 select、分组与 boolean；超过 5 项提供搜索；等待 agent 确认后更新值 |
| 旧版 session modes / models | `mode_selector.rs`、`agent_model_selector.rs` | 无 config options 时回退旧版 mode；模型通过当前共享协议的 model config option 提供 |
| `prompt_capabilities.image`、`embedded_context` | `message_editor.rs:49`；`thread_view.rs:6580` | 暂未接图片 / 文件 / 项目上下文入口；后续按能力启用，并接宿主能力 |
| session 运行状态、草稿是否为空、上下文是否加载完成 | `thread_view.rs:6456` | 暂不接发送状态机，发送按钮禁用，草稿保留；session 初始化失败可查看错误并断开 |
| token usage、profile、follow、fast/thinking、自有 skills | `thread_view.rs:5319`、`message_editor.rs:49` | 暂缓；其中部分属于 Zed 的项目或内置 agent 功能，不能假定任意 ACP agent 都会提供 |

Zed 发送按钮：上下文加载中显示 loading；生成中且草稿为空时 Stop；生成中有草稿时 Queue；空闲时 Send，空草稿禁用。后续接聊天时再实现这一状态机。

## 协议与生命周期

1. 代理 `status.connected = true` 后进入 Chat；此时只确认 transport / agent 初始化完成。
2. 复用共享 `ACPClient` 发送 `new_session`，等待 `session_created`，取得 session ID、配置与能力。创建 session 不会发送 prompt，但会在 agent 侧创建会话。
3. 复用共享 client 对 session 创建前的命令更新的缓冲，以及后续命令、配置、mode 更新事件。
4. 配置变更发送 `set_config_option`；旧 mode 发送 `set_session_mode`。这些方法发送后即返回，因此 UI 继续等待权威更新；等待时禁用所有配置选择器，15 秒无确认显示错误。session 初始化 30 秒超时。
5. session / 配置错误保留连接并展示错误；连接关闭、Disconnect、Chat 返回操作回到连接页，销毁草稿与 session 监听器。连接页内存中的地址和 token 保留。

Zed 此 revision 使用 `acp_v2`，本仓库共享 ACP SDK 仍有不同的数据形状，例如 prompt capability 的布尔值。这里对照交互语义，以本仓库 proxy/shared 的实际类型为准。未复制 Zed v2 的 wire schema，也未新增独立的协议实现。

## 验证范围

`node tests/connection.mjs` 覆盖连接、跳转、断开、草稿、命令、配置确认 / 拒绝、旧 mode、无配置以及 session 失败；mock 明确拒绝 prompt。
`--target android` 在连接的 Android 设备上运行同一组交互（手动时钟超时用例除外）。这些测试使用 mock proxy，真实 agent 的差异需要后续联调。

# 会话历史与打开恢复（ACP v1）

基准是本地 Zed `62682ebde9e70b8a77a95863a2b16e9d59bf65eb`。
本轮只使用 `agent_servers/src/acp/v1.rs` 的 wire 行为；Zed 内部共享类型的
v2 命名不表示客户端协商或发送 v2。

| Zed 来源 | 本项目行为 |
| --- | --- |
| `v1.rs::AcpSessionList::list_sessions`、`thread_import.rs::collect_all_sessions` | 由 initialize 的 `sessionCapabilities.list` 控制。默认列出所有目录，省略 cwd；API 支持显式 cwd。cursor 原样透传，包括空字符串；同一 cursor 重复返回时停止分页。界面按需加载下一页，保留已经取得的页；失败重试原请求。 |
| `v1.rs::load_session` / `resume_session`、`conversation_view.rs::initial_state` | 优先 load，其次 resume；二者均不支持时不发送请求，不创建替代会话。使用目标 SessionInfo 的 cwd；additionalDirectories 按能力保持顺序传递。恢复前注册 ID，接收响应前历史。resume 明确提示 earlier messages 未回放。 |
| `v1.rs::register_session`、`handle_session_notification`、权限路由 | 一个连接保存多个会话注册，每个打开的会话拥有独立 composer、thread、草稿、配置、命令和 RPC 生命周期。通知和权限请求按 sessionId 路由；未知或已移除 ID 被忽略／拒绝。 |
| `agent_panel.rs` 的现有 thread 查找及后台线程保留、`v1.rs::open_or_create_session` | 打开已存在的 view 直接选中，不重新 load；新聊天复用 initialize 后的连接。切换不取消后台生成，也不移动草稿。打开期间发生错误保留目标身份和目录，Retry session 仍打开原会话；失败 replay 的消息及配置不会作为可用聊天保留。 |
| `conversation_view.rs` 的认证 reset、`v1.rs::release_session` / `close_session_and_drain` | 单个 view 认证后重建自己的会话，其他打开 view 保留。沿用 close 能力判断、失败记录、已接收消息排空和旧 RPC 归属隔离。load/resume 失败也先排空旧 replay、再解除 pending 操作，保留原始错误。 |
| `acp_thread/src/connection.rs::AgentSessionInfo::apply_update` | title / updatedAt 缺省表示不更新，显式 null 清空；无效 RFC3339 更新时间忽略；v1 `_meta` 整块替换，缺省／null 不修改。标题、时间同步到列表及已打开 view。列表请求期间到达的更新按字段保留；后续新刷新可以采用更新的列表结果。 |
| `v1.rs::AcpSessionList::delete_session` | 仅声明 delete 时提供操作，用户先确认；RPC 成功或 ResourceNotFound(-32002) 后刷新列表，其他错误保留列表并允许重试。删除已打开的空闲会话后销毁其本地 owner，切回其他打开 view；没有其他 view 时新建聊天。生成或恢复中的会话先禁用删除操作。 |

客户端不保存聊天的磁盘副本，历史来源始终是 agent。打开的 view 在当前连接内保留；
空闲后台 view 对齐 `agent_panel.rs::cleanup_retained_threads` 的默认 5 个上限；
`createSessions` 的 `maxIdleRetainedThreads` 可覆盖该值，包括 0。筛选顺序与
`cleanup_retained_threads` 一致：先排除当前 view 和无法独立保存的输入；没有建立
root thread 的后台 view 可以回收，不要求 load 能力；已有 root thread 时才要求
load 能力及 `is_idle_for_retention`。因此无 load／resume-only agent 的失败 view
仍遵守后台上限，已经建立的 resume-only thread 则保留。是否存在 root thread 用
成功完成 new/load/resume 的独立状态记录，不以目标 sessionId 或 phase 字符串猜测。

普通文本草稿在当前连接的独立草稿表中保存，已知 ID 的 view 回收后重新打开会恢复
草稿，不能自动发送。尚无 ID 且已有输入的 view 保留，避免丢失无法另存的输入。
更新顺序取本地会话事件，服务端 updatedAt 只用于历史列表，不决定 view 回收顺序。
后台回合结束或权限状态改变后再次检查上限。
新增 view 与切换当前 view 原子提交，对齐 Zed 先替换 base_view 再保留旧 view 的顺序；
默认上限和零上限下，新的加载中 view 都不会被当成后台候选误回收。

回收同时销毁 composer 和连接内 session owner，取消该 owner 未完成的配置及认证
任务。正在 new/load/resume 的无 root view 回收后，连接层继续持有 wire 操作的完成
屏障，view 的 Promise continuation 立即结束；成功返回的废弃会话再按能力 close，
失败操作只排空消息。替代 owner 等待旧操作和释放完成后才能注册相同 ID。
若声明 close，等待关闭；关闭错误记录后继续，随后排空已接收通知。连接保存按 ID
索引的 pending release；其他 owner 打开同一 ID 时等待该屏障。新连接清空旧屏障，
旧清理任务无法移除新连接的注册。已回收会话的小量目录／标题元数据保留在列表，
不保留消息实体；即使 agent 不支持 session/list，也能再次打开当前连接中已知的 ID。

断开后销毁这些 owner 和连接内草稿，再连接时重新向 agent 获取历史。无 list 能力时，Sessions
仍可切换当前连接内已打开的聊天，并明确提示不支持远端历史。

## 解码与验证

`tests/fixtures/history-v1.json` 的 25 组样本由 Zed Cargo.lock 锁定的 Rust schema
1.15.1（unstable）实际解码生成，附 `history-v1-reference.rs`。列表字段必填；
无效列表回落为空，无效项按 VecSkipError 跳过。SessionInfo 的目录、附加目录、
可选标题、时间、元数据及 serde 位置序列遵循该版本规则；archive 字段如同 Zed
v1 的 AgentSessionInfo 适配器不映射到本轮的历史条目。

`tests/history-client.mjs` 覆盖样本、能力控制、删除结果、多个会话共享连接、目录与
附加目录传递、消息／配置归属、权限路由、未知与移除会话、断线清理、重复 ID、
空 ID 和信息更新的 null／元数据规则。
`tests/sessions.test.tsx` 使用真实 WebSocket mock 覆盖分页、列表和页失败重试、
新建与切换、独立草稿和历史、后台生成、恢复失败重试、认证后打开历史、resume
提示、删除确认／失败／切回、能力差异、实时元数据与列表响应交错。

`tests/retention.test.tsx` 覆盖默认／零上限、活动顺序、草稿恢复、生成中与权限等待、
Stop 后未完成的 prompt、resume-only、关闭能力差异及释放屏障，以及有／无 load
能力的失败 view 和未知 ID 输入保护。协议测试另覆盖废弃 new/load/resume 的成功／
失败结果及认证任务的取消。

运行（Node.js 26）：

```sh
node --test nsh-client/tests/acp-client.mjs nsh-client/tests/history-client.mjs
node nsh-client/tests/connection.mjs
```

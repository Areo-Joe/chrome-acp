# Zed v1 message queue

Reference: local Zed `62682ebde9e70b8a77a95863a2b16e9d59bf65eb`.
This integration follows external ACP v1 prompt completion. The queue is local
to the client and uses existing `session/prompt` and `session/cancel` only.

| Behavior | Zed source under `crates/` | NSH implementation |
| --- | --- | --- |
| Stable IDs, FIFO, AutoProcess / Paused / AbsorbingCancel, fast-track flag | `agent_ui/src/conversation_view/message_queue.rs` | `state/message-queue.ts` |
| Nonempty generating draft queues; empty editor may fast-track once | `agent_ui/src/conversation_view/thread_view.rs::send`, `queue_message` | `state/composer.ts::submit` |
| Cancel and wait before sending; restore failed dispatch by original ID and pause | `thread_view.rs::dispatch_queued_entry` | `dispatchQueued`, `thread.cancelForQueue` |
| Stop pauses; enqueue and ordinary send resume; idle Send Now preserves pause | `thread_view.rs::cancel_generation`, `send_impl`; queue state machine | `stop`, `sendDraftDirect`, `sendNow` |
| Send Immediately cancels before sending the current main draft, bypassing empty-editor fast-track and local login interception | `thread_view.rs::interrupt_and_send` | `sendImmediately` |
| Auto-send is driven by Stopped; focused first entry defers it; blur alone does not send | `thread_view.rs` thread-event subscription | `thread.onStopped`, `handleQueueStopped` |
| Successful v1 responses including refusal emit Stopped; max_tokens and RPC errors do not | `acp_thread/src/acp_thread.rs::run_turn` | `state/thread.ts::settle` |
| Edit or input attempt moves entry into main editor; append after two newlines when nonempty; Up on empty main retrieves last entry | `thread_view.rs::handle_queue_editor_event`, `move_queued_message_to_main_editor`, `handle_message_editor_move_up` | `editQueued`, `editLastQueued`, queue/main input bindings |
| Expanded by default, count, Clear All, bounded scroll, first-entry indicator, delete/edit/Send Now | `thread_view.rs::render_message_queue_summary`, `render_message_queue_entries` | `components/MessageQueue.tsx` |
| Recovery rebuilds queue paused; idle view reclamation retains saved input independently | `thread_view.rs` recovery; `agent_ui/src/agent_panel.rs` draft stores and retention | `restoreQueue`, `state/sessions.ts::savedQueues` |

Dispatch removes the entry before awaiting cancellation. During that wait the
view retains ownership of it, blocks another dispatch and absorbs the old
completion exactly once. A cancellation failure restores the entry before the
next higher ID, retaining edits/removals made to other entries during the wait.
Disposal or authentication recovery invalidates the pending continuation.

Automatic dequeue leaves the fast-track flag unchanged, as Zed does. Clear All
clears the entries and flag while retaining the processing state and ID counter.
A manual Stop remains paused until a fresh ordinary send or enqueue resumes it.
Sending one paused entry with idle Send Now leaves subsequent entries paused.

Each session owns its queue. Background sessions continue independently. Idle
view eviction stores queued content alongside the draft for the lifetime of the
connection; opening it again restores a paused queue. Authentication recovery
also restores it paused, with no automatic prompt replay. A pending dispatch or
recovery remains retained until its owner can safely be reclaimed.

NSH host adaptations: queue actions stay visible on touch screens. The preview
keeps queued source content immutable, with text typing/paste attempts promoted
into the main editor. AppKit suppresses those attempts in a noneditable text
view, so macOS uses an editable preview to capture them and rebuilds the preview
on a rejected deletion. Composition is deferred until commit. Other hosts use
a read-only Input. A focused preview also handles the paste shortcut explicitly.
Desktop Enter sends,
Mod+Enter follows ordinary send, Mod+Shift+Enter sends immediately, and
empty-editor Up edits the last queue entry. Shift+Enter is ignored in queued previews;
touch keyboards keep newline entry and the action buttons. Queue previews use
one to ten lines, inside a 160px scroll area. Existing attachment composition is
still unavailable; unsupported edit attempts preserve the queued source and
report an error. Native-agent steering is outside the external ACP v1 path.

Validation:

- `tests/fixtures/queue-v1-reference.rs` copies Zed's state machine, reducing
  GPUI-owned entries to data. Its recorded output in `queue-v1.json` contains
  16 operation traces (129 transitions), including mixed transitions; `tests/message-queue.mjs`
  compares every transition with the TypeScript implementation.
- `tests/queue.test.tsx` exercises real WebSocket prompt/cancel ordering,
  completion outcomes, focus and keyboard behavior, queue editing, restoration,
  background dispatch, authentication, eviction, cancellation failures and
  disposed continuations. `QueueTestApp.tsx` is a test-only root entry for native
  asset resolution and mock controls; production does not import it.

Run from the repository root using Node.js 26:

```sh
node --test nsh-client/tests/message-queue.mjs
node nsh-client/tests/connection.mjs --file tests/queue.test.tsx
node nsh-client/tests/connection.mjs --file tests/queue.test.tsx --target macos
node nsh-client/tests/connection.mjs
```

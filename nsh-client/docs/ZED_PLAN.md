# Ordinary ACP v1 plan

Reference: `/Users/joe/Workspace/zed`, commit
`62682ebde9e70b8a77a95863a2b16e9d59bf65eb`.

| Behavior | Zed reference | NSH implementation |
| --- | --- | --- |
| Receive the complete plan snapshot, retain entry and plan metadata | `acp_thread.rs::update_plan`, `replace_plan`, `replace_plan_entries` | `Thread.handleUpdate`, index-keyed Markdown rows |
| Every ordinary plan notification makes the plan visible, including an identical snapshot | `replace_plan` with `PlanIdentity::Legacy` | `planVisible` is set on each notification |
| Clear Plan hides locally; no RPC or removal of stored entries | `clear_plan` | `dismissPlan` |
| Remove only completed entries at the start of the next send, after successful synchronous cancellation initiation and before awaiting cancellation | `run_turn`, `clear_completed_plan_entries` | `Thread.send` |
| Initially collapsed; preserve expansion across notifications, dismissal, and retained view switches | `ThreadView::plan_expanded`, `render_plan_summary` | `Thread.planExpanded` belongs to the retained conversation view model |
| Hide absent/empty plans; show above the composer | `render_activity_bar` | `PlanView` in `Conversation` |
| First in-progress entry in wire order; pending count includes every in-progress entry | `Plan::stats`, `render_plan_items_title` | `planStats` |
| Expanded summary: All Done, total Tasks, or completed/total | `plan_summary_label` | `planSummary` |
| Markdown rows, completed strikethrough/success icon, spinning progress icon, pending icon, 160px scroll limit, full-content tooltip | `render_plan_entries`, `plan_label_markdown_style` | `PlanView` |

The wire protocol remains v1. This implementation handles ordinary `plan` only.
Keyed plans, `plan_update`, `plan_removed`, Markdown/file plans, and beta plan
capabilities are outside this change. The current locked v1 schema accepts
pending/in_progress/completed and high/medium/low; invalid or unknown entries
are skipped by Rust's `DefaultOnError<VecSkipError<_>>` policy.

`decodePlan` follows that schema, including optional metadata, positional entry
structs, and externally tagged unit variants. A stream transform canonicalizes
ordinary plans before SDK validation; the SDK retains transport framing and
notification ordering. Other notification payloads pass through unchanged.

The Rust oracle and 34 recorded cases are in `tests/fixtures/plan-v1-reference.rs`
and `plan-v1.json`. Their pinned dependencies are documented beside the initialize
oracle. Run from the repository root using Node.js 26:

```sh
node --test nsh-client/tests/acp-client.mjs nsh-client/tests/history-client.mjs nsh-client/tests/plan-client.mjs
node nsh-client/tests/connection.mjs --file tests/plan.test.tsx
node nsh-client/tests/connection.mjs --file tests/plan.test.tsx --target macos
node_modules/.bin/tsc --project nsh-client/tsconfig.json --noEmit
```

The tests cover the Rust decode fixtures, real WebSocket routing and load replay,
snapshot replacement, metadata replacement, visibility/expansion, next-turn
cleanup, synchronous/asynchronous cancellation failures, stop/refusal/error,
independent retained/background sessions, authentication rebuild, and disposal.

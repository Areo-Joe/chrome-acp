# Ordinary ACP v1 context usage and cost

Reference: `/Users/joe/Workspace/zed` at
`62682ebde9e70b8a77a95863a2b16e9d59bf65eb`, ACP v1 schema 1.15.1.

| Behavior | Zed source | NSH implementation |
| --- | --- | --- |
| Required unsigned used/size; optional cost and metadata use DefaultOnError | `schema/v1/client.rs::UsageUpdate`, `Cost` | `acp/client.ts::decodeUsage` |
| Replace context counters; replace a supplied cumulative cost, never add it | `acp_thread.rs::update_session` v1 UsageUpdate branch; `update_usage` | `state/usage.ts::applyUsage` |
| Missing/null/invalid optional cost leaves the previous cost unchanged | v1 maps None to Undefined, never Null | Decoder omits invalid cost; applyUsage preserves the old cost |
| Preserve cost currency and metadata; usage notification metadata is not stored in thread usage state | `update_usage` | `ContextUsage` holds used, size, cost |
| No usage until reported; send, stop, refusal and errors retain it | AcpThread initialization and run_turn | Thread usage signal and notification handler |
| Discard usage/cost with a rebuilt or failed thread; receive replay for registered IDs; retain inactive-session usage independently | Thread/view lifecycle and v1 session registry | Existing session ownership, Thread.reset/dispose |
| External ACP uses one context ring, with Context and optional Cost details | `thread_view.rs::supports_split_token_display`, `render_token_usage`, `TokenUsageTooltip::render` | `components/ContextUsage.tsx` |
| Ring 16px, stroke 2px, radius 6px, clockwise from top; progress clamped to [0,1] | `ui/components/progress/circular_progress.rs` | Native Canvas |
| Ratio and percentage use f32 arithmetic; size=0 gives 0%; tooltip can exceed 100%; ring warns at ratio >= 0.85 | `render_token_usage` | `usagePresentation` |
| Token labels use Zed's k/M boundaries and carry rules | `agent_ui.rs::humanize_token_count` | `humanizeTokens` |
| Cost: 4 decimals for 0 < amount < 0.01, otherwise 2, followed by currency | `render_token_usage` | `fixedCost` / usagePresentation |

Rust fixed float formatting rounds the exact binary number, ties to even.
`fixedCost` decomposes the IEEE-754 value and rounds with integers so values
such as 0.125 match Rust's `0.12`, including negative zero and large amounts.
The protocol decoder uses the SDK's JavaScript number representation for counters.
Integers above Number.MAX_SAFE_INTEGER can be rounded by the transport's JSON
parser before decoding. In particular, a wire u64::MAX rounds to 2^64 and is
rejected by the u64 range check. Exact handling of that transport boundary
remains a difference from Rust; the recorded cases include representable large
integers and invalid overflow values, but do not claim lossless u64 transport.

Desktop details follow pointer hover; moving away hides them. Touch screens
use the ring button to show/hide the same detail content. Appearance updates
with the app's light/dark theme. A reset also closes the touch detail state.
No extra RPC or capability advertisement is required.

This change handles ordinary v1 usage_update. It does not enable ACP beta or
consume beta-only per-prompt input/output statistics. Native Zed model split
usage and editor project-rule details are not supplied by an external ACP thread.

Validation:

- `tests/fixtures/usage-v1-reference.rs` uses Zed's pinned Rust dependencies
  (documented in initialize-v1-reference.rs), decoder, token formatter, and UI
  ratio/cost formulas to produce 110 recorded cases in usage-v1.json.
- `tests/usage-client.mjs` checks those results, raw WebSocket notifications,
  optional-cost retention, unknown IDs, and replay before load completion.
- `tests/usage.test.tsx` checks both input and display behavior, hover/touch,
  theme changes, zero/over-capacity values, prompt outcomes, metadata, reset,
  disposal, background sessions, failed replay, authentication, and eviction.

Run from the repository root with Node.js 26:

```sh
node --test nsh-client/tests/acp-client.mjs nsh-client/tests/history-client.mjs nsh-client/tests/plan-client.mjs nsh-client/tests/usage-client.mjs
node nsh-client/tests/connection.mjs
node nsh-client/tests/connection.mjs --file tests/usage.test.tsx --target macos
node_modules/.bin/tsc --project nsh-client/tsconfig.json --noEmit
```

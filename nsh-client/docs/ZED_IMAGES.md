# Zed ordinary ACP v1 images

Reference: local Zed `62682ebde9e70b8a77a95863a2b16e9d59bf65eb`.
Image input uses standard v1 `session/prompt` content blocks. No v2 negotiation
or additional ACP method is introduced.

| Behavior | Zed source under `crates/` | NSH implementation |
| --- | --- | --- |
| Capability-gated picker | `agent_ui/src/message_editor.rs::SessionCapabilities::supports_images`, `add_images_from_picker` | `Composer`, `supportsImages` |
| Text paste wins over images; bitmap avoids duplicate image paths | `message_editor.rs::paste_item`, `resolve_pasted_context_items` | `pastedImages` |
| Selection, image order and identity, deletion/undo/redo of its placeholder | `agent_ui/src/mention_set.rs::insert_images_as_context` and editor anchors | `state/draft.ts`, native Input selection |
| Each transaction owns independent pre-edit and post-edit selections | `editor/src/editor.rs::TransactionSelections`, `start_transaction_at`, `end_transaction_at`, `undo`, `redo` | `DraftHistory` transactions; caret moves do not mutate history |
| Accepted replacement ranges preserve identity even when text is unchanged | editor buffer edits and mention anchors | `pasteText`, `editDraftRange`; general native edits remain limited by the stock SDK |
| External files are identified from their contents before insertion | `mention_set.rs::load_external_image_from_path` | `readImageSource`, shared Rust format sniffing; names/extensions are labels |
| Batch insertion waits for each image conversion and failure cleanup, then reads the current selection for the next insertion | `mention_set.rs::insert_images_as_context` | `addImages`, per-image editor transactions |
| Capture mention registrations at resolution start, await their results, then build current editor chunks; later mentions remain ordinary link text | `mention_set.rs::contents`, `message_editor.rs::build_content_blocks`, `build_chunks_from_creases` | `imageMentions`, `waitForInput`, resolved `draftContent` |
| Await conversion before resolving contents; failure removes only its mention and releases its source | `mention_set.rs::contents`, `insert_images_as_context`, `message_editor.rs::build_content_blocks` | pending tasks, `waitForInput`, selective `clearMentions` |
| Outer whitespace trim, text segments between images, image-only input | `message_editor.rs::build_chunks_from_creases` | `draftContent` |
| New blocks use PNG base64 and a named pasted-image URI | `message_editor.rs::mention_to_content_block` | `prepareImage` |
| 1568px bounds, PNG encoding, up to eight 0.85 scale passes to fit 5 MiB binary bytes | `language_model/src/request.rs::language_model_image_from_dynamic_image` | shared Rust `image-codec` |
| f32 bounds truncate to u32 before aspect-preserving resize | `gpui/src/style.rs::ObjectFit::ScaleDown`, `gpui/src/geometry.rs::From<Pixels> for u32` | same calculation and Triangle filter |
| Queue/edit/append/Send Now/cancellation rollback preserve sources | `conversation_view/thread_view.rs` queue methods | `Composer`, `MessageQueueView` |
| Failed authentication restores input and waits for explicit resend | `ConversationView` recovery and editor restoration | `authenticateFailedPrompt` |
| Idle view reclamation preserves saved input independently | `agent_ui/src/agent_panel.rs` draft stores | `savedDrafts` includes images |

The native Input uses one object replacement character per image in place of
GPUI's inline crease. Thumbnails and remove actions appear below the input;
previews also appear in queues and user-message history. Selection identifies
the image being deleted even with identical adjacent markers. Clicking an image
expands/collapses its preview. This is the native UI adaptation; source blocks
retain their position relative to text. Editor transactions retain image IDs,
source blocks and independent per-transaction undo/redo selections, including conversion completion
while an image is removed. Conversion failure removes its placeholder and source; undo can restore its ordinary mention-link text, while other image sources remain registered. Transactions use Zed's 300 ms grouping
interval (zero in controlled model tests). Only explicit undo/redo commands
restore attachment snapshots; ordinary text edits and pasted object markers
never infer attachments from historical text. Text paste is handled with its
explicit replacement range (`pasteBehavior="report"`), including replacements
whose resulting text is identical. A batch inserts one image at a time and waits for its conversion and failure cleanup before proceeding, matching Zed. Each insertion reads the current selection and participates independently in normal transaction grouping. Disposal stops the remaining batch.

Both hosts use the unmodified, pinned NSH SDK. There is no vendored platform
backend or Android AAR rewriting. Native inputs expose their standard value,
key and selection events only. General edits therefore use the value/selection
fallback; ambiguous adjacent image markers and native Edit-menu undo/redo are
not claimed to match Zed. Application keyboard undo/redo retains its own draft
transactions. Full parity in those native boundaries requires an upstream SDK
capability; local NSH source patches have been withdrawn.

Both hosts use Rust `image` 0.25.10, matching Zed's lockfile, including its PNG
encoder and resize filter. The picker requests original formats; the codec
identifies supported raster formats from source bytes. Missing or incorrect
extensions and platform MIME aliases do not override the content. External
files are read before insertion; unsupported content is skipped. Conversion
uses that captured source, so a later path change cannot replace the image. Restored source images retain their data
rather than being reprocessed on every editor/session rebuild.

`image.normalize` is an NSH application-host function, outside ACP. It prepares
local image bytes or a selected image path. macOS registers it on the embedding
channel; Android calls the same library through JNI. Image work runs off the
UI/engine thread. The ACP client continues to advertise no filesystem/terminal
capabilities. Use `just macos` / `just android`; NSH's generic development host
does not supply this application's image bridge.

Sending snapshots the mention registrations, including sources whose placeholders
were deleted and remain undoable. It waits for that fixed source set, then reads
the current editor. Later image mentions remain ordinary link text, matching
Zed's unresolved-crease behavior; pending placeholder data is never emitted as
an image block. Ordinary deletion preserves registrations; failed conversion or
clearing the editor releases them.

Tasks belong to their original composer. Removal/disposal cannot resurrect
sources or submit into a replacement view. A send waiting for conversion retains
its owner and reports errors without sending automatically. A failed conversion deletes only its image mention, leaves the trailing space, and releases that source from undo/redo history as Zed does. Other draft contents remain editable and sendable. Queue intent is captured
before conversion, matching `queue_message` if generation ends during that wait.

Validation:

- `images-v1-reference.rs` copies Zed's chunk builder with GPUI lookups replaced
  by byte spans. `images-v1.json` records 16 Rust cases; `image-draft.mjs` checks
  those and selection/removal/append boundaries and transaction history (32 tests).
- Rust codec tests cover PNG color/alpha, JPEG conversion, fractional bounds,
  encoded byte limits, content recognition, picker MIME aliases, extensionless local files and errors (9 tests).
- `images.test.tsx` covers picker order, capability gating, paste, image-only
  messages, echoes, editing, queues, auth, history, eviction and task lifecycle
  (38 tests). Its bridge uses known codec outputs; a model fixture controls
  delayed/rejected conversions separately.
- `images-native.mjs` builds the production macOS host and runs NSH's native
  driver. Ten scenarios use real image bytes and the real Rust bridge, without
  host mocks. They cover clipboard input, keyboard undo/redo, queues, auth,
  history, file recognition and plain marker paste. System picker mocks are
  headless-only. The former patched-backend range/menu checks were removed
  when the NSH source patches were withdrawn.

Run from the repository root with Node.js 26:

```sh
node --test nsh-client/tests/image-draft.mjs
cargo +stable test --manifest-path nsh-client/image-codec/Cargo.toml --locked
node nsh-client/tests/connection.mjs --file tests/images.test.tsx
node nsh-client/tests/images-native.mjs
node nsh-client/tests/connection.mjs
```

Android builds the codec for arm64-v8a, armeabi-v7a, x86_64 and x86 with NDK
29.0.14033849. Device interaction requires a connected device/emulator;
APK compilation is separate from that validation.

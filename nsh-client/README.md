# NSH Client

A connection form and Chat composer with a shared TSX entry and custom macOS / Android hosts. The repository selects NSH; a global NSH installation is not used.

```sh
cd nsh-client
just macos
just android
# Select a device when several are connected:
just android SERIAL
```

Keep the command running while editing. Saving TSX updates the running UI.
Rust/Kotlin host changes require restarting the command. Ctrl-C stops the dev
server and host; Android also removes its USB port forwarding. The servers start
at ports 8790 / 8791, using the next available port when needed.

## Connection screen

Start the Rust CLI from the `refactor/rust_cli` branch. It relays each WebSocket
connection to a new agent process over stdin/stdout and prints its auth token:

```sh
cargo run --manifest-path cli/Cargo.toml -- --port 9315 -- dsh --profile acp
```

Enter a WS/WSS server URL, the token, and the absolute working directory on the
server machine, then press Connect. The address defaults to
`ws://127.0.0.1:9315/acp` and is used as entered, including its path and query
parameters. The token is
sent as the `token` query parameter: NSH and browsers cannot set an
`Authorization` handshake header. The server rejects a wrong token or a failed
agent spawn before the upgrade, which the app reports as a connection it could
not open. The agent's stdout must carry only ACP JSON lines.
Connected is shown only after the agent answers ACP `initialize`.
The screen supports loading, cancellation, disconnect, errors and a 30-second
connection timeout. Inputs are locked while connecting/connected, and Connect is
disabled for invalid addresses or an active connection. Settings are held in memory only.

After connecting, the app opens Chat and creates an ACP session to obtain its
configuration and advertised commands. The bottom composer supports multiline
drafts, slash-command completion and argument hints. Configuration
selectors follow the agent’s current options (including grouped selects and
booleans), with legacy mode fallback. Selections display the target immediately;
a spinner appears after 300 ms while waiting for agent confirmation. Configuration
changes run one at a time until their RPC response settles. Success displays the
returned state even when the agent normalizes a value or removes an option;
matching notifications alone do not finish a pending RPC. A mode notification
received while waiting takes precedence over the requested mode on success.
Configuration changes have no fixed timeout; selectors stay pending until the
RPC succeeds, fails, or the connection closes. Rejection reveals the latest
confirmed value and an error without dropping the connection. Disconnect or Back returns to the
connection form.

Send submits the draft, without trailing whitespace, as a `session/prompt`; the message shows at once,
and an agent's echo of it is not shown twice. The reply streams in as Markdown,
revealed smoothly, with the agent's thinking open while it streams and collapsed
once the agent moves on. Stop sends `session/cancel` and ends the turn at once.
A refusal removes the refused message and names the agent; output limits and
failed prompts show an error that can be dismissed, and refusals and failures can
also be copied. Sending while a turn runs (Zed's queue) is
deferred: Stop replaces Send until the turn ends.

Tool calls show in the thread as Zed shows them: a line with the tool's icon and
title that opens to its input and output, or a card for edits (with their diff),
commands and tool calls waiting for permission. A permission request lists the
agent's options; the choice is sent back, and Stop, the agent withdrawing the
request, or the tool finishing on its own answer it as cancelled. See
[the Zed comparison](docs/ZED_COMPOSER.md) for the source references and deferred features.

`acp/client.ts` is the app's ACP client: the official ACP SDK (`@agentclientprotocol/sdk`,
v1 protocol) and its WebSocket transport send standard JSON-RPC objects; a server
that answers with anything else is reported instead of answered. Configuration
requests await their own RPC result, so a late error cannot reject an unrelated
change. The client advertises no file or terminal capabilities, so the agent uses
its own.

Protocol selection is `"v1" | "auto"`, with `DEFAULT_ACP_PROTOCOL_MODE = "v1"`.
`AcpClientSettings.protocolMode` can override it. `auto` is TODO / unimplemented
and fails before opening a connection. Current implementation and Zed comparisons
target ACP v1; v2 negotiation and fallback are deferred.

`nsh-client` is a pnpm project of its own, with its own `package.json` and
lockfile, outside the repository's workspace. Run `pnpm install` in `nsh-client/`
(Node.js 26) before type checking, building or testing. For protocol/UI tests
(a local ACP mock endpoint):

```sh
node tests/connection.mjs                  # headless, including timeout
node tests/connection.mjs --target android # device, with mock-server USB forwarding
node --test tests/acp-client.mjs           # the ACP client against mock endpoints
```

The device runner uses NSH's standard test host; `just android` uses our custom
Kotlin/Compose host. After device tests, use `just android` to reopen this app.
The mock server binds port 19437; it must be free.

## Pinned toolchain

The exact `nsh-platform-macos` dependency in `native-host/Cargo.toml` is the single
NSH version declaration (currently `=0.4.0`). `Cargo.lock` pins the macOS SDK's
resolved dependencies. `nsh-toolchain.sha256` records the SHA-256 checksums of
the official distribution archives for the supported development machines.

`just macos` and `just android` call the Rust CLI in `cli/`, which prepares the
toolchain before starting the host:

1. Reads that version and selects the machine's official release archive.
2. Downloads it, verifies its committed SHA-256, checks its CLI version and SDK
   files, and publishes it to a user cache only after verification succeeds.
3. Links `.nsh/toolchain` to the cached distribution. The CLI, runtime and Android
   AARs all come from this directory, never from the global NSH installation.

You can run `just setup` separately. Cached setup requires no network. Downloads
are serialized with a per-version lock, so concurrent macOS / Android launches
share the same installation. Failed downloads leave no completed installation.
The installation lock is owned by the operating system and is released even if
the process is killed; no stale lock directory needs manual cleanup.
The macOS SDK crates are downloaded separately by Cargo into its standard shared
cache, using the same NSH version; they are not included in the CLI archive.
No NSH source checkout is needed.

Cache locations:

- macOS: `~/Library/Caches/chrome-acp/nsh/`.
- Linux: `~/.cache/chrome-acp/nsh/`.
- `XDG_CACHE_HOME` overrides the cache base on either system.

Deleting `.nsh/` only removes the project link and generated files. The next run
reuses the user cache. To reclaim a downloaded release, remove its version
folder from that cache when no development host is using it.

To upgrade NSH, update the exact Cargo dependency and refresh its `Cargo.lock`,
then update the archive checksums from that official release. Commit these
changes together and verify both hosts and TSX hot updates. An outdated checksum
causes setup to fail; it never silently installs another release.

This follows the repository version selection used by [rustup](https://rust-lang.github.io/rustup/overrides.html#the-toolchain-file)
and verified distribution caching used by the [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html).
The archive layout follows [NSH's official distribution documentation](https://nsh.dev/docs/installation/).

## Requirements

Shared: `just`, Rust stable (via rustup), Bash, `curl` and `tar`. No global `nsh`
or Python is required. The first command builds the repository CLI; subsequent
commands reuse the compiled binary. Archive SHA-256 verification runs in Rust.
First setup needs network access to GitHub; macOS Cargo builds and Android Gradle
builds also need their dependencies downloaded on first use.

Supported development machines: Apple Silicon macOS and x86_64 Linux, matching
the pinned prebuilt NSH distributions. Windows and Intel Macs are not configured.
The macOS host requires macOS 14+, Rust stable and Xcode Command Line Tools.
The recipe ad-hoc signs the local `.app` after copying the host executable.

Android requires JDK 17, Android SDK platform 37 / build tools / platform-tools,
and a USB-debuggable device or emulator. On macOS the recipe locates JDK 17;
elsewhere set `JAVA_HOME`. Set `ANDROID_HOME` / `ANDROID_SDK_ROOT` for a custom SDK
location (the recipe defaults to `~/Library/Android/sdk`). Gradle is pinned by its
wrapper. The pinned AARs' native libraries are aligned for 16 KB pages.

## Layout and Android Studio

- `App.tsx`: connection-driven navigation.
- `pages/`, `components/`: Connect / Chat pages and the bottom composer.
- `icons/`: SVG icons from the official [Lucide](https://lucide.dev) 1.67.0 release, unmodified, with its license.
- `acp/`: the ACP client over WebSocket.
- `state/`: connection and ACP session/configuration state.
- `native-host/`: Rust/AppKit host; connects to the dev server when given a URL.
- `android-host/`: Kotlin/Compose host embedding NshView with AndroidView.
- `justfile`: small command entry points; builds and delegates to the Rust CLI.
- `cli/src/toolchain.rs`: version selection, downloads, SHA-256 verification and cache.
- `cli/src/dev.rs`: macOS / Android build, install and host lifecycle.
- `cli/src/server.rs`: dev-server startup, logs and actual port discovery.
- `cli/src/process.rs`: command execution and child-process cleanup.

Android Gradle's `setupNsh` task invokes the same `just setup`, even when launched
from Android Studio. It then builds TSX with `.nsh/toolchain/bin/nsh` and uses
that distribution's `nsh-dev.aar` for debug and `nsh.aar` for release. Ensure the
IDE's environment can find `just`, Cargo/rustup, Bash, `curl` and `tar`.
`just android` passes a dev-server URL; launching from Android Studio without that
extra uses the bundle packaged in APK assets.

## Checks

From `nsh-client/`:

```sh
pnpm install
just setup
cargo +stable test --manifest-path cli/Cargo.toml --locked --target-dir .nsh/cli-target
.nsh/toolchain/bin/nsh check .
cargo +stable check --manifest-path native-host/Cargo.toml --locked
# With JDK 17 and the Android SDK configured:
./android-host/gradlew -p android-host :app:assembleDebug
```

Android APK: `android-host/app/build/outputs/apk/debug/app-debug.apk`.
Dev logs: `.nsh/macos-dev.log` and `.nsh/android-dev.log`.

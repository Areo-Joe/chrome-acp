# Proxy Server

Follow the repository's root `AGENTS.md`.

- Use pnpm for dependency management and workspace commands.
- Keep runtime code compatible with Node.js, including Android Termux.
- Use Node.js APIs and the existing Hono HTTP/WebSocket stack.
- Build this package with TypeScript (`tsc`). Both frontends use Vite.

Run commands from the repository root:

```bash
pnpm install
pnpm run build:proxy
node packages/proxy-server/dist/cli/bin.js /path/to/agent
```

Run `pnpm run build` when changes also affect the shared UI or Web client assets.

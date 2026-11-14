// Native tests run the production macOS host and its real Rust image bridge.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'native-host/target');
const build = spawnSync('cargo', ['+stable', 'build', '--manifest-path', join(root, 'native-host/Cargo.toml'), '--target-dir', target, '--locked'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const runtime = mkdtempSync(join(tmpdir(), 'nsh-images-runtime-'));
mkdirSync(join(runtime, 'macos'));
symlinkSync(join(target, 'debug/nsh-client-macos'), join(runtime, 'macos/nsh-macos-host'));
for (const name of ['image-without-extension', 'image-wrong.jpg']) copyFileSync(join(root, 'tests/fixtures/red.png'), join(root, 'tests/fixtures', name));
writeFileSync(join(root, 'tests/fixtures/plain-file'), 'This is not an image');
try {
  const child = spawn(process.execPath, [join(root, 'tests/connection.mjs'), '--file', 'tests/images-native.test.tsx', '--target', 'macos', ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, NSH_RUNTIME: runtime, ACP_TEST_PORT: '19439' } });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  for (const name of ['image-without-extension', 'image-wrong.jpg', 'plain-file']) rmSync(join(root, 'tests/fixtures', name), { force: true });
  rmSync(runtime, { recursive: true, force: true });
}

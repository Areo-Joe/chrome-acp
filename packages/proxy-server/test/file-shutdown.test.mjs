import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finishPendingFileWrites, writeTextFile } from '../dist/files.js';

test('shutdown waits for all accepted saves and rejects later writes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-file-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = join(dir, 'nested', 'first');
  const second = join(dir, 'second');
  const saves = [writeTextFile(first, 'first save'), writeTextFile(second, 'second save')];
  const drained = finishPendingFileWrites();
  const rejected = join(dir, 'rejected');
  await assert.rejects(writeTextFile(rejected, 'too late'), { code: -32800 });
  await drained;
  await Promise.all(saves);
  assert.equal(await readFile(first, 'utf8'), 'first save');
  assert.equal(await readFile(second, 'utf8'), 'second save');
  await assert.rejects(readFile(rejected), { code: 'ENOENT' });
});

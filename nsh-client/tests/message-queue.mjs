import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MessageQueue } from '../state/message-queue.ts';
const reference = JSON.parse(readFileSync(new URL('./fixtures/queue-v1.json', import.meta.url)));
for (const { name, commands, expected } of reference.cases) {
  test(`Zed queue state machine: ${name}`, () => {
    const q = new MessageQueue();
    const snapshots = [];
    for (const c of commands) {
      let result;
      switch (c.op) {
        case 'enqueue': q.enqueue({ id: q.nextId(), text: c.text }); break;
        case 'remove': result = q.remove(c.id); break;
        case 'clear': q.clear(); break;
        case 'pause': q.pause(); break;
        case 'resume': q.resume(); break;
        case 'fast': result = q.tryFastTrack(c.flag ?? false); break;
        case 'stopped': result = q.onGenerationStopped(c.flag ?? false); break;
        case 'now': result = q.sendNow(c.id, c.flag ?? false); break;
        case 'restore': q.restoreAfterFailedSend({ id: c.id, text: c.text }); break;
        default: assert.fail(c.op);
      }
      snapshots.push({ entries: structuredClone(q.entries), processing: q.processing, fast: q.canFastTrack(), result: result ?? null });
    }
    assert.deepEqual(snapshots, expected);
  });
}

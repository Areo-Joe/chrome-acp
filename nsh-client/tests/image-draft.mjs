import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appendDraft, changeDraft, draftContent, editDraftRange, insertDraftImages, restoreDraft } from '../state/draft.ts';
const reference = JSON.parse(readFileSync(new URL('./fixtures/images-v1.json', import.meta.url)));
for (const { name, draft, expected } of reference.cases) {
  test(`Zed v1 image chunks: ${name}`, () => assert.deepEqual(draftContent(draft), expected));
}
const block = name => ({ type: 'image', data: name, mimeType: 'image/png', uri: `zed:///agent/pasted-image?name=${name}` });
test('restore preserves source image positions and editor line ending normalization', () => {
  const input = [{ type: 'text', text: '你🙂\r\n' }, block('a'), block('b'), { type: 'text', text: 'end' }];
  const draft = restoreDraft(input, (() => { let id = 0; return () => id++; })());
  assert.equal(draft.text, '你🙂\n\ufffc\ufffcend');
  assert.deepEqual(draftContent(draft), [{ type: 'text', text: '你🙂\n' }, block('a'), block('b'), { type: 'text', text: 'end' }]);
});
test('native Backspace identifies the selected adjacent image, retaining the other source', () => {
  const draft = restoreDraft([block('a'), block('b')], (() => { let id = 0; return () => id++; })());
  assert.deepEqual(draftContent(changeDraft(draft, '\ufffc', { start: 1, end: 1 })), [block('b')]);
  assert.deepEqual(draftContent(changeDraft(draft, '\ufffc', { start: 2, end: 2 })), [block('a')]);
});
test('explicit removal uses source identity even with repeated image markers', () => {
  const draft = restoreDraft([block('a'), block('b')], () => 0);
  assert.deepEqual(draftContent(editDraftRange(draft, 0, 1, '')), [block('b')]);
});
test('insertion at a selection replaces its images and keeps surrounding text in order', () => {
  const draft = restoreDraft([{ type: 'text', text: 'before' }, block('a'), { type: 'text', text: 'after' }], () => 0);
  const result = insertDraftImages(draft, [{ id: 1, name: 'b', block: block('b') }], 6, 7);
  assert.deepEqual(draftContent(result.draft), [{ type: 'text', text: 'before' }, block('b'), { type: 'text', text: ' after' }]);
  assert.equal(result.offset, 8);
});
test('appending to an image-only draft retains both image sources and two-newline separator', () => {
  const current = restoreDraft([block('a')], () => 0), next = restoreDraft([block('b')], () => 1);
  assert.deepEqual(draftContent(appendDraft(current, next).draft), [block('a'), { type: 'text', text: '\n\n' }, block('b')]);
});
test('unsupported blocks cannot be partially restored and discarded', () => {
  assert.equal(restoreDraft([block('a'), { type: 'audio', data: 'AA==', mimeType: 'audio/wav' }], () => 0), null);
});
test('restored source images use Zed MIME aliases and default pasted-image identity', () => {
  const draft = restoreDraft([{ type: 'image', mimeType: 'image/jpg', data: 'AA==', annotations: { audience: ['assistant'] } }], () => 0);
  assert.deepEqual(draftContent(draft), [{ type: 'image', mimeType: 'image/jpeg', data: 'AA==', uri: 'zed:///agent/pasted-image?name=Image' }]);
});

test('image undo/redo keeps distinct sources behind identical markers and selection', async () => {
  const { DraftHistory, emptyDraft } = await import('../state/draft.ts');
  const empty = emptyDraft(), a = restoreDraft([block('a')], () => 1), b = restoreDraft([block('b')], () => 2);
  const history = new DraftHistory(empty, 0);
  history.record(empty, a, true);
  history.record(a, b, true, 1, { start: 0, end: 1 });
  assert.deepEqual(draftContent(history.undo().draft), [block('a')]);
  assert.deepEqual(draftContent(history.redo().draft), [block('b')]);
  const undone = history.undo();
  assert.deepEqual(undone.selection, { start: 0, end: 1 });
  history.record(undone.draft, empty, true);
  assert.equal(history.redo(), null);
});
test('image conversion completion updates removed sources while failure releases them', async () => {
  const { DraftHistory } = await import('../state/draft.ts');
  const image = restoreDraft([block('pending')], () => 5), deleted = changeDraft(image, '');
  image.images[0].pending = Promise.resolve(block('ready'));
  const history = new DraftHistory(image);
  history.record(image, deleted, true);
  history.updateImage(5, { block: block('ready'), pending: undefined });
  assert.deepEqual(draftContent(history.undo().draft), [block('ready')]);
  history.redo();
  history.clearMentions(5);
  assert.deepEqual(history.undo().draft, { text: '[@pending](zed:///agent/pasted-image?name=ready)', images: [] });
});
test('plain marker edits stay text while explicit undo restores attachment identity', async () => {
  const { DraftHistory } = await import('../state/draft.ts');
  const original = restoreDraft([block('a')], () => 1), deleted = changeDraft(original, '');
  const history = new DraftHistory(original, 0);
  history.record(original, deleted, true);
  const textOnly = changeDraft(deleted, '\ufffc');
  history.record(deleted, textOnly, true);
  assert.deepEqual(draftContent(textOnly), [{ type: 'text', text: '\ufffc' }]);
  assert.deepEqual(history.undo().draft, deleted);
  assert.deepEqual(draftContent(history.undo().draft), [block('a')]);
  history.redo();
  assert.deepEqual(draftContent(history.redo().draft), [{ type: 'text', text: '\ufffc' }]);
});
test('text transactions follow Zed 300ms grouping and undo breaks the group', async () => {
  const { DraftHistory, emptyDraft } = await import('../state/draft.ts');
  const empty = emptyDraft(), a = changeDraft(empty, 'a'), ab = changeDraft(a, 'ab'), abc = changeDraft(ab, 'abc');
  const history = new DraftHistory(empty);
  history.record(empty, a, false, 0);
  history.record(a, ab, false, 299);
  history.record(ab, abc, false, 600);
  assert.equal(history.undo().draft.text, 'ab');
  assert.equal(history.undo().draft.text, '');
  history.redo();
  history.record(ab, changeDraft(ab, 'x'), false, 601);
  assert.equal(history.undo().draft.text, 'ab');
  history.reset(empty);
  assert.equal(history.undo(), null);
});


test('replacing identical marker text removes only selected attachment identities', () => {
  const images = restoreDraft([block('a'), block('b')], (() => { let id = 0; return () => id++; })());
  assert.deepEqual(draftContent(changeDraft(images, images.text, { start: 0, end: 1 })), [
    { type: 'text', text: '\ufffc' }, block('b'),
  ]);
  assert.deepEqual(draftContent(changeDraft(images, images.text, { start: 0, end: 2 })), [
    { type: 'text', text: '\ufffc\ufffc' },
  ]);
  assert.equal(changeDraft(images, images.text), images);
});
test('transaction undo/redo selections remain independent after caret movement and later edits', async () => {
  const { DraftHistory, emptyDraft } = await import('../state/draft.ts');
  const empty = emptyDraft(), image = restoreDraft([block('a')], () => 1);
  const h = new DraftHistory(empty, 0);
  h.record(empty, image, false, 0, { start: 0, end: 0 }, { start: 1, end: 1 });
  const prefixed = changeDraft(image, 'x'+image.text, { start: 0, end: 0 });
  h.record(image, prefixed, false, 400, { start: 0, end: 0 }, { start: 1, end: 1 });
  assert.deepEqual(h.undo().selection, { start: 0, end: 0 });
  h.undo();
  const restored = h.redo();
  assert.deepEqual(restored.selection, { start: 1, end: 1 });
  // A caller changing its returned selection cannot rewrite the transaction.
  restored.selection.start = 0; h.undo();
  assert.deepEqual(h.redo().selection, { start: 1, end: 1 });
  h.redo();
  assert.deepEqual(h.undo().selection, { start: 0, end: 0 });
});
test('grouped transactions retain first undo selection and final redo selection', async () => {
  const { DraftHistory, emptyDraft } = await import('../state/draft.ts');
  const empty = emptyDraft(), a = changeDraft(empty, 'a'), ba = changeDraft(a, 'ba');
  const h = new DraftHistory(empty);
  h.record(empty, a, false, 0, { start: 0, end: 0 }, { start: 1, end: 1 });
  h.record(a, ba, false, 100, { start: 0, end: 0 }, { start: 1, end: 1 });
  assert.deepEqual(h.undo(), { draft: empty, selection: { start: 0, end: 0 } });
  assert.deepEqual(h.redo(), { draft: ba, selection: { start: 1, end: 1 } });
});

test('releasing one failed mention maps history selections and preserves other image sources', async () => {
  const { DraftHistory, emptyDraft } = await import('../state/draft.ts');
  let id = 0;
  const original = restoreDraft([block('a'), { type: 'text', text: ' text ' }, block('b'), block('c')], () => id++);
  const removed = editDraftRange(original, 0, 1, '');
  const history = new DraftHistory(original, 0);
  history.record(original, removed, true, 0, { start: 1, end: 8 }, { start: 0, end: 7 });
  history.clearMentions(0);
  const undo = history.undo();
  const link = '[@a](zed:///agent/pasted-image?name=a)';
  assert.deepEqual(undo.selection, { start: link.length, end: link.length + 7 });
  assert.deepEqual(undo.draft.images.map(image => [image.id, image.offset]), [[1, link.length + 6], [2, link.length + 7]]);
  assert.deepEqual(draftContent(undo.draft), [{ type: 'text', text: link + ' text ' }, block('b'), block('c')]);
  assert.deepEqual(history.redo().draft, removed);
});

test('resolved mention map emits captured sources and leaves uncaptured mention links as text', () => {
  let id = 0;
  const draft = restoreDraft([block('a'), { type: 'text', text: ' middle ' }, block('b'), block('c')], () => id++);
  assert.deepEqual(draftContent(draft, new Map([[1, block('resolved')]])), [
    { type: 'text', text: '[@a](zed:///agent/pasted-image?name=a) middle ' },
    block('resolved'), { type: 'text', text: '[@c](zed:///agent/pasted-image?name=c)' },
  ]);
  assert.deepEqual(draftContent(draft, new Map()), [{ type: 'text', text:
    '[@a](zed:///agent/pasted-image?name=a) middle [@b](zed:///agent/pasted-image?name=b)[@c](zed:///agent/pasted-image?name=c)' }]);
  const removed = editDraftRange(draft, 0, 1, '');
  assert.deepEqual(draftContent(removed, new Map([[0, block('a')]])), [{ type: 'text', text:
    'middle [@b](zed:///agent/pasted-image?name=b)[@c](zed:///agent/pasted-image?name=c)' }]);
});

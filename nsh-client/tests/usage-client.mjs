import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AcpClient, decodeUsage } from '../acp/client.ts';
import { applyUsage, usagePresentation } from '../state/usage.ts';
const reference = JSON.parse(readFileSync(new URL('./fixtures/usage-v1.json', import.meta.url)));
for (const { name, input, expected, presentation, error } of reference.cases) {
  test(`Zed v1 usage serde and presentation: ${name}`, () => {
    if (error) assert.throws(() => decodeUsage(input), /Invalid ACP usage_update/);
    else {
      const decoded = decodeUsage(input);
      assert.deepEqual(decoded, expected);
      assert.deepEqual(usagePresentation(applyUsage(null, decoded)), presentation);
    }
  });
}
async function mock(t, handle) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const calls = [];
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data);
    calls.push(message);
    const result = value => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }));
    if (handle(message, socket, result)) return;
    if (message.method === 'initialize') {
      assert.equal(message.params.protocolVersion, 1);
      assert.deepEqual(message.params.clientCapabilities, { session: { configOptions: { boolean: {} } } });
      result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    } else if (message.method === 'session/new') result({ sessionId: 's' });
    else assert.fail(`Unexpected ${message.method}`);
  }));
  const client = new AcpClient({ url: `ws://127.0.0.1:${server.address().port}`, cwd: '/workspace' });
  t.after(async () => { client.disconnect(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  await client.connect();
  return { client, calls };
}
const notify = (socket, sessionId, update) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }));
const marker = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'barrier' } };
for (const { name, input, wire, expected, error } of reference.cases.filter(c => c.input && typeof c.input === 'object' && !Array.isArray(c.input))) {
  test(`Zed v1 usage WebSocket: ${name}`, { timeout: 10000 }, async t => {
    const { client } = await mock(t, (message, socket, result) => {
      if (message.method !== 'session/prompt') return false;
      const rawUpdate = '{"sessionUpdate":"usage_update"' + (Object.keys(input).length ? ',' + wire.slice(1, -1) : '') + '}';
      socket.send('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":' + rawUpdate + '}}');
      notify(socket, 's', marker);
      result({ stopReason: 'end_turn' });
      return true;
    });
    await client.createSession();
    const updates = [];
    const barrier = new Promise(resolve => client.setSessionUpdateHandler(update => {
      updates.push(update);
      if (update.sessionUpdate === 'agent_message_chunk') resolve();
    }));
    await client.prompt([{ type: 'text', text: 'usage' }]);
    await barrier;
    assert.deepEqual(updates, [...(error ? [] : [{ sessionUpdate: 'usage_update', ...expected }]), marker]);
  });
}

test('v1 usage replaces cumulative cost and preserves it for missing, null or invalid costs', () => {
  let state = applyUsage(null, decodeUsage({ used: 10, size: 100, cost: { amount: 1, currency: 'USD', _meta: { previous: 1 } } }));
  for (const cost of [undefined, null, {}, { amount: 9, currency: null }]) {
    state = applyUsage(state, decodeUsage({ used: 20, size: 200, cost, _meta: { ignored: true } }));
    assert.deepEqual(state, { used: 20, size: 200, cost: { amount: 1, currency: 'USD', _meta: { previous: 1 } } });
  }
  state = applyUsage(state, decodeUsage({ used: 1, size: 2, cost: { amount: 0, currency: 'credits' } }));
  assert.deepEqual(state, { used: 1, size: 2, cost: { amount: 0, currency: 'credits' } });
});

test('v1 usage routing ignores unknown sessions and receives response-before-load replay', { timeout: 10000 }, async t => {
  const { client } = await mock(t, (message, socket, result) => {
    if (message.method !== 'session/load') return false;
    notify(socket, 'unknown', { sessionUpdate: 'usage_update', used: 1, size: 1 });
    notify(socket, message.params.sessionId, { sessionUpdate: 'usage_update', used: 8500, size: 10000, cost: { amount: 0.005, currency: 'USD' } });
    result({}); return true;
  });
  const updates = [];
  client.setSessionUpdateHandler(update => updates.push(update));
  await client.restoreSession('saved');
  assert.deepEqual(updates, [{ sessionUpdate: 'usage_update', used: 8500, size: 10000, cost: { amount: 0.005, currency: 'USD' } }]);
});

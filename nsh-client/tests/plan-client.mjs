import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AcpClient, decodePlan } from '../acp/client.ts';
import { planStats, planSummary } from '../state/plan.ts';

const reference = JSON.parse(readFileSync(new URL('./fixtures/plan-v1.json', import.meta.url)));
for (const { name, input, expected, error } of reference.cases) {
  test(`Zed v1 plan serde: ${name}`, () => {
    if (error) assert.throws(() => decodePlan(input), /Invalid ACP plan/);
    else assert.deepEqual(decodePlan(input), expected);
  });
}

async function mock(t, handle) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data);
    const result = value => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }));
    if (handle(message, socket, result)) return;
    if (message.method === 'initialize') {
      assert.equal(message.params.protocolVersion, 1);
      assert.equal(message.params.clientCapabilities.plan, undefined);
      result({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    } else if (message.method === 'session/new') result({ sessionId: 's' });
    else assert.fail(`Unexpected ${message.method}`);
  }));
  const client = new AcpClient({ url: `ws://127.0.0.1:${server.address().port}`, cwd: '/workspace' });
  t.after(async () => { client.disconnect(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  await client.connect();
  return client;
}
const notify = (socket, sessionId, update) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }));
const marker = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'barrier' } };
for (const { name, input, expected, error } of reference.cases.filter(c => !Array.isArray(c.input))) {
  test(`Zed v1 plan notification over WebSocket: ${name}`, { timeout: 10000 }, async t => {
    const client = await mock(t, (message, socket, result) => {
      if (message.method !== 'session/prompt') return false;
      notify(socket, 'unknown', { sessionUpdate: 'plan', entries: [] });
      notify(socket, 's', { sessionUpdate: 'plan', ...input });
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
    await client.prompt([{ type: 'text', text: 'plan' }]);
    await barrier;
    assert.deepEqual(updates, [...(error ? [] : [{ sessionUpdate: 'plan', ...expected }]), marker]);
  });
}

test('v1 replay delivers plans before load resolves, to the registered session only', { timeout: 10000 }, async t => {
  const client = await mock(t, (message, socket, result) => {
    if (message.method !== 'session/load') return false;
    notify(socket, 'other', { sessionUpdate: 'plan', entries: [] });
    notify(socket, message.params.sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Replayed', priority: 'low', status: 'pending' }] });
    result({}); return true;
  });
  const updates = [];
  client.setSessionUpdateHandler(update => updates.push(update));
  await client.restoreSession('saved');
  assert.deepEqual(updates.map(update => update.entries[0].content), ['Replayed']);
});

test('plan summaries follow wire order and count all in-progress tasks as pending', () => {
  const make = statuses => ({ entries: statuses.map((status, index) => ({ content: `${index}`, status, priority: index ? 'high' : 'low' })) });
  const plan = make(['pending', 'in_progress', 'in_progress', 'completed']);
  assert.equal(planStats(plan).current.content, '1');
  assert.equal(planStats(plan).pending, 3);
  assert.equal(planSummary(plan), '1/4');
  assert.equal(planSummary(make(['pending', 'pending'])), '2 Tasks');
  assert.equal(planSummary(make(['completed', 'completed'])), 'All Done');
  assert.equal(planSummary(make(['in_progress'])), '1 Tasks');
});

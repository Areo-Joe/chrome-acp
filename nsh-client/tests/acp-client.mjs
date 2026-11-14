// Node.js 26 strips the TypeScript client directly; no generated test bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AcpClient, DEFAULT_ACP_PROTOCOL_MODE } from '../acp/client.ts';
const options = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] },
  { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false },
];
async function mock(t, handle) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise((resolve) => server.close(resolve)); });
  server.on('connection', (socket, request) => {
    const send = (id, result) => socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      assert.equal(message.jsonrpc, '2.0');
      assert.equal('type' in message, false);
      if (handle(message, socket, send, request) === true) return;
      if (message.method === 'initialize') send(message.id, { protocolVersion: 1, agentCapabilities: {} });
      else if (message.method === 'session/new') send(message.id, { sessionId: 's', configOptions: options() });
      else assert.fail(`Unexpected method ${message.method}`);
    });
  });
  const client = new AcpClient({ url: `ws://127.0.0.1:${server.address().port}/acp?existing=1`, cwd: '/workspace', token: 'token' });
  t.after(() => client.disconnect());
  return client;
}

test('auto is explicitly unimplemented before opening a connection', async () => {
  assert.equal(DEFAULT_ACP_PROTOCOL_MODE, 'v1');
  const client = new AcpClient({ url: 'invalid', cwd: '/workspace', protocolMode: 'auto' });
  await assert.rejects(client.connect(), /ACP protocol mode 'auto' is unimplemented/);
});

test('ACP initialization, cwd, early commands, boolean discriminator, and response-only config confirmation', { timeout: 10000 }, async (t) => {
  const client = await mock(t, (message, socket, send, request) => {
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('token'), 'token');
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('existing'), '1');
    if (message.method === 'initialize') {
      assert.equal(message.params.protocolVersion, 1);
      assert.equal(message.params.clientInfo.name, 'nsh-client');
      assert.deepEqual(message.params.clientCapabilities, { session: { configOptions: { boolean: {} } } });
    }
    if (message.method === 'session/new') {
      assert.equal(message.params.cwd, '/workspace');
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
        sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }],
      } } }));
    }
    if (message.method === 'session/set_config_option') {
      assert.equal(message.params.type, 'boolean');
      assert.equal(message.params.value, true);
      const updated = options(); updated[1].currentValue = true;
      send(message.id, { configOptions: updated }); return true;
    }
  });
  await client.connect();
  assert.equal(await client.createSession(), 's');
  assert.equal(client.availableCommands[0].name, 'review');
  await client.setConfigOption('thinking', true);
  assert.equal(client.configOptions[1].currentValue, true);
});

test('late RPC errors reject their original request without cancelling another configuration change', { timeout: 10000 }, async (t) => {
  let previous;
  const client = await mock(t, (message, socket, send) => {
    if (message.method !== 'session/set_config_option') return;
    if (message.params.configId === 'model') previous = message.id;
    else {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: previous, error: { code: -32603, message: 'Older configuration rejected' } }));
      setTimeout(() => { const updated = options(); updated[1].currentValue = true; send(message.id, { configOptions: updated }); }, 50);
    }
    return true;
  });
  const broadcast = [];
  client.setErrorHandler((message) => broadcast.push(message));
  await client.connect(); await client.createSession();
  const rejected = assert.rejects(client.setConfigOption('model', 'smart'), /Older configuration rejected/);
  let confirmed = false;
  const accepted = client.setConfigOption('thinking', true).then(() => { confirmed = true; });
  await rejected;
  assert.equal(confirmed, false);
  await accepted;
  assert.equal(client.configOptions[1].currentValue, true);
  assert.deepEqual(broadcast, []);
});

test('ACP mode changes use their RPC response without a companion notification', { timeout: 10000 }, async (t) => {
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'session/new') {
      send(message.id, { sessionId: 's', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } }); return true;
    }
    if (message.method === 'session/set_mode') { assert.equal(message.params.modeId, 'code'); send(message.id, {}); return true; }
  });
  await client.connect(); await client.createSession(); await client.setSessionMode('code');
  assert.equal(client.sessionModes.currentModeId, 'code');
});

test('disconnect rejects in-flight SDK requests', { timeout: 10000 }, async (t) => {
  const client = await mock(t, (message, socket) => {
    if (message.method === 'session/set_config_option') { socket.close(1011, 'Agent stopped'); return true; }
  });
  const states = [];
  client.setConnectionStateHandler((state, reason) => states.push([state, reason]));
  await client.connect(); await client.createSession();
  await assert.rejects(client.setConfigOption('model', 'smart'));
  assert.ok(states.some(([state, reason]) => state === 'error' && reason === 'Agent stopped'));
  assert.equal(client.configOptions, null);
});

test('an HTTP rejection before the upgrade reports an error state', { timeout: 10000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (_info, done) => done(false, 401) });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new AcpClient({ url: `ws://127.0.0.1:${server.address().port}/acp`, cwd: '/workspace', token: 'wrong' });
  const states = [];
  client.setConnectionStateHandler((state, reason) => states.push([state, reason]));
  await assert.rejects(client.connect(), /Could not open the connection/);
  assert.deepEqual(states.at(-1), ['error', 'Could not open the connection. Check the address and token, and that the agent can start.']);
});

test('non-JSON-RPC messages fail immediately instead of creating a protocol-error loop', { timeout: 10000 }, async (t) => {
  let requests = 0;
  const client = await mock(t, (message, socket) => {
    requests++;
    socket.send(JSON.stringify({ type: 'error', payload: { message: 'Unknown message type' } }));
    return true;
  });
  await assert.rejects(client.connect(), /does not speak ACP/);
  assert.equal(requests, 1);
});

test('mode success preserves notifications received before its empty response', { timeout: 10000 }, async (t) => {
  const client = await mock(t, (message, socket, send) => {
    if (message.method === 'session/new') {
      send(message.id, { sessionId: 's', modes: { currentModeId: 'ask', availableModes: [
        { id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }, { id: 'plan', name: 'Plan' },
      ] } }); return true;
    }
    if (message.method === 'session/set_mode') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
        sessionUpdate: 'current_mode_update', currentModeId: 'plan',
      } } }));
      send(message.id, {});
      return true;
    }
  });
  await client.connect(); await client.createSession();
  await client.setSessionMode('code');
  assert.equal(client.sessionModes.currentModeId, 'plan');
});

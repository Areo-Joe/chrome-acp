// Node.js 26 strips the TypeScript client directly; no generated test bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectACPClient } from '../../packages/shared/src/acp/direct-client.ts';
const require = createRequire(new URL('../../packages/proxy-server/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
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
  const client = new DirectACPClient({ proxyUrl: `ws://127.0.0.1:${server.address().port}/ws?existing=1`, cwd: '/workspace', token: 'token' });
  t.after(() => client.disconnect());
  return client;
}

test('ACP initialization, cwd, early commands, boolean discriminator, and response-only config confirmation', { timeout: 10000 }, async (t) => {
  const client = await mock(t, (message, socket, send, request) => {
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('token'), 'token');
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('existing'), '1');
    if (message.method === 'initialize') {
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

test('NSH client connects through the real --acp proxy and retains proxy-owned file and terminal capabilities', { timeout: 15000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'nsh-acp-integration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../packages/proxy-server/dist/cli/bin.js', import.meta.url)), '--acp', '--host', '127.0.0.1', '--port', String(port), process.execPath, '--', fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url))], {
    env: { ...process.env, ACP_AUTH_TOKEN: 'integration' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  const client = new DirectACPClient({ proxyUrl: `ws://127.0.0.1:${port}/ws`, cwd: dir, token: 'integration' });
  t.after(async () => { client.disconnect(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (i === 100 || child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await client.connect();
  assert.equal(await client.createSession(), 'integration');
  assert.equal(client.availableCommands[0].name, 'review');
  await client.setConfigOption('thinking', true);
  assert.equal(client.configOptions[0].currentValue, true);
  assert.equal(await readFile(join(dir, 'proxy-capabilities.txt'), 'utf8'), 'true:local terminal');
});

test('legacy proxy envelopes fail immediately instead of creating a protocol-error loop', { timeout: 10000 }, async (t) => {
  let requests = 0;
  const client = await mock(t, (message, socket) => {
    requests++;
    socket.send(JSON.stringify({ type: 'error', payload: { message: 'Unknown message type' } }));
    return true;
  });
  await assert.rejects(client.connect(), /Start the proxy with --acp/);
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

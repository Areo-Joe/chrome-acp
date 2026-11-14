// Node.js 26 strips the TypeScript client directly; no generated test bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { AcpClient, DEFAULT_ACP_PROTOCOL_MODE, authenticationKind, authenticationRequired } from '../acp/client.ts';
import { RequestError } from '@agentclientprotocol/sdk';
const options = () => [
  { id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] },
  { id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false },
];
const initializedAgent = () => ({
  protocolVersion: 1,
  agentInfo: { name: 'mock', title: 'Mock Agent', version: '1', _meta: { extension: ['info'] } },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false, acp: false },
    sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {}, delete: {} },
    auth: { logout: {} },
    _meta: { extension: { nested: [null, true] } },
  },
  authMethods: [
    { id: '/opaque.login', name: 'Login' },
    { id: 'empty', name: '', description: '', _meta: {} },
    { id: 'legacy', name: 'Legacy login', description: 'Sign in', _meta: {
      'terminal-auth': { label: 'Login', command: 'agent', args: ['auth'], env: { EMPTY: '' } },
      extension: { nested: [null, true] },
    } },
    { type: 'terminal', id: 'terminal/opaque', name: 'Terminal login', args: ['auth', ''], env: { EMPTY: '', SHARED: 'override' }, _meta: { extension: [1] } },
  ],
});

function assertUninitialized(client) {
  assert.equal(client.agentInfo, null);
  assert.equal(client.agentCapabilities, null);
  assert.deepEqual(client.authMethods, []);
}

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

test('authentication errors use their protocol code and Zed description rules', () => {
  assert.deepEqual(authenticationRequired(new RequestError(-32000, 'Authentication required')), { description: null });
  assert.deepEqual(authenticationRequired(new RequestError(-32000, 'Sign in again', { ignored: true })), { description: 'Sign in again' });
  assert.deepEqual(authenticationRequired(new RequestError(-32000, '')), { description: '' });
  assert.equal(authenticationRequired(new RequestError(-32603, 'Authentication required')), null);
  assert.equal(authenticationRequired(new Error('Authentication required')), null);
});

test('terminal auth dispatch matches first-class and legacy Zed definitions', () => {
  assert.equal(authenticationKind({ type: 'terminal', id: 't', name: 'Terminal' }), 'terminal');
  const legacy = (value) => ({ id: 'legacy', name: 'Legacy', _meta: { 'terminal-auth': value } });
  assert.equal(authenticationKind(legacy({ label: '', command: '' })), 'terminal');
  assert.equal(authenticationKind(legacy({ label: 'Login', command: 'agent', args: ['auth', ''], env: { EMPTY: '' } })), 'terminal');
  assert.equal(authenticationKind(legacy(['Login', 'agent', [], {}])), 'terminal');
  for (const value of [null, {}, { label: 'Login', command: 'agent', args: null }, { label: 'Login', command: 'agent', env: null }, { label: 'Login', command: 'agent', args: [false] }]) {
    assert.equal(authenticationKind(legacy(value)), 'agent');
  }
});

test('agent-managed authentication validates advertised methods and sends the exact opaque ID', { timeout: 10000 }, async (t) => {
  const calls = [];
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'initialize') { send(message.id, initializedAgent()); return true; }
    if (message.method === 'authenticate') { calls.push(message.params); send(message.id, {}); return true; }
  });
  await client.connect();
  await assert.rejects(client.authenticate('unknown'), /not supported for agent-managed login/);
  await assert.rejects(client.authenticate('terminal/opaque'), /not supported for agent-managed login/);
  assert.deepEqual(calls, []);
  await client.authenticate('/opaque.login');
  await client.authenticate('empty');
  assert.deepEqual(calls, [{ methodId: '/opaque.login' }, { methodId: 'empty' }]);
  assert.deepEqual(client.authMethods, initializedAgent().authMethods);
});

test('authentication rejection retains the initialized connection and allows retry', { timeout: 10000 }, async (t) => {
  let attempts = 0;
  const client = await mock(t, (message, socket, send) => {
    if (message.method === 'initialize') { send(message.id, initializedAgent()); return true; }
    if (message.method !== 'authenticate') return;
    if (++attempts === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Login rejected' } }));
    else send(message.id, {});
    return true;
  });
  await client.connect();
  await assert.rejects(client.authenticate('/opaque.login'), /Login rejected/);
  await client.authenticate('/opaque.login');
  assert.equal(attempts, 2);
  assert.deepEqual(client.agentCapabilities, initializedAgent().agentCapabilities);
});

for (const response of [null, {}, [], [42], false, 42, 'bad', [{}, {}]]) {
  test(`authenticate response follows the v1 nullable struct rules: ${JSON.stringify(response)}`, { timeout: 10000 }, async (t) => {
    let attempts = 0;
    const client = await mock(t, (message, _socket, send) => {
      if (message.method === 'initialize') { send(message.id, initializedAgent()); return true; }
      if (message.method === 'authenticate') { send(message.id, ++attempts === 1 ? response : {}); return true; }
    });
    await client.connect();
    const valid = response === null || (typeof response === 'object' && (!Array.isArray(response) || response.length <= 1));
    if (valid) await client.authenticate('/opaque.login');
    else await assert.rejects(client.authenticate('/opaque.login'), /Invalid ACP authenticate response/);
    await client.authenticate('/opaque.login');
    assert.equal(attempts, 2);
  });
}

test('disconnect rejects pending authentication and clears connection data', { timeout: 10000 }, async (t) => {
  const waiting = Promise.withResolvers();
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'initialize') { send(message.id, initializedAgent()); return true; }
    if (message.method === 'authenticate') { waiting.resolve(); return true; }
  });
  await client.connect();
  const rejected = assert.rejects(client.authenticate('/opaque.login'), /connection closed/i);
  await waiting.promise;
  client.disconnect();
  await rejected;
  assertUninitialized(client);
});

for (const strategy of ['load', 'resume', 'unsupported']) {
  test(`post-login restoration uses ${strategy} according to v1 capabilities`, { timeout: 10000 }, async (t) => {
    const calls = [];
    const updates = [];
    const client = await mock(t, (message, socket, send) => {
      if (message.method === 'initialize') {
        send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: strategy === 'unsupported' ? {} : { resume: {} } } });
        return true;
      }
      if (message.method !== 'session/load' && message.method !== 'session/resume') return;
      calls.push(message);
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'History before response' },
      } } }));
      send(message.id, { configOptions: options() });
      return true;
    });
    client.setSessionUpdateHandler((update) => updates.push(update));
    await client.connect();
    if (strategy === 'unsupported') {
      await assert.rejects(client.restoreSession('s'), /Loading or resuming sessions is not supported/);
      assert.deepEqual(calls, []);
    } else {
      assert.equal(await client.restoreSession('s'), 's');
      assert.equal(calls[0].method, strategy === 'load' ? 'session/load' : 'session/resume');
      assert.deepEqual(calls[0].params, { sessionId: 's', cwd: '/workspace', mcpServers: [] });
      assert.equal(updates[0].content.text, 'History before response');
      assert.deepEqual(client.configOptions, options());
    }
  });
}

for (const strategy of ['load', 'resume']) {
  test(`failed ${strategy} recovery unregisters its session and can be retried with the known ID`, { timeout: 10000 }, async (t) => {
    let attempts = 0;
    let created = 0;
    const client = await mock(t, (message, _socket, send) => {
      if (message.method === 'initialize') {
        send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: { resume: {} } } });
        return true;
      }
      if (message.method !== `session/${strategy}`) return;
      assert.equal(message.params.sessionId, 's');
      send(message.id, ++attempts === 1 ? false : null);
      return true;
    });
    client.setSessionCreatedHandler(() => created++);
    await client.connect();
    await assert.rejects(client.restoreSession('s'), /Invalid ACP session\/(load|resume) response/);
    assert.equal(created, 0);
    await assert.rejects(client.prompt([{ type: 'text', text: 'not loaded' }]), /No active session/);
    assert.equal(await client.restoreSession('s'), 's');
    assert.equal(created, 1);
    assert.equal(client.configOptions, null);
  });
}

for (const strategy of ['load', 'resume']) {
  for (const failure of ['rpc', 'malformed']) {
    test(`failed ${strategy} ${failure} drains replay before an immediate same-ID retry`, { timeout: 10000 }, async (t) => {
      let attempts = 0;
      const updates = [];
      const client = await mock(t, (message, socket, send) => {
        if (message.method === 'initialize') {
          send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: { resume: {} } } });
          return true;
        }
        if (message.method !== `session/${strategy}`) return;
        const notify = (update) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } }));
        if (++attempts === 1) {
          // One transport burst makes these queued replay messages, rather
          // than notifications arriving from the network after cleanup ends.
          socket._socket.cork();
          if (failure === 'rpc') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Replay failed' } }));
          else send(message.id, false);
          // Already-received old replay must finish before the failure reaches
          // the caller, which immediately registers a replacement under this ID.
          notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay' } });
          notify({ sessionUpdate: 'config_option_update', configOptions: options() });
          notify({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'stale', description: 'Old command' }] });
          socket._socket.uncork();
        } else {
          notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new replay' } });
          send(message.id, {});
        }
        return true;
      });
      client.setSessionUpdateHandler((update) => updates.push(update.content.text));
      await client.connect();
      await assert.rejects(client.restoreSession('s'), failure === 'rpc' ? /Replay failed/ : /Invalid ACP/);
      updates.length = 0;
      assert.equal(await client.restoreSession('s'), 's');
      assert.deepEqual(updates, ['new replay']);
      assert.equal(client.configOptions, null);
      assert.deepEqual(client.availableCommands, []);
    });
  }
}

for (const strategy of ['load', 'resume']) {
  test(`disconnect during failed ${strategy} replay cannot clear a new connection's state`, { timeout: 10000 }, async (t) => {
    let reconnected;
    let release;
    const pendingNew = Promise.withResolvers();
    const client = await mock(t, (message, socket, send) => {
      if (message.method === 'initialize') {
        send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: { resume: {} } } });
        return true;
      }
      if (message.method === `session/${strategy}`) {
        socket._socket.cork();
        send(message.id, false);
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'disconnect during drain' } },
        } }));
        socket._socket.uncork();
        return true;
      }
      if (message.method === 'session/new') {
        release = () => send(message.id, { sessionId: 'replacement', configOptions: options() });
        pendingNew.resolve();
        return true;
      }
    });
    client.setSessionUpdateHandler(() => {
      client.disconnect();
      reconnected = client.connect().then(() => client.createSession());
    });
    await client.connect();
    await assert.rejects(client.restoreSession('s'), /Invalid ACP/);
    assert.ok(reconnected, 'the old replay was drained before the failure settled');
    await pendingNew.promise;
    await assert.rejects(client.createSession(), /Session creation already in progress/);
    release();
    assert.equal(await reconnected, 'replacement');
    assert.deepEqual(client.configOptions, options());
  });
}

for (const strategy of ['load', 'resume']) {
  for (const outcome of ['success', 'error', 'malformed']) {
    test(`late configuration ${outcome} cannot change the ${strategy} session's new owner`, { timeout: 10000 }, async (t) => {
      const waiting = Promise.withResolvers();
      let release;
      const restored = options(); restored[1].currentValue = true;
      const client = await mock(t, (message, socket, send) => {
        if (message.method === 'initialize') {
          send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: { resume: {} } }, authMethods: [{ id: 'login', name: 'Login' }] });
          return true;
        }
        if (message.method === 'session/set_config_option') {
          release = () => {
            if (outcome === 'error') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Old change rejected' } }));
            else if (outcome === 'malformed') send(message.id, {});
            else { const old = options(); old[0].currentValue = 'smart'; send(message.id, { configOptions: old }); }
          };
          waiting.resolve();
          return true;
        }
        if (message.method === 'authenticate') { send(message.id, {}); return true; }
        if (message.method === `session/${strategy}`) { send(message.id, { configOptions: restored }); return true; }
      });
      const changes = [];
      client.setConfigOptionsChangedHandler((value) => { if (value) changes.push(value); });
      await client.connect(); await client.createSession();
      const old = client.setConfigOption('model', 'smart');
      const settled = outcome === 'success' ? old : assert.rejects(old, outcome === 'error' ? /Old change rejected/ : /Invalid ACP session\/set_config_option response/);
      await waiting.promise;
      await client.authenticate('login');
      await client.restoreSession('s');
      assert.deepEqual(client.configOptions, restored);
      release(); await settled;
      assert.deepEqual(client.configOptions, restored);
      assert.deepEqual(changes, [options(), restored]);
      assert.equal(client.sessionModes, null);
    });
  }
}

// Reopening an existing v1 thread waits for its release before reusing the ID.
for (const strategy of ['load', 'resume']) {
  for (const outcome of ['unsupported', 'success', 'error', 'malformed']) {
    test(`${strategy} drains the previous session after close ${outcome}`, { timeout: 10000 }, async (t) => {
      const warnings = t.mock.method(console, 'warn', () => {});
      const closing = Promise.withResolvers();
      const calls = [];
      const updates = [];
      let release;
      const client = await mock(t, (message, socket, send) => {
        const notify = (text) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        } }));
        if (message.method === 'initialize') {
          send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: strategy === 'load', sessionCapabilities: {
            resume: {}, ...(outcome === 'unsupported' ? {} : { close: {} }),
          } } });
          return true;
        }
        calls.push(message.method);
        if (message.method === 'session/close') {
          assert.deepEqual(message.params, { sessionId: 's' });
          notify('stale before close response');
          release = () => {
            if (outcome === 'error') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Close rejected' } }));
            else send(message.id, outcome === 'malformed' ? false : null);
            notify('stale after close response');
          };
          closing.resolve();
          return true;
        }
        if (message.method === `session/${strategy}`) {
          notify('new history');
          send(message.id, { configOptions: options() });
          notify('current update');
          return true;
        }
      });
      client.setSessionUpdateHandler((update) => updates.push(update.content.text));
      await client.connect(); await client.createSession();
      const restore = client.restoreSession('s');
      if (outcome !== 'unsupported') {
        await closing.promise;
        assert.deepEqual(calls, ['session/new', 'session/close']);
        await assert.rejects(client.prompt([{ type: 'text', text: 'not registered' }]), /No active session/);
        await assert.rejects(client.restoreSession('s'), /Session creation already in progress/);
        release();
      }
      assert.equal(await restore, 's');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(updates, ['new history', 'current update']);
      assert.deepEqual(calls, ['session/new', ...(outcome === 'unsupported' ? [] : ['session/close']), `session/${strategy}`]);
      assert.equal(warnings.mock.calls.some(({ arguments: args }) => args[0] === 'ACP session release failed:'), ['error', 'malformed'].includes(outcome));
    });
  }
}

test('disconnect during close cannot register the session on another connection', { timeout: 10000 }, async (t) => {
  t.mock.method(console, 'warn', () => {});
  const closing = Promise.withResolvers();
  const calls = [];
  const client = await mock(t, (message, _socket, send) => {
    calls.push(message.method);
    if (message.method === 'initialize') {
      send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
      return true;
    }
    if (message.method === 'session/close') { closing.resolve(); return true; }
  });
  await client.connect(); await client.createSession();
  const old = assert.rejects(client.restoreSession('s'), /Connection closed/);
  await closing.promise;
  client.disconnect();
  await client.connect();
  await old;
  assert.equal(calls.includes('session/load'), false);
  await assert.rejects(client.prompt([{ type: 'text', text: 'no old session' }]), /No active session/);
  await client.createSession();
});

test('release still closes the existing thread when reopening is unsupported', { timeout: 10000 }, async (t) => {
  const calls = [];
  const client = await mock(t, (message, _socket, send) => {
    calls.push(message.method);
    if (message.method === 'initialize') {
      send(message.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });
      return true;
    }
    if (message.method === 'session/close') { send(message.id, {}); return true; }
  });
  await client.connect(); await client.createSession();
  await assert.rejects(client.restoreSession('s'), /Loading or resuming sessions is not supported/);
  assert.deepEqual(calls, ['initialize', 'session/new', 'session/close']);
  await assert.rejects(client.prompt([{ type: 'text', text: 'closed' }]), /No active session/);
});

const sessionReference = JSON.parse(readFileSync(new URL('./fixtures/session-state-v1.json', import.meta.url), 'utf8'));
for (const { name, operation, input, expected, error } of sessionReference.cases) {
  test(`Zed v1 ${operation} response: ${name}`, { timeout: 10000 }, async (t) => {
    const client = await mock(t, (message, _socket, send) => {
      if (message.method === 'initialize') {
        send(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: operation !== 'session/resume', sessionCapabilities: { resume: {} } } });
        return true;
      }
      if (message.method === operation) { send(message.id, input); return true; }
    });
    await client.connect();
    if (operation === 'session/set_config_option') await client.createSession();
    const request = operation === 'session/new' ? client.createSession()
      : operation === 'session/set_config_option' ? client.setConfigOption('model', 'smart')
      : client.restoreSession('s');
    if (error) {
      await assert.rejects(request, /Invalid ACP session\/(new|load|resume|set_config_option) response/);
    } else {
      await request;
      assert.deepEqual(client.configOptions, expected.configOptions ?? null);
      assert.deepEqual(client.sessionModes, expected.configOptions !== undefined ? null : expected.modes ?? null);
    }
    assert.notEqual(client.agentCapabilities, null, 'session decoding must not destroy the connection');
  });
}

test('initialize data is available when connected and survives session creation and session errors', { timeout: 10000 }, async (t) => {
  const response = initializedAgent();
  let sessions = 0;
  const client = await mock(t, (message, socket, send) => {
    if (message.method === 'initialize') { send(message.id, response); return true; }
    if (message.method === 'session/new' && ++sessions === 2) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Session failed' } }));
      return true;
    }
  });
  assertUninitialized(client);
  let connected = false;
  const assertInitialized = () => {
    assert.deepEqual(client.agentInfo, response.agentInfo);
    assert.deepEqual(client.agentCapabilities, response.agentCapabilities);
    assert.deepEqual(client.authMethods, response.authMethods);
  };
  client.setConnectionStateHandler((state) => {
    if (state === 'connecting') assertUninitialized(client);
    if (state === 'connected') { assertInitialized(); connected = true; }
  });
  await client.connect();
  assert.equal(connected, true);
  await client.createSession();
  assertInitialized();
  await assert.rejects(client.createSession(), /Session failed/);
  assertInitialized();
  await client.createSession();
  assertInitialized();
});

test('disconnect clears initialize data and reconnect defaults do not retain the previous agent', { timeout: 10000 }, async (t) => {
  let attempts = 0;
  const client = await mock(t, (message, _socket, send) => {
    if (message.method !== 'initialize') return;
    send(message.id, ++attempts === 1 ? initializedAgent() : { protocolVersion: 1 });
    return true;
  });
  await client.connect();
  client.setConnectionStateHandler(() => assertUninitialized(client));
  client.disconnect();
  assertUninitialized(client);
  client.setConnectionStateHandler((state) => {
    if (state === 'connecting') assertUninitialized(client);
    if (state === 'connected') {
      assert.equal(client.agentInfo, null);
      assert.deepEqual(client.agentCapabilities, {
        loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false }, sessionCapabilities: {}, auth: {},
      });
      assert.deepEqual(client.authMethods, []);
    }
  });
  await client.connect();
  assert.equal(attempts, 2);
});

// Expected values were produced by Zed's exact locked Rust schema, not this decoder.
const reference = JSON.parse(readFileSync(new URL('./fixtures/initialize-v1.json', import.meta.url), 'utf8'));
for (const { name, input, expected, error } of reference.cases) {
  test(`Zed v1 initialize decoding: ${name}`, { timeout: 10000 }, async (t) => {
    let attempts = 0;
    let peer;
    const client = await mock(t, (message, socket, send) => {
      assert.equal(message.method, 'initialize');
      peer = socket;
      send(message.id, ++attempts === 1 ? input : initializedAgent());
      return true;
    });
    const states = [];
    client.setConnectionStateHandler((state) => {
      states.push(state);
      if (state !== 'connected') assertUninitialized(client);
      else if (attempts === 1) {
        assert.deepEqual(client.agentInfo, expected.agentInfo ?? null);
        assert.deepEqual(client.agentCapabilities, expected.agentCapabilities);
        assert.deepEqual(client.authMethods, expected.authMethods);
      }
    });
    if (error) {
      await assert.rejects(client.connect(), /Invalid ACP initialize response/);
      assert.deepEqual(states, ['connecting', 'error']);
      assertUninitialized(client);
      if (peer.readyState !== 3) await once(peer, 'close');
      await client.connect();
      assert.deepEqual(client.authMethods, initializedAgent().authMethods);
    } else {
      await client.connect();
      assert.deepEqual(states, ['connecting', 'connected']);
      assert.deepEqual(client.agentInfo, expected.agentInfo ?? null);
      assert.deepEqual(client.agentCapabilities, expected.agentCapabilities);
      assert.deepEqual(client.authMethods, expected.authMethods);
    }
  });
}

test('transport closure clears initialize data before reporting disconnection', { timeout: 10000 }, async (t) => {
  let peer;
  const client = await mock(t, (message, socket, send) => {
    if (message.method !== 'initialize') return;
    peer = socket;
    send(message.id, initializedAgent());
    return true;
  });
  await client.connect();
  const closed = Promise.withResolvers();
  client.setConnectionStateHandler((state) => {
    if (state === 'error') { assertUninitialized(client); closed.resolve(); }
  });
  peer.close(1011, 'Agent exited');
  await closed.promise;
});

for (const failure of ['version', 'rpc']) {
  test(`failed initialize (${failure}) does not expose agent data after a previous connection`, { timeout: 10000 }, async (t) => {
    let attempts = 0;
    const client = await mock(t, (message, socket, send) => {
      if (message.method !== 'initialize') return;
      if (++attempts === 1) send(message.id, initializedAgent());
      else if (failure === 'version') send(message.id, { ...initializedAgent(), protocolVersion: 2 });
      else socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Login unavailable' } }));
      return true;
    });
    await client.connect();
    client.disconnect();
    let failed = false;
    client.setConnectionStateHandler((state) => {
      assertUninitialized(client);
      if (state === 'error') failed = true;
    });
    await assert.rejects(client.connect(), failure === 'version' ? /Unsupported ACP protocol version/ : /Login unavailable/);
    assert.equal(failed, true);
    assertUninitialized(client);
  });
}

test('cancelling initialization leaves no data and permits reconnecting', { timeout: 10000 }, async (t) => {
  let attempts = 0;
  const pending = Promise.withResolvers();
  const client = await mock(t, (message, _socket, send) => {
    if (message.method !== 'initialize') return;
    if (++attempts === 1) pending.resolve();
    else send(message.id, initializedAgent());
    return true;
  });
  const connecting = assert.rejects(client.connect(), /connection closed/i);
  await pending.promise;
  assertUninitialized(client);
  client.disconnect();
  await client.connect();
  await connecting;
  assert.deepEqual(client.agentCapabilities, initializedAgent().agentCapabilities);
  assert.deepEqual(client.authMethods, initializedAgent().authMethods);
});

test('ACP initialization, cwd, commands, boolean discriminator, and response-only config confirmation', { timeout: 10000 }, async (t) => {
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
      send(message.id, { sessionId: 's', configOptions: options() });
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: {
        sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }],
      } } }));
      return true;
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
  await client.setConfigOption('thinking', true);
  assert.equal(client.availableCommands[0].name, 'review');
  assert.equal(client.configOptions[1].currentValue, true);
});

for (const legacy of [false, true]) {
  test(`new ${legacy ? 'mode' : 'config'} session ignores unregistered updates and applies updates immediately after its response`, { timeout: 10000 }, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const modes = { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] };
    const updated = options(); updated[0].currentValue = 'smart';
    const received = [];
    const configurations = [];
    const modeChanges = [];
    const commands = [];
    const events = [];
    const complete = Promise.withResolvers();
    const client = await mock(t, (message, socket, send) => {
      if (message.method !== 'session/new') return;
      const update = (value, sessionId = 's') => socket.send(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value },
      }));
      const configuration = legacy
        ? { sessionUpdate: 'current_mode_update', currentModeId: 'code' }
        : { sessionUpdate: 'config_option_update', configOptions: updated };
      const command = (name) => ({ sessionUpdate: 'available_commands_update', availableCommands: [{ name, description: name }] });
      const text = (value) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
      update(configuration);
      update(command('early'));
      update(text('early'));
      send(message.id, { sessionId: 's', ...(legacy ? { modes } : { configOptions: options() }) });
      // No timer or client acknowledgement: preserve adjacent wire ordering.
      update(configuration);
      update(command('live'));
      update(text('wrong session'), 'other');
      update(text('live'));
      return true;
    });
    client.setConfigOptionsChangedHandler((value) => { if (value) { configurations.push(value[0].currentValue); events.push('config'); } });
    client.setSessionModesChangedHandler((value) => { if (value) { modeChanges.push(value.currentModeId); events.push('mode'); } });
    client.setAvailableCommandsChangedHandler((value) => { if (value.length) commands.push(value[0].name); });
    client.setSessionCreatedHandler(() => events.push('created'));
    client.setSessionUpdateHandler((update) => { received.push(update.content.text); complete.resolve(); });
    await client.connect();
    assert.equal(await client.createSession(), 's');
    await complete.promise;
    assert.deepEqual(configurations, legacy ? [] : ['fast', 'smart']);
    assert.deepEqual(modeChanges, legacy ? ['ask', 'code'] : []);
    assert.deepEqual(commands, ['live']);
    assert.deepEqual(received, ['live']);
    assert.deepEqual(events, legacy ? ['mode', 'created', 'mode'] : ['config', 'created', 'config']);
    assert.equal(warnings.mock.callCount(), 4);
    assert.equal(client.configOptions?.[0].currentValue, legacy ? undefined : 'smart');
    assert.equal(client.sessionModes?.currentModeId, legacy ? 'code' : undefined);
  });
}

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

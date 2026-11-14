import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { AcpClient, historyInfoPatch, historyTimestamp } from '../acp/client.ts';

async function mock(t, handle, capabilities = { loadSession: true, sessionCapabilities: { list: {}, delete: {}, resume: {}, additionalDirectories: {} } }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(data);
    const send = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    if (handle(message, socket, send) === true) return;
    if (message.method === 'initialize') send({ protocolVersion: 1, agentCapabilities: capabilities });
    else assert.fail(`Unexpected ${message.method}`);
  }));
  const client = new AcpClient({ url: `ws://127.0.0.1:${server.address().port}`, cwd: '/workspace' });
  t.after(async () => { client.disconnect(); for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  await client.connect();
  return client;
}
const notify = (socket, id, update) => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: id, update } }));
const text = value => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });

const reference = JSON.parse(readFileSync(new URL('./fixtures/history-v1.json', import.meta.url), 'utf8'));
for (const { name, input, expected, error } of reference.cases) {
  test(`Zed v1 list response: ${name}`, { timeout: 10000 }, async t => {
    const client = await mock(t, (message, _socket, send) => {
      if (message.method === 'session/list') {
        assert.deepEqual(message.params, { cursor: '' });
        send(input); return true;
      }
    });
    if (error) await assert.rejects(client.listSessions({ cursor: '' }), /Invalid ACP session\/list response/);
    else {
      const result = await client.listSessions({ cursor: '' });
      const normalized = { ...expected, sessions: expected.sessions.map(({ archived, updatedAt, ...row }) => ({
        ...row, additionalDirectories: row.additionalDirectories ?? [],
        ...(historyTimestamp(updatedAt) !== null ? { updatedAt } : {}),
      })) };
      assert.deepEqual(result, normalized);
    }
  });
}

test('list and delete capabilities gate requests before sending RPCs', { timeout: 10000 }, async t => {
  const client = await mock(t, () => {}, {});
  assert.equal(client.supportsHistory, false);
  assert.equal(client.supportsDelete, false);
  await assert.rejects(client.listSessions(), /Listing sessions is not supported/);
  await assert.rejects(client.deleteSession('s'), /Deleting sessions is not supported/);
});

for (const outcome of ['success', 'missing', 'error', 'malformed']) {
  test(`delete ${outcome} matches Zed v1 and refreshes only on success`, { timeout: 10000 }, async t => {
    const client = await mock(t, (message, socket, send) => {
      if (message.method !== 'session/delete') return;
      assert.deepEqual(message.params, { sessionId: 's' });
      if (outcome === 'error' || outcome === 'missing') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: outcome === 'missing' ? -32002 : -32603, message: 'Delete rejected' } }));
      else send(outcome === 'malformed' ? false : null);
      return true;
    });
    let refreshes = 0;
    const unwatch = client.watchHistory(() => refreshes++);
    if (['success', 'missing'].includes(outcome)) await client.deleteSession('s');
    else await assert.rejects(client.deleteSession('s'), /Delete rejected|Invalid ACP session\/delete response/);
    assert.equal(refreshes, ['success', 'missing'].includes(outcome) ? 1 : 0);
    unwatch();
  });
}

test('independent session owners share initialization and preserve directory, stream, config and permission routing', { timeout: 10000 }, async t => {
  let initialized = 0;
  let socket;
  const seen = [];
  const permissionAnswers = [];
  const cancelled = Promise.withResolvers();
  const client = await mock(t, (message, ws, send) => {
    socket = ws;
    if (message.method === 'initialize') { initialized++; return; }
    if (message.method === undefined) { permissionAnswers.push(message); return true; }
    seen.push(message);
    if (message.method === 'session/new') { send({ sessionId: 'a' }); return true; }
    if (message.method === 'session/load') {
      assert.deepEqual(message.params, { sessionId: 'b', cwd: '/other', additionalDirectories: ['/extra', '/last'], mcpServers: [] });
      notify(ws, 'b', text('replayed b')); send({}); return true;
    }
    if (message.method === 'session/prompt') { notify(ws, message.params.sessionId, text(`reply ${message.params.sessionId}`)); send({ stopReason: 'end_turn' }); return true; }
    if (message.method === 'session/set_config_option') { send({ configOptions: [{ id: 'flag', name: 'Flag', type: 'boolean', currentValue: message.params.value }] }); return true; }
    if (message.method === 'session/cancel') { cancelled.resolve(); return true; }
  });
  const a = client.forkSession();
  const b = client.forkSession('/other', ['/extra', '/last']);
  const aUpdates = [], bUpdates = [];
  a.setSessionUpdateHandler(update => aUpdates.push(update.content.text));
  b.setSessionUpdateHandler(update => bUpdates.push(update.content.text));
  a.setPermissionHandler(async request => ({ outcome: { outcome: 'selected', optionId: request.options[0].optionId } }));
  b.setPermissionHandler(async () => ({ outcome: { outcome: 'cancelled' } }));
  await a.createSession(); await b.restoreSession('b');
  await Promise.all([a.prompt([{ type: 'text', text: 'a' }]), b.prompt([{ type: 'text', text: 'b' }])]);
  await a.cancel();
  await cancelled.promise;
  assert.deepEqual(aUpdates, ['reply a']);
  assert.deepEqual(bUpdates, ['replayed b', 'reply b']);
  await a.setConfigOption('flag', true);
  await b.setConfigOption('flag', false);
  assert.equal(a.configOptions[0].currentValue, true);
  assert.equal(b.configOptions[0].currentValue, false);
  assert.equal(initialized, 1);
  assert.equal(seen.find(message => message.method === 'session/cancel').params.sessionId, 'a');
  const request = { toolCall: { toolCallId: 'same', title: 'Permission' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] };
  for (const id of ['a', 'b']) socket.send(JSON.stringify({ jsonrpc: '2.0', id: `permission-${id}`, method: 'session/request_permission', params: { sessionId: id, ...request } }));
  for (let attempt = 0; permissionAnswers.length < 2 && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(permissionAnswers.length, 2);
  assert.deepEqual(permissionAnswers.find(answer => answer.id === 'permission-a').result.outcome, { outcome: 'selected', optionId: 'allow' });
  assert.deepEqual(permissionAnswers.find(answer => answer.id === 'permission-b').result.outcome, { outcome: 'cancelled' });
  client.disconnect();
  assert.equal(a.agentCapabilities, null); assert.equal(b.agentCapabilities, null);
  assert.equal(a.currentSessionId, null); assert.equal(b.currentSessionId, null);
  await assert.rejects(a.prompt([]), /Not connected/);
});

test('registered session-info updates reach history; unknown and forgotten sessions remain ignored', { timeout: 10000 }, async t => {
  t.mock.method(console, 'warn', () => {});
  let socket;
  const client = await mock(t, (message, ws, send) => {
    socket = ws;
    if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
  });
  const session = client.forkSession();
  await session.createSession();
  const updates = [];
  client.watchHistory((id, update) => updates.push({ id, update }));
  notify(socket, 'unknown', { sessionUpdate: 'session_info_update', title: 'wrong' });
  notify(socket, 's', { sessionUpdate: 'session_info_update', title: 'right', _meta: { a: 1 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updates.length, 1); assert.equal(updates[0].id, 's');
  session.forgetSession();
  notify(socket, 's', { sessionUpdate: 'session_info_update', title: 'late' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(updates.length, 1);
});

test('a duplicate session ID cannot steal another owner registration', { timeout: 10000 }, async t => {
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
    if (message.method === 'session/prompt') { send({ stopReason: 'end_turn' }); return true; }
  });
  const a = client.forkSession(), b = client.forkSession();
  await a.createSession();
  await assert.rejects(b.restoreSession('s'), /Session is already open/);
  assert.equal(a.currentSessionId, 's');
  await a.prompt([]);
});

test('empty opaque session IDs remain valid for restore and prompts', { timeout: 10000 }, async t => {
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'session/load') { assert.equal(message.params.sessionId, ''); send({}); return true; }
    if (message.method === 'session/prompt') { assert.equal(message.params.sessionId, ''); send({ stopReason: 'end_turn' }); return true; }
  });
  const session = client.forkSession();
  await session.restoreSession(''); await session.prompt([]);
});

test('session-info tri-state values and v1 metadata replacement follow Zed', () => {
  const row = { title: 'Before', updatedAt: '2026-11-09T00:00:00Z', _meta: { old: 1 } };
  assert.deepEqual({ ...row, ...historyInfoPatch({ sessionUpdate: 'session_info_update' }) }, row);
  const cleared = { ...row, ...historyInfoPatch({ sessionUpdate: 'session_info_update', title: null, updatedAt: null, _meta: { new: 2 } }) };
  assert.deepEqual(cleared, { title: undefined, updatedAt: undefined, _meta: { new: 2 } });
  assert.deepEqual(historyInfoPatch({ sessionUpdate: 'session_info_update', updatedAt: '2026-02-30T00:00:00Z' }), {});
  assert.deepEqual(historyInfoPatch({ sessionUpdate: 'session_info_update', _meta: {} }), { _meta: {} });
});

for (const invalid of ['yesterday', '2026-02-30T00:00:00Z', '2026-11-09', '2026-11-09T24:00:00Z', '2026-11-09T00:00:00', '2026-11-09T00:00:00+24:00']) {
  test(`invalid RFC3339 timestamp is ignored: ${invalid}`, () => assert.equal(historyTimestamp(invalid), null));
}
test('RFC3339 offsets, fractional seconds and leap seconds remain sortable', () => {
  assert.equal(historyTimestamp('2026-11-09T08:00:00.125+08:00'), Date.parse('2026-11-09T00:00:00.125Z'));
  assert.equal(historyTimestamp('2016-12-31T23:59:60Z'), Date.parse('2017-01-01T00:00:00Z'));
});

test('explicit list filters and opaque cursors are forwarded without inventing a default cwd', { timeout: 10000 }, async t => {
  const client = await mock(t, (message, _socket, send) => {
    if (message.method !== 'session/list') return;
    assert.deepEqual(message.params, { cwd: '/other workspace', cursor: 'opaque:/+= cursor' });
    send({ sessions: [], nextCursor: 'next' }); return true;
  });
  assert.equal((await client.listSessions({ cwd: '/other workspace', cursor: 'opaque:/+= cursor' })).nextCursor, 'next');
});

test('disconnect rejects a pending list and the same client can list on a fresh connection', { timeout: 10000 }, async t => {
  const listed = Promise.withResolvers();
  let attempts = 0;
  const client = await mock(t, (message, _socket, send) => {
    if (message.method !== 'session/list') return;
    if (++attempts === 1) listed.resolve();
    else send({ sessions: [{ sessionId: 'new', cwd: '/new' }] });
    return true;
  });
  const old = assert.rejects(client.listSessions(), /closed/i);
  await listed.promise;
  client.disconnect();
  await client.connect();
  await old;
  assert.equal((await client.listSessions()).sessions[0].sessionId, 'new');
});

test('saved additional directories are omitted when the agent did not advertise support', { timeout: 10000 }, async t => {
  const client = await mock(t, (message, _socket, send) => {
    if (message.method !== 'session/load') return;
    assert.deepEqual(message.params, { sessionId: 's', cwd: '/saved', mcpServers: [] });
    send({}); return true;
  }, { loadSession: true });
  await client.forkSession('/saved', ['/extra']).restoreSession('s');
});

for (const outcome of ['success', 'error', 'malformed', 'unsupported']) {
  test(`released owner ${outcome} is a barrier before another owner can load its ID`, { timeout: 10000 }, async t => {
    t.mock.method(console, 'warn', () => {});
    const closing = Promise.withResolvers();
    let finish;
    let socket;
    const calls = [];
    const client = await mock(t, (message, ws, send) => {
      socket = ws;
      if (message.method === 'initialize') return;
      calls.push(message.method);
      if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
      if (message.method === 'session/close') {
        assert.deepEqual(message.params, { sessionId: 's' });
        finish = () => {
          ws._socket.cork();
          if (outcome === 'error') ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Close rejected' } }));
          else send(outcome === 'malformed' ? false : null);
          notify(ws, 's', text('old after close'));
          ws._socket.uncork();
        };
        closing.resolve(); return true;
      }
      if (message.method === 'session/load') {
        notify(ws, 's', text('new history')); send({}); return true;
      }
    }, { loadSession: true, sessionCapabilities: outcome === 'unsupported' ? {} : { close: {} } });
    const old = client.forkSession();
    const oldUpdates = [], newUpdates = [];
    old.setSessionUpdateHandler(update => oldUpdates.push(update.content.text));
    await old.createSession();
    const release = old.releaseSession();
    const replacement = client.forkSession();
    replacement.setSessionUpdateHandler(update => newUpdates.push(update.content.text));
    const loading = replacement.restoreSession('s');
    if (outcome !== 'unsupported') {
      await closing.promise;
      assert.deepEqual(calls, ['session/new', 'session/close']);
      notify(socket, 's', text('old before close'));
      finish();
    }
    await release; await loading;
    assert.deepEqual(oldUpdates, []);
    assert.deepEqual(newUpdates, ['new history']);
    assert.equal(old.currentSessionId, null);
    assert.equal(replacement.currentSessionId, 's');
  });
}

test('releasing an owner cancels its configuration task without cancelling another owner', { timeout: 10000 }, async t => {
  t.mock.method(console, 'warn', () => {});
  const configuring = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let configId;
  let sessions = 0;
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'session/new') { send({ sessionId: `s-${++sessions}` }); return true; }
    if (message.method === 'session/set_config_option') { configId = message.id; configuring.resolve(); return true; }
    if (message.method === '$/cancel_request') { assert.equal(message.params.requestId, configId); cancelled.resolve(); return true; }
    if (message.method === 'session/prompt') { send({ stopReason: 'end_turn' }); return true; }
  });
  const a = client.forkSession(), b = client.forkSession();
  await a.createSession(); await b.createSession();
  const change = assert.rejects(a.setConfigOption('flag', true), error => error.code === -32800);
  await configuring.promise;
  await a.releaseSession();
  await change; await cancelled.promise;
  assert.equal(b.currentSessionId, 's-2');
  await b.prompt([]);
});

test('disconnect during release cannot register a waiting replacement on the new connection', { timeout: 10000 }, async t => {
  t.mock.method(console, 'warn', () => {});
  const closing = Promise.withResolvers();
  let loads = 0;
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
    if (message.method === 'session/close') { closing.resolve(); return true; }
    if (message.method === 'session/load') { loads++; send({}); return true; }
  }, { loadSession: true, sessionCapabilities: { close: {} } });
  const a = client.forkSession(); await a.createSession();
  const release = a.releaseSession();
  const b = client.forkSession();
  const loading = assert.rejects(b.restoreSession('s'), /Connection closed/);
  await closing.promise;
  client.disconnect(); await client.connect();
  const c = client.forkSession(); await c.restoreSession('s');
  await release; await loading;
  assert.equal(loads, 1);
  assert.equal(c.currentSessionId, 's');
});

for (const strategy of ['new', 'load', 'resume']) {
  for (const outcome of ['success', 'error']) {
    test(`release of pending ${strategy} ${outcome} waits for its wire operation before replacement`, { timeout: 10000 }, async t => {
      t.mock.method(console, 'warn', () => {});
      const opening = Promise.withResolvers();
      const closing = Promise.withResolvers();
      let finishOpen, finishClose;
      let first = true;
      const calls = [];
      const method = `session/${strategy}`;
      const replacementMethod = strategy === 'resume' ? 'session/resume' : 'session/load';
      const client = await mock(t, (message, socket, send) => {
        if (message.method === 'initialize') return;
        calls.push(message.method);
        if (message.method === method && first) {
          first = false;
          finishOpen = () => {
            socket._socket.cork();
            if (outcome === 'error') socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Opening rejected' } }));
            else send(strategy === 'new' ? { sessionId: 's' } : {});
            notify(socket, 's', text('old opening replay'));
            socket._socket.uncork();
          };
          opening.resolve(); return true;
        }
        if (message.method === 'session/close') {
          assert.equal(message.params.sessionId, 's');
          finishClose = () => {
            socket._socket.cork();
            send({}); notify(socket, 's', text('old closing replay'));
            socket._socket.uncork();
          };
          closing.resolve(); return true;
        }
        if (message.method === replacementMethod) { notify(socket, 's', text('replacement history')); send({}); return true; }
      }, { loadSession: strategy !== 'resume', sessionCapabilities: { close: {}, resume: {} } });
      const old = client.forkSession();
      const request = strategy === 'new' ? old.createSession() : old.restoreSession('s');
      const original = assert.rejects(request, outcome === 'success' ? /Connection closed/ : /Opening rejected/);
      await opening.promise;
      const release = old.releaseSession();
      const replacement = client.forkSession();
      const updates = [];
      replacement.setSessionUpdateHandler(update => updates.push(update.content.text));
      let loading;
      if (strategy !== 'new') loading = replacement.restoreSession('s');
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.deepEqual(calls, [method]);
      finishOpen();
      if (outcome === 'success') {
        await closing.promise;
        if (strategy === 'new') loading = replacement.restoreSession('s');
        assert.equal(calls.filter(value => value === replacementMethod).length, strategy === 'new' ? 0 : 1);
        finishClose();
      }
      await release; await original;
      if (loading) {
        await loading;
        assert.deepEqual(updates, ['replacement history']);
      }
      assert.equal(calls.filter(value => value === 'session/close').length, outcome === 'success' ? 1 : 0);
      assert.equal(old.currentSessionId, null);
    });
  }
}

test('dropping an authenticating view cancels its auth task and releases its existing session', { timeout: 10000 }, async t => {
  const authenticating = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let authId;
  const client = await mock(t, (message, _socket, send) => {
    if (message.method === 'initialize') {
      send({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [{ id: 'login', name: 'Login' }] });
      return true;
    }
    if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
    if (message.method === 'authenticate') { authId = message.id; authenticating.resolve(); return true; }
    if (message.method === '$/cancel_request') { assert.equal(message.params.requestId, authId); cancelled.resolve(); return true; }
    if (message.method === 'session/close' || message.method === 'session/load') { send({}); return true; }
  });
  const old = client.forkSession(); await old.createSession();
  const auth = assert.rejects(old.authenticate('login'), error => error.code === -32800);
  await authenticating.promise;
  await old.releaseSession(); await auth; await cancelled.promise;
  const replacement = client.forkSession();
  await replacement.restoreSession('s');
  assert.equal(replacement.currentSessionId, 's');
});

for (const target of ['s', 'other']) {
  test(`releasing during reset close protects both the old ID and target ${target} without a cycle`, { timeout: 10000 }, async t => {
    t.mock.method(console, 'warn', () => {});
    const closing = Promise.withResolvers();
    let finishClose;
    const calls = [];
    const client = await mock(t, (message, socket, send) => {
      if (message.method === 'initialize') return;
      calls.push({ method: message.method, id: message.params?.sessionId });
      if (message.method === 'session/new') { send({ sessionId: 's' }); return true; }
      if (message.method === 'session/close') {
        assert.equal(message.params.sessionId, 's');
        finishClose = () => {
          socket._socket.cork();
          send({}); notify(socket, 's', text('old reset output'));
          socket._socket.uncork();
        };
        closing.resolve(); return true;
      }
      if (message.method === 'session/load') { send({}); return true; }
    }, { loadSession: true, sessionCapabilities: { close: {} } });
    const old = client.forkSession(); await old.createSession();
    const resetting = assert.rejects(old.restoreSession(target), /Connection closed/);
    await closing.promise;
    const release = old.releaseSession();
    const previousReplacement = client.forkSession();
    const previousLoading = previousReplacement.restoreSession('s');
    const targetReplacement = target === 's' ? null : client.forkSession();
    const targetLoading = targetReplacement?.restoreSession(target);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls.map(call => call.method), ['session/new', 'session/close']);
    finishClose();
    await Promise.all([resetting, release, previousLoading, targetLoading]);
    assert.equal(previousReplacement.currentSessionId, 's');
    if (targetReplacement) assert.equal(targetReplacement.currentSessionId, target);
    assert.equal(calls.filter(call => call.method === 'session/close').length, 1);
    assert.equal(calls.filter(call => call.method === 'session/load').length, target === 's' ? 1 : 2);
  });
}

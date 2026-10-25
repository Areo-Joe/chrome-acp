import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { writeTextFile } from '../dist/files.js';

const cli = fileURLToPath(new URL('../dist/cli/bin.js', import.meta.url));
const agent = fileURLToPath(new URL('./fixtures/agent.mjs', import.meta.url));

async function start(t, acp = true, nodeArgs = []) {
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const child = spawn(process.execPath, [...nodeArgs, cli, ...(acp ? ['--acp'] : []), '--host', '127.0.0.1', '--port', String(port), process.execPath, '--', agent], {
    env: { ...process.env, ACP_AUTH_TOKEN: 'test-token' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch {}
    if (i > 100 || child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token`);
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(message); else queue.push(message);
  });
  await once(ws, 'open');
  t.after(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.close();
      await once(ws, 'close');
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  return {
    ws, url, child, output: () => output,
    send: (message) => ws.send(JSON.stringify(message)),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)),
  };
}

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
async function openSession(client, cwd = process.cwd(), id = 's', clientCapabilities = {}) {
  client.send(request('init', 'initialize', { protocolVersion: 1, clientCapabilities }));
  assert.ok((await client.next()).result);
  client.send(request('new', 'session/new', { cwd, mcpServers: [], _meta: { sessionId: id } }));
  assert.equal((await client.next()).result.sessionId, id);
}

const local = async (client, id, method, params) => {
  client.send(request(id, 'test/client-request', { method, params }));
  const response = await client.next();
  assert.equal(response.id, id);
  return response.result;
};

test('ACP WebSocket forwards messages and serves local capabilities', { timeout: 15000 }, async (t) => {
  const client = await start(t);
  client.send(request(1, 'initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false }, elicitation: { form: {} }, _meta: { future: true } }, _meta: { custom: 1 } }));
  const init = (await client.next()).result._meta.received;
  assert.deepEqual(init.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
  assert.equal(init.clientCapabilities.terminal, true);
  assert.deepEqual(init.clientCapabilities.elicitation, { form: {} });
  assert.deepEqual(init._meta, { custom: 1 });
  assert.deepEqual(init.clientCapabilities._meta, { future: true });

  client.send(request('new', 'session/new', { cwd: process.cwd(), mcpServers: [] }));
  assert.equal((await client.next()).result.sessionId, 's');

  const unknown = { ...request('future', 'future/method', { extension: [1, 2] }), _meta: { opaque: true } };
  client.send(unknown);
  assert.deepEqual((await client.next()).result, unknown);
  const notification = { method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'future', extra: true } } };
  client.send({ jsonrpc: '2.0', method: 'test/notify', params: notification });
  assert.deepEqual(await client.next(), { jsonrpc: '2.0', ...notification });

  // Both directions can use the same request ID without conflating responses.
  client.send(request('agent-1', 'test/client-request', { method: 'session/request_permission', params: { future: true } }));
  const permission = await client.next();
  assert.equal(permission.method, 'session/request_permission');
  client.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'cancelled' } } });
  assert.equal((await client.next()).result.result.outcome.outcome, 'cancelled');

  const dir = await mkdtemp(join(tmpdir(), 'acp-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'test.txt');
  assert.deepEqual((await local(client, 3, 'fs/write_text_file', { sessionId: 's', path, content: 'one\ntwo\nthree' })).result, {});
  assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nthree');
  assert.equal((await local(client, 4, 'fs/read_text_file', { sessionId: 's', path, line: 2, limit: 1 })).result.content, 'two\n');
  assert.ok((await local(client, 5, 'fs/read_text_file', { sessionId: 's', path: join(dir, 'missing') })).error);
  assert.equal((await local(client, 6, 'terminal/create', { sessionId: 's' })).error.code, -32602);

  const { terminalId } = (await local(client, 7, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', 'console.log("terminal works")'] })).result;
  assert.equal((await local(client, 8, 'terminal/wait_for_exit', { sessionId: 's', terminalId })).result.exitCode, 0);
  assert.match((await local(client, 9, 'terminal/output', { sessionId: 's', terminalId })).result.output, /terminal works/);
  assert.ok((await local(client, 10, 'terminal/output', { sessionId: 'other', terminalId })).error);
  await local(client, 11, 'terminal/release', { sessionId: 's', terminalId });

  const running = (await local(client, 12, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })).result.terminalId;
  client.send(request(13, 'test/client-request', { id: 'pending-wait', method: 'terminal/wait_for_exit', params: { sessionId: 's', terminalId: running } }));
  client.send({ jsonrpc: '2.0', method: 'test/cancel', params: { requestId: 'pending-wait' } });
  assert.equal((await client.next()).result.error.code, -32800);
  await local(client, 14, 'terminal/kill', { sessionId: 's', terminalId: running });

  client.ws.send('{');
  assert.equal((await client.next()).error.code, -32700);
  client.send({ type: 'connect' });
  assert.equal((await client.next()).error.code, -32600);
  assert.equal((await fetch(`${client.url}/mcp`, { method: 'POST' })).status, 404);
});

test('default mode retains the legacy connect and session messages', { timeout: 10000 }, async (t) => {
  const client = await start(t, false);
  client.send({ type: 'connect' });
  const status = await client.next();
  assert.equal(status.type, 'status');
  assert.equal(status.payload.connected, true);
  client.send({ type: 'new_session' });
  assert.equal((await client.next()).type, 'session_created');
});

test('ACP mode rejects invalid tokens and closes when the agent exits', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const unauthorized = new WebSocket(client.url.replace('http:', 'ws:') + '/ws?token=wrong');
  assert.equal((await once(unauthorized, 'close'))[0], 4001);
  client.send(request(1, 'test/exit'));
  assert.equal((await once(client.ws, 'close'))[0], 1011);
});

test('disconnect stops local terminal processes', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  await openSession(client);
  const dir = await mkdtemp(join(tmpdir(), 'acp-relay-cleanup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'pid');
  await local(client, 1, 'terminal/create', {
    sessionId: 's', command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', path],
  });
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(path, 'utf8')); break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  t.after(() => { try { process.kill(pid); } catch {} });
  client.ws.close();
  await once(client.ws, 'close');
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Local terminal survived disconnect');
});

async function rpc(client, id, method, params = {}) {
  client.send(request(id, method, params));
  const response = await client.next();
  assert.equal(response.id, id);
  return response;
}

async function waitForFile(path) {
  for (let i = 0; i < 100; i++) {
    try { return await readFile(path, 'utf8'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`File was not created: ${path}`);
}

async function assertStopped(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Process survived cleanup: ${pid}`);
}

test('agent exit drains its final response and closes inherited pipes within a bound', { timeout: 10000, skip: process.platform === 'win32' }, async (t) => {
  const client = await start(t);
  client.send(request('exit', 'test/exit-with-descendant'));
  const response = await client.next();
  assert.equal(response.id, 'exit');
  assert.equal(response.result.finalMessage, true);
  const pid = response.result.pid;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  const started = Date.now();
  const [code] = await once(client.ws, 'close');
  assert.equal(code, 1011);
  assert.ok(Date.now() - started < 2000, 'Inherited stdio prevented bounded shutdown');
  await assertStopped(pid);
});

test('local capabilities require an initialized live session and release closed sessions', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-sessions-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'file');
  const write = { sessionId: 's', path, content: 'content\n' };
  assert.match((await local(client, 1, 'fs/write_text_file', write)).error.data, /unknown session/);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await openSession(client, dir);
  assert.deepEqual((await local(client, 2, 'fs/write_text_file', write)).result, {});
  assert.ok((await local(client, 3, 'terminal/create', { sessionId: 'other', command: 'echo hello' })).error);

  assert.ok((await rpc(client, 4, 'session/close', { sessionId: 's', _meta: { fail: true } })).error);
  assert.equal((await local(client, 5, 'fs/read_text_file', { sessionId: 's', path })).result.content, 'content\n');

  const { terminalId } = (await local(client, 6, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] })).result;
  assert.ok((await rpc(client, 7, 'session/close', { sessionId: 's' })).result);
  assert.ok((await local(client, 8, 'fs/write_text_file', write)).error);
  assert.ok((await local(client, 9, 'terminal/create', { sessionId: 's', command: 'echo hello' })).error);
  // Reopening the same session ID must not restore its old terminal handles.
  await rpc(client, 10, 'session/resume', { sessionId: 's', cwd: dir });
  assert.ok((await local(client, 11, 'terminal/output', { sessionId: 's', terminalId })).error);
  await rpc(client, 12, 'session/delete', { sessionId: 's' });
  assert.equal((await local(client, 13, 'fs/read_text_file', { sessionId: 's', path })).result.content, 'content\n');
});

test('loads accept replay requests, roll back failures, and preserve concurrent successful loads', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  const path = join(dir, 'file');
  await local(client, 1, 'fs/write_text_file', { sessionId: 's', path, content: 'replay\n' });
  const replay = (sessionId) => ({ method: 'fs/read_text_file', params: { sessionId, path } });
  const failed = await rpc(client, 2, 'session/load', { sessionId: 'failed', cwd: dir, _meta: { replay: replay('failed'), fail: true } });
  assert.equal(failed.error.data.replay.result.content, 'replay\n');
  assert.ok((await local(client, 3, 'fs/read_text_file', { sessionId: 'failed', path })).error);
  assert.equal((await local(client, 4, 'fs/read_text_file', { sessionId: 's', path })).result.content, 'replay\n');

  client.send(request(5, 'session/load', { sessionId: 'loaded', cwd: dir, _meta: { fail: true, delayMs: 50 } }));
  client.send(request(6, 'session/load', { sessionId: 'loaded', cwd: dir, _meta: { replay: replay('loaded') } }));
  const responses = [await client.next(), await client.next()];
  assert.equal(responses.find((m) => m.id === 6).result._meta.replay.result.content, 'replay\n');
  assert.ok(responses.find((m) => m.id === 5).error);
  assert.equal((await local(client, 7, 'fs/read_text_file', { sessionId: 'loaded', path })).result.content, 'replay\n');
  await rpc(client, 8, 'session/load', { sessionId: 'loaded', cwd: dir, _meta: { fail: true } });
  assert.equal((await local(client, 9, 'fs/read_text_file', { sessionId: 'loaded', path })).result.content, 'replay\n');
});

test('file ranges retain newlines and reject out-of-range starts', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-ranges-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  const path = join(dir, 'file');
  let id = 0;
  for (const [content, cases] of [
    ['a\nb\nc', [[1, 1, 'a\n'], [2, 1, 'b\n'], [3, 1, 'c'], [0, 1, 'a\n'], [2, 0, ''], [2, 99, 'b\nc'], [4, 1, null]]],
    ['a\n', [[2, 1, ''], [3, 0, null]]],
    ['', [[1, 1, ''], [2, 1, null]]],
  ]) {
    await local(client, ++id, 'fs/write_text_file', { sessionId: 's', path, content });
    for (const [line, limit, expected] of cases) {
      const response = await local(client, ++id, 'fs/read_text_file', { sessionId: 's', path, line, limit });
      if (expected === null) assert.equal(response.error.code, -32602);
      else assert.equal(response.result.content, expected);
    }
  }
  assert.equal((await local(client, ++id, 'fs/read_text_file', { sessionId: 's', path: 'relative' })).error.code, -32602);
});

test('headless terminals execute shell expressions, quote args, disable pagers, and report failures', { timeout: 10000, skip: process.platform === 'win32' }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-shell-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  let id = 0;
  const run = async (params) => {
    const created = await local(client, ++id, 'terminal/create', { sessionId: 's', ...params });
    assert.ok(created.result, JSON.stringify(created));
    const terminalId = created.result.terminalId;
    const status = (await local(client, ++id, 'terminal/wait_for_exit', { sessionId: 's', terminalId })).result;
    const output = (await local(client, ++id, 'terminal/output', { sessionId: 's', terminalId })).result;
    await local(client, ++id, 'terminal/release', { sessionId: 's', terminalId });
    return { status, ...output };
  };
  assert.equal((await run({ command: "printf 'hello'" })).output, 'hello');
  const args = ['a b', "a'b", '$HOME', '`uname`', '$(uname)', 'line\nbreak'];
  const quoted = await run({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args] });
  assert.deepEqual(JSON.parse(quoted.output), args);
  const env = await run({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({pager:process.env.PAGER,gitPager:process.env.GIT_PAGER,cwd:process.cwd()}))'] });
  assert.deepEqual(JSON.parse(env.output), { pager: '', gitPager: 'cat', cwd: await realpath(dir) });
  const overridden = await run({ command: 'printf "$GIT_PAGER"', env: [{ name: 'GIT_PAGER', value: 'custom' }] });
  assert.equal(overridden.output, 'custom');
  assert.equal((await run({ command: 'acp-test-nonexistent-command-123456' })).status.exitCode, 127);
  assert.ok((await local(client, ++id, 'terminal/create', { sessionId: 's', command: 'echo hello', cwd: join(dir, 'missing') })).error);
});

test('terminal output keeps a UTF-8-safe prefix and truncates at complete lines', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  await openSession(client);
  let id = 0;
  for (const [text, limit, expected, truncated] of [
    ['first\nsecond\nthird', 10, 'first', true],
    ['你好世界', 7, '你好', true],
    ['abc', 0, '', true],
    ['abc\n', 4, 'abc\n', false],
    ['abcdef', undefined, 'abcdef', false],
  ]) {
    const { terminalId } = (await local(client, ++id, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', text], outputByteLimit: limit })).result;
    await local(client, ++id, 'terminal/wait_for_exit', { sessionId: 's', terminalId });
    const output = (await local(client, ++id, 'terminal/output', { sessionId: 's', terminalId })).result;
    assert.equal(output.output, expected);
    assert.equal(output.truncated, truncated);
    await local(client, ++id, 'terminal/release', { sessionId: 's', terminalId });
  }
});

test('terminal kill and release stop descendants and settle exit waiters', { timeout: 15000, skip: process.platform === 'win32' }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-process-tree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  let id = 0;
  for (const action of ['terminal/kill', 'terminal/release', 'session/close']) {
    if (action === 'session/close') await rpc(client, ++id, 'session/resume', { sessionId: 's', cwd: dir });
    const path = join(dir, action.replace('/', '-'));
    const script = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});require("node:fs").writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);';
    const { terminalId } = (await local(client, ++id, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', script, path] })).result;
    const pid = Number(await waitForFile(path));
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
    if (action === 'session/close') await rpc(client, ++id, action, { sessionId: 's' });
    else await local(client, ++id, action, { sessionId: 's', terminalId });
    await assertStopped(pid);
    if (action === 'terminal/kill') {
      const result = await local(client, ++id, 'terminal/wait_for_exit', { sessionId: 's', terminalId });
      assert.ok(result.result.signal || result.result.exitCode !== null);
    }
  }
});

test('SIGTERM cleans up agent and terminal process groups', { timeout: 10000, skip: process.platform === 'win32' }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-shutdown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  const { pid, agentPid } = (await rpc(client, 1, 'test/spawn-descendant')).result;
  const path = join(dir, 'terminal.pid');
  await local(client, 2, 'terminal/create', { sessionId: 's', command: process.execPath,
    args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', path] });
  const terminalPid = Number(await waitForFile(path));
  for (const childPid of [pid, agentPid, terminalPid]) {
    t.after(() => { try { process.kill(childPid, 'SIGKILL'); } catch {} });
  }
  const exited = once(client.child, 'exit');
  client.child.kill('SIGTERM');
  assert.equal((await exited)[0], 143);
  await Promise.all([pid, agentPid, terminalPid].map(assertStopped));
});

test('subagent local capabilities share parent ownership and are released with the parent', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-subagent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir, 's', { subagents: {} });
  client.send({ jsonrpc: '2.0', method: 'test/notify', params: { method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'subagent_update', sessionId: 'child' } } } });
  assert.equal((await client.next()).params.update.sessionId, 'child');
  const path = join(dir, 'child.txt');
  assert.ok((await local(client, 1, 'fs/write_text_file', { sessionId: 'child', path, content: 'child' })).result);
  await rpc(client, 2, 'session/close', { sessionId: 's' });
  assert.ok((await local(client, 3, 'fs/read_text_file', { sessionId: 'child', path })).error);
});

test('separate clients cannot access each other\'s local terminal handles', { timeout: 10000 }, async (t) => {
  const first = await start(t);
  // Use a second connection to the same proxy, creating its own agent process.
  const secondWs = new WebSocket(first.url.replace('http:', 'ws:') + '/ws?token=test-token');
  const queue = [];
  const waiters = [];
  secondWs.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(message); else queue.push(message);
  });
  await once(secondWs, 'open');
  t.after(async () => { if (secondWs.readyState !== WebSocket.CLOSED) { secondWs.close(); await once(secondWs, 'close'); } });
  const second = {
    send: (message) => secondWs.send(JSON.stringify(message)),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)),
  };
  await openSession(first);
  await openSession(second);
  const { terminalId } = (await local(first, 1, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', 'console.log("first")'] })).result;
  assert.ok((await local(second, 1, 'terminal/output', { sessionId: 's', terminalId })).error);
  await local(first, 2, 'terminal/wait_for_exit', { sessionId: 's', terminalId });
  assert.match((await local(first, 3, 'terminal/output', { sessionId: 's', terminalId })).result.output, /first/);
});

test('file read cancellation uses ACP request cancellation and leaves the session usable', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-file-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'file');
  await writeFile(path, 'a'.repeat(1024 * 1024));
  await openSession(client, dir);
  client.send(request(1, 'test/client-request', { id: 'read-to-cancel', method: 'fs/read_text_file', params: { sessionId: 's', path } }));
  client.send({ jsonrpc: '2.0', method: 'test/cancel', params: { requestId: 'read-to-cancel' } });
  assert.equal((await client.next()).result.error.code, -32800);
  assert.equal((await local(client, 2, 'fs/read_text_file', { sessionId: 's', path, limit: 0 })).result.content, '');
});

test('terminal UTF-8 decoding survives split byte sequences across chunks', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  await openSession(client);
  const script = 'process.stdout.write(Buffer.from([0xe4,0xbd]));setTimeout(()=>process.stdout.write(Buffer.from([0xa0,0xe5,0xa5,0xbd])),30);';
  const { terminalId } = (await local(client, 1, 'terminal/create', { sessionId: 's', command: process.execPath, args: ['-e', script] })).result;
  await local(client, 2, 'terminal/wait_for_exit', { sessionId: 's', terminalId });
  assert.equal((await local(client, 3, 'terminal/output', { sessionId: 's', terminalId })).result.output, '你好');
});

test('write cancellation preserves the original before acceptance and finishes an accepted write', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-write-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'file');
  await writeFile(path, 'original contents');
  const before = new AbortController();
  before.abort();
  await assert.rejects(writeTextFile(path, 'replacement', before.signal), { name: 'AbortError' });
  assert.equal(await readFile(path, 'utf8'), 'original contents');

  const accepted = new AbortController();
  const content = 'replacement\n'.repeat(100000);
  const writing = writeTextFile(path, content, accepted.signal);
  // The handler has accepted the operation and yielded to asynchronous IO.
  // Cancelling now must never leave a truncated or partially written file.
  accepted.abort();
  await writing;
  assert.equal(await readFile(path, 'utf8'), content);
});

test('deleting history keeps a live session and its terminal usable', { timeout: 10000 }, async (t) => {
  const client = await start(t);
  const dir = await mkdtemp(join(tmpdir(), 'acp-delete-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await openSession(client, dir);
  const { terminalId } = (await local(client, 1, 'terminal/create', {
    sessionId: 's', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'],
  })).result;
  assert.ok((await rpc(client, 2, 'session/delete', { sessionId: 's' })).result);
  const output = await local(client, 3, 'terminal/output', { sessionId: 's', terminalId });
  assert.equal(output.result.exitStatus, null);
  const path = join(dir, 'still-active');
  assert.deepEqual((await local(client, 4, 'fs/write_text_file', { sessionId: 's', path, content: 'active' })).result, {});
  assert.equal(await readFile(path, 'utf8'), 'active');
  await rpc(client, 5, 'session/close', { sessionId: 's' });
  assert.ok((await local(client, 6, 'terminal/output', { sessionId: 's', terminalId })).error);
});

test('omitted and null subagent capabilities do not grant local child-session access', { timeout: 10000 }, async (t) => {
  for (const subagents of [undefined, null]) {
    const client = await start(t);
    const dir = await mkdtemp(join(tmpdir(), 'acp-subagent-gate-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await openSession(client, dir, 's', { subagents });
    const notification = { method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'subagent_update', sessionId: 'child' } } };
    client.send({ jsonrpc: '2.0', method: 'test/notify', params: notification });
    // Wire messages still pass through; only local ownership is gated.
    assert.deepEqual(await client.next(), { jsonrpc: '2.0', ...notification });
    const path = join(dir, 'file');
    assert.match((await local(client, 1, 'fs/write_text_file', { sessionId: 'child', path, content: 'child' })).error.data, /unknown session/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    assert.deepEqual((await local(client, 2, 'fs/write_text_file', { sessionId: 's', path, content: 'parent' })).result, {});
  }
});

test('SIGINT and SIGTERM drain accepted slow writes in both protocol modes', { timeout: 20000 }, async (t) => {
  const preload = fileURLToPath(new URL('./fixtures/slow-writes.mjs', import.meta.url));
  for (const [acp, signal, expectedCode] of [[true, 'SIGTERM', 143], [false, 'SIGINT', 130]]) {
    const client = await start(t, acp, ['--import', preload]);
    const dir = await mkdtemp(join(tmpdir(), 'acp-slow-shutdown-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    if (acp) {
      await openSession(client, dir);
    } else {
      client.send({ type: 'connect' });
      assert.equal((await client.next()).payload.connected, true);
      client.send({ type: 'new_session', payload: { cwd: dir } });
      assert.equal((await client.next()).type, 'session_created');
    }
    const path = join(dir, 'file.slow-save');
    const content = 'accepted save\n'.repeat(10000);
    const call = { method: 'fs/write_text_file', params: { sessionId: 's', path, content } };
    if (acp) client.send(request('write', 'test/client-request', call));
    else client.send({ type: 'prompt', payload: { content: [{ type: 'text', text: JSON.stringify(call) }] } });
    // The preload pauses after writing one byte, so this is definitely an
    // accepted operation already past truncation, rather than a queued request.
    assert.equal(await waitForFile(path), content[0]);
    const exited = once(client.child, 'exit');
    const disconnected = once(client.ws, 'close');
    const started = Date.now();
    client.child.kill(signal);
    await disconnected;
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.child.kill(signal);
    const [exitCode, exitSignal] = await exited;
    assert.equal(exitCode, expectedCode);
    assert.equal(exitSignal, null);
    assert.ok(Date.now() - started >= 1000, 'Shutdown deadline interrupted the slow save');
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

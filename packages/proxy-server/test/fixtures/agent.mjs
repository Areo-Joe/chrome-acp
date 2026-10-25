import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const pending = new Map();
let nextId = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (!('method' in message)) {
    const originalId = pending.get(message.id);
    if (originalId !== undefined) {
      pending.delete(message.id);
      if (typeof originalId === 'function') { originalId(message); continue; }
      send({ jsonrpc: '2.0', id: originalId, result: message });
    }
    continue;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, delete: {} } }, agentInfo: { name: 'test-agent', version: '1' },
      _meta: { received: message.params },
    } });
  } else if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params?._meta?.sessionId ?? 's' } });
  } else if (['session/close', 'session/delete', 'session/load', 'session/resume'].includes(message.method)) {
    const respond = (replay) => {
      const response = message.params?._meta?.fail
        ? { error: { code: -32603, message: 'simulated failure', data: { replay } } }
        : { result: { _meta: { replay } } };
      setTimeout(() => send({ jsonrpc: '2.0', id: message.id, ...response }), message.params?._meta?.delayMs ?? 0);
    };
    const replay = message.params?._meta?.replay;
    if (replay) {
      const id = `agent-${++nextId}`;
      pending.set(id, respond);
      send({ jsonrpc: '2.0', id, ...replay });
    } else respond();
  } else if (message.method === 'session/fork') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'forked' } });
  } else if (message.method === 'session/prompt') {
    const call = JSON.parse(message.params.prompt[0].text);
    const id = `agent-${++nextId}`;
    pending.set(id, (reply) => send({ jsonrpc: '2.0', id: message.id,
      result: { stopReason: 'end_turn', _meta: { reply } } }));
    send({ jsonrpc: '2.0', id, method: call.method,
      params: { ...call.params, sessionId: message.params.sessionId } });
  } else if (['test/exit-with-descendant', 'test/spawn-descendant'].includes(message.method)) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
    send({ jsonrpc: '2.0', id: message.id, result: { pid: child.pid, agentPid: process.pid, finalMessage: true } });
    if (message.method === 'test/exit-with-descendant') process.exit(0);
  } else if (message.method === 'test/client-request') {
    const id = message.params.id ?? `agent-${++nextId}`;
    pending.set(id, message.id);
    send({ jsonrpc: '2.0', id, ...message.params });
  } else if (message.method === 'test/cancel') {
    send({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: message.params.requestId } });
  } else if (message.method === 'test/notify') {
    send({ jsonrpc: '2.0', ...message.params });
  } else if (message.method === 'test/exit') {
    process.exit(0);
  } else if ('id' in message) {
    send({ jsonrpc: '2.0', id: message.id, result: message });
  }
}

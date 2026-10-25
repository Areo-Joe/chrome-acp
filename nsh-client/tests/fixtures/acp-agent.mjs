import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
const require = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const acp = await import(require.resolve('@agentclientprotocol/sdk'));
const app = acp.agent({ name: 'nsh-integration-agent' });
const options = [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }];
let cwd;
app.onRequest(acp.methods.agent.initialize, ({ params }) => {
  assert.equal(params.clientInfo.name, 'nsh-client');
  assert.equal(params.clientCapabilities.fs.readTextFile, true);
  assert.equal(params.clientCapabilities.terminal, true);
  return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'integration-agent', version: '1' } };
});
app.onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
  cwd = params.cwd;
  assert.deepEqual(params.mcpServers, []);
  await client.notify(acp.methods.client.session.update, { sessionId: 'integration', update: {
    sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }],
  } });
  return { sessionId: 'integration', configOptions: options };
});
app.onRequest(acp.methods.agent.session.setConfigOption, async ({ params, client }) => {
  assert.equal(params.sessionId, 'integration');
  assert.equal(params.type, 'boolean');
  const { terminalId } = await client.request(acp.methods.client.terminal.create, {
    sessionId: params.sessionId, command: process.execPath, args: ['-e', 'process.stdout.write("local terminal")'],
  });
  const status = await client.request(acp.methods.client.terminal.waitForExit, { sessionId: params.sessionId, terminalId });
  assert.equal(status.exitCode, 0);
  const output = await client.request(acp.methods.client.terminal.output, { sessionId: params.sessionId, terminalId });
  await client.request(acp.methods.client.terminal.release, { sessionId: params.sessionId, terminalId });
  await client.request(acp.methods.client.fs.writeTextFile, {
    sessionId: params.sessionId, path: join(cwd, 'proxy-capabilities.txt'), content: `${params.value}:${output.output}`,
  });
  options[0].currentValue = params.value;
  return { configOptions: options };
});
const connection = app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExecutionHub } from '../dist/shared/hub.js'
import { runSharedHttp } from '../dist/shared/server.js'
import { SharedConnection } from '../dist/plugin/shared.js'
import { loadConfig, NATIVE_TOOL_IDS } from '../dist/config.js'
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.status)
const unpack = result => result.structuredContent ?? JSON.parse(result.content.find(x => x.type === 'text').text)
const exists = path => access(path).then(() => true, () => false)
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port }
test('shared HTTP MCP executes independent native threads on a single endpoint', { timeout: 65000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shared-native-')), root = join(dir, 'project_a'), otherRoot = join(dir, 'project_b'), port = await freePort()
  await mkdir(root); await mkdir(otherRoot)
  await Promise.all(['a', 'b'].map(name => writeFile(join(root, `${name}.txt`), `${name} before\n`)))
  const config = loadConfig({ OPENCODE_MCP_ROOT: root, OPENCODE_MCP_RUNTIME_DIR: process.env.OPENCODE_MCP_RUNTIME_DIR ?? resolve('.opencode-runtime'),
    ...(process.env.OPENCODE_MCP_BUN ? { OPENCODE_MCP_BUN: process.env.OPENCODE_MCP_BUN } : {}), OPENCODE_MCP_STATE_DIR: join(dir, 'state'), OPENCODE_MCP_WAIT_MAX_SECONDS: '1',
    OPENCODE_MCP_PERMISSIONS: JSON.stringify({ '*': 'allow', edit: 'ask' }) })
  const hub = new ExecutionHub(config), token = 'execution-test-credential-'.repeat(3), controlToken = 'private-control-test-credential-'.repeat(3), clients = []
  let http
  t.after(async () => { await Promise.allSettled(clients.map(c => c.close())); if (http) await http.close(); else await hub.stop(); await rm(dir, { recursive: true, force: true }) })
  await hub.start(); http = await runSharedHttp(hub, { mcpToken: token, controlToken, identity: 'test', port })
  const url = `http://127.0.0.1:${port}`
  async function connect() { const c = new Client({ name: 'independent-ai-fixture', version: '1' }); clients.push(c); await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } })); return c }
  const [ca, cb] = await Promise.all([connect(), connect()])
  const control = async body => { const response = await fetch(`${url}/control`, { method: 'POST', headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result }
  const a = { env_id: 'project_a', thread_id: 'ai_a', turn_id: 'turn_a' }, b = { env_id: 'project_a', thread_id: 'ai_b', turn_id: 'turn_b' }, c = { env_id: 'project_b', thread_id: 'ai_c', turn_id: 'turn_c' }
  for (const [owner_id, env_id, path] of [['owner_a', 'project_a', root], ['owner_b', 'project_a', root], ['owner_c', 'project_b', otherRoot]]) await control({ op: 'claim', owner_id, env_id, root: path })
  await Promise.all([['owner_a', a], ['owner_b', b], ['owner_c', c]].map(([owner_id, scope]) => control({ op: 'begin', owner_id, ...scope })))
  const call = async (connection, scope, name, args = {}) => unpack(await connection.callTool({ name, arguments: { ...scope, ...(name.startsWith('opencode_') ? args : { arguments: args }) } }))
  async function finish(connection, scope, job, approve = false) {
    for (let n = 0; n < 30 && !terminal(job); n++) {
      if (job.status === 'awaiting_permission') { assert.ok(approve, JSON.stringify(job)); job = await call(connection, scope, 'opencode_permission_reply', { job_id: job.job_id, permission_id: job.permission.id, reply: 'once' }) }
      else job = await call(connection, scope, 'opencode_job_result', { job_id: job.job_id, wait_seconds: 1 })
    }
    assert.ok(terminal(job), JSON.stringify(job)); return job
  }
  async function complete(connection, scope, name, args) { const job = await finish(connection, scope, await call(connection, scope, name, args), true); assert.equal(job.status, 'completed', JSON.stringify(job)); return job }
  await t.test('catalog retains native schemas inside a required scope envelope; control credentials stay separate', async () => {
    const catalog = (await ca.listTools()).tools
    for (const name of NATIVE_TOOL_IDS) {
      const tool = catalog.find(x => x.name === name)
      assert.deepEqual(tool.inputSchema.required, ['env_id', 'thread_id', 'turn_id', 'arguments'])
      assert.deepEqual(tool.inputSchema.properties.arguments, hub.tools().find(x => x.name === name).inputSchema)
    }
    assert.equal((await ca.callTool({ name: 'bash', arguments: { arguments: { command: 'must not run' } } })).isError, true)
    assert.equal((await ca.callTool({ name: 'opencode_job_list', arguments: { ...a, thread_id: 'unknown' } })).isError, true)
    assert.equal((await fetch(`${url}/control`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"op":"status"}' })).status, 401)
    assert.equal((await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${controlToken}` } })).status, 401)
    assert.equal((await fetch(`${url}/mcp`, { headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.example' } })).status, 403)
    const health = await (await fetch(`${url}/healthz`)).text(); assert.ok(!health.includes(token)); assert.ok(!health.includes(controlToken))
    assert.ok(!catalog.some(x => ['claim', 'begin', 'release', 'shutdown', 'task'].includes(x.name)))
  })
  await t.test('barrier proves overlapping executions; different native edits and approvals remain scoped', async () => {
    const barrier = (name, peer) => `touch ${name}.ready; for i in $(seq 1 300); do test -e ${peer}.ready && break; sleep 0.02; done; test -e ${peer}.ready && printf overlapped > ${name}.overlap`
    const jobs = await Promise.all([complete(ca, a, 'bash', { command: barrier('a', 'b'), description: 'AI A concurrency barrier' }), complete(cb, b, 'bash', { command: barrier('b', 'a'), description: 'AI B concurrency barrier' })])
    assert.notEqual(jobs[0].job_id, jobs[1].job_id)
    for (const name of ['a', 'b']) assert.equal(await readFile(join(root, `${name}.overlap`), 'utf8'), 'overlapped')
    await Promise.all([complete(ca, a, 'read', { filePath: join(root, 'a.txt') }), complete(cb, b, 'read', { filePath: join(root, 'b.txt') })])
    const [ea, eb] = await Promise.all([call(ca, a, 'edit', { filePath: join(root, 'a.txt'), oldString: 'a before', newString: 'a after' }), call(cb, b, 'edit', { filePath: join(root, 'b.txt'), oldString: 'b before', newString: 'b after' })])
    assert.equal(ea.status, 'awaiting_permission'); assert.equal(eb.status, 'awaiting_permission')
    assert.equal((await call(ca, a, 'opencode_permissions_pending')).requests.length, 1)
    assert.match((await call(ca, a, 'opencode_permission_reply', { job_id: eb.job_id, permission_id: eb.permission.id, reply: 'once' })).error, /does not belong/)
    assert.match((await call(cb, b, 'opencode_job_cancel', { job_id: ea.job_id })).error, /does not belong/)
    for (const job of await Promise.all([finish(ca, a, ea, true), finish(cb, b, eb, true)])) assert.equal(job.status, 'completed')
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a after\n'); assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'b after\n')
    const listed = await call(ca, a, 'opencode_job_list'); assert.ok(listed.jobs.every(job => job.scope.thread_id === a.thread_id)); assert.ok(!listed.jobs.some(job => job.job_id === eb.job_id))
  })
  await t.test('environments select cwd and each thread has its own native home', async () => {
    const [ha, hb, hc] = await Promise.all([complete(ca, a, 'bash', { command: 'printf "%s\n" "$HOME"; pwd' }), complete(cb, b, 'bash', { command: 'printf "%s\n" "$HOME"; pwd' }), complete(cb, c, 'bash', { command: 'printf "%s\n" "$HOME"; pwd' })])
    assert.notEqual(ha.result.output.split('\n')[0], hb.result.output.split('\n')[0]); assert.match(hc.result.output, new RegExp(otherRoot))
    await complete(cb, c, 'write', { filePath: join(otherRoot, 'c.txt'), content: 'environment c' }); assert.equal(await exists(join(root, 'c.txt')), false)
  })
  await t.test('ending A cancels only A; B continues and stale A cannot launch new work', async () => {
    const [ja, jb] = await Promise.all([call(ca, a, 'bash', { command: 'sleep 20; touch cancelled-side-effect', timeout: 30000 }), call(cb, b, 'bash', { command: 'sleep 3; printf survived > survived.txt', timeout: 10000 })])
    assert.equal(ja.status, 'running'); assert.equal(jb.status, 'running')
    await control({ op: 'end', owner_id: 'owner_a', ...a })
    assert.equal((await finish(ca, a, ja)).status, 'cancelled'); assert.equal((await finish(cb, b, jb)).status, 'completed')
    assert.equal(await readFile(join(root, 'survived.txt'), 'utf8'), 'survived'); assert.equal(await exists(join(root, 'cancelled-side-effect')), false)
    assert.match((await call(ca, a, 'bash', { command: 'touch stale-side-effect' })).error, /not active/); assert.equal(await exists(join(root, 'stale-side-effect')), false)
    await control({ op: 'release', owner_id: 'owner_a' }); await complete(cb, b, 'bash', { command: 'printf still-alive' })
  })
  await t.test('MCP reconnect retrieves the same job, never redispatches it', async () => {
    const job = await call(cb, b, 'bash', { command: 'sleep 1.5; printf x >> reconnect-count' })
    await cb.close(); const reconnected = await connect(), result = await finish(reconnected, b, job)
    assert.equal(result.status, 'completed'); assert.equal(result.job_id, job.job_id); assert.equal(await readFile(join(root, 'reconnect-count'), 'utf8'), 'x')
    const history = await control({ op: 'events', owner_id: 'owner_b', cursor: 0 }); assert.ok(history.events.length > 0)
    for (const { event } of history.events) assert.deepEqual(event.scope, b)
  })
  await t.test('the plugin client fences a lost turn boundary on its next begin', async () => {
    const remote = new SharedConnection(dir, { port, controlToken, mcpToken: token, identity: 'test' }, otherRoot)
    try {
      await remote.claim(otherRoot)
      const first = await remote.begin('recovery_thread', 'turn_one')
      await assert.rejects(remote.end({ ...first, turn_id: 'never_begun' }), /Unknown execution turn/)
      const second = await remote.begin('recovery_thread', 'turn_two')
      assert.notEqual(second.turn_id, first.turn_id)
      await remote.end(second)
    } finally { await remote.close() }
  })
})

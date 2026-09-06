import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionHub } from '../dist/shared/hub.js'
import { Journal } from '../dist/plugin/storage.js'
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER } from '../dist/plugin/transport.js'
import { unreachable } from '../dist/plugin/shared.js'
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve } }
const scope = (thread, turn = 'turn_1', env = 'env_a') => ({ env_id: env, thread_id: thread, turn_id: turn })
let nextJob = 0
class FakeWorker {
  constructor(config) { this.config = config; this.jobs = new Map(); this.stopped = false; this.stall = false }
  async start() { await this.startGate }
  async stop() { await this.stopGate; this.stopped = true; for (const id of this.jobs.keys()) this.finish(id, 'cancelled') }
  observe(fn) { this.listener = fn; return () => this.listener = undefined }
  tools() { return [{ name: 'bash', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }] }
  info() { return { root: this.config.root, state: this.config.stateDir } }
  list() { return [...this.jobs.values()].map(j => ({ ...j })) }
  startJob(tool, input) {
    const job = { job_id: `job_${++nextJob}`, tool, status: 'running', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    this.jobs.set(job.job_id, job); this.listener?.({ type: 'start', job: { ...job }, input }); return job.job_id
  }
  finish(id, status = 'completed') { const job = this.jobs.get(id); job.status = status; this.listener?.({ type: 'update', job: { ...job } }); return { ...job } }
  async wait(id) { return { ...this.jobs.get(id) } }
  cancel(id) { return this.stall ? { ...this.jobs.get(id) } : this.finish(id, 'cancelled') }
  async reply(id, permission, reply) { this.lastReply = { id, permission, reply } }
}
async function hubFixture(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shared-unit-')), a = join(dir, 'a'), b = join(dir, 'b'); await mkdir(a); await mkdir(b)
  const workers = [], hub = new ExecutionHub({ root: a, stateDir: join(dir, 'state'), waitMs: 0 }, { maxThreads: 8, maxConcurrent: 8, ownerLeaseMs: 60000, ...limits }, config => { const w = new FakeWorker(config); workers.push(w); return w })
  await hub.start(); await hub.claim('owner_a', 'env_a', a); await hub.claim('owner_b', 'env_b', b)
  t.after(async () => { await hub.stop(); await rm(dir, { recursive: true, force: true }) })
  return { hub, workers, a, b, dir }
}
test('shared hub isolates immutable scopes, jobs, controls and event ownership', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), b = scope('thread_b', 'turn_1', 'env_b')
  await Promise.all([f.hub.begin('owner_a', a), f.hub.begin('owner_b', b)])
  const ja = f.hub.startJob(a, 'bash', { command: 'a' }), jb = f.hub.startJob(b, 'bash', { command: 'b' })
  assert.deepEqual(f.hub.list(a).map(j => j.job_id), [ja]); assert.deepEqual(f.hub.list(b).map(j => j.job_id), [jb])
  await assert.rejects(f.hub.wait(b, ja, 0), /does not belong/)
  assert.throws(() => f.hub.cancel(b, ja), /does not belong/)
  await assert.rejects(f.hub.reply(b, ja, 'permission_a', 'once'), /does not belong/)
  for (const item of f.hub.events('owner_a', 0).events) assert.deepEqual(item.event.scope, a)
  for (const item of f.hub.events('owner_b', 0).events) assert.deepEqual(item.event.scope, b)
  assert.notEqual(f.workers[1].config.stateDir, f.workers[2].config.stateDir)
  assert.equal(f.workers[1].config.root, f.a); assert.equal(f.workers[2].config.root, f.b)
})
test('same-thread ownership, duplicate begin and active-turn reservations fail closed', async t => {
  const f = await hubFixture(t), a = scope('thread_a')
  await f.hub.claim('owner_other', 'env_a', f.a)
  await Promise.all([f.hub.begin('owner_a', a), f.hub.begin('owner_a', a)])
  assert.equal(f.workers.length, 2)
  await assert.rejects(f.hub.begin('owner_other', a), /Another AI/)
  await assert.rejects(f.hub.begin('owner_a', { ...a, turn_id: 'other_turn' }), /Another turn/)
  await assert.rejects(f.hub.claim('owner_a', 'env_a', f.b), /rebound/)
  await assert.rejects(f.hub.claim('bad', '../escape', f.a), /Invalid/)
  assert.throws(() => f.hub.list({ ...a, turn_id: 'unknown' }), /Unknown execution turn/)
})
test('ending a turn fences late execution and preserves only its retained results', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), next = { ...a, turn_id: 'turn_2' }
  await f.hub.begin('owner_a', a)
  const old = f.hub.startJob(a, 'bash', {}); await f.hub.end('owner_a', a)
  assert.equal((await f.hub.wait(a, old, 0)).status, 'cancelled')
  assert.throws(() => f.hub.startJob(a, 'bash', {}), /not active/)
  await assert.rejects(f.hub.begin('owner_a', a), /already ended/)
  await f.hub.begin('owner_a', next); const fresh = f.hub.startJob(next, 'bash', {})
  assert.deepEqual(f.hub.list(next).map(j => j.job_id), [fresh]); assert.deepEqual(f.hub.list(a).map(j => j.job_id), [old])
  await assert.rejects(f.hub.end('owner_a', a), /another active turn/)
})
test('release fences new begins immediately and cannot stop another owner', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), b = scope('thread_b', 'turn_1', 'env_b')
  await f.hub.begin('owner_a', a); await f.hub.begin('owner_b', b)
  const gate = deferred(); f.workers[1].stopGate = gate.promise
  const release = f.hub.release('owner_a')
  try {
    await assert.rejects(f.hub.begin('owner_a', scope('new_thread')), /expired/)
    await assert.rejects(f.hub.claim('owner_a', 'env_a', f.a), /closing/)
    assert.equal(f.workers[2].stopped, false); f.hub.startJob(b, 'bash', {})
  } finally { gate.resolve(); await release }
  assert.equal(f.hub.ownerCount, 1); assert.equal(f.workers[2].stopped, false)
})
test('unacknowledged cancellation quarantines only its own worker', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), b = scope('thread_b', 'turn_1', 'env_b')
  await f.hub.begin('owner_a', a); await f.hub.begin('owner_b', b)
  f.workers[1].stall = true; f.hub.startJob(a, 'bash', {})
  await assert.rejects(f.hub.end('owner_a', a), /quarantined/)
  assert.equal(f.workers[1].stopped, true); assert.equal(f.workers[2].stopped, false)
  f.hub.startJob(b, 'bash', {})
})
test('event eviction never attributes an old update to a newer active turn', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), b = { ...a, turn_id: 'turn_2' }
  await f.hub.begin('owner_a', a); const old = f.hub.startJob(a, 'bash', {})
  await f.hub.end('owner_a', a); await f.hub.begin('owner_a', b)
  f.workers[1].jobs.clear(); f.hub.startJob(b, 'bash', {})
  const cursor = f.hub.events('owner_a', 0).latest
  f.workers[1].listener({ type: 'update', job: { job_id: old, tool: 'bash', status: 'completed' } })
  assert.equal(f.hub.events('owner_a', cursor).events.length, 0)
})
test('global concurrency and thread counts are bounded without serializing all owners', async t => {
  const f = await hubFixture(t, { maxThreads: 2, maxConcurrent: 1 }), a = scope('a'), b = scope('b', 'turn_1', 'env_b')
  await Promise.all([f.hub.begin('owner_a', a), f.hub.begin('owner_b', b)])
  await assert.rejects(f.hub.begin('owner_a', scope('third')), /thread limit/)
  const job = f.hub.startJob(a, 'bash', {}); assert.throws(() => f.hub.startJob(b, 'bash', {}), /concurrency limit/)
  f.hub.cancel(a, job); f.hub.startJob(b, 'bash', {})
})
test('lease expiry releases only expired owners and rejects stale cursors', async t => {
  const f = await hubFixture(t), a = scope('a'), b = scope('b', 'turn_1', 'env_b')
  await f.hub.begin('owner_a', a); await f.hub.begin('owner_b', b)
  f.hub.owners.get('owner_a').touched = 0
  await f.hub.reap(); assert.equal(f.workers[1].stopped, true); assert.equal(f.workers[2].stopped, false)
  assert.throws(() => f.hub.events('owner_a', 0), /expired/)
  assert.throws(() => f.hub.events('owner_b', 99), /cursor/)
})
const request = (transport, session, message = 'message_1', signal) => transport.fetch('https://opencode-notion.invalid/v1/chat/completions', { method: 'POST', signal,
  headers: { [SESSION_HEADER]: session, [MESSAGE_HEADER]: message }, body: JSON.stringify({ model: 'chat', stream: false, messages: [{ role: 'user', content: session }] }) })
async function eventually(check) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(10) } assert.fail('Expected concurrent work did not start') }
async function waitGate(gate, signal) {
  let abort; const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })
  try { await Promise.race([gate.promise, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}
test('parallel chat turns keep duplicate job IDs, cancellation and display on their own thread', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'parallel-chat-')), calls = [], ends = [], interrupts = [], cards = [], a = deferred(), b = deferred()
  const journal = new Journal(join(dir, 'journal.json')); await journal.load()
  let transport
  const event = (input, status) => transport.observeExecution({ type: status === 'running' ? 'start' : 'update', scope: input.executionScope, job: { job_id: 'same_native_id', tool: 'bash', status } })
  const backend = { send: async input => { calls.push(input); event(input, 'running'); await waitGate(input.executionScope.thread_id === 'a' ? a : b, input.signal); event(input, 'completed'); return input.executionScope.thread_id }, interrupt: async id => interrupts.push(id) }
  transport = new NotionTransport(backend, journal, 'context', x => x, async () => {}, undefined, {
    begin: async (session, message) => ({ scope: scope(session, message), context: 'required scope' }), end: async value => { ends.push(value); const input = calls.find(x => x.executionScope.thread_id === value.thread_id); if (value.thread_id === 'a') event(input, 'cancelled') },
  })
  transport.display = { begin: async (session, message) => ({ update: e => cards.push([session, e.scope.thread_id, e.job.status]), finalText() {}, async flush() {} }) }
  t.after(async () => { a.resolve(); b.resolve(); await transport.close(); await rm(dir, { recursive: true, force: true }) })
  const abort = new AbortController(), pa = request(transport, 'a', 'message_1', abort.signal), pb = request(transport, 'b')
  await eventually(() => calls.length === 2)
  const duplicateB = request(transport, 'b'); assert.equal((await request(transport, 'a', 'message_2')).status, 400)
  abort.abort(new Error('stop a')); assert.equal((await pa).status, 400)
  assert.equal(interrupts.length, 1); assert.equal(interrupts[0], calls.find(x => x.executionScope.thread_id === 'a').conversationId)
  assert.deepEqual(ends.map(x => x.thread_id), ['a']); assert.equal(calls.find(x => x.executionScope.thread_id === 'b').signal.aborted, false)
  b.resolve(); assert.equal((await pb).status, 200); assert.equal((await duplicateB).status, 200)
  assert.equal((await request(transport, 'b')).status, 200); assert.equal(calls.length, 2)
  assert.ok(cards.length >= 4); for (const [session, routed] of cards) assert.equal(session, routed)
  assert.equal(journal.data.sessions.a.turns.message_1.status, 'interrupted'); assert.equal(journal.data.sessions.b.turns.message_1.status, 'complete')
})
test('split journals keep cross-process sessions without lost updates or lock stealing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'split-journal-')), path = join(dir, 'journal.json')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const module = pathToFileURL(resolve('dist/plugin/storage.js')).href
  const child = session => promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {Journal,hash} from ${JSON.stringify(module)};import{setTimeout as delay}from'node:timers/promises';const j=new Journal(${JSON.stringify(path)},{split:true});await j.load();const release=await j.acquire(${JSON.stringify(session)});try{j.data.sessions[${JSON.stringify(session)}]={conversationId:'conv',turns:{message:{conversationId:'conv',promptHash:hash('hello'),status:'complete',text:${JSON.stringify(session)}}}};await delay(75);await j.save(${JSON.stringify(session)})}finally{await release()}`], { timeout: 10000 })
  await Promise.all([child('session_a'), child('session_b')])
  const journal = new Journal(path, { split: true }); await journal.load()
  for (const session of ['session_a', 'session_b']) { const release = await journal.acquire(session); assert.equal(journal.data.sessions[session].turns.message.text, session); await release() }
  const release = await journal.acquire('session_a')
  try { await assert.rejects(child('session_a'), /Another plugin owns/) } finally { await release() }
})
test('legacy single-file saves are serialized and completed snapshots cannot overwrite newer sessions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'serial-journal-')), journal = new Journal(join(dir, 'journal.json'))
  t.after(() => rm(dir, { recursive: true, force: true })); await journal.load()
  const writes = []
  for (let n = 0; n < 32; n++) { journal.data.sessions[`session_${n}`] = { conversationId: randomUUID(), turns: {} }; writes.push(journal.save()) }
  await Promise.all(writes); const read = new Journal(journal.path); await read.load(); assert.equal(Object.keys(read.data.sessions).length, 32)
})
test('concurrent releases await one termination instead of replacing a live worker', async t => {
  const f = await hubFixture(t), a = scope('thread_a')
  await f.hub.begin('owner_a', a)
  const worker = f.workers[1], stop = worker.stop.bind(worker), gate = deferred()
  let stops = 0; worker.stopGate = gate.promise; worker.stop = async () => { stops++; return stop() }
  const releases = [f.hub.release('owner_a'), f.hub.release('owner_a')]
  await delay(20); assert.equal(worker.stopped, false)
  gate.resolve(); await Promise.all(releases)
  assert.equal(stops, 1); assert.equal(worker.stopped, true); assert.equal(f.hub.ownerCount, 1)
})
test('a noisy thread only loses its own superseded progress', async t => {
  const f = await hubFixture(t), noisyScope = scope('thread_a'), quietScope = scope('thread_c')
  await f.hub.begin('owner_a', noisyScope); await f.hub.begin('owner_a', quietScope)
  const quiet = f.hub.startJob(quietScope, 'bash', {}), noisy = f.hub.startJob(noisyScope, 'bash', {})
  for (let n = 0; n < 2600; n++) f.workers[1].finish(noisy, 'running')
  const page = f.hub.events('owner_a', 0)
  assert.equal(page.gap, false)
  assert.ok(page.events.some(item => item.event.job.job_id === quiet))
  assert.equal(f.hub.events('owner_a', page.latest).events.length, 0)
})
test('fencing recovers a lost turn boundary and never touches another owner', async t => {
  const f = await hubFixture(t), a = scope('thread_a'), b = scope('thread_b', 'turn_1', 'env_b')
  await f.hub.begin('owner_a', a); await f.hub.begin('owner_b', b)
  const job = f.hub.startJob(a, 'bash', {}), other = f.hub.startJob(b, 'bash', {})
  await f.hub.fence('owner_a', a)
  assert.equal((await f.hub.wait(a, job, 0)).status, 'cancelled'); assert.equal((await f.hub.wait(b, other, 0)).status, 'running')
  await f.hub.fence('owner_a', a)
  await assert.rejects(f.hub.fence('owner_b', a), /another owner/)
  await f.hub.begin('owner_a', { ...a, turn_id: 'turn_2' })
})
test('idle threads are reclaimed while replayed turns stay refused', async t => {
  const f = await hubFixture(t, { threadIdleMs: 0 }), a = scope('thread_a')
  await f.hub.begin('owner_a', a); await f.hub.end('owner_a', a)
  await f.hub.reap(Date.now() + 1000)
  assert.equal(f.workers[1].stopped, true); assert.equal(f.hub.ownerCount, 2)
  await assert.rejects(f.hub.begin('owner_a', a), /already ended/)
  await f.hub.begin('owner_a', { ...a, turn_id: 'turn_2' }); assert.equal(f.workers.length, 3)
})

test('an unreachable shared service is recognized under both node and bun error shapes', () => {
  assert.equal(unreachable(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), true)
  assert.equal(unreachable(Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' })), true)
  assert.equal(unreachable(new Error('Unable to connect. Is the computer able to access the url?')), true)
  assert.equal(unreachable(new Error('Other OpenCode clients still own this shared service; refusing shutdown')), false)
  assert.equal(unreachable(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), false)
})

test('the shared daemon launches with the resolved Bun runtime, never the host executable', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../dist/plugin/shared.js', import.meta.url), 'utf8')
  // A compiled opencode executable is process.execPath inside the host; giving it a script
  // path only prints the CLI help, so the daemon must start with the configured runtime.
  assert.ok(!/spawn\(\s*process\.execPath/.test(source), 'the daemon must not be spawned with the host executable')
  assert.match(source, /spawn\(\s*s\.bun\s*,/)
})

test('tool activity renews the owner lease so a busy AI is never reaped', async t => {
  const f = await hubFixture(t, { ownerLeaseMs: 60 })
  const a = scope('thread_a'), b = scope('thread_b', 'turn_1', 'env_b')
  await f.hub.begin('owner_a', a); await f.hub.begin('owner_b', b)
  const job = f.hub.startJob(a, 'bash', { command: 'long' })
  // Only control-plane traffic used to renew the lease, so an AI whose event
  // poll stalled had its running threads torn down mid-execution.
  for (let i = 0; i < 4; i++) { await delay(40); assert.equal(f.hub.list(a).length, 1); await f.hub.reap() }
  assert.equal(f.hub.list(a)[0].job_id, job)
  assert.equal(f.hub.ownerCount, 1)
  assert.throws(() => f.hub.list(b), /Unknown or unavailable execution thread/)
})

test('the shared service reports the package version, refuses proxied control traffic and idles out only when nothing is live', async t => {
  const { readFile } = await import('node:fs/promises')
  const { createServer: createTcpServer } = await import('node:net')
  const { runSharedHttp } = await import('../dist/shared/server.js')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const freePort = () => new Promise(resolve => { const probe = createTcpServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) }) })
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const credentials = { mcpToken: 'execution-credential-for-shared-http-tests', controlToken: 'control-credential-for-shared-http-tests', identity: 'unit' }
  const live = await hubFixture(t), port = await freePort()
  const service = await runSharedHttp(live.hub, { ...credentials, port, idleMs: 10 })
  let running = true
  void service.closed.then(() => { running = false })
  t.after(() => service.close())
  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()
  assert.equal(health.version, pkg.version)
  for (const file of ['../dist/index.js', '../dist/tools.js', '../dist/shared/server.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.ok(!/version: "\d+\.\d+\.\d+"/.test(source), `${file} must take its version from package.json`)
  }
  const control = (headers = {}) => fetch(`http://127.0.0.1:${port}/control`, { method: 'POST', body: JSON.stringify({ op: 'status' }),
    headers: { authorization: `Bearer ${credentials.controlToken}`, 'content-type': 'application/json', ...headers } })
  // The tunnel publishes /mcp, but claims, fences and shutdown must stay local.
  assert.equal((await control({ 'x-forwarded-for': '203.0.113.9' })).status, 403)
  assert.equal((await control({ 'cf-connecting-ip': '203.0.113.9' })).status, 403)
  assert.equal((await control()).status, 200)
  const client = new Client({ name: 'idle-guard', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${credentials.mcpToken}` } } }))
  t.after(() => client.close().catch(() => {}))
  await live.hub.release('owner_a'); await live.hub.release('owner_b')
  // The reaper sweeps every five seconds; a connected AI must survive it.
  await delay(7000)
  assert.equal(running, true)
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200)
  const spare = await hubFixture(t), sparePort = await freePort()
  const unused = await runSharedHttp(spare.hub, { ...credentials, port: sparePort, idleMs: 10 })
  await spare.hub.release('owner_a'); await spare.hub.release('owner_b')
  await unused.closed
})


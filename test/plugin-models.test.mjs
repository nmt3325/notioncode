import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { NotionModels } from "../dist/plugin/models.js"
import { MODEL_CATALOG, MODEL_REASONING_EFFORTS, normalizeModelName } from "../dist/vendor/notion-ai/models.js"
import { Journal, hash, saveJson } from "../dist/plugin/storage.js"
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER, AGENT_HEADER } from "../dist/plugin/transport.js"
import { NotionBackend, notionConfig } from "../dist/plugin/notion.js"
import { providerHooks } from "../dist/plugin.js"
async function fixture(t, models = new NotionModels(), send) {
  const dir = await mkdtemp(join(tmpdir(), "notion-model-test-"))
  const calls = [], backend = { send: async input => { calls.push(input); return send ? send(input) : "ok" }, interrupt: async () => {} }
  const journal = new Journal(join(dir, "journal.json")); await journal.load()
  const transport = new NotionTransport(backend, journal, "context", text => text, async () => {}, models)
  t.after(async () => { await transport.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, calls, backend, journal, transport }
}
function request(transport, model = "chat", message = "msg_1", extra = {}) {
  const { agent = "notion", ...body } = extra
  return transport.fetch("https://opencode-notion.invalid/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "ses_models", [MESSAGE_HEADER]: message, [AGENT_HEADER]: agent },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }], ...body }),
  })
}
test("picker contains every production-pickable model with unique public keys and names", () => {
  const models = new NotionModels(), expected = MODEL_CATALOG.filter(entry => entry.pickable)
  assert.equal(models.choices.length, expected.length)
  assert.equal(new Set(models.choices.map(entry => entry.id)).size, expected.length)
  assert.equal(new Set(models.choices.map(entry => entry.name)).size, expected.length)
  assert.deepEqual(new Set(models.choices.map(entry => entry.notionModel)), new Set(expected.map(entry => entry.modelId)))
  for (const entry of models.choices) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9.-]*$/)
    assert.equal(models.resolve(entry.id), entry.notionModel)
    assert.equal(models.definitions()[entry.id].tool_call, false)
    assert.notEqual(entry.name, entry.notionModel)
  }
  assert.equal(models.choices.filter(entry => entry.name.startsWith("GPT-5.4") && !/Mini|Nano|High/.test(entry.name)).length, 2)
})
test("advanced catalog includes every callable entry without changing existing public keys", () => {
  const regular = new NotionModels(), all = new NotionModels("default", true)
  assert.equal(all.choices.length, MODEL_CATALOG.length)
  for (const entry of regular.choices) assert.deepEqual(all.choices.find(item => item.id === entry.id), entry)
  for (const entry of all.choices) assert.equal(all.resolve(entry.id), entry.notionModel)
})
test("GPT-6 Astra public key resolves to the workflow routing identifier", () => {
  const models = new NotionModels()
  const astra = models.choices.find(entry => entry.id === "gpt-6-astra")
  assert.ok(astra)
  assert.equal(astra.name, "GPT-6 Astra")
  assert.equal(astra.notionModel, "orlando-quinn")
  assert.equal(models.resolve("gpt-6-astra"), "orlando-quinn")
  assert.equal(normalizeModelName("gpt-6", "default"), "orlando-quinn")
  assert.equal(normalizeModelName("gpt-6-astra", "default"), "orlando-quinn")
})
test("configured default is explicit and does not force named selections to Sonnet", async t => {
  const models = new NotionModels("gpt-5.4"), f = await fixture(t, models)
  assert.equal(models.resolve("chat"), normalizeModelName("gpt-5.4", "default"))
  assert.match(models.definitions().chat.name, /GPT-5\.4/)
  await request(f.transport)
  const different = models.choices.find(entry => entry.notionModel !== models.defaultModel)
  await request(f.transport, different.id, "msg_2")
  assert.equal(f.calls[0].model, models.defaultModel)
  assert.equal(f.calls[1].model, different.notionModel)
})
test("configured unlisted default stays selectable without exposing every unlisted entry", () => {
  const entry = MODEL_CATALOG.find(entry => !entry.pickable)
  const models = new NotionModels(entry.modelId)
  assert.ok(models.choices.some(item => item.notionModel === entry.modelId))
  assert.equal(models.choices.filter(item => !item.pickable).length, 1)
})
test("explicit OpenCode model selection survives plugin configuration", async t => {
  const f = await fixture(t), selected = `notion-ai/${f.transport.models.choices[0].id}`
  const config = { model: selected, provider: { existing: { name: "keep" } } }
  await providerHooks(f.transport, async () => {}).config(config)
  assert.equal(config.model, selected); assert.equal(config.agent.notion.model, selected)
  assert.equal(config.provider.existing.name, "keep"); assert.equal(config.small_model, "notion-ai/metadata")
  assert.equal(Object.keys(config.provider["notion-ai"].models).length, f.transport.models.choices.length + 2)
})
test("model switch keeps one Notion conversation and persists across transport restarts", async t => {
  const f = await fixture(t), [a, b] = f.transport.models.choices
  await request(f.transport, a.id)
  const second = new NotionTransport(f.backend, new Journal(f.journal.path), "context")
  await second.journal.load(); t.after(() => second.close())
  await request(second, b.id, "msg_2")
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].conversationId, f.calls[1].conversationId)
  assert.equal(f.calls[1].fresh, false); assert.equal(f.calls[1].prompt, "hello")
  assert.equal(f.calls[0].model, a.notionModel); assert.equal(f.calls[1].model, b.notionModel)
  assert.equal(second.journal.data.sessions.ses_models.turns.msg_2.model, b.notionModel)
})
test("a completed turn cannot be replayed with a different selected model", async t => {
  const f = await fixture(t), [a, b] = f.transport.models.choices
  await request(f.transport, a.id); await request(f.transport, a.id)
  const changed = await request(f.transport, b.id)
  assert.equal(changed.status, 400); assert.match(await changed.text(), /different model/)
  assert.equal(f.calls.length, 1)
})
test("a concurrent duplicate with another model is rejected rather than joined", async t => {
  let release; const wait = new Promise(resolve => { release = resolve })
  const f = await fixture(t, new NotionModels(), async () => { await wait; return "ok" })
  const [a, b] = f.transport.models.choices
  const first = request(f.transport, a.id); await delay(10)
  assert.equal((await request(f.transport, b.id)).status, 400)
  release(); assert.equal((await first).status, 200); assert.equal(f.calls.length, 1)
})
test("unknown model and malformed model values never dispatch or fall back", async t => {
  const f = await fixture(t)
  for (const value of ["missing-model", "__proto__", "constructor", null, {}, 1]) {
    assert.equal((await request(f.transport, value)).status, 400)
  }
  assert.equal(f.calls.length, 0)
})
test("named models also keep auxiliary requests local", async t => {
  const f = await fixture(t), model = f.transport.models.choices[0].id
  for (const agent of ["title", "summary", "compaction"]) assert.equal((await request(f.transport, model, "msg_aux", { agent })).status, 200)
  assert.equal(f.calls.length, 0)
})
test("legacy journals remain readable but changed effective selections never replay or resend", async t => {
  const f = await fixture(t), id = randomUUID()
  await saveJson(f.journal.path, { version: 1, sessions: { ses_models: { conversationId: id, turns: { msg_1: { conversationId: id, promptHash: hash("hello"), status: "complete", text: "legacy" } } } } })
  await f.journal.load()
  const response = await request(f.transport)
  assert.equal(response.status, 400); assert.match(await response.text(), /different content/); assert.equal(f.calls.length, 0)
})
test("corrupt persisted model values fail closed", async t => {
  const f = await fixture(t); await request(f.transport)
  f.journal.data.sessions.ses_models.turns.msg_1.model = { invalid: true }; await f.journal.save()
  await assert.rejects(new Journal(f.journal.path).load(), /Corrupt/)
})
test("every selectable model reaches the real Notion client transcript configuration", async t => {
  const models = new NotionModels("default", true), f = await fixture(t, models), requests = []
  const config = notionConfig({ model: "default", tokenV2: "TEST_COOKIE", account: {} }, f.dir)
  config.account = { tokenV2: "TEST_COOKIE", userId: randomUUID(), userName: "Fixture", userEmail: "fixture@example.com", spaceId: randomUUID(), spaceName: "Test", spaceViewId: randomUUID(), timezone: "UTC" }
  const backend = new NotionBackend(config, async (url, init) => {
    assert.ok(String(url).endsWith("/runInferenceTranscript")); requests.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ type: "agent-inference", id: "reply", finishedAt: 1, value: [{ type: "text", content: "ok" }] }) + "\n")
  })
  const transport = new NotionTransport(backend, f.journal, "context", text => text, async () => {}, models)
  t.after(() => transport.close())
  for (const [index, choice] of models.choices.entries()) {
    const response = await request(transport, choice.id, `msg_${index}`)
    assert.equal(response.status, 200, await response.text())
    const requestBody = requests[index], configuration = requestBody.transcript.find(step => step.type === "config").value
    assert.equal(configuration.model, choice.notionModel)
    assert.equal(configuration.modelFromUser, true)
    assert.equal(requestBody.threadId, requests[0].threadId)
    assert.equal(requestBody.createThread, index === 0)
  }
  assert.equal(requests.length, MODEL_CATALOG.length)
})

test("OpenCode definitions expose attachments and every registered Notion effort variant",()=>{
  const models = new NotionModels("default", true), definitions = models.definitions()
  assert.equal(definitions["gpt-5.2"].attachment,true)
  assert.deepEqual(definitions["gpt-5.2"].modalities,{input:["text","image","pdf"],output:["text"]})
  for (const choice of models.choices) {
    const efforts = MODEL_REASONING_EFFORTS[choice.notionModel]
    if (!efforts) continue
    const definition = definitions[choice.id]
    assert.equal(definition.reasoning, true, choice.notionModel)
    assert.deepEqual(Object.keys(definition.variants), efforts.supported, choice.notionModel)
    for (const effort of efforts.supported) assert.equal(definition.variants[effort].reasoningEffort, effort)
  }
  assert.deepEqual(Object.keys(definitions["gpt-6-astra"].variants), ["low", "medium", "high", "xhigh", "max"])
})

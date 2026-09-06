import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { NotionModels } from "../dist/plugin/models.js"
import { settings } from "../dist/plugin/config.js"
import { SelectionGuard, guardInferenceResponse } from "../dist/plugin/selection.js"
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER } from "../dist/plugin/transport.js"
import { NotionBackend, notionConfig } from "../dist/plugin/notion.js"
import { Journal } from "../dist/plugin/storage.js"
const astra = "orlando-quinn", other = "opal-quince"
const account = { tokenV2: "TEST_COOKIE", userId: randomUUID(), userName: "Fixture", userEmail: "test@example.com", spaceId: randomUUID(), spaceName: "Fixture", spaceViewId: randomUUID(), timezone: "UTC" }
async function setup(t, fetcher) {
  const dir = await mkdtemp(join(tmpdir(), "notion-effort-")), calls = []
  const cfg = notionConfig({ model: "gpt-6-astra", tokenV2: account.tokenV2, account: {} }, dir); cfg.account = account
  const backend = fetcher ? new NotionBackend(cfg, fetcher) : { send: async input => { calls.push(input); return "ok" }, interrupt: async () => {} }
  const journal = new Journal(join(dir, "journal.json")); await journal.load()
  const models = new NotionModels("gpt-6-astra"), transport = new NotionTransport(backend, journal, "test", text => text, async () => {}, models)
  t.after(async () => { await transport.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, backend, journal, transport, models, calls }
}
function request(transport, message, options = {}) {
  return transport.fetch("https://opencode-notion.invalid/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", [SESSION_HEADER]: "ses_effort", [MESSAGE_HEADER]: message }, body: JSON.stringify({ model: "gpt-6-astra", messages: [{ role: "user", content: "hello" }], ...options }) })
}
test("Astra exposes exactly its five registry efforts and an explicit medium default", () => {
  const models = new NotionModels("gpt-6-astra"), definitions = models.definitions()
  assert.equal(models.resolve("chat"), astra)
  assert.deepEqual(Object.keys(definitions["gpt-6-astra"].variants), ["low", "medium", "high", "xhigh", "max"])
  assert.equal(definitions["gpt-6-astra"].options.reasoningEffort, "medium")
  assert.equal(definitions.chat.options.reasoningEffort, "medium")
  assert.equal(new NotionModels("gpt-6-astra", false, "high").resolveEffort("chat"), "high")
  assert.equal(models.resolveEffort("gpt-6-astra", "x-high"), "xhigh")
  for (const value of ["none", "minimal", "invalid", null, 4, {}, [], false]) assert.throws(() => models.resolveEffort("gpt-6-astra", value))
})
test("plugin options and environment can set a validated default effort", async t => {
  const f = await setup(t), options = { publicUrl: "https://fixture.example/mcp", stateDir: join(f.dir, "state"), runtimeDir: join(f.dir, "runtime"), bun: "/fake/bun", model: "gpt-6-astra" }
  const env = { NOTION_TOKEN_V2: "TEST_COOKIE", NOTION_REASONING_EFFORT: "low" }
  assert.equal((await settings(process.cwd(), options, env)).reasoningEffort, "low")
  assert.equal((await settings(process.cwd(), { ...options, reasoningEffort: "high" }, env)).reasoningEffort, "high")
  await assert.rejects(settings(process.cwd(), { ...options, reasoningEffort: "none" }, env))
  await assert.rejects(settings(process.cwd(), { ...options, reasoningEffort: null }, env))
})
test("invalid or conflicting efforts fail before journal creation and attachment dispatch", async t => {
  const f = await setup(t)
  const image = [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } }]
  for (const reasoning_effort of ["none", "minimal", "invalid", null, {}, [], 9]) {
    const r = await request(f.transport, "msg_same", { reasoning_effort, messages: [{ role: "user", content: image }] })
    assert.equal(r.status, 400)
  }
  assert.equal((await request(f.transport, "msg_same", { reasoningEffort: "high", reasoning_effort: "low" })).status, 400)
  assert.deepEqual(f.journal.data.sessions, {})
  assert.equal(f.calls.length, 0)
  assert.equal((await request(f.transport, "msg_same", { reasoning_effort: "high" })).status, 200)
})
test("all efforts reach the backend, and clearing a variant resets it after restart", async t => {
  const f = await setup(t)
  for (const [i, effort] of ["low", "medium", "high", "xhigh", "max"].entries()) {
    const key = i % 2 ? "reasoningEffort" : "reasoning_effort"
    assert.equal((await request(f.transport, `msg_${i}`, { [key]: effort })).status, 200)
    assert.equal(f.calls[i].model, astra); assert.equal(f.calls[i].reasoningEffort, effort)
  }
  const journal = new Journal(f.journal.path); await journal.load()
  const second = new NotionTransport(f.backend, journal, "test", text => text, async () => {}, f.models); t.after(() => second.close())
  assert.equal((await request(second, "msg_reset")).status, 200)
  assert.equal(f.calls.at(-1).reasoningEffort, "medium")
  assert.equal(f.calls.at(-1).conversationId, f.calls[0].conversationId)
  assert.equal(f.calls.at(-1).fresh, false)
  assert.equal((await request(second, "msg_reset", { reasoning_effort: "medium" })).status, 200)
  assert.equal(f.calls.length, 6)
  assert.equal((await request(second, "msg_reset", { reasoning_effort: "high" })).status, 400)
  assert.equal(f.calls.length, 6)
})
test("backend validates effort before any real-client image upload", async t => {
  let calls = 0
  const f = await setup(t, async () => { calls++; throw Error("must not dispatch") })
  await assert.rejects(f.backend.send({ prompt: "image", attachments: [{ base64: "iVBORw==", fileName: "probe.png", mimeType: "image/png" }], conversationId: randomUUID(), fresh: true, signal: new AbortController().signal, model: "gpt-6-astra", reasoningEffort: "none" }))
  assert.equal(calls, 0)
})
test("HTTP 200 model fallback becomes an uncertain turn and is not resent", async t => {
  let calls = 0
  const f = await setup(t, async () => { calls++; return new Response(JSON.stringify({ type: "config", id: "config", value: { model: other } }) + "\n") })
  const first = await request(f.transport, "msg_mismatch")
  assert.equal(first.status, 400); assert.match(await first.text(), /model mismatch.*GPT-6 Astra.*GPT-5.5/)
  assert.equal(f.journal.data.sessions.ses_effort.turns.msg_mismatch.status, "uncertain")
  assert.equal((await request(f.transport, "msg_mismatch")).status, 400)
  assert.equal(calls, 1)
})
test("matching response metadata succeeds, while streaming fallback is an error", async t => {
  let calls = 0
  const f = await setup(t, async (_url, init) => {
    calls++; const body = JSON.parse(init.body), config = body.transcript.find(s => s.type === "config")
    return new Response([config, { type: "agent-inference", id: "answer", model: calls === 1 ? astra : other, value: [{ type: "text", content: "verified" }] }].map(x => JSON.stringify(x)).join("\n") + "\n")
  })
  assert.equal((await request(f.transport, "msg_ok", { reasoning_effort: "high" })).status, 200)
  const r = await request(f.transport, "msg_wrong", { stream: true, reasoning_effort: "high" }), text = await r.text()
  assert.match(text, /model mismatch/); assert.doesNotMatch(text, /"finish_reason":"stop"/)
  assert.equal(calls, 2)
})
test("selection guard handles typed patches, later types, record maps and effort mismatches", () => {
  for (const event of [
    { type: "agent-inference", model: other },
    { type: "config", value: { model: other } },
    { type: "patch", v: [{ o: "a", p: "/s/0", v: { type: "agent-inference", model: other } }] },
    { type: "patch", v: [{ o: "a", p: "/s/0/model", v: other }, { o: "a", p: "/s/0/type", v: "agent-inference" }] },
    { type: "patch", v: [{ o: "a", p: "/s/0/type", v: "config" }, { o: "a", p: "/s/0/value/model", v: other }] },
    { type: "record-map", recordMap: { thread_message: { config: { value: { value: { step: { id: "current-config", type: "config", value: { model: other } } } } } } } },
  ]) assert.throws(() => new SelectionGuard({ model: astra, configId: "current-config" }).observe(event), /model mismatch/)
  assert.throws(() => new SelectionGuard({ model: astra, reasoningEffort: "high" }).observe({ type: "config", value: { model: astra, reasoningEffort: "medium" } }), /effort mismatch/)
  const g = new SelectionGuard({ model: astra, configId: "current-config" })
  g.observe({ type: "agent-tool-result", result: { type: "agent-inference", model: other } })
  g.observe({ type: "patch", v: [{ o: "a", p: "/s/0", v: { type: "agent-tool-result", model: other } }] })
  g.observe({ type: "record-map", recordMap: { thread_message: { old: { value: { value: { step: { id: "previous-turn", type: "config", value: { model: other } } } } } } } })
})
test("split SSE frames and unterminated final frames cannot hide model fallback", async () => {
  const encoded = new TextEncoder().encode('data: ' + JSON.stringify({ type: "agent-inference", model: other }))
  const source = new ReadableStream({ start(c) { c.enqueue(encoded.slice(0, 25)); c.enqueue(encoded.slice(25)); c.close() } })
  const response = guardInferenceResponse(new Response(source), JSON.stringify({ transcript: [{ id: "config", type: "config", value: { model: astra } }] }))
  await assert.rejects(response.text(), /model mismatch/)
})

test("filename-less SDK image parts get MIME-derived extensions, while named files are preserved", async t => {
  const f = await setup(t)
  for (const [index, [mime, extension]] of Object.entries({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" }).entries()) {
    const response = await request(f.transport, `msg_image_${index}`, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mime};base64,iVBORw==` } }] }] })
    assert.equal(response.status, 200)
    assert.equal(f.calls.at(-1).attachments[0].fileName, `attachment.${extension}`)
    assert.equal(f.calls.at(-1).attachments[0].mimeType, mime)
  }
  await request(f.transport, "msg_named", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==", filename: "original.png" } }] }] })
  assert.equal(f.calls.at(-1).attachments[0].fileName, "original.png")
})


test("config values preceding their type are checked without trusting nested inference content", () => {
  const g = new SelectionGuard({ model: astra })
  assert.throws(() => g.observe({ type: "patch", v: [
    { o: "a", p: "/s/0/value", v: { model: other } },
    { o: "a", p: "/s/0/type", v: "config" }
  ] }), /model mismatch/)
  const safe = new SelectionGuard({ model: astra })
  safe.observe({ type: "patch", v: [
    { o: "a", p: "/s/0/value", v: { model: other } },
    { o: "a", p: "/s/0/type", v: "agent-inference" },
    { o: "a", p: "/s/0/model", v: astra }
  ] })
  safe.observe({ type: "patch", v: [
    { o: "r", p: "/s/0/type" }, { o: "a", p: "/s/0/model", v: other },
    { o: "a", p: "/s/0/type", v: "agent-tool-result" }
  ] })
})
test("mismatched inference cancels the upstream stream and errors use public model names", async () => {
  let cancelled = false
  const body = new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ type: "agent-inference", model: other }) + "\n")) }, cancel() { cancelled = true } })
  const guarded = guardInferenceResponse(new Response(body), JSON.stringify({ transcript: [{ type: "config", value: { model: astra } }] }))
  await assert.rejects(guarded.text(), /model mismatch/)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(cancelled, true)
  assert.throws(() => new NotionModels("gpt-6-astra").resolveEffort("chat", "none"), error => /GPT-6 Astra/.test(error.message) && !error.message.includes(astra))
})

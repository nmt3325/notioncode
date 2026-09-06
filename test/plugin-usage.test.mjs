import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { InferenceUsageCollector, readNotionUsage } from "../dist/vendor/notion-ai/usage.js"
import { parseInferenceLines, parseInferenceStream } from "../dist/vendor/notion-ai/notion-client.js"
import { sanitizeJob } from "../dist/vendor/notion-ai/chat-jobs.js"
import { openAIUsage, usageEnvelope, reportedContext, readTurnUsage, withTurnUsage, notionUsageMetadataExtractor } from "../dist/plugin/usage.js"
import { NotionBackend, notionConfig } from "../dist/plugin/notion.js"
import { Journal } from "../dist/plugin/storage.js"
import { NotionTransport, SESSION_HEADER, MESSAGE_HEADER, AGENT_HEADER } from "../dist/plugin/transport.js"
const snapshot = (id, inputTokens, outputTokens, rest = {}) => ({ type: "agent-inference", id,
  ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), ...rest })
const collect = (...events) => { const c = new InferenceUsageCollector(); events.forEach(e => c.observe(e)); return c.result() }
const measured = () => collect(snapshot("one", 100, 20, { cachedTokensRead: 30, cachedTokensCreated: 10, maxInputTokens: 500, maxContextTokens: 1000 }))
const patch = (p, v, o = "a") => ({ o, p, v })
const patchEvent = (...v) => ({ type: "patch", v })

test("Notion cumulative snapshots replace counts, including corrections, rather than add them", () => {
  const usage = collect(snapshot("one", 100, 10), snapshot("one", 100, 10), snapshot("one", 90, 12))
  assert.deepEqual(usage.observedTotals, { inputTokens: 90, outputTokens: 12 })
  assert.equal(usage.inferenceCount, 1)
  assert.equal(usage.allInferenceInputOutputReported, true)
})
test("distinct inference totals stay separate from latest context; late old frames cannot change latest", () => {
  const usage = collect(snapshot("one", 100, 10), snapshot("two", 200, 20), snapshot("one", 110, 11))
  assert.deepEqual(usage.observedTotals, { inputTokens: 310, outputTokens: 31 })
  assert.deepEqual(usage.lastInference, { inputTokens: 200, outputTokens: 20 })
  assert.deepEqual(openAIUsage(usage), { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 })
})
test("field patches replace cumulative counts and do not add the same final frame twice", () => {
  const events = [patchEvent(patch("/s/0/id", "one"), patch("/s/0/type", "agent-inference"),
    patch("/s/0/inputTokens", 80), patch("/s/0/outputTokens", 5)),
    patchEvent(patch("/s/0/inputTokens", 100), patch("/s/0/outputTokens", 10)),
    patchEvent(patch("/s/0/inputTokens", 100), patch("/s/0/outputTokens", 10))]
  assert.deepEqual(collect(...events).observedTotals, { inputTokens: 100, outputTokens: 10 })
})
test("patch slot identity merges with full snapshots of that same inference", () => {
  const usage = collect(patchEvent(patch("/s/0/inputTokens", 100), patch("/s/0/outputTokens", 10)),
    snapshot("one", 100, 10), patchEvent(patch("/s/0/id", "one")))
  assert.equal(usage.inferenceCount, 1)
  assert.deepEqual(usage.observedTotals, { inputTokens: 100, outputTokens: 10 })
})
test("whole-step append patches preserve distinct step identity and cache/context fields", () => {
  const usage = collect(patchEvent(patch("/s/-", snapshot("one", 100, 10)),
    patch("/s/-", snapshot("two", 200, 20, { cachedTokensRead: 50, maxContextTokens: 1000 }))))
  assert.equal(usage.inferenceCount, 2)
  assert.equal(usage.lastInference.cachedTokensRead, 50)
  assert.equal(reportedContext(usage).percent, 22)
})
test("wholly ID-less snapshot streams are not counted as multiple inferences", () => {
  const usage = collect(snapshot(undefined, 100, 10), snapshot(undefined, 100, 11))
  assert.equal(usage.inferenceCount, 1)
  assert.equal(usage.allInferenceInputOutputReported, false)
  assert.deepEqual(usage.observedTotals, { inputTokens: 100, outputTokens: 11 })
})
test("later unreported inference never inherits a previous inference's metrics", () => {
  const usage = collect(snapshot("one", 100, 10), snapshot("two", undefined, undefined, { value: [{ type: "text", content: "answer" }] }))
  assert.deepEqual(usage.lastInference, {})
  assert.equal(usage.allInferenceInputOutputReported, false)
  assert.equal(openAIUsage(usage), undefined)
  const fromPatches = collect(patchEvent(patch("/s/0/inputTokens", 100), patch("/s/0/outputTokens", 10),
    patch("/s/1/value/-", { type: "text", content: "answer" })))
  assert.equal(openAIUsage(fromPatches), undefined)
})
test("missing, partial and explicit measured zero are different", () => {
  assert.equal(collect(snapshot("one")), undefined)
  assert.equal(collect({ type: "credits", inputTokens: 999, outputTokens: 999 }), undefined)
  const partial = collect(snapshot("one", 100))
  assert.deepEqual(partial.lastInference, { inputTokens: 100 })
  assert.equal(openAIUsage(partial), undefined)
  assert.equal("usage" in usageEnvelope(partial), false)
  assert.deepEqual(openAIUsage(collect(snapshot("one", 0, 0))), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
})
test("invalid or unsafe counters are omitted, never coerced or estimated", () => {
  for (const invalid of [-1, NaN, Infinity, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(collect(snapshot("one", invalid, invalid)), undefined)
  }
  const usage = collect(snapshot("one", Number.MAX_SAFE_INTEGER, 1))
  assert.equal(openAIUsage(usage), undefined)
  assert.equal(openAIUsage(collect(snapshot("one", 10, 1, { cachedTokensRead: 11 }))), undefined)
  assert.equal(reportedContext(collect(snapshot("one", 10, 1, { maxContextTokens: 0 }))).percent, undefined)
})
test("unknown nested token-shaped fields, tool results, credits and reasoning text are ignored", () => {
  const usage = collect({ type: "agent-tool-result", inputTokens: 200, outputTokens: 200 },
    patchEvent(patch("/s/0/type", "agent-tool-result"), patch("/s/0/inputTokens", 200)),
    patchEvent(patch("/s/1/value/0/tool/inputTokens", 200)),
    snapshot("one", 10, 2, { credits: 99, totalCostDollars: 3, thinkingTokens: 50,
      value: [{ type: "thinking", content: "secret" }], nested: { inputTokens: 500 } }))
  assert.deepEqual(usage.lastInference, { inputTokens: 10, outputTokens: 2 })
  assert.equal(usage.inferenceCount, 1)
  assert.equal(JSON.stringify(usage).includes("secret"), false)
  assert.equal("completion_tokens_details" in openAIUsage(usage), false)
})
test("cache reads are included in input, cache creation added once; only measured breakdown is sent", () => {
  assert.deepEqual(openAIUsage(measured()), { prompt_tokens: 110, completion_tokens: 20, total_tokens: 130,
    prompt_tokens_details: { cached_tokens: 30 } })
  assert.equal("prompt_tokens_details" in openAIUsage(collect(snapshot("one", 10, 2))), false)
  const context = reportedContext(measured())
  assert.deepEqual(context, { scope: "last-inference", tokens: 130, maxInputTokens: 500, maxContextTokens: 1000, percent: 26 })
  assert.equal(reportedContext(collect(snapshot("one", 10, 2))).percent, undefined)
})
test("final usage-only NDJSON frames survive arbitrary UTF-8 chunks and no terminal newline", async () => {
  const lines = [snapshot("one", undefined, undefined, { value: [{ type: "text", content: "日本語" }] }), snapshot("one", 7, 3)]
  const bytes = new TextEncoder().encode(lines.map(e => JSON.stringify(e)).join("\n"))
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close() } })
  const result = await parseInferenceStream(stream)
  assert.equal(result.text, "日本語")
  assert.deepEqual(openAIUsage(result.usage), { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
})
test("parser omits absent usage, rejects error/credit-limit frames, and does not leak thinking text", () => {
  const result = parseInferenceLines([JSON.stringify(snapshot("one", undefined, undefined, { value: [{ type: "thinking", content: "hidden" }, { type: "text", content: "visible" }] }))])
  assert.equal(result.text, "visible")
  assert.equal("usage" in result, false)
  assert.equal("inputTokens" in result, false)
  assert.equal("outputTokens" in result, false)
  assert.throws(() => parseInferenceLines([JSON.stringify(snapshot("one", 10, 2)), '{"type":"error","message":"bad"}']), /bad/)
  assert.throws(() => parseInferenceLines(['{"type":"premium-feature-unavailable","featureAvailability":{"limit":{"current":10,"total":10}}}']), /credit limit/)
})
test("safe persisted usage round-trips, unknown properties are stripped, old fabricated zero data is not upgraded", () => {
  const original = measured(), dirty = { ...original, cookie: "secret", lastInference: { ...original.lastInference, secret: "hidden" } }
  assert.deepEqual(readNotionUsage(dirty), original)
  assert.equal(readNotionUsage({ inputTokens: 0, outputTokens: 0 }), undefined)
  assert.equal(readTurnUsage(withTurnUsage({ status: "uncertain" }, original)), undefined)
  const job = { jobId: "job", conversationId: "conv", status: "completed", startedAt: 1, usage: original }
  assert.deepEqual(sanitizeJob(job).usage, original)
  assert.equal("usage" in sanitizeJob({ ...job, usage: { inputTokens: 0, outputTokens: 0 } }), false)
})
test("documented metadata extractor retains provenance and preserves actual cache write split", async () => {
  const envelope = usageEnvelope(measured()), one = await notionUsageMetadataExtractor.extractMetadata({ parsedBody: envelope })
  assert.equal(one.anthropic.cacheCreationInputTokens, 10)
  assert.deepEqual(one["notion-ai"].usage, measured())
  const stream = notionUsageMetadataExtractor.createStreamExtractor()
  stream.processChunk({ choices: [] }); stream.processChunk(envelope); stream.processChunk(envelope)
  assert.deepEqual(stream.buildMetadata(), one)
  assert.equal(await notionUsageMetadataExtractor.extractMetadata({ parsedBody: { usage: { prompt_tokens: 1 } } }), undefined)
})

async function fixture(t, send) {
  const dir = await mkdtemp(join(tmpdir(), "notion-usage-test-"))
  const calls = [], interrupts = []
  const backend = { send: async input => { calls.push(input); return send(input) }, interrupt: async id => { interrupts.push(id) } }
  const journal = new Journal(join(dir, "journal.json")); await journal.load()
  const transport = new NotionTransport(backend, journal, "context")
  t.after(async () => { await transport.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, journal, transport, backend, calls, interrupts }
}
function request(transport, { stream = false, message = "msg_usage", model = "chat", signal } = {}) {
  return transport.fetch("https://opencode-notion.invalid/v1/chat/completions", { method: "POST", signal,
    headers: { "content-type": "application/json", [SESSION_HEADER]: "ses_usage", [MESSAGE_HEADER]: message, [AGENT_HEADER]: "notion" },
    body: JSON.stringify({ model, stream, stream_options: { include_usage: true }, messages: [{ role: "user", content: "hello" }] }) })
}
const sse = text => text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))

test("transport puts one usage-only frame after stop and before DONE, and JSON carries identical metrics", async t => {
  const f = await fixture(t, async input => { input.onUsage?.(measured()); return "answer" })
  const text = await (await request(f.transport, { stream: true })).text(), events = sse(text)
  const frames = events.filter(e => e.usage)
  assert.equal(frames.length, 1); assert.deepEqual(frames[0].choices, [])
  assert.deepEqual(frames[0].usage, openAIUsage(measured()))
  assert.ok(text.indexOf('"finish_reason":"stop"') < text.indexOf('"usage"'))
  assert.ok(text.indexOf('"usage"') < text.indexOf("[DONE]"))
  const body = await (await request(f.transport)).json()
  assert.deepEqual(body.usage, frames[0].usage); assert.equal(f.calls.length, 1)
})
test("completed replay after restart preserves usage exactly and never adds or re-sends", async t => {
  const f = await fixture(t, async input => { input.onUsage?.(measured()); return "answer" })
  await request(f.transport)
  const journal = new Journal(f.journal.path); await journal.load()
  const transport = new NotionTransport(f.backend, journal, "context")
  try {
    for (let i = 0; i < 2; i++) assert.deepEqual((await (await request(transport)).json()).usage, openAIUsage(measured()))
    assert.equal(f.calls.length, 1)
  } finally { await transport.close() }
})
test("old completed turns and local metadata have no fabricated usage", async t => {
  const f = await fixture(t, async () => "answer")
  for (const options of [{}, { stream: true }, { model: "metadata" }]) {
    const text = await (await request(f.transport, options)).text()
    assert.equal(text.includes('"usage":'), false)
    assert.equal(text.includes('"notion_usage":'), false)
  }
  assert.equal(f.calls.length, 1)
})
test("unknown final input/output pair is preserved in provenance but not promoted to a fake zero pair", async t => {
  const partial = collect(snapshot("one", 100))
  const f = await fixture(t, async input => { input.onUsage?.(partial); return "answer" })
  const body = await (await request(f.transport)).json()
  assert.equal("usage" in body, false); assert.deepEqual(body.notion_usage.lastInference, { inputTokens: 100 })
})
test("errors after an early callback do not publish completion usage or permit replay", async t => {
  const f = await fixture(t, async input => { input.onUsage?.(measured()); throw new Error("mock error") })
  const body = await (await request(f.transport)).json()
  assert.ok(body.error); assert.equal("usage" in body, false)
  assert.equal("usage" in f.journal.data.sessions.ses_usage.turns.msg_usage, false)
  await request(f.transport); assert.equal(f.calls.length, 1)
})
test("cancelled turns discard early metrics instead of persisting a successful completion", async t => {
  const f = await fixture(t, async input => { input.onUsage?.(measured()); await delay(60000, undefined, { signal: input.signal }); return "never" })
  const response = await request(f.transport, { stream: true }), reader = response.body.getReader()
  await reader.read(); await delay(10); await reader.cancel(); await f.transport.close()
  const turn = f.journal.data.sessions.ses_usage.turns.msg_usage
  assert.equal(turn.status, "interrupted"); assert.equal("usage" in turn, false); assert.equal(f.interrupts.length, 1)
})
test("empty but successfully measured transport text does not lose a usage-only frame", async t => {
  const f = await fixture(t, async input => { input.onUsage?.(measured()); return "" })
  const frames = sse(await (await request(f.transport, { stream: true })).text())
  assert.deepEqual(frames.find(e => e.usage).usage, openAIUsage(measured()))
})

test("real Notion backend parses mocked runInferenceTranscript and invokes one final measured callback", async () => {
  const account = { user_id: randomUUID(), user_name: "Test", user_email: "test@example.invalid", space_id: randomUUID(), space_name: "Test", space_view_id: randomUUID(), timezone: "UTC", client_version: "test" }
  const cfg = notionConfig({ tokenV2: "not-a-real-token", model: "almond-croissant-low", account })
  const events = [snapshot("one", undefined, undefined, { value: [{ type: "text", content: "answer" }] }), snapshot("one", 100, 20, { cachedTokensRead: 30, cachedTokensCreated: 10 })]
  let calls = 0
  const backend = new NotionBackend(cfg, async (url) => { assert.ok(String(url).endsWith("/runInferenceTranscript")); calls++; return new Response(events.map(e => JSON.stringify(e)).join("\n")) })
  const usages = [], conversationId = randomUUID()
  assert.equal(await backend.send({ prompt: "hi", conversationId, fresh: true, signal: new AbortController().signal, onUsage: u => usages.push(u) }), "answer")
  assert.equal(calls, 1); assert.equal(usages.length, 1)
  assert.deepEqual(openAIUsage(usages[0]), { prompt_tokens: 110, completion_tokens: 20, total_tokens: 130, prompt_tokens_details: { cached_tokens: 30 } })
})
test("Notion's empty-answer guard rejects usage-only turns rather than pretending completion", async () => {
  const account = { user_id: randomUUID(), user_name: "Test", user_email: "test@example.invalid", space_id: randomUUID(), space_name: "Test", space_view_id: randomUUID(), timezone: "UTC", client_version: "test" }
  const backend = new NotionBackend(notionConfig({ tokenV2: "not-a-real-token", model: "almond-croissant-low", account }), async () => new Response(JSON.stringify(snapshot("one", 10, 0))))
  let called = false
  await assert.rejects(backend.send({ prompt: "hi", conversationId: randomUUID(), fresh: true, signal: new AbortController().signal, onUsage: () => { called = true } }), /no answer text/)
  assert.equal(called, false)
})

// Mixed-format and sparse-patch regressions: all are numeric-only protocol fixtures.
test("unidentified snapshots are dropped rather than double-counted when identified steps arrive", () => {
  const usage = collect(snapshot(undefined, 100, 10), snapshot("one", 100, 10))
  assert.equal(usage.inferenceCount, 1)
  assert.deepEqual(usage.observedTotals, { inputTokens: 100, outputTokens: 10 })
  assert.equal(usage.allInferenceInputOutputReported, false)
})
test("value-only patch slots reserve their index before a later append", () => {
  const usage = collect(patchEvent(patch("/s/0/value/-", { type: "text", content: "first" }),
    patch("/s/-", snapshot("second", 200, 20)), patch("/s/0/inputTokens", 100), patch("/s/0/outputTokens", 10)))
  assert.equal(usage.inferenceCount, 2)
  assert.deepEqual(usage.lastInference, { inputTokens: 200, outputTokens: 20 })
  assert.deepEqual(usage.observedTotals, { inputTokens: 300, outputTokens: 30 })
})
test("identity merge keeps newest assignment per numeric field, not the preferred transport format", () => {
  const usage = collect(snapshot("one", 100, 10, { cachedTokensRead: 25 }),
    patchEvent(patch("/s/0/inputTokens", 120), patch("/s/0/outputTokens", 12), patch("/s/0/id", "one")))
  assert.equal(usage.inferenceCount, 1)
  assert.deepEqual(usage.lastInference, { inputTokens: 120, outputTokens: 12, cachedTokensRead: 25 })
  const reverse = collect(patchEvent(patch("/s/0/inputTokens", 120), patch("/s/0/outputTokens", 12)),
    snapshot("one", 100, 10), patchEvent(patch("/s/0/id", "one")))
  assert.deepEqual(reverse.lastInference, { inputTokens: 100, outputTokens: 10 })
})
test("an explicitly invalid newest assignment cannot resurrect an older number during identity merge", () => {
  const usage = collect(snapshot("one", 100, 10), patchEvent(patch("/s/0/inputTokens", null), patch("/s/0/id", "one")))
  assert.deepEqual(usage.lastInference, { outputTokens: 10 })
  assert.equal(openAIUsage(usage), undefined)
})
test("a new stable inference id at a reused slot does not erase the old inference", () => {
  const usage = collect(patchEvent(patch("/s/0", snapshot("one", 100, 10)), patch("/s/0", snapshot("two", 200, 20))))
  assert.equal(usage.inferenceCount, 2)
  assert.deepEqual(usage.observedTotals, { inputTokens: 300, outputTokens: 30 })
  assert.deepEqual(usage.lastInference, { inputTokens: 200, outputTokens: 20 })
})
test("unsupported patch operations and unsafe indices cannot create phantom inferences", () => {
  const usage = collect(snapshot("one", 100, 10), patchEvent(patch("/s/1/value/-", "ignored", "unsupported"),
    patch("/s/9999999999999999999999/inputTokens", 9)))
  assert.equal(usage.inferenceCount, 1)
  assert.deepEqual(usage.lastInference, { inputTokens: 100, outputTokens: 10 })
})

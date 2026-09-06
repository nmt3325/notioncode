import { scopeKey, type ExecutionScope } from "../shared/hub.js"
import { readTurnUsage, usageEnvelope, withTurnUsage } from "./usage.js"
import { randomUUID } from "node:crypto"
import { Journal, hash } from "./storage.js"
import type { ChatBackend } from "./notion.js"
import type { ExecutionEvent } from "../opencodeClient.js"
import { isTerminal } from "../protocol.js"
import type { LiveDisplay, TurnDisplay } from "./live.js"
import type { Redactor } from "./redact.js"
import { NotionModels, META_MODEL } from "./models.js"
export { PROVIDER, CHAT_MODEL, META_MODEL } from "./models.js"
export const SESSION_HEADER = "x-opencode-notion-session"
export const MESSAGE_HEADER = "x-opencode-notion-message"
export const AGENT_HEADER = "x-opencode-notion-agent"
const AUXILIARY = new Set(["title", "summary", "compaction"])
interface InputAttachment { base64: string; fileName: string; mimeType: string }
function dataAttachment(url: unknown, fileName: unknown, fallbackMime = "application/octet-stream"): InputAttachment {
  if (typeof url !== "string") throw new Error("Attached file has no data")
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(url)
  if (!match) throw new Error("Only inline OpenCode file attachments are supported")
  const mimeType = (match[1] || fallbackMime).toLowerCase()
  // The standard OpenAI-compatible SDK discards image filenames. Notion checks
  // the extension even when contentType is correct, so .bin rejects real PNGs.
  const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" } as Record<string, string>)[mimeType] ?? "bin"
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : `attachment.${extension}`
  return { mimeType, base64: match[2].replace(/\s+/g, ""), fileName: name }
}
function newestInput(messages: unknown): { prompt: string; attachments: InputAttachment[] } {
  if (!Array.isArray(messages)) throw new Error("Missing chat messages")
  const message = [...messages].reverse().find(m => m?.role === "user")
  if (!message) throw new Error("Missing user message")
  if (typeof message.content === "string") return { prompt: message.content, attachments: [] }
  if (!Array.isArray(message.content)) throw new Error("Unsupported user message")
  const text: string[] = [], attachments: InputAttachment[] = []
  for (const part of message.content) {
    if (part?.type === "text") { text.push(String(part.text ?? "")); continue }
    if (part?.type === "image_url") { attachments.push(dataAttachment(part.image_url?.url, part.image_url?.filename ?? part.filename, "image/png")); continue }
    if (part?.type === "file") {
      const file = part.file ?? part
      attachments.push(dataAttachment(file.file_data ?? file.data ?? file.url, file.filename ?? file.name ?? part.filename, file.media_type ?? file.mediaType ?? part.mediaType))
      continue
    }
    throw new Error(`Unsupported user content part: ${String(part?.type ?? "unknown")}`)
  }
  return { prompt: text.join("\n"), attachments }
}
function responseError(message: string, status = 400): Response {
  return Response.json({ error: { message, type: "notion_plugin_error" } }, { status })
}
export interface ExecutionBinding {
  begin(session: string, message: string, conversationId: string): Promise<{ scope: ExecutionScope; context: string }>
  end(scope: ExecutionScope): Promise<void>
}
interface ActiveTurn {
  message: string; promptHash: string; model: string; promise: Promise<string>; controller: AbortController
  listeners: Set<(text: string) => void>; snapshot: () => string | undefined
}
export class NotionTransport {
  private busy = new Map<string, ActiveTurn>()
  display?: LiveDisplay
  private displayTurns = new Map<string, TurnDisplay>()
  private scopedDisplays = new Map<string, TurnDisplay>()
  private displayJobs = new Map<string, TurnDisplay>()
  get redactDisplay(): Redactor { return this.redact }
  observeExecution(event: ExecutionEvent): void {
    const key = `${event.scope ? scopeKey(event.scope) : "legacy"}:${event.job.job_id}`
    if (event.type === "start") {
      const display = event.scope ? this.scopedDisplays.get(scopeKey(event.scope))
        : !this.execution && this.displayTurns.size === 1 ? this.displayTurns.values().next().value : undefined
      if (display) {
        this.displayJobs.set(key, display)
        if (this.displayJobs.size > 4096) this.displayJobs.delete(this.displayJobs.keys().next().value!)
      }
    }
    this.displayJobs.get(key)?.update(event)
    if (isTerminal(event.job.status)) this.displayJobs.delete(key)
  }
  private closed = false
  constructor(private readonly backend: ChatBackend, readonly journal: Journal,
    private readonly context: string, private readonly redact: Redactor = text => text,
    private readonly cancelTools: (session?: string, message?: string) => Promise<void> = async () => {},
    readonly models = new NotionModels(), private readonly execution?: ExecutionBinding) {}
  private async turn(session: string, message: string, prompt: string, attachments: InputAttachment[], model: string, reasoningEffort: string | undefined, signal: AbortSignal, onText?: (text: string) => void): Promise<string> {
    if (this.closed) throw new Error("Plugin is shutting down")
    signal.throwIfAborted()
    const promptHash = attachments.length || reasoningEffort !== undefined ? hash(JSON.stringify({ prompt, attachments, reasoningEffort })) : hash(prompt)
    const existing = this.busy.get(session)
    if (existing) {
      if (existing.message !== message) throw new Error("Another Notion turn is active in this thread. Each thread has one AI; use another thread for parallel work")
      if (existing.promptHash !== promptHash) throw new Error("Message ID was reused with different content; start a new message")
      if (existing.model !== model) throw new Error("Message ID was reused with a different model; send a new message to change models")
      if (onText) { existing.listeners.add(onText); const text = existing.snapshot(); if (text !== undefined) onText(text) }
      try { return await existing.promise } finally { if (onText) existing.listeners.delete(onText) }
    }
    if (this.busy.size >= 32) throw new Error("Concurrent Notion thread limit reached; wait for an active thread")
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const listeners = new Set<(text: string) => void>(); if (onText) listeners.add(onText)
    let latest: string | undefined
    const publish = (text: string) => { if (combined.aborted) return; latest = text; for (const listener of listeners) listener(text) }
    const promise = this.execute(session, message, prompt, attachments, promptHash, model, reasoningEffort, combined, publish)
    const active = { message, promptHash, model, promise, controller, listeners, snapshot: () => latest }; this.busy.set(session, active)
    try { return await promise } finally { if (this.busy.get(session) === active) this.busy.delete(session) }
  }
  private async execute(session: string, message: string, prompt: string, attachments: InputAttachment[], promptHash: string, model: string, reasoningEffort: string | undefined, signal: AbortSignal, onText: (text: string) => void): Promise<string> {
    const release = await this.journal.acquire(session)
    try {
      signal.throwIfAborted()
      const known = this.journal.data.sessions[session]?.turns[message]
      if (known && known.promptHash !== promptHash) throw new Error("Message ID was reused with different content; start a new message")
      if (known?.model !== undefined && known.model !== model) throw new Error("Message ID was reused with a different model; send a new message to change models")
      if (known?.status === "complete") return known.text ?? ""
      if (known) throw new Error("This message was already dispatched. Its result is uncertain or it was interrupted; it will not be automatically resent. Inspect the Notion conversation, then send a new message")
      let conversation = this.journal.data.sessions[session]
      const fresh = !conversation
      if (!conversation) { conversation = { conversationId: randomUUID(), turns: {} }; this.journal.data.sessions[session] = conversation }
      const turn = { promptHash, model, conversationId: conversation.conversationId, status: "sending" as const }
      conversation.turns[message] = turn
      await this.journal.save(session)
      let display: TurnDisplay | undefined, scope: ExecutionScope | undefined, ending: Promise<void> | undefined, dispatched = false
      const end = () => { if (scope && this.execution) return ending ??= this.execution.end(scope); return Promise.resolve() }
      try {
        display = await this.display?.begin(session, message)
        if (display) this.displayTurns.set(session, display)
        signal.throwIfAborted()
        let executionContext = ""
        if (this.execution) {
          const opened = await this.execution.begin(session, message, conversation.conversationId)
          scope = opened.scope; executionContext = opened.context
          if (display) this.scopedDisplays.set(scopeKey(scope), display)
        }
        signal.throwIfAborted()
        let usage: unknown
        const prefix = [fresh ? this.context : "", executionContext].filter(Boolean).join("\n\n")
        dispatched = true
        const raw = await this.backend.send({ prompt: prefix ? `${prefix}\n\n${prompt}` : prompt,
          conversationId: conversation.conversationId, fresh, model, reasoningEffort, attachments, signal, onText,
          ...(scope ? { executionScope: scope } : {}), onUsage: value => { usage = value } })
        signal.throwIfAborted()
        await end()
        const text = this.redact(raw)
        display?.finalText(text); await display?.flush()
        conversation.turns[message] = withTurnUsage({ ...turn, status: "complete" as const, text }, usage)
        await this.journal.save(session); return text
      } catch (error) {
        conversation.turns[message] = { ...turn, status: signal.aborted ? "interrupted" : "uncertain" }
        try { await this.journal.save(session) }
        finally {
          const cleanup: Promise<unknown>[] = [end()]
          if (signal.aborted && dispatched) cleanup.push(this.backend.interrupt(conversation.conversationId), this.cancelTools(session, message))
          await Promise.allSettled(cleanup)
        }
        throw error
      } finally {
        if (this.displayTurns.get(session) === display) this.displayTurns.delete(session)
        if (scope) this.scopedDisplays.delete(scopeKey(scope))
      }
    } finally { await release() }
  }
  fetch: typeof fetch = async (input, init) => {
    let request: Request
    try { request = new Request(input, init) } catch { return responseError("Invalid provider request") }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") return responseError("Unsupported Notion provider endpoint", 404)
    try {
      const body = await request.json() as Record<string, any>
      const auxiliary = body.model === META_MODEL || AUXILIARY.has(request.headers.get(AGENT_HEADER) ?? "")
      const model = body.model === META_MODEL ? undefined : this.models.resolve(body.model)
      const { prompt, attachments } = newestInput(body.messages)
      // Validate before journal mutation, image upload, or network dispatch.
      const reasoningEffort = auxiliary ? undefined : this.models.resolveEffort(body.model, body.reasoningEffort !== undefined ? body.reasoningEffort : body.reasoning_effort)
      if (!auxiliary && body.reasoningEffort !== undefined && body.reasoning_effort !== undefined && reasoningEffort !== this.models.resolveEffort(body.model, body.reasoning_effort)) throw new Error("Conflicting reasoningEffort and reasoning_effort values")
      const session = request.headers.get(SESSION_HEADER) ?? ""
      const message = request.headers.get(MESSAGE_HEADER) ?? ""
      const valid = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id)
      if (!auxiliary && (!valid(session) || !valid(message))) return responseError("OpenCode session/message headers are missing or invalid. Use the supported plugin and OpenCode version")
      const abort = new AbortController(); const signal = AbortSignal.any([request.signal, abort.signal])
      // Metadata stays local, even if OpenCode explicitly uses the main model.
      const run = (onText?: (text: string) => void) => auxiliary ? Promise.resolve(prompt.trim().split(/\n/)[0].slice(0, 72) || "Notion conversation") : this.turn(session, message, prompt, attachments, model!, reasoningEffort, signal, onText)
      const metrics = () => auxiliary ? {} : usageEnvelope(readTurnUsage(this.journal.data.sessions[session]?.turns[message]))
      if (!body.stream) {
        const text = this.redact(await run())
        return Response.json({ id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now()/1000), model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], ...metrics() })
      }
      const id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now()/1000), encode = new TextEncoder(), self = this
      let heartbeat: ReturnType<typeof setInterval> | undefined, ended = false, emitted = "", revised = false
      let controller: ReadableStreamDefaultController<Uint8Array>
      const send = (value: unknown) => { if (!ended) controller.enqueue(encode.encode(`data: ${JSON.stringify(value)}\n\n`)) }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c; send(chunk({ role: "assistant", content: "" }))
          heartbeat = setInterval(() => { if (!ended) c.enqueue(encode.encode(": waiting for Notion\n\n")) }, 10000)
          const snapshot = (text: string, final = false) => {
            if (ended) return
            const safe = self.redact.stream?.(text, final) ?? self.redact(text)
            if (safe.startsWith(emitted) && !revised) {
              const delta = safe.slice(emitted.length); emitted = safe
              if (delta) send(chunk({ content: delta }))
            } else if (!emitted.startsWith(safe) || (final && safe !== emitted)) revised = true
            // SSE is append-only. The standard text.complete hook reconciles a
            // genuine upstream revision, without duplicating it as another answer.
            if (final && revised && !self.display) throw new Error("Notion revised previously streamed text; use the supported OpenCode live UI or retrieve the completed response without streaming")
          }
          void run(text => snapshot(text)).then(text => {
            snapshot(text, true); send(chunk({}, "stop"))
            const usage = metrics()
            if (Object.keys(usage).length) send({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], ...usage })
            if (!ended) { c.enqueue(encode.encode("data: [DONE]\n\n")); ended = true; c.close() }
          }).catch(error => {
            send({ error: { message: self.redact(error instanceof Error ? error.message : String(error)), type: "notion_plugin_error" } })
            if (!ended) { ended = true; c.close() }
          }).finally(() => clearInterval(heartbeat))
        },
        cancel() { ended = true; clearInterval(heartbeat); abort.abort(new Error("OpenCode stopped the response")) },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
    } catch (error) { return responseError(this.redact(error instanceof Error ? error.message : String(error))) }
  }
  abort(reason: Error): void { for (const active of this.busy.values()) active.controller.abort(reason) }
  async close(): Promise<void> {
    this.closed = true
    this.abort(new Error("Plugin disposed"))
    await Promise.allSettled([...this.busy.values()].map(active => active.promise))
    this.displayJobs.clear()
  }
}

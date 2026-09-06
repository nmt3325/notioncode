import { randomBytes } from "node:crypto"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { ExecutionEvent } from "../opencodeClient.js"
import { displayText, displayValue, type Redactor } from "./redact.js"
import type { NotionTransport } from "./transport.js"

export interface TurnDisplay {
  update(event: ExecutionEvent): void
  finalText(text: string): void
  flush(): Promise<void>
}
export interface LiveDisplay { begin(sessionID: string, userMessageID: string): Promise<TurnDisplay> }
type Assistant = { id: string; sessionID: string; parentID: string; role: string; providerID: string; agent?: string; modelID?: string; time: { completed?: number }; path?: { cwd: string } }
type RawSdk = { patch(options: Record<string, unknown>): Promise<{ error?: unknown }> }
const validID = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(id)
const auxiliary = new Set(["title", "summary", "compaction"])
let partCounter = 0
function partID(): string {
  const time = ((BigInt(Date.now()) * 0x1000n + BigInt(++partCounter % 4096)) & 0xffffffffffffn).toString(16).padStart(12, "0")
  return `prt_${time}${Array.from(randomBytes(14), n => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[n % 62]).join("")}`
}
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {}

/** Display-only part.update route on the SAME SDK transport supplied by OpenCode.
 * The pinned plugin root SDK is v1 (no part.update), while the public route and
 * v2 part schema are available. This narrow shim preserves in-process fetch,
 * directory routing, and server auth, unlike creating a localhost client.
 */
export class OpenCodeDisplay implements LiveDisplay {
  private readonly raw: RawSdk
  private readonly final = new Map<string, { sessionID: string; text: string }>()
  private readonly queues = new Set<Promise<void>>()
  private failure?: Error
  private closed = false
  constructor(private readonly input: Pick<PluginInput, "client" | "directory">, private readonly redact: Redactor = text => text) {
    const raw = Reflect.get(input.client, "_client") as RawSdk | undefined
    if (!raw || typeof raw.patch !== "function") throw new Error("This OpenCode version does not expose the supported display transport")
    this.raw = raw
  }
  private matches(info: Assistant, sessionID: string, parentID: string): boolean {
    return info?.role === "assistant" && info.sessionID === sessionID && info.parentID === parentID &&
      info.providerID === "notion-ai" && info.modelID !== "metadata" && !auxiliary.has(info.agent ?? "") &&
      validID(info.id) && info.id !== parentID && (!info.path?.cwd || info.path.cwd === this.input.directory)
  }
  event(event: unknown): void {
    const e = record(event)
    if (e.type === "message.removed") {
      const id = record(e.properties).messageID
      this.final.delete(id)
    }
  }
  complete(input: { sessionID: string; messageID: string }, output: { text: string }): void {
    const final = this.final.get(input.messageID)
    if (!final || final.sessionID !== input.sessionID) return
    output.text = final.text
    this.final.delete(input.messageID)
  }
  async begin(sessionID: string, userMessageID: string): Promise<TurnDisplay> {
    if (this.closed) throw new Error("OpenCode display is closed")
    if (this.failure) throw this.failure
    if (!validID(sessionID) || !validID(userMessageID)) throw new Error("Invalid OpenCode display identity")
    const query = { directory: this.input.directory }
    const user = await this.input.client.session.message({ path: { id: sessionID, messageID: userMessageID }, query, signal: AbortSignal.timeout(5000), throwOnError: true })
    if (user.data?.info.role !== "user" || user.data.info.id !== userMessageID || user.data.info.sessionID !== sessionID) throw new Error("Refusing to attach tool activity to a non-user turn")
    // Resolve exact parentage from storage, including when an event cache could
    // have missed a second candidate. Never choose a newest/ambiguous message.
    const result = await this.input.client.session.messages({ path: { id: sessionID }, query: { ...query, limit: 20 }, signal: AbortSignal.timeout(5000), throwOnError: true })
    const candidates = (result.data ?? []).map(x => x.info as Assistant).filter(info => this.matches(info, sessionID, userMessageID) && !info.time?.completed)
    if (candidates.length !== 1) throw new Error("Cannot uniquely identify this turn's OpenCode assistant; no Notion request was dispatched")
    const target = candidates[0]!, cards = new Map<string, ToolPart>()
    let queue = Promise.resolve(), draining = false, scopeFailure: Error | undefined
    const pendingParts = new Map<string, ToolPart>()
    const verify = async (allowCompleted = true) => {
      const response = await this.input.client.session.message({ path: { id: sessionID, messageID: target.id }, query, signal: AbortSignal.timeout(5000), throwOnError: true })
      if (!this.matches(response.data?.info as Assistant, sessionID, userMessageID) || (!allowCompleted && (response.data?.info as Assistant)?.time?.completed)) throw new Error("OpenCode assistant identity changed; refusing display update")
    }
    await verify(false)
    const drain = () => {
      if (draining) return
      draining = true
      queue = Promise.resolve().then(async () => {
        while (pendingParts.size && !scopeFailure && !this.closed) {
          const [key, value] = pendingParts.entries().next().value!
          pendingParts.delete(key)
          await verify()
        const result = await this.raw.patch({
          url: "/session/{sessionID}/message/{messageID}/part/{partID}",
          path: { sessionID, messageID: target.id, partID: value.id }, query,
          headers: { "content-type": "application/json" }, body: value,
          signal: AbortSignal.timeout(5000), throwOnError: true,
        })
        if (result.error) throw new Error("OpenCode rejected a tool display update")
        }
      }).catch(error => {
        pendingParts.clear()
        scopeFailure = this.failure = new Error(`Tool display failed; execution is not retried: ${this.redact(error instanceof Error ? error.message : String(error))}`)
      })
      queue = queue.finally(() => {
        draining = false
        if (pendingParts.size && !scopeFailure && !this.closed) drain()
      })
      const pending = queue
      this.queues.add(pending)
      void pending.finally(() => this.queues.delete(pending))
    }
    const put = (part: ToolPart, initial: boolean) => {
      // Preserve the first running card and the latest state. Fast native stdout
      // cannot create an unbounded chain of obsolete SDK writes.
      pendingParts.set(`${part.id}:${initial ? "start" : "latest"}`, structuredClone(part))
      drain()
    }
    return {
      update: event => {
        if (this.closed || scopeFailure) return
        const { job } = event
        let part = cards.get(job.job_id)
        if (!part) {
          if (event.type !== "start") return
          // Our namespace is separate from processor-owned text/tool parts.
          const id = partID()
          part = { id, messageID: target.id, sessionID, type: "tool", callID: `notion-display-${job.job_id}`,
            tool: `opencode_mcp.${this.redact(job.tool)}`,
            // providerExecuted is honored by the pinned prompt loop: without it,
            // even finish=stop would trigger another local model step.
            metadata: { providerExecuted: true, notionDisplay: { displayOnly: true, source: "execution-mcp" } },
            state: { status: "running", input: displayValue(event.input ?? {}, this.redact) as Record<string, unknown>, time: { start: Date.parse(job.created_at) || Date.now() } } }
          cards.set(job.job_id, part)
        }
        const { __display_status: _status, ...argumentsOnly } = part.state.input
        const input = { __display_status: job.status, ...argumentsOnly }
        const start = part.state.status === "pending" ? Date.now() : part.state.time.start
        const progressRedact = (text: string) => this.redact.stream?.(text, false) ?? this.redact(text)
        const title = displayText(job.result?.title ?? job.progress?.title ?? job.tool, job.result ? this.redact : progressRedact)
        const metadata = { notionDisplayOnly: true, executionStatus: job.status,
          ...(job.progress ? { progress: displayValue(job.progress, progressRedact) } : {}) }
        if (job.status === "completed") part.state = { status: "completed", input, title, metadata,
          output: displayText(job.result?.output ?? "", this.redact), time: { start, end: Date.parse(job.updated_at) || Date.now() } }
        else if (job.status === "failed" || job.status === "cancelled") part.state = { status: "error", input, metadata,
          error: displayText(job.error ?? job.status, this.redact), time: { start, end: Date.parse(job.updated_at) || Date.now() } }
        else part.state = { status: "running", input, title: `${title} (${job.status})`, metadata, time: { start } }
        put(part, event.type === "start")
        if (["completed", "failed", "cancelled"].includes(job.status)) cards.delete(job.job_id)
      },
      finalText: text => {
        this.final.set(target.id, { sessionID, text: this.redact(text) })
        if (this.final.size > 128) this.final.delete(this.final.keys().next().value!)
      },
      flush: async () => { do { await queue } while (draining || pendingParts.size); if (scopeFailure) throw scopeFailure },
    }
  }
  async close(): Promise<void> { await Promise.all(this.queues); this.closed = true; this.final.clear() }
}

/** Compose AFTER providerHooks; does not change picker/provider/model config. */
export function attachLiveUI(input: Pick<PluginInput, "client" | "directory">, transport: NotionTransport, hooks: Hooks): Hooks {
  const display = new OpenCodeDisplay(input, transport.redactDisplay)
  transport.display = display
  const event = hooks.event, complete = hooks["experimental.text.complete"], transform = hooks["experimental.chat.messages.transform"], dispose = hooks.dispose
  return { ...hooks,
    event: async value => { display.event(value.event); await event?.(value) },
    "experimental.chat.messages.transform": async (input, output) => {
      await transform?.(input, output)
      // Cards stay persisted for the stock UI, but never become model tool
      // messages, including after restarting or switching providers.
      output.messages = output.messages.map(message => message.info.role === "assistant" && message.info.providerID === "notion-ai"
        ? { ...message, parts: message.parts.filter(part => !(part.type === "tool" && part.callID.startsWith("notion-display-") && record(part.metadata?.notionDisplay).displayOnly === true)) }
        : message)
    },
    "experimental.text.complete": async (input, output) => { await complete?.(input, output); display.complete(input, output) },
    dispose: async () => { try { await dispose?.() } finally { await display.close() } },
  }
}

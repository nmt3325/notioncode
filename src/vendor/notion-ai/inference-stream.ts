import { InferenceUsageCollector } from "./usage.js"
import type { ParsedInferenceStream } from "./types.js"

/** Cumulative, user-visible text only. No raw event, reasoning, or tool payload escapes. */
export type TextObserver = (snapshot: string) => void
interface Entry { type: string; content: string }
interface Step { entries: Entry[]; versions: number[]; resetAt: number; order: number; kind?: string; kindVersion: number }
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const string = (v: unknown): string => typeof v === "string" ? v : ""
function entry(v: unknown): Entry {
  const x = object(v)
  // Keep no hidden text, even in the parser's retained state.
  return { type: string(x.type), content: x.type === "text" ? string(x.content) : "" }
}
function clean(text: string): string {
  return text.replace(/<lang\b[^>]*\/>/g, "").replace(/<(?:l(?:a(?:n(?:g[^>]*)?)?)?)?$/, "")
}

/** Incremental reducer for the inference-transcript NDJSON snapshot + patch dialect. */
export class InferenceText {
  private steps = new Map<string, Step>()
  private slots = new Map<string, string>()
  private nextSlot = 0
  private revision = 0
  private order = 0
  private eventTypes: Record<string, number> = Object.create(null)
  private last = ""
  private usage = new InferenceUsageCollector()
  constructor(private readonly onText?: TextObserver) {}
  private step(key: string): Step {
    let value = this.steps.get(key)
    if (!value) {
      if (this.steps.size >= 10000) throw new Error("Notion inference step limit exceeded")
      value = { entries: [], versions: [], resetAt: 0, order: this.order++, kindVersion: 0 }
      this.steps.set(key, value)
    }
    return value
  }
  private slot(label: string): string | undefined {
    if (label === "-") label = String(this.nextSlot)
    if (/^\d+$/.test(label)) {
      const index = Number(label)
      if (!Number.isSafeInteger(index) || index >= Number.MAX_SAFE_INTEGER) return
      this.nextSlot = Math.max(this.nextSlot, index + 1)
      label = String(index)
    }
    return label
  }
  private slotKey(label: string): string {
    // Numeric workflow slots are distinct from stable IDs. Older named-slot
    // fixtures remain supported only directly under the inference /s root.
    return this.slots.get(label) ?? (/^\d+$/.test(label) ? `slot:${label}` : `id:${label}`)
  }
  private replace(step: Step, value: unknown[]): void {
    if (value.length > 10001) throw new Error("Notion inference entry limit exceeded")
    step.entries = value.map(entry)
    step.resetAt = ++this.revision
    step.versions = step.entries.map(() => step.resetAt)
  }
  private kind(step: Step, value: string): void {
    step.kind = value; step.kindVersion = ++this.revision
    if (value !== "agent-inference") this.replace(step, [])
  }
  private identify(slot: string, id: string): Step {
    const key = `id:${id}`, oldKey = this.slotKey(slot), old = this.steps.get(oldKey)
    let target = this.steps.get(key)
    if (old && oldKey !== key && oldKey.startsWith("slot:")) {
      if (!target) { target = old; this.steps.set(key, old) }
      else {
        const resetAt = Math.max(target.resetAt, old.resetAt), entries: Entry[] = [], versions: number[] = []
        for (let i = 0; i < Math.max(target.entries.length, old.entries.length, target.versions.length, old.versions.length); i++) {
          const a = target.versions[i] ?? 0, b = old.versions[i] ?? 0, version = Math.max(a, b)
          if (!version || version < resetAt) continue
          const item = b > a ? old.entries[i] : target.entries[i]
          if (item) entries[i] = item
          versions[i] = version
        }
        target.entries = entries; target.versions = versions; target.resetAt = resetAt
        target.order = Math.min(target.order, old.order)
        if (old.kindVersion > target.kindVersion) { target.kind = old.kind; target.kindVersion = old.kindVersion }
        if (target.kind && target.kind !== "agent-inference") this.replace(target, [])
      }
      this.steps.delete(oldKey)
      for (const [alias, linked] of this.slots) if (linked === oldKey) this.slots.set(alias, key)
    }
    // Reusing a numeric slot with another stable ID starts a distinct step.
    if (!this.slots.has(slot) && this.slots.size >= 10000) throw new Error("Notion inference slot limit exceeded")
    this.slots.set(slot, key)
    return target ?? this.step(key)
  }
  private text(): string {
    return [...this.steps.values()].sort((a, b) => a.order - b.order)
      .flatMap(step => step.entries.filter(x => x.type === "text").map(x => clean(x.content)).filter(Boolean)).join("\n\n")
  }
  line(raw: string): void {
    if (raw.length > 16 * 1024 * 1024) throw new Error("Notion inference frame limit exceeded")
    let line = raw.trim()
    if (!line || line.startsWith(":") || line.startsWith("event:")) return
    if (line.startsWith("data:")) line = line.slice(5).trim()
    if (line === "[DONE]") return
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { return }
    const event = object(parsed), type = string(event.type) || "unknown"
    this.eventTypes[type] = (this.eventTypes[type] ?? 0) + 1
    this.usage.observe(event)
    if (type === "error") throw new Error(`Notion AI error: ${string(event.message) || "unknown error"}`)
    if (type === "premium-feature-unavailable") {
      const limit = object(object(event.featureAvailability).limit)
      const detail = typeof limit.current === "number" && typeof limit.total === "number" ? ` (AI credit limit reached: ${limit.current}/${limit.total})` : ""
      throw new Error(`Notion AI premium feature unavailable${detail}`)
    }
    if (type === "agent-inference") {
      const id = string(event.id), step = this.step(id ? `id:${id}` : "anonymous")
      this.kind(step, type)
      if (Array.isArray(event.value)) this.replace(step, event.value)
    } else if (type === "patch") {
      for (const rawOp of Array.isArray(event.v) ? event.v : []) this.patch(object(rawOp))
    } else return
    const text = this.text()
    if (text !== this.last) { this.last = text; this.onText?.(text) }
  }
  private patch(op: Record<string, unknown>): void {
    const path = string(op.p), operation = string(op.o)
    if (!["a", "p", "x", "r"].includes(operation)) return
    const numeric = /^\/s\/(\d+)(?:\/|$)/.exec(path)
    if (numeric && this.slot(numeric[1]!) === undefined) return
    const root = /^\/s\/([^/]+)(?:\/(id|type))?$/.exec(path)
    if (root) {
      if (!["a", "p", "r"].includes(operation)) return
      const slot = this.slot(root[1]!)
      if (slot === undefined) return
      if (root[2] === "id") { if (typeof op.v === "string" && op.v && operation !== "r") this.identify(slot, op.v); return }
      if (root[2] === "type") { if (typeof op.v === "string" && operation !== "r") this.kind(this.step(this.slotKey(slot)), op.v); return }
      if (operation === "r") { this.replace(this.step(this.slotKey(slot)), []); return }
      const value = object(op.v)
      const step = typeof value.id === "string" && value.id ? this.identify(slot, value.id) : this.step(this.slotKey(slot))
      if (typeof value.type === "string") this.kind(step, value.type)
      if (value.type === "agent-inference" && Array.isArray(value.value)) this.replace(step, value.value)
      return
    }
    // Do not inspect similarly named arrays nested inside tool/reviewer payloads.
    const match = /^\/s\/([^/]+)\/value(?:\/(\d+|-)(?:\/(content|type))?)?$/.exec(path)
    if (!match || match[1] === "-") return
    const slot = this.slot(match[1]!)
    if (slot === undefined) return
    const step = this.step(this.slotKey(slot)), indexText = match[2], field = match[3]
    if (step.kind && step.kind !== "agent-inference") return
    if (indexText === undefined) {
      if (operation === "r") this.replace(step, [])
      else if (Array.isArray(op.v) && (operation === "a" || operation === "p")) this.replace(step, op.v)
      return
    }
    const index = indexText === "-" ? step.entries.length : Number(indexText)
    if (!Number.isSafeInteger(index) || index < 0 || index > 10000) return
    if (!field) {
      if (operation === "r") { step.entries.splice(index, 1); this.replace(step, step.entries); return }
      if (operation === "a" || operation === "p") { step.entries[index] = entry(op.v); step.versions[index] = ++this.revision }
      return
    }
    const current = step.entries[index]
    if (!current) return // Unknown entry type is never presumed public text.
    if (field === "type") {
      if (operation === "x") return
      current.type = operation === "r" ? "" : string(op.v)
      if (current.type !== "text") current.content = ""
    } else if (operation === "r") current.content = ""
    else {
      if (current.type !== "text" || typeof op.v !== "string") return
      if (operation === "x") current.content += op.v
      else current.content = op.v
    }
    step.versions[index] = ++this.revision
  }
  result(): ParsedInferenceStream {
    const usage = this.usage.result()
    return { text: this.text(), ...(usage ? { usage } : {}),
      ...(usage?.observedTotals.inputTokens !== undefined ? { inputTokens: usage.observedTotals.inputTokens } : {}),
      ...(usage?.observedTotals.outputTokens !== undefined ? { outputTokens: usage.observedTotals.outputTokens } : {}), eventTypes: this.eventTypes }
  }
}
export function inferenceLines(lines: string[]): ParsedInferenceStream {
  const parser = new InferenceText()
  for (const line of lines) parser.line(line)
  return parser.result()
}
export async function inferenceStream(stream: ReadableStream<Uint8Array>, onText?: TextObserver): Promise<ParsedInferenceStream> {
  const parser = new InferenceText(onText), reader = stream.getReader(), decoder = new TextDecoder()
  let buffer = "", done = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) { done = true; break }
      buffer += decoder.decode(next.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) { parser.line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Notion inference frame limit exceeded")
    }
    buffer += decoder.decode()
    if (buffer.trim()) parser.line(buffer)
    return parser.result()
  } finally {
    if (!done) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

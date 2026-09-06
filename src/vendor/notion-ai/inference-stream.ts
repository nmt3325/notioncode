import { InferenceUsageCollector } from "./usage.js"
import type { ParsedInferenceStream } from "./types.js"

/** Cumulative, user-visible text only. No raw event, reasoning, or tool payload escapes. */
export type TextObserver = (snapshot: string) => void
interface Entry { type: string; content: string }
interface Step { entries: Entry[] }
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
  private eventTypes: Record<string, number> = Object.create(null)
  private last = ""
  private usage = new InferenceUsageCollector()
  constructor(private readonly onText?: TextObserver) {}
  private step(id: string): Step {
    let value = this.steps.get(id)
    if (!value) {
      if (this.steps.size >= 10000) throw new Error("Notion inference step limit exceeded")
      value = { entries: [] }; this.steps.set(id, value)
    }
    return value
  }
  private text(): string {
    return [...this.steps.values()].flatMap(step => step.entries.filter(x => x.type === "text").map(x => clean(x.content)).filter(Boolean)).join("\n\n")
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
      const step = this.step(string(event.id) || "anonymous")
      if (Array.isArray(event.value)) step.entries = event.value.map(entry)
    } else if (type === "patch") {
      for (const rawOp of Array.isArray(event.v) ? event.v : []) this.patch(object(rawOp))
    } else return
    const text = this.text()
    if (text !== this.last) { this.last = text; this.onText?.(text) }
  }
  private patch(op: Record<string, unknown>): void {
    const path = string(op.p), operation = string(op.o)
    if (!["a", "p", "x", "r"].includes(operation)) return
    // Match exact entry fields, not arbitrary paths containing the word "content".
    const match = /^(.*?)\/value(?:\/(\d+|-)(?:\/(content|type))?)?$/.exec(path)
    if (match) {
      const prefix = match[1]!.split("/").filter(Boolean).at(-1) || "anonymous"
      const step = this.step(prefix), indexText = match[2], field = match[3]
      if (indexText === undefined) {
        if (operation === "r") { step.entries = []; return }
        if (Array.isArray(op.v) && (operation === "a" || operation === "p")) step.entries = op.v.map(entry)
        return
      }
      const index = indexText === "-" ? step.entries.length : Number(indexText)
      if (!Number.isSafeInteger(index) || index < 0 || index > 10000) return
      if (!field) {
        if (operation === "r") { step.entries.splice(index, 1); return }
        if (operation === "a" || operation === "p") step.entries[index] = entry(op.v)
        return
      }
      const current = step.entries[index]
      if (!current) return // Unknown entry type is NOT presumed public text.
      if (field === "type") {
        current.type = string(op.v)
        if (current.type !== "text") current.content = ""
        return
      }
      if (field === "content" && operation === "r") { current.content = ""; return }
      if (current.type !== "text" || typeof op.v !== "string") return
      if (operation === "x") current.content += op.v
      else if (operation === "a" || operation === "p") current.content = op.v
      return
    }
    // Full-step puts, used before typed entry patches.
    const value = object(op.v)
    if ((operation === "a" || operation === "p") && value.type === "agent-inference" && Array.isArray(value.value)) {
      const id = string(value.id) || path.split("/").filter(Boolean).at(-1) || "anonymous"
      const step = this.step(id)
      step.entries = value.value.map(entry)
    }
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

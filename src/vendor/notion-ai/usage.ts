/** Numeric fields observed on Notion's workflow agent-inference steps.
 * See docs/usage-ui.md for the public source evidence and scope limitations.
 * No text, tool arguments, credits, model pricing or estimated tokens live here.
 */
export interface NotionInferenceUsage {
  inputTokens?: number
  outputTokens?: number
  cachedTokensRead?: number
  cachedTokensCreated?: number
  maxInputTokens?: number
  maxContextTokens?: number
}
export type NotionTokenTotals = Pick<NotionInferenceUsage, "inputTokens" | "outputTokens" | "cachedTokensRead" | "cachedTokensCreated">
export interface NotionUsage {
  source: "notion-inference"
  /** Last inference in this response, NOT the sum of a turn or conversation. */
  lastInference: NotionInferenceUsage
  /** Sum of only the fields actually reported, once per distinct observed inference. */
  observedTotals: NotionTokenTotals
  inferenceCount: number
  /** Does not assert that cache details, all remote steps, or reasoning were reported. */
  allInferenceInputOutputReported: boolean
}
const tokenKeys = ["inputTokens", "outputTokens", "cachedTokensRead", "cachedTokensCreated"] as const
const keys = [...tokenKeys, "maxInputTokens", "maxContextTokens"] as const
type Field = typeof keys[number]
const fields = new Set<string>(keys)
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
export const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const validField = (key: Field, value: unknown): value is number => tokenCount(value) && (!key.startsWith("max") || value > 0)
function counts(value: unknown, limits = true): NotionInferenceUsage {
  const result: NotionInferenceUsage = {}
  if (!record(value)) return result
  for (const key of limits ? keys : tokenKeys) if (validField(key, value[key])) result[key] = value[key] as number
  return result
}
/** Untrusted journal/metadata input: allowlist numeric fields; reject legacy fabricated zero usage. */
export function readNotionUsage(value: unknown): NotionUsage | undefined {
  if (!record(value) || value.source !== "notion-inference" || !record(value.lastInference) || !record(value.observedTotals) || !tokenCount(value.inferenceCount) || value.inferenceCount < 1 || typeof value.allInferenceInputOutputReported !== "boolean") return
  const latest = counts(value.lastInference), totals = counts(value.observedTotals, false)
  if (!Object.keys(latest).length && !Object.keys(totals).length) return
  return { source: "notion-inference", lastInference: latest, observedTotals: totals,
    inferenceCount: value.inferenceCount, allInferenceInputOutputReported: value.allInferenceInputOutputReported }
}

type Step = {
  order: number
  type?: string
  typeVersion: number
  usage: NotionInferenceUsage
  versions: Partial<Record<Field, number>>
}
/** Snapshot collector, not an increment counter. Instantiate once per HTTP response. */
export class InferenceUsageCollector {
  private steps = new Map<string, Step>()
  private slots = new Map<string, string>()
  private nextSlot = 0
  private nextOrder = 0
  private version = 0
  private anonymous = false
  private step(key: string): Step {
    let step = this.steps.get(key)
    if (!step) {
      step = { order: this.nextOrder++, typeVersion: 0, usage: {}, versions: {} }
      this.steps.set(key, step)
    }
    return step
  }
  private assign(step: Step, value: Record<string, unknown>): void {
    if (typeof value.type === "string") { step.type = value.type; step.typeVersion = ++this.version }
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) continue
      step.versions[key] = ++this.version
      if (validField(key, value[key])) step.usage[key] = value[key] as number
      else delete step.usage[key]
    }
  }
  private merge(target: Step, source: Step): void {
    target.order = Math.min(target.order, source.order)
    if (source.typeVersion > target.typeVersion) { target.type = source.type; target.typeVersion = source.typeVersion }
    for (const key of keys) {
      if ((source.versions[key] ?? -1) <= (target.versions[key] ?? -1)) continue
      target.versions[key] = source.versions[key]
      if (source.usage[key] !== undefined) target.usage[key] = source.usage[key]
      else delete target.usage[key]
    }
  }
  private identify(slot: string, id: string): Step {
    const key = `id:${id}`, oldKey = this.slots.get(slot) ?? `slot:${slot}`
    const old = this.steps.get(oldKey), existing = this.steps.get(key)
    // A previously anonymous slot can be linked to a snapshot identity. A new
    // *stable id* at a reused index is instead a distinct inference, not a rename.
    if (old && oldKey !== key && oldKey.startsWith("slot:")) {
      if (existing) this.merge(existing, old)
      else this.steps.set(key, old)
      this.steps.delete(oldKey)
      for (const [alias, linked] of this.slots) if (linked === oldKey) this.slots.set(alias, key)
    }
    this.slots.set(slot, key)
    return this.step(key)
  }
  private slotStep(slot: string): Step { return this.step(this.slots.get(slot) ?? `slot:${slot}`) }
  private index(value: string): number | undefined {
    const index = value === "-" ? this.nextSlot : Number(value)
    if (!tokenCount(index) || index >= Number.MAX_SAFE_INTEGER) return
    this.nextSlot = Math.max(this.nextSlot, index + 1)
    // Cannot safely attribute an ID-less snapshot to a newly identified slot.
    // Drop it rather than count it again or inherit possibly unrelated fields.
    this.steps.delete("anonymous")
    return index
  }
  observe(value: unknown): void {
    if (!record(value)) return
    if (value.type === "agent-inference") {
      // Real workflow snapshots have a stable step id. A wholly ID-less stream
      // is treated as ONE snapshot, never a new inference for every line.
      const id = typeof value.id === "string" && value.id ? value.id : undefined
      if (!id && [...this.steps.keys()].some(key => key !== "anonymous")) return
      if (!id) this.anonymous = true
      else this.steps.delete("anonymous")
      this.assign(this.step(id ? `id:${id}` : "anonymous"), value)
      return
    }
    if (value.type !== "patch" || !Array.isArray(value.v)) return
    for (const raw of value.v) {
      if (!record(raw) || typeof raw.p !== "string" || !["a", "p"].includes(String(raw.o))) continue
      // A later inference with no token fields must not inherit the previous
      // inference's usage. Observe the documented value-entry path as well.
      const valuePath = /^\/s\/(\d+)\/value(?:\/(?:\d+|-)(?:\/content)?)?$/.exec(raw.p)
      if (valuePath) {
        const index = this.index(valuePath[1])
        if (index === undefined) continue
        const step = this.slotStep(`/s/${index}`)
        if (!step.type) this.assign(step, { type: "agent-inference" })
        continue
      }
      const match = /^\/s\/(\d+|-)(?:\/(id|type|inputTokens|outputTokens|cachedTokensRead|cachedTokensCreated|maxInputTokens|maxContextTokens))?$/.exec(raw.p)
      if (!match) continue // never read counters out of tool payloads or nested review traces
      const index = this.index(match[1])
      if (index === undefined) continue
      const slot = `/s/${index}`, field = match[2]
      if (!field) {
        if (!record(raw.v)) continue
        const step = typeof raw.v.id === "string" && raw.v.id ? this.identify(slot, raw.v.id) : this.slotStep(slot)
        this.assign(step, raw.v)
        continue
      }
      if (field === "id" && typeof raw.v === "string" && raw.v) { this.identify(slot, raw.v); continue }
      const step = this.slotStep(slot)
      if (field === "type") { if (typeof raw.v === "string") this.assign(step, { type: raw.v }); continue }
      if (fields.has(field)) this.assign(step, { [field]: raw.v })
    }
  }
  result(): NotionUsage | undefined {
    const steps = [...this.steps.values()].filter(step => step.type === "agent-inference" || (!step.type && Object.keys(step.usage).length)).sort((a, b) => a.order - b.order)
    if (!steps.length) return
    const observedTotals: NotionTokenTotals = {}
    for (const key of tokenKeys) {
      const reported = steps.map(step => step.usage[key]).filter((n): n is number => n !== undefined)
      if (!reported.length) continue
      const total = reported.reduce((a, b) => a + b, 0)
      if (tokenCount(total)) observedTotals[key] = total
    }
    const latest = counts(steps.at(-1)!.usage)
    if (!Object.keys(latest).length && !Object.keys(observedTotals).length) return
    return { source: "notion-inference", lastInference: latest, observedTotals,
      inferenceCount: steps.length,
      allInferenceInputOutputReported: !this.anonymous && steps.every(step => step.usage.inputTokens !== undefined && step.usage.outputTokens !== undefined) }
  }
}

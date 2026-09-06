import { MODEL_CATALOG, normalizeModelName } from "../vendor/notion-ai/models.js"

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}
const label = (id: string) => MODEL_CATALOG.find(entry => entry.modelId === id)?.displayName ?? "an unrecognized model"
interface Selection { model: string; reasoningEffort?: string | undefined; configId?: string | undefined }
interface Step { id?: string; type?: string; model?: unknown; reasoningEffort?: unknown; configModel?: unknown; configEffort?: unknown }

/** Only authoritative top-level transcript metadata is inspected; never tool output or thinking. */
export class SelectionGuard {
  private readonly currentIds = new Set<string>()
  private readonly slots = new Map<string, Step>()
  constructor(private readonly expected: Selection) {
    if (expected.configId) this.currentIds.add(expected.configId)
  }
  private check(step: Step): void {
    if (step.type !== "config" && step.type !== "agent-inference") return
    if (step.id) this.currentIds.add(step.id)
    if (this.currentIds.size > 10000) throw new Error("Notion selection metadata limit exceeded")
    const model = step.type === "config" ? step.configModel : step.model
    const effort = step.type === "config" ? step.configEffort : step.reasoningEffort
    if (typeof model === "string" && model && normalizeModelName(model, "default") !== this.expected.model) {
      throw new Error(`Notion model mismatch: requested ${label(this.expected.model)}, but Notion reported ${label(model)}. No automatic retry was sent.`)
    }
    if (this.expected.reasoningEffort && typeof effort === "string" && effort !== this.expected.reasoningEffort) {
      throw new Error("Notion reasoning effort mismatch: the server did not retain the requested effort. No automatic retry was sent.")
    }
  }
  private snapshot(value: ObjectValue): Step {
    const config = object(value.value)
    return { ...(typeof value.id === "string" ? { id: value.id } : {}), ...(typeof value.type === "string" ? { type: value.type } : {}), model: value.model, reasoningEffort: value.reasoningEffort, configModel: config.model, configEffort: config.reasoningEffort }
  }
  observe(value: unknown): void {
    const event = object(value)
    if (event.type === "config" || event.type === "agent-inference") {
      const step = this.snapshot(event)
      this.check(step)
      for (const [slot, old] of this.slots) if (step.id && step.id === old.id) this.slots.set(slot, { ...old, ...step })
    } else if (event.type === "record-map") {
      // Record maps may contain older turns. Only inspect this turn's known IDs.
      for (const entry of Object.values(object(object(event.recordMap).thread_message))) {
        const message = object(object(object(entry).value).value), step = object(message.step)
        if (typeof step.id === "string" && this.currentIds.has(step.id)) this.check(this.snapshot(step))
      }
    } else if (event.type === "patch") {
      for (const raw of Array.isArray(event.v) ? event.v : []) {
        const op = object(raw)
        if (op.o !== "a" && op.o !== "p" && op.o !== "r") continue
        if (typeof op.p !== "string") continue
        const match = /^\/s\/([^/]+)(?:\/(id|type|model|reasoningEffort|value)(?:\/(model|reasoningEffort))?)?$/.exec(op.p)
        if (!match) continue
        const slot = match[1]!, field = match[2], nested = match[3]
        if (slot === "-") continue
        if (op.o === "r") {
          if (!field) this.slots.delete(slot)
          else {
            const step = this.slots.get(slot)
            if (step) {
              if (field === "value") {
                if (!nested || nested === "model") delete step.configModel
                if (!nested || nested === "reasoningEffort") delete step.configEffort
              } else if (field === "id" || field === "type" || field === "model" || field === "reasoningEffort") delete step[field]
            }
          }
          continue
        }
        if (!this.slots.has(slot) && this.slots.size >= 10000) throw new Error("Notion selection metadata limit exceeded")
        let step = this.slots.get(slot) ?? {}
        if (!field) step = this.snapshot(object(op.v))
        else if (field === "id" && typeof op.v === "string") {
          if (step.id && step.id !== op.v) step = {}
          step.id = op.v
        } else if (field === "type" && typeof op.v === "string") step.type = op.v
        else if (field === "model" || field === "reasoningEffort") step[field] = op.v
        else if (field === "value" && nested === "model") step.configModel = op.v
        else if (field === "value" && nested === "reasoningEffort") step.configEffort = op.v
        else if (field === "value") { const config = object(op.v); step.configModel = config.model; step.configEffort = config.reasoningEffort }
        this.slots.set(slot, step)
        this.check(step)
      }
    }
  }
}

/** HTTP 200 and the OpenAI-compatible response.model echo do not prove selection. */
export function guardInferenceResponse(response: Response, requestBody: unknown): Response {
  if (!response.ok || !response.body || typeof requestBody !== "string") return response
  const request = object(JSON.parse(requestBody))
  const config = object((Array.isArray(request.transcript) ? request.transcript : []).slice().reverse().find(value => object(value).type === "config"))
  const selection = object(config.value)
  if (typeof selection.model !== "string") throw new Error("Missing Notion model selection in inference request")
  const guard = new SelectionGuard({ model: normalizeModelName(selection.model, "default"),
    ...(typeof selection.reasoningEffort === "string" ? { reasoningEffort: selection.reasoningEffort } : {}),
    ...(typeof config.id === "string" ? { configId: config.id } : {}) })
  const decoder = new TextDecoder(); let buffer = ""
  const line = (raw: string) => {
    if (raw.length > 16 * 1024 * 1024) throw new Error("Notion inference frame limit exceeded")
    const text = raw.trim().replace(/^data:\s*/, "")
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return }
    guard.observe(parsed)
  }
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1) }
      if (buffer.length > 16 * 1024 * 1024) throw new Error("Notion inference frame limit exceeded")
      controller.enqueue(chunk)
    },
    flush() { buffer += decoder.decode(); if (buffer.trim()) line(buffer) },
  }))
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

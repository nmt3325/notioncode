import { resolveReasoningEffort } from "./effort.js"
import { UNKNOWN_NOTION_CONTEXT } from "./usage.js"
import { MODEL_CATALOG, modelReasoningEfforts, normalizeModelName, type ModelInfo } from "../vendor/notion-ai/models.js"
export const PROVIDER = "notion-ai"
export const CHAT_MODEL = "chat"
export const META_MODEL = "metadata"
export interface ModelChoice {
  /** Customer-facing OpenCode key, never a Notion routing codename. */
  id: string
  name: string
  notionModel: string
  pickable: boolean
}
function displayName(entry: ModelInfo): string {
  const name = entry.displayName
  return entry.family === "anthropic" && !/^Claude\b/i.test(name) ? `Claude ${name}` : name
}
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
}
/** Shipped Notion web-registry snapshot, not an account-entitlement API. */
export class NotionModels {
  readonly choices: ReadonlyArray<ModelChoice>
  readonly defaultModel: string
  readonly defaultName: string
  readonly defaultReasoningEffort: string | undefined
  private readonly byId: Map<string, ModelChoice>
  constructor(defaultModel = "default", includeUnlistedModels = false, defaultReasoningEffort?: string) {
    this.defaultModel = normalizeModelName(defaultModel, "default")
    this.defaultReasoningEffort = resolveReasoningEffort(this.defaultModel, defaultReasoningEffort)
    const used = new Set([CHAT_MODEL, META_MODEL])
    // Allocate before filtering so visibility toggles cannot change saved keys.
    const all = MODEL_CATALOG.map(entry => {
      let name = displayName(entry), id = slug(name)
      if (used.has(id)) {
        const effort = modelReasoningEfforts(entry.modelId)?.default
        const suffix = effort ? effort[0]!.toUpperCase() + effort.slice(1) : "Alternative"
        name = `${name} (${suffix})`; id = slug(name)
      }
      const base = id, label = name
      for (let n = 2; used.has(id); n++) { id = `${base}-${n}`; name = `${label} ${n}` }
      used.add(id)
      return { id, name, notionModel: entry.modelId, pickable: entry.pickable }
    })
    this.choices = all.filter(entry => includeUnlistedModels || entry.pickable || entry.notionModel === this.defaultModel)
    this.byId = new Map(this.choices.map(entry => [entry.id, entry]))
    this.defaultName = all.find(entry => entry.notionModel === this.defaultModel)?.name ?? "Configured model"
  }
  resolve(id: unknown): string {
    if (id === CHAT_MODEL) return this.defaultModel
    if (typeof id !== "string" || !this.byId.has(id)) throw new Error("Unknown Notion model. Select a model under Notion AI in /models; unavailable models are not silently replaced.")
    return this.byId.get(id)!.notionModel
  }
  resolveEffort(id: unknown, value?: unknown): string | undefined {
    const model = this.resolve(id)
    return resolveReasoningEffort(model, value === undefined && model === this.defaultModel ? this.defaultReasoningEffort : value)
  }
  definitions() {
    // No universal Notion context/output capacity has been verified.
    const limits = { context: UNKNOWN_NOTION_CONTEXT, output: 0 }
    const chat = (name: string, notionModel?: string) => {
      const efforts = notionModel ? modelReasoningEfforts(notionModel) : undefined
      return { name, tool_call: false, attachment: true, modalities: { input: ["text" as const, "image" as const, "pdf" as const], output: ["text" as const] }, reasoning: Boolean(efforts), limit: { ...limits },
        ...(efforts ? { options: { reasoningEffort: notionModel === this.defaultModel ? this.defaultReasoningEffort : efforts.default }, variants: Object.fromEntries(efforts.supported.map(effort => [effort, { reasoningEffort: effort }])) } : {}) }
    }
    return {
      [CHAT_MODEL]: chat(`Notion AI · Configured default (${this.defaultName})`, this.defaultModel),
      ...Object.fromEntries(this.choices.map(entry => [entry.id, chat(entry.name + (entry.pickable ? "" : " [Notion picker: unlisted]"), entry.notionModel)])),
      [META_MODEL]: { ...chat("Notion local metadata (not a chat model)"), attachment: false, reasoning: false },
    }
  }
}

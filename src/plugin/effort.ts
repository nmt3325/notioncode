import { MODEL_CATALOG, modelReasoningEfforts, normalizeReasoningEffort, type ReasoningEffort } from "../vendor/notion-ai/models.js"

/** Resolve every turn, rather than inheriting the previous turn's UI variant. */
export function resolveReasoningEffort(model: string, value: unknown): ReasoningEffort | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error("reasoningEffort must be a string")
  const requested = typeof value === "string" && value.trim().toLowerCase() === "default" ? undefined : value
  try { return normalizeReasoningEffort(model, requested) ?? modelReasoningEfforts(model)?.default }
  catch {
    const config = modelReasoningEfforts(model), entry = MODEL_CATALOG.find(item => item.modelId === model)
    if (entry && !config) throw new Error(`${entry.displayName} has no reasoning effort selector; omit reasoningEffort`)
    const supported = config ? ` Supported: ${config.supported.join(", ")}` : ""
    throw new Error(`Unsupported reasoning effort for ${entry?.displayName ?? "the selected model"}.${supported}`)
  }
}

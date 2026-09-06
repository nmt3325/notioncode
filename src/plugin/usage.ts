import { readNotionUsage, record, tokenCount, type NotionUsage } from "../vendor/notion-ai/usage.js"
export type { NotionUsage } from "../vendor/notion-ai/usage.js"

/** OpenCode uses zero as an unknown model context limit. It is NOT a measured window. */
export const UNKNOWN_NOTION_CONTEXT = 0
export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}
/**
 * The unchanged sidebar wants the latest inference's context, not the sum of
 * every internal call Notion made while executing a turn. Input includes cache
 * reads in Notion; separately reported cache creation is additional input.
 * Partial input/output pairs are not sent: pinned SDK fills missing fields with 0.
 */
export function openAIUsage(value: unknown): OpenAIUsage | undefined {
  const usage = readNotionUsage(value)
  if (!usage) return
  const last = usage.lastInference
  if (last.inputTokens === undefined || last.outputTokens === undefined) return
  if (last.cachedTokensRead !== undefined && last.cachedTokensRead > last.inputTokens) return
  const prompt = last.inputTokens + (last.cachedTokensCreated ?? 0)
  const total = prompt + last.outputTokens
  if (!tokenCount(prompt) || !tokenCount(total)) return
  return { prompt_tokens: prompt, completion_tokens: last.outputTokens, total_tokens: total,
    ...(last.cachedTokensRead !== undefined ? { prompt_tokens_details: { cached_tokens: last.cachedTokensRead } } : {}) }
}
/** Safe numeric-only extension preserves absent fields and the distinct usage scopes. */
export function usageEnvelope(value: unknown): { usage?: OpenAIUsage; notion_usage?: NotionUsage } {
  const notion_usage = readNotionUsage(value)
  if (!notion_usage) return {}
  const usage = openAIUsage(notion_usage)
  return { ...(usage ? { usage } : {}), notion_usage }
}
export function withTurnUsage<T extends object>(turn: T, value: unknown): T & { usage?: NotionUsage } {
  const usage = readNotionUsage(value)
  return { ...turn, ...(usage ? { usage } : {}) }
}
export function readTurnUsage(turn: unknown): NotionUsage | undefined {
  return record(turn) && turn.status === "complete" ? readNotionUsage(turn.usage) : undefined
}
/** Authoritative RESPONSE fields only. No registry default or text-length estimate. */
export function reportedContext(value: unknown): {
  scope: "last-inference"
  tokens?: number
  maxContextTokens?: number
  maxInputTokens?: number
  percent?: number
} | undefined {
  const usage = readNotionUsage(value)
  if (!usage) return
  const last = usage.lastInference, tokens = openAIUsage(usage)?.total_tokens
  // Notion's workflow debug UI uses maxInputTokens ahead of maxContextTokens.
  // Expose BOTH: an input budget must not be relabelled a physical model window.
  const window = last.maxInputTokens ?? last.maxContextTokens
  return { scope: "last-inference", ...(tokens !== undefined ? { tokens } : {}),
    ...(last.maxContextTokens !== undefined ? { maxContextTokens: last.maxContextTokens } : {}),
    ...(last.maxInputTokens !== undefined ? { maxInputTokens: last.maxInputTokens } : {}),
    ...(tokens !== undefined && window !== undefined ? { percent: Math.round(tokens / window * 100) } : {}) }
}

type Metadata = Record<string, Record<string, unknown>>
function metadata(body: unknown): Metadata | undefined {
  if (!record(body)) return
  const usage = readNotionUsage(body.notion_usage)
  if (!usage) return
  const wire = openAIUsage(usage)
  const cacheWrite = wire ? usage.lastInference.cachedTokensCreated : undefined
  return {
    "notion-ai": { usage, context: reportedContext(usage) },
    // OpenCode 1.18.29's documented provider-metadata compatibility path for
    // cache writes. This is a field-name adapter, not a claim of provider identity.
    // Its openai-compatible SDK otherwise silently loses the cache-write split.
    ...(cacheWrite !== undefined ? { anthropic: { cacheCreationInputTokens: cacheWrite } } : {}),
  }
}
/** Matches @ai-sdk/openai-compatible 2.0.41 MetadataExtractor, inspected at pin. */
export const notionUsageMetadataExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }): Promise<Metadata | undefined> { return metadata(parsedBody) },
  createStreamExtractor() {
    let latest: Metadata | undefined
    return {
      processChunk(chunk: unknown) { const next = metadata(chunk); if (next) latest = next },
      buildMetadata() { return latest },
    }
  },
}
/** Merge into the existing provider's options; does not change the OpenCode UI. */
export const notionUsageOptions = { includeUsage: true, metadataExtractor: notionUsageMetadataExtractor }

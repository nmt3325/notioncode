import { resolveReasoningEffort } from "./effort.js"
import { guardInferenceResponse } from "./selection.js"
import { normalizeModelName } from "../vendor/notion-ai/models.js"
import type { NotionUsage } from "./usage.js"
import { AsyncLocalStorage } from "node:async_hooks"
import { join } from "node:path"
import { NotionClient } from "../vendor/notion-ai/notion-client.js"
import type { NotionConfig } from "../vendor/notion-ai/config.js"
import type { Settings } from "./config.js"
export interface ChatInput { executionScope?: import("../shared/hub.js").ExecutionScope; prompt: string; attachments?: Array<{ base64: string; fileName: string; mimeType: string }>; conversationId: string; fresh: boolean; signal: AbortSignal; model?: string; reasoningEffort?: string; onText?: (snapshot: string) => void; onUsage?: (usage: NotionUsage) => void }
export interface ChatBackend { send(input: ChatInput): Promise<string>; interrupt(conversationId: string): Promise<void> }
export function notionConfig(s: Settings, stateDir?: string): NotionConfig {
  return {
    apiBase: ["https:", "", "app.notion.com", "api", "v3"].join("/"), defaultModel: s.model,
    requestTimeoutMs: 30 * 60 * 1000, maxWorkspaceRetries: 0, allowSessionRehydrate: true,
    defaultWebSearch: true, defaultWorkspaceSearch: true, defaultReadOnly: false,
    ...(stateDir ? { stateFilePath: join(stateDir, "notion.json"), mcpRegistryPath: join(stateDir, "mcp-registry.json") } : {}),
    account: { tokenV2: s.tokenV2, userId: s.account.user_id, userName: s.account.user_name,
      userEmail: s.account.user_email, spaceId: s.account.space_id, spaceName: s.account.space_name,
      spaceViewId: s.account.space_view_id, timezone: s.account.timezone, clientVersion: s.account.client_version },
    keepAwake: { enabled: false, autoContinue: false, idleMs: 120000, pollMs: 30000, cooldownMs: 60000, maxNudges: 1, deadlineMs: 600000, interrupt: false, maxContinues: 0, continueCooldownMs: 15000, confirmGraceMs: 10000, continuePatterns: [], stepLimitSteps: 2000 },
  }
}
export class NotionBackend implements ChatBackend {
  readonly client: NotionClient
  private readonly signal = new AsyncLocalStorage<AbortSignal | undefined>()
  constructor(private readonly config: NotionConfig, fetcher: typeof fetch = fetch) {
    const bound: typeof fetch = async (url, init) => {
      const signal = this.signal.getStore()
      const response = await fetcher(url, { ...init, redirect: "error", ...(signal ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal } : {}) })
      return String(url).endsWith("/runInferenceTranscript") ? guardInferenceResponse(response, init?.body) : response
    }
    this.client = new NotionClient(config, bound)
  }
  async send(input: ChatInput): Promise<string> {
    input.signal.throwIfAborted()
    const model = normalizeModelName(input.model, this.config.defaultModel)
    const reasoningEffort = resolveReasoningEffort(model, input.reasoningEffort)
    return this.signal.run(input.signal, async () => {
      const fileIds: string[] = []
      for (const [index, attachment] of (input.attachments ?? []).entries()) {
        const uploaded = await this.client.uploadAttachment({ ...attachment, transport: "inference_transcript", processForInference: true,
          ...(index === 0 && input.fresh ? { newConversationId: input.conversationId } : { conversationId: input.conversationId }) })
        fileIds.push(uploaded.fileId)
      }
      const result = await this.client.chat({ prompt: input.prompt, readOnly: false,
        ...(fileIds.length ? { fileIds } : {}),
        model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        ...(input.onText ? { onText: input.onText } : {}),
        ...(input.fresh && fileIds.length === 0 ? { newConversationId: input.conversationId } : { conversationId: input.conversationId }) })
      if (result.conversationId !== input.conversationId) throw new Error("Notion returned a different conversation; refusing to remap silently")
      input.signal.throwIfAborted()
      if (result.usage) input.onUsage?.(result.usage)
      return result.text
    })
  }
  withTimeout<T>(milliseconds: number, action: () => Promise<T>): Promise<T> {
    return this.signal.run(AbortSignal.timeout(milliseconds), action)
  }
  async interrupt(conversationId: string): Promise<void> { await this.withTimeout(5000, () => this.client.interruptTurn(conversationId)) }
}

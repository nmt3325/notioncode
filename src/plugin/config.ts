import { readFile, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { hash } from "./storage.js"
import { resolveReasoningEffort } from "./effort.js"
import { normalizeModelName } from "../vendor/notion-ai/models.js"
import { bundledBun, UPSTREAM } from "../config.js"
export interface PluginOptions { publicUrl?: string; accountFile?: string; spaceId?: string; model?: string; reasoningEffort?: string; stateDir?: string; runtimeDir?: string; bun?: string; port?: number; autoSetup?: boolean; includeUnlistedModels?: boolean }
export interface Settings {
  root: string; publicUrl: string; tokenV2: string; account: Record<string, string>
  model: string; reasoningEffort?: string; stateBase: string; runtimeDir: string; bun: string; port: number
  autoSetup: boolean; includeUnlistedModels: boolean; connectionName: string
}
export function outside(root: string, target: string): boolean {
  const p = relative(root, target)
  return isAbsolute(p) || p === ".." || p.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
}
// One Bun resolver for the package: the plugin re-exports the core one so the
// toolbox and the plugin can never disagree about which Bun runs.
export { bundledBun }
export async function settings(directory: string, options: PluginOptions = {}, env = process.env): Promise<Settings> {
  if (options.includeUnlistedModels !== undefined && typeof options.includeUnlistedModels !== "boolean") throw new Error("includeUnlistedModels must be a boolean")
  const root = await realpath(directory)
  if (dirname(root) === root) throw new Error("A filesystem root cannot be the execution workspace")
  const raw = options.publicUrl ?? env.OPENCODE_NOTION_MCP_URL
  if (!raw) throw new Error("Set OPENCODE_NOTION_MCP_URL to the manually configured public HTTPS /mcp endpoint")
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error("The MCP endpoint must be an HTTPS URL without credentials, query, or fragment")
  const accountPath = options.accountFile ?? env.NOTION_ACCOUNT_FILE
  let account: Record<string, string> = {}
  if (accountPath) {
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(resolve(accountPath), "utf8")) }
    catch { throw new Error("Cannot read Notion account file; check its JSON format and permissions") }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Notion account file must contain a JSON object")
    account = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  }
  const tokenV2 = (env.NOTION_TOKEN_V2 ?? account.token_v2 ?? "").trim()
  if (!tokenV2 || /[\r\n;]/.test(tokenV2)) throw new Error("Set NOTION_TOKEN_V2 or a token_v2 in NOTION_ACCOUNT_FILE; never put it in project config")
  account.space_id = options.spaceId ?? env.NOTION_SPACE_ID ?? account.space_id ?? ""
  const stateBase = resolve(options.stateDir ?? env.OPENCODE_NOTION_STATE_DIR ?? join(homedir(), ".local/state/opencode-notion"))
  const runtimeDir = resolve(options.runtimeDir ?? env.OPENCODE_MCP_RUNTIME_DIR ?? join(stateBase, "runtime", UPSTREAM.version))
  if (!outside(root, stateBase) || !outside(root, runtimeDir)) throw new Error("Plugin state and runtime must be outside the editable workspace")
  const port = options.port ?? Number(env.OPENCODE_MCP_PORT ?? 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MCP port must be between 1 and 65535")
  const model = options.model ?? env.NOTION_DEFAULT_MODEL ?? "default"
  const reasoningEffort = resolveReasoningEffort(normalizeModelName(model, "default"), options.reasoningEffort !== undefined ? options.reasoningEffort : env.NOTION_REASONING_EFFORT)
  return { root, publicUrl: url.href, tokenV2, account, stateBase, runtimeDir, model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    bun: options.bun ?? env.OPENCODE_MCP_BUN ?? bundledBun(), port, autoSetup: options.autoSetup !== false, includeUnlistedModels: options.includeUnlistedModels === true,
    connectionName: `OpenCode execution toolbox [${hash(url.href).slice(0, 10)}]` }
}

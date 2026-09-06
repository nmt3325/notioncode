import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { PACKAGE_ROOT, loadConfig, workerEnvironment } from "../config.js"
import { type PluginOptions, settings, outside } from "./config.js"
import { hash, Journal, lockWithWait, privateDirectory, readJson, saveJson } from "./storage.js"
import { NotionBackend, notionConfig, type ChatBackend } from "./notion.js"
import { NotionTransport } from "./transport.js"
import { NotionModels } from "./models.js"
import { secretRedactor } from "./redact.js"
import { connectShared, type SharedConnection } from "./shared.js"
const execute = promisify(execFile)
export async function registerConnection(manager: ReturnType<NotionBackend["client"]["mcp"]>, name: string, url: string, token: string, file: string): Promise<void> {
  const record = await readJson<{ id?: string; credentialHash?: string }>(file, {})
  const all = await manager.list()
  let matches = all.filter(item => item.linked && item.name === name)
  if (record.id) {
    const saved = all.find(item => item.id === record.id && item.linked)
    if (saved && saved.name !== name) throw new Error("Saved MCP connection ownership changed; refusing to modify an unrelated connection")
    if (saved) matches = [saved]
  }
  if (matches.length > 1) throw new Error("Multiple plugin-owned MCP connections found; resolve duplicates before starting")
  const existing = matches[0], credentialHash = hash(token)
  const policy = { runReadToolsAutomatically: true, runWriteToolsAutomatically: true }
  let id: string
  if (existing) {
    const status = await manager.status(existing.id)
    if (existing.serverUrl !== url || status.status !== "connected" || record.credentialHash !== credentialHash) {
      await manager.update(existing.id, { serverUrl: url, auth: { type: "bearer", token }, transport: "streamableHttp", enabledToolNames: null, ...policy })
    } else if (!existing.runReadToolsAutomatically || !existing.runWriteToolsAutomatically || existing.enabledToolNames !== null) {
      await manager.update(existing.id, { enabledToolNames: null, ...policy })
    }
    id = existing.id
  } else {
    if (all.some(item => item.linked && item.serverUrl === url)) throw new Error("This URL is already registered under another connection. Reuse or explicitly migrate that connection; the plugin will not take over its permissions or create a project-specific replacement")
    id = (await manager.add({ name, serverUrl: url, auth: { type: "bearer", token }, transport: "streamableHttp", ...policy })).id
  }
  await saveJson(file, { id, credentialHash })
}
async function prepared(runtimeDir: string): Promise<boolean> {
  for (const name of ["entry.ts", "native-worker.ts"]) {
    try { if (!(await readFile(join(runtimeDir, "packages/opencode/.mcp-toolbox", name))).equals(await readFile(join(PACKAGE_ROOT, "runtime", name)))) return false }
    catch { return false }
  }
  return true
}
export async function startRuntime(directory: string, options: PluginOptions = {}, backendFactory = (config: ReturnType<typeof notionConfig>) => new NotionBackend(config)) {
  const s = await settings(directory, options)
  await privateDirectory(s.stateBase)
  if (!outside(s.root, await realpath(s.stateBase))) throw new Error("State directory resolves inside the workspace")
  let shared: SharedConnection | undefined
  const redact = secretRedactor(() => [s.tokenV2, shared?.service.mcpToken ?? "", shared?.service.controlToken ?? ""])
  try {
    const probe = backendFactory(notionConfig(s)), account = await probe.withTimeout(30000, () => probe.client.account())
    const stateDir = join(s.stateBase, "accounts", hash(`${s.root}\0${account.userId}\0${account.spaceId}`))
    await privateDirectory(stateDir)
    const config = loadConfig({ OPENCODE_MCP_ROOT: s.root, OPENCODE_MCP_RUNTIME_DIR: s.runtimeDir,
      OPENCODE_MCP_STATE_DIR: join(s.stateBase, "setup-worker"), OPENCODE_MCP_BUN: s.bun,
      OPENCODE_MCP_PORT: String(s.port),
      OPENCODE_MCP_PERMISSIONS: JSON.stringify({ "*": "allow", read: "allow", glob: "allow", grep: "allow", edit: "allow", bash: "allow", webfetch: "allow", todowrite: "allow" }) })
    if (!await prepared(s.runtimeDir)) {
      if (!s.autoSetup) throw new Error("Native runtime needs setup; enable autoSetup or run npm run setup:native")
      const releaseSetup = await lockWithWait(join(s.stateBase, "setup", `${hash(s.runtimeDir)}.lock`), 16 * 60 * 1000)
      try {
        if (!await prepared(s.runtimeDir)) {
          for (const dir of ["", "home", "home/tmp", "home/cache"]) await privateDirectory(join(config.stateDir, dir))
          await execute(s.bun, [join(PACKAGE_ROOT, "scripts/setup-native.mjs")], { cwd: PACKAGE_ROOT,
            env: { ...workerEnvironment(config), OPENCODE_MCP_BUN: s.bun, OPENCODE_MCP_RUNTIME_DIR: s.runtimeDir }, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 })
        }
      } finally { await releaseSetup() }
    }
    shared = await connectShared(s, config)
    const remote = shared
    const connectionFile = join(remote.directory, "connections", `${hash(account.userId)}.json`)
    const releaseRegistration = await lockWithWait(`${connectionFile}.lock`)
    try { await probe.withTimeout(60000, () => registerConnection(probe.client.mcp(), s.connectionName, s.publicUrl, remote.service.mcpToken, connectionFile)) }
    finally { await releaseRegistration() }
    const journal = new Journal(join(stateDir, "conversations.json"), { split: true }); await journal.load()
    const backends = new Map<string, Promise<NotionBackend>>()
    const backendFor = (conversationId: string) => {
      let pending = backends.get(conversationId)
      if (!pending) {
        pending = (async () => {
          const threadDir = join(stateDir, "threads", hash(conversationId)); await privateDirectory(threadDir)
          const config = notionConfig(s, threadDir); config.account = { ...account }
          return backendFactory(config)
        })()
        backends.set(conversationId, pending)
      }
      return pending
    }
    const backend: ChatBackend = {
      send: async input => (await backendFor(input.conversationId)).send(input),
      interrupt: async conversationId => (await backendFor(conversationId)).interrupt(conversationId),
    }
    const transport = new NotionTransport(backend, journal,
      `This conversation is displayed in OpenCode. You own reasoning and tool selection; OpenCode only displays your answer. Local work uses the ONE shared execution MCP connection named ${JSON.stringify(s.connectionName)}. Never register a project-specific connection. Native tool inputs are nested under arguments.`,
      redact, async () => {}, new NotionModels(s.model, s.includeUnlistedModels, s.reasoningEffort), {
        begin: async (_session, _message, conversationId) => {
          const scope = await remote.begin(conversationId, randomUUID())
          return { scope, context: `Execution scope for THIS turn: ${JSON.stringify(scope)}. Supply these exact env_id, thread_id and turn_id fields on EVERY call to the shared MCP, including job/permission controls. The environment is ${JSON.stringify(s.root)}. Do not use a previous turn's or another thread's scope. Different threads can edit different files concurrently. Work on the same file must be coordinated explicitly.` }
        },
        end: scope => remote.end(scope),
      })
    const unobserve = remote.observe(event => transport.observeExecution(event), error => transport.abort(error))
    let closed = false
    return { transport, shared: remote, close: async () => {
      if (closed) return; closed = true
      try { await transport.close() } finally { unobserve(); await remote.close() }
    } }
  } catch (error) {
    await shared?.close().catch(() => {})
    throw new Error(redact(error instanceof Error ? error.message : String(error)))
  }
}

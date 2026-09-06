import { spawn } from "node:child_process"
import { open, readFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { PACKAGE_ROOT, workerEnvironment, type BridgeConfig } from "../config.js"
import type { ExecutionEvent } from "../opencodeClient.js"
import type { ExecutionScope } from "../shared/hub.js"
import type { DaemonConfig } from "../shared/daemon.js"
import type { Settings } from "./config.js"
import { hash, lockWithWait, mcpSecret, privateDirectory, readJson, saveJson } from "./storage.js"
async function rpc<T>(port: number, token: string, input: Record<string, unknown>, milliseconds = 65000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${port}/control`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(milliseconds),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(input) })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Shared execution control request failed")
  return body
}
/** Node reports an unreachable socket through `cause.code`, Bun through its own code and message. */
export function unreachable(error: unknown): boolean {
  const value = error as { code?: string; message?: string; cause?: { code?: string } }
  const codes = [value?.code, value?.cause?.code].filter((code): code is string => typeof code === "string")
  if (codes.some(code => ["ECONNREFUSED", "ConnectionRefused", "ECONNRESET", "ConnectionClosed", "ERR_SOCKET_CLOSED"].includes(code))) return true
  return /ECONNREFUSED|ConnectionRefused|Unable to connect|fetch failed|socket connection was closed/i.test(String(value?.message ?? ""))
}
async function probe(config: Pick<DaemonConfig, "port" | "controlToken">): Promise<{ identity: string; protocol: number } | undefined> {
  try { return await rpc(config.port, config.controlToken, { op: "status" }, 1500) }
  catch (error) {
    if (unreachable(error)) return undefined
    throw error
  }
}
export class SharedConnection {
  readonly ownerId = randomUUID()
  readonly envId: string
  private cursor = 0
  private polling?: Promise<void>
  private timer?: NodeJS.Timeout
  private closed = false
  private failure?: Error
  private listeners = new Set<(event: ExecutionEvent) => void>()
  private failListeners = new Set<(error: Error) => void>()
  private unfenced = new Set<string>()
  constructor(readonly directory: string, readonly service: DaemonConfig, root: string) { this.envId = `env-${hash(root).slice(0, 24)}` }
  async claim(root: string): Promise<void> {
    await rpc(this.service.port, this.service.controlToken, { op: "claim", owner_id: this.ownerId, env_id: this.envId, root })
    this.timer = setInterval(() => { void this.poll().catch(error => this.fail(error)) }, 200)
    this.timer.unref()
  }
  observe(listener: (event: ExecutionEvent) => void, failure?: (error: Error) => void): () => void {
    this.listeners.add(listener); if (failure) this.failListeners.add(failure)
    return () => { this.listeners.delete(listener); if (failure) this.failListeners.delete(failure) }
  }
  private fail(error: unknown): void {
    if (this.closed || this.failure) return
    this.failure = error instanceof Error ? error : new Error("Shared execution event stream failed")
    clearInterval(this.timer)
    for (const listener of this.failListeners) listener(this.failure)
  }
  private poll(): Promise<void> {
    if (this.polling) return this.polling
    if (this.closed) return Promise.resolve()
    const pending = rpc<{ events: Array<{ sequence: number; event: ExecutionEvent }>; cursor: number; latest: number }>(this.service.port, this.service.controlToken,
      { op: "events", owner_id: this.ownerId, cursor: this.cursor }, 15000).then(result => {
        for (const { event } of result.events) for (const listener of this.listeners) listener(event)
        this.cursor = result.cursor
      })
    this.polling = pending.finally(() => { this.polling = undefined })
    return this.polling
  }
  async begin(threadId: string, turnId: string): Promise<ExecutionScope> {
    if (this.closed || this.failure) throw this.failure ?? new Error("Shared execution client is closed")
    // An ambiguous begin/end may have been applied. Fence that thread first so a
    // lost response cannot strand it, without disturbing any other thread.
    if (this.unfenced.has(threadId)) {
      await rpc(this.service.port, this.service.controlToken, { op: "fence", owner_id: this.ownerId, env_id: this.envId, thread_id: threadId })
      this.unfenced.delete(threadId)
    }
    const scope = { env_id: this.envId, thread_id: threadId, turn_id: turnId }
    try { await rpc(this.service.port, this.service.controlToken, { op: "begin", owner_id: this.ownerId, ...scope }) }
    catch (error) { this.unfenced.add(threadId); throw error }
    return scope
  }
  async end(scope: ExecutionScope): Promise<void> {
    let result: { sequence: number }
    try { result = await rpc(this.service.port, this.service.controlToken, { op: "end", owner_id: this.ownerId, ...scope }) }
    catch (error) { this.unfenced.add(scope.thread_id); throw error }
    while (this.cursor < result.sequence) await this.poll()
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer)
    await this.polling?.catch(() => {})
    await rpc(this.service.port, this.service.controlToken, { op: "release", owner_id: this.ownerId })
  }
  async stopIfUnused(): Promise<void> {
    // The service can drop the connection while it is shutting down, so the
    // outcome is confirmed by probing rather than by the response itself.
    try { await rpc(this.service.port, this.service.controlToken, { op: "shutdown" }) }
    catch (error) { if (!unreachable(error)) throw error }
    for (let i = 0; i < 100; i++) { if (!await probe(this.service)) return; await delay(50) }
    throw new Error("Shared service shutdown did not complete")
  }
}
/** Startup failures are only actionable with the daemon's own output. */
async function logTail(file: string): Promise<string> {
  try { const text = (await readFile(file, "utf8")).trim(); return text ? `: ${text.slice(-400).replace(/\s+/g, " ")}` : "" }
  catch { return "" }
}
export async function connectShared(s: Settings, initialConfig: BridgeConfig): Promise<SharedConnection> {
  const directory = join(s.stateBase, "shared", hash(s.publicUrl))
  await privateDirectory(directory)
  const release = await lockWithWait(join(directory, "startup.lock"))
  let remote: SharedConnection | undefined
  try {
    const mcpToken = await mcpSecret(join(directory, "execution-secret.json"))
    const controlToken = await mcpSecret(join(directory, "control-secret.json"))
    const parts = await Promise.all(["dist/shared/daemon.js", "dist/shared/hub.js", "dist/shared/server.js", "dist/config.js", "dist/opencodeClient.js", "runtime/native-worker.ts", "package.json"].map(file => readFile(join(PACKAGE_ROOT, file))))
    // The published catalog depends on the language-server setting, so a daemon
    // started with a different one must not be reused for this connection.
    const identity = hash(JSON.stringify({ code: parts.map(part => hash(part.toString("utf8"))), publicUrl: s.publicUrl, runtimeDir: s.runtimeDir, bun: s.bun, port: s.port, lsp: s.lsp }))
    const config: DaemonConfig = { mcpToken, controlToken, identity, port: s.port,
      bridge: { ...initialConfig, mcpToken, stateDir: join(directory, "execution") } }
    const file = join(directory, "daemon.json"), stored = await readJson<DaemonConfig | undefined>(file, undefined)
    const live = stored ? await probe(stored) : undefined
    if (live && (live.protocol !== 1 || live.identity !== identity)) throw new Error("A different shared MCP runtime is already using this URL. Close its clients and restart it before changing the runtime, port or package version")
    if (!live) {
      await saveJson(file, config)
      const processState = join(directory, "process")
      for (const sub of ["", "home", "home/tmp", "home/cache"]) await privateDirectory(join(processState, sub))
      const log = await open(join(directory, "daemon.log"), "a", 0o600)
      // process.execPath is the compiled opencode executable inside the host, and handing
      // it a script path only prints the OpenCode CLI help, so use the resolved runtime.
      const child = spawn(s.bun, [join(PACKAGE_ROOT, "dist/shared/daemon.js"), file], {
        cwd: PACKAGE_ROOT, detached: true, stdio: ["ignore", log.fd, log.fd],
        env: workerEnvironment({ ...config.bridge, stateDir: processState }),
      })
      let spawnError: Error | undefined, exited = false
      child.on("error", error => { spawnError = error }); child.on("exit", () => { exited = true }); child.unref(); await log.close()
      try {
        let ready = false
        for (let i = 0; i < 180; i++) {
          if (spawnError || exited || child.exitCode !== null) throw new Error(`Shared MCP daemon failed to start; verify the pinned native runtime${await logTail(join(directory, "daemon.log"))}`)
          // A daemon that is still binding its port can refuse or drop the probe;
          // only its exit or the overall budget counts as a startup failure.
          const status = await probe(config).catch(() => undefined)
          if (status) { if (status.identity !== identity || status.protocol !== 1) throw new Error("Shared MCP identity mismatch"); ready = true; break }
          await delay(250)
        }
        if (!ready) throw new Error(`Shared MCP startup timed out; no Notion inference was sent${await logTail(join(directory, "daemon.log"))}`)
      } catch (error) { child.kill("SIGTERM"); throw error }
    }
    remote = new SharedConnection(directory, stored && live ? stored : config, s.root)
    await remote.claim(s.root)
    return remote
  } catch (error) { await remote?.close().catch(() => {}); throw error }
  finally { await release() }
}

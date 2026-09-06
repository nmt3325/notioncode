import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, unlink, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { readFileSync, unlinkSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
export const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o077)) throw new Error("Plugin state directory must have mode 0700")
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw new Error("Cannot read plugin state; refusing to silently reset conversation mappings") }
}
export async function saveJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path))
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, "wx", 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temp, path)
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  } catch (error) { await unlink(temp).catch(() => {}); throw error }
}
const heldLocks = new Map<string, string>()
const onExit = () => { for (const [path, nonce] of heldLocks) { try { if (JSON.parse(readFileSync(path, "utf8")).nonce === nonce) unlinkSync(path) } catch {} } }
export async function exclusiveLock(path: string): Promise<() => Promise<void>> {
  await privateDirectory(dirname(path))
  const nonce = randomUUID()
  let file
  try { file = await open(path, "wx", 0o600) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Object.assign(new Error(`Another plugin owns this workspace/endpoint/thread. If it crashed, verify that no OpenCode process is running before removing the lock: ${path}`), { code: "EEXIST" })
    throw error
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.sync() } finally { await file.close() }
  if (!heldLocks.size) process.once("exit", onExit)
  heldLocks.set(path, nonce)
  return async () => {
    try { const owner = await readJson<{ nonce?: string }>(path, {}); if (owner.nonce === nonce) await unlink(path) }
    finally { if (heldLocks.get(path) === nonce) heldLocks.delete(path); if (!heldLocks.size) process.off("exit", onExit) }
  }
}
/** Wait only for a short-lived setup/registration lock; never steal stale locks. */
export async function lockWithWait(path: string, milliseconds = 90000): Promise<() => Promise<void>> {
  const deadline = Date.now() + milliseconds
  while (true) {
    try { return await exclusiveLock(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error; await delay(50) }
  }
}
export async function mcpSecret(path: string): Promise<string> {
  let value = await readJson<{ token?: string }>(path, {})
  if (!value.token) { value = { token: randomBytes(32).toString("hex") }; await saveJson(path, value) }
  if (typeof value.token !== "string" || value.token.length < 32) throw new Error("Invalid execution MCP credential")
  return value.token
}
export interface Turn { promptHash: string; model?: string; conversationId: string; status: "sending" | "complete" | "uncertain" | "interrupted"; text?: string }
export interface ConversationState { conversationId: string; turns: Record<string, Turn> }
export interface JournalData { version: 1; sessions: Record<string, ConversationState> }
const validId = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !["__proto__", "prototype", "constructor"].includes(id)
function validate(data: JournalData): void {
  if (!data || data.version !== 1 || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) throw new Error("Unsupported conversation journal")
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  for (const [id, session] of Object.entries(data.sessions)) {
    if (!validId(id) || !record(session) || typeof session.conversationId !== "string" || !record(session.turns)) throw new Error("Corrupt conversation journal")
    for (const [message, turn] of Object.entries(session.turns)) {
      if (!validId(message) || !record(turn) || (turn.model !== undefined && (typeof turn.model !== "string" || !turn.model.trim() || turn.model.length > 256)) || turn.conversationId !== session.conversationId || typeof turn.promptHash !== "string" || !/^[a-f0-9]{64}$/.test(turn.promptHash) || !["sending", "complete", "uncertain", "interrupted"].includes(String(turn.status)) || (turn.status === "complete" && typeof turn.text !== "string")) throw new Error("Corrupt conversation turn")
    }
  }
}
export class Journal {
  data: JournalData = { version: 1, sessions: {} }
  private writes: Promise<void> = Promise.resolve()
  constructor(readonly path: string, private readonly options: { split?: boolean } = {}) {}
  async load(): Promise<void> { const data = await readJson<JournalData>(this.path, this.data); validate(data); this.data = data }
  private sessionPath(session: string): string { return join(`${this.path}.d`, `${hash(session)}.json`) }
  async acquire(session: string): Promise<() => Promise<void>> {
    if (!validId(session)) throw new Error("Invalid journal session")
    if (!this.options.split) return async () => {}
    const release = await exclusiveLock(`${this.sessionPath(session)}.lock`)
    try {
      const legacy = this.data.sessions[session]
      const data = await readJson<JournalData>(this.sessionPath(session), { version: 1, sessions: legacy ? { [session]: legacy } : {} })
      validate(data)
      if (Object.keys(data.sessions).some(id => id !== session)) throw new Error("Journal shard belongs to another thread")
      if (data.sessions[session]) this.data.sessions[session] = data.sessions[session]
      else delete this.data.sessions[session]
      return release
    } catch (error) { await release(); throw error }
  }
  async save(session?: string): Promise<void> {
    if (this.options.split) {
      if (!session || !validId(session) || !this.data.sessions[session]) throw new Error("A thread is required when saving a sharded journal")
      await saveJson(this.sessionPath(session), structuredClone({ version: 1, sessions: { [session]: this.data.sessions[session] } }))
      return
    }
    const snapshot = structuredClone(this.data)
    const write = this.writes.catch(() => {}).then(() => saveJson(this.path, snapshot))
    this.writes = write
    await write
  }
}

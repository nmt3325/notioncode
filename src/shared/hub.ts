import { realpath, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import type { BridgeConfig } from "../config.js"
import { OpencodeClient, type ExecutionEvent } from "../opencodeClient.js"
import { isTerminal, type JobView, type NativeTool } from "../protocol.js"
import { displayValue } from "../plugin/redact.js"

/** Routing identifiers, not independent authentication principals. */
export interface ExecutionScope { env_id: string; thread_id: string; turn_id: string }
export const validScopeId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id)
export function parseScope(value: Record<string, unknown>): ExecutionScope {
  for (const key of ["env_id", "thread_id", "turn_id"] as const) if (!validScopeId(value[key])) throw new Error(`Missing or invalid ${key}; every shared MCP call must specify its execution scope`)
  return { env_id: value.env_id as string, thread_id: value.thread_id as string, turn_id: value.turn_id as string }
}
export const scopeKey = (scope: ExecutionScope) => JSON.stringify([scope.env_id, scope.thread_id, scope.turn_id])
const threadKey = (scope: Pick<ExecutionScope, "env_id" | "thread_id">) => JSON.stringify([scope.env_id, scope.thread_id])
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
interface Owner { env: string; touched: number; sequence: number; events: Array<{ sequence: number; event: ExecutionEvent }>; bytes: number; dropped: number; latestByJob: Map<string, number>; releasing?: Promise<void>; released?: boolean }
interface Thread {
  owner: string; env: string; id: string; client: OpencodeClient; ready: Promise<void>
  touched: number; active?: string; closing?: Promise<void>; faulted: boolean; used: Set<string>; turns: Map<string, string>; unobserve: () => void
}
export interface HubLimits { maxThreads: number; maxConcurrent: number; ownerLeaseMs: number; threadIdleMs: number }
export class ExecutionHub {
  private environments = new Map<string, string>()
  private owners = new Map<string, Owner>()
  private threads = new Map<string, Thread>()
  private retired = new Map<string, Set<string>>()
  private catalog?: OpencodeClient
  private closing = false
  constructor(readonly config: BridgeConfig, readonly limits: HubLimits = { maxThreads: 32, maxConcurrent: 32, ownerLeaseMs: 60000, threadIdleMs: 15 * 60 * 1000 },
    private readonly factory = (config: BridgeConfig) => new OpencodeClient(config, () => {})) {}
  async start(): Promise<void> {
    const catalog = this.factory({ ...this.config, stateDir: join(this.config.stateDir, "catalog") })
    this.catalog = catalog
    try { await catalog.start() } catch (error) { await catalog.stop(); throw error }
  }
  tools(): NativeTool[] { if (!this.catalog) throw new Error("Shared toolbox is not ready"); return this.catalog.tools() }
  info(): Record<string, unknown> { return { ...this.catalog?.info(), shared: true, scopes_required: ["env_id", "thread_id", "turn_id"], owner_count: this.owners.size, thread_count: this.threads.size, limits: this.limits } }
  get ownerCount(): number { return this.owners.size }
  private owner(id: string): Owner {
    const owner = this.owners.get(id)
    if (!owner || owner.released || this.closing) throw new Error("Unknown or expired execution owner; reconnect explicitly")
    owner.touched = Date.now()
    return owner
  }
  async claim(ownerId: string, envId: string, root: string): Promise<void> {
    if (this.closing || !validScopeId(ownerId) || !validScopeId(envId) || typeof root !== "string") throw new Error("Invalid environment registration")
    const canonical = await realpath(root)
    if (dirname(canonical) === canonical || !(await stat(canonical)).isDirectory()) throw new Error("Invalid environment root")
    if (this.closing) throw new Error("Shared execution is stopping")
    const existing = this.environments.get(envId)
    if (existing && existing !== canonical) throw new Error("An environment cannot be rebound to another directory")
    const owner = this.owners.get(ownerId)
    if (owner?.released) throw new Error("Execution owner is closing")
    if (owner && owner.env !== envId) throw new Error("An owner cannot be rebound to another environment")
    if (!existing && this.environments.size >= 128) throw new Error("Environment limit reached")
    if (!owner && this.owners.size >= 128) throw new Error("Owner limit reached")
    this.environments.set(envId, canonical)
    if (owner) owner.touched = Date.now()
    else this.owners.set(ownerId, { env: envId, touched: Date.now(), sequence: 0, events: [], bytes: 0, dropped: 0, latestByJob: new Map() })
  }
  private emit(thread: Thread, event: ExecutionEvent): void {
    const owner = this.owners.get(thread.owner)
    if (!owner) return
    const turn = thread.turns.get(event.job.job_id) ?? (event.type === "start" ? thread.active : undefined)
    if (!turn) return
    thread.turns.set(event.job.job_id, turn)
    const scope = { env_id: thread.env, thread_id: thread.id, turn_id: turn }
    const bounded = displayValue(event, text => text) as unknown as ExecutionEvent
    const item = { sequence: ++owner.sequence, event: { ...bounded, scope } }
    const key = `${thread.id}\0${event.job.job_id}`
    owner.events.push(item); owner.bytes += Buffer.byteLength(JSON.stringify(item)); owner.latestByJob.set(key, item.sequence)
    while (owner.latestByJob.size > 4096) owner.latestByJob.delete(owner.latestByJob.keys().next().value!)
    thread.touched = Date.now()
    while (owner.events.length > 2048 || owner.bytes > 8 * 1024 * 1024) {
      // Prefer discarding progress a later event already superseded. That is not
      // a history gap, so one noisy thread cannot blank another thread display.
      let index = owner.events.findIndex(entry => entry.event.type === "update" && !isTerminal(entry.event.job.status) &&
        owner.latestByJob.get(`${entry.event.scope?.thread_id}\0${entry.event.job.job_id}`) !== entry.sequence)
      const superseded = index >= 0
      if (!superseded) index = 0
      const [removed] = owner.events.splice(index, 1)
      owner.bytes -= Buffer.byteLength(JSON.stringify(removed))
      if (!superseded) owner.dropped = removed!.sequence
    }
  }
  async begin(ownerId: string, scope: ExecutionScope): Promise<void> {
    parseScope(scope as unknown as Record<string, unknown>)
    const owner = this.owner(ownerId)
    if (owner.env !== scope.env_id) throw new Error("Scope does not belong to this environment owner")
    const key = threadKey(scope)
    let thread = this.threads.get(key)
    if (thread && thread.owner !== ownerId) throw new Error("Another AI owns this thread; a thread has exactly one owner")
    if (!thread) {
      if (this.threads.size >= this.limits.maxThreads) throw new Error("Shared thread limit reached; idle threads are reclaimed automatically, so retry shortly")
      const root = this.environments.get(scope.env_id)!
      const client = this.factory({ ...this.config, root, stateDir: join(this.config.stateDir, "threads", hash(key)) })
      thread = { owner: ownerId, env: scope.env_id, id: scope.thread_id, client, ready: Promise.resolve(), faulted: false, touched: Date.now(), used: new Set(this.retired.get(key) ?? []), turns: new Map(), unobserve: () => {} }
      this.threads.set(key, thread); this.retired.delete(key)
      const current = thread
      current.unobserve = client.observe(event => this.emit(current, event))
      current.ready = client.start().catch(async error => { current.faulted = true; await client.stop(); throw error })
    }
    if (thread.faulted || thread.closing) throw new Error("Thread execution is unavailable; inspect its previous work before reconnecting")
    if (thread.active && thread.active !== scope.turn_id) throw new Error("Another turn is active in this thread")
    if (!thread.active && thread.used.has(scope.turn_id)) throw new Error("This execution turn already ended; it cannot be reopened or replayed")
    if (thread.used.size >= 10000 && !thread.used.has(scope.turn_id)) throw new Error("Thread turn limit reached; start a new thread")
    thread.active = scope.turn_id; thread.used.add(scope.turn_id); thread.touched = Date.now()
    await thread.ready
    if (this.threads.get(key) !== thread || !this.owners.has(ownerId) || thread.active !== scope.turn_id) throw new Error("Thread was closed during startup")
  }
  private thread(scope: ExecutionScope, active = false): Thread {
    parseScope(scope as unknown as Record<string, unknown>)
    const thread = this.threads.get(threadKey(scope))
    if (this.closing || !thread || thread.faulted) throw new Error("Unknown or unavailable execution thread")
    if (!thread.used.has(scope.turn_id)) throw new Error("Unknown execution turn")
    if (active && (thread.active !== scope.turn_id || thread.closing)) throw new Error("Execution turn is not active; late or cancelled requests are refused")
    thread.touched = Date.now()
    return thread
  }
  private jobThread(scope: ExecutionScope, id: string): Thread {
    const thread = this.thread(scope)
    if (thread.turns.get(id) !== scope.turn_id) throw new Error("Job does not belong to the requested environment/thread/turn")
    return thread
  }
  scopeInfo(scope: ExecutionScope): Record<string, unknown> { return { ...this.thread(scope).client.info(), scope } }
  private view(scope: ExecutionScope, job: JobView): JobView & { scope: ExecutionScope } { return { ...job, scope } }
  startJob(scope: ExecutionScope, tool: string, args: Record<string, unknown>): string {
    const thread = this.thread(scope, true)
    const running = [...this.threads.values()].reduce((n, item) => n + item.client.list().filter(job => !isTerminal(job.status)).length, 0)
    if (running >= this.limits.maxConcurrent) throw new Error("Shared execution concurrency limit reached; wait for existing jobs")
    const id = thread.client.startJob(tool, args)
    thread.turns.set(id, scope.turn_id)
    const retained = new Set(thread.client.list().map(job => job.job_id))
    for (const old of thread.turns.keys()) if (!retained.has(old)) thread.turns.delete(old)
    return id
  }
  list(scope: ExecutionScope): Array<JobView & { scope: ExecutionScope }> {
    const thread = this.thread(scope)
    return thread.client.list().filter(job => thread.turns.get(job.job_id) === scope.turn_id).map(job => this.view(scope, job))
  }
  async wait(scope: ExecutionScope, id: string, milliseconds: number) { return this.view(scope, await this.jobThread(scope, id).client.wait(id, milliseconds)) }
  cancel(scope: ExecutionScope, id: string) { return this.view(scope, this.jobThread(scope, id).client.cancel(id)) }
  async reply(scope: ExecutionScope, id: string, permission: string, reply: "once" | "reject") { await this.jobThread(scope, id).client.reply(id, permission, reply) }
  async end(ownerId: string, scope: ExecutionScope): Promise<number> {
    const owner = this.owner(ownerId), thread = this.thread(scope)
    if (thread.owner !== ownerId) throw new Error("Thread belongs to another owner")
    if (thread.active && thread.active !== scope.turn_id) throw new Error("Cannot end another active turn")
    if (thread.closing) { await thread.closing; return owner.sequence }
    if (!thread.active) return owner.sequence
    thread.active = undefined
    const drain = async () => {
      const pending = this.list(scope).filter(job => !isTerminal(job.status))
      for (const job of pending) this.cancel(scope, job.job_id)
      await Promise.all(pending.map(job => thread.client.wait(job.job_id, 5000)))
      if (thread.client.list().some(job => !isTerminal(job.status))) {
        thread.faulted = true
        await thread.client.stop()
        throw new Error("Thread cancellation was not acknowledged; this thread is quarantined, other threads remain available")
      }
    }
    thread.closing = drain()
    try { await thread.closing } finally { thread.closing = undefined }
    return owner.sequence
  }
  events(ownerId: string, cursor: number) {
    const owner = this.owner(ownerId)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > owner.sequence) throw new Error("Invalid event cursor")
    // A display-history gap is reported, never thrown: losing one thread progress
    // must not abort unrelated conversations. No execution is ever retried.
    const gap = cursor < owner.dropped
    const events = owner.events.filter(item => item.sequence > cursor).slice(0, 128)
    return { events, cursor: events.at(-1)?.sequence ?? Math.max(cursor, owner.dropped), latest: owner.sequence, gap }
  }
  /** End whichever turn this owner left active, without knowing its turn ID. */
  async fence(ownerId: string, scope: Pick<ExecutionScope, "env_id" | "thread_id">): Promise<number> {
    const owner = this.owner(ownerId), thread = this.threads.get(threadKey(scope))
    if (!thread) return owner.sequence
    if (thread.owner !== ownerId) throw new Error("Thread belongs to another owner")
    if (thread.faulted) return owner.sequence
    if (thread.closing) { await thread.closing; return owner.sequence }
    if (!thread.active) return owner.sequence
    return this.end(ownerId, { ...scope, turn_id: thread.active })
  }
  private remember(key: string, thread: Thread): void {
    // Retain used turn IDs so a reclaimed thread still refuses a replayed turn.
    const retired = this.retired.get(key) ?? new Set<string>()
    for (const turn of thread.used) retired.add(turn)
    while (retired.size > 10000) retired.delete(retired.values().next().value!)
    this.retired.delete(key); this.retired.set(key, retired)
    while (this.retired.size > 64) this.retired.delete(this.retired.keys().next().value!)
  }
  /** Reclaim an idle thread worker without losing its replay fences. */
  private async evict(key: string, thread: Thread): Promise<void> {
    if (this.threads.get(key) !== thread || thread.active || thread.closing) return
    this.threads.delete(key); this.remember(key, thread)
    await thread.ready.catch(() => {}); await thread.client.stop(); thread.unobserve()
  }
  async release(ownerId: string): Promise<void> {
    const owner = this.owners.get(ownerId)
    if (!owner) return
    if (owner.releasing) return owner.releasing
    owner.released = true // fence new thread claims before the first await
    const owned = [...this.threads.entries()].filter(([, thread]) => thread.owner === ownerId)
    for (const [, thread] of owned) { thread.active = undefined; thread.faulted = true }
    owner.releasing = (async () => {
      await Promise.allSettled(owned.map(async ([key, thread]) => {
        await thread.ready.catch(() => {}); await thread.client.stop(); thread.unobserve()
        if (this.threads.get(key) === thread) this.threads.delete(key)
        this.remember(key, thread)
      }))
      if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId)
    })()
    await owner.releasing
  }
  async reap(now = Date.now()): Promise<void> {
    await Promise.all([...this.owners].filter(([, owner]) => now - owner.touched > this.limits.ownerLeaseMs).map(([id]) => this.release(id)))
    await Promise.all([...this.threads].filter(([, thread]) => !thread.active && !thread.closing && now - thread.touched > this.limits.threadIdleMs)
      .map(([key, thread]) => this.evict(key, thread)))
  }
  async stop(): Promise<void> {
    this.closing = true
    await Promise.all([...this.owners.keys()].map(id => this.release(id)))
    await this.catalog?.stop()
  }
}

import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import type { BridgeConfig } from "../config.js"
import { ExecutionHub } from "./hub.js"
import { runSharedHttp, type SharedServerOptions } from "./server.js"
export interface DaemonConfig extends SharedServerOptions { bridge: BridgeConfig }
async function main() {
  const path = process.argv[2]
  if (!path) throw new Error("A private shared-service configuration file is required")
  const config = JSON.parse(await readFile(path, "utf8")) as DaemonConfig
  const hub = new ExecutionHub(config.bridge)
  await hub.start()
  const service = await runSharedHttp(hub, config)
  let stopping = false
  const stop = () => { if (!stopping) { stopping = true; void service.close() } }
  process.once("SIGTERM", stop); process.once("SIGINT", stop)
  await service.closed
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), () => { console.error("Shared execution service failed to start or stop; inspect the runtime configuration"); process.exit(1) })
}

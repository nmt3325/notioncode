import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { NativeTool } from "./protocol.js"
import { NATIVE_TOOL_IDS, OPTIONAL_NATIVE_TOOL_IDS } from "./config.js"

// Descriptions AND schemas come from ToolJsonSchema.fromTool(upstreamDef).
// This module contains no filesystem, replacement, regex, HTTP-fetch or shell
// implementation. There is intentionally no mirrored schema or local fallback.
export function nativeCatalog(tools: NativeTool[]): Tool[] {
  const allowed = new Set<string>(NATIVE_TOOL_IDS)
  const optional = new Set<string>(OPTIONAL_NATIVE_TOOL_IDS)
  const published = new Set(tools.map((tool) => tool.name))
  // Unknown or duplicated tools still fail closed. Only an optional tool may be
  // missing, and only because its execution context is switched off.
  if (published.size !== tools.length || tools.some((tool) => !allowed.has(tool.name)) || NATIVE_TOOL_IDS.some((id) => !optional.has(id) && !published.has(id))) {
    throw new Error("Native tool catalog does not match the pinned execution-only allowlist")
  }
  return tools.map((tool) => ({
    ...tool,
    annotations: {
      readOnlyHint: ["read", "glob", "grep", "webfetch", "lsp"].includes(tool.name),
      destructiveHint: ["write", "edit", "apply_patch", "bash"].includes(tool.name),
      idempotentHint: ["read", "glob", "grep", "lsp"].includes(tool.name),
      openWorldHint: ["bash", "webfetch"].includes(tool.name),
    },
  }))
}

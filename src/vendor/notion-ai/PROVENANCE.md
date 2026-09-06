# Notion client provenance
Copied from nmt3325/notion-ai-mcp, commit fa773f022b08ec43884927ed865c3ef3dbec8711.
Only the client library and its local dependencies are included. No MCP server,
watchdog, workspace-rotation loop, or process entrypoint is started by the plugin.
The adapter explicitly sets maxWorkspaceRetries to zero and disables keep-awake.
The upstream API is unofficial and may change. Preserve this pin when updating.

## Local usage/context modifications

- Added numeric-only workflow inference usage collection with stable-step snapshot
  deduplication, optional actual cache/context fields, and separate last-inference
  versus observed-response totals (`usage.ts`).
- Forwarded optional usage through parsed streams and chat results; removed
  fabricated zero usage when the selected protocol did not report counters.
- Updated job persistence to validate provenance-aware usage and leave unsupported
  or legacy usage unknown. No upstream source pin, account policy or tool execution
  behavior was changed.
- See `docs/usage-ui.md` for public source evidence, exact pinned SDK/native-host
  verification and the limitations of the unchanged OpenCode sidebar.

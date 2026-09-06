# Notion client provenance
Originally copied from nmt3325/notion-ai-mcp, commit fa773f022b08ec43884927ed865c3ef3dbec8711.
Only the client library and its local dependencies are included. No MCP server,
watchdog, workspace-rotation loop, or process entrypoint is started by the plugin.
The adapter explicitly sets maxWorkspaceRetries to zero and disables keep-awake.
The upstream API is unofficial and may change. Preserve this source pin when updating.

## Local integration changes
This directory is not a byte-for-byte upstream copy. The live UI integration makes
these deliberately scoped changes:

- `notion-client.ts`: adds an optional cumulative public-text observer to chat;
  uses the incremental inference-stream parser; forwards public text at each
  Agent Service poll; and prevents a newly selected model from inheriting the
  previous model's reasoning effort. Omitting the new options preserves the
  existing calling convention.
- `inference-stream.ts` (new): incrementally reduces explicitly typed public text
  from NDJSON snapshots and patches, deduplicates snapshots, preserves separate
  public commentary/answer entries, handles split UTF-8/SSE framing and usage
  counters, and releases/cancels stream readers. Hidden/unknown/tool entry content
  is not retained or forwarded by this reducer. Frame and step bounds apply.
- `agent-transcript.ts`: adds a public-assistant-message aggregation helper for
  the current polled transcript, without exposing thinking or tool entities.

No account credentials or captured real-account transcript are included in the
fixtures. See `test/plugin-live.test.mjs`, `scripts/test-opencode-live.mjs`, and
`docs/live-ui.md` for coverage, supported event shapes and limitations. The native
OpenCode source pin remains unchanged; display integration uses host hooks and the
existing part-update route rather than patching the host.

## Measured-usage integration

- `usage.ts` (new): validates and deduplicates numeric workflow inference counters,
  preserves absence, last-inference context and separate observed turn totals.
- `inference-stream.ts`: observes raw events with the usage collector alongside
  incremental public text. The old zero-filled token accumulator is removed.
- `types.ts`, `chat-jobs.ts`, and `notion-client.ts`: preserve optional provenance
  through successful results and durable jobs; no fabricated zero-token fallback
  is retained for old records or Agent Service responses.

See `docs/usage-ui.md` for public source evidence, the opt-in live-test boundary,
cache mapping and unchanged-sidebar percentage/cost limitations.

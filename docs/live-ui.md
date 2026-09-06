# Live Notion text and execution activity

This plugin uses the unchanged OpenCode 1.18.29 chat UI (Bun 1.3.14). Notion remains the only reasoning and tool-selection owner. No upstream OpenCode source is patched and no second model is used to simulate streaming.

## What appears in chat

- Public assistant text is forwarded as soon as Notion emits it. The inference-transcript reader reduces NDJSON snapshots and typed text patches incrementally, rather than collecting the entire response first. The Agent Service polling path also reports public assistant-message snapshots at its polling cadence.
- Repeated cumulative snapshots are not appended twice. Multiple public text entries, such as commentary followed by an answer, are preserved. A genuine non-prefix revision stops append-only deltas; OpenCode's normal `experimental.text.complete` hook replaces that assistant's final text once. An upstream that supplies only a final answer still produces only a final answer; the plugin does not fabricate intermediate text.
- Locally observed native MCP execution jobs use the same specialized OpenCode tool cards as local calls. Native tool names, sanitized arguments, output/error text, and native metadata are preserved; bridge status stays in private metadata instead of appearing as a synthetic argument.
- Running, awaiting permission and cancelling map to a running OpenCode part; completed maps to completed; failed and cancelled map to error. The exact native status is retained in the card. Normal generic-tool output/details toggles control expanded results and completed-tool visibility. No replacement chat UI or custom TUI widget is required.

## Display only: no duplicate execution

`OpencodeClient.observe()` reports the existing native job lifecycle. It does not start work or change the catalog, arguments, permissions, execution result, HTTP bearer authentication, path boundaries, endpoint ownership or all-allow policy. Throwing observers cannot fail native work.

The plugin writes only its own tool parts using OpenCode's existing display-only `PATCH /session/{sessionID}/message/{messageID}/part/{partID}` route. The pinned plugin SDK is v1 and lacks the v2 part helper; a narrow `_client.patch` compatibility shim preserves the supplied SDK's in-process fetch, directory routing and server authentication. It does not make a fresh localhost client. The pinned route/schema and real host are tested.

Two safeguards are essential:

1. Card metadata sets `providerExecuted: true`. In this pinned host, even `finish_reason: stop` would otherwise cause another model step merely because a tool part exists.
2. A composed `experimental.chat.messages.transform` hook removes only these marked, namespaced display cards from inference histories. The original persisted records remain available to the standard UI, including after a restart. Actual assistant text and unrelated/user messages are not rewritten by this hook.

Provider SSE contains ordinary text deltas and `stop`, never executable `tool_calls`, tool arguments, or reasoning events. Mirrored native work is not executed by OpenCode's local model processor.

## Identity, cancellation and safety

The request headers identify the OpenCode **user** message. Before dispatching Notion, the display adapter verifies that user and resolves exactly one incomplete assistant with matching session, parent user, Notion provider and workspace directory. Metadata/title/summary/compaction assistants are excluded. It verifies the assistant again before every display write and never overwrites user, unrelated, or processor-owned parts.

Each job retains the assistant association it received at start. Late updates therefore stay on the original turn even if another turn starts. Progress writes are coalesced to a first running card plus latest pending state, rather than an unbounded queue of obsolete output. Completed-turn replay, uncertain-turn no-replay, single-active-turn locking, cancellation, and local metadata handling are preserved.

Only explicitly typed public text is forwarded; hidden thinking, reasoning, unknown entry types and raw upstream tool events are not used as chat text. The Notion token and execution bearer (including common encoded forms) are redacted from displayed text/errors/tool data. Streaming redaction holds an undecidable credential prefix across progress events. Tool display data also redacts sensitive keys, strips terminal control sequences and bounds depth, collection size and output length. Actual native arguments/results are not mutated by presentation sanitization.

## Visibility boundaries

- Tool cards cover native jobs observed in this bridge's execution worker while it owns an active turn, not all tools in Notion. Notion-native actions, other connectors and raw MCP control RPCs such as job-list/result queries are not mirrored as independent cards. A control operation's resulting native job-state change is visible on the job card.
- Jobs started outside an active bridge turn are not guessed onto a message. The dedicated endpoint/single-active-turn arrangement is the attribution boundary: do not concurrently drive the same execution connection from an unrelated Notion chat. Upstream does not provide a reliable cross-connector operation stream or universal turn identifier here.
- The upstream Notion API is unofficial. The parser supports the observed snapshot/typed-patch dialect and fails closed on unknown text-entry types. Real-account timing and unsupported future event shapes are not guaranteed. Agent Service visibility is polling, not token-level push.
- Append-only SSE clients without the supported OpenCode completion hook cannot apply non-prefix revisions; they receive an explicit error instead of a duplicated answer. The authoritative completed response remains in the journal for a non-streaming retry.
- Safe output is text-only and bounded; binary attachment previews are not automatically embedded into tool cards. A disconnected/restarted runtime cannot replay unfinished native work just to refresh a card.

## Integration contract

`ChatInput` adds optional `model`, `reasoningEffort`, and `onText(snapshot)` fields; the backend forwards those explicitly to the vendored client when present. `onText` is cumulative public text, not raw deltas or inference events. The vendored client does not inherit reasoning effort when a different model is selected.

Attach `attachLiveUI(input, runtime.transport, providerHooks(...))` after constructing the provider hooks. It composes event, history-transform, final-text and disposal hooks; it does not replace picker/provider configuration. The transport's `display` property avoids consuming a constructor slot. The sixth constructor argument is reserved for the parallel model-registry integration. When merging that change, thread its explicit model parameter alongside, not instead of, the new text callback in `turn`, `execute`, and `backend.send`.

New tests are `test/plugin-live.test.mjs` and `scripts/test-opencode-live.mjs`. Add a package/CI script for the latter in the model/version integration; no package version or scripts are changed by this feature branch.

## Validation

With the pinned native runtime prepared:

```sh
npm ci --ignore-scripts
npm run build
export OPENCODE_MCP_BUN="$(node --input-type=module -e 'import { bundledBun } from "./dist/plugin/config.js"; console.log(bundledBun())')"
export OPENCODE_MCP_RUNTIME_DIR=/path/to/private/native-runtime
npm run setup:native
npm run typecheck:native
npm test
npm run test:opencode
node scripts/test-opencode-live.mjs
npm run test:package
```

The live host smoke uses a mock Notion NDJSON response and the **real pinned OpenCode host, plugin SDK events, authenticated local HTTP MCP, and native write/bash/read execution**. It checks text before upstream completion, running/completed/error cards, correct assistant identity, exact final reconciliation after a revision, credential/hidden-text filtering, two-process session continuation, zero local tool executions, and a filesystem counter proving no duplicate native work.

This is real host/SDK/native-operation coverage with a mocked upstream. It is **not** a real Notion-account test or a screenshot-based TUI test. `KEEP_LIVE_TEST_ARTIFACTS=1` retains isolated smoke-test artifacts for diagnostics; only dummy credentials are used.

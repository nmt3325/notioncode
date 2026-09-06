# Notion token usage in the standard OpenCode sidebar

This change transports **reported Notion workflow inference counters**, not token estimates, through the existing OpenAI-compatible provider. It does not fork OpenCode, replace its sidebar, execute a second model, expose thinking text, or run a local tool because a Notion transcript mentioned it.

## What is measured

The collector is scoped to one `runInferenceTranscript` response. Its allowlisted numeric fields are:

| Notion inference field | Meaning / mapping |
| --- | --- |
| `inputTokens` | Reported inference input, including cache reads. |
| `outputTokens` | Reported inference output. No guessed reasoning split. |
| `cachedTokensRead` | Cache-read portion already included in `inputTokens`. Optional, not inferred. |
| `cachedTokensCreated` | Separately reported cache creation; added to compatible-provider prompt input exactly once. |
| `maxInputTokens` | Reported input/context budget for that inference; not renamed to physical model capacity. |
| `maxContextTokens` | Reported model context capacity for that inference. |

`NotionUsage` explicitly separates:

- **`lastInference`**: the last observed inference by step order. This drives OpenCode's context token number.
- **`observedTotals`**: per-field sums of distinct observed inferences in this response, after cumulative snapshots are deduplicated. Not sent as OpenCode's context number.
- **`inferenceCount` / `allInferenceInputOutputReported`**: describe retained observations, not completeness of every remote Notion operation. The completeness flag does not assert cache or reasoning availability.

Neither the last inference nor the sum of a turn is advertised as a measured whole-conversation context. Notion may select, compress, cache, or omit conversation content internally. No text-length token estimate is made.

Missing, invalid, negative, fractional, unsafe, or overflowed values remain absent. Explicitly reported `0` remains a real numeric value. A partial input/output pair remains in provenance metadata but is **not** emitted as standard `usage`, because the pinned compatible SDK turns the missing half of a partial pair into zero.

### Deduplication and ordering

Stable `agent-inference.id` snapshots and `/s/N` patch slots identify inferences. Numeric `a`/`p` assignments replace prior values; they are not deltas. A late snapshot of an earlier inference updates that inference's counters without changing which inference is last. Patch slots are linked to stable IDs; field revisions preserve the newest assignment when formats are mixed, including invalidations. Reusing an index with a different stable ID does not erase the earlier inference.

A wholly ID-less stream is conservatively treated as one cumulative snapshot, with completeness false. If identified steps arrive, ambiguous ID-less observations are discarded rather than counted twice. Unknown nested tool/reviewer token-shaped data is ignored. Value-entry paths reserve later inference positions even when no usage follows, so the parser does not inherit earlier metrics for an unmeasured later inference.

## Wire and persistence

For a complete last-inference input/output pair:

```text
prompt_tokens     = inputTokens + reported cachedTokensCreated (if present)
completion_tokens = outputTokens
total_tokens      = prompt_tokens + completion_tokens
prompt_tokens_details.cached_tokens = reported cachedTokensRead (if present)
```

This is an arithmetic sum of reported components, not an estimate of missing cache or reasoning categories. Missing categories remain distinguishable in the numeric-only `notion_usage` extension.

- JSON completions include the optional `usage` and `notion_usage` envelope.
- SSE emits one final usage-only `choices: []` frame after the stop frame and before `[DONE]`, including final Notion metrics arriving after visible text.
- A successful backend callback is saved with the completed turn. Complete-turn replays read the same saved usage and do not call Notion again or add totals again.
- Errors, cancellation, uncertain dispatches and the vendor's empty-answer guard do not persist or publish successful-completion metrics.
- Local title/summary/metadata work never emits Notion usage and never calls Notion.
- Legacy journal/job records without provenance remain readable, but their old usage objects are not promoted into measured counters. In particular, the old `{ inputTokens: 0, outputTokens: 0 }` fallback is removed.

## Production integration

Version 0.5.0 already integrates the usage options, unknown model limits, streaming parser, journal and native smoke into production code and CI. The following is a maintainer reference, not an extra configuration step for users:

```ts
import { notionUsageOptions, UNKNOWN_NOTION_CONTEXT } from "./plugin/usage.js"

// Keep existing fetch, timeout, model routing and other provider settings.
Object.assign(config.provider["notion-ai"].options, notionUsageOptions)

// Only for limits which have not been independently verified for this model:
model.limit.context = UNKNOWN_NOTION_CONTEXT // 0 = native unknown convention
model.limit.output = 0 // native host falls back internally; not a Notion capacity claim
```

`notionUsageOptions` sets `includeUsage: true` and the documented compatible SDK `metadataExtractor`. The extractor retains `notion-ai` provenance and supplies actually reported cache creation through OpenCode 1.18.29's `anthropic.cacheCreationInputTokens` compatibility field. That key is a host field-name adapter, **not a claim that Notion or its selected model is Anthropic**. Without the adapter, the pinned compatible SDK loses the cache-write split. No cost or provider identity is inferred from it.

Keep the following small integration points when reconciling the streaming branch:

1. `ChatInput.onUsage?: (usage: NotionUsage) => void`; `send()` still returns `Promise<string>`.
2. The backend invokes `onUsage` once after a successful result, same-conversation validation and abort check. Preserve the streaming callbacks and selected `model` alongside it.
3. Instantiate `InferenceUsageCollector` once per parsed response and call `observe` for every raw parsed event, including final usage-only frames. Use its `result()` for optional `ParsedInferenceStream.usage`; do not restore the old `+=` counter logic when replacing the text parser.
4. The transport captures the final callback, stores it using `withTurnUsage`, reads complete-turn usage with `readTurnUsage`, and emits `usageEnvelope` once at the end. Preserve the parent model-routing argument and the sixth `models` constructor slot; usage takes no constructor slot.
5. Keep journal version 1 compatibility. The helpers safely persist and validate optional provenance without promoting old zero-filled usage records into measured data.
6. Both native display/usage smoke tests run in CI after pinned runtime setup. Unit tests are matched by `test/*.test.mjs`; the explicit opt-in real-account harness never runs in CI.

The smoke fixture asserts the actual production provider settings and exercises the real backend, SDK and host. It does not repair missing production integration with fixture-only configuration overrides.

## Honest context limits and unchanged-UI limitations

The historical blanket `context: 200000` / `output: 32000` values are not verified Notion limits. The public Notion workflow UI also has a `272000` fallback; this implementation does **not** reuse it as a measured limit. Prefer the native unknown sentinel until the selected model's limit is independently established.

Actual response `maxInputTokens` and `maxContextTokens`, when present, are preserved in the journal and provider metadata. `reportedContext()` exposes both and computes an optional percentage using Notion's observed precedence `maxInputTokens ?? maxContextTokens`, without a fallback. This helper result does not claim to synchronize the sidebar's provider-model registry dynamically. No safe per-response registry refresh is implemented here; changing host configuration/restarting a provider mid-turn would not be a justified substitute.

Pinned OpenCode TUI behavior matters:

- It selects the last assistant message with **`tokens.output > 0`**.
- It sums native input, output, reasoning, cache-read and cache-write categories. Our adapter prevents cache reads/writes from being counted twice.
- It divides by the configured provider model `limit.context`, not `notion_usage.maxContextTokens`.
- With `limit.context: 0`, its state has `percent: null`, but its unchanged JSX renders **`0% used`** anyway. That is a UI placeholder, not a measured zero. Omitting or relabelling that text would require a host UI change, which this task does not make.
- Absent counters normalize to native numeric zeros. A new unmeasured or zero-output turn can therefore leave an earlier positive-output turn selected. The journal/wire preserve absence, but the unchanged sidebar cannot express all of those states.
- Native **`$0.00 spent`** without Notion pricing is an unpriced placeholder, not a statement that Notion is free or that credits are dollars.

No confirmed workflow top-level reasoning counter was found. Different Notion Agent Service/reviewer payloads expose names such as `reasoningOutputTokens` or `thinkingTokens`, but those are not evidence that the workflow inference producer emits them. They are intentionally not mapped. No hidden thinking text is exposed.

## Source evidence

Inspected pins:

- vendored `nmt3325/notion-ai-mcp`: `fa773f022b08ec43884927ed865c3ef3dbec8711`;
- unchanged OpenCode **1.18.29**: `16747470f976aca3d362ad730bcd3fe82ecc2c9a`;
- bundled Bun **1.3.14**;
- runtime `@ai-sdk/openai-compatible` **2.0.41**.

Public Notion assets were fetched without account cookies. These rolling assets may later disappear; the recorded hashes identify exactly what was inspected. The bundle investigation was targeted, not a claim to have successfully downloaded every chunk.

- `https://app.notion.com/_assets/21863-23be36b9a162ae36.js` — workflow usage/context UI. SHA-256 `f96dbb3ac61a120923b69cc29a9ced782dbb73faf7cc6562aea31ea21abb8f07`.
- `https://app.notion.com/_assets/5043-e9430deb27ad9c9d.js` — current model registry showing differing model limits, not a universal 200K capacity. SHA-256 `26d3983cecb5fbb3f075211893296093326293bd39fb642056ebd668e985ae6e`.

The workflow UI splits input into cached reads plus `max(0, inputTokens - cachedTokensRead)`, adds separately reported cache creation and output, and prefers `maxInputTokens` to `maxContextTokens`. It also estimates later tool-result size; that estimate is explicitly **not** copied here. Its latest-inference context pass resets at each inference instead of accumulating an entire turn.

Relevant pinned host/SDK sources:

- `packages/tui/src/feature-plugins/sidebar/context.tsx` — token/percentage selection and rendering.
- `packages/app/src/components/session/session-context-metrics.ts` — app unknown-context behavior differs from the terminal sidebar.
- `packages/opencode/src/session/session.ts` — `getUsage`, cache decomposition and metadata compatibility keys.
- `packages/opencode/src/session/processor.ts` — native message and step-finish token updates.
- compatible SDK `src/chat/openai-compatible-chat-language-model.ts` — final usage-only frames and metadata extraction.
- compatible SDK `src/chat/convert-openai-compatible-chat-usage.ts` — absent/partial usage normalization.
- compatible SDK `src/chat/openai-compatible-metadata-extractor.ts` — supported extractor interface.

## Verification

```sh
npm ci --ignore-scripts
npm run build
# Set up the project's pinned runtime first, as in the existing native smoke.
export OPENCODE_MCP_BUN="$(node --input-type=module -e 'import {bundledBun} from "./dist/plugin/config.js"; console.log(bundledBun())')"
export OPENCODE_MCP_RUNTIME_DIR=/path/to/isolated/pinned-runtime
npm run setup:native
npm test
node scripts/test-opencode-usage.mjs
```

The new unit suite covers repeated snapshots, multiple inferences, sparse and mixed patches, cache/context optionality, explicit zero versus absence, overflow/invalid input, hidden/nested data exclusion, last usage-only NDJSON frames, job sanitization, complete-turn restart/replay, metadata isolation, errors, empty responses and cancellation.

The native smoke starts the **actual pinned OpenCode source CLI**, uses an isolated HOME/XDG tree, closes child stdin, and injects mocked Notion NDJSON into the real backend. It verifies both native `step_finish` and `message.updated` counters. A last inference with input 1000, output 200, cache read 300 and cache creation 40 produces native `{total:1240,input:700,output:200,reasoning:0,cache:{read:300,write:40}}`, not the sum including an earlier 400/30 inference. A second, unmeasured turn retains no usage in the journal after process restart.

It also extracts and executes the actual pinned sidebar state callback with those native messages, testing known/unknown denominators and the prior-message fallback. This is **not a rendered TUI screenshot**, a macOS test, or proof that a real Notion account currently supplies every supported optional field. No live Notion credentials or account mutations are used by these tests.

## Explicitly authorized real-account verification

`scripts/test-notion-usage-live.mjs` is a separate **opt-in**, non-CI harness. It
starts the pinned native CLI and makes one real Notion inference, with a durable
one-dispatch guard, search disabled and Notion read-only mode asserted before
the request. It does not initialize the full connection-registration runtime;
only account loading and the inference endpoint are permitted.

The caller must provide `NOTION_USAGE_LIVE_ALLOW=yes`,
`NOTION_USAGE_LIVE_SPACE_ID` for the intended workspace and
`NOTION_USAGE_LIVE_TOKEN_FILE` pointing to a private JSON file outside the
repository containing `tokenV2`. Never put a token value in a command line,
tracked file, environment variable, log or shared report. The normal pinned Bun
and runtime environment variables above also apply.

The harness reports only reply confirmation, HTTP statuses, numeric usage/context
fields, native SDK counters and completion statuses. It asserts that standard
usage, when supplied, matches both native step-finish and assistant-message
counters. If the service supplies no usable counters, it reports that distinction
instead of manufacturing measurements.

Its temporary HOME, journal, provider fixture and protocol summaries are removed
on completion. The caller remains responsible for removing the input credential
file they supplied. The implementation's user-authorized live check used encrypted
credential transfer and then removed both local and runner credential copies.
No credential, account identifier or private raw transcript is included in this
repository. The ordinary automated smoke remains fully mocked and repeatable.

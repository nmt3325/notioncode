# Validation record

## Live integration — 2026-09-06

Verified on an owned GitHub Actions Linux runner with Node 22, Bun 1.3.14 and the unchanged OpenCode 1.18.29 source pin.

- Supplied token_v2 authenticated against app.notion.com.
- Production plugin loaded in the real OpenCode host (not a mock UI).
- Standard chat returned a unique marker from the real Notion AI.
- Plugin automatically started the authenticated execution MCP and registered exactly one dedicated Notion connection.
- Both read/write auto-run policies were enabled.
- Restarted OpenCode and continued the same mapped Notion conversation.
- Notion called real native write, read, edit and bash tools. Final file bytes and a shell-created marker were checked independently on disk.
- Completed-turn journal contained both turns; no duplicate connection was created.
- Temporary MCP connection removal was verified; pre-existing connections remained present.
- Temporary tunnel, credential copies and scratch workspace were removed. Exact credential scan of repository and built output found zero matches.

Notion supplied the reasoning and selected the execution tools. No second OpenCode LLM was used. Native file edits were not simulated. The UI protocol was exercised through the standard CLI; no TUI pixel/screenshot test was performed.

Routine automated tests use mock Notion responses and never use a live Cookie. The one-time live credential and private session/connection identifiers are deliberately absent from this record and the repository.


## Astra, effort and real image upload — 2026-09-06

### Findings and corrections

- The old public Astra entry was silently reported as **GPT-5.5** by the live inference service despite HTTP 200. The workflow selection key is not the same as the provider-facing model name; its mapping was corrected using the current Notion Web registry.
- Astra exposes five effort variants: **low, medium, high, xhigh, max**, with **medium** as the registry default. Plugin options and `NOTION_REASONING_EFFORT` can set the configured default; per-turn variants take precedence.
- A second, real native-host test exposed **HTTP 400: File type not allowed** before inference. The standard SDK omitted the PNG filename; the adapter used `.bin` even though MIME was `image/png`. The missing filename now receives a MIME-derived extension.

### Actual native-host result

Tested with **OpenCode 1.18.29 / Bun 1.3.14** on Linux, using the production provider hooks, transport, backend and client. This was not a mocked upload.

| Check | Observed |
| --- | --- |
| Public CLI model | `notion-ai/gpt-6-astra` |
| CLI variant and SDK effort | `high` |
| Upload URL request | HTTP 200 |
| Signed storage upload | **HTTP 204**, PNG, 5,189 bytes |
| Attachment processing | HTTP 200 |
| Inference | HTTP 200; exactly one dispatch |
| Server-reported inference model | **GPT-6 Astra** |
| Server-persisted current config | **GPT-6 Astra / high** |
| Image-only code | **37E85015** |
| Blue circles / red squares | **3 / 1** |

The code and counts were in the image, not the outbound question, and were deep-compared with the expected JSON. Effort was obtained from the server's current persisted config, not an echoed local `.model` field. The fixture provider forced read-only mode, disabled search, and did not register or expose an execution MCP. No TUI screenshot claim is made.

Only **high** was live-tested for Astra. All five variants, default reset, invalid/conflicting efforts, journal no-resend behavior, metadata mismatch handling and filename fallback are covered by automated tests. Registry support does not prove every tier is available to every account. Reported metadata verifies server-side selection, not the physical model weights.

Machine-readable sanitized evidence: [astra-image-result.json](astra-image-result.json).

### Explicit opt-in reproduction (repository checkout only)

Prepare an account JSON **outside the repository**, with `token_v2` and `space_id` (camelCase `tokenV2` / `spaceId` also accepted), permissions 0600. Never put a Cookie into the command line, Git, CI secrets for an automatic test, or test output. Install the pinned native runtime first as described in the normal setup instructions.

```sh
NOTION_MODEL_LIVE_ALLOW=yes \
NOTION_MODEL_LIVE_ACCOUNT_FILE=/absolute/private/account.json \
npm run test:notion:model-image
```

This uploads `test/fixtures/image-probe.png` and makes **one real, billable, read-only inference** per invocation. It is not part of CI. The script isolates the native HOME and workspace, blocks unrelated HTTP endpoints, refuses a second inference, requires both image and server-metadata assertions, and removes its temporary local workspace. It does not delete the account's Notion conversation. Use `NOTION_MODEL_LIVE_REPORT` to save the sanitized report; use `NOTION_MODEL_LIVE_IMAGE` and `NOTION_MODEL_LIVE_EXPECTED` together for another image/expected-JSON pair.

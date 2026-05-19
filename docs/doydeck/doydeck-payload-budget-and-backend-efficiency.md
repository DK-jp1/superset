# DoyDeck Payload Budget and Backend Efficiency

Status: initial implementation checkpoint, 2026-05-20.

This note defines the backend-side payload budget for DoyDeck Controller
Commands. The intent is to keep the same user-facing behavior while making
status reads, Worker monitoring, Handoff sends, and artifact review cheaper for
long sessions.

## Goal

DoyDeck should avoid returning or retaining large diagnostic payloads unless the
caller explicitly needs them. Normal operations should prefer structured
summary fields, path references, artifact metadata, and short previews.

This pass does not remove features, change UI behavior, unload WebViews, or
change Auto Loop semantics.

## Heavy Backend Paths

High-risk paths:

- `readBoundWorkerLatestResponse()`
  - Can inspect a long terminal buffer.
  - Historically returned `rawOutputText`, `outputText`, `screenText`, and
    `viewportText` on every call.
  - Now supports response modes so monitoring can avoid returning diagnostics.

- `getTaskRunStatus()` / `getBoundWorkerCompletionStatus()`
  - Used by Meta AI and external scripts for Worker monitoring.
  - Should return state, run identity, report length, and next action without
    shipping raw terminal text.

- `sendHandoffToBrowserAI()`
  - Builds a full Handoff prompt.
  - Risk grows when old outcomes, long additional context, or full docs are
    copied into the prompt.

- `sendBoundWorkerResponseToBrowserAI()`
  - Needs the extracted Worker report, not the whole terminal buffer.
  - Large reports should be visible through length/preview warnings.

- Artifact Review Loop
  - Should keep path, filename, mime, byte length, attach status, and review
    status.
  - It should not store file body or base64 in Commander state.

- Browser AI / visual verification
  - DOM snapshots and screenshots are useful for sanity checks but should stay
    action-triggered, not background polling.

## Response Mode Policy

Controller worker-output reads use three modes:

| Mode | Use | Returned diagnostic text |
| --- | --- | --- |
| `summary` | polling, `getTaskRunStatus()`, outcome classification | omitted from `rawOutputText`, `outputText`, `screenText`, `viewportText` |
| `diagnostic` | normal manual debugging / compatibility | capped diagnostic text, default `80000` chars per field |
| `raw` | explicit deep debugging only | larger capped diagnostic text, default `250000` chars per field |

Supported inputs on `readBoundWorkerLatestResponse(input?)`:

- `responseMode?: "summary" | "diagnostic" | "raw"`
- `includeRawOutput?: boolean`
- `maxDiagnosticChars?: number`

Returned budget fields:

- `responseMode`
- `maxDiagnosticChars`
- `diagnosticFieldsIncluded`
- `rawOutputIncluded`
- `omittedDiagnosticFields`
- `truncatedDiagnosticFields`
- `diagnosticTextLength`
- `returnedDiagnosticTextLength`

Default remains `diagnostic` for compatibility. Internal status/polling callers
should use `summary`.

## Payload Budget Warnings

Controller sends now warn when payloads approach large thresholds:

- Handoff ledger: warning at `20000` chars, severe at `40000`.
- Handoff additional context: warning at `20000`, severe at `40000`.
- Browser AI prompt: warning at `30000`, severe at `60000`.
- Worker response package: warning at `20000`, severe at `50000`.

Warnings do not block. They are signals to move toward summaries, file
attachments, artifact metadata, or path references.

## Implemented in This Pass

- Added response-mode inputs to `readBoundWorkerLatestResponse(input?)`.
- Added payload budget metadata to Worker latest-response results.
- Changed internal `getTaskRunStatus()` / completion-status reads to use
  summary-oriented Worker response reads.
- Changed outcome and artifact collection paths to avoid returning raw terminal
  diagnostics when only structured Worker response fields are needed.
- Added Handoff / prompt / Worker response payload-size warnings.
- Added Handoff Ledger length and budget fields to `buildHandoffLedger()`.

## Deferred Design Items

P1:

- Add `responseMode` guidance to all external Meta AI starter prompts.
- Add Handoff / Outcome storage compaction where large reports become path
  references plus previews.
- Add per-terminal retained char diagnostics and listener counts.
- Define active / inactive / completed tab lifecycle polling policy.

P2:

- Cache Explorer previews by path, size, and mtime.
- Add artifact metadata hashes for review reproducibility.
- Add visual sanity check counters for loop runs.

P3:

- WebView unload / restore for inactive providers.
- DB-backed telemetry dashboard.
- Multi-tab background loop scheduler.

## Smoke Matrix

| Area | Expected result | Verification |
| --- | --- | --- |
| Worker latest response summary | No raw terminal diagnostic text returned in summary mode. | Controller smoke. |
| Worker latest response diagnostic/raw | Diagnostic fields still available when requested. | Controller smoke. |
| Task run status | Structured state still works without raw diagnostics. | Controller smoke / targeted tests. |
| DONE_TAG report extraction | Structured reports still extract and validate. | Targeted tests. |
| Artifact Review Loop | Artifact routing remains metadata/path based. | Targeted tests. |
| Browser AI sends | Existing submission path still typechecks and keeps verification status. | Typecheck / Controller smoke where available. |
| Handoff payload budget | Large Handoff/prompt warnings are visible but not blocking. | Controller smoke / code inspection. |

## Tomorrow's Recommended Operation

- Use `getTaskRunStatus()` for polling instead of repeatedly requesting raw
  Worker output.
- Use `readBoundWorkerLatestResponse({ responseMode: "summary" })` for
  completion checks.
- Use `responseMode: "diagnostic"` only while investigating a specific Worker
  issue.
- Use `responseMode: "raw"` only for explicit deep debugging, and include a
  bounded `maxDiagnosticChars`.
- Treat Handoff / prompt payload warnings as a prompt-slimming signal.
- Prefer file attachments and artifact metadata over copying large file bodies
  or full terminal logs into Handoff.

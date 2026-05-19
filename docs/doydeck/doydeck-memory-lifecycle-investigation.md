# DoyDeck Memory Lifecycle Investigation

Status: initial investigation checkpoint, 2026-05-20.

This note records the first memory / performance / lifecycle pass for DoyDeck
safe-dev. The goal is to keep long sessions and multiple task tabs usable
without removing useful DoyDeck features. Large design changes remain backlog
items; this pass only includes small, low-risk fixes.

## Scope

Investigated:

- CommanderTab Controller Commands and Auto Loop watchers.
- Browser AI send, attachment, and latest-reply paths.
- Worker terminal output retention and Worker response extraction.
- Handoff / Outcome / artifact review payload shape.
- Explorer preview and Browser AI real-file attachment paths at a static level.

Out of scope for this pass:

- WebView destruction / restore redesign.
- Background multi-tab Auto Loop scheduler.
- DB or app-state migration.
- Feature removal.
- Long Auto Loop soak testing.

## Measurements / Static Evidence

The current code already has some limits:

- Auto capture poll interval: `1000ms`.
- Auto relay poll interval: `1000ms`.
- Auto Loop no-activity timeout: `180000ms`.
- Auto Loop hard max wait: `600000ms`.
- Browser AI captured text is capped by `MAX_CAPTURE_LENGTH = 10000`.
- Explorer Office preview text is capped at `80 * 1024` chars.
- `getTerminalOutputSnapshot(input)` defaults to returning the last `12000`
  chars of output text and caps explicit `maxOutputChars` at `50000`.

This pass changed two high-risk payload surfaces:

- Renderer terminal output log retention for each v1 terminal pane was reduced
  from `2_000_000` chars to `1_000_000` chars.
- `readBoundWorkerLatestResponse()` still analyzes the captured output, but its
  returned diagnostic `rawOutputText`, `outputText`, `screenText`, and
  `viewportText` fields are capped to the last `80000` chars each with a
  warning when truncation happens.

## Findings

### P0: Controller response payloads can become huge

`readBoundWorkerLatestResponse()` analyzes terminal output and returns
diagnostic copies of raw/output/screen/viewport text. In long Worker sessions,
this can return very large objects to Controller callers even when the
actionable report is a short DONE_TAG block.

Impact:

- Meta AI / external scripts receive more data than needed.
- JSON serialization and CDP transfer can become expensive.
- Large payloads make status polling slower and noisier.

Small fix done:

- Keep internal analysis behavior, but cap the returned diagnostic text fields
  to `80000` chars each and emit truncation warnings.

Backlog:

- Add explicit `includeRawOutput?: boolean` / `maxDiagnosticChars?: number`
  inputs so default status calls return summary fields only.

### P0: Terminal output retention grows per pane

The v1 terminal cache retains output logs in renderer memory per pane. Before
this pass, the cap was `2_000_000` chars per pane. Multiple long-running Worker
panes can accumulate significant renderer memory even when only the latest
report is needed.

Small fix done:

- Lowered the renderer output-log cap to `1_000_000` chars per pane. DONE_TAG
  report extraction and recent output deltas still have enough history for
  normal DoyDeck tasks.

Backlog:

- Add per-pane memory diagnostics: retained chars, baseOffset, listener count,
  and whether the pane is active/bound.
- Consider task-run-scoped report indexing so old raw logs can be discarded
  after a structured report is extracted.

### P1: Inactive tab polling / watchers need an explicit lifecycle policy

Auto Loop and auto-capture watchers are generally tied to active loop phases,
but DoyDeck now supports multiple tabs, Browser AI slots, Workers, artifact
review, and Controller status calls. Without a written lifecycle policy,
future features may accidentally poll inactive tabs too often.

Current state:

- Auto Loop has explicit phase checks and cancels on phase mismatch.
- Recent event lists are capped to 10 entries.
- Background / multi-tab loop is still a backlog item, not implemented.

Backlog:

- Define a tab lifecycle state: active, inactive-visible, inactive-hidden,
  loop-running, loop-paused, completed.
- Only active or explicitly running-loop tabs should run 1s polling.
- Inactive tabs should prefer event-driven updates or low-frequency summaries.

### P1: Browser AI / WebView provider state can carry task context

Provider tabs can retain chat thread context. This is a correctness and memory
concern because long threads make provider pages heavier and can leak old task
context into a new tab.

Current state:

- Browser AI provider thread reset / new thread remains a backlog item.
- `prepareBrowserAiReady()` can navigate providers but does not yet perform a
  Doy-confirmed thread reset.

Backlog:

- Add Doy-confirmed provider-specific new-thread/reset action.
- Keep one Browser AI provider slot per active task tab unless a task explicitly
  needs a different provider.

### P1: Handoff / Outcome / report payloads can bloat

Handoff, Outcome, Worker reports, and artifact reviews are now powerful enough
to carry large context. If every report keeps full raw text and full history,
future Browser AI prompts will become slower and more error-prone.

Current state:

- Decision Records are intended to be referenced by DR-ID, not copied in full.
- Artifact Review Loop prefers real file attachments and path/status metadata.
- Worker DONE_TAG reports are extracted and summarized for Browser AI review.

Backlog:

- Add Handoff size and prompt size warnings.
- Store full large reports as file/path references when possible, with concise
  preview in Handoff.
- Prefer artifact metadata: path, filename, byte length, mime type, hash/status.

### P1: Codex default prompt placeholders can look like unsafe input residue

Fresh Codex TUI sessions can display prompt suggestions such as
`Explain this codebase`, `Write tests for @filename`, and
`Find and fix a bug in @filename`. Treating these as real unsent input can make
preflight/readiness look blocked even when the pane is actually usable.

Small fix done:

- Treat the common Codex placeholder prompt lines as placeholder UI, not user
  input residue.

Backlog:

- Add fixture tests for Codex and Claude readiness UI samples so prompt
  placeholders, feedback prompts, and real residue stay separated.

### P2: Explorer preview and attachment work is already mostly bounded

Office preview output is capped, Browser AI attachment has file count and byte
limits, and unsupported / secret-like paths are skipped. The remaining risk is
not obvious memory leak but accidental preview of large files or repeated
expensive preview work.

Backlog:

- Cache preview summaries by path + mtime + size.
- Add an explicit "large preview skipped" status before expensive extraction.
- Keep PDF/OCR out of automatic loops unless Doy explicitly asks.

### P2: CDP / DOM snapshot / screenshot should stay on-demand

Visual sanity checks are required when text logs and UI disagree, but they
should not become background polling.

Backlog:

- Keep screenshots and visible snapshots user/action-triggered.
- Add diagnostic counters for visual checks performed during a loop.

### P3: Browser provider lifecycle / inactive WebView unload

Destroying or unloading inactive WebViews could save memory, but it is a large
behavioral change because provider session state, attachments, and chat context
would need restore semantics.

Backlog:

- Design before implementation.
- Start with "freeze / low-frequency diagnostics" before unload/destroy.

## Priority Summary

P0:

- Cap Controller diagnostic payloads for Worker response reads. Done.
- Reduce per-pane retained terminal output. Done.

P1:

- Active-tab-first lifecycle policy for polling/watchers.
- Browser AI thread reset / provider context lifecycle.
- Handoff / Outcome / prompt size warnings.
- Codex / Claude UI readiness fixtures.

P2:

- Explorer preview caching and large-preview status.
- Visual sanity check counters.
- Artifact metadata compaction and optional hashes.

P3:

- Inactive WebView unload / restore.
- Background multi-tab loop scheduler.
- DB-backed telemetry / lifecycle dashboard.

## Smoke Matrix

| Area | Expected result | Verification in this pass |
| --- | --- | --- |
| Active tab normal operation | Existing Controller commands still typecheck. | Typecheck gate. |
| Inactive tab polling | No large change in this pass; lifecycle policy documented. | Docs/backlog. |
| Browser AI send | No code path changed. | Typecheck gate; existing send code untouched. |
| Worker status read | Worker response extraction still analyzes full retained output but returns capped diagnostic text. | Targeted smoke/test and typecheck. |
| Artifact Review Loop | No artifact code changed. | Typecheck gate; existing tests remain available. |
| Handoff / Outcome size | No runtime change yet; bloat risk documented. | Docs/backlog. |

## Tomorrow's Recommended Operation

- Use one active task tab for active work; leave inactive tabs idle unless a
  bounded loop is intentionally running.
- Prefer DONE_TAG reports and artifact attachments over pasting large raw output
  into Handoff.
- When reviewing Worker status from Meta AI, use summary fields first and only
  request raw diagnostic text when investigating.
- Keep Browser AI threads fresh for unrelated tasks when a Doy-confirmed reset
  path exists; until then, create a new task tab and explicitly prime context.
- Watch for payload warnings in Controller results and treat them as a signal to
  summarize or attach files instead of pasting text.

## Open Follow-ups

1. Add `maxDiagnosticChars` / `includeRawOutput` options to Worker status and
   latest response accessors.
2. Add Handoff / prompt size warnings.
3. Add per-pane terminal cache diagnostics.
4. Add readiness fixture tests for Codex placeholders and Claude feedback /
   recap / residue states.
5. Design inactive-tab lifecycle states before background multi-tab Auto Loop.

# DoyDeck Feature Backlog

Status: backlog checkpoint, 2026-05-19.

This backlog collects features and hardening follow-ups that Doy has asked for
or that emerged from live DoyDeck usage. It separates "now" from "later" so
normal DoyDeck use does not turn into an unbounded implementation queue.

Priority guide:

- P0: blocks safe live operation.
- P1: important for near-term real operation.
- P2: useful hardening or workflow improvement.
- P3: larger design / later product work.

## Backlog Items

| Item | Purpose | Why wanted | Current status | Priority | Now or later | Prerequisites | Related finding | Minimal implementation | Smoke method |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Memory lifecycle / payload budget | Keep long DoyDeck sessions and multiple task tabs from becoming heavy. | Worker terminal logs, Controller raw output payloads, Browser AI threads, Handoff history, and artifact state can grow over time. | Initial caps, Worker response modes, and payload warnings added; broader lifecycle policy remains open. | P1 | Now/later | Stable Controller status fields and active-tab lifecycle policy. | Memory lifecycle investigation / payload budget policy. | Add per-pane terminal cache diagnostics, Handoff/Outcome compaction, and inactive-tab polling policy. | Long-session smoke shows status calls stay small, active tab still works, inactive tabs do not run unnecessary 1s polling. |
| Browser AI provider thread reset / new thread | Start an unrelated tab in a clean provider context. | Avoid Claude/ChatGPT thread context carryover across tasks. | Intent fields exist: `preferFreshThread` warns, `forceNewThread` blocks for Doy confirmation. Actual provider reset is not implemented. | P1 | Next design slice | Provider-specific safe navigation and Doy confirmation policy. | Browser AI thread/context reset. | Add Doy-confirmed provider-specific reset only after UI behavior is known. | Create two unrelated test tabs; confirm second Browser AI prompt has no first-task context. |
| Browser AI arbitrary short prompt command | Send a short one-off prompt to Browser AI without building a full Handoff. | Doy often wants quick wall-discussion or sanity checks. | Implemented. | done | Done | Existing `prepareBrowserAiReady` and submission verification. | Prompt/Handoff bloat. | `sendBrowserAiPrompt({ provider, prompt, expectedTabId, expectedTitle, requireActiveTabMatch })` with submission verification and guarded target. | Send 1-line prompt to ChatGPT/Claude and verify `UI_REFLECTED` or `REPLIED`. |
| Target-doc Browser AI review command | Review scoped docs without long manual prompt assembly. | Keeps target docs out of every Handoff and avoids prompt sprawl. | Partially supported by prompt flow; no narrow command. | P1 | Now, small slice | File read/context policy; guarded target tab. | Controller command missing P1. | `sendTargetDocsReviewToBrowserAI({ files, question, maxChars })` with path summary and additionalContext. | Review one docs file and verify provider reply references the target content. |
| Decision Record accessor | Expose DR-ID and short summaries through Controller Commands. | Avoid pasting full Decision Ledger content into prompts. | Docs-only workflow exists. | P1 | Now/later | Decide file-backed read-only source. | Handoff bloat / DR short-reference workflow. | `listDecisionRecords()` and `getDecisionRecord({ id })` read-only helpers. | Handoff includes DR-ID short reference and not full record text. |
| Prompt-size / Handoff-size warning | Warn before sending oversized Handoff or stale history. | Prevent Browser AI context bloat and wrong-history carryover. | Implemented for Handoff ledger, Browser AI prompt, additional context, and Worker response package length. | done | Done | Existing `buildHandoffLedger` output metadata. | Handoff肥大化. | Length fields and warnings are returned by Handoff / send paths. | Build a long Handoff fixture; warning appears while normal short Handoff remains clean. |
| Worker report contract / FORMAT_INVALID expansion | Enforce DONE_TAG report quality before Browser AI review. | Browser AI should not review prompt echo, placeholders, or footer-noise reports. | Implemented. | done | Done | Existing `commander-worker-report.ts`. | DONE_TAG extraction and footer/noise. | Required section validation and END_REPORT-aftertext fixture coverage. | Fixture tests for valid report, placeholder, missing section, END_REPORT footer. |
| Destructive guard false positive test pack | Prevent harmless words from blocking Worker instructions. | `remove` in screenshot names and UI copy caused false stops. | Implemented. | done | Done | Existing `commander-safety.test.ts`. | dangerous guard false positive. | Tests cover screenshot path, `removeFromArray`, UI "削除" labels, and true destructive shell commands. | Unit test pass; actual `rm -rf` still blocks. |
| DoyDeck-native task status watcher continued smoke | Keep Worker completion status reliable across long tasks. | External scripts previously misdetected RUNNING/COMPLETED. | `getTaskRunStatus` exists and current smoke passed. | P1 | Now as regression | Existing Worker pane and no-op task. | task-run identity and state reset. | Add repeatable smoke script or fixture for NOT_SUBMITTED -> RUNNING -> COMPLETED. | No-op DONE_TAG task reports current-run completion without previous state leak. |
| Claude worker input residue recovery action | Recover from prompt-echo-residue / feedback / recap states without unsafe guessing. | Current safe-dev smoke can correctly BLOCK a Claude pane with `❯ continue`; operators need the next safe action without guessing. | Detection and recovery advice implemented; mutating recovery remains Doy-gated. | P1 | Next safety slice | Visual sanity check and Doy confirmation before clear/restart/dismiss. | Final readiness audit / final usability polish. | Add an optional Doy-confirmed recovery action after the current diagnose-first helper. | Reproduce residue, confirm BLOCKED with `workerRecoveryActions`, recover through an approved route, then confirm readiness becomes READY or READY_WITH_NOTES. |
| Worker identity regression hardening | Keep Codex / Claude recognition precise as terminal UI changes. | Shell/unknown panes must not be treated as Workers, while real Codex/Claude panes should be detected without UI exploration. | Implemented with recognized worker listing and bind guards; needs ongoing fixture coverage. | P2 | Later test slice | Representative Codex, Claude, shell, and unknown output fixtures. | Worker identity / bind / race condition. | Extract worker identity detection into fixture-testable helpers, or add controller fixture smoke around representative pane text. | Fixture matrix returns Codex/Claude recognized and shell/unknown ignored. |
| Worker completion badge / status dot | Show completion state in UI without Doy scanning terminal output. | Doy should see task state immediately. | Missing. | P2 | Later UI slice | Reliable `getTaskRunStatus`. | Meta AI monitoring model. | Add small status dot/badge near bound worker or Handoff panel. | Completed Worker shows badge; running/stalled states update without Auto Loop start. |
| SSH / remote worker activity indicator | Show remote/Windows Worker status and whether it is routine or Doy-confirmed. | Doy sometimes wants Windows Claude only when explicitly requested. | Worker launch policy is docs-only. | P2 | Later | Remote launch policy and identity detection. | worker launch policy. | Add worker source fields and readiness text for local vs SSH. | Local Claude default remains high effort; Windows command used only when requested. |
| Background loop / 裏タブLoop | Let a task continue while Doy views another tab. | Real operation needs long tasks without keeping the tab foregrounded. | Not implemented; current work avoids long Auto Loop. | P2 | Later design | Per-tab state isolation and task-run identity. |裏タブ/非表示pane state uncertainty. | Design per-tab loop scheduler and status isolation before implementation. | Start a bounded fixture loop in one tab, switch tabs, verify status and no cross-tab writes. |
| Multiple tab Loop management | Monitor several tab loops safely. | Doy wants less copy/paste and more batch operation. | Not implemented. | P2 | Later design | Background loop, per-tab guards, completion watcher. | multi-tab operation risk. | Add loop registry with per-tab status, max concurrency, and Doy-gated starts. | Two fixture tabs show independent statuses and cannot write each other's Handoff. |
| Multi-worker team mode | Assign separate Workers to implementation/test/review roles. | Larger tasks need parallel help without Doy acting as relay. | Docs discuss roles; no native team mode. | P3 | Later | Multi-tab/multi-worker scheduling and conflict detection. | subagent/team policy. | Read-only planning first: propose worker roles and file ownership before sends. | Two docs-only workers produce non-overlapping outputs and one reviewer summary. |
| MCP integration | Expose DoyDeck task/tab/Outcome operations externally. | External Meta AI or tools should operate DoyDeck without UI/CDP scripts. | Docs-only plan exists. | P3 | Later | Stable Controller surface and auth/permission model. | Controller Commands / API-like操作. | Start with read-only MCP: command inventory, list tabs, active tab, build Handoff. | MCP client lists tabs and reads Handoff without mutating state. |
| Task / Goal app integration | Connect goal/task priority with DoyDeck tabs and outcomes. | Doy wants rough tasks turned into persistent work items. | Docs-only plan exists. | P3 | Later product slice | Task schema and Doy confirmation model. | task intake workflow. | File-backed prototype or local app mock before DB. | Rough task intake proposes tabs and returns completion status to Task App. |
| Decision / Feedback DB + weekly review | Persist Doy decisions beyond Markdown and review them regularly. | Past judgment should improve future operation without freezing it. | Markdown Decision Ledger exists. | P3 | Later | DB design and review UI decisions. | Decision Ledger workflow. | Keep Markdown until query/review needs exceed docs. | Weekly summary lists new decisions and stale decisions needing review. |
| Context Pack generation | Create scoped context bundles for Browser AI / Worker. | Reduces prompt length and stale history while preserving relevant facts. | Missing. | P2 | Later | Prompt-size warning and target-doc review command. | prompt slimming. | Generate pack with currentTask, target files, DR-ID refs, recent outcomes, and exclusions. | Browser AI review receives pack and does not need full Handoff history. |
| "雑に話すだけで準備" flow | Rough Doy input becomes proposed tabs, Browser AI ready, and Worker readiness after approval. | Reduces short-time copy/paste. | Docs-only task intake flow exists. | P2 | Later after command helpers | Task intake commands and guarded writes. | task intake workflow. | Add `analyzeTaskIntake` and `proposeTaskTabs` before any auto-create. | Sample multi-task input returns create / not-create / later candidates. |
| Browser AI initial context prime | Prime Browser AI at tab start with behavior policy and current task. | Browser AI should act as wall-discussion partner immediately. | Template exists in docs; no command. | P2 | Later | Browser AI short prompt command. | Browser AI behavior policy. | `primeBrowserAiForTab({ tabId, context })` with guarded send and verification. | New tab receives concise context and replies with useful next questions. |
| File to Browser AI review path | Attach selected Explorer files to Browser AI for review. | Finder open helps humans; AI review needs real attachments, not only copied paths or pasted text. | Implemented for supported Explorer action and Controller command; supports up to 5 files per send and PDF as a real attachment type. | done | Done | File selection, max-size/type rules, provider submission verification. | Explorer / file handling. | `attachTargetFilesToBrowserAI()` prepares supported files and uses Browser AI native file input; Explorer exposes `Attach to Browser AI`. | Select a small docs/PDF/image file, verify filename/chip UI reflection, send review prompt, and read Browser AI reply. |
| Artifact Review Loop package | Collect Worker screenshots/files/report and send them to Browser AI as real attachments. | Browser AI should review the actual result, not only a text summary. | Implemented as Controller commands and integrated into the bounded-loop Worker completion path. | done | Done | Existing file attachment command and Worker DONE_TAG extraction. | Artifact review loop. | `collectLoopReviewArtifacts()` collects selected files, review screenshots, Worker report metadata, and Worker-reported artifact paths; bounded loop prefers `sendWorkerReportedArtifactsToBrowserAI()` when Worker reports attachable paths and falls back to text review only with an explicit no-artifact note. | Dry-run collection returns attachable artifacts; bounded-loop routing tests cover artifact send, no-artifact fallback, skipped artifact fallback, and blocked collection. |

## File Attachment Follow-ups

- Multiple-file UX polish beyond the current 5-file-per-send cap.
- PDF live provider smoke; OCR or PDF text extraction remains out of scope.
- Image attachment review flow for screenshots and visual specs.
- Fallback text excerpt mode only when provider real attachment is impossible.
- Auto Loop body integration that automatically calls `sendLoopArtifactsToBrowserAI()` after each Worker completion.
- Read-only attached-file inventory exists as `getBrowserAiAttachedFiles(input?)`; continue smoke against provider UI changes.
- Treat `AI_REFERENCED_FILE: no` as incomplete artifact review unless the task explicitly allows text-only fallback.

## Top 5 Recommended Next Implementations

1. Optional Doy-confirmed Claude worker recovery action.
2. Handoff / Outcome compaction fields.
3. Browser AI provider thread reset / new thread design.
4. `sendTargetDocsReviewToBrowserAI(input)` as a scoped docs review command.
5. Decision Record accessor.

## Items To Keep Doy-Gated

- Push, deploy, public release, or external publication.
- Destructive file operations, tab close/delete, or bulk state mutations.
- Cookie, token, credentials, private API, production DB, billing, or auth.
- Direct edits to `local.db`, `app-state.json`, `~/.superset`, or
  `~/.doydeck-superset-dev`.
- Auto Loop body redesign, background/multi-tab scheduler, DB design, and
  broad UX final decisions.

## Backlog Maintenance Rule

When a live incident becomes a code fix, move the item from "open backlog" to a
hardening finding with:

- related commit,
- smoke evidence,
- remaining watch item,
- next regression check.

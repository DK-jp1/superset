# DoyDeck Artifact Review Loop

## Purpose

Artifact Review Loop lets Browser AI review real files from DoyDeck instead of
only reviewing copied text or paths. The intended flow is:

1. Doy selects specs, screenshots, docs, or result files in Explorer.
2. DoyDeck attaches those files to Claude or ChatGPT through the provider file
   attachment UI.
3. Browser AI uses the real attachments to create Worker instructions.
4. Worker implements and reports with DONE_TAG / END_REPORT.
5. DoyDeck collects Worker reports and generated review screenshots.
6. DoyDeck sends the collected artifacts back to Browser AI as real attachments.
7. Browser AI returns STOP or a scoped next Worker instruction.

## Controller Commands

- `attachTargetFilesToBrowserAI(input?)`: attach explicit supported file paths.
- `sendTargetFilesReviewToBrowserAI(input?)`: alias for file attachment plus
  optional review prompt.
- `attachSelectedExplorerFileToBrowserAI(input?)`: Explorer UI selected-file path.
- `getBrowserAiAttachedFiles(input?)`: read visible Browser AI attachment chips
  and file input filenames.
- `collectLoopReviewArtifacts(input?)`: collect selected files, review
  screenshots, and Worker report metadata for the active tab/run.
- `sendLoopArtifactsToBrowserAI(input?)`: attach collected artifacts to Browser
  AI and send the artifact review prompt.

Write/send commands should pass `expectedTabId`, `expectedTitle`, and
`requireActiveTabMatch:true` where possible.

## Artifact Sources

- Doy selected files in the Commander session.
- Explicit `targetPaths`.
- Worker generated `review-screenshots/*.png`, `.jpg`, `.jpeg` under the
  workspace.
- Worker DONE_TAG / END_REPORT reports.
- Build/test/Playwright/console/pageerror and changed-file hints found in the
  Worker report.

Only supported files are attached in the first version:

- `.md`, `.txt`, `.json`
- `.ts`, `.tsx`, `.js`, `.jsx`
- `.png`, `.jpg`, `.jpeg`

Unsupported files are returned as skipped artifacts with reasons.

## Status Semantics

Do not collapse these states:

- `ATTACH_ATTEMPTED`: an attachment operation started.
- `FILE_INPUT_SET`: the native file input received the file.
- `ATTACHMENT_UI_REFLECTED`: filename/chip is visible in Browser AI.
- `PROMPT_SENT`: the review prompt was submitted.
- `AI_REFERENCED_FILE`: Browser AI reply indicates it used the attachment.
- `REPLIED`: Browser AI has returned a reply.

`FILE_INPUT_SET` alone is not success. The loop should require
`ATTACHMENT_UI_REFLECTED` or a stronger observed state before treating file
review as ready.

## Doy Confirmation Gates

The loop should continue without Doy confirmation for scoped fixes. Stop for Doy
confirmation only when the next action includes:

- scope expansion
- DB/API/auth/AI live integration
- `.env.local`, credentials, token, cookie
- push, deploy, public release
- destructive operation
- private API, `local.db`, `app-state.json`
- large specification, UX, or wording final decision
- two failed self-repair attempts

## Future Work

- Provider-specific multi-file UX polish.
- PDF attachment validation; no OCR or PDF text extraction yet.
- Image-specific review prompts.
- Fallback text excerpt mode when provider real attachment is impossible.
- Auto Loop body integration that automatically calls
  `sendLoopArtifactsToBrowserAI()` after Worker completion.
- UI registry for attached/reviewed artifacts per task run.

# DoyDeck Artifact Review Loop

## Purpose

Artifact Review Loop lets Browser AI review real files from DoyDeck instead of
only reviewing copied text or paths. The intended flow is:

1. Doy selects specs, screenshots, docs, or result files in Explorer.
2. DoyDeck attaches those files to Claude or ChatGPT through the provider file
   attachment UI.
3. Browser AI uses the real attachments to create Worker instructions.
4. Worker implements and reports with DONE_TAG / END_REPORT.
5. DoyDeck collects Worker reports, generated review screenshots, and any
   supported artifact paths named inside the Worker report.
6. DoyDeck sends the collected artifacts back to Browser AI as real attachments.
7. Browser AI returns STOP or a scoped next Worker instruction.

The loop should not ask Doy for step-by-step confirmation after requirements
are clear. Browser AI and Worker continue within the approved scope until STOP,
unless a hard Doy gate is reached.

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
- `extractArtifactsFromWorkerReport(input?)`: extract Worker-reported artifact
  path candidates without sending.
- `collectWorkerReportedArtifacts(input?)`: resolve Worker-reported paths,
  check existence/attachability, and return skipped reasons.
- `sendWorkerReportedArtifactsToBrowserAI(input?)`: attach Worker-reported
  files and ask Browser AI to review the real artifacts.

Write/send commands should pass `expectedTabId`, `expectedTitle`, and
`requireActiveTabMatch:true` where possible.

## Artifact Sources

- Doy selected files in the Commander session.
- Explicit `targetPaths`.
- Worker generated `review-screenshots/*.png`, `.jpg`, `.jpeg` under the
  workspace.
- Worker DONE_TAG / END_REPORT reports.
- Supported file paths written inside Worker DONE_TAG reports, including
  absolute paths, workspace-relative paths, Markdown links, and screenshot paths.
- Build/test/Playwright/console/pageerror and changed-file hints found in the
  Worker report.

Worker reports should use this standard block:

```text
DONE_TAG:<TASK_ID>
実施内容:
変更ファイル:
成果物path:
スクショpath:
確認結果:
build結果:
Playwright結果:
console/pageerror:
未実装:
Doy確認事項:
次にやるなら:
END_REPORT
```

Every section must be present. Use `なし` when not applicable. `成果物path` and
`スクショpath` must contain real paths only; do not include `.env`,
token/cookie/secret paths, `local.db`, `app-state.json`, `node_modules`, or
`.git`.

Only supported files are attached in the first version:

- `.md`, `.txt`, `.json`
- `.ts`, `.tsx`, `.js`, `.jsx`
- `.png`, `.jpg`, `.jpeg`

Unsupported files are returned as skipped artifacts with reasons.
Sensitive or excluded paths such as `.env`, token/cookie/secret paths,
`local.db`, `app-state.json`, `node_modules`, and `.git` are skipped and should
not be attached.

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

Browser AI review replies should state whether the real files were actually
referenced:

- `AI_REFERENCED_FILE: yes` plus the filenames when the attachment was used.
- `AI_REFERENCED_FILE: no` plus the reason when Browser AI could not read the
  attachment.

If a follow-up Worker turn is needed, the reply must start the instruction with
`Workerへ渡す指示:`. If no follow-up is needed, the reply must include `STOP` or
`次のWorker指示は不要`. If no Doy confirmation is needed, it must include
`Doy確認事項なし`.

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

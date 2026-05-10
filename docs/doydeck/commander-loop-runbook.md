# DoyDeck Commander Loop Runbook

This runbook describes how to operate and verify the DoyDeck Commander Loop built across S3.1 through S3.15. It is intentionally operational: follow it when using the loop, handing work off, or debugging a stuck session.

## 1. Superset vs DoyDeck Safe Dev

Keep normal Superset and DoyDeck development isolated. Do not mix app state, user data, or worktrees.

| Use case | Home / data | App / profile | Repo |
| --- | --- | --- | --- |
| Normal Superset work | `~/.superset` | `/Applications/Superset.app` | normal Superset checkout |
| DoyDeck development | `~/.doydeck-superset-dev` | `Superset-DoyDeck-Dev` | `~/Developer/superset-doydeck-safe-dev` |

Rules:

- Do not copy, reset, delete, or migrate normal Superset data while working on DoyDeck.
- Do not point DoyDeck safe-dev at the normal Superset user data directory.
- Do not point normal Superset at the DoyDeck safe-dev profile.
- Verify the running process and user data path before debugging state problems.
- If both apps are running, confirm which window is the safe-dev window before testing Commander behavior.

Useful process checks:

```bash
ps aux | grep -E "superset-doydeck-safe-dev|Superset-DoyDeck-Dev|dev:doydeck-safe|electron-vite dev|host-service.js" | grep -v grep
```

Start safe-dev from the DoyDeck repo:

```bash
cd ~/Developer/superset-doydeck-safe-dev
bun run --cwd apps/desktop dev:doydeck-safe
```

## 2. Commander Loop Basic Flow

The Commander Loop connects terminal workers such as Claude Code or Codex with a Browser AI tab such as ChatGPT, Claude, or Gemini.

Standard loop:

1. Select the relevant terminal output.
2. Open Commander Actions.
3. Choose `Term -> AI`.
4. Confirm the selected terminal text is sent to Browser AI.
5. Wait for Browser AI to finish responding.
6. DoyDeck auto-captures the stable Browser AI response.
7. DoyDeck extracts only the worker instruction block.
8. Review the Terminal Send Preview.
9. Choose `Send` for paste-only, or `Send + Enter` to paste and execute.
10. If Auto Relay Preview is ON, wait for the worker completion report.
11. Review Worker Response Preview.
12. Choose `Send to Browser AI` only after confirming the worker response.

Safety rules:

- `Send` is the default safe action. It pastes only.
- `Send + Enter` executes. Use it only after reviewing the preview.
- Browser AI responses must not be pasted wholesale into the terminal.
- If instruction extraction fails, DoyDeck shows an empty Terminal Send Preview. Fill it manually.
- There is no automatic Enter unless Doy explicitly presses `Send + Enter`.

## 3. Recovery / Handoff

Use Handoff when a loop is stuck, a context is too long, a worker rate limits, a browser thread needs to be replaced, or the app/session needs to be recovered.

Generate a handoff:

1. Open Commander Actions.
2. Choose `Generate Handoff`.
3. Review Handoff Preview.
4. Choose one of:
   - `Copy`: copy the handoff prompt.
   - `Inject to Browser AI`: insert the handoff into the current Browser AI input.
   - `Send to Terminal`: open Terminal Send Preview for the handoff prompt.

`Copy Handoff` in Actions copies the latest generated handoff, even after the preview was closed.

Handoff Prompt sections:

- `Goal`
- `Completion Criteria`
- `Constraints`
- `Allowed Scope`
- `Forbidden Scope`
- `Current State`
- `Latest Worker Report`
- `Latest Browser AI Direction`
- `Browser State`
- `Terminal State`
- `Auto Relay Mode`
- `Git / Files`
- `Next Action`
- `Instruction for New Worker`

Git / Files field:

- `Branch`: current branch from Git.
- `Status`: `git status --short`.
- `Changed files`: `git diff --name-only`.
- `Diff stat`: `git diff --stat`.
- Diff body is not included.
- If Git info is successfully retrieved and clean, the field shows `変更なし`.
- If Git info cannot be retrieved, the field shows `未取得` and includes the failure reason.

## 4. Rate Limit Playbook

Claude Code rate limit:

1. Generate Handoff.
2. Copy or send the handoff to Codex.
3. Ask Codex to continue from `Instruction for New Worker`.
4. Keep constraints and forbidden scope unchanged.

Codex rate limit:

1. Generate Handoff.
2. Copy or send the handoff to Claude Code.
3. Ask Claude Code to continue from the latest worker report and Browser AI direction.

Browser AI thread too long:

1. Generate Handoff.
2. Open a new ChatGPT / Claude / Gemini thread manually.
3. Inject or paste the Handoff Prompt.
4. Continue with the new thread only after it acknowledges the current state.

Worker switch:

1. Generate Handoff from the current state.
2. Send the handoff to the new worker.
3. Do not rely on the previous terminal scrollback being visible.
4. Use the Git / Files field to confirm uncommitted state before work resumes.

## 5. Forbidden Actions

Do not:

- Move, delete, reset, or back up normal Superset data without explicit Doy approval.
- Mix `~/.superset` and `~/.doydeck-superset-dev`.
- Initialize, wipe, or migrate Electron `userData`.
- Reintroduce terminal right-click Commander actions.
- Use cookies, tokens, private APIs, or unsupported service APIs.
- Auto-send Browser AI output to terminal.
- Auto-run terminal commands without Doy pressing `Send + Enter`.
- Fall back to sending the full Browser AI response when extraction fails.
- Add Git write operations for handoff summary. Only read-only Git commands are allowed.

Read-only Git commands allowed for Handoff Git / Files:

```bash
git branch --show-current
git status --short
git diff --stat
git diff --name-only
```

## 6. E2E Checklist

Run this checklist after changes to Commander Loop behavior.

Term -> AI:

- Select terminal output.
- Actions -> `Term -> AI`.
- Confirm Browser AI receives the selected terminal text.
- Confirm Browser AI sends or accepts the prompt through the visible UI.

AI -> Term:

- Wait for Browser AI response completion.
- Confirm auto-capture waits for stable text.
- Confirm Terminal Send Preview appears.
- Confirm extracted worker instructions are not truncated.
- Confirm full Browser AI response is not used as fallback.

Send / Send + Enter:

- `Send` pastes only.
- `Send + Enter` pastes, waits briefly, then sends carriage return.
- Empty preview disables both buttons.
- Missing terminal disables both buttons.

Auto Relay Preview:

- Turn Auto Relay Preview ON.
- Press `Send + Enter`.
- Confirm marker is taken before send.
- Worker outputs `## 完了報告`.
- After idle, Worker Response Preview appears.
- Preview contains the final clean completion report, not Codex / Claude TUI noise.

Worker Response -> Browser AI:

- Press `Send to Browser AI`.
- Confirm the Browser AI input receives the worker response.
- Confirm Browser AI sends only after Doy clicks the preview action.

Handoff:

- Actions -> `Generate Handoff`.
- Confirm Handoff Preview appears.
- Confirm `Copy` works.
- Confirm Actions -> `Copy Handoff` works after closing preview.
- Confirm `Inject to Browser AI` inserts into Browser AI input.
- Confirm `Send to Terminal` opens Terminal Send Preview instead of direct sending.
- Confirm Git / Files shows branch and clean/dirty state.

## 7. Troubleshooting

### Git summary fetcher is disconnected

Symptom:

```text
Git情報取得失敗: Git summary fetcherが未接続です
```

Meaning:

- The visible Commander did not receive a Git summary fetcher prop.
- This often means the V1 RightSidebar Commander path was used while only the V2 WorkspaceSidebar path was wired.

Check:

- V2 path: `WorkspaceSidebar.tsx` passes `fetchGitSummary` to `CommanderTab`.
- V1 path: `screens/main/components/WorkspaceView/RightSidebar/index.tsx` passes `fetchGitSummary` to `CommanderTab`.
- V1 uses `electronTrpc.changes.getHandoffSummary`.
- V2 uses `workspaceTrpc.git.getHandoffSummary`.

### No query-procedure

Symptom:

```text
No "query"-procedure on path "git.getHandoffSummary"
```

Meaning:

- Renderer connected to a host-service router that does not include `git.getHandoffSummary`.
- The app may be running an old host-service process or stale dev bundle.

Fix:

1. Stop DoyDeck safe-dev processes.
2. Restart `bun run --cwd apps/desktop dev:doydeck-safe`.
3. Confirm `apps/desktop/dist/main/host-service.js` contains `getHandoffSummary`.
4. Confirm the window uses `Superset-DoyDeck-Dev` user data.

### Terminal Send Preview does not appear

Likely causes:

- Browser AI response extraction returned empty and preview visibility was incorrectly tied to text truthiness.
- Active terminal was lost.
- Auto-capture timed out.

Expected behavior:

- Extraction failure still shows an empty Terminal Send Preview.
- Placeholder asks Doy to enter the instruction manually.
- Empty text disables `Send` and `Send + Enter`.

### Old AI response is captured

Likely causes:

- Capture happened on assistant count increase before streaming finished.
- Latest assistant text changed after capture.

Expected behavior:

- Capture waits for a stable candidate.
- Final DOM is re-read immediately before extraction.
- Transient text such as `Thought for`, `思考中`, or `考え中` is ignored.

### Worker Response Preview has TUI noise

Likely causes:

- Terminal stream contains Codex / Claude TUI redraw text.
- Multiple `## 完了報告` blocks were present.

Expected behavior:

- Strip ANSI/control sequences.
- Use the last `## 完了報告`.
- Remove lines such as `Working`, `esc to interrupt`, `gpt-*`, workspace path banners, and prompt examples.
- Send the cleaned worker response to Browser AI.

### Terminal right-click breaks display

The right-click Commander path must remain disabled. The official terminal-to-browser path is:

```text
Commander Actions -> Term -> AI
```

Do not reintroduce terminal right-click menu actions for Commander Loop.

## 8. Completion Report Format

Worker instructions should ask workers to finish with:

```md
## 完了報告
- やったこと:
- 変更ファイル:
- 確認結果:
- 未解決:
- 次にやること:
```

Auto Relay Preview depends on this heading for the first MVP completion detector.

import { toast } from "@superset/ui/sonner";
import type { CommanderSession, CommanderState } from "../commander-types";

export const DOYDECK_WORKER_RESPONSE_START =
	"<<<DOYDECK_WORKER_RESPONSE_START>>>";
export const DOYDECK_WORKER_RESPONSE_END =
	"<<<DOYDECK_WORKER_RESPONSE_END>>>";
export const DOYDECK_WORKER_RESPONSE_ENVELOPE_TEMPLATE = `${DOYDECK_WORKER_RESPONSE_START}
## 完了報告

### 実施内容
- ...

### 変更ファイル
- ...

### 確認結果
- ...

### git diff --check 結果
- PASS / FAIL

### セルフレビュー
- ...

### 次に改善するなら
- ...

### 未解決
- なし / あり: ...
${DOYDECK_WORKER_RESPONSE_END}`;

export const BROWSER_AI_STARTER_PROMPT = `あなたはDoyDeck内のBrowser AIです。

あなたの役割:
- Doyとの壁打ち
- 要件定義
- 実装方針の整理
- Terminal Workerへの指示生成
- Worker完了報告のレビュー
- 次アクション判断

あなた自身は実装者ではありません。
あなた自身が「## 完了報告」を返してはいけません。

Workerへ作業指示を出す時は、必ず最初の行を以下にしてください。

Workerへ渡す指示:

DoyDeckの構成:
- Explorer: ファイル閲覧、Preview、Browser AIへのfile upload drag
- Center Preview: PDF / image / Office / text / codeのPreview
- Commander: Session / Handoff / Browser AI ⇄ Worker連携
- Terminal Worker: Claude Code / Codexなどの実装担当
- Auto Relay Preview: Worker Responseを拾ってBrowser AIへ返す
- Auto Loop Preview: 制限付きでBrowser AI ⇄ Workerを自動往復

役割分担:
- Doy: 最終判断者、UX感覚、事業目的
- Browser AI: 要件定義、レビュー、次のWorker指示
- Worker: 実装、調査、検証、完了報告
- DoyDeck: 状態管理、Preview、Handoff、受け渡し

Doyの好み:
- 結論ファースト
- 抽象論より具体アクション
- 主導線だけ表に出す
- 補助機能はActions / Advancedへ逃がす
- ボタンを増やしすぎない
- AIっぽい汎用SaaS感を避ける
- 実在する作業ツール感を重視する
- 同じ症状を2回直して改善しなければ、次は追加実装せず調査モードへ切り替える

安全ルール:
- 通常版Supersetとsafe-devを混同しない
- ~/.superset / ~/.doydeck-superset-dev / local.db / app-state.json を直接触らない
- Git操作、commit、pushはDoy確認後
- 削除 / rename / move / destructive操作は明示承認まで禁止
- cookie / token / private APIには触らない
- 右クリック導線を勝手に復活させない

Worker指示には基本的に以下を含めてください:
- 目的
- 変更対象
- やること
- やらないこと
- 確認方法
- git diff
- git diff --check
- 必要ならtypecheck
- セルフレビュー/別観点レビュー
- 完了報告形式

Workerへの指示には、完了報告を必ず以下のDoyDeck response envelopeで囲むように指定してください。

${DOYDECK_WORKER_RESPONSE_ENVELOPE_TEMPLATE}

Auto Loop時:
- Workerへ渡す指示が必要なら必ず「Workerへ渡す指示:」で始める
- 完了なら「次のWorker指示は不要」または「STOP」と明記する
- Worker完了報告は必ずDoyDeck response envelopeで囲ませる
- Worker出力のMarkdown見出しがTUI上で \`● 完了報告\` のように見えても、それだけで不合格扱いしない
- 安全条件、成果、次アクションで判断する

以後、この前提でDoyの相談に答えてください。`;

interface HandoffPromptInput {
	state: CommanderState;
	session: CommanderSession;
	latestWorkerReport: string;
	latestBrowserAiDirection: string;
	browserProviderLabel: string;
	currentUrl: string;
	activeTerminal: string | null;
	autoRelayMode: string;
	gitSummary: HandoffGitSummary | null;
}

export interface HandoffGitSummary {
	branch: string;
	statusShort: string;
	diffStat: string;
	diffNameOnly: string[];
	error: string | null;
}

function valueOrUnset(
	value: string,
	fallback = "未設定。必要なら追記してください",
): string {
	const trimmed = value.trim();
	return trimmed ? trimmed : fallback;
}

function formatGitSummary(gitSummary: HandoffGitSummary | null): string {
	if (!gitSummary) {
		return "Git情報取得失敗: 結果を取得できませんでした";
	}
	if (gitSummary.error) {
		return `${gitSummary.error}

Branch:
未取得

Status:
未取得

Changed files:
未取得

Diff stat:
未取得`;
	}

	const changedFiles =
		gitSummary.diffNameOnly.length > 0
			? gitSummary.diffNameOnly.map((path) => `- ${path}`).join("\n")
			: "変更なし";

	return `Branch:
${gitSummary.branch || "未取得"}

Status:
${gitSummary.statusShort || "変更なし"}

Changed files:
${changedFiles}

Diff stat:
${gitSummary.diffStat || "変更なし"}`;
}

function formatSelectedFiles(
	files: CommanderSession["selectedFiles"],
): string {
	if (files.length === 0) return "未設定。必要ならExplorerから追加してください";
	return files
		.map((file) => {
			const lines = [
				`- Type: ${file.type}`,
				`  Display Name: ${file.displayName}`,
				`  Relative Path: ${file.relativePath || "未取得"}`,
				`  Absolute Path: ${file.absolutePath}`,
				`  Root: ${file.rootId}`,
			];
			if (typeof file.size === "number") lines.push(`  Size: ${file.size}`);
			if (file.previewKind) lines.push(`  Preview Kind: ${file.previewKind}`);
			return lines.join("\n");
		})
		.join("\n");
}

export function generateWorkerPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Goal\n${state.goal}`);
	if (state.context) sections.push(`## Context\n${state.context}`);
	if (state.constraints) sections.push(`## Constraints\n${state.constraints}`);
	if (state.currentProblem)
		sections.push(`## Current Problem\n${state.currentProblem}`);

	if (sections.length === 0) return "";

	return `# Worker Prompt

${sections.join("\n\n")}

---
Execute the goal above. Follow all constraints. Report what you did and any issues found.
Wrap your final response in this DoyDeck response envelope:

${DOYDECK_WORKER_RESPONSE_ENVELOPE_TEMPLATE}`;
}

export function generateReviewPrompt(state: CommanderState): string {
	const sections: string[] = [];
	if (state.goal) sections.push(`## Original Goal\n${state.goal}`);
	if (state.constraints)
		sections.push(`## Constraints to Verify\n${state.constraints}`);

	if (sections.length === 0) return "";

	return `# Review Prompt\n\n${sections.join("\n\n")}\n\n---\nReview the worker's output against the goal and constraints above. Check for:\n1. Goal completion — did the worker fully achieve the goal?\n2. Constraint violations — were all constraints respected?\n3. Side effects — any unintended changes?\n4. Quality — code quality, security, correctness\n\nReport: PASS / FAIL with specific findings.`;
}

export function generateHandoffPrompt({
	state,
	session,
	latestWorkerReport,
	latestBrowserAiDirection,
	browserProviderLabel,
	currentUrl,
	activeTerminal,
	autoRelayMode,
	gitSummary,
}: HandoffPromptInput): string {
	const nextAction = latestBrowserAiDirection.trim()
		? "Latest Browser AI Directionを確認し、制約を守って次の作業から再開してください。"
		: session.currentTask.trim() || state.currentProblem.trim()
			? "Current State / Current Problemを確認し、次の最小作業を提案してから進めてください。"
			: "GoalとConstraintsを確認し、必要な確認事項を整理してから作業を開始してください。";
	const goal = session.goal || state.goal;
	const constraints = session.constraints || state.constraints;
	const currentTask = session.currentTask || state.currentProblem;
	const intentNotes = session.intentNotes || state.context;
	const targetFiles = session.targetFiles.length
		? session.targetFiles.map((path) => `- ${path}`).join("\n")
		: "未設定。必要なら追記してください";

	return `## DoyDeck Handoff

### Goal
${valueOrUnset(goal)}

### Completion Criteria
${valueOrUnset(session.completionCriteria)}

### Constraints
${valueOrUnset(constraints)}

### Allowed Scope
${valueOrUnset(session.allowedScope)}

### Forbidden Scope
${valueOrUnset(session.forbiddenScope)}

### Current State
Intent / Notes:
${valueOrUnset(intentNotes)}

Current Task:
${valueOrUnset(currentTask)}

### Implementation Plan
${valueOrUnset(session.implementationPlan)}

### Target Files
${targetFiles}

### Selected Files / Paths
${formatSelectedFiles(session.selectedFiles)}

### Test Plan
${valueOrUnset(session.testPlan)}

### Risks / Open Questions
${valueOrUnset(session.risksOpenQuestions)}

### Latest Worker Report
${valueOrUnset(latestWorkerReport, "未取得。必要なら直近worker出力を確認してください")}

### Latest Browser AI Direction
${valueOrUnset(latestBrowserAiDirection, "未取得。必要ならBrowser AI側の直近指示を確認してください")}

### Browser State
- Provider: ${browserProviderLabel}
- Current URL: ${currentUrl || "未取得"}

### Terminal State
- Active Terminal: ${activeTerminal ? "connected" : "disconnected"}
- Pane ID: ${activeTerminal || "未取得"}

### Auto Relay Mode
${autoRelayMode}

### Git / Files
${formatGitSummary(gitSummary)}

### Next Action
${nextAction}

### Instruction for New Worker
このhandoffを読み、Goal / Constraints / Forbidden Scopeを維持して続きから作業してください。
作業前にCurrent State、Latest Worker Report、Latest Browser AI Directionを確認してください。
不明点がある場合は勝手に範囲を広げず、最小の確認事項として報告してください。
完了時は以下の形式で報告してください。

${DOYDECK_WORKER_RESPONSE_ENVELOPE_TEMPLATE}
`;
}

export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success("クリップボードにコピーしました");
	} catch {
		toast.error("クリップボードへのアクセスが拒否されました");
	}
}

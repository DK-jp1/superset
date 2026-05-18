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

interface WorkSessionLedgerInput {
	workspaceId: string;
	tabId: string | null;
	state: CommanderState;
	session: CommanderSession;
	browser: {
		ownerType: string;
		slotKey: string | null;
		providerLabel: string;
		ready: boolean;
		status: string;
		bridgeAvailable: boolean;
		currentUrl: string;
		webContentsId: number | null;
		usableWidth: number | null;
		visualStatus: string;
	};
	worker: {
		paneId: string | null;
		terminalId: string | null;
		workerType: string;
		workerIdentityOk: boolean;
		bindingStatus: string;
		bindingPolicy: string;
		fallbackUsed: boolean;
		reason: string | null;
	};
	autoLoop: {
		mode: string;
		phase: string;
		turn: number;
		maxTurns: number;
		stopReason: string | null;
		lastAction: string;
		tabContextStatus: string;
	};
	latestWorkerReport: string;
	latestBrowserDecision: string;
	latestQaResult: {
		status: "PASS" | "BLOCKED" | "FAIL" | "UNKNOWN";
		reportPath?: string;
		screenshots?: string[];
		summary?: string;
	} | null;
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

export function generateWorkSessionLedgerMarkdown({
	workspaceId,
	tabId,
	state,
	session,
	browser,
	worker,
	autoLoop,
	latestWorkerReport,
	latestBrowserDecision,
	latestQaResult,
}: WorkSessionLedgerInput): string {
	const recordedOutcome = extractLatestControllerChainOutcome(session);
	const goal = session.goal || state.goal;
	const objective = goal.trim() || "未設定。必要ならSessionに目的を追加してください";
	const currentTask =
		session.currentTask.trim() ||
		state.currentProblem.trim() ||
		"未設定。必要なら現在地を追記してください";
	const completed = latestWorkerReport.trim()
		? summarizeBlock(latestWorkerReport)
		: recordedOutcome
			? `Controller chain ${recordedOutcome.chainStatus || "RECORDED"}: ${recordedOutcome.finalDecision || "記録済み"}`
			: "未取得。Worker Responseを取得後に更新してください";
	const browserDecision = latestBrowserDecision.trim()
		? summarizeBlock(latestBrowserDecision)
		: recordedOutcome?.finalDecision
			? summarizeBlock(
					[
						recordedOutcome.finalDecision,
						recordedOutcome.extractedStopSignal
							? `STOP: ${recordedOutcome.extractedStopSignal}`
							: "",
						recordedOutcome.hasCodexInstruction === "true"
							? `Codex instruction: ${recordedOutcome.extractedCodexInstructionSummary || "あり"}`
							: "Codex instruction: false",
						recordedOutcome.hasDoyConfirmationItems === "true"
							? `Doy confirmation: ${recordedOutcome.extractedDoyConfirmationItems || "あり"}`
							: "Doy confirmation: false",
					]
						.filter(Boolean)
						.join("\n"),
				)
			: "未取得。Browser AI判断を取得後に更新してください";
	const unresolved = session.risksOpenQuestions.trim()
		? session.risksOpenQuestions
		: "未設定。未解決があれば追加してください";
	const nextAction = latestBrowserDecision.trim()
		? "Latest Browser AI Decisionを確認し、必要なら次のWorker指示を作成してください。"
		: recordedOutcome?.nextAction
			? recordedOutcome.nextAction
		: session.currentTask.trim() || state.currentProblem.trim()
			? "Current Taskを確認し、次の最小アクションを決めてください。"
			: "目的と制約を整理し、最初のWorker指示を作るか判断してください。";
	const qaLines = latestQaResult
		? [
				`- status: ${latestQaResult.status}`,
				`- report: ${latestQaResult.reportPath || "未取得"}`,
				`- screenshots: ${
					latestQaResult.screenshots?.length
						? latestQaResult.screenshots.join(", ")
						: "未取得"
				}`,
				latestQaResult.summary ? `- summary: ${latestQaResult.summary}` : "",
			]
				.filter(Boolean)
				.join("\n")
		: "- status: UNKNOWN\n- report: 未取得\n- screenshots: 未取得";
	const recordedQaLines =
		!latestQaResult && recordedOutcome
			? formatRecordedOutcomeQaLines(recordedOutcome)
			: "";
	const recordedOutcomeSection = recordedOutcome
		? formatRecordedOutcomeSection(recordedOutcome)
		: "";
	const liveWarnings = [
		browser.ready
			? ""
			: `Browser AI live ready is false (${browser.providerLabel || "Unsupported"})`,
		worker.workerIdentityOk
			? ""
			: `Worker identity live check is false (${worker.workerType || "unknown"})`,
		worker.reason ? `Worker binding reason: ${worker.reason}` : "",
		autoLoop.stopReason ? `Auto Loop stop reason: ${autoLoop.stopReason}` : "",
	].filter(Boolean);
	const liveStateSection = recordedOutcome
		? `## 現在のlive状態
注: このlive状態は現在のUI/Binding状態です。上記のController Chain Outcomeは記録済みの完了結果です。
${!browser.ready || !worker.workerIdentityOk ? "注: live状態がUnsupported/unknownでも、記録済みoutcomeが自動的にBLOCKEDへ変わるわけではありません。" : ""}

### Browser AI
- Browser provider: ${browser.providerLabel}
- browserAiReady: ${browser.ready ? "yes" : "no"}
- Browser runtime status: ${browser.status || "unknown"}
- Browser bridge available: ${browser.bridgeAvailable ? "yes" : "no"}
- Browser URL: ${browser.currentUrl || "未取得"}
- Browser owner: ${browser.ownerType || "unknown"}
- Browser slot: ${browser.slotKey || "未取得"}
- Browser webContentsId: ${browser.webContentsId ?? "未取得"}
- Browser usable width: ${browser.usableWidth ?? "未取得"}
- Browser visual: ${browser.visualStatus || "UNKNOWN"}

### Worker Binding
- status: ${worker.bindingStatus}
- policy: ${worker.bindingPolicy}
- fallback used: ${worker.fallbackUsed ? "yes" : "no"}
- worker type: ${worker.workerType}
- workerIdentityOk: ${worker.workerIdentityOk ? "yes" : "no"}
- paneId: ${worker.paneId || "未取得"}
- terminalId: ${worker.terminalId || "未取得"}
- reason: ${worker.reason || "なし"}

### Auto Loop
- mode: ${autoLoop.mode}
- phase: ${autoLoop.phase}
- turn: ${autoLoop.turn}/${autoLoop.maxTurns}
- stop reason: ${autoLoop.stopReason || "なし"}
- last action: ${autoLoop.lastAction || "なし"}
- tab context: ${autoLoop.tabContextStatus}

### live blockers / warnings
${liveWarnings.length ? liveWarnings.map((warning) => `- ${warning}`).join("\n") : "- なし"}
`
		: `## Worker / Browser AI
- latest worker: ${latestWorkerReport.trim() ? "あり" : "未取得"}
- latest browser decision: ${latestBrowserDecision.trim() ? "あり" : "未取得"}
- Browser provider: ${browser.providerLabel}
- Browser URL: ${browser.currentUrl || "未取得"}
- Browser owner: ${browser.ownerType || "unknown"}
- Browser slot: ${browser.slotKey || "未取得"}
- Browser webContentsId: ${browser.webContentsId ?? "未取得"}
- Browser usable width: ${browser.usableWidth ?? "未取得"}
- Browser visual: ${browser.visualStatus || "UNKNOWN"}

## Worker Binding
- status: ${worker.bindingStatus}
- policy: ${worker.bindingPolicy}
- fallback used: ${worker.fallbackUsed ? "yes" : "no"}
- worker type: ${worker.workerType}
- paneId: ${worker.paneId || "未取得"}
- terminalId: ${worker.terminalId || "未取得"}
- reason: ${worker.reason || "なし"}

## Auto Loop
- mode: ${autoLoop.mode}
- phase: ${autoLoop.phase}
- turn: ${autoLoop.turn}/${autoLoop.maxTurns}
- stop reason: ${autoLoop.stopReason || "なし"}
- last action: ${autoLoop.lastAction || "なし"}
- tab context: ${autoLoop.tabContextStatus}
`;
	const targetFiles = session.targetFiles.length
		? session.targetFiles.map((path) => `- ${path}`).join("\n")
		: "未設定";
	const selectedFiles = formatSelectedFiles(session.selectedFiles);

	return `# Handoff

## 目的
${objective}

## 現在地
${currentTask}

## 完了
${completed}

## 決定事項
${browserDecision}

## 未解決
${unresolved}

## 次アクション
1. ${nextAction}

## 最新QA
${recordedQaLines || qaLines}

${recordedOutcomeSection}${recordedOutcomeSection ? "\n" : ""}${liveStateSection}

## 関連ファイル
Target Files:
${targetFiles}

Selected Files / Paths:
${selectedFiles}

## 注意点
- workspaceId: ${workspaceId || "未取得"}
- tabId: ${tabId || "未取得"}
- local.db / app-state.json は直接触らない
- Git commit / push はDoy確認後
- destructive操作は明示承認まで禁止
- cookie / token / private APIには触らない
`;
}

export function buildSendHandoffLedgerPrompt(ledger: string): string {
	return `以下は現在のDoyDeck作業タブのHandoff Ledgerです。
内容を読み取り、現在地・未解決・次アクションを整理してください。
次にWorkerへ作業指示を出す必要がある場合は、必ず「Workerへ渡す指示:」から始めてください。
完了または追加作業不要なら「次のWorker指示は不要」または「STOP」と明記してください。
Doy判断が必要な場合だけ「Doy確認事項:」を書いてください。
Doy判断が不要なら「Doy確認事項なし」と明記してください。
単なる観点リストや報告欄として「Doy確認事項」見出しを作らないでください。
docs-only指示が安全条件を満たす場合は「Doy確認事項なし」としてください。
仕様判断、UX判断、文言の最終判断、commit/push、destructive操作が必要な場合だけDoy確認事項ありにしてください。

--- Handoff Ledger ---
${ledger}`;
}

export function buildHandoffLedgerRelativePath({
	tabId,
	tabName,
}: {
	tabId: string | null;
	tabName?: string | null;
}): string {
	const tabSuffix = (tabId || "active-tab").slice(-8);
	const baseName =
		sanitizeHandoffLedgerFileName(tabName || "") ||
		sanitizeHandoffLedgerFileName(tabId || "") ||
		"active-tab";
	return `docs/doydeck/handoffs/${baseName}-${tabSuffix}.md`;
}

function sanitizeHandoffLedgerFileName(value: string): string {
	return value
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 80);
}

interface RecordedControllerChainOutcome {
	chainMode: string;
	smokeType: string;
	browserAiOnly: string;
	browserAiReviewExpected: string;
	browserAiReviewStatus: string;
	workerResponseExpected: string;
	workerResponseStatus: string;
	workerOnlySmokePassed: string;
	browserAiProvider: string;
	workerType: string;
	workerIdentityOk: string;
	chainStatus: string;
	finalDecision: string;
	nextAction: string;
	latestBrowserAiReviewStatus: string;
	latestWorkerResponseStatus: string;
	workerResponseReturnedToBrowserAi: string;
	submissionStatus: string;
	uiReflected: string;
	assistantReplyObserved: string;
	visualVerificationUsed: string;
	submissionNextRequiredAction: string;
	hasStopSignal: string;
	hasCodexInstruction: string;
	hasDoyConfirmationItems: string;
	extractedStopSignal: string;
	extractedCodexInstructionSummary: string;
	extractedDoyConfirmationItems: string;
	notes: string;
	autoLoop: string;
	completedAt: string;
}

function isWorkerOnlyRecordedOutcome(
	recordedOutcome: RecordedControllerChainOutcome,
): boolean {
	const chainMode = recordedOutcome.chainMode || "browser-worker-review";
	const smokeType = recordedOutcome.smokeType || "";
	return (
		chainMode === "worker-only" ||
		chainMode === "noop-smoke" ||
		chainMode === "preflight-smoke" ||
		smokeType === "worker-noop" ||
		smokeType === "noop-smoke" ||
		recordedOutcome.workerOnlySmokePassed === "true"
	);
}

function formatRecordedOutcomeQaLines(
	recordedOutcome: RecordedControllerChainOutcome,
): string {
	if (isWorkerOnlyRecordedOutcome(recordedOutcome)) {
		const workerOnlySmokeStatus =
			recordedOutcome.workerOnlySmokePassed === "true" ||
			recordedOutcome.chainStatus === "PASS"
				? "PASS"
				: "recorded";
		return [
			`- status: ${recordedOutcome.chainStatus || "RECORDED"}`,
			`- Chain mode: ${recordedOutcome.chainMode || "worker-only"}`,
			recordedOutcome.smokeType
				? `- Smoke type: ${recordedOutcome.smokeType}`
			: "",
			"- Browser AI review: not expected",
			`- Worker response: ${recordedOutcome.latestWorkerResponseStatus || "未取得"}`,
			`- Worker-only smoke: ${workerOnlySmokeStatus}`,
			`- Auto Loop: ${recordedOutcome.autoLoop || "未取得"}`,
		]
			.filter(Boolean)
			.join("\n");
	}
	return [
		`- status: ${recordedOutcome.chainStatus || "RECORDED"}`,
		`- Chain mode: ${recordedOutcome.chainMode || "browser-worker-review"}`,
		`- Browser AI review expected: ${recordedOutcome.browserAiReviewExpected || "true"}`,
		`- Browser AI review: ${recordedOutcome.latestBrowserAiReviewStatus || "未取得"}`,
		`- Worker response expected: ${recordedOutcome.workerResponseExpected || "true"}`,
		`- Worker response: ${recordedOutcome.latestWorkerResponseStatus || "未取得"}`,
		`- Worker response returned to Browser AI: ${recordedOutcome.workerResponseReturnedToBrowserAi || "未取得"}`,
		`- Browser AI submission: ${recordedOutcome.submissionStatus || "未取得"}`,
		`- Browser AI UI reflected: ${recordedOutcome.uiReflected || "未取得"}`,
		`- Browser AI assistant reply observed: ${recordedOutcome.assistantReplyObserved || "未取得"}`,
		`- Browser AI visual verification: ${recordedOutcome.visualVerificationUsed || "未取得"}`,
		`- Worker-only smoke passed: ${recordedOutcome.workerOnlySmokePassed || "false"}`,
		`- STOP: ${recordedOutcome.hasStopSignal || "false"}`,
		`- Codex instruction: ${recordedOutcome.hasCodexInstruction || "false"}`,
		`- Doy confirmation: ${recordedOutcome.hasDoyConfirmationItems || "false"}`,
		`- Auto Loop: ${recordedOutcome.autoLoop || "未取得"}`,
	].join("\n");
}

function formatRecordedOutcomeSection(
	recordedOutcome: RecordedControllerChainOutcome,
): string {
	if (isWorkerOnlyRecordedOutcome(recordedOutcome)) {
		const workerOnlySmokeStatus =
			recordedOutcome.workerOnlySmokePassed === "true" ||
			recordedOutcome.chainStatus === "PASS"
				? "PASS"
				: "recorded";
		return `## 記録済みController Chain Outcome
- chainStatus: ${recordedOutcome.chainStatus || "RECORDED"}
- chainMode: ${recordedOutcome.chainMode || "worker-only"}
${recordedOutcome.smokeType ? `- smokeType: ${recordedOutcome.smokeType}` : ""}
- Browser AI review: not expected
- Worker response: ${recordedOutcome.latestWorkerResponseStatus || "未取得"}
- Worker-only smoke: ${workerOnlySmokeStatus}
- nextAction: ${recordedOutcome.nextAction || "STOP / 追加Worker指示不要"}
- recorded worker type: ${recordedOutcome.workerType || "未取得"}
- recorded workerIdentityOk: ${recordedOutcome.workerIdentityOk || "未取得"}
- Auto Loop at record time: ${recordedOutcome.autoLoop || "未取得"}
- completedAt / recordedAt: ${recordedOutcome.completedAt || "未取得"}
${recordedOutcome.notes ? `- notes: ${recordedOutcome.notes}` : ""}
`;
	}
	return `## 記録済みController Chain Outcome
- chainStatus: ${recordedOutcome.chainStatus || "RECORDED"}
- finalDecision: ${recordedOutcome.finalDecision || "記録済み"}
- nextAction: ${recordedOutcome.nextAction || "未取得"}
- Chain mode: ${recordedOutcome.chainMode || "browser-worker-review"}
${recordedOutcome.smokeType ? `- Smoke type: ${recordedOutcome.smokeType}` : ""}
- Browser AI review expected: ${recordedOutcome.browserAiReviewExpected || "true"}
- Browser AI review result: ${recordedOutcome.latestBrowserAiReviewStatus || "未取得"}
- Worker response expected: ${recordedOutcome.workerResponseExpected || "true"}
- Worker response result: ${recordedOutcome.latestWorkerResponseStatus || "未取得"}
- Worker response returned to Browser AI: ${recordedOutcome.workerResponseReturnedToBrowserAi || "未取得"}
- Browser AI submission status: ${recordedOutcome.submissionStatus || "未取得"}
- Browser AI UI reflected: ${recordedOutcome.uiReflected || "未取得"}
- Browser AI assistant reply observed: ${recordedOutcome.assistantReplyObserved || "未取得"}
- Browser AI visual verification used: ${recordedOutcome.visualVerificationUsed || "未取得"}
${recordedOutcome.submissionNextRequiredAction ? `- Browser AI submission next action: ${recordedOutcome.submissionNextRequiredAction}` : ""}
- Worker-only smoke passed: ${recordedOutcome.workerOnlySmokePassed || "false"}
- Browser-AI-only: ${recordedOutcome.browserAiOnly || "false"}
- STOP / 次のCodex指示不要: ${recordedOutcome.hasStopSignal === "true" ? recordedOutcome.extractedStopSignal || "true" : "false"}
- Codex instruction: ${recordedOutcome.hasCodexInstruction || "false"}
- Doy confirmation: ${recordedOutcome.hasDoyConfirmationItems || "false"}
- recorded Browser provider: ${recordedOutcome.browserAiProvider || "未取得"}
- recorded worker type: ${recordedOutcome.workerType || "未取得"}
- recorded workerIdentityOk: ${recordedOutcome.workerIdentityOk || "未取得"}
- Auto Loop at record time: ${recordedOutcome.autoLoop || "未取得"}
- completedAt / recordedAt: ${recordedOutcome.completedAt || "未取得"}
${recordedOutcome.notes ? `- notes: ${recordedOutcome.notes}` : ""}
`;
}

function extractLatestControllerChainOutcome(
	session: CommanderSession,
): RecordedControllerChainOutcome | null {
	const combined = [
		session.intentNotes,
		session.completionCriteria,
		session.implementationPlan,
		session.testPlan,
		session.risksOpenQuestions,
	]
		.filter(Boolean)
		.join("\n\n");
	const sections = combined.split("--- Controller Chain Outcome ---").slice(1);
	const latest = sections[sections.length - 1]?.trim();
	if (!latest) return null;
	const readLine = (key: string) => {
		const match = latest.match(new RegExp(`^- ${key}:\\s*(.*)$`, "m"));
		return match?.[1]?.trim() ?? "";
	};
	return {
		chainMode: readLine("chainMode"),
		smokeType: readLine("smokeType"),
		browserAiOnly: readLine("browserAiOnly"),
		browserAiReviewExpected: readLine("browserAiReviewExpected"),
		browserAiReviewStatus: readLine("browserAiReviewStatus"),
		workerResponseExpected: readLine("workerResponseExpected"),
		workerResponseStatus: readLine("workerResponseStatus"),
		workerOnlySmokePassed: readLine("workerOnlySmokePassed"),
		browserAiProvider: readLine("browserAiProvider"),
		workerType: readLine("workerType"),
		workerIdentityOk: readLine("workerIdentityOk"),
		chainStatus: readLine("chainStatus"),
		finalDecision: readLine("finalDecision"),
		nextAction: readLine("nextAction"),
		latestBrowserAiReviewStatus: readLine("latestBrowserAiReviewStatus"),
		latestWorkerResponseStatus: readLine("latestWorkerResponseStatus"),
		workerResponseReturnedToBrowserAi: readLine(
			"workerResponseReturnedToBrowserAi",
		),
		submissionStatus: readLine("submissionStatus"),
		uiReflected: readLine("uiReflected"),
		assistantReplyObserved: readLine("assistantReplyObserved"),
		visualVerificationUsed: readLine("visualVerificationUsed"),
		submissionNextRequiredAction: readLine("submissionNextRequiredAction"),
		hasStopSignal: readLine("hasStopSignal"),
		hasCodexInstruction: readLine("hasCodexInstruction"),
		hasDoyConfirmationItems: readLine("hasDoyConfirmationItems"),
		extractedStopSignal: readLine("extractedStopSignal"),
		extractedCodexInstructionSummary: readLine(
			"extractedCodexInstructionSummary",
		),
		extractedDoyConfirmationItems: readLine("extractedDoyConfirmationItems"),
		notes: readLine("notes"),
		autoLoop: readLine("autoLoop"),
		completedAt: readLine("completedAt"),
	};
}

function summarizeBlock(value: string, maxLength = 900): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength).trimEnd()}\n...`;
}

export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success("クリップボードにコピーしました");
	} catch {
		toast.error("クリップボードへのアクセスが拒否されました");
	}
}

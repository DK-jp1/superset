#!/usr/bin/env node

const lines = [
	"# DoyDeck Real Agent QA",
	"",
	"This legacy autonomous relay QA runner has been retired.",
	"DoyDeck now keeps Browser AI, Worker, artifact review, and handoff operations as explicit human-driven controller commands.",
	"",
	"Use the current targeted controller smokes instead:",
	"- getLiveReadinessSummary()",
	"- sendBrowserAiPrompt()",
	"- attachTargetFilesToBrowserAI()",
	"- sendWorkerReportedArtifactsToBrowserAI()",
	"",
	"No Browser AI send, Worker send, file mutation, or long-running automation was started by this script.",
];

console.log(lines.join("\n"));

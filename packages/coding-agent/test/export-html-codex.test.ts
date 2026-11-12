import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertCodexTranscript, exportCodexSession, findCodexTranscript } from "../src/core/export-html/codex.ts";
import type {
	CompactionEntry,
	ModelChangeEntry,
	SessionHeader,
	SessionMessageEntry,
} from "../src/core/session-manager.ts";

interface TreeNode {
	entry: { id: string };
	children: TreeNode[];
}

interface TreeApi {
	buildTree: () => TreeNode[];
	buildActivePathIds: (targetId: string) => Set<string>;
	getPath: (targetId: string) => Array<{ id: string }>;
}

function loadTreeApi(html: string): TreeApi {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	const viewer = scripts.pop();
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: {
			getElementById: () => ({ textContent: sessionData }),
			querySelector: () => null,
		},
		window: { location: { search: "" } },
	});
	return runInContext(
		viewer.replace(
			"let treeNodeMap = null;",
			"let treeNodeMap = null; return { buildTree, buildActivePathIds, getPath };",
		),
		context,
	);
}

describe("export-html-codex", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-codex-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("findCodexTranscript", () => {
		it("resolves direct file path", () => {
			const directFile = join(tempDir, "rollout-direct.jsonl");
			writeFileSync(directFile, '{"type":"session_meta","payload":{"id":"abc"}}\n');
			expect(findCodexTranscript(directFile)).toBe(directFile);
		});

		it("finds transcript by session id in CODEX_HOME sessions directory", () => {
			const codexHome = join(tempDir, "codex-home");
			const dayDir = join(codexHome, "sessions", "2026", "11", "11");
			mkdirSync(dayDir, { recursive: true });
			const sessionId = "01a1cbd0-afbe-7dd1-bacd-1a415f11751a";
			const sessionFile = join(dayDir, `rollout-2026-11-11T10-13-33-${sessionId}.jsonl`);
			writeFileSync(sessionFile, `{"type":"session_meta","payload":{"id":"${sessionId}"}}\n`);

			const prevEnv = process.env.CODEX_HOME;
			try {
				process.env.CODEX_HOME = codexHome;
				expect(findCodexTranscript(sessionId)).toBe(sessionFile);
				expect(findCodexTranscript(`${sessionId}.jsonl`)).toBe(sessionFile);
				expect(findCodexTranscript(`rollout-2026-11-11T10-13-33-${sessionId}`)).toBe(sessionFile);
			} finally {
				process.env.CODEX_HOME = prevEnv;
			}
		});

		it("throws when session transcript is not found", () => {
			expect(() => findCodexTranscript("non-existent-codex-session-id")).toThrow("Codex session not found");
		});
	});

	describe("convertCodexTranscript", () => {
		it("converts Codex records into Pi session v3 entries with expanded exec tools, skills, and token usage", () => {
			const records = [
				{
					timestamp: "2026-11-11T18:13:33.000Z",
					type: "session_meta",
					payload: {
						id: "01a1cbd0-test",
						timestamp: "2026-11-11T18:13:33.000Z",
						cwd: "C:\\repo\\project",
						model_provider: "openai",
					},
				},
				{
					timestamp: "2026-11-11T18:13:33.100Z",
					type: "turn_context",
					payload: {
						turn_id: "turn-1",
						cwd: "C:\\repo\\project",
						model: "gpt-6.1-sol",
					},
				},
				{
					timestamp: "2026-11-11T18:13:33.200Z",
					type: "event_msg",
					payload: {
						type: "task_started",
						turn_id: "turn-1",
					},
				},
				{
					timestamp: "2026-11-11T18:13:33.300Z",
					type: "response_item",
					payload: {
						type: "message",
						role: "user",
						content: [
							{
								type: "input_text",
								text: "# AGENTS.md instructions for C:\\repo\\project\n\n<INSTRUCTIONS>\nFollow rules.\n</INSTRUCTIONS>",
							},
							{
								type: "input_text",
								text: "<environment_context>\n  <cwd>C:\\repo\\project</cwd>\n</environment_context>",
							},
						],
						internal_chat_message_metadata_passthrough: {
							turn_id: "turn-1",
							content_item_kinds: ["agents_md.instructions", "environments.environment_context"],
						},
					},
				},
				{
					timestamp: "2026-11-11T18:13:33.400Z",
					type: "response_item",
					payload: {
						id: "msg-user-1",
						type: "message",
						role: "user",
						content: [
							{
								type: "input_text",
								text: "Use $propose-plan to inspect and update src/index.ts",
							},
						],
					},
				},
				{
					timestamp: "2026-11-11T18:13:33.500Z",
					type: "response_item",
					payload: {
						id: "msg-skill-1",
						type: "message",
						role: "user",
						content: [
							{
								type: "input_text",
								text: "<skill>\n<name>propose-plan</name>\n<path>C:\\Users\\test\\.agents\\skills\\propose-plan\\SKILL.md</path>\n# Propose Plan\nSubmit plan.\n</skill>",
							},
						],
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.000Z",
					type: "response_item",
					payload: {
						id: "rs-1",
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Inspecting repository files**" }],
						content: null,
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.100Z",
					type: "response_item",
					payload: {
						id: "msg-commentary-1",
						type: "message",
						role: "assistant",
						phase: "commentary",
						content: [{ type: "output_text", text: "I will check `src/index.ts` and apply the update." }],
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.200Z",
					type: "response_item",
					payload: {
						id: "call-item-1",
						type: "custom_tool_call",
						status: "completed",
						call_id: "call-exec-1",
						name: "exec",
						input: 'await tools.exec_command({ cmd: "git status -s" });',
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.300Z",
					type: "event_msg",
					payload: {
						type: "item_completed",
						turn_id: "turn-1",
						item: {
							type: "CommandExecution",
							id: "cmd-1",
							command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "git status -s"],
							parsed_cmd: [{ type: "unknown", cmd: "git status -s" }],
							aggregated_output: "M src/index.ts\r\n",
							exit_code: 0,
							status: "completed",
						},
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.400Z",
					type: "event_msg",
					payload: {
						type: "item_completed",
						turn_id: "turn-1",
						item: {
							type: "FileChange",
							id: "patch-1",
							changes: {
								"c:\\REPO\\project\\src\\index.ts": {
									type: "update",
									unified_diff: "@@ -1,1 +1,1 @@\n-export const v = 1;\n+export const v = 2;\n",
								},
								"C:\\repo\\project\\src\\new.ts": {
									type: "add",
									content: "export const created = true;\n",
								},
							},
							status: "completed",
						},
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.500Z",
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "call-exec-1",
						output: [
							{
								type: "input_text",
								text: "Script completed\nWall time 0.1 seconds",
							},
						],
					},
				},
				{
					timestamp: "2026-11-11T18:13:34.600Z",
					type: "token_usage_record",
					payload: {
						usage: {
							input_tokens: 1000,
							cached_input_tokens: 800,
							cache_write_input_tokens: 50,
							output_tokens: 120,
							reasoning_output_tokens: 40,
							total_tokens: 1120,
						},
					},
				},
				{
					timestamp: "2026-11-11T18:13:35.000Z",
					type: "response_item",
					payload: {
						id: "msg-final-1",
						type: "message",
						role: "assistant",
						phase: "final_answer",
						content: [
							{
								type: "output_text",
								text: "<proposed_plan>\n# Plan Title\n\nUpdated `src/index.ts`.\n</proposed_plan>",
							},
						],
					},
				},
			];

			const entries = convertCodexTranscript(records);

			const header = entries[0] as SessionHeader;
			expect(header.type).toBe("session");
			expect(header.version).toBe(3);
			expect(header.id).toBe("01a1cbd0-test");
			expect(header.cwd).toBe("C:\\repo\\project");

			// Harness-injected user message was skipped; skill block merged into user message
			const userEntries = entries.filter(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "user",
			);
			expect(userEntries).toHaveLength(1);
			expect(userEntries[0].id).toBe("msg-user-1");
			if (userEntries[0].message.role === "user") {
				expect(userEntries[0].message.content).toEqual([
					{
						type: "text",
						text: '<skill name="propose-plan" location="C:\\Users\\test\\.agents\\skills\\propose-plan\\SKILL.md">\n# Propose Plan\nSubmit plan.\n</skill>\n\nUse $propose-plan to inspect and update src/index.ts',
					},
				]);
			}

			// Model change entry created before first assistant message
			const modelEntry = entries.find((e) => e.type === "model_change") as ModelChangeEntry;
			expect(modelEntry).toBeDefined();
			expect(modelEntry.provider).toBe("openai");
			expect(modelEntry.modelId).toBe("gpt-6.1-sol");
			expect(modelEntry.parentId).toBe("msg-user-1");

			// First assistant turn combines reasoning, commentary, and expanded tool calls
			const asst1 = entries.find((e) => e.type === "message" && e.id === "rs-1") as SessionMessageEntry;
			expect(asst1).toBeDefined();
			expect(asst1.parentId).toBe(modelEntry.id);
			if (asst1.message.role === "assistant") {
				expect(asst1.message.content).toEqual([
					{ type: "thinking", thinking: "**Inspecting repository files**" },
					{ type: "text", text: "I will check `src/index.ts` and apply the update." },
					{
						type: "toolCall",
						id: "cmd-1",
						name: "bash",
						arguments: { command: "git status -s" },
					},
					{
						type: "toolCall",
						id: "patch-1-1",
						name: "edit",
						arguments: { path: "src/index.ts" },
					},
					{
						type: "toolCall",
						id: "patch-1-2",
						name: "write",
						arguments: { path: "src/new.ts", content: "export const created = true;" },
					},
				]);
				expect(asst1.message.usage).toEqual({
					input: 150,
					output: 120,
					cacheRead: 800,
					cacheWrite: 50,
					reasoning: 40,
					totalTokens: 1120,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				});
			}

			// Check expanded tool results
			const toolResults = entries.filter(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "toolResult",
			);
			expect(toolResults).toHaveLength(3);
			if (toolResults[0].message.role === "toolResult") {
				expect(toolResults[0].message.toolName).toBe("bash");
				expect(toolResults[0].message.content).toEqual([{ type: "text", text: "M src/index.ts" }]);
			}
			if (toolResults[1].message.role === "toolResult") {
				expect(toolResults[1].message.toolName).toBe("edit");
				const details = toolResults[1].message.details as { diff?: string } | undefined;
				expect(details?.diff).toBe("@@ -1,1 +1,1 @@\n-export const v = 1;\n+export const v = 2;");
			}
			if (toolResults[2].message.role === "toolResult") {
				expect(toolResults[2].message.toolName).toBe("write");
				expect(toolResults[2].message.isError).toBe(false);
			}

			// Final answer stripped <proposed_plan> wrapper
			const asstFinal = entries.find((e) => e.type === "message" && e.id === "msg-final-1") as SessionMessageEntry;
			expect(asstFinal).toBeDefined();
			if (asstFinal.message.role === "assistant") {
				expect(asstFinal.message.content).toEqual([
					{ type: "text", text: "# Plan Title\n\nUpdated `src/index.ts`." },
				]);
			}
		});

		it("relativizes Windows paths case-insensitively and keeps POSIX case distinct", () => {
			const records = [
				{
					type: "session_meta",
					payload: { id: "sess-paths", cwd: "/work/project" },
				},
				{
					type: "response_item",
					payload: {
						id: "call-paths",
						type: "custom_tool_call",
						call_id: "call-paths",
						name: "exec",
						input: "await tools.apply_patch();",
					},
				},
				{
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: {
							type: "FileChange",
							id: "patch-paths",
							changes: {
								"/work/project/src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n" },
								"/work/Project/src/b.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n" },
							},
							status: "completed",
						},
					},
				},
				{
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "call-paths",
						output: "ok",
					},
				},
			];

			const entries = convertCodexTranscript(records);
			const assistant = entries.find(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "assistant",
			);
			expect(assistant).toBeDefined();
			if (assistant?.message.role === "assistant") {
				expect(assistant.message.content).toEqual([
					{ type: "toolCall", id: "patch-paths", name: "edit", arguments: { path: "src/a.ts" } },
					{
						type: "toolCall",
						id: "patch-paths-1",
						name: "edit",
						arguments: { path: "/work/Project/src/b.ts" },
					},
				]);
			}
		});

		it("handles failed exec calls before item_completed, function_call, compaction, and turn_aborted", () => {
			const records = [
				{
					type: "session_meta",
					payload: { id: "sess-fallback", cwd: "/workspace", model_provider: "openai" },
				},
				{
					type: "turn_context",
					payload: { model: "gpt-5.4", cwd: "/workspace" },
				},
				{
					type: "response_item",
					payload: {
						id: "u-1",
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Run command and ask question" }],
					},
				},
				{
					type: "response_item",
					payload: {
						id: "c-1",
						type: "custom_tool_call",
						call_id: "call-fail-1",
						name: "exec",
						input: 'await tools.exec_command({ cmd: "rm -rf /", sandbox_permissions: "require_escalated" });',
					},
				},
				{
					type: "response_item",
					payload: {
						type: "custom_tool_call_output",
						call_id: "call-fail-1",
						output: [
							{
								type: "input_text",
								text: "Script error:\nexec_command failed: sandbox policy prohibited escalation",
							},
						],
					},
				},
				{
					type: "response_item",
					payload: {
						id: "f-1",
						type: "function_call",
						call_id: "call-q-1",
						name: "request_user_input",
						arguments: JSON.stringify({ questions: [{ id: "q1", question: "Proceed?" }] }),
					},
				},
				{
					type: "response_item",
					payload: {
						type: "function_call_output",
						call_id: "call-q-1",
						output: JSON.stringify({ answers: { q1: { answers: ["Yes"] } } }),
					},
				},
				{
					type: "event_msg",
					payload: {
						type: "turn_aborted",
						reason: "interrupted",
					},
				},
				{
					type: "response_item",
					payload: {
						id: "comp-1",
						type: "compaction",
						summary: "Compacted earlier context",
						tokens_before: 12000,
					},
				},
			];

			const entries = convertCodexTranscript(records);
			const toolResults = entries.filter(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "toolResult",
			);
			expect(toolResults).toHaveLength(2);
			if (toolResults[0].message.role === "toolResult") {
				expect(toolResults[0].message.toolName).toBe("bash");
				expect(toolResults[0].message.isError).toBe(true);
				expect(toolResults[0].message.content).toEqual([
					{ type: "text", text: "exec_command failed: sandbox policy prohibited escalation" },
				]);
			}
			if (toolResults[1].message.role === "toolResult") {
				expect(toolResults[1].message.toolName).toBe("request_user_input");
				expect(toolResults[1].message.isError).toBe(false);
			}

			const assistants = entries.filter(
				(e): e is SessionMessageEntry => e.type === "message" && e.message.role === "assistant",
			);
			expect(assistants).toHaveLength(2);
			if (assistants[1].message.role === "assistant") {
				expect(assistants[1].message.stopReason).toBe("aborted");
			}

			const compaction = entries.find((e): e is CompactionEntry => e.type === "compaction");
			expect(compaction).toBeDefined();
			expect(compaction?.summary).toBe("Compacted earlier context");
			expect(compaction?.tokensBefore).toBe(12000);
		});
	});

	describe("exportCodexSession", () => {
		it("generates an HTML file that renders a valid session tree and supports themes", async () => {
			const sessionPath = join(tempDir, "rollout-2026-11-11T10-13-33-01a1cbd0-test.jsonl");
			const outZenburn = join(tempDir, "zenburn.html");
			const outSystem = join(tempDir, "system.html");
			const lines = [
				JSON.stringify({
					timestamp: "2026-11-11T18:13:33.000Z",
					type: "session_meta",
					payload: {
						id: "01a1cbd0-test",
						timestamp: "2026-11-11T18:13:33.000Z",
						cwd: tempDir,
						model_provider: "openai",
					},
				}),
				JSON.stringify({
					timestamp: "2026-11-11T18:13:34.000Z",
					type: "turn_context",
					payload: {
						model: "gpt-6.1-sol",
						cwd: tempDir,
					},
				}),
				JSON.stringify({
					timestamp: "2026-11-11T18:13:35.000Z",
					type: "response_item",
					payload: {
						id: "u-1",
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hello Codex" }],
					},
				}),
				JSON.stringify({
					timestamp: "2026-11-11T18:13:36.000Z",
					type: "response_item",
					payload: {
						id: "a-1",
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Hello from Codex!" }],
					},
				}),
			];
			writeFileSync(sessionPath, lines.join("\n"));

			const resultPath = await exportCodexSession(sessionPath, outZenburn);
			expect(resultPath).toBe(outZenburn);

			const html = readFileSync(outZenburn, "utf-8");
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain("--body-bg: #1f1f1f;");

			const api = loadTreeApi(html);
			const tree = api.buildTree();
			expect(tree.length).toBeGreaterThan(0);
			const path = api.getPath("a-1");
			expect(path.map((p) => p.id)).toContain("u-1");
			expect(path.map((p) => p.id)).toContain("a-1");

			await exportCodexSession(sessionPath, {
				outputPath: outSystem,
				themeName: "system",
			});
			const systemHtml = readFileSync(outSystem, "utf-8");
			expect(systemHtml).not.toContain("--body-bg: #1f1f1f;");
		});
	});
});

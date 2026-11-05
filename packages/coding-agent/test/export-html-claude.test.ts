import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertClaudeTranscript, exportClaudeSession, findClaudeTranscript } from "../src/core/export-html/claude.ts";
import type { ModelChangeEntry, SessionHeader, SessionMessageEntry } from "../src/core/session-manager.ts";

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

describe("export-html-claude", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-claude-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("findClaudeTranscript", () => {
		it("resolves direct file path", () => {
			const directFile = join(tempDir, "direct-session.jsonl");
			writeFileSync(directFile, '{"type":"mode","sessionId":"abc"}\n');
			expect(findClaudeTranscript(directFile)).toBe(directFile);
		});

		it("finds transcript by session id in CLAUDE_CONFIG_DIR projects directory", () => {
			const claudeHome = join(tempDir, "claude-home");
			const projectDir = join(claudeHome, "projects", "my-project");
			mkdirSync(projectDir, { recursive: true });
			const sessionFile = join(projectDir, "test-session-123.jsonl");
			writeFileSync(sessionFile, '{"sessionId":"test-session-123"}\n');

			const prevEnv = process.env.CLAUDE_CONFIG_DIR;
			try {
				process.env.CLAUDE_CONFIG_DIR = claudeHome;
				expect(findClaudeTranscript("test-session-123")).toBe(sessionFile);
				expect(findClaudeTranscript("test-session-123.jsonl")).toBe(sessionFile);
			} finally {
				process.env.CLAUDE_CONFIG_DIR = prevEnv;
			}
		});

		it("throws when session transcript is not found", () => {
			expect(() => findClaudeTranscript("non-existent-session-id")).toThrow("Claude session not found");
		});
	});

	describe("convertClaudeTranscript", () => {
		it("converts transcript records into Pi session v3 entries with proper re-parenting", () => {
			const records = [
				{
					type: "mode",
					sessionId: "sess-001",
					timestamp: "2026-10-26T20:00:00.000Z",
					cwd: "/test/cwd",
				},
				{
					type: "cost-state",
					sessionId: "sess-001",
				},
				{
					uuid: "msg-user-1",
					parentUuid: null,
					type: "user",
					timestamp: "2026-10-26T20:01:00.000Z",
					message: {
						role: "user",
						content: "Please check the readme and edit line 1.",
					},
				},
				{
					uuid: "snap-1",
					parentUuid: "msg-user-1",
					type: "file-history-snapshot",
				},
				{
					uuid: "msg-asst-1",
					parentUuid: "snap-1",
					type: "assistant",
					timestamp: "2026-10-26T20:02:00.000Z",
					message: {
						id: "claude-turn-1",
						model: "claude-sonnet-4-5",
						content: [
							{ type: "thinking", thinking: "I will read the file first." },
							{
								type: "tool_use",
								id: "toolu-read-1",
								name: "Read",
								input: { file_path: "README.md" },
							},
						],
						usage: {
							input_tokens: 150,
							output_tokens: 45,
							cache_read_input_tokens: 10,
							cache_creation_input_tokens: 5,
						},
					},
				},
				{
					uuid: "msg-toolres-1",
					parentUuid: "msg-asst-1",
					type: "user",
					timestamp: "2026-10-26T20:02:05.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu-read-1",
								content: "   1\t# Readme Title\n   2\tContent here",
								is_error: false,
							},
						],
					},
				},
				{
					uuid: "msg-asst-2",
					parentUuid: "msg-toolres-1",
					type: "assistant",
					timestamp: "2026-10-26T20:02:10.000Z",
					message: {
						id: "claude-turn-2",
						model: "claude-sonnet-4-5",
						content: [
							{
								type: "tool_use",
								id: "toolu-edit-1",
								name: "Edit",
								input: {
									file_path: "README.md",
									old_string: "# Readme Title",
									new_string: "# Updated Title",
								},
							},
						],
					},
				},
				{
					uuid: "msg-toolres-2",
					parentUuid: "msg-asst-2",
					type: "user",
					timestamp: "2026-10-26T20:02:15.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu-edit-1",
								content: "File updated successfully.",
								is_error: false,
							},
						],
					},
				},
			];

			const entries = convertClaudeTranscript(records);

			// First entry must be SessionHeader
			const header = entries[0] as SessionHeader;
			expect(header.type).toBe("session");
			expect(header.version).toBe(3);
			expect(header.id).toBe("sess-001");
			expect(header.cwd).toBe("/test/cwd");

			// Check user message
			const userEntry = entries.find((e) => e.type === "message" && e.id === "msg-user-1") as SessionMessageEntry;
			expect(userEntry).toBeDefined();
			expect(userEntry.parentId).toBeNull();
			expect(userEntry.message.role).toBe("user");

			// Check model change entry created before assistant
			const modelEntry = entries.find((e) => e.type === "model_change") as ModelChangeEntry;
			expect(modelEntry).toBeDefined();
			expect(modelEntry.modelId).toBe("claude-sonnet-4-5");
			expect(modelEntry.parentId).toBe("msg-user-1");

			// Assistant entry should be parented on model change
			const asst1 = entries.find((e) => e.type === "message" && e.id === "msg-asst-1") as SessionMessageEntry;
			expect(asst1).toBeDefined();
			expect(asst1.parentId).toBe(modelEntry.id);
			expect(asst1.message.role).toBe("assistant");
			if (asst1.message.role === "assistant") {
				expect(asst1.message.content).toEqual([
					{ type: "thinking", thinking: "I will read the file first." },
					{
						type: "toolCall",
						id: "toolu-read-1",
						name: "read",
						arguments: { path: "README.md" },
					},
				]);
				expect(asst1.message.usage).toEqual({
					input: 150,
					output: 45,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 210,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				});
			}

			// Read tool result stripped line number prefixes
			const readRes = entries.find((e) => e.type === "message" && e.id === "msg-toolres-1") as SessionMessageEntry;
			expect(readRes).toBeDefined();
			expect(readRes.message.role).toBe("toolResult");
			if (readRes.message.role === "toolResult") {
				expect(readRes.message.toolName).toBe("read");
				expect(readRes.message.content).toEqual([{ type: "text", text: "# Readme Title\nContent here" }]);
			}

			// Edit tool result has diff details
			const editRes = entries.find((e) => e.type === "message" && e.id === "msg-toolres-2") as SessionMessageEntry;
			expect(editRes).toBeDefined();
			expect(editRes.message.role).toBe("toolResult");
			if (editRes.message.role === "toolResult") {
				expect(editRes.message.toolName).toBe("edit");
				const details = editRes.message.details as { diff?: string } | undefined;
				expect(details?.diff).toBe("-# Readme Title\n+# Updated Title");
			}
		});

		it("handles bash execution pairs", () => {
			const records = [
				{
					uuid: "u1",
					type: "user",
					timestamp: "2026-10-26T20:00:00.000Z",
					message: {
						role: "user",
						content: "<bash-input>git status</bash-input>",
					},
				},
				{
					uuid: "u2",
					parentUuid: "u1",
					type: "user",
					timestamp: "2026-10-26T20:00:01.000Z",
					message: {
						role: "user",
						content: "<bash-stdout>On branch main\nnothing to commit</bash-stdout>",
					},
				},
			];

			const entries = convertClaudeTranscript(records);
			const bashEntry = entries.find((e) => e.type === "message") as SessionMessageEntry;
			expect(bashEntry).toBeDefined();
			expect(bashEntry.message.role).toBe("bashExecution");
			if (bashEntry.message.role === "bashExecution") {
				expect(bashEntry.message.command).toBe("git status");
				expect(bashEntry.message.output).toBe("On branch main\nnothing to commit");
			}
		});

		it("drops resubmitted prompts that got no response", () => {
			const assistant = (uuid: string, parentUuid: string | null) => ({
				uuid,
				parentUuid,
				type: "assistant",
				timestamp: "2026-10-26T20:00:00.000Z",
				message: { id: `turn-${uuid}`, model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }] },
			});
			const user = (uuid: string, parentUuid: string) => ({
				uuid,
				parentUuid,
				type: "user",
				timestamp: "2026-10-26T20:00:01.000Z",
				message: { role: "user", content: "Same question" },
			});
			const records = [
				assistant("a1", null),
				user("u1", "a1"),
				{ uuid: "att1", parentUuid: "u1", type: "attachment" },
				user("u2", "a1"),
				assistant("a2", "u2"),
			];

			const entries = convertClaudeTranscript(records);
			const ids = entries.map((e) => (e.type === "session" ? null : e.id));
			expect(ids).not.toContain("u1");
			expect(ids).toContain("u2");

			const childCounts = new Map<string, number>();
			for (const e of entries) {
				if (e.type === "session" || e.parentId === null) continue;
				childCounts.set(e.parentId, (childCounts.get(e.parentId) ?? 0) + 1);
			}
			expect(Math.max(...childCounts.values())).toBe(1);
		});

		it("keeps a trailing user prompt with no reply", () => {
			const records = [
				{
					uuid: "u1",
					parentUuid: null,
					type: "user",
					timestamp: "2026-10-26T20:00:00.000Z",
					message: { role: "user", content: "Anyone there?" },
				},
			];

			const entries = convertClaudeTranscript(records);
			expect(entries.some((e) => e.type === "message" && e.id === "u1")).toBe(true);
		});
	});

	describe("persisted tool output expansion", () => {
		const toolResultRecords = (text: string) => [
			{ type: "mode", sessionId: "sess-p", timestamp: "2026-10-26T20:00:00.000Z", cwd: "/test" },
			{
				uuid: "a-1",
				parentUuid: null,
				type: "assistant",
				timestamp: "2026-10-26T20:00:01.000Z",
				message: {
					id: "turn-1",
					model: "claude-opus-5-5",
					content: [{ type: "tool_use", id: "toolu-1", name: "Bash", input: { command: "ls" } }],
				},
			},
			{
				uuid: "u-1",
				parentUuid: "a-1",
				type: "user",
				timestamp: "2026-10-26T20:00:02.000Z",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu-1", content: text }],
				},
			},
		];

		const resultText = (records: unknown[], transcriptPath?: string): string => {
			const entries = convertClaudeTranscript(records, transcriptPath);
			const result = entries.find((e) => e.type === "message" && e.message.role === "toolResult") as
				| SessionMessageEntry
				| undefined;
			const content = result?.message.role === "toolResult" ? result.message.content[0] : undefined;
			return content?.type === "text" ? content.text : "";
		};

		const setupSession = () => {
			const transcriptPath = join(tempDir, "sess-p.jsonl");
			const toolResultsDir = join(tempDir, "sess-p", "tool-results");
			mkdirSync(toolResultsDir, { recursive: true });
			return { transcriptPath, toolResultsDir };
		};

		it("expands files inside the session's tool-results directory", () => {
			const { transcriptPath, toolResultsDir } = setupSession();
			const saved = join(toolResultsDir, "toolu-1.txt");
			writeFileSync(saved, "full output");
			expect(resultText(toolResultRecords(`truncated\nFull output saved to: ${saved}`), transcriptPath)).toBe(
				"full output",
			);
		});

		it("does not expand files outside the session's tool-results directory", () => {
			const { transcriptPath } = setupSession();
			const secret = join(tempDir, "secret.txt");
			writeFileSync(secret, "private");
			const traversal = join(tempDir, "sess-p", "tool-results", "..", "..", "secret.txt");
			for (const path of [secret, traversal]) {
				const text = resultText(toolResultRecords(`Full output saved to: ${path}`), transcriptPath);
				expect(text).not.toContain("private");
			}
		});

		it("does not expand symlinks that escape the tool-results directory", () => {
			const { transcriptPath, toolResultsDir } = setupSession();
			const secret = join(tempDir, "secret.txt");
			writeFileSync(secret, "private");
			const link = join(toolResultsDir, "link.txt");
			try {
				symlinkSync(secret, link);
			} catch {
				return; // symlinks need extra privileges on Windows
			}
			expect(resultText(toolResultRecords(`Full output saved to: ${link}`), transcriptPath)).not.toContain(
				"private",
			);
		});

		it("does not expand anything without a transcript path", () => {
			const { toolResultsDir } = setupSession();
			const saved = join(toolResultsDir, "toolu-1.txt");
			writeFileSync(saved, "full output");
			expect(resultText(toolResultRecords(`Full output saved to: ${saved}`))).not.toBe("full output");
		});
	});

	describe("exportClaudeSession", () => {
		it("generates an HTML file that renders valid session tree", async () => {
			const sessionPath = join(tempDir, "4d43fa94-test.jsonl");
			const outHtml = join(tempDir, "exported.html");
			const lines = [
				JSON.stringify({
					type: "mode",
					sessionId: "4d43fa94-test",
					timestamp: "2026-10-26T23:17:36.253Z",
					cwd: "/test",
				}),
				JSON.stringify({
					uuid: "u-1",
					parentUuid: null,
					type: "user",
					timestamp: "2026-10-26T23:17:37.000Z",
					message: { role: "user", content: "Hello Pi" },
				}),
				JSON.stringify({
					uuid: "a-1",
					parentUuid: "u-1",
					type: "assistant",
					timestamp: "2026-10-26T23:17:38.000Z",
					message: {
						id: "turn-1",
						model: "claude-opus-5-5",
						content: [{ type: "text", text: "Hello! How can I help?" }],
					},
				}),
			];
			writeFileSync(sessionPath, lines.join("\n"));

			const resultPath = await exportClaudeSession(sessionPath, outHtml);
			expect(resultPath).toBe(outHtml);

			const html = readFileSync(outHtml, "utf-8");
			expect(html).toContain("<!DOCTYPE html>");
			expect(html).toContain('<script id="session-data" type="application/json">');

			const api = loadTreeApi(html);
			const tree = api.buildTree();
			expect(tree.length).toBeGreaterThan(0);
			const path = api.getPath("a-1");
			expect(path.map((p) => p.id)).toContain("u-1");
			expect(path.map((p) => p.id)).toContain("a-1");
		});

		it("exports sessions with read tool calls on .mjs files cleanly", async () => {
			const sessionPath = join(tempDir, "read-mjs-test.jsonl");
			const outHtml = join(tempDir, "read-mjs.html");
			const lines = [
				JSON.stringify({
					type: "mode",
					sessionId: "read-mjs-test",
					timestamp: "2026-10-26T23:17:36.253Z",
					cwd: "/test",
				}),
				JSON.stringify({
					uuid: "u-1",
					parentUuid: null,
					type: "user",
					timestamp: "2026-10-26T23:17:37.000Z",
					message: { role: "user", content: "read file" },
				}),
				JSON.stringify({
					uuid: "a-1",
					parentUuid: "u-1",
					type: "assistant",
					timestamp: "2026-10-26T23:17:38.000Z",
					message: {
						id: "turn-1",
						model: "claude-opus-5-5",
						content: [
							{
								type: "tool_use",
								id: "toolu-1",
								name: "Read",
								input: { file_path: "convert.mjs" },
							},
						],
					},
				}),
				JSON.stringify({
					uuid: "u-2",
					parentUuid: "a-1",
					type: "user",
					timestamp: "2026-10-26T23:17:39.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "toolu-1",
								content: "export const name = 'test';",
								is_error: false,
							},
						],
					},
				}),
			];
			writeFileSync(sessionPath, lines.join("\n"));

			const result = await exportClaudeSession(sessionPath, outHtml);
			expect(result).toBe(outHtml);
			const html = readFileSync(outHtml, "utf-8");
			expect(html).toContain("<!DOCTYPE html>");
		});

		it("exports HTML with zenburn theme by default and supports system theme", () => {
			const sessionPath = join(tempDir, "theme-test.jsonl");
			const outZenburn = join(tempDir, "zenburn.html");
			const outSystem = join(tempDir, "system.html");

			const lines = [
				JSON.stringify({
					type: "session_start",
					uuid: "u0",
					sessionId: "theme-test",
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "user",
					uuid: "u1",
					parentUuid: "u0",
					message: { role: "user", content: "Hi" },
				}),
			];
			writeFileSync(sessionPath, lines.join("\n"));

			return Promise.all([
				exportClaudeSession(sessionPath, outZenburn).then(() => {
					const html = readFileSync(outZenburn, "utf-8");
					expect(html).toContain("--body-bg: #1f1f1f;");
					expect(html).toContain("--container-bg: #1f1f1f;");
					expect(html).toContain("--info-bg: #2a2820;");
					expect(html).toContain("--accent: #c0bed1;");
					expect(html).toContain("--text: #dcdccc;");
				}),
				exportClaudeSession(sessionPath, {
					outputPath: outSystem,
					themeName: "system",
				}).then(() => {
					const html = readFileSync(outSystem, "utf-8");
					expect(html).not.toContain("--body-bg: #1f1f1f;");
					expect(html).not.toContain("--accent: #c0bed1;");
				}),
			]);
		});
	});
});

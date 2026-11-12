// Export OpenAI Codex transcripts to Pi HTML sessions.

import { type Dirent, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	JsonObject,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { APP_NAME, expandTildePath } from "../../config.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type {
	FileEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
} from "../session-manager.ts";
import { CURRENT_SESSION_VERSION, SessionManager } from "../session-manager.ts";
import type { ExportOptions, SessionData } from "./index.ts";
import { generateHtml } from "./index.ts";

interface CodexUsage {
	input_tokens?: number;
	cached_input_tokens?: number;
	cache_write_input_tokens?: number;
	output_tokens?: number;
	reasoning_output_tokens?: number;
	total_tokens?: number;
}

interface CodexContentBlock {
	type?: string;
	text?: string;
	refusal?: string;
	image_url?: string;
}

interface CodexPassthroughMetadata {
	turn_id?: string;
	content_item_kinds?: string[];
	content_item_metadata?: Array<{
		provenance?: {
			type?: string;
		};
	}>;
}

interface CodexParsedCmd {
	type?: string;
	cmd?: string;
	name?: string;
	path?: string;
}

interface CodexFileChangeEntry {
	type?: string;
	unified_diff?: string;
	content?: string;
}

interface CodexCompletedItem {
	type?: string;
	id?: string;
	command?: string[] | string;
	parsed_cmd?: CodexParsedCmd[];
	aggregated_output?: string;
	exit_code?: number;
	status?: string;
	changes?: Record<string, CodexFileChangeEntry>;
	summary_text?: string[];
	raw_content?: string[];
}

interface CodexPayload {
	type?: string;
	id?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	timestamp?: string;
	cwd?: string;
	model_provider?: string;
	model?: string;
	role?: string;
	phase?: string;
	name?: string;
	call_id?: string;
	input?: string;
	arguments?: string;
	output?: unknown;
	action?: {
		type?: string;
		command?: string[] | string;
	};
	summary?: Array<{ type?: string; text?: string }> | string;
	content?: CodexContentBlock[] | string;
	usage?: CodexUsage;
	info?: {
		last_token_usage?: CodexUsage;
	};
	thread_settings?: {
		model?: string;
		model_provider_id?: string;
		cwd?: string;
	};
	item?: CodexCompletedItem;
	internal_chat_message_metadata_passthrough?: CodexPassthroughMetadata;
	reason?: string;
	tokens_before?: number;
}

interface CodexRecord {
	timestamp?: string;
	ordinal?: number;
	type?: string;
	payload?: CodexPayload;
}

interface PendingToolCall {
	kind: "custom" | "function" | "shell";
	id: string;
	callId: string;
	name: string;
	input: string;
	timestamp: string;
	items: CodexCompletedItem[];
}

interface ResolvedToolExecution {
	call: ToolCall;
	resultId: string;
	toolName: string;
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	details?: { diff?: string };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const SCRIPT_STATUS_HEADER = /^(Script (?:completed|failed)\nWall time [^\n]*(?:\nOutput:)?(?:\n|$))/i;
const DATA_URL = /^data:([^;,]+);base64,([\s\S]+)$/;
const SKILL_TAG =
	/^<skill>\s*\r?\n<name>([\s\S]*?)<\/name>\s*\r?\n<path>([\s\S]*?)<\/path>\s*\r?\n([\s\S]*?)\r?\n<\/skill>\s*$/;
const PROPOSED_PLAN = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g;
const HARNESS_BLOCK_PATTERNS = [
	/^# AGENTS\.md instructions for [\s\S]*$/,
	/^<environment_context>[\s\S]*<\/environment_context>$/,
	/^<permissions instructions>[\s\S]*<\/permissions instructions>$/,
	/^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/,
];
const HARNESS_ITEM_KINDS = new Set([
	"agents_md.instructions",
	"environments.environment_context",
	"permissions.instructions",
	"collaboration_mode.instructions",
]);
const HARNESS_PROVENANCE_TYPES = new Set(["agents_md", "harness"]);

/** Normalize a tool file path relative to the session cwd when inside it. */
function formatToolPath(filePath: string, cwd: string): string {
	const normFile = filePath.replace(/\\/g, "/");
	const normCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normCwd) return normFile;
	// Drive letters and backslashes are case-insensitive. POSIX paths keep their case,
	// so `/work/Project` is not inside `/work/project`.
	const windows = /\\/.test(filePath) || /\\/.test(cwd) || /^[A-Za-z]:/.test(normFile) || /^[A-Za-z]:/.test(normCwd);
	const fileKey = windows ? normFile.toLowerCase() : normFile;
	const cwdKey = windows ? normCwd.toLowerCase() : normCwd;
	if (fileKey.startsWith(`${cwdKey}/`)) {
		return normFile.slice(normCwd.length + 1);
	}
	return normFile;
}

/** Normalize CRLF and strip ANSI escapes from command or diff output. */
function cleanOutputText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(ANSI, "").trimEnd();
}

/** Convert a Codex data URL or image block into Pi ImageContent or fallback text. */
function convertImageUrl(imageUrl?: string): ImageContent | TextContent {
	if (!imageUrl) return { type: "text", text: "[image]" };
	const match = imageUrl.trim().match(DATA_URL);
	if (!match) return { type: "text", text: "[image]" };
	return {
		type: "image",
		mimeType: match[1],
		data: match[2],
	};
}

/** Convert OpenAI/Codex token usage (where input_tokens includes cached tokens) to Pi Usage. */
function convertUsage(usage: CodexUsage): Usage {
	const rawInput = usage.input_tokens || 0;
	const cacheRead = usage.cached_input_tokens || 0;
	const cacheWrite = usage.cache_write_input_tokens || 0;
	const input = Math.max(0, rawInput - cacheRead - cacheWrite);
	const output = usage.output_tokens || 0;
	const reasoning = usage.reasoning_output_tokens || 0;
	const totalTokens = usage.total_tokens || input + output + cacheRead + cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning > 0 && { reasoning }),
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

/** Extract shell command text from a Codex CommandExecution item. */
function extractCommandExecutionCmd(item: CodexCompletedItem): string {
	if (Array.isArray(item.parsed_cmd) && item.parsed_cmd.length > 0) {
		const joined = item.parsed_cmd
			.map((c) => c.cmd?.trim())
			.filter(Boolean)
			.join(" && ");
		if (joined) return joined;
	}
	if (Array.isArray(item.command) && item.command.length > 0) {
		return item.command[item.command.length - 1] ?? "";
	}
	if (typeof item.command === "string") return item.command;
	return "";
}

/** Parse a Codex `apply_patch` payload into per-file operations. */
function parseApplyPatchOperations(
	patchText: string,
	cwd: string,
): Array<{ type: "add" | "update" | "delete"; path: string; content: string }> {
	const normalized = patchText.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	const ops: Array<{ type: "add" | "update" | "delete"; path: string; lines: string[] }> = [];
	let current: { type: "add" | "update" | "delete"; path: string; lines: string[] } | null = null;

	for (const line of lines) {
		if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
			continue;
		}
		if (line.startsWith("*** Add File: ")) {
			current = { type: "add", path: formatToolPath(line.slice(14).trim(), cwd), lines: [] };
			ops.push(current);
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			current = { type: "update", path: formatToolPath(line.slice(17).trim(), cwd), lines: [] };
			ops.push(current);
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			current = { type: "delete", path: formatToolPath(line.slice(17).trim(), cwd), lines: [] };
			ops.push(current);
			continue;
		}
		if (line.startsWith("*** Move to: ") || line.startsWith("*** End of File")) {
			continue;
		}
		if (current) {
			if (current.type === "add") {
				current.lines.push(line.startsWith("+") ? line.slice(1) : line);
			} else {
				current.lines.push(line);
			}
		}
	}

	return ops.map((op) => ({
		type: op.type,
		path: op.path,
		content: op.lines.join("\n").trimEnd(),
	}));
}

/** Try to extract a patch string from a Codex `exec` JS snippet calling `tools.apply_patch(...)`. */
function extractExecApplyPatch(jsInput: string): string | undefined {
	const marker = "tools.apply_patch(";
	const idx = jsInput.indexOf(marker);
	if (idx === -1) return undefined;
	const rest = jsInput.slice(idx + marker.length).trimStart();
	if (rest.startsWith('"') || rest.startsWith("'")) {
		const quote = rest[0];
		let i = 1;
		while (i < rest.length) {
			if (rest[i] === "\\") {
				i += 2;
				continue;
			}
			if (rest[i] === quote) {
				const rawLiteral = rest.slice(0, i + 1);
				try {
					if (quote === '"') return JSON.parse(rawLiteral) as string;
				} catch {
					// fall through to manual unescape
				}
				return rest
					.slice(1, i)
					.replace(/\\n/g, "\n")
					.replace(/\\r/g, "\r")
					.replace(/\\t/g, "\t")
					.replace(/\\"/g, '"')
					.replace(/\\'/g, "'")
					.replace(/\\\\/g, "\\");
			}
			i++;
		}
	}
	return undefined;
}

/** Try to extract a command string from a Codex `exec` JS snippet calling `tools.exec_command(...)`. */
function extractExecCommandString(jsInput: string): string | undefined {
	const match = jsInput.match(
		/tools\.exec_command\(\s*\{\s*(?:"cmd"|cmd)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[\s\S]*?`)/,
	);
	if (!match) return undefined;
	const literal = match[1];
	if (literal.startsWith('"')) {
		try {
			return JSON.parse(literal) as string;
		} catch {
			return literal.slice(1, -1);
		}
	}
	if (literal.startsWith("`") || literal.startsWith("'")) {
		return literal.slice(1, -1).trim();
	}
	return undefined;
}

/** Parse raw `custom_tool_call_output` or `function_call_output` into text/image blocks and error state. */
function parseToolOutputPayload(output: unknown): {
	blocks: Array<TextContent | ImageContent>;
	isError: boolean;
} {
	const textChunks: string[] = [];
	const images: ImageContent[] = [];
	let isError = false;

	if (typeof output === "string") {
		textChunks.push(output);
	} else if (Array.isArray(output)) {
		for (const item of output) {
			if (typeof item !== "object" || item === null) continue;
			const block = item as CodexContentBlock;
			if ((block.type === "input_text" || block.type === "text") && typeof block.text === "string") {
				textChunks.push(block.text);
			} else if (block.type === "input_image" && block.image_url) {
				const converted = convertImageUrl(block.image_url);
				if (converted.type === "image") images.push(converted);
				else textChunks.push(converted.text);
			}
		}
	} else if (typeof output === "object" && output !== null) {
		textChunks.push(JSON.stringify(output, null, 2));
	}

	const cleanedParts: string[] = [];
	for (const rawChunk of textChunks) {
		let chunk = rawChunk;
		const header = chunk.match(SCRIPT_STATUS_HEADER);
		if (header) {
			if (chunk.startsWith("Script failed")) isError = true;
			chunk = chunk.slice(header[0].length);
			if (!chunk.trim()) continue;
		}
		if (chunk.startsWith("Script error:\n")) {
			isError = true;
			cleanedParts.push(cleanOutputText(chunk.slice("Script error:\n".length)));
			continue;
		}
		const embeddedError = chunk.indexOf("\nScript error:\n");
		if (embeddedError !== -1) {
			isError = true;
			const before = cleanOutputText(chunk.slice(0, embeddedError));
			const after = cleanOutputText(chunk.slice(embeddedError + "\nScript error:\n".length));
			const combined = [before, after].filter((part) => part.length > 0).join("\n");
			if (combined) cleanedParts.push(combined);
			continue;
		}
		const trimmed = chunk.trim();
		if (trimmed === "{}") continue;
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
			try {
				const parsed = JSON.parse(trimmed) as {
					output?: unknown;
					exit_code?: unknown;
					value?: { output?: unknown; exit_code?: unknown };
				};
				const exitCode = parsed.exit_code ?? parsed.value?.exit_code;
				if (typeof exitCode === "number" && exitCode !== 0) isError = true;
				const innerOutput = parsed.output ?? parsed.value?.output;
				if (typeof innerOutput === "string") {
					const cleaned = cleanOutputText(innerOutput);
					if (cleaned) cleanedParts.push(cleaned);
					continue;
				}
			} catch {
				// keep original text
			}
		}
		const cleaned = cleanOutputText(chunk);
		if (cleaned) cleanedParts.push(cleaned);
	}

	const joined = cleanedParts.join("\n").trimEnd();
	return {
		blocks: [...(joined ? [{ type: "text" as const, text: joined }] : []), ...images],
		isError,
	};
}

/** Resolve a pending Codex tool call and its output into Pi ToolCall and toolResult objects. */
function resolveToolCallExecutions(pending: PendingToolCall, rawOutput: unknown, cwd: string): ResolvedToolExecution[] {
	// 1. Expand structured CommandExecution / FileChange items emitted during `exec`
	if (pending.kind === "custom" && pending.name === "exec" && pending.items.length > 0) {
		const results: ResolvedToolExecution[] = [];
		let itemIndex = 0;

		for (const item of pending.items) {
			if (item.type === "FileChange" && item.changes) {
				for (const [rawPath, change] of Object.entries(item.changes)) {
					const path = formatToolPath(rawPath, cwd);
					const subId =
						itemIndex === 0 ? (item.id ?? pending.callId) : `${item.id ?? pending.callId}-${itemIndex}`;
					itemIndex++;
					const failed = item.status === "failed";

					if (change.type === "add") {
						results.push({
							call: {
								type: "toolCall",
								id: subId,
								name: "write",
								arguments: { path, content: cleanOutputText(change.content ?? "") } as unknown as JsonObject,
							},
							resultId: `res-${subId}`,
							toolName: "write",
							content: [],
							isError: failed,
						});
					} else {
						const diff = change.unified_diff ? cleanOutputText(change.unified_diff) : undefined;
						results.push({
							call: {
								type: "toolCall",
								id: subId,
								name: "edit",
								arguments: { path } as unknown as JsonObject,
							},
							resultId: `res-${subId}`,
							toolName: "edit",
							content: diff ? [{ type: "text", text: diff }] : [],
							isError: failed,
							...(diff && { details: { diff } }),
						});
					}
				}
			} else if (item.type === "CommandExecution") {
				const subId = item.id ?? (itemIndex === 0 ? pending.callId : `${pending.callId}-${itemIndex}`);
				itemIndex++;
				const cmd = extractCommandExecutionCmd(item);
				const outputText = cleanOutputText(item.aggregated_output ?? "");
				const isError = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);

				results.push({
					call: {
						type: "toolCall",
						id: subId,
						name: "bash",
						arguments: { command: cmd } as unknown as JsonObject,
					},
					resultId: `res-${subId}`,
					toolName: "bash",
					content: outputText ? [{ type: "text", text: outputText }] : [],
					isError,
				});
			}
		}

		if (results.length > 0) return results;
	}

	const parsedOutput = parseToolOutputPayload(rawOutput);

	// 2. Direct `apply_patch` tool or `exec` calling `tools.apply_patch(...)` without FileChange item
	const patchSource =
		pending.name === "apply_patch"
			? pending.input
			: pending.name === "exec"
				? extractExecApplyPatch(pending.input)
				: undefined;
	if (patchSource) {
		const ops = parseApplyPatchOperations(patchSource, cwd);
		if (ops.length > 0) {
			return ops.map((op, i) => {
				const subId = i === 0 ? pending.callId : `${pending.callId}-${i}`;
				if (op.type === "add") {
					return {
						call: {
							type: "toolCall",
							id: subId,
							name: "write",
							arguments: { path: op.path, content: op.content } as unknown as JsonObject,
						},
						resultId: `res-${subId}`,
						toolName: "write",
						content: i === ops.length - 1 ? parsedOutput.blocks : [],
						isError: parsedOutput.isError,
					};
				}
				return {
					call: {
						type: "toolCall",
						id: subId,
						name: "edit",
						arguments: { path: op.path } as unknown as JsonObject,
					},
					resultId: `res-${subId}`,
					toolName: "edit",
					content:
						parsedOutput.blocks.length > 0
							? parsedOutput.blocks
							: op.content
								? [{ type: "text", text: op.content }]
								: [],
					isError: parsedOutput.isError,
					...(!parsedOutput.isError && op.content && { details: { diff: op.content } }),
				};
			});
		}
	}

	// 3. `exec` calling `tools.exec_command(...)` that failed or yielded before CommandExecution item
	if (pending.kind === "custom" && pending.name === "exec") {
		const cmd = extractExecCommandString(pending.input);
		if (cmd) {
			return [
				{
					call: {
						type: "toolCall",
						id: pending.callId,
						name: "bash",
						arguments: { command: cmd } as unknown as JsonObject,
					},
					resultId: `res-${pending.callId}`,
					toolName: "bash",
					content: parsedOutput.blocks,
					isError: parsedOutput.isError,
				},
			];
		}
	}

	// 4. Local shell calls or function calls (`shell`, `exec_command`, `view_image`, `request_user_input`, etc.)
	if (pending.kind === "shell") {
		return [
			{
				call: {
					type: "toolCall",
					id: pending.callId,
					name: "bash",
					arguments: { command: pending.input } as unknown as JsonObject,
				},
				resultId: `res-${pending.callId}`,
				toolName: "bash",
				content: parsedOutput.blocks,
				isError: parsedOutput.isError,
			},
		];
	}

	let parsedArgs: Record<string, unknown> = {};
	if (pending.kind === "function") {
		try {
			const candidate = JSON.parse(pending.input);
			if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
				parsedArgs = candidate as Record<string, unknown>;
			}
		} catch {
			parsedArgs = { input: pending.input };
		}
	} else {
		parsedArgs = { input: pending.input };
	}

	if (pending.name === "exec_command" || pending.name === "shell") {
		const rawCmd = parsedArgs.cmd ?? parsedArgs.command;
		const cmd = Array.isArray(rawCmd)
			? String(rawCmd[rawCmd.length - 1] ?? "")
			: typeof rawCmd === "string"
				? rawCmd
				: "";
		return [
			{
				call: {
					type: "toolCall",
					id: pending.callId,
					name: "bash",
					arguments: { command: cmd } as unknown as JsonObject,
				},
				resultId: `res-${pending.callId}`,
				toolName: "bash",
				content: parsedOutput.blocks,
				isError: parsedOutput.isError,
			},
		];
	}

	if (pending.name === "view_image") {
		const path = typeof parsedArgs.path === "string" ? formatToolPath(parsedArgs.path, cwd) : "";
		return [
			{
				call: {
					type: "toolCall",
					id: pending.callId,
					name: "read",
					arguments: { path } as unknown as JsonObject,
				},
				resultId: `res-${pending.callId}`,
				toolName: "read",
				content: parsedOutput.blocks,
				isError: parsedOutput.isError,
			},
		];
	}

	return [
		{
			call: {
				type: "toolCall",
				id: pending.callId,
				name: pending.name,
				arguments: parsedArgs as unknown as JsonObject,
			},
			resultId: `res-${pending.callId}`,
			toolName: pending.name,
			content: parsedOutput.blocks,
			isError: parsedOutput.isError,
		},
	];
}

/** Check whether a Codex user message record was injected by the harness (AGENTS.md / environment context). */
function isHarnessInjectedUserMessage(payload: CodexPayload): boolean {
	const passthrough = payload.internal_chat_message_metadata_passthrough;
	const kinds = passthrough?.content_item_kinds;
	if (Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => HARNESS_ITEM_KINDS.has(k))) {
		return true;
	}
	const meta = passthrough?.content_item_metadata;
	if (
		Array.isArray(meta) &&
		meta.length > 0 &&
		meta.every((m) => m.provenance?.type && HARNESS_PROVENANCE_TYPES.has(m.provenance.type))
	) {
		return true;
	}
	return false;
}

/** Parse a Codex `<skill>` block into Pi's `<skill name="..." location="...">` format. */
function formatSkillBlock(text: string): string | undefined {
	const match = text.trim().match(SKILL_TAG);
	if (!match) return undefined;
	const name = match[1].trim();
	const location = match[2].trim();
	const body = match[3].replace(/\r\n/g, "\n").trim();
	return `<skill name="${name}" location="${location}">\n${body}\n</skill>`;
}

/** Remove empty assistant entries while re-linking child parentIds. */
function pruneEmptyAssistants(entries: SessionEntry[]): SessionEntry[] {
	const dropped = new Map<string, string | null>();
	for (const e of entries) {
		if (e.type === "message" && e.message.role === "assistant" && e.message.content.length === 0) {
			dropped.set(e.id, e.parentId);
		}
	}
	if (dropped.size === 0) return entries;

	return entries
		.filter((e) => !dropped.has(e.id))
		.map((e) => {
			let p = e.parentId;
			while (p && dropped.has(p)) {
				p = dropped.get(p) ?? null;
			}
			return { ...e, parentId: p };
		});
}

/** Drop user prompts that got no response and are not the session leaf. */
function pruneAbandonedPrompts(entries: SessionEntry[]): SessionEntry[] {
	const parents = new Set(entries.map((e) => e.parentId));
	const leafId = entries[entries.length - 1]?.id;
	return entries.filter(
		(e) => !(e.type === "message" && e.message.role === "user" && !parents.has(e.id) && e.id !== leafId),
	);
}

/** Recursively search a directory for a Codex `.jsonl` transcript matching `cleanId`. */
function searchTranscriptDir(dir: string, cleanId: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const stem = entry.name.slice(0, -6);
				if (stem === cleanId || stem.endsWith(`-${cleanId}`)) {
					return fullPath;
				}
			}
		}
	}
	return undefined;
}

/**
 * Locate a Codex transcript by direct file path or session ID.
 */
export function findCodexTranscript(sessionIdOrPath: string): string {
	const expanded = expandTildePath(sessionIdOrPath);
	const resolved = resolvePath(expanded);
	if (existsSync(resolved) && statSync(resolved).isFile()) {
		return resolved;
	}

	const rawId = sessionIdOrPath.trim();
	const cleanId = rawId.endsWith(".jsonl") ? rawId.slice(0, -6) : rawId;
	const codexDir = process.env.CODEX_HOME ? resolvePath(process.env.CODEX_HOME) : join(homedir(), ".codex");

	for (const subdir of ["sessions", "archived_sessions"]) {
		const found = searchTranscriptDir(join(codexDir, subdir), cleanId);
		if (found) return found;
	}

	throw new Error(`Codex session not found: ${sessionIdOrPath}`);
}

/**
 * Convert parsed Codex transcript records into Pi session file entries.
 */
export function convertCodexTranscript(records: unknown[]): FileEntry[] {
	const entries: SessionEntry[] = [];
	let header: SessionHeader | null = null;
	let sessionCwd = process.cwd();
	let currentProvider = "openai";
	let currentModel: string | null = null;
	let lastEmittedModel: string | null = null;
	let lastEntryId: string | null = null;
	let lastUserEntryInTurn: SessionMessageEntry | null = null;

	const turnState: {
		currentAssistant: SessionMessageEntry | null;
		lastAssistantInTurn: SessionMessageEntry | null;
	} = {
		currentAssistant: null,
		lastAssistantInTurn: null,
	};
	const pendingToolCalls = new Map<string, PendingToolCall>();
	let activeExecCallId: string | null = null;

	const emitEntry = (
		type: string,
		fields: Record<string, unknown>,
		options?: { id?: string; parentId?: string | null; timestamp?: string },
	): SessionEntry => {
		const id = options?.id ?? `entry-${entries.length}`;
		const parentId = options?.parentId !== undefined ? options.parentId : lastEntryId;
		const entry = {
			type,
			id,
			parentId,
			timestamp: options?.timestamp ?? new Date().toISOString(),
			...fields,
		} as unknown as SessionEntry;
		entries.push(entry);
		lastEntryId = id;
		return entry;
	};

	const flushPendingAssistant = (): void => {
		if (!turnState.currentAssistant) return;
		if (pendingToolCalls.size > 0) {
			const assistantMsg = turnState.currentAssistant.message as AssistantMessage;
			for (const pending of pendingToolCalls.values()) {
				const resolved = resolveToolCallExecutions(pending, undefined, sessionCwd);
				for (const item of resolved) {
					assistantMsg.content.push(item.call);
				}
			}
			pendingToolCalls.clear();
			activeExecCallId = null;
		}
		turnState.currentAssistant = null;
	};

	const ensureAssistant = (timestamp: string, idHint?: string): SessionMessageEntry => {
		if (turnState.currentAssistant) return turnState.currentAssistant;

		if (currentModel && currentModel !== lastEmittedModel) {
			emitEntry(
				"model_change",
				{ provider: currentProvider, modelId: currentModel },
				{ id: `model-${idHint ?? entries.length}`, timestamp },
			) as ModelChangeEntry;
			lastEmittedModel = currentModel;
		}

		const entry = emitEntry(
			"message",
			{
				message: {
					role: "assistant",
					provider: currentProvider,
					content: [],
					...(currentModel && { model: currentModel }),
				},
			},
			{ id: idHint ?? `asst-${entries.length}`, timestamp },
		) as SessionMessageEntry;

		turnState.currentAssistant = entry;
		turnState.lastAssistantInTurn = entry;
		return entry;
	};

	for (const item of records) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as CodexRecord;
		const p = r.payload ?? {};
		const timestamp = r.timestamp ?? p.timestamp ?? new Date().toISOString();

		if (r.type === "session_meta") {
			if (p.cwd) sessionCwd = p.cwd;
			if (p.model_provider) currentProvider = p.model_provider;
			if (!header) {
				header = {
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: p.session_id ?? p.id ?? `codex-${Date.now()}`,
					timestamp: p.timestamp ?? timestamp,
					cwd: sessionCwd,
				};
			}
			continue;
		}

		if (r.type === "turn_context") {
			if (p.cwd) sessionCwd = p.cwd;
			if (p.model) currentModel = p.model;
			continue;
		}

		if (r.type === "event_msg") {
			if (p.type === "thread_settings_applied" && p.thread_settings) {
				if (p.thread_settings.cwd) sessionCwd = p.thread_settings.cwd;
				if (p.thread_settings.model_provider_id) currentProvider = p.thread_settings.model_provider_id;
				if (p.thread_settings.model) currentModel = p.thread_settings.model;
				continue;
			}

			if (p.type === "task_started") {
				flushPendingAssistant();
				lastUserEntryInTurn = null;
				turnState.lastAssistantInTurn = null;
				continue;
			}

			if (p.type === "item_completed" && p.item) {
				const completed = p.item;
				if (
					(completed.type === "CommandExecution" || completed.type === "FileChange") &&
					activeExecCallId &&
					pendingToolCalls.has(activeExecCallId)
				) {
					pendingToolCalls.get(activeExecCallId)!.items.push(completed);
				}
				continue;
			}

			if (p.type === "token_count") {
				const target = turnState.currentAssistant ?? turnState.lastAssistantInTurn;
				if (target) {
					const assistantMsg = target.message as AssistantMessage;
					if (!assistantMsg.usage && p.info?.last_token_usage) {
						assistantMsg.usage = convertUsage(p.info.last_token_usage);
					}
				}
				if (pendingToolCalls.size === 0) {
					turnState.currentAssistant = null;
				}
				continue;
			}

			if (p.type === "turn_aborted") {
				flushPendingAssistant();
				if (turnState.lastAssistantInTurn && turnState.lastAssistantInTurn.message.role === "assistant") {
					(turnState.lastAssistantInTurn.message as AssistantMessage).stopReason = "aborted";
				}
				continue;
			}

			if (p.type === "task_complete") {
				flushPendingAssistant();
				continue;
			}

			continue;
		}

		if (r.type === "token_usage_record") {
			const target = turnState.currentAssistant ?? turnState.lastAssistantInTurn;
			if (target && p.usage) {
				(target.message as AssistantMessage).usage = convertUsage(p.usage);
				if (pendingToolCalls.size === 0) {
					turnState.currentAssistant = null;
				}
			}
			continue;
		}

		if (r.type !== "response_item") continue;

		if (p.type === "compaction") {
			flushPendingAssistant();
			const summary = typeof p.summary === "string" ? p.summary : "";
			emitEntry("compaction", { summary, tokensBefore: p.tokens_before ?? 0 }, { id: p.id, timestamp });
			continue;
		}

		if (p.type === "reasoning") {
			const summaryParts = Array.isArray(p.summary) ? p.summary.map((s) => s.text ?? "").filter(Boolean) : [];
			const contentParts = Array.isArray(p.content) ? p.content.map((c) => c.text ?? "").filter(Boolean) : [];
			const thinkingText = (summaryParts.join("\n\n") || contentParts.join("\n\n")).trim();
			if (thinkingText) {
				const asst = ensureAssistant(timestamp, p.id);
				(asst.message as AssistantMessage).content.push({
					type: "thinking",
					thinking: thinkingText,
				} satisfies ThinkingContent);
			}
			continue;
		}

		if (p.type === "message" && p.role === "assistant") {
			const rawBlocks = Array.isArray(p.content) ? p.content : [];
			const textParts: string[] = [];
			for (const b of rawBlocks) {
				const t = b.text ?? b.refusal ?? "";
				if (t) textParts.push(t);
			}
			const cleanedText = textParts.join("\n").replace(PROPOSED_PLAN, "$1").trim();
			if (!cleanedText) continue;

			const asst = ensureAssistant(timestamp, p.id);
			(asst.message as AssistantMessage).content.push({
				type: "text",
				text: cleanedText,
			} satisfies TextContent);
			continue;
		}

		if (p.type === "custom_tool_call" && p.call_id) {
			ensureAssistant(timestamp, p.id);
			pendingToolCalls.set(p.call_id, {
				kind: "custom",
				id: p.id ?? p.call_id,
				callId: p.call_id,
				name: p.name ?? "custom",
				input: p.input ?? "",
				timestamp,
				items: [],
			});
			if (p.name === "exec") {
				activeExecCallId = p.call_id;
			}
			continue;
		}

		if (p.type === "function_call" && p.call_id) {
			ensureAssistant(timestamp, p.id);
			pendingToolCalls.set(p.call_id, {
				kind: "function",
				id: p.id ?? p.call_id,
				callId: p.call_id,
				name: p.name ?? "custom",
				input: p.arguments ?? "{}",
				timestamp,
				items: [],
			});
			continue;
		}

		if (p.type === "local_shell_call") {
			const callId = p.call_id ?? p.id ?? `shell-${entries.length}`;
			const rawCmd = p.action?.command;
			const cmd = Array.isArray(rawCmd)
				? (rawCmd[rawCmd.length - 1] ?? "")
				: typeof rawCmd === "string"
					? rawCmd
					: "";
			ensureAssistant(timestamp, p.id);
			pendingToolCalls.set(callId, {
				kind: "shell",
				id: p.id ?? callId,
				callId,
				name: "bash",
				input: cmd,
				timestamp,
				items: [],
			});
			continue;
		}

		if (
			(p.type === "custom_tool_call_output" ||
				p.type === "function_call_output" ||
				p.type === "local_shell_call_output") &&
			p.call_id
		) {
			const pending = pendingToolCalls.get(p.call_id);
			if (!pending || !turnState.currentAssistant) continue;

			const assistantMsg = turnState.currentAssistant.message as AssistantMessage;
			const executions = resolveToolCallExecutions(pending, p.output, sessionCwd);
			for (const exec of executions) {
				assistantMsg.content.push(exec.call);
				emitEntry(
					"message",
					{
						message: {
							role: "toolResult" as const,
							toolCallId: exec.call.id,
							toolName: exec.toolName,
							content: exec.content,
							isError: exec.isError,
							...(exec.details && { details: exec.details }),
						},
					},
					{ id: exec.resultId, timestamp },
				);
			}

			pendingToolCalls.delete(p.call_id);
			if (activeExecCallId === p.call_id) {
				activeExecCallId = null;
			}
			if (pendingToolCalls.size === 0) {
				turnState.currentAssistant = null;
			}
			continue;
		}

		if (p.type === "message" && p.role === "user") {
			if (isHarnessInjectedUserMessage(p)) continue;

			const rawBlocks = Array.isArray(p.content) ? p.content : [];
			const textParts: string[] = [];
			const images: Array<ImageContent | TextContent> = [];

			for (const b of rawBlocks) {
				if ((b.type === "input_text" || b.type === "text") && typeof b.text === "string") {
					const trimmedBlock = b.text.trim();
					if (!HARNESS_BLOCK_PATTERNS.some((pattern) => pattern.test(trimmedBlock))) {
						textParts.push(b.text);
					}
				} else if (b.type === "input_image" && b.image_url) {
					images.push(convertImageUrl(b.image_url));
				}
			}

			const combinedText = textParts.join("\n").trim();
			if (!combinedText && images.length === 0) continue;

			const formattedSkill = combinedText ? formatSkillBlock(combinedText) : undefined;
			if (formattedSkill && lastUserEntryInTurn && lastUserEntryInTurn.message.role === "user") {
				const prevContent = lastUserEntryInTurn.message.content;
				if (Array.isArray(prevContent)) {
					const firstText = prevContent.find((c): c is TextContent => c.type === "text");
					if (firstText) {
						firstText.text = `${formattedSkill}\n\n${firstText.text}`;
						continue;
					}
				}
			}

			flushPendingAssistant();
			const finalText = formattedSkill ?? combinedText;
			lastUserEntryInTurn = emitEntry(
				"message",
				{
					message: {
						role: "user",
						content: [...(finalText ? [{ type: "text", text: finalText }] : []), ...images],
					},
				},
				{ id: p.id, timestamp },
			) as SessionMessageEntry;
		}
	}

	flushPendingAssistant();

	if (!header) {
		header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: `codex-${Date.now()}`,
			timestamp: entries[0]?.timestamp ?? new Date().toISOString(),
			cwd: sessionCwd,
		};
	}

	return [header, ...pruneAbandonedPrompts(pruneEmptyAssistants(entries))];
}

/**
 * Export a Codex session transcript to HTML.
 */
export async function exportCodexSession(sessionIdOrPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const transcriptPath = findCodexTranscript(sessionIdOrPath);

	const content = readFileSync(transcriptPath, "utf-8");
	const lines = content.split("\n");
	const records: unknown[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed));
		} catch {
			// skip malformed lines
		}
	}

	const fileEntries = convertCodexTranscript(records);
	if (fileEntries.length === 0) {
		throw new Error(`Failed to convert Codex session: ${transcriptPath}`);
	}

	const header = fileEntries[0] as SessionHeader;
	const cwd = header.cwd || process.cwd();
	const sm = SessionManager.inMemory(cwd, undefined, fileEntries);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName ?? "zenburn");

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const baseId = header.id || basename(transcriptPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${baseId}.html`;
	}

	writeFileSync(outputPath, html, "utf-8");
	return outputPath;
}

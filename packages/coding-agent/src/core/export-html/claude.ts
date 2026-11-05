// Export Claude Code transcripts to Pi HTML sessions.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import type { BashExecutionMessage } from "../messages.ts";
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

interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

interface ClaudeImageSource {
	type?: string;
	data?: string;
	media_type?: string;
}

interface ClaudeContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string | ClaudeContentBlock[];
	is_error?: boolean;
	source?: ClaudeImageSource;
}

interface ClaudeMessage {
	role?: string;
	id?: string;
	model?: string;
	content?: string | ClaudeContentBlock[];
	usage?: ClaudeUsage;
}

interface ClaudeRecord {
	uuid?: string;
	parentUuid?: string | null;
	logicalParentUuid?: string | null;
	type?: string;
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	isCompactSummary?: boolean;
	subtype?: string;
	compactMetadata?: { preTokens?: number };
	message?: ClaudeMessage;
	toolUseResult?: {
		structuredPatch?: Array<{
			oldStart: number;
			oldLines: number;
			newStart: number;
			newLines: number;
			lines?: string[];
		}>;
		file?: { content?: string };
	};
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const BASH_INPUT = /<bash-input>([\s\S]*?)<\/bash-input>/;
const BASH_OUTPUT = /<bash-(stdout|stderr)>([\s\S]*?)<\/bash-\1>/g;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const READ_LINE_PREFIX = /^\s*\d+\t/gm;
const PERSISTED_OUTPUT = /Full output saved to: (\S+)/;
const SYNTHETIC_MODEL = "<synthetic>";

/** Map Claude tool names to Pi equivalents where specialized renderers exist. */
function mapToolName(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "bash") return "bash";
	if (lower === "read") return "read";
	if (lower === "write") return "write";
	if (lower === "edit" || lower === "multiedit") return "edit";
	return name;
}

/** Normalize tool inputs for Pi's template renderer. */
function mapToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
	const lower = name.toLowerCase();
	switch (lower) {
		case "bash":
			return { command: args.command ?? "" };
		case "read": {
			const out: Record<string, unknown> = {
				path: args.file_path ?? args.path ?? "",
			};
			if ("offset" in args) out.offset = args.offset;
			if ("limit" in args) out.limit = args.limit;
			return out;
		}
		case "write":
			return {
				path: args.file_path ?? args.path ?? "",
				content: args.content ?? "",
			};
		case "edit":
		case "multiedit": {
			const { file_path: filePath, path: p, ...edits } = args;
			return { path: filePath ?? p ?? "", ...edits };
		}
		default:
			return args;
	}
}

/** Format unified diff lines for Pi's edit renderer. */
function formatEditDiff(
	input: Record<string, unknown>,
	toolUseResult?: ClaudeRecord["toolUseResult"],
): string | undefined {
	const patch = toolUseResult?.structuredPatch;
	if (Array.isArray(patch) && patch.length > 0) {
		return patch
			.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...(h.lines ?? [])])
			.join("\n");
	}

	const edits = (input.edits as Array<{
		old_string?: unknown;
		new_string?: unknown;
	}>) ?? [input];
	const lines = edits.flatMap((e) => [
		...String(e.old_string ?? "")
			.split("\n")
			.map((l) => `-${l}`),
		...String(e.new_string ?? "")
			.split("\n")
			.map((l) => `+${l}`),
	]);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Convert a Claude image block to Pi ImageContent. */
function convertImage(block: ClaudeContentBlock): ImageContent | TextContent {
	const source = block.source ?? {};
	if (source.type !== "base64" || !source.data) {
		return { type: "text", text: "[image]" };
	}
	return {
		type: "image",
		data: source.data,
		mimeType: source.media_type ?? "image/png",
	};
}

/** Convert tool result content to Pi text and image blocks. */
function convertToolResultContent(
	content: unknown,
	readFile: (path: string) => string | undefined,
): Array<TextContent | ImageContent> {
	const blocks: Array<TextContent | ImageContent> = [];
	if (typeof content === "string") {
		blocks.push({ type: "text", text: content });
	} else if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item !== "object" || item === null) continue;
			const b = item as ClaudeContentBlock;
			if (b.type === "image") {
				blocks.push(convertImage(b));
			} else if (b.type === "text" && typeof b.text === "string") {
				blocks.push({ type: "text", text: b.text });
			} else {
				blocks.push({ type: "text", text: JSON.stringify(b) });
			}
		}
	}

	for (const b of blocks) {
		if (b.type !== "text") continue;
		b.text = b.text.replace(SYSTEM_REMINDER, "");
		const persisted = b.text.match(PERSISTED_OUTPUT);
		if (persisted) {
			const full = readFile(persisted[1]);
			if (typeof full === "string") {
				b.text = full;
				continue;
			}
		}
		b.text = b.text.trimEnd();
	}
	return blocks;
}

/** Convert Claude token usage to Pi Usage. */
function convertUsage(usage?: ClaudeUsage): Usage | undefined {
	if (!usage) return undefined;
	const input = usage.input_tokens || 0;
	const output = usage.output_tokens || 0;
	return {
		input,
		output,
		cacheRead: usage.cache_read_input_tokens || 0,
		cacheWrite: usage.cache_creation_input_tokens || 0,
		totalTokens: input + output,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

/** Extract plain text from user turn content. */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => typeof b === "object" && b !== null && (b as ClaudeContentBlock).type === "text")
			.map((b) => (b as ClaudeContentBlock).text ?? "")
			.join("\n");
	}
	return "";
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

/**
 * Locate a Claude Code transcript by direct file path or session ID.
 */
export function findClaudeTranscript(sessionIdOrPath: string): string {
	const expanded = expandTildePath(sessionIdOrPath);
	const resolved = resolvePath(expanded);
	if (existsSync(resolved)) {
		return resolved;
	}

	const rawId = sessionIdOrPath.trim();
	const cleanId = rawId.endsWith(".jsonl") ? rawId.slice(0, -6) : rawId;
	const claudeDir = process.env.CLAUDE_CONFIG_DIR
		? resolvePath(process.env.CLAUDE_CONFIG_DIR)
		: join(homedir(), ".claude");
	const projectsDir = join(claudeDir, "projects");

	if (existsSync(projectsDir)) {
		const projects = readdirSync(projectsDir);
		for (const project of projects) {
			const projectDir = join(projectsDir, project);
			const targetFile = join(projectDir, `${cleanId}.jsonl`);
			if (existsSync(targetFile)) {
				return targetFile;
			}
		}
	}

	throw new Error(`Claude session not found: ${sessionIdOrPath}`);
}

/**
 * Convert parsed Claude transcript records into Pi session file entries.
 */
export function convertClaudeTranscript(records: unknown[]): FileEntry[] {
	const entries: SessionEntry[] = [];
	const parentOf = new Map<string, string | null>();
	const emitted = new Map<string, string>(); // Claude uuid -> emitted entry id
	const assistantByMessageId = new Map<string, SessionMessageEntry>();
	const toolUses = new Map<string, { id: string; name: string; input: Record<string, unknown> }>();
	const lastToolResult = new Map<string, string>(); // assistant entry id -> latest result id
	let header: SessionHeader | null = null;
	let lastModel: string | null = null;
	let pendingBash: string | null = null;
	let preCompactTokens = 0;

	const readFile = (filePath: string): string | undefined => {
		try {
			if (existsSync(filePath)) return readFileSync(filePath, "utf-8");
		} catch {
			// ignore unreadable persisted files
		}
		return undefined;
	};

	for (const item of records) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as ClaudeRecord;
		if (r.uuid) {
			parentOf.set(r.uuid, r.parentUuid ?? r.logicalParentUuid ?? null);
		}
	}

	const resolveParent = (uuid: string): string | null => {
		let p = parentOf.get(uuid);
		while (p && !emitted.has(p)) {
			p = parentOf.get(p) ?? null;
		}
		return p ? (emitted.get(p) ?? null) : null;
	};

	const emit = (
		r: ClaudeRecord,
		type: string,
		fields: Record<string, unknown>,
		options?: { id?: string; parentId?: string | null },
	): SessionEntry => {
		const id = options?.id ?? r.uuid ?? `entry-${entries.length}`;
		const parentId = options?.parentId !== undefined ? options.parentId : r.uuid ? resolveParent(r.uuid) : null;
		const entry = {
			type,
			id,
			parentId,
			timestamp: r.timestamp ?? new Date().toISOString(),
			...fields,
		} as unknown as SessionEntry;
		entries.push(entry);
		if (r.uuid) emitted.set(r.uuid, id);
		return entry;
	};

	for (const item of records) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as ClaudeRecord;

		if (!header && r.sessionId && r.timestamp) {
			header = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: r.sessionId,
				timestamp: r.timestamp,
				cwd: r.cwd ?? process.cwd(),
			};
		}

		if (r.type === "system" && r.subtype === "compact_boundary") {
			preCompactTokens = r.compactMetadata?.preTokens ?? 0;
			continue;
		}

		if (r.type !== "user" && r.type !== "assistant") continue;
		if (r.isSidechain || !r.uuid) continue;
		const msg = r.message ?? {};

		if (r.type === "assistant") {
			const blocks: Array<TextContent | ThinkingContent | ToolCall> = [];

			const rawContent = Array.isArray(msg.content) ? msg.content : [];
			for (const b of rawContent) {
				if (b.type === "text" && b.text?.trim()) {
					blocks.push({ type: "text", text: b.text });
				} else if (b.type === "thinking" && b.thinking?.trim()) {
					blocks.push({ type: "thinking", thinking: b.thinking });
				} else if (b.type === "tool_use" && b.id && b.name) {
					const input = b.input ?? {};
					toolUses.set(b.id, { id: b.id, name: b.name, input });
					blocks.push({
						type: "toolCall",
						id: b.id,
						name: mapToolName(b.name),
						arguments: mapToolArgs(b.name, input) as unknown as JsonObject,
					});
				}
			}

			const usage = convertUsage(msg.usage);
			const msgId = msg.id;
			if (msgId && assistantByMessageId.has(msgId)) {
				const existing = assistantByMessageId.get(msgId)!;
				const assistantMsg = existing.message as AssistantMessage;
				assistantMsg.content.push(...blocks);
				if (usage) assistantMsg.usage = usage;
				emitted.set(r.uuid, existing.id);
				continue;
			}

			const model = msg.model && msg.model !== SYNTHETIC_MODEL ? msg.model : undefined;
			let parentId: string | null | undefined;
			if (model && model !== lastModel) {
				const modelChangeEntry = emit(
					r,
					"model_change",
					{ provider: "anthropic", modelId: model },
					{ id: `model-${r.uuid}` },
				) as ModelChangeEntry;
				parentId = modelChangeEntry.id;
				lastModel = model;
			}

			const entry = emit(
				r,
				"message",
				{
					message: {
						role: "assistant",
						provider: "anthropic",
						content: blocks,
						...(model && { model }),
						...(usage && { usage }),
					},
				},
				{ parentId },
			) as SessionMessageEntry;

			if (msgId) assistantByMessageId.set(msgId, entry);
			continue;
		}

		// User records
		if (r.isMeta) continue;
		const content = msg.content ?? "";

		// Check for embedded tool results
		const toolResults = Array.isArray(content)
			? (content as ClaudeContentBlock[]).filter((b) => b.type === "tool_result")
			: [];

		if (toolResults.length > 0) {
			const owner = resolveParent(r.uuid);
			let parentId = (owner && lastToolResult.get(owner)) ?? owner;

			toolResults.forEach((block, i) => {
				const toolCallId = block.tool_use_id ?? "";
				const toolUse = toolUses.get(toolCallId);
				const toolName = toolUse ? mapToolName(toolUse.name) : "custom";
				const isError = Boolean(block.is_error);
				let resultBlocks = convertToolResultContent(block.content, readFile);

				let details: { diff?: string } | undefined;
				if (toolName === "read" && !isError) {
					const fileContent = r.toolUseResult?.file?.content;
					if (typeof fileContent === "string") {
						const images = resultBlocks.filter((b) => b.type === "image");
						resultBlocks = [{ type: "text", text: fileContent }, ...images];
					} else {
						for (const b of resultBlocks) {
							if (b.type === "text") b.text = b.text.replace(READ_LINE_PREFIX, "");
						}
					}
				} else if (toolName === "edit" && !isError) {
					const diff = formatEditDiff(toolUse?.input ?? {}, r.toolUseResult);
					if (diff) details = { diff };
				}

				const resultMessage = {
					role: "toolResult" as const,
					toolCallId,
					toolName,
					content: resultBlocks,
					isError,
					...(details && { details }),
				};

				const id = i === 0 ? r.uuid! : `${r.uuid}-${i}`;
				parentId = emit(r, "message", { message: resultMessage }, { id, parentId }).id;
			});

			if (owner && parentId) lastToolResult.set(owner, parentId);
			continue;
		}

		if (r.isCompactSummary) {
			emit(r, "compaction", {
				summary: extractUserText(content),
				tokensBefore: preCompactTokens,
			});
			continue;
		}

		let text = extractUserText(content).replace(SYSTEM_REMINDER, "");

		const bashInput = text.match(BASH_INPUT);
		if (bashInput) {
			pendingBash = bashInput[1];
			continue;
		}

		const bashOutput = [...text.matchAll(BASH_OUTPUT)];
		if (bashOutput.length > 0 && pendingBash !== null) {
			const outputText = bashOutput
				.map((m) => m[2].replace(ANSI, "").trim())
				.filter(Boolean)
				.join("\n");
			const bashMsg: BashExecutionMessage = {
				role: "bashExecution",
				command: pendingBash,
				output: outputText,
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
			};
			emit(r, "message", { message: bashMsg });
			pendingBash = null;
			continue;
		}

		const command = text.match(COMMAND_NAME);
		if (command) {
			const args = text.match(COMMAND_ARGS)?.[1].trim() ?? "";
			text = `${command[1].trim()} ${args}`;
		}
		text = text.trim();

		const images = Array.isArray(content)
			? (content as ClaudeContentBlock[]).filter((b) => b.type === "image").map(convertImage)
			: [];

		if (!text && images.length === 0) continue;

		emit(r, "message", {
			message: {
				role: "user",
				content: [...(text ? [{ type: "text", text }] : []), ...images],
			},
		});
	}

	if (!header) {
		header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: `claude-${Date.now()}`,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
		};
	}

	return [header, ...pruneEmptyAssistants(entries)];
}

/**
 * Export a Claude Code session transcript to HTML.
 */
export async function exportClaudeSession(sessionIdOrPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const transcriptPath = findClaudeTranscript(sessionIdOrPath);

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

	const fileEntries = convertClaudeTranscript(records);
	if (fileEntries.length === 0) {
		throw new Error(`Failed to convert Claude session: ${transcriptPath}`);
	}

	const header = fileEntries[0] as SessionHeader;
	const cwd = (header as { cwd?: string }).cwd || process.cwd();
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

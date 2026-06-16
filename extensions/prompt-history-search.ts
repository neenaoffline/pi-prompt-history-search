import * as fs from "node:fs";
import * as path from "node:path";
import {
	CustomEditor,
	getAgentDir,
	parseSessionEntries,
	SessionManager,
	SettingsManager,
	type AppKeybinding,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionEntry,
	type SessionHeader,
} from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type Focusable,
	type TUI,
} from "@mariozechner/pi-tui";

const AGENT_DIR = getAgentDir();
const INDEX_FILE = path.join(AGENT_DIR, "prompt-history-index.jsonl");
const GLOBAL_CONFIG_FILE = path.join(AGENT_DIR, "prompt-history-search.json");
const PROJECT_CONFIG_FILE = path.join(".pi", "prompt-history-search.json");

type PromptHistoryScope = "all" | "current-session";

type PromptHistoryConfig = {
	scope: PromptHistoryScope;
};

const DEFAULT_CONFIG: PromptHistoryConfig = {
	scope: "all",
};

type PromptHistoryEntry = {
	text: string;
	timestamp: number;
	cwd?: string;
	sessionFile?: string;
	sessionId?: string;
	entryId?: string;
};

type PromptHistoryIndexRecord =
	| {
			type: "meta";
			version: 3;
			createdAt: number;
			updatedAt: number;
	  }
	| ({ type: "message" } & PromptHistoryEntry);

type CustomEditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

class PromptHistoryStore {
	private entries: PromptHistoryEntry[] = [];
	private config: PromptHistoryConfig = DEFAULT_CONFIG;
	private activeSessionFile: string | undefined;
	private activeSessionId: string | undefined;
	private activeCwd: string | undefined;

	constructor(private readonly indexFile: string) {
		this.load();
	}

	configure(cwd: string): void {
		this.config = loadConfig(cwd);
	}

	setActiveSession(ctx: ExtensionContext): void {
		this.activeSessionFile = ctx.sessionManager.getSessionFile();
		this.activeSessionId = ctx.sessionManager.getSessionId();
		this.activeCwd = ctx.cwd;
	}

	hasIndex(): boolean {
		return fs.existsSync(this.indexFile);
	}

	async ensureIndex(): Promise<boolean> {
		if (this.hasIndex()) {
			this.load();
			return false;
		}

		await this.rebuildFromAllSessions();
		return true;
	}

	async rebuildFromAllSessions(): Promise<void> {
		const entries: PromptHistoryEntry[] = [];
		const sessions = await SessionManager.listAll();

		for (const session of sessions) {
			entries.push(...extractUserPromptEntriesFromSessionFile(session.path, session.cwd));
		}

		this.entries = this.dedupeIndexedEntries(entries);
		this.sortNewestFirst();
		this.save();
	}

	add(text: string, cwd?: string, session?: { sessionFile?: string; sessionId?: string }, options?: { persist?: boolean }): boolean {
		const entry = this.normalizeEntry({
			text,
			timestamp: Date.now(),
			cwd: cwd ?? this.activeCwd,
			sessionFile: session?.sessionFile ?? this.activeSessionFile,
			sessionId: session?.sessionId ?? this.activeSessionId,
		});
		if (!entry) return false;

		this.entries.push(entry);
		this.sortNewestFirst();
		if (options?.persist !== false) this.save();
		return true;
	}

	addEntries(entries: PromptHistoryEntry[], options?: { persist?: boolean }): void {
		let changed = false;
		for (const entry of entries) {
			const normalized = this.normalizeEntry(entry);
			if (!normalized || this.hasIndexedEntry(normalized)) continue;
			this.entries.push(normalized);
			changed = true;
		}

		if (!changed) return;
		this.sortNewestFirst();
		if (options?.persist !== false) this.save();
	}

	search(query: string, exclude?: string): string[] {
		const needle = query.trim().toLowerCase();
		const excludeNormalized = exclude ? this.normalizeText(exclude) : undefined;
		const seen = new Set<string>();
		const result: string[] = [];

		for (const entry of this.scopedEntries()) {
			const text = entry.text;
			if (!text || text === excludeNormalized || seen.has(text)) continue;
			if (needle && !text.toLowerCase().includes(needle)) continue;
			seen.add(text);
			result.push(text);
		}
		return result;
	}

	allNewestFirst(): string[] {
		return this.search("");
	}

	getScopeLabel(): string {
		return this.config.scope === "current-session" ? "current session" : "all sessions";
	}

	count(): number {
		return this.entries.length;
	}

	clear(): void {
		this.entries = [];
		try {
			fs.rmSync(this.indexFile, { force: true });
		} catch {
			// Ignore.
		}
	}

	private scopedEntries(): PromptHistoryEntry[] {
		if (this.config.scope !== "current-session") return this.entries;
		if (this.activeSessionFile) return this.entries.filter((entry) => entry.sessionFile === this.activeSessionFile);
		if (this.activeSessionId) return this.entries.filter((entry) => entry.sessionId === this.activeSessionId);
		return [];
	}

	private normalizeText(text: string): string {
		return text.replace(/\r\n?/g, "\n").trim();
	}

	private normalizeEntry(entry: PromptHistoryEntry): PromptHistoryEntry | undefined {
		const text = this.normalizeText(entry.text);
		if (!text) return undefined;

		return {
			text,
			timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
			cwd: typeof entry.cwd === "string" && entry.cwd.length > 0 ? entry.cwd : undefined,
			sessionFile: typeof entry.sessionFile === "string" && entry.sessionFile.length > 0 ? entry.sessionFile : undefined,
			sessionId: typeof entry.sessionId === "string" && entry.sessionId.length > 0 ? entry.sessionId : undefined,
			entryId: typeof entry.entryId === "string" && entry.entryId.length > 0 ? entry.entryId : undefined,
		};
	}

	private hasIndexedEntry(entry: PromptHistoryEntry): boolean {
		if (entry.sessionFile && entry.entryId) {
			return this.entries.some((existing) => existing.sessionFile === entry.sessionFile && existing.entryId === entry.entryId);
		}
		if (entry.sessionId && entry.entryId) {
			return this.entries.some((existing) => existing.sessionId === entry.sessionId && existing.entryId === entry.entryId);
		}
		return false;
	}

	private dedupeIndexedEntries(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
		const seen = new Set<string>();
		const result: PromptHistoryEntry[] = [];

		for (const entry of entries) {
			const normalized = this.normalizeEntry(entry);
			if (!normalized) continue;
			const key = indexedEntryKey(normalized);
			if (key && seen.has(key)) continue;
			if (key) seen.add(key);
			result.push(normalized);
		}

		return result;
	}

	private sortNewestFirst(): void {
		this.entries.sort((a, b) => b.timestamp - a.timestamp);
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.indexFile)) {
				this.entries = [];
				return;
			}

			this.entries = this.loadJsonlIndexEntries();
			this.sortNewestFirst();
		} catch {
			this.entries = [];
		}
	}

	private loadJsonlIndexEntries(): PromptHistoryEntry[] {
		try {
			const entries: PromptHistoryEntry[] = [];
			const lines = fs.readFileSync(this.indexFile, "utf-8").split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				const record = JSON.parse(line) as Partial<PromptHistoryIndexRecord>;
				if (record.type !== "message") continue;
				entries.push(record as PromptHistoryEntry);
			}
			return this.dedupeIndexedEntries(entries);
		} catch {
			return [];
		}
	}


	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
			const now = Date.now();
			const createdAt = this.loadCreatedAt() ?? now;
			const records: PromptHistoryIndexRecord[] = [
				{ type: "meta", version: 3, createdAt, updatedAt: now },
				...this.entries.map((entry) => ({ type: "message" as const, ...entry })),
			];
			const tmp = `${this.indexFile}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");
			fs.renameSync(tmp, this.indexFile);
		} catch {
			// History is a convenience feature; never break pi if persistence fails.
		}
	}

	private loadCreatedAt(): number | undefined {
		try {
			if (!fs.existsSync(this.indexFile)) return undefined;
			const firstLine = fs.readFileSync(this.indexFile, "utf-8").split("\n").find((line) => line.trim());
			if (!firstLine) return undefined;
			const record = JSON.parse(firstLine) as Partial<PromptHistoryIndexRecord>;
			return record.type === "meta" && typeof record.createdAt === "number" ? record.createdAt : undefined;
		} catch {
			return undefined;
		}
	}
}

class PromptHistoryEditor implements EditorComponent, Focusable {
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onExtensionShortcut?: (data: string) => boolean;

	private searchState:
		| {
				query: string;
				originalText: string;
				matches: string[];
				selected: number;
			}
		| undefined;

	constructor(
		private readonly inner: EditorComponent,
		private readonly store: PromptHistoryStore,
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly highlight: (text: string) => string,
	) {}

	get focused(): boolean {
		return Boolean((this.inner as unknown as Focusable).focused);
	}

	set focused(value: boolean) {
		(this.inner as unknown as Focusable).focused = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.inner.onSubmit;
	}

	set onSubmit(handler: ((text: string) => void) | undefined) {
		this.inner.onSubmit = handler;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.inner.onChange;
	}

	set onChange(handler: ((text: string) => void) | undefined) {
		this.inner.onChange = handler;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.inner.borderColor;
	}

	set borderColor(color: ((str: string) => string) | undefined) {
		this.inner.borderColor = color;
	}

	getText(): string {
		return this.inner.getText();
	}

	getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	setText(text: string): void {
		this.inner.setText(text);
	}

	insertTextAtCursor(text: string): void {
		if (this.inner.insertTextAtCursor) this.inner.insertTextAtCursor(text);
		else this.inner.setText(this.inner.getText() + text);
	}

	addToHistory(text: string): void {
		this.store.add(text);
		this.inner.addToHistory?.(text);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.inner.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.inner.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.inner.setAutocompleteMaxVisible?.(maxVisible);
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	render(width: number): string[] {
		const lines = this.inner.render(width);
		if (!this.searchState) return lines;

		const state = this.searchState;
		const match = state.matches[state.selected];
		const query = state.query.length > 0 ? state.query : "(empty = latest prompts)";
		const status = match
			? `reverse prompt search [${this.store.getScopeLabel()}] ${state.selected + 1}/${state.matches.length}: ${query}`
			: `reverse prompt search [${this.store.getScopeLabel()}]: ${query} — no match`;
		const help = "Enter accept • Esc cancel • Ctrl+R older • Ctrl+S newer";

		const displayLines = (state.query
			? lines.map((line, index) => (index > 0 && index < lines.length - 1 ? this.highlightQuery(line, state.query) : line))
			: lines
		).map((line) => truncateToWidth(line, width));

		return [
			...displayLines,
			truncateToWidth(status, width),
			truncateToWidth(help, width),
		];
	}

	handleInput(data: string): void {
		if (this.searchState) {
			this.handleSearchInput(data);
			return;
		}

		if (matchesKey(data, Key.ctrl("r"))) {
			this.startSearch();
			return;
		}

		if (this.handleAppKeybinding(data)) return;

		this.inner.handleInput(data);
	}

	dispose(): void {
		(this.inner as EditorComponent & { dispose?: () => void }).dispose?.();
	}

	private handleAppKeybinding(data: string): boolean {
		if (this.onExtensionShortcut?.(data)) return true;

		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}

		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
			}

			this.inner.handleInput(data);
			return true;
		}

		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return true;
			}
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return true;
			}
		}

		return false;
	}

	private isShowingAutocomplete(): boolean {
		const editor = this.inner as EditorComponent & { isShowingAutocomplete?: () => boolean };
		return editor.isShowingAutocomplete?.() ?? false;
	}

	private startSearch(): void {
		const originalText = this.inner.getText();
		this.searchState = {
			query: "",
			originalText,
			matches: this.store.search("", originalText),
			selected: 0,
		};
		this.applySelectedMatch();
		this.tui.requestRender();
	}

	private handleSearchInput(data: string): void {
		if (!this.searchState) return;

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.acceptSearch();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancelSearch();
			return;
		}

		if (matchesKey(data, Key.ctrl("r")) || matchesKey(data, Key.up)) {
			this.cycleMatch(1);
			return;
		}

		if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.down)) {
			this.cycleMatch(-1);
			return;
		}

		if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
			this.searchState.query = this.searchState.query.slice(0, -1);
			this.refreshMatches();
			return;
		}

		if (matchesKey(data, Key.ctrl("u"))) {
			this.searchState.query = "";
			this.refreshMatches();
			return;
		}

		if (this.isPrintableInput(data)) {
			this.searchState.query += data;
			this.refreshMatches();
			return;
		}
	}

	private cycleMatch(delta: number): void {
		if (!this.searchState || this.searchState.matches.length === 0) return;
		const count = this.searchState.matches.length;
		this.searchState.selected = (this.searchState.selected + delta + count) % count;
		this.applySelectedMatch();
		this.tui.requestRender();
	}

	private refreshMatches(): void {
		if (!this.searchState) return;
		this.searchState.matches = this.store.search(this.searchState.query, this.searchState.originalText);
		this.searchState.selected = 0;
		this.applySelectedMatch();
		this.tui.requestRender();
	}

	private applySelectedMatch(): void {
		if (!this.searchState) return;
		const match = this.searchState.matches[this.searchState.selected];
		this.inner.setText(match ?? this.searchState.originalText);
	}

	private highlightQuery(line: string, query: string): string {
		const normalizedQuery = query.toLowerCase();
		if (!normalizedQuery) return line;

		let cursor = 0;
		let result = "";
		const lowerLine = line.toLowerCase();

		while (cursor < line.length) {
			const matchIndex = lowerLine.indexOf(normalizedQuery, cursor);
			if (matchIndex === -1) {
				result += line.slice(cursor);
				break;
			}

			result += line.slice(cursor, matchIndex);
			result += this.highlight(line.slice(matchIndex, matchIndex + query.length));
			cursor = matchIndex + query.length;
		}

		return result;
	}

	private acceptSearch(): void {
		this.searchState = undefined;
		this.tui.requestRender();
	}

	private cancelSearch(): void {
		if (!this.searchState) return;
		const originalText = this.searchState.originalText;
		this.searchState = undefined;
		this.inner.setText(originalText);
		this.tui.requestRender();
	}

	private isPrintableInput(data: string): boolean {
		return data.length > 0 && !data.includes("\x1b") && [...data].every((char) => char >= " ");
	}
}

function loadConfig(cwd: string): PromptHistoryConfig {
	const config: PromptHistoryConfig = { ...DEFAULT_CONFIG };
	applyConfigFile(config, GLOBAL_CONFIG_FILE);
	applyConfigFile(config, path.join(cwd, PROJECT_CONFIG_FILE));
	return config;
}

function applyConfigFile(config: PromptHistoryConfig, file: string): void {
	try {
		if (!fs.existsSync(file)) return;
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { scope?: unknown; searchScope?: unknown };
		const scope = parsed.scope ?? parsed.searchScope;
		if (scope === "all" || scope === "all-sessions" || scope === "global") config.scope = "all";
		if (scope === "current" || scope === "current-session" || scope === "session") config.scope = "current-session";
	} catch {
		// Invalid config should not break pi.
	}
}

function extractUserPromptEntriesFromSession(ctx: ExtensionContext): PromptHistoryEntry[] {
	return extractUserPromptEntriesFromEntries(ctx.sessionManager.getEntries(), {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionId: ctx.sessionManager.getSessionId(),
	});
}

function extractUserPromptEntriesFromSessionFile(sessionFile: string, fallbackCwd?: string): PromptHistoryEntry[] {
	try {
		const fileEntries = parseSessionEntries(fs.readFileSync(sessionFile, "utf-8"));
		const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
		const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
		return extractUserPromptEntriesFromEntries(entries, {
			cwd: header?.cwd ?? fallbackCwd,
			sessionFile,
			sessionId: header?.id,
		});
	} catch {
		return [];
	}
}

function extractUserPromptEntriesFromEntries(
	entries: SessionEntry[],
	session: { cwd?: string; sessionFile?: string; sessionId?: string },
): PromptHistoryEntry[] {
	const prompts: PromptHistoryEntry[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractTextFromUserMessage(entry.message.content);
		if (!text) continue;
		prompts.push({
			text,
			timestamp: Date.parse(entry.timestamp) || Date.now(),
			cwd: session.cwd,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			entryId: entry.id,
		});
	}

	return prompts;
}

function extractTextFromUserMessage(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() ? content : undefined;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter((block): block is { type: "text"; text: string } => {
			const maybeBlock = block as { type?: unknown; text?: unknown };
			return maybeBlock.type === "text" && typeof maybeBlock.text === "string";
		})
		.map((block) => block.text)
		.join("\n");

	return text.trim() ? text : undefined;
}

function indexedEntryKey(entry: PromptHistoryEntry): string | undefined {
	if (entry.sessionFile && entry.entryId) return `file:${entry.sessionFile}:${entry.entryId}`;
	if (entry.sessionId && entry.entryId) return `session:${entry.sessionId}:${entry.entryId}`;
	return undefined;
}

function getEditorOptions(cwd: string): { paddingX: number; autocompleteMaxVisible: number } {
	try {
		const settings = SettingsManager.create(cwd, AGENT_DIR);
		return {
			paddingX: settings.getEditorPaddingX(),
			autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
		};
	} catch {
		return { paddingX: 0, autocompleteMaxVisible: 5 };
	}
}

export default function (pi: ExtensionAPI) {
	const store = new PromptHistoryStore(INDEX_FILE);
	let previousEditorFactory: CustomEditorFactory | undefined;
	let installed = false;

	pi.on("session_start", async (_event, ctx) => {
		store.configure(ctx.cwd);
		store.setActiveSession(ctx);

		const needsIndex = !store.hasIndex();
		if (needsIndex) ctx.ui.notify("Building prompt history index from existing sessions...", "info");
		const builtIndex = await store.ensureIndex();
		store.addEntries(extractUserPromptEntriesFromSession(ctx));
		if (builtIndex) ctx.ui.notify(`Prompt history indexed ${store.count()} user messages.`, "info");

		if (installed) return;
		previousEditorFactory = ctx.ui.getEditorComponent();
		const editorOptions = getEditorOptions(ctx.cwd);
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const inner = previousEditorFactory
				? previousEditorFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, editorOptions);
			return new PromptHistoryEditor(inner, store, tui, keybindings, (text) => `\x1b[33m\x1b[1m${text}\x1b[22m\x1b[39m`);
		});
		installed = true;
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		store.configure(ctx.cwd);
		store.setActiveSession(ctx);
		store.add(event.text, ctx.cwd, {
			sessionFile: ctx.sessionManager.getSessionFile(),
			sessionId: ctx.sessionManager.getSessionId(),
		});
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (installed) {
			ctx.ui.setEditorComponent(previousEditorFactory);
			installed = false;
		}
	});

	pi.registerCommand("prompt-history", {
		description: "Pick a previous prompt and put it in the editor",
		handler: async (_args, ctx) => {
			store.configure(ctx.cwd);
			store.setActiveSession(ctx);
			const choices = store.allNewestFirst();
			if (choices.length === 0) {
				ctx.ui.notify(`No prompt history yet for ${store.getScopeLabel()}.`, "info");
				return;
			}

			const labelWidth = Math.max(20, Math.min(process.stdout.columns || 120, 120) - 8);
			const labels = choices.map((text, index) => `${index + 1}. ${truncateToWidth(text.split("\n")[0] ?? "", labelWidth)}`);
			const selected = await ctx.ui.select(`Prompt history (${store.getScopeLabel()})`, labels);
			if (!selected) return;

			const index = labels.indexOf(selected);
			if (index >= 0) ctx.ui.setEditorText(choices[index] ?? "");
		},
	});

	pi.registerCommand("prompt-history-reindex", {
		description: "Rebuild the prompt history index from all saved sessions",
		handler: async (_args, ctx) => {
			store.configure(ctx.cwd);
			ctx.ui.notify("Rebuilding prompt history index...", "info");
			await store.rebuildFromAllSessions();
			store.setActiveSession(ctx);
			store.addEntries(extractUserPromptEntriesFromSession(ctx));
			ctx.ui.notify(`Prompt history indexed ${store.count()} user messages.`, "info");
		},
	});

	pi.registerCommand("prompt-history-clear", {
		description: "Clear the Ctrl+R prompt history index",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Clear prompt history?", `Delete ${INDEX_FILE}?`);
			if (!ok) return;
			store.clear();
			ctx.ui.notify("Prompt history cleared.", "info");
		},
	});
}

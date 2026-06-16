import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CustomEditor, type EditorFactory, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type Focusable,
	type TUI,
} from "@mariozechner/pi-tui";

const HISTORY_FILE = path.join(os.homedir(), ".pi", "agent", "prompt-history.json");
const MAX_HISTORY = 2000;
const EXTENSION_ID = "prompt-history-search";

type PromptHistoryEntry = {
	text: string;
	timestamp: number;
	cwd?: string;
};

type PromptHistoryFile = {
	version: 1;
	entries: PromptHistoryEntry[];
};

class PromptHistoryStore {
	private entries: PromptHistoryEntry[] = [];

	constructor(private readonly file: string) {
		this.load();
	}

	add(text: string, cwd?: string, options?: { persist?: boolean }): boolean {
		const normalized = this.normalize(text);
		if (!normalized) return false;

		const existing = this.entries.findIndex((entry) => entry.text === normalized);
		if (existing >= 0) this.entries.splice(existing, 1);

		this.entries.push({ text: normalized, timestamp: Date.now(), cwd });
		this.trim();
		if (options?.persist !== false) this.save();
		return true;
	}

	addMany(texts: string[], cwd?: string): void {
		let changed = false;
		for (const text of texts) {
			changed = this.add(text, cwd, { persist: false }) || changed;
		}
		if (changed) this.save();
	}

	search(query: string, exclude?: string): string[] {
		const needle = query.trim().toLowerCase();
		const excludeNormalized = exclude ? this.normalize(exclude) : undefined;
		const seen = new Set<string>();
		const result: string[] = [];

		for (let i = this.entries.length - 1; i >= 0; i--) {
			const text = this.entries[i]?.text;
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

	clear(): void {
		this.entries = [];
		try {
			fs.rmSync(this.file, { force: true });
		} catch {
			// Ignore.
		}
	}

	private normalize(text: string): string {
		return text.replace(/\r\n?/g, "\n").trim();
	}

	private trim(): void {
		if (this.entries.length > MAX_HISTORY) {
			this.entries = this.entries.slice(this.entries.length - MAX_HISTORY);
		}
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.file)) return;
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<PromptHistoryFile>;
			if (!Array.isArray(parsed.entries)) return;
			this.entries = parsed.entries
				.filter((entry): entry is PromptHistoryEntry => typeof entry?.text === "string" && entry.text.trim().length > 0)
				.map((entry) => ({
					text: this.normalize(entry.text),
					timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
					cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
				}));
			this.trim();
		} catch {
			this.entries = [];
		}
	}

	private save(): void {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			const payload: PromptHistoryFile = { version: 1, entries: this.entries };
			const tmp = `${this.file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
			fs.renameSync(tmp, this.file);
		} catch {
			// History is a convenience feature; never break pi if persistence fails.
		}
	}
}

class PromptHistoryEditor implements EditorComponent, Focusable {
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
			? `reverse prompt search ${state.selected + 1}/${state.matches.length}: ${query}`
			: `reverse prompt search: ${query} — no match`;
		const help = "Enter accept • Esc cancel • Ctrl+R older • Ctrl+S newer";

		return [
			...lines,
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

		this.inner.handleInput(data);
	}

	dispose(): void {
		(this.inner as EditorComponent & { dispose?: () => void }).dispose?.();
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

function extractUserPromptsFromSession(ctx: ExtensionContext): string[] {
	const branch = ctx.sessionManager.getBranch() as unknown[];
	const prompts: string[] = [];

	for (const entry of branch) {
		const maybeEntry = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (maybeEntry.type !== "message" || maybeEntry.message?.role !== "user") continue;

		const content = maybeEntry.message.content;
		if (typeof content === "string") {
			prompts.push(content);
		} else if (Array.isArray(content)) {
			const text = content
				.filter((block): block is { type: "text"; text: string } => {
					const maybeBlock = block as { type?: unknown; text?: unknown };
					return maybeBlock.type === "text" && typeof maybeBlock.text === "string";
				})
				.map((block) => block.text)
				.join("\n");
			if (text.trim()) prompts.push(text);
		}
	}

	return prompts;
}

export default function (pi: ExtensionAPI) {
	const store = new PromptHistoryStore(HISTORY_FILE);
	let previousEditorFactory: EditorFactory | undefined;
	let installed = false;

	pi.on("session_start", (_event, ctx) => {
		store.addMany(extractUserPromptsFromSession(ctx), ctx.cwd);

		if (installed) return;
		previousEditorFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const inner = previousEditorFactory
				? previousEditorFactory(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings);
			return new PromptHistoryEditor(inner, store, tui);
		});
		ctx.ui.setStatus(EXTENSION_ID, "Ctrl+R prompt search");
		installed = true;
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		store.add(event.text, ctx.cwd);
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (installed) {
			ctx.ui.setEditorComponent(previousEditorFactory);
			ctx.ui.setStatus(EXTENSION_ID, undefined);
			installed = false;
		}
	});

	pi.registerCommand("prompt-history", {
		description: "Pick a previous prompt and put it in the editor",
		handler: async (_args, ctx) => {
			const choices = store.allNewestFirst();
			if (choices.length === 0) {
				ctx.ui.notify("No prompt history yet.", "info");
				return;
			}

			const labels = choices.map((text, index) => `${index + 1}. ${text.split("\n")[0] ?? ""}`);
			const selected = await ctx.ui.select("Prompt history", labels);
			if (!selected) return;

			const index = labels.indexOf(selected);
			if (index >= 0) ctx.ui.setEditorText(choices[index] ?? "");
		},
	});

	pi.registerCommand("prompt-history-clear", {
		description: "Clear the Ctrl+R prompt history file",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm("Clear prompt history?", `Delete ${HISTORY_FILE}?`);
			if (!ok) return;
			store.clear();
			ctx.ui.notify("Prompt history cleared.", "info");
		},
	});
}

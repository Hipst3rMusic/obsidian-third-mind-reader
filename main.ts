import {
	Plugin,
	PluginSettingTab,
	Setting,
	App,
	ItemView,
	WorkspaceLeaf,
	TFile,
	TFolder,
	MarkdownRenderer,
	Menu,
	setIcon,
	setTooltip,
	Notice,
	SecretComponent,
	TextAreaComponent,
	TextComponent,
	SuggestModal,
	Platform,
	apiVersion,
} from "obsidian";
import * as nodePath from "path";
import * as fs from "fs";
import { exec } from "child_process";
import {
	parseEpub,
	parseEpubDir,
	renderSpineRange,
	revokeImageUrls,
	extractLinkPreview,
	resolveEpubHref,
	EpubBook,
	EpubTocItem,
	type EpubLinkPreview,
} from "./epub";
import { OffsetMap, type CursorRange } from "./pretext-layer";
import { chat, probeProvider, probeModelLoaded, type AiProvider, type ChatMessage, type ProviderKind, type LocalRuntime } from "./ai-client";
import { LibraryView, LIBRARY_VIEW_TYPE } from "./library-view";
import { type LibraryOverride, invalidateMetaCache, LIBRARY_ROOT } from "./library-scan";

export const READER_VIEW_TYPE = "third-mind-reader";

/** Per-mode model overrides. Only set when the user wants a non-default
 *  routing for that mode (e.g. Examine pinned to a stronger cloud model).
 *  Each entry references a provider by id + a model id within it. */
type GlossModeId = "explain" | "examine" | "exclaim" | "enquiry";

interface ImportEntry {
	folderPath: string;
	name: string;
	finalName: string;
	checked: boolean;
}

interface AiDefaults {
	/** Provider id used by default for new conversations. Null = no AI
	 *  configured yet (Conversations tab still works for displaying past
	 *  exchanges; new turns are blocked with an "configure AI provider"
	 *  notice). */
	primaryProviderId: string | null;
	/** Optional per-mode override. Empty object = global default for all. */
	perMode: Partial<Record<GlossModeId, { providerId: string; model: string }>>;
}

interface ThirdMindReaderSettings {
	tmrMode: "obsidian" | "3c";
	tmrTheme: "light" | "dark";
	bookPositions: Record<string, ReaderPosition>;
	aiProviders: AiProvider[];
	aiDefaults: AiDefaults;
	/** Master switch for the AI surface. When off, the GlossBar shows only the
	 *  Emphasise tile (Lite) and the Highlights pane hides its tab bar; when on,
	 *  the AI Gloss modes + Conversations pane are available. Auto-enabled when
	 *  the first provider is added; default off. */
	aiFeaturesEnabled: boolean;
	/** Stream AI responses token-by-token (local openai-compatible providers
	 *  only — cloud kinds always buffer). On by default; surfaces a
	 *  "Loading model…" → "Thinking…" → live-text progression in the chat. */
	streaming: boolean;
	/** Show AI-mode callouts in the Conversations list even when the user
	 *  submitted no text and no AI turn followed (Exclaim/Enquiry edge cases).
	 *  Toggled per-pane via the chat-box gear popover; off by default. */
	showBareFlaggedConversations: boolean;
	/** Last-used source folder for the Apple Books importer (retained for migration only). */
	importSourceFolder?: string;
	/** Editable system-prompt templates per AI Gloss mode. `{book}` is
	 *  substituted with the book title; the selected passage is appended
	 *  automatically by `buildAiSystemPrompt`. */
	systemPrompts: Record<AiPromptMode, string>;
	/** Per-book display overrides for title/author, keyed by vault path. The
	 *  epub file is never modified — these only change how the Library renders
	 *  (e.g. trimming a junk suffix baked into the OPF metadata). */
	libraryOverrides: Record<string, LibraryOverride>;
	/** User-defined order for Library collection tabs (excludes "Everything",
	 *  which is always pinned leftmost). Also lets a freshly added but still-empty
	 *  folder appear as a tab. */
	libraryCollectionOrder: string[];
	/** One-time flag: the Library shows a feedback hint above the settings gear on
	 *  first load, then sets this so it never reappears. */
	feedbackHintShown: boolean;
}

/** Gloss modes that issue an AI request. Emphasise is excluded — it never
 *  calls the model. */
type AiPromptMode = "explain" | "examine" | "exclaim" | "enquiry";

const DEFAULT_SYSTEM_PROMPTS: Record<AiPromptMode, string> = {
	explain:
		`You are a concise reading assistant for "{book}". `
		+ `Answer the reader's question using your training knowledge only. `
		+ `Be precise and brief, and reply in plain conversational prose — `
		+ `no headings, tables, or diagrams.`,
	examine:
		`You are a thorough research assistant for "{book}". `
		+ `Explore the reader's question in depth. Check the web and Cite sources with numbered `
		+ `footnotes like [1], [2] and append each as "[^N]: Title — URL". `
		+ `Write your findings as flowing conversational prose; the only structure `
		+ `should be those footnotes — no headings, tables, or diagrams.`,
	exclaim:
		`You are an empathetic reading companion for "{book}". `
		+ `The reader has had a reaction to the passage. Respond warmly and `
		+ `connect it to themes, context, or broader ideas. `
		+ `Talk like a person rather than a document: natural prose, `
		+ `no headings, tables, or diagrams.`,
	enquiry:
		`You are a knowledgeable reading companion for "{book}". `
		+ `Have a thoughtful, open-ended conversation about the reader's question. `
		+ `Keep it substantive but conversational — natural prose, `
		+ `no headings, tables, or diagrams.`,
};

const DEFAULT_SETTINGS: ThirdMindReaderSettings = {
	tmrMode: "obsidian",
	tmrTheme: "dark",
	bookPositions: {},
	aiProviders: [],
	aiDefaults: { primaryProviderId: null, perMode: {} },
	aiFeaturesEnabled: false,
	streaming: true,
	showBareFlaggedConversations: false,
	systemPrompts: { ...DEFAULT_SYSTEM_PROMPTS },
	libraryOverrides: {},
	libraryCollectionOrder: [],
	feedbackHintShown: false,
};

/** Gloss annotation modes. Per-mode button fill + icon fill colours are
 *  DLS primitive hex values (Oh Dear, Look, Learn, All Good, Shadow-500 /
 *  Look, Prince-900, Dawn-800, Empire-600, Empire-800W) — semantic and
 *  theme-independent. See Feature Docs/Gloss - Feature Spec.md. */
const GLOSS_MODES = [
	{ id: "emphasise", label: "Emphasise", icon: "highlighter" },
	{ id: "exclaim",   label: "Exclaim",   icon: "circle-alert" },
	{ id: "explain",   label: "Explain",   icon: "help-circle" },
	{ id: "examine",   label: "Examine",   icon: "search" },
	{ id: "enquiry",   label: "Enquiry",   icon: "message-circle-more" },
] as const;

/** Placeholder copy per gloss mode; exact phrasing from Feature Spec §Phase 2. */
const GLOSS_PLACEHOLDERS: Record<string, string> = {
	emphasise: "your thought...",
	exclaim:   "what just happened...",
	explain:   "what's unclear...",
	examine:   "what do you want to explore...",
	enquiry:   "your question...",
};

/** Modes that get a `<!-- ai response pending -->` slot at submit time and
 *  that auto-fire an AI call immediately after the callout is written.
 *  Emphasise is never AI-bearing. */
const GLOSS_AI_MODES = new Set(["exclaim", "explain", "examine", "enquiry"]);

/** User-facing label for a pre-token live-exchange phase (the animated dots are
 *  appended separately). "streaming" never reaches here — it renders text. */
function pendingLabel(phase: "connecting" | "loading" | "thinking"): string {
	return phase === "connecting" ? "Connecting"
		: phase === "loading" ? "Loading model"
		: "Thinking";
}

/** Every mode whose callouts should surface in the Conversations tab,
 *  regardless of whether the AI has actually responded yet. Includes
 *  Exclaim and Enquiry so Phase 2 reactions and freeform prompts
 *  (currently AI-less) still show up — they will gain AI turns once
 *  Phase D lands. Emphasise is permanently excluded. */
const GLOSS_AI_MODES_ALL = new Set(["exclaim", "explain", "examine", "enquiry"]);

/** Sort priority for the Conversations list: Exclaim → Explain → Examine
 *  → Enquiry, matching the GlossBar tile order. Spec §"Sort order". */
const CONV_MODE_PRIORITY: Record<string, number> = {
	exclaim: 0,
	explain: 1,
	examine: 2,
	enquiry: 3,
};

/** A single conversation turn parsed out of a callout body. Multi-line
 *  turns are reconstructed by appending continuation lines (lines without
 *  a `User:` / `AI:` prefix that follow a turn header) to `content`. */
interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
}

/** A saved highlight as parsed from the companion doc. We keep raw char offsets
 *  and the text prefix rather than resolving to a CursorRange here — resolution
 *  happens at paint time against the live OffsetMap so highlights can recover
 *  from paragraph-index drift (paraId hint stale but prefix still matches). */
interface SavedHighlight {
	mode: string;
	paraIdHint: string;
	/** For cross-paragraph highlights: the paraId of the paragraph where the
	 *  selection ends. Absent for single-paragraph highlights. */
	endParaIdHint?: string;
	startChar: number;
	endChar: number;
	prefix: string;
	/** User's annotation text (lines inside the callout after the anchor,
	 *  excluding the source quote and any `<!-- ... -->` pending markers).
	 *  Shown in the hover preview. */
	userText: string;
	/** Source text quoted inside the callout (`> > ...` lines). Shown in the
	 *  hover preview as context under the annotation. */
	quote: string;
	/** Legacy pretext cursors, populated only when the anchor was written in
	 *  the pre-CFI format. Used as a last-resort fallback when char offsets
	 *  aren't available. */
	legacyCursors: { start: { segmentIndex: number; graphemeIndex: number };
	                 end:   { segmentIndex: number; graphemeIndex: number } } | null;
	/** Alternating user/assistant turns parsed from `User:` / `AI:` line
	 *  prefixes within the callout body. Phase 2 callouts (no prefixes)
	 *  produce an empty array and surface their content via `userText`. */
	turns: ConversationTurn[];
	/** State of the most recent AI exchange:
	 *  - "complete" — no pending marker, no error marker (Phase 2 default)
	 *  - "pending"  — `<!-- ai response pending -->` marker present
	 *  - "error"    — `<!-- ai error: ... -->` marker present (`aiError` set) */
	aiState: "complete" | "pending" | "error";
	/** Error text extracted from the `<!-- ai error: ... -->` marker, if any. */
	aiError?: string;
	/** Transient (never parsed or persisted) live-exchange phase, set only while
	 *  `aiState === "pending"` during an in-flight request. Drives the
	 *  conversation bubble: "connecting" (probing whether the model is resident) →
	 *  "loading" (local server cold-loading the model) → "thinking" (generating,
	 *  pre-first-token) → "streaming" (tokens arriving). Undefined on load and
	 *  once the exchange settles. */
	livePhase?: "connecting" | "loading" | "thinking" | "streaming";
	/** Transient accumulated text during `livePhase === "streaming"`. Rendered as
	 *  plain text live; replaced by the formatted markdown bubble on completion. */
	streamingText?: string;
}

const ANCHOR_PREFIX_LEN = 48;

/** Consecutive forward page-turns (with no backward turn) after a large jump
 *  before the "Back" pill decays. The return-point dot on the bar persists; the
 *  pill is the obtrusive part, so it recedes once the reader has committed to
 *  the destination. A backward turn = peeking, and resets the count. */
const BACK_PILL_COMMIT_TURNS = 3;

interface AssistantCitation {
	title: string;
	url: string;
}

/** Strip Markdown footnote definition lines (`[^N]: Title — URL`) from the
 *  end of an assistant turn and return the cleaned body alongside a numbered
 *  citation map. Used to render Examine responses with inline `[N]` pills
 *  that hover/click their source. Both em-dash and ASCII hyphen separators
 *  are accepted; lines without a URL are ignored. */
function parseAssistantCitations(content: string): {
	body: string;
	citations: Map<number, AssistantCitation>;
} {
	const citations = new Map<number, AssistantCitation>();
	const footnoteRe = /^\s*\[\^(\d+)\]:\s*(.+?)\s+[—–-]\s+(https?:\/\/\S+?)\s*$/;
	const lines = content.split(/\r?\n/);
	const bodyLines: string[] = [];
	for (const line of lines) {
		const m = footnoteRe.exec(line);
		if (m) {
			const num = parseInt(m[1], 10);
			citations.set(num, { title: m[2].trim(), url: m[3].trim() });
		} else {
			bodyLines.push(line);
		}
	}
	return { body: bodyLines.join("\n").trimEnd(), citations };
}

/** Parse `<!-- tmr-anchor ... -->` comments out of a companion-doc markdown
 *  string, pairing each with the mode declared on the preceding callout line.
 *  Accepts both the new `chars:S,E prefix:"..."` format and the legacy
 *  `start:s,g end:s,g` format so existing annotation files keep rendering. */
function parseSavedHighlights(md: string): SavedHighlight[] {
	const result: SavedHighlight[] = [];
	const modeRe = /^>\s*\[!(exclaim|explain|examine|emphasise|enquiry)\]/;
	const anchorRe = /<!--\s*tmr-anchor\s+([^>]*?)-->/;
	const fieldRe = /(spine|para|chars|start|end|prefix|endPara|endChars):(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
	const lines = md.split(/\r?\n/);

	let pendingMode: string | null = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const m = modeRe.exec(line);
		if (m) { pendingMode = m[1]; i++; continue; }

		const a = anchorRe.exec(line);
		if (!a || !pendingMode) { i++; continue; }

		const fields: Record<string, string> = {};
		for (const f of a[1].matchAll(fieldRe)) {
			fields[f[1]] = f[2] !== undefined ? f[2].replace(/\\"/g, '"') : f[3];
		}
		const paraIdHint = fields.para ?? "";
		if (!paraIdHint) { pendingMode = null; i++; continue; }

		const endParaIdHint = fields.endPara ?? undefined;

		let startChar = -1, endChar = -1;
		if (fields.chars) {
			const [s, e] = fields.chars.split(",").map((n) => parseInt(n, 10));
			if (Number.isFinite(s) && Number.isFinite(e)) { startChar = s; endChar = e; }
		}
		// Multi-para anchor: endChars holds the real end offset within endParaIdHint
		if (endParaIdHint && fields.endChars) {
			const e = parseInt(fields.endChars, 10);
			if (Number.isFinite(e)) endChar = e;
		}

		let legacyCursors: SavedHighlight["legacyCursors"] = null;
		if (fields.start && fields.end) {
			const [ss, sg] = fields.start.split(",").map((n) => parseInt(n, 10));
			const [es, eg] = fields.end.split(",").map((n) => parseInt(n, 10));
			if ([ss, sg, es, eg].every(Number.isFinite)) {
				legacyCursors = {
					start: { segmentIndex: ss, graphemeIndex: sg },
					end:   { segmentIndex: es, graphemeIndex: eg },
				};
			}
		}

		const prefix = fields.prefix ? decodeURIComponent(fields.prefix) : "";

		// Walk forward through the callout body (all subsequent `>`-prefixed
		// lines) and split into:
		//   - source quote   (`> > ...` lines)
		//   - turns          (`> User: ...` / `> AI: ...` line-prefix scheme)
		//   - legacyUserText (bare `> <text>` lines without a turn prefix —
		//                     Phase 2 callouts, before multi-turn was a thing)
		// HTML comments are scanned for AI state markers. Continuation lines
		// for a turn (lines following `User:` / `AI:` that don't start with
		// either prefix and aren't a comment) are appended to that turn.
		const quoteLines: string[] = [];
		const legacyUserLines: string[] = [];
		const turns: ConversationTurn[] = [];
		let aiState: SavedHighlight["aiState"] = "complete";
		let aiError: string | undefined;
		let currentTurn: ConversationTurn | null = null;
		const turnHeaderRe = /^(User|AI):\s*(.*)$/;
		const aiPendingRe = /<!--\s*ai response pending\s*-->/i;
		const aiErrorRe = /<!--\s*ai error:\s*(.*?)\s*-->/i;
		let j = i + 1;
		while (j < lines.length) {
			const bodyLine = lines[j];
			if (!/^>/.test(bodyLine)) break;
			// Bail if we hit the next callout's header line
			if (modeRe.test(bodyLine)) break;

			const stripped = bodyLine.replace(/^>\s?/, "");
			if (/^>/.test(stripped)) {
				quoteLines.push(stripped.replace(/^>\s?/, ""));
				currentTurn = null;
			} else if (/^<!--.*-->\s*$/.test(stripped.trim())) {
				if (aiPendingRe.test(stripped)) aiState = "pending";
				const errMatch = aiErrorRe.exec(stripped);
				if (errMatch) { aiState = "error"; aiError = errMatch[1]; }
				currentTurn = null;
			} else if (stripped.trim().length === 0) {
				// Blank line inside a callout. If we're mid-turn, treat as a
				// paragraph break rather than resetting — multi-paragraph AI
				// responses write `> ` blank lines that must not orphan the
				// continuation lines that follow.
				if (currentTurn) currentTurn.content += "\n\n";
			} else {
				const turnMatch = turnHeaderRe.exec(stripped);
				if (turnMatch) {
					currentTurn = {
						role: turnMatch[1] === "User" ? "user" : "assistant",
						content: turnMatch[2],
					};
					turns.push(currentTurn);
				} else if (currentTurn) {
					// Continuation of the previous turn (multi-line user/AI text).
					currentTurn.content += "\n" + stripped;
				} else {
					// Phase 2 legacy: bare user text with no `User:` prefix.
					legacyUserLines.push(stripped);
				}
			}
			j++;
		}

		// Prefer the first explicit user turn for `userText` (the field that
		// powers hover previews and the conversations-card title); fall back
		// to the legacy bucket for Phase 2 callouts.
		const firstUserTurn = turns.find((t) => t.role === "user");
		const userText = firstUserTurn?.content.trim() ?? legacyUserLines.join("\n").trim();

		result.push({
			mode: pendingMode,
			paraIdHint,
			endParaIdHint,
			startChar,
			endChar,
			prefix,
			userText,
			quote: quoteLines.join("\n").trim(),
			legacyCursors,
			turns,
			aiState,
			aiError,
		});
		pendingMode = null;
		i = j;
	}
	return result;
}

/** Inline SVG for the 3C logo (from Hipst3r-DLS/3CLibrary.pen, node 0goli).
 *  Exported so the Library's 3C-mode toggle reuses the exact same mark. */
export const LOGO_3C_SVG =
	'<svg viewBox="0 0 116 106" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
	'<path d="M93.18848 28.23926c13.49923 6.5209 22.81152 20.33795 22.81152 36.3291-0.00023 22.27106-18.06232 40.32514-40.34277 40.32519-8.60221 0-16.57421-2.69321-23.12207-7.27929 15.27594-1.13094 28.59509-9.2851 36.74804-21.24317-3.99014 4.82665-10.02286 7.90332-16.77441 7.90332-12.01438-0.00017-21.75391-9.74046-21.75391-21.75488 0.00017-12.01427 9.73963-21.75373 21.75391-21.7539 12.01442 0 21.75471 9.73953 21.75488 21.7539 0 2.69022-0.48997 5.26622-1.38281 7.64453 3.11907-6.43531 4.86914-13.65764 4.86914-21.28906-0.00001-7.37464-1.63689-14.36607-4.56152-20.63574z m-44.31348-28.23926c19.61829 0 36.53326 11.56047 44.31348 28.23926-5.30147-2.56091-11.24851-3.99705-17.53125-3.99707-22.28064 0-40.34277 18.05488-40.34278 40.32617 0.00014 13.67252 6.80903 25.75362 17.22071 33.0459-1.20835 0.08946-2.42894 0.13574-3.66016 0.13574-26.99292-0.00004-48.875-21.88206-48.875-48.875 0.00004-26.9929 21.8821-48.87496 48.875-48.875z"/>' +
	'</svg>';

interface ReaderSection {
	id: string;
	label: string;
	tocHref: string;
	startSpine: number;
	endSpine: number;
}

interface RenderUnit {
	id: string;
	sectionIds: string[];
	sectionOffsets: number[];
	startSpine: number;
	endSpine: number;
	spreadCount: number;
	/** True when this unit holds a single short section that couldn't be paired
	 *  with an adjacent section. Renders as a centered single-column page
	 *  rather than in the left column of an empty two-column spread. */
	singlePage?: boolean;
}

interface ReaderPosition {
	unitIndex: number;
	spread: number;
	/** Last-active right-rail tab for this book. Persisted across sessions
	 *  so re-opening a book whose user was last on Conversations restores
	 *  there. Optional for backward compat — Phase 2 stored positions
	 *  without this field. */
	pane?: "annotations" | "conversations";
	/** Cached reading fraction (0..1), written on every position-save. The Library
	 *  card reads this directly for its progress bar and never recomputes it.
	 *  Optional for backward compat — books last read before Phase D lack it
	 *  (the Library treats absent as "Unread"). */
	pct?: number;
}

type LayoutMode = "spread" | "single";

/** Render inline markdown (bold, italic, code) into `el` synchronously.
 *  HTML-escapes the text first so this is safe for untrusted content.
 *  Handles: **bold**, *italic*, ***bold-italic***, `code`. */
function setInlineMarkdown(el: HTMLElement, text: string): void {
	const esc = text
		.replace(/&/g, "&amp;").replace(/</g, "&lt;")
		.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	el.innerHTML = esc
		.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Searchable list of a provider's available models. Shared by the settings
 *  "Browse" button and the in-chat model picker. */
class ModelPickerModal extends SuggestModal<string> {
	constructor(app: App, private models: string[], private onPick: (model: string) => void) {
		super(app);
		this.setPlaceholder("Search models…");
	}
	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.models.filter((m) => m.toLowerCase().includes(q));
	}
	renderSuggestion(model: string, el: HTMLElement): void {
		el.createSpan({ text: model });
	}
	onChooseSuggestion(model: string): void {
		this.onPick(model);
	}
}

/** Probe a provider's `/v1/models`, then open {@link ModelPickerModal}. Surfaces
 *  a Notice on an unreachable provider or an empty list instead of opening an
 *  empty modal. Works for any provider kind probeProvider enumerates. */
async function pickModel(
	app: App,
	provider: AiProvider,
	onPick: (model: string) => void,
): Promise<void> {
	const result = await probeProvider(provider);
	if (!result.available) {
		new Notice(`✗ ${provider.id}: ${result.error ?? "unreachable"}`);
		return;
	}
	if (result.models.length === 0) {
		new Notice(`${provider.id}: server returned no models`);
		return;
	}
	new ModelPickerModal(app, [...result.models].sort(), onPick).open();
}

// ─── REGION: ReaderView — Fields ────────────────────────────────────────────
export class ReaderView extends ItemView {
	private currentFile: TFile | null = null;
	private currentFolder: TFolder | null = null;
	private book: EpubBook | null = null;

	private spineIndex = 0;
	private currentSpread = 0;
	private currentUnitIndex = 0;
	private totalSpreads = 1;
	private tocAnchorPageMap: Array<{ spreadOffset: number; href: string }> = [];

	private tocOpen = false;

	private resizeObserver: ResizeObserver | null = null;
	private statusBarObserver: ResizeObserver | null = null;
	private resizeTimer: number | null = null;
	private isDraggingProgress = false;
	private progressTooltipRaf: number | null = null;
	private pendingProgressMouseEvent: MouseEvent | null = null;

	private tooltipEl: HTMLElement | null = null;
	private linkPreviewCache = new Map<string, EpubLinkPreview | null>();
	private linkPreviewPending = new Map<string, Promise<EpubLinkPreview | null>>();
	private hoveredLinkPreviewKey: string | null = null;
	private previousPosition: ReaderPosition | null = null;
	/** Forward page-turns since the current anchor was set; reset by a backward
	 *  turn. Drives the pill decay — see {@link BACK_PILL_COMMIT_TURNS}. */
	private backForwardTurns = 0;
	/** True once the reader has committed to the jump destination: the pill has
	 *  receded, leaving only the return-point dot. The anchor itself lives on. */
	private backPillDismissed = false;
	/** Transiently re-summons a dismissed pill while the dot is hovered. */
	private backPillHovering = false;

	private spreadEl: HTMLElement | null = null;
	private contentNode: HTMLElement | null = null;
	private cacheHost: HTMLElement | null = null;
	private prevHost: HTMLElement | null = null;
	private nextHost: HTMLElement | null = null;
	private tocListEl: HTMLElement | null = null;
	private tocTitleEl: HTMLElement | null = null;
	private progressBarEl: HTMLElement | null = null;
	private progressTipEl: HTMLElement | null = null;
	private globalPageEl: HTMLElement | null = null;
	private localPageEl: HTMLElement | null = null;

	private measurementSpreadEl: HTMLElement | null = null;
	private measurementContentEl: HTMLElement | null = null;
	private measurementBucketKey = "";

	private sections: ReaderSection[] = [];
	private units: RenderUnit[] = [];
	private sectionIndexById = new Map<string, number>();
	private sectionIndexBySpine: number[] = [];
	private unitIndexBySection = new Map<string, number>();
	private sectionSpreadCounts: number[] = [];
	private sectionColumnCounts: number[] = [];
	private sectionStartSpreads: number[] = [];
	private unitStartSpreads: number[] = [];
	private spreadMeasureCache = new Map<string, number>();

	private unitDomCache = new Map<number, HTMLElement>();
	private mountedUnitIndices = { prev: -1, next: -1 };
	private renderToken = 0;
	private offsetMap = new OffsetMap();
	private layoutMode: LayoutMode = "spread";

	private glossBarEl: HTMLElement | null = null;
	private glossInputEl: HTMLElement | null = null;
	private glossTileTooltipEl: HTMLElement | null = null;
	private highlightOverlayEl: HTMLElement | null = null;
	private highlightsPanelEl: HTMLElement | null = null;
	private hlNoteBtnEl: HTMLElement | null = null;
	private highlightsListEl: HTMLElement | null = null;
	private conversationsListEl: HTMLElement | null = null;
	private convCardsEl: HTMLElement | null = null;
	private convFilterRowEl: HTMLElement | null = null;
	private paneTabsEl: HTMLElement | null = null;
	private paneTab: "annotations" | "conversations" = "annotations";
	private convFilterOpen = false;
	private convSort: "priority" | "recent" | "chapter" = "priority";
	private highlightsOpen = false;
	private activeHighlight: CursorRange | null = null;
	private activeSelectionText: string | null = null;
	private activeSelectionRect: DOMRect | null = null;
	private activeGlossMode: string | null = null;
	/** Anchored cross-page selection. While `isExtending`, the start boundary is
	 *  frozen in `extendAnchor` (a live DOM point — valid as long as the unit's
	 *  DOM persists, i.e. within-unit page turns), the selection survives
	 *  navigation, and the next reader click sets the far endpoint. */
	private isExtending = false;
	private extendAnchor: { node: Node; offset: number } | null = null;
	private extendHintEl: HTMLElement | null = null;
	private savedHighlights: SavedHighlight[] = [];
	/** Index into `savedHighlights` whose note is currently being edited inline
	 *  in the Annotations pane; null when no editor is open. Render-state, so the
	 *  editor survives the full re-renders triggered elsewhere. */
	private editingNoteIdx: number | null = null;
	/** Section IDs whose Annotations-pane chapter group is collapsed. In-memory
	 *  only — resets to all-expanded when a book opens (cleared on book reset). */
	private collapsedSections = new Set<string>();
	private annotationPreviewEl: HTMLElement | null = null;
	private hoveredHighlightIdx = -1;
	/** Index into `savedHighlights` of the currently expanded conversation, or
	 *  -1 when none is open. Drives the `tmr-saved-highlight-rect-active` class
	 *  on overlay rects so the source passage stays visually pinned during the
	 *  exchange. Cleared by `toggleConversationCard` when the card collapses. */
	private activeConversationIdx = -1;
	/** Live `.tmr-conv-log` element of the currently-open conversation surface, or
	 *  null when no card is expanded. Lets the initial auto-fired AI exchange
	 *  stream into the open card's DOM (it's started right after the card opens,
	 *  so there's no `log` argument to thread through). */
	private activeConvLog: HTMLElement | null = null;
	/** Abort controller for the in-flight streamed AI exchange, if any. Aborted
	 *  when the hosting conversation card closes or the view unloads so a stream
	 *  never outlives its surface. Null when no exchange is running. */
	private activeStreamAbort: AbortController | null = null;
	/** Monotonic render token + per-log generation. `renderConversationLog` is
	 *  async (awaits MarkdownRenderer per turn); concurrent calls on the same log
	 *  would interleave into one tree. A render checks its generation after each
	 *  await and bails if a newer render has superseded it. */
	private convRenderSeq = 0;
	private convLogSeq = new WeakMap<HTMLElement, number>();

	private positionSaveTimer: number | null = null;

	private static readonly GAP = 48;
	private static readonly SINGLE_PAGE_HYSTERESIS = 32;
	private static readonly SINGLE_PAGE_BREAK_RATIO = 0.72;
	private static readonly SINGLE_PAGE_MIN_SPREAD_COL = 420;
	private static readonly SINGLE_PAGE_MAX_SPREAD_COL = 560;
	private static readonly TOOLTIP_MAX_CHARS = 900;
	private static readonly TOOLTIP_MARGIN = 16;
	private static readonly TOOLTIP_OFFSET_X = 14;
	private static readonly TOOLTIP_OFFSET_Y = 18;

	// ─── REGION: Lifecycle ───────────────────────────────────────────────────
	constructor(leaf: WorkspaceLeaf, private plugin: ThirdMindReader) {
		super(leaf);
	}

	getViewType(): string {
		return READER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.currentFile?.basename ?? this.currentFolder?.name ?? "Third Mind Reader";
	}

	getIcon(): string {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
			this.resizeTimer = window.setTimeout(() => {
				this.resizeTimer = null;
				void this.handleResize();
			}, 250);
		});

		const statusBar = document.querySelector<HTMLElement>(".status-bar");
		if (statusBar) {
			this.statusBarObserver = new ResizeObserver(() => {
				const h = statusBar.getBoundingClientRect().height;
				this.containerEl.style.setProperty("--status-bar-height", `${h}px`);
			});
			this.statusBarObserver.observe(statusBar);
			// Seed immediately so panels have the correct value on first render.
			this.containerEl.style.setProperty(
				"--status-bar-height",
				`${statusBar.getBoundingClientRect().height}px`
			);
		}

		this.renderShell();

		this.registerDomEvent(document, "mouseup", () => {
			this.isDraggingProgress = false;
		});

		// Reader bare-key shortcuts (t / h / 1–5 / ← / →) are handled HERE, scoped
		// to this view: the handler no-ops unless this reader is the active leaf,
		// so the keys never interfere with typing in a note or any other view.
		// They are deliberately NOT Obsidian command hotkeys — command hotkeys are
		// global and a bare key (especially the arrows) steals the keystroke from
		// the editor app-wide. Only modifier combos are safe as commands, so just
		// those live in `addReaderCommands`. Escape is also handled here (universal
		// cancel; fires even while a panel input has focus).
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (this.app.workspace.activeLeaf !== this.leaf) return;
			if (e.key === "Escape" && this.isGlossActive()) {
				this.dismissGloss();
				return;
			}
			// While a text field (gloss input, note editor, chat box, search…) has
			// focus, keystrokes belong to it: navigation and shortcuts yield.
			const typing = this.isTextInputFocused();
			// GlossBar numeric shortcuts (1–5): only over a live selection.
			if (
				!typing &&
				!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
				/^[1-5]$/.test(e.key)
			) {
				const mode = this.glossShortcutMode(parseInt(e.key, 10));
				if (mode) {
					e.preventDefault();
					e.stopPropagation();
					this.openGlossInput(mode);
					return;
				}
			}
			if (!typing && e.key === "ArrowRight") void this.advance();
			if (!typing && e.key === "ArrowLeft") void this.retreat();
			if (e.key === "Escape" && this.tocOpen) this.toggleToc();
			if (e.key === "Escape" && this.highlightsOpen) this.toggleHighlightsPanel();
			if (!typing && (e.key === "t" || e.key === "h") && !e.ctrlKey && !e.metaKey && !e.altKey) {
				if (e.key === "t") this.toggleToc();
				else this.toggleHighlightsPanel();
			}
		});

		this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
			// The end-click of an extend is resolved on mouseup — never dismiss it.
			if (this.isExtending) return;
			// Shift-click extends the live selection (browser handles the range
			// growth); dismissing here would wipe it before it can extend.
			if (e.shiftKey) return;
			if (!this.isGlossActive()) return;
			const target = e.target as Node;
			if (this.glossBarEl?.contains(target)) return;
			if (this.glossInputEl?.contains(target)) return;
			this.dismissGloss();
		});
	}

	async onClose(): Promise<void> {
		this.activeStreamAbort?.abort();
		this.activeStreamAbort = null;
		this.activeConvLog = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		if (this.book) revokeImageUrls(this.book);
		this.linkPreviewCache.clear();
		this.linkPreviewPending.clear();
		this.hoveredLinkPreviewKey = null;
		this.tooltipEl?.remove();
		this.glossBarEl?.remove();
		this.glossBarEl = null;
		this.glossInputEl?.remove();
		this.glossInputEl = null;
		this.glossTileTooltipEl?.remove();
		this.glossTileTooltipEl = null;
		this.extendHintEl?.remove();
		this.extendHintEl = null;
		this.isExtending = false;
		this.extendAnchor = null;
		this.annotationPreviewEl?.remove();
		this.annotationPreviewEl = null;
		this.hoveredHighlightIdx = -1;
		this.clearHighlightOverlay();
		if (this.progressTooltipRaf !== null) cancelAnimationFrame(this.progressTooltipRaf);
		this.progressTooltipRaf = null;
		// Flush any pending debounced save so the last position isn't lost on close.
		if (this.positionSaveTimer !== null) {
			window.clearTimeout(this.positionSaveTimer);
			this.positionSaveTimer = null;
		}
		const closePath = this.currentFile?.path ?? this.currentFolder?.path;
		if (closePath && this.book) {
			this.writeBookPosition(closePath);
			void this.plugin.persistSettings();
		}
		this.contentEl.empty();
	}

	async setState(state: any, result: any): Promise<void> {
		const filePath: string | undefined = state?.state?.file ?? state?.file;
		if (filePath) {
			const incomingUnit = state?.state?.unitIndex ?? state?.unitIndex;
			const incomingSpread = state?.state?.spread ?? state?.spread;
			const storedPos = this.plugin.settings.bookPositions[filePath];
			const savedUnitIndex: number = incomingUnit ?? storedPos?.unitIndex ?? 0;
			const savedSpread: number = incomingSpread ?? storedPos?.spread ?? 0;

			// Tab-restore: this view already has the same epub loaded.
			// Just seek to the saved position — no reload, no new-tab redirect.
			const alreadyLoaded =
				this.book !== null &&
				(this.currentFile?.path === filePath || this.currentFolder?.path === filePath);
			if (alreadyLoaded) {
				// If the restore state doesn't carry a real position, keep the
				// live position rather than remounting at spread 0. Obsidian
				// sometimes hands us a bare { file } state on tab activation
				// — trusting the ?? 0 fallback there would throw the reader
				// back to the cover after the user has navigated into the book.
				const hasPosition = incomingUnit !== undefined || incomingSpread !== undefined;
				if (hasPosition) {
					await this.mountCurrentUnit(savedUnitIndex, savedSpread);
				}
				await super.setState(state, result);
				return;
			}

			// First open (Obsidian opened the epub, not us). Two cases:
			if (!this.plugin._openingEpub) {
				const hist = (this.leaf as any).history;
				if (hist?.back?.length) {
					// The leaf already holds content the user navigated to (e.g. Cmd+O
					// replacing the active tab). Don't clobber it: open the book in a
					// dedicated tab and revert this leaf to where it was.
					const originatingLeaf = this.leaf;
					void this.plugin.openEpubInNewTab(filePath);
					setTimeout(() => {
						originatingLeaf.setViewState(hist.back[hist.back.length - 1].state);
					}, 0);
					return;
				}
				// Otherwise this is a fresh, history-less leaf (a Shift+Cmd+T restore or
				// a new-tab open). There's nothing to preserve, so just load the book
				// in place and fall through. The old redirect-and-detach left an
				// orphaned "Opening…" tab under rapid restores — loading in place is
				// race-free and what Obsidian does for every other file type (bug B2).
			}

			const node = this.app.vault.getAbstractFileByPath(filePath);
			if (node instanceof TFile) {
				this.currentFile = node;
				this.currentFolder = null;
				await this.loadFile(node, { unitIndex: savedUnitIndex, spread: savedSpread });
			} else if (node instanceof TFolder) {
				this.currentFolder = node;
				this.currentFile = null;
				await this.loadFolder(node, { unitIndex: savedUnitIndex, spread: savedSpread });
			}
		}
		await super.setState(state, result);
	}

	getState(): any {
		return {
			file: this.currentFile?.path ?? this.currentFolder?.path,
			unitIndex: this.currentUnitIndex,
			spread: this.currentSpread,
		};
	}

	// ─── REGION: Theme ───────────────────────────────────────────────────────
	applyThemeClasses(): void {
		const root = this.contentEl;
		if (!root.classList.contains("tmr-root")) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			root.addClass("tmr-3c-mode");
			root.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			root.removeClass("tmr-3c-mode");
			root.removeAttribute("data-tmr-theme");
		}
		if (this.tooltipEl) {
			if (tmrMode === "3c") {
				this.tooltipEl.addClass("tmr-3c-mode");
				this.tooltipEl.setAttribute("data-tmr-theme", tmrTheme);
			} else {
				this.tooltipEl.removeClass("tmr-3c-mode");
				this.tooltipEl.removeAttribute("data-tmr-theme");
			}
		}
		this.syncGlossBarTheme();
		this.syncGlossInputTheme();
		this.syncGlossTileTooltipTheme();
		this.syncAnnotationPreviewTheme();
		this.syncHighlightsPanelTheme();
		this.updateTocFooter();
		requestAnimationFrame(() => this.renderSavedHighlights());
	}

	private updateTocFooter(): void {
		const modeBtn = this.contentEl.querySelector(".tmr-toc-mode-btn") as HTMLElement | null;
		const themeBtn = this.contentEl.querySelector(".tmr-toc-theme-btn") as HTMLElement | null;
		if (!modeBtn || !themeBtn) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		modeBtn.toggleClass("tmr-toc-footer-btn-active", tmrMode === "3c");
		modeBtn.ariaLabel = tmrMode === "3c" ? "3C mode (on)" : "3C mode (off)";
		themeBtn.toggleClass("tmr-hidden", tmrMode !== "3c");
		themeBtn.empty();
		setIcon(themeBtn, tmrTheme === "dark" ? "sun" : "moon");
		themeBtn.ariaLabel = tmrTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
	}

	// ─── REGION: Shell & TOC ─────────────────────────────────────────────────
	private renderShell(): void {
		this.tocOpen = false;
		const root = this.contentEl;
		root.empty();
		root.addClass("tmr-root");
		root.createEl("div", { cls: "tmr-loading", text: "Opening…" });

		const tocToggle = root.createEl("button", { cls: "tmr-toc-toggle" });
		setIcon(tocToggle, "table-of-contents");
		tocToggle.ariaLabel = "Table of Contents";
		this.registerDomEvent(tocToggle, "click", () => this.toggleToc());

		const tocPanel = root.createEl("div", { cls: "tmr-toc" });
		const tocHeader = tocPanel.createEl("div", { cls: "tmr-toc-header" });
		this.tocTitleEl = tocHeader.createEl("span", { cls: "tmr-toc-title", text: "Contents" });
		const tocClose = tocHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-toc-close" });
		setIcon(tocClose, "x");
		this.registerDomEvent(tocClose, "click", () => this.toggleToc());
		this.tocListEl = tocPanel.createEl("div", { cls: "tmr-toc-list" });

		const tocFooter = tocPanel.createEl("div", { cls: "tmr-toc-footer" });
		const modeBtn = tocFooter.createEl("button", { cls: "tmr-toc-mode-btn" });
		modeBtn.innerHTML = LOGO_3C_SVG;
		this.registerDomEvent(modeBtn, "click", () => void this.toggleTmrMode());
		const themeBtn = tocFooter.createEl("button", { cls: "tmr-toc-theme-btn" });
		this.registerDomEvent(themeBtn, "click", async () => {
			this.plugin.settings.tmrTheme = this.plugin.settings.tmrTheme === "dark" ? "light" : "dark";
			await this.plugin.saveSettings();
		});

		const tocBackdrop = root.createEl("div", { cls: "tmr-toc-backdrop" });
		this.registerDomEvent(tocBackdrop, "click", () => this.toggleToc());

		// Highlights navigation panel — mirrors the TOC shell but slides in from
		// the right. Populated from `savedHighlights` on every open, grouped by
		// section. Click-to-jump mounts the hosting unit and scrolls the
		// paragraph into view.
		const hlToggle = root.createEl("button", { cls: "tmr-highlights-toggle" });
		setIcon(hlToggle, "pencil-line");
		hlToggle.ariaLabel = "Highlights";
		this.registerDomEvent(hlToggle, "click", () => this.toggleHighlightsPanel());

		const hlPanel = root.createEl("div", { cls: "tmr-highlights-panel" });
		const hlHeader = hlPanel.createEl("div", { cls: "tmr-highlights-header" });
		hlHeader.createEl("span", { cls: "tmr-highlights-title", text: "Highlights" });
		// Note button — opens the companion annotation doc. Lives in the header
		// (above the tab bar) so it's reachable from both tabs, and so readers
		// who only Emphasise (no conversations) can still get to their notes.
		const hlNote = hlHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-highlights-note" });
		setIcon(hlNote, "file-pen");
		setTooltip(hlNote, "Open annotation notes");
		this.registerDomEvent(hlNote, "click", () => this.openCompanionDoc());
		this.hlNoteBtnEl = hlNote;
		this.updateCompanionDocButton();
		const hlClose = hlHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-highlights-close" });
		setIcon(hlClose, "x");
		this.registerDomEvent(hlClose, "click", () => this.toggleHighlightsPanel());

		// Tab bar (Annotations / Conversations) lives between the header and
		// the content. Two segmented buttons; click swaps which list is
		// visible. Active tab persists per-book via savePosition().
		const tabsWrap = hlPanel.createEl("div", { cls: "tmr-pane-tabs-wrap" });
		const tabs = tabsWrap.createEl("div", { cls: "tmr-pane-tabs" });
		tabs.dataset.active = "annotations";
		const annTab = tabs.createEl("button", {
			cls: "tmr-pane-tab",
			text: "Annotations",
		});
		annTab.dataset.paneTab = "annotations";
		const convTab = tabs.createEl("button", {
			cls: "tmr-pane-tab",
			text: "Conversations",
		});
		convTab.dataset.paneTab = "conversations";
		this.registerDomEvent(annTab, "click", () => this.setPaneTab("annotations"));
		this.registerDomEvent(convTab, "click", () => this.setPaneTab("conversations"));
		this.paneTabsEl = tabs;

		this.highlightsListEl = hlPanel.createEl("div", { cls: "tmr-highlights-list" });
		const convListEl = hlPanel.createEl("div", { cls: "tmr-conversations-list tmr-hidden" });
		this.conversationsListEl = convListEl;
		this.convCardsEl = convListEl.createEl("div", { cls: "tmr-conv-cards" });
		const filterRow = convListEl.createEl("div", { cls: "tmr-conv-filter-row" });
		this.buildConvFilterRow(filterRow);
		this.highlightsPanelEl = hlPanel;
		this.applyAiFeaturesState();

		const hlBackdrop = root.createEl("div", { cls: "tmr-highlights-backdrop" });
		this.registerDomEvent(hlBackdrop, "click", () => this.toggleHighlightsPanel());

		this.spreadEl = root.createEl("div", { cls: "tmr-spread tmr-hidden" });
		this.contentNode = this.spreadEl.createEl("div", { cls: "tmr-content" });
		this.syncSpreadLayoutMode(this.spreadEl);

		this.cacheHost = root.createEl("div", { cls: "tmr-hidden" });
		this.prevHost = this.cacheHost.createEl("div");
		this.nextHost = this.cacheHost.createEl("div");

		this.resizeObserver?.disconnect();
		if (this.spreadEl) this.resizeObserver?.observe(this.spreadEl);

		this.registerDomEvent(this.spreadEl, "mouseover", (e: MouseEvent) => {
			const target = e.target as Element;
			const cite = target.closest(".tmr-citation") as HTMLElement | null;
			const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
			const ridEl = target.closest("[data-rid]") as HTMLElement | null;

			if (cite) {
				const text = cite.dataset.citeText;
				if (text) this.renderTooltip(this.buildInlineTextPreview(text), e);
			} else if (anchor) {
				this.handleLinkHover(anchor, e);
			} else if (ridEl) {
				const targetEl = this.findTarget(ridEl.dataset.rid!);
				if (targetEl) this.showTooltip(targetEl, e);
			}
		});

		this.registerDomEvent(this.spreadEl, "mouseout", (e: MouseEvent) => {
			const to = e.relatedTarget as Element | null;
			const leavingLink = (e.target as Element | null)?.closest("a[href]") as HTMLAnchorElement | null;
			if (leavingLink && to?.closest("a[href]") === leavingLink) return;
			const leavingCite = (e.target as Element | null)?.closest(".tmr-citation");
			if (leavingCite && to?.closest(".tmr-citation") === leavingCite) return;
			this.hoveredLinkPreviewKey = null;
			if (!to?.closest(".tmr-tooltip")) this.hideTooltip();
		});

		// Annotation preview on hover. Rects are pointer-events: none so text
		// under a highlight stays selectable, so we hit-test ourselves against
		// their bounding boxes on every mousemove. Cost is a few dozen rect
		// compares per frame — negligible versus the cost of losing selection.
		this.registerDomEvent(this.spreadEl, "mousemove", (e: MouseEvent) => {
			this.handleAnnotationHover(e);
		});
		this.registerDomEvent(this.spreadEl, "mouseleave", () => {
			this.hideAnnotationPreview();
		});

		this.registerDomEvent(this.spreadEl, "click", (e: MouseEvent) => {
			// Saved-highlight rects sit at z-index: 0 with pointer-events: none,
			// so the click target is the underlying paragraph. Hit-test the
			// pointer against the rendered rects: if it lands on an AI-bearing
			// highlight, open the Conversations tab and expand its card.
			if (this.handleHighlightClick(e)) {
				e.preventDefault();
				return;
			}
			const anchor = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
			if (!anchor) return;
			const href = anchor.getAttribute("href") ?? "";
			if (href.startsWith("#")) {
				e.preventDefault();
				const t = this.findTarget(href.slice(1));
				if (t) {
					this.savePosition();
					this.scrollToTarget(t);
				}
			} else if (href.startsWith("http")) {
				e.preventDefault();
				window.open(href, "_blank");
			} else if (this.book) {
				e.preventDefault();
				void this.navigateToHref(href);
			}
		});
		this.registerDomEvent(this.spreadEl, "wheel", (e: WheelEvent) => {
			// Keep navigation transform-driven; native wheel scrolling causes horizontal drift.
			e.preventDefault();
		});
		this.registerDomEvent(this.spreadEl, "mouseup", () => this.onSelectionMouseUp());

		const footer = root.createEl("div", { cls: "tmr-footer" });
		this.localPageEl = footer.createEl("span", { cls: "tmr-page-info" });
		this.progressBarEl = footer.createEl("div", { cls: "tmr-progress-bar" });
		const backMarker = this.progressBarEl.createEl("div", { cls: "tmr-progress-back-marker tmr-hidden" });
		// The dot is the persistent re-entry point once the pill has decayed:
		// hovering it re-summons the pill, clicking it returns directly.
		this.registerDomEvent(backMarker, "mouseenter", () => {
			if (!this.backPillDismissed) return;
			this.backPillHovering = true;
			this.updateBackMarker();
		});
		this.registerDomEvent(backMarker, "mouseleave", () => {
			if (!this.backPillHovering) return;
			this.backPillHovering = false;
			this.updateBackMarker();
		});
		this.registerDomEvent(backMarker, "click", (e) => {
			e.stopPropagation();
			void this.goBack();
		});
		const backBtn = this.progressBarEl.createEl("button", { cls: "tmr-progress-back tmr-hidden" });
		const backIcon = backBtn.createEl("span", { cls: "tmr-progress-back-icon" });
		setIcon(backIcon, "redo-2");
		backBtn.createEl("span", { cls: "tmr-progress-back-label", text: "Back" });
		this.registerDomEvent(backBtn, "click", (e) => {
			e.stopPropagation();
			void this.goBack();
		});
		this.progressTipEl = this.progressBarEl.createEl("div", { cls: "tmr-progress-tooltip tmr-hidden" });
		this.registerDomEvent(this.progressBarEl, "mousedown", (e) => this.onProgressMouseDown(e));
		this.registerDomEvent(this.progressBarEl, "mousemove", (e) => this.onProgressMouseMove(e));
		this.registerDomEvent(this.progressBarEl, "mouseleave", () => {
			this.progressTipEl?.addClass("tmr-hidden");
		});
		this.globalPageEl = footer.createEl("span", { cls: "tmr-global-page" });

		this.applyThemeClasses();
	}

	toggleToc(): void {
		this.tocOpen = !this.tocOpen;
		const toc = this.contentEl.querySelector(".tmr-toc");
		const backdrop = this.contentEl.querySelector(".tmr-toc-backdrop");
		const toggle = this.contentEl.querySelector(".tmr-toc-toggle");
		if (this.tocOpen) {
			toc?.addClass("tmr-toc-open");
			backdrop?.addClass("tmr-toc-backdrop-visible");
			toggle?.addClass("tmr-toc-toggle-hidden");
			requestAnimationFrame(() => {
				const active = this.contentEl.querySelector(".tmr-toc-item.tmr-toc-active");
				active?.scrollIntoView({ block: "center", behavior: "smooth" });
			});
		} else {
			toc?.removeClass("tmr-toc-open");
			backdrop?.removeClass("tmr-toc-backdrop-visible");
			toggle?.removeClass("tmr-toc-toggle-hidden");
		}
	}

	private renderToc(): void {
		if (!this.book || !this.tocListEl) return;
		this.tocListEl.empty();
		if (this.tocTitleEl) this.tocTitleEl.setText(this.book.title);
		this.renderTocItems(this.book.toc, this.tocListEl, 0);
		this.updateTocActive();
	}

	private renderTocItems(items: EpubTocItem[], container: HTMLElement, level: number): void {
		for (const item of items) {
			const el = container.createEl("div", { cls: "tmr-toc-item", text: item.label });
			el.dataset.href = item.href;
			el.dataset.level = String(level);
			el.style.paddingLeft = `${1 + level * 1.25}rem`;
			this.registerDomEvent(el, "click", () => {
				void this.navigateToTocHref(item.href);
				this.toggleToc();
			});
			if (item.children.length > 0) this.renderTocItems(item.children, container, level + 1);
		}
	}

	toggleHighlightsPanel(): void {
		this.highlightsOpen = !this.highlightsOpen;
		const panel = this.highlightsPanelEl;
		const backdrop = this.contentEl.querySelector(".tmr-highlights-backdrop");
		const toggle = this.contentEl.querySelector(".tmr-highlights-toggle");
		if (this.highlightsOpen) {
			this.applyPaneTabUI();
			this.renderActivePane();
			this.updateCompanionDocButton();
			panel?.addClass("tmr-highlights-open");
			backdrop?.addClass("tmr-highlights-backdrop-visible");
			toggle?.addClass("tmr-highlights-toggle-hidden");
		} else {
			panel?.removeClass("tmr-highlights-open");
			backdrop?.removeClass("tmr-highlights-backdrop-visible");
			toggle?.removeClass("tmr-highlights-toggle-hidden");
			// Clear active-highlight styling when the panel is dismissed.
			if (this.activeConversationIdx !== -1) {
				this.activeConversationIdx = -1;
				this.renderSavedHighlights();
			}
		}
	}

	/** Switch the active right-rail tab. Persists to settings so re-opening
	 *  the book restores the same tab. Re-renders the now-visible list. */
	private setPaneTab(tab: "annotations" | "conversations"): void {
		if (this.paneTab === tab) return;
		this.paneTab = tab;
		this.applyPaneTabUI();
		this.renderActivePane();
		this.persistPaneTab();
	}

	/** Sync the tab-bar active state and list visibility with `paneTab`.
	 *  Called from `toggleHighlightsPanel` (when the panel opens) and
	 *  `setPaneTab` (on tab click). Pure DOM swap; no data work. */
	private applyPaneTabUI(): void {
		const tabs = this.paneTabsEl;
		if (tabs) {
			tabs.dataset.active = this.paneTab;
			tabs.querySelectorAll<HTMLElement>(".tmr-pane-tab").forEach((el) => {
				el.toggleClass("tmr-pane-tab-active", el.dataset.paneTab === this.paneTab);
			});
		}
		const ann = this.highlightsListEl;
		const conv = this.conversationsListEl;
		if (ann) ann.toggleClass("tmr-hidden", this.paneTab !== "annotations");
		if (conv) conv.toggleClass("tmr-hidden", this.paneTab !== "conversations");
	}

	/** Reflect the AI-features master switch across this view: the GlossBar
	 *  collapses to the lone Emphasise tile (Lite) and the Highlights pane hides
	 *  its Annotations/Conversations tab bar, showing only the Annotations list.
	 *  Public so `saveSettings` can fan it out to open views on a toggle. */
	applyAiFeaturesState(): void {
		const lite = !this.plugin.settings.aiFeaturesEnabled;
		this.highlightsPanelEl?.toggleClass("tmr-pane-lite", lite);
		this.glossBarEl?.toggleClass("tmr-gloss-lite", lite);
		if (lite && this.paneTab !== "annotations") this.paneTab = "annotations";
		this.applyPaneTabUI();
	}

	/** Open (or focus) the book's companion annotation doc in a markdown tab.
	 *  No-op when the doc doesn't exist yet (no annotations made). Bound to the
	 *  Highlights-pane header button so it's reachable from either tab. */
	async openCompanionDoc(): Promise<void> {
		const path = this.getCompanionDocPath();
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const existing = this.app.workspace.getLeavesOfType("markdown").find(
			(l) => (l.view as { file?: TFile }).file?.path === path,
		);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
		} else {
			await this.app.workspace.getLeaf("tab").openFile(file);
		}
	}

	/** Show the Highlights-pane note button only once a companion doc exists on
	 *  disk — there's nothing to open before the reader's first annotation. */
	private updateCompanionDocButton(): void {
		if (!this.hlNoteBtnEl) return;
		const path = this.getCompanionDocPath();
		const exists = !!path && this.app.vault.getAbstractFileByPath(path) instanceof TFile;
		this.hlNoteBtnEl.toggleClass("tmr-hidden", !exists);
	}

	/** Build the filter row that lives at the bottom of the conversations list.
	 *  A `list-filter` icon button sits pinned to the right; clicking it reveals
	 *  the three sort pills that slide in from the right. The button turns teal
	 *  while the filter is open. */
	private buildConvFilterRow(row: HTMLElement): void {
		this.convFilterRowEl = row;

		// Middle: sort pills — hidden until filter is open.
		const optionsEl = row.createEl("div", { cls: "tmr-conv-filter-options" });
		const opts: Array<{ key: "priority" | "recent" | "chapter"; label: string }> = [
			{ key: "priority", label: "Priority" },
			{ key: "recent",   label: "Recent"   },
			{ key: "chapter",  label: "Chapter"  },
		];
		for (const { key, label } of opts) {
			const btn = optionsEl.createEl("button", { cls: "tmr-conv-sort-btn", text: label });
			btn.dataset.sortKey = key;
			btn.toggleClass("tmr-conv-sort-btn-active", this.convSort === key);
			this.registerDomEvent(btn, "click", () => {
				if (this.convSort === key) return;
				this.convSort = key;
				optionsEl.querySelectorAll<HTMLElement>(".tmr-conv-sort-btn").forEach((b) => {
					b.toggleClass("tmr-conv-sort-btn-active", b.dataset.sortKey === key);
				});
				this.renderConversationsList();
			});
		}

		// Right: filter toggle button — always visible when row is visible.
		const filterBtn = row.createEl("button", { cls: "tmr-conv-filter-btn" });
		setIcon(filterBtn, "list-filter");
		setTooltip(filterBtn, "Sort conversations");
		this.registerDomEvent(filterBtn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.convFilterOpen = !this.convFilterOpen;
			filterBtn.toggleClass("tmr-conv-filter-btn-active", this.convFilterOpen);
			optionsEl.toggleClass("tmr-conv-filter-options-open", this.convFilterOpen);
		});
	}

	/** Dispatch render to whichever list is currently active. Re-running
	 *  the inactive list would be wasted DOM work. */
	private renderActivePane(): void {
		if (this.paneTab === "annotations") this.renderHighlightsList();
		else this.renderConversationsList();
	}

	/** Persist the active pane tab into the per-book position record so
	 *  re-opening the book lands on the same tab. Mirrors
	 *  `schedulePositionSave`'s write but is fire-and-forget (debounce-less)
	 *  because tab toggles are user-paced, not stream-of-events. */
	private persistPaneTab(): void {
		const path = this.currentFile?.path ?? this.currentFolder?.path;
		if (!path) return;
		const existing = this.plugin.settings.bookPositions[path] ?? {
			unitIndex: this.currentUnitIndex,
			spread: this.currentSpread,
		};
		this.plugin.settings.bookPositions[path] = { ...existing, pane: this.paneTab };
		void this.plugin.persistSettings();
	}

	/** Restore `paneTab` from the saved per-book position. Called after
	 *  `loadEpub` has populated `currentFile`. Defaults to "annotations"
	 *  when no record exists. */
	private restorePaneTab(): void {
		const path = this.currentFile?.path ?? this.currentFolder?.path;
		const stored = path ? this.plugin.settings.bookPositions[path]?.pane : undefined;
		// Lite mode has no Conversations tab — always land on Annotations.
		this.paneTab = this.plugin.settings.aiFeaturesEnabled ? (stored ?? "annotations") : "annotations";
	}

	private syncHighlightsPanelTheme(): void {
		const el = this.highlightsPanelEl;
		if (!el) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			el.addClass("tmr-3c-mode");
			el.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			el.removeClass("tmr-3c-mode");
			el.removeAttribute("data-tmr-theme");
		}
	}

	/** Build the grouped list of saved highlights for the sidebar. Groups by
	 *  the host section's label (derived from paraId → spineIdx → sectionIdx).
	 *  Renders in document order so the sidebar reflects reading order. */
	private renderHighlightsList(): void {
		const list = this.highlightsListEl;
		if (!list) return;
		list.empty();

		if (this.savedHighlights.length === 0) {
			list.createEl("div", {
				cls: "tmr-highlights-empty",
				text: "No highlights yet — select any text to begin annotating.",
			});
			return;
		}

		// Stable doc-order sort: by spine index, then by start-char within the paragraph.
		const ordered = this.savedHighlights.map((saved, idx) => {
			const match = /^s(\d+)-p(\d+)$/.exec(saved.paraIdHint);
			const spineIdx = match ? parseInt(match[1], 10) : 0;
			const paraIdx = match ? parseInt(match[2], 10) : 0;
			const section = this.sections[this.sectionIndexBySpine[spineIdx] ?? 0];
			return { saved, idx, paraIdx, spineIdx, sectionId: section?.id ?? "", sectionLabel: section?.label ?? "—" };
		}).sort((a, b) =>
			(a.spineIdx - b.spineIdx) ||
			(a.paraIdx - b.paraIdx) ||
			(a.saved.startChar - b.saved.startChar)
		);

		// Per-chapter annotation counts, for the collapsed-header badge.
		const sectionCounts = new Map<string, number>();
		for (const o of ordered) sectionCounts.set(o.sectionId, (sectionCounts.get(o.sectionId) ?? 0) + 1);

		// Once the whole list is long (>10 marks), every chapter becomes
		// collapsible so even sparse ones can be folded away to navigate.
		const manyTotal = ordered.length > 10;

		let lastSectionId = "";
		let itemsParent: HTMLElement | null = null;
		for (const { saved, idx, sectionId, sectionLabel } of ordered) {
			if (sectionId !== lastSectionId) {
				lastSectionId = sectionId;
				const count = sectionCounts.get(sectionId) ?? 0;
				// Collapse earns its UI past a few annotations per chapter, or
				// once the book as a whole is heavily annotated. Sparse chapters
				// in a short list stay as plain, always-open headers.
				const collapsible = count > 3 || manyTotal;
				itemsParent = this.renderSection(
					list, sectionId, sectionLabel, count, collapsible,
					collapsible && this.collapsedSections.has(sectionId),
				);
			}
			if (itemsParent) this.renderHighlightItem(itemsParent, saved, idx);
		}
	}

	/** Render a chapter section (header + items container) into the Annotations
	 *  list and return the element new item rows should be appended to.
	 *
	 *  Collapse is animated, so the toggle flips a single `tmr-section-collapsed`
	 *  class on the wrapper *in place* (no re-render) and CSS drives all three
	 *  motions off it: chevron rotation, count fade-in, and the rows' grid-row
	 *  height collapse. Non-collapsible chapters (≤3 annotations) get a plain,
	 *  static header with no chevron, count, or click handler. */
	private renderSection(
		list: HTMLElement,
		sectionId: string,
		label: string,
		count: number,
		collapsible: boolean,
		collapsed: boolean,
	): HTMLElement {
		const section = list.createEl("div", { cls: "tmr-section" });
		section.toggleClass("tmr-section-collapsed", collapsed);

		const header = section.createEl("div", { cls: "tmr-highlights-section-header" });
		const left = header.createEl("div", { cls: "tmr-section-header-left" });
		left.createEl("span", { cls: "tmr-section-header-label", text: label });

		if (collapsible) {
			header.addClass("tmr-section-header-collapsible");
			setIcon(left.createEl("span", { cls: "tmr-section-chevron" }), "chevron-down");
			const countEl = header.createEl("div", { cls: "tmr-section-count" });
			setIcon(countEl.createEl("span", { cls: "tmr-section-count-icon" }), "bookmark");
			countEl.createEl("span", { cls: "tmr-section-count-num", text: String(count) });
			this.registerDomEvent(header, "click", () => {
				const nowCollapsed = !this.collapsedSections.has(sectionId);
				if (nowCollapsed) this.collapsedSections.add(sectionId);
				else this.collapsedSections.delete(sectionId);
				section.toggleClass("tmr-section-collapsed", nowCollapsed);
			});
		}

		const itemsOuter = section.createEl("div", { cls: "tmr-section-items" });
		return itemsOuter.createEl("div", { cls: "tmr-section-items-inner" });
	}

	/** Render one saved-highlight row into `parent`. */
	private renderHighlightItem(parent: HTMLElement, saved: SavedHighlight, idx: number): void {
		const item = parent.createEl("div", { cls: "tmr-highlights-item" });
		item.dataset.glossMode = saved.mode;
		item.dataset.highlightIdx = String(idx);

		const iconEl = item.createEl("span", { cls: "tmr-highlights-item-icon" });
		const modeMeta = GLOSS_MODES.find((m) => m.id === saved.mode);
		if (modeMeta) setIcon(iconEl, modeMeta.icon);

		const body = item.createEl("div", { cls: "tmr-highlights-item-body" });
		const quote = saved.quote.replace(/\s+/g, " ").trim();
		body.createEl("div", {
			cls: "tmr-highlights-item-quote",
			text: quote.length > 0 ? quote : "(no quote)",
		});
		// Note slot. Emphasise notes are free text the reader owns, so they
		// are click-to-edit and empty ones offer a "+ Add a note" prompt.
		// Other modes' "note" is the AI query — shown, but not editable here
		// (that belongs to the Conversations chat surface).
		const note = saved.userText.trim();
		const isEmphasise = saved.mode === "emphasise";
		if (this.editingNoteIdx === idx && isEmphasise) {
			this.renderNoteEditor(body, idx, saved.userText);
		} else if (note.length > 0) {
			const noteEl = body.createEl("div", { cls: "tmr-highlights-item-note", text: note });
			if (isEmphasise) {
				noteEl.addClass("tmr-highlights-item-note-editable");
				noteEl.setAttr("title", "Click to edit");
				this.registerDomEvent(noteEl, "click", (e) => {
					e.stopPropagation();
					this.editingNoteIdx = idx;
					this.renderHighlightsList();
				});
			}
		} else if (isEmphasise) {
			const addEl = body.createEl("div", {
				cls: "tmr-highlights-item-add-note",
				text: "+ Add a note",
			});
			this.registerDomEvent(addEl, "click", (e) => {
				e.stopPropagation();
				this.editingNoteIdx = idx;
				this.renderHighlightsList();
			});
		}

		// No delete affordance while this row's note editor is open — it
		// would overlap the full-width input.
		if (this.editingNoteIdx !== idx) {
			const delBtn = item.createEl("button", {
				cls: "tmr-highlights-item-delete",
				attr: { "aria-label": "Delete annotation" },
			});
			setIcon(delBtn, "trash-2");
			this.registerDomEvent(delBtn, "click", (e) => {
				e.stopPropagation();
				void this.deleteHighlightAt(idx);
			});
		}

		this.registerDomEvent(item, "click", () => {
			void this.jumpToHighlight(idx);
		});
	}

	/** Render the inline note editor into an Annotations-pane row. Commits on
	 *  Enter or blur, cancels on Escape. The blur commit is deferred so an
	 *  Enter/Escape keystroke or a click on another control wins the race before
	 *  the list re-renders the input away. */
	private renderNoteEditor(container: HTMLElement, idx: number, initial: string): void {
		const input = container.createEl("input", { cls: "tmr-highlights-note-input", type: "text" });
		input.value = initial;
		input.placeholder = GLOSS_PLACEHOLDERS["emphasise"] ?? "your thought…";
		// Keep pointer/keyboard activity inside the editor from bubbling to the
		// row's jump-to-highlight handler.
		this.registerDomEvent(input, "click", (e) => e.stopPropagation());
		this.registerDomEvent(input, "mousedown", (e) => e.stopPropagation());

		let settled = false;
		const commit = () => {
			if (settled) return;
			settled = true;
			void this.commitNoteEdit(idx, input.value);
		};
		this.registerDomEvent(input, "keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				settled = true;
				this.cancelNoteEdit();
			}
		});
		this.registerDomEvent(input, "blur", () => window.setTimeout(commit, 120));
		requestAnimationFrame(() => { input.focus(); input.select(); });
	}

	private cancelNoteEdit(): void {
		this.editingNoteIdx = null;
		this.renderHighlightsList();
	}

	/** Persist an edited Emphasise note. An empty value clears the note back to
	 *  a bare callout. No-op write when the text is unchanged. */
	private async commitNoteEdit(idx: number, value: string): Promise<void> {
		const saved = this.savedHighlights[idx];
		this.editingNoteIdx = null;
		if (!saved) { this.renderHighlightsList(); return; }
		const next = value.trim();
		if (next === saved.userText.trim()) { this.renderHighlightsList(); return; }
		saved.userText = next;
		try {
			await this.patchCalloutInDoc(saved);
		} catch (err) {
			console.error("[ThirdMindReader] commitNoteEdit failed", err);
			new Notice("Third Mind Reader: failed to save note");
		}
		this.renderSavedHighlights();
		this.renderHighlightsList();
	}

	/** Delete an annotation: excise its callout from the companion doc, drop it
	 *  from the in-memory list, and repaint overlays + pane. Confirmation-gated
	 *  because the callout (and any AI conversation it holds) is removed. */
	private async deleteHighlightAt(idx: number): Promise<void> {
		const saved = this.savedHighlights[idx];
		if (!saved) return;
		const ok = window.confirm(
			"Delete this annotation? It will be removed from the companion doc. This cannot be undone (the doc remains in vault history).",
		);
		if (!ok) return;

		const path = this.getCompanionDocPath();
		if (path) {
			try {
				const doc = await this.app.vault.adapter.read(path);
				const updated = this.removeCalloutFromDoc(doc, saved);
				if (updated !== doc) await this.app.vault.adapter.write(path, updated);
			} catch (err) {
				console.error("[ThirdMindReader] deleteHighlightAt failed", err);
				new Notice("Third Mind Reader: failed to delete annotation");
				return;
			}
		}

		this.savedHighlights.splice(idx, 1);
		this.editingNoteIdx = null;
		this.renderSavedHighlights();
		this.renderHighlightsList();
		if (this.paneTab === "conversations") this.renderConversationsList();
		new Notice("Annotation deleted");
	}

	/** Build the Conversations tab list. Filters `savedHighlights` to
	 *  AI-bearing modes (Exclaim/Explain/Examine/Enquiry — Emphasise is
	 *  permanently excluded), sorts by mode priority then doc order, and
	 *  renders one card per entry.
	 *
	 *  Phase B: click-to-expand is a stub that toggles the chevron rotation
	 *  and an `tmr-conv-card-expanded` class. The actual chat surface
	 *  (pinned header + bubbles + chat box) lands in Phase C. */
	private renderConversationsList(): void {
		const list = this.convCardsEl;
		if (!list) return;

		// Preserve which conversation was open so tab-switch and data-refresh
		// don't collapse it. `list.empty()` only removes children; the
		// `tmr-conv-list-focused` class stays on `list` unless we remove it.
		const expandedEl = list.querySelector<HTMLElement>(".tmr-conv-card-expanded");
		const expandedIdx = expandedEl
			? parseInt(expandedEl.dataset.conversationIdx ?? "-1", 10)
			: -1;
		list.removeClass("tmr-conv-list-focused");
		list.empty();

		const showBare = this.plugin.settings.showBareFlaggedConversations;
		const conversations = this.savedHighlights
			.map((saved, idx) => ({ saved, idx }))
			.filter(({ saved }) => GLOSS_AI_MODES_ALL.has(saved.mode))
			.filter(({ saved }) => showBare || !this.isBareFlaggedConversation(saved));

		const hasConversations = conversations.length > 0;
		if (this.convFilterRowEl) this.convFilterRowEl.toggleClass("tmr-hidden", !hasConversations);

		if (!hasConversations) {
			list.createEl("div", {
				cls: "tmr-highlights-empty",
				text: "No conversations yet — use Explain, Examine, Exclaim or Enquiry on a selection to start one.",
			});
			return;
		}

		const enriched = conversations.map((entry) => {
			const match = /^s(\d+)-p(\d+)$/.exec(entry.saved.paraIdHint);
			const spineIdx = match ? parseInt(match[1], 10) : 0;
			const paraIdx  = match ? parseInt(match[2], 10) : 0;
			const priority = CONV_MODE_PRIORITY[entry.saved.mode] ?? 99;
			return { ...entry, spineIdx, paraIdx, priority };
		});

		let ordered: typeof enriched;
		if (this.convSort === "recent") {
			// Reverse insertion order — later entries in savedHighlights were appended last.
			ordered = enriched.slice().sort((a, b) => b.idx - a.idx);
		} else if (this.convSort === "chapter") {
			// Doc order (spine → para → startChar), same as Annotations tab.
			ordered = enriched.slice().sort((a, b) =>
				(a.spineIdx - b.spineIdx) ||
				(a.paraIdx  - b.paraIdx)  ||
				(a.saved.startChar - b.saved.startChar)
			);
		} else {
			// Priority (default): mode order → doc order.
			ordered = enriched.slice().sort((a, b) =>
				(a.priority - b.priority) ||
				(a.spineIdx - b.spineIdx) ||
				(a.paraIdx  - b.paraIdx)  ||
				(a.saved.startChar - b.saved.startChar)
			);
		}

		let lastSectionId = "";
		for (const { saved, idx, spineIdx } of ordered) {
			// Chapter headers when sorting by chapter — mirrors Annotations tab grouping.
			if (this.convSort === "chapter") {
				const sectionIdx = this.sectionIndexBySpine[spineIdx] ?? 0;
				const section    = this.sections[sectionIdx];
				const sectionId  = section?.id ?? "";
				if (sectionId !== lastSectionId) {
					lastSectionId = sectionId;
					list.createEl("div", {
						cls: "tmr-highlights-section-header",
						text: section?.label ?? "—",
					});
				}
			}

			const card = list.createEl("div", { cls: "tmr-conv-card" });
			card.dataset.glossMode = saved.mode;
			card.dataset.conversationIdx = String(idx);

			// Header row — body + chevron sit here so the card can flex-column
			// when the conversation surface is appended below.
			const row = card.createEl("div", { cls: "tmr-conv-card-row" });
			const body = row.createEl("div", { cls: "tmr-conv-card-body" });

			// Title = user's first turn (or `userText` for legacy callouts).
			// Falls through to "(no prompt)" for bare-flagged entries.
			const title = saved.userText.trim();
			body.createEl("div", {
				cls: "tmr-conv-card-title",
				text: title.length > 0 ? title : "(no prompt)",
			});

			// Preview = first assistant turn, or a status placeholder.
			const firstAssistant = saved.turns.find((t) => t.role === "assistant");
			const previewText = this.conversationPreviewText(saved, firstAssistant);
			if (previewText) {
				const preview = body.createEl("div", { cls: "tmr-conv-card-preview" });
				preview.toggleClass("tmr-conv-card-preview-pending", saved.aiState === "pending");
				preview.toggleClass("tmr-conv-card-preview-error",   saved.aiState === "error");
				preview.setText(this.stripInlineMarkdown(previewText));
			}

			const chevron = row.createEl("span", { cls: "tmr-conv-card-chevron" });
			setIcon(chevron, "chevron-right");

			this.registerDomEvent(row, "click", () => {
				this.toggleConversationCard(card);
			});
		}

		// Restore any conversation that was open before the list was cleared
		// (tab switch, data refresh, pane reopen). Restore without navigating —
		// a persisted open card must not yank the reader back to its source.
		if (expandedIdx >= 0) {
			const cardToRestore = list.querySelector<HTMLElement>(
				`[data-conversation-idx="${expandedIdx}"]`,
			);
			if (cardToRestore) this.toggleConversationCard(cardToRestore, false);
		}
	}

	/** Resolve the muted-italic preview line for a conversation card based on
	 *  `aiState` and the first assistant turn (if any). Returns "" when the
	 *  card should render title-only (bare Phase 2 reactions with no AI). */
	private conversationPreviewText(saved: SavedHighlight, firstAssistant?: ConversationTurn): string {
		if (saved.aiState === "pending") return "Awaiting response…";
		if (saved.aiState === "error")   return `Failed: ${saved.aiError ?? "model unreachable"}`;
		return firstAssistant?.content.trim() ?? "";
	}

	private stripInlineMarkdown(text: string): string {
		return text
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\*([^*\n]+)\*/g, "$1")
			.replace(/_([^_\n]+)_/g, "$1")
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/#{1,6}\s+/gm, "")
			.replace(/\n+/g, " ")
			.trim();
	}

	/** Expand or collapse a conversation card. `jumpToSource` navigates the
	 *  reader to the source paragraph on expand — true for explicit user opens,
	 *  false when *restoring* a persisted open card (pane reopen / re-render), so
	 *  a remembered conversation never yanks the reader away from where it is. */
	private toggleConversationCard(card: HTMLElement, jumpToSource = true): void {
		const list = this.convCardsEl;
		const wasExpanded = card.hasClass("tmr-conv-card-expanded");

		// Collapse any currently open card.
		list?.querySelectorAll<HTMLElement>(".tmr-conv-card-expanded").forEach((c) => {
			c.removeClass("tmr-conv-card-expanded");
			c.querySelector(".tmr-conv-surface")?.remove();
		});
		list?.removeClass("tmr-conv-list-focused");

		if (wasExpanded) {
			// Closing — cancel any in-flight stream, drop active highlight
			// styling, and we're done.
			this.activeStreamAbort?.abort();
			this.activeConversationIdx = -1;
			this.activeConvLog = null;
			this.renderSavedHighlights();
			return;
		}

		card.addClass("tmr-conv-card-expanded");
		list?.addClass("tmr-conv-list-focused");
		const idxStr = card.dataset.conversationIdx;
		if (idxStr === undefined) return;
		const idx = parseInt(idxStr, 10);
		const saved = this.savedHighlights[idx];
		if (!saved) return;
		this.renderConversationSurface(card, saved);
		// Pin the highlight in active styling for the duration of the open
		// conversation. On an explicit open, also jump the reader to the source
		// paragraph; on a restore, repaint styling without navigating so the
		// reader keeps its current position.
		this.activeConversationIdx = idx;
		if (jumpToSource) {
			void this.jumpToHighlight(idx, false);
		} else {
			this.renderSavedHighlights();
		}
	}

	private renderConversationSurface(card: HTMLElement, saved: SavedHighlight): void {
		const surface = card.createEl("div", { cls: "tmr-conv-surface" });

		// Chat log — scrollable middle section. Quote is prepended inside so it scrolls away.
		const log = surface.createEl("div", { cls: "tmr-conv-log" });
		this.activeConvLog = log;
		void this.renderConversationLog(log, saved);

		// Chat box — fixed-height bottom section matching DLS "Chat box" component.
		const chatbox = surface.createEl("div", { cls: "tmr-conv-chatbox" });

		// Top: textarea + send button.
		const chatboxTop = chatbox.createEl("div", { cls: "tmr-conv-chatbox-top" });
		const textarea = chatboxTop.createEl("textarea", {
			cls: "tmr-conv-textarea",
			attr: { placeholder: "Say something…", rows: "1" },
		}) as HTMLTextAreaElement;
		const sendBtn = chatboxTop.createEl("button", { cls: "tmr-conv-send" });
		setIcon(sendBtn, "send-horizontal");
		(sendBtn as HTMLButtonElement).disabled = true;

		// Bottom: model picker + settings button.
		const chatboxBottom = chatbox.createEl("div", { cls: "tmr-conv-chatbox-bottom" });
		const provider = this.getActiveProvider(saved.mode as GlossModeId);
		const modelStr = provider?.defaultModel ?? "No model configured";
		const modelPicker = chatboxBottom.createEl("div", { cls: "tmr-conv-model-picker" });
		setIcon(modelPicker, "chevron-down");
		const modelLabel = modelPicker.createEl("span", { text: modelStr });
		// Clickable when a provider is resolved: opens the model browser for it
		// and updates this provider's default model. No-op when unconfigured.
		if (provider) {
			modelPicker.addClass("tmr-conv-model-picker-clickable");
			this.registerDomEvent(modelPicker, "click", (e: MouseEvent) => {
				e.stopPropagation();
				void pickModel(this.app, provider, async (model) => {
					provider.defaultModel = model;
					modelLabel.textContent = model;
					await this.plugin.saveSettings();
				});
			});
		}
		const settingsBtn = chatboxBottom.createEl("button", { cls: "tmr-conv-settings-btn" });
		setIcon(settingsBtn, "settings-2");
		this.registerDomEvent(settingsBtn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.openConvQuickSettings(settingsBtn, saved, log);
		});

		// Textarea auto-resize + send enable/disable.
		this.registerDomEvent(textarea, "input", () => {
			textarea.style.height = "auto";
			textarea.style.height = Math.min(textarea.scrollHeight, 80) + "px";
			(sendBtn as HTMLButtonElement).disabled = textarea.value.trim().length === 0;
		});
		// Prevent input clicks from bubbling to the card-row toggle.
		this.registerDomEvent(textarea, "click", (e: MouseEvent) => e.stopPropagation());
		this.registerDomEvent(sendBtn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			const text = textarea.value.trim();
			if (!text) return;
			textarea.value = "";
			textarea.style.height = "auto";
			(sendBtn as HTMLButtonElement).disabled = true;
			this.submitConversationMessage(card, saved, log, text);
		});
		this.registerDomEvent(chatbox, "click", (e: MouseEvent) => e.stopPropagation());
		this.registerDomEvent(textarea, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (!(sendBtn as HTMLButtonElement).disabled) sendBtn.click();
			}
		});

		log.scrollTop = log.scrollHeight;
	}

	/** Update the live pending indicator's label + phase class in place (no
	 *  re-render) as `livePhase` advances connecting → loading → thinking. Called
	 *  by the model-load probe and `onResponseStart`. No-op once streaming. */
	private updatePendingIndicator(log: HTMLElement, saved: SavedHighlight): void {
		const phase = saved.livePhase;
		if (phase !== "connecting" && phase !== "loading" && phase !== "thinking") return;
		const ind = log.querySelector<HTMLElement>(
			".tmr-conv-pending-wrap .tmr-conv-turn-ai-bubble");
		if (!ind) return;
		ind.removeClass("tmr-turn-connecting", "tmr-turn-loading", "tmr-turn-thinking");
		ind.addClass(`tmr-turn-${phase}`);
		const lbl = ind.querySelector(".tmr-thinking-label");
		if (lbl) lbl.textContent = pendingLabel(phase);
	}

	private async renderConversationLog(log: HTMLElement, saved: SavedHighlight): Promise<void> {
		const seq = ++this.convRenderSeq;
		this.convLogSeq.set(log, seq);
		log.empty();
		if (saved.quote.trim()) {
			log.createEl("div", { cls: "tmr-conv-quote", text: `"${saved.quote.trim()}"` });
		}
		for (const turn of saved.turns) {
			if (turn.role === "user") {
				const wrap = log.createEl("div", { cls: "tmr-conv-turn-user-wrap" });
				wrap.createEl("div", { cls: "tmr-conv-turn-user-bubble", text: turn.content });
			} else {
				const wrap = log.createEl("div", { cls: "tmr-conv-turn-ai-wrap" });
				const bubble = wrap.createEl("div", { cls: "tmr-conv-turn-ai-bubble" });
				await this.renderAssistantBubble(bubble, turn.content);
				// A newer render superseded us mid-await — stop before appending
				// into the tree it has since rebuilt.
				if (this.convLogSeq.get(log) !== seq) return;
			}
		}
		if (this.convLogSeq.get(log) !== seq) return;
		if (saved.aiState === "pending") {
			const phase = saved.livePhase ?? "thinking";
			if (phase === "streaming") {
				// Live token stream — plain text while arriving; renderAssistant-
				// Bubble re-renders it as formatted markdown once the turn lands.
				const wrap = log.createEl("div", { cls: "tmr-conv-turn-ai-wrap" });
				const bubble = wrap.createEl("div", { cls: "tmr-conv-turn-ai-bubble tmr-turn-streaming" });
				bubble.textContent = saved.streamingText ?? "";
			} else {
				// Animated indicator: "Connecting…" while probing the server,
				// "Loading model…" during a cold load, "Thinking…" once generating.
				const wrap = log.createEl("div", { cls: "tmr-conv-turn-ai-wrap tmr-conv-pending-wrap" });
				const ind = wrap.createEl("div", {
					cls: `tmr-conv-turn-ai-bubble tmr-turn-pending tmr-turn-${phase}`,
				});
				ind.createSpan({
					cls: "tmr-thinking-label",
					text: pendingLabel(phase),
				});
				const dots = ind.createSpan({ cls: "tmr-thinking-dots" });
				dots.createSpan({ cls: "tmr-dot" });
				dots.createSpan({ cls: "tmr-dot" });
				dots.createSpan({ cls: "tmr-dot" });
			}
		} else if (saved.aiState === "error") {
			const wrap = log.createEl("div", { cls: "tmr-conv-turn-ai-wrap" });
			wrap.createEl("div", {
				cls: "tmr-conv-turn-ai-bubble tmr-turn-error",
				text: saved.aiError ?? "Model unreachable — check plugin settings.",
			});
		}
	}

	/** Render an assistant turn into `bubble` with full markdown support.
	 *  `[N]` citation markers (Examine mode) are wired as hover-clickable pills
	 *  via a DOM walk after markdown rendering. */
	private async renderAssistantBubble(bubble: HTMLElement, content: string): Promise<void> {
		const { body, citations } = parseAssistantCitations(content);
		await MarkdownRenderer.render(this.app, body, bubble, "", this);
		if (citations.size > 0) this.wireCitationSpans(bubble, citations);
	}

	/** Post-process rendered markdown in `root`: find bare `[N]` text nodes
	 *  matching known citations and replace them with hover-clickable spans. */
	private wireCitationSpans(root: HTMLElement, citations: Map<number, AssistantCitation>): void {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const replacements: Array<{ node: Text; parts: Array<string | number> }> = [];
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const text = node.textContent ?? "";
			const re = /\[(\d+)\]/g;
			let m: RegExpExecArray | null;
			const parts: Array<string | number> = [];
			let pos = 0;
			let hasKnown = false;
			while ((m = re.exec(text)) !== null) {
				const num = parseInt(m[1], 10);
				if (!citations.has(num)) continue;
				if (m.index > pos) parts.push(text.slice(pos, m.index));
				parts.push(num);
				pos = m.index + m[0].length;
				hasKnown = true;
			}
			if (!hasKnown) continue;
			if (pos < text.length) parts.push(text.slice(pos));
			replacements.push({ node, parts });
		}
		for (const { node, parts } of replacements) {
			const frag = document.createDocumentFragment();
			for (const part of parts) {
				if (typeof part === "string") {
					frag.appendChild(document.createTextNode(part));
				} else {
					const cite = citations.get(part)!;
					const span = document.createElement("span");
					span.className = "tmr-citation";
					span.textContent = `[${part}]`;
					span.dataset.citationNum = String(part);
					this.registerDomEvent(span, "mouseenter", (e: MouseEvent) =>
						this.renderTooltip({ kind: "text", text: `${cite.title} — ${cite.url}` }, e));
					this.registerDomEvent(span, "mouseleave", () => this.hideTooltip());
					this.registerDomEvent(span, "click", (e: MouseEvent) => {
						e.stopPropagation(); e.preventDefault();
						window.open(cite.url, "_blank");
					});
					frag.appendChild(span);
				}
			}
			node.parentNode?.replaceChild(frag, node);
		}
	}

	private submitConversationMessage(
		_card: HTMLElement,
		saved: SavedHighlight,
		log: HTMLElement,
		text: string,
	): void {
		saved.turns.push({ role: "user", content: text });
		saved.aiState = "pending";
		void this.renderConversationLog(log, saved);
		log.scrollTop = log.scrollHeight;

		this.doAiExchange(saved, log).catch((err) =>
			console.error("[ThirdMindReader] submitConversationMessage AI call failed", err),
		);
	}

	/** Core AI exchange: sends turns to the provider, writes the assistant
	 *  turn (or error) back into `saved`, patches the companion doc, and
	 *  refreshes the conversations list.
	 *
	 *  When called from `persistGloss` (initial auto-fire), `saved.turns` is
	 *  empty and `log` is null — the first user turn is seeded from
	 *  `saved.userText` before the API call fires. When called from
	 *  `submitConversationMessage`, the user turn is already in `saved.turns`. */
	private async doAiExchange(
		saved: SavedHighlight,
		log: HTMLElement | null,
	): Promise<void> {
		// Seed the first user turn from legacy userText when this is the
		// initial auto-fire (turns array is empty at persistGloss time).
		if (saved.turns.length === 0) {
			saved.turns.push({ role: "user", content: saved.userText });
		}

		// Persist the pending state so the user turn is durable before the
		// network round-trip.
		await this.patchCalloutInDoc(saved);

		const provider = this.getActiveProvider(saved.mode as GlossModeId);
		if (!provider) {
			saved.aiState = "error";
			saved.aiError = "No AI provider configured — open plugin settings.";
			delete saved.livePhase; delete saved.streamingText;
			if (log) { await this.renderConversationLog(log, saved); log.scrollTop = log.scrollHeight; }
			await this.patchCalloutInDoc(saved);
			if (this.paneTab === "conversations") this.renderConversationsList();
			return;
		}
		const model = this.resolveModel(provider, saved.mode);
		if (!model) {
			saved.aiState = "error";
			saved.aiError = "No model configured for this provider.";
			delete saved.livePhase; delete saved.streamingText;
			if (log) { await this.renderConversationLog(log, saved); log.scrollTop = log.scrollHeight; }
			await this.patchCalloutInDoc(saved);
			if (this.paneTab === "conversations") this.renderConversationsList();
			return;
		}

		const messages: ChatMessage[] = saved.turns.map((t) => ({
			role: t.role,
			content: t.content,
		}));

		// Stream only on local openai-compatible servers (cloud kinds CORS-block
		// a browser fetch and fall back to buffered). A streamed run opens on
		// "Connecting…" while it probes the server, then "Loading model…" (cold
		// load) or "Thinking…" (warm), flipping to "Thinking…" once headers
		// arrive; buffered runs just show "Thinking…".
		const useStreaming =
			this.plugin.settings.streaming && provider.kind === "openai-compatible";
		saved.streamingText = "";
		saved.livePhase = useStreaming ? "connecting" : "thinking";
		if (log) { await this.renderConversationLog(log, saved); log.scrollTop = log.scrollHeight; }

		// Active probe (local/streaming only): ask the server whether the model is
		// already resident so "Loading model…" shows only for a genuine cold load.
		// Fired in parallel with the chat call below so it never delays the answer;
		// only updates the indicator while we're still in the "connecting" window
		// (a fast warm response can reach headers/tokens before the probe resolves).
		if (useStreaming) {
			void probeModelLoaded(provider, model).then((loaded) => {
				if (saved.livePhase !== "connecting") return;
				saved.livePhase = loaded === true ? "thinking" : "loading";
				if (log) this.updatePendingIndicator(log, saved);
			}).catch(() => { /* probe is best-effort; heuristic carries on */ });
		}

		const abort = new AbortController();
		this.activeStreamAbort = abort;
		let streamBubble: HTMLElement | null = null;

		try {
			const res = await chat(provider, model, {
				messages,
				systemPrompt: this.buildAiSystemPrompt(saved),
				maxTokens: saved.mode === "explain" ? 512 : 1024,
				stream: useStreaming,
				signal: abort.signal,
				onResponseStart: () => {
					// Headers arrived → model is loaded and generating. Flip the
					// indicator from "Connecting…"/"Loading model…" to "Thinking…"
					// in place (no re-render).
					if (saved.livePhase !== "connecting" && saved.livePhase !== "loading") return;
					saved.livePhase = "thinking";
					if (log) this.updatePendingIndicator(log, saved);
				},
				onDelta: (delta) => {
					saved.streamingText = (saved.streamingText ?? "") + delta;
					if (!log) return;
					if (!streamBubble) {
						// First token: drop the animated indicator and open a
						// plain-text bubble we append to (formatted on completion).
						saved.livePhase = "streaming";
						log.querySelector(".tmr-conv-pending-wrap")?.remove();
						const wrap = log.createEl("div", { cls: "tmr-conv-turn-ai-wrap" });
						streamBubble = wrap.createEl("div",
							{ cls: "tmr-conv-turn-ai-bubble tmr-turn-streaming" });
					}
					streamBubble.textContent = saved.streamingText ?? "";
					log.scrollTop = log.scrollHeight;
				},
			});
			saved.turns.push({ role: "assistant", content: res.content });
			saved.aiState = "complete";
			delete saved.aiError;
		} catch (err) {
			if (abort.signal.aborted) {
				// Cancelled (card closed / view unloaded). Leave the turn pending
				// for retry; no error bubble, no further render against dead DOM.
				delete saved.livePhase; delete saved.streamingText;
				return;
			}
			const msg = (err as Error).message ?? "Unknown error";
			saved.aiState = "error";
			saved.aiError = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
		} finally {
			if (this.activeStreamAbort === abort) this.activeStreamAbort = null;
		}

		delete saved.livePhase;
		delete saved.streamingText;
		if (log) { await this.renderConversationLog(log, saved); log.scrollTop = log.scrollHeight; }
		await this.patchCalloutInDoc(saved);
		if (this.paneTab === "conversations") this.renderConversationsList();
	}

	/** Build a mode-specific system prompt from the user-editable template,
	 *  substituting the book title and appending the source quote as context
	 *  so the model knows what passage is being discussed. */
	private buildAiSystemPrompt(saved: SavedHighlight): string {
		const book = this.book?.title ?? this.currentFile?.basename ?? "the current book";
		const quoteCtx = saved.quote.trim()
			? `\n\nSelected passage:\n"${saved.quote.trim()}"`
			: "";
		const template = this.plugin.settings.systemPrompts[saved.mode as AiPromptMode]
			?? DEFAULT_SYSTEM_PROMPTS[saved.mode as AiPromptMode]
			?? `You are a helpful reading assistant for "{book}".`;
		return template.replace(/\{book\}/g, book) + quoteCtx;
	}

	/** Pick a model ID for the given provider + mode, falling back to sensible
	 *  per-kind defaults when `provider.defaultModel` is unset. */
	private resolveModel(provider: AiProvider, mode: string): string {
		if (provider.defaultModel) return provider.defaultModel;
		if (provider.kind === "anthropic") {
			return mode === "explain" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
		}
		if (provider.kind === "openai") {
			return mode === "explain" ? "gpt-4o-mini" : "gpt-4o";
		}
		return "";
	}

	private async patchCalloutInDoc(saved: SavedHighlight): Promise<void> {
		const path = this.getCompanionDocPath();
		if (!path) return;
		try {
			const doc = await this.app.vault.adapter.read(path);
			// AI-bearing callouts are rebuilt from `turns`; non-AI (Emphasise)
			// callouts carry a free-text note in `userText` instead.
			const patched = GLOSS_AI_MODES.has(saved.mode)
				? this.rewriteCalloutBody(doc, saved)
				: this.rewriteEmphasiseNote(doc, saved);
			if (patched !== doc) await this.app.vault.adapter.write(path, patched);
		} catch (err) {
			console.error("[ThirdMindReader] patchCalloutInDoc failed", err);
		}
	}

	/** Rewrite the body lines of a single callout (from anchor line to the
	 *  first non-`>` line) to reflect `saved.turns` and `saved.aiState`.
	 *  Identifies the callout by `paraIdHint` + `chars` for disambiguation.
	 *  Returns the unchanged doc string when the callout cannot be found. */
	/** Locate a single callout in `lines` by its anchor (`para:` + optional
	 *  `chars:` token). Returns the header line index (`> [!mode]`), the anchor
	 *  comment line index, and the exclusive end index (first line past the
	 *  callout body). Null when the callout cannot be found. Shared by the body
	 *  rewriters and the delete path. */
	private findCalloutBounds(
		lines: string[],
		saved: SavedHighlight,
	): { startIdx: number; anchorIdx: number; endIdx: number } | null {
		const charsToken = saved.startChar >= 0 ? `chars:${saved.startChar},${saved.endChar}` : null;
		let anchorIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.includes(`para:${saved.paraIdHint}`)) continue;
			if (charsToken && !line.includes(charsToken)) continue;
			if (/<!--\s*tmr-anchor/.test(line)) { anchorIdx = i; break; }
		}
		if (anchorIdx === -1) return null;

		// Header is the nearest `> [!mode]` line at or above the anchor.
		let startIdx = anchorIdx;
		while (startIdx > 0 && !/^>\s*\[!/.test(lines[startIdx])) startIdx--;

		// End of the callout: first line not starting with `>` (or the next
		// callout header).
		let endIdx = anchorIdx + 1;
		while (endIdx < lines.length) {
			if (!/^>/.test(lines[endIdx])) break;
			if (/^>\s*\[!/.test(lines[endIdx])) break;
			endIdx++;
		}
		return { startIdx, anchorIdx, endIdx };
	}

	private rewriteCalloutBody(doc: string, saved: SavedHighlight): string {
		const lines = doc.split("\n");
		const bounds = this.findCalloutBounds(lines, saved);
		if (!bounds) return doc;
		const { anchorIdx, endIdx } = bounds;

		// Rebuild body: source quote → turns → state marker.
		const body: string[] = [];
		if (saved.quote.trim()) {
			for (const ql of saved.quote.split("\n")) body.push(`> > ${ql}`);
		}
		for (const turn of saved.turns) {
			const prefix = turn.role === "user" ? "User" : "AI";
			const contentLines = turn.content.split("\n");
			body.push(`> ${prefix}: ${contentLines[0]}`);
			for (let i = 1; i < contentLines.length; i++) body.push(`> ${contentLines[i]}`);
		}
		if (saved.aiState === "pending") {
			body.push(">");
			body.push("> <!-- ai response pending -->");
		} else if (saved.aiState === "error") {
			body.push(">");
			body.push(`> <!-- ai error: ${saved.aiError ?? "unknown"} -->`);
		}

		return [
			...lines.slice(0, anchorIdx + 1),
			...body,
			...lines.slice(endIdx),
		].join("\n");
	}

	/** Rewrite a non-AI (Emphasise) callout body to reflect `saved.userText`.
	 *  Mirrors the non-AI branch of {@link buildCallout}: source quote, then a
	 *  blank `>` separator + the note lines when a note is present. An empty
	 *  note collapses the callout back to its bare form. */
	private rewriteEmphasiseNote(doc: string, saved: SavedHighlight): string {
		const lines = doc.split("\n");
		const bounds = this.findCalloutBounds(lines, saved);
		if (!bounds) return doc;
		const { anchorIdx, endIdx } = bounds;

		const body: string[] = [];
		if (saved.quote.length > 0) {
			for (const ql of saved.quote.split(/\r?\n/)) body.push(`> > ${ql}`);
		}
		const note = saved.userText.trim();
		if (note.length > 0) {
			body.push(">");
			for (const ul of note.split(/\r?\n/)) body.push(`> ${ul}`);
		}

		return [
			...lines.slice(0, anchorIdx + 1),
			...body,
			...lines.slice(endIdx),
		].join("\n");
	}

	/** Excise a callout entirely from the companion doc, absorbing one adjacent
	 *  blank line so deletions don't leave widening gaps. Returns the doc
	 *  unchanged when the callout can't be located. */
	private removeCalloutFromDoc(doc: string, saved: SavedHighlight): string {
		const lines = doc.split("\n");
		const bounds = this.findCalloutBounds(lines, saved);
		if (!bounds) return doc;
		let { startIdx } = bounds;
		let { endIdx } = bounds;
		if (lines[endIdx] === "") endIdx++;
		else if (startIdx > 0 && lines[startIdx - 1] === "") startIdx--;
		lines.splice(startIdx, endIdx - startIdx);
		return lines.join("\n");
	}

	/** Expand the conversation card at `savedHighlights[idx]` in the list.
	 *  No-op when the list is not yet rendered or the card is not found. */
	private openConversationByIdx(idx: number): void {
		const list = this.convCardsEl;
		if (!list) return;
		const card = list.querySelector<HTMLElement>(`[data-conversation-idx="${idx}"]`);
		if (card) this.toggleConversationCard(card);
	}

	/** A bare-flagged conversation is an AI-mode callout with no user prompt
	 *  text and no AI turns — only valid for Exclaim/Enquiry submitted with
	 *  empty input. Filtered out of the Conversations list by default; the
	 *  chat-box gear popover toggles visibility. */
	private isBareFlaggedConversation(saved: SavedHighlight): boolean {
		return saved.userText.trim() === "" && saved.turns.length === 0;
	}

	/** Quick-settings popover for the chat-box gear icon. Anchored above the
	 *  gear via `Menu.showAtPosition`. Items: bare-flag toggle (pane-scoped),
	 *  reset-conversation (conversation-scoped, requires confirmation), and
	 *  a link to the plugin settings tab. */
	private openConvQuickSettings(
		anchor: HTMLElement,
		saved: SavedHighlight,
		log: HTMLElement,
	): void {
		const menu = new Menu();
		const settings = this.plugin.settings;

		menu.addItem((item) =>
			item
				.setTitle("Show bare-flagged Exclaims/Enquiries")
				.setIcon("eye")
				.setChecked(settings.showBareFlaggedConversations)
				.onClick(async () => {
					settings.showBareFlaggedConversations = !settings.showBareFlaggedConversations;
					await this.plugin.saveSettings();
					this.renderConversationsList();
				})
		);

		menu.addSeparator();

		const canReset = saved.turns.length > 2;
		menu.addItem((item) => {
			item
				.setTitle(canReset ? "Reset this conversation" : "Reset this conversation (nothing to reset)")
				.setIcon("rotate-ccw")
				.setDisabled(!canReset)
				.onClick(async () => {
					const ok = window.confirm(
						"Reset this conversation? All turns after the first exchange will be removed. This cannot be undone (the companion doc remains in vault history).",
					);
					if (!ok) return;
					const firstUser = saved.turns.find((t) => t.role === "user");
					const firstAi = saved.turns.find((t) => t.role === "assistant");
					saved.turns = [firstUser, firstAi].filter(
						(t): t is ConversationTurn => Boolean(t),
					);
					saved.aiState = "complete";
					delete saved.aiError;
					await this.patchCalloutInDoc(saved);
					await this.renderConversationLog(log, saved);
					this.renderConversationsList();
				});
		});

		menu.addSeparator();

		menu.addItem((item) =>
			item
				.setTitle("Open plugin settings →")
				.setIcon("settings")
				.onClick(() => {
					const setting = (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
					if (setting) {
						setting.open();
						setting.openTabById("third-mind-reader");
					}
				})
		);

		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.top });
	}

	private getActiveProvider(mode: GlossModeId): AiProvider | null {
		const s = this.plugin.settings;
		const override = s.aiDefaults.perMode[mode];
		if (override) {
			const p = s.aiProviders.find((p) => p.id === override.providerId);
			if (p) return p;
		}
		const primary = s.aiProviders.find((p) => p.id === s.aiDefaults.primaryProviderId);
		return primary ?? s.aiProviders[0] ?? null;
	}

	/** Mount the unit hosting the highlight, then scroll the paragraph into
	 *  the visible spread. Resolves paraId via prefix so drift-recovered
	 *  highlights still land correctly. */
	private async jumpToHighlight(idx: number, closeHighlightsPanel = true): Promise<void> {
		const saved = this.savedHighlights[idx];
		if (!saved) return;
		const match = /^s(\d+)-p(\d+)$/.exec(saved.paraIdHint);
		if (!match) return;
		const spineIdx = parseInt(match[1], 10);
		const sectionIdx = this.sectionIndexBySpine[spineIdx] ?? -1;
		const section = this.sections[sectionIdx];
		if (!section) return;
		this.savePosition();
		const targetUnitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const spreadOffset = this.getSpreadOffsetInUnitBySectionId(this.units[targetUnitIdx], section.id);
		await this.mountCurrentUnit(targetUnitIdx, spreadOffset);

		// After mount, resolve the paragraph by prefix (fall back to hint) and
		// scroll the exact paragraph into the visible spread.
		const resolvedId = saved.prefix
			? this.offsetMap.findParaIdByPrefix(saved.prefix, saved.paraIdHint)
			: saved.paraIdHint;
		if (resolvedId) {
			const entry = this.offsetMap.get(resolvedId);
			if (entry?.element) this.scrollToTarget(entry.element);
		}
		if (closeHighlightsPanel && this.highlightsOpen) this.toggleHighlightsPanel();
	}

	private async loadFile(file: TFile, initialPos?: { unitIndex: number; spread: number }): Promise<void> {
		this.resetViewState();
		this.renderShell();
		if (file.extension === "epub") {
			await this.loadEpub(async () => {
				const data = await this.app.vault.readBinary(file);
				return parseEpub(data);
			}, initialPos);
		} else if (file.extension === "md") {
			await this.loadMarkdown(file);
		} else {
			this.showError(`Unsupported file type: .${file.extension}`);
		}
	}

	private async loadFolder(folder: TFolder, initialPos?: { unitIndex: number; spread: number }): Promise<void> {
		this.resetViewState();
		this.renderShell();
		const adapter = this.app.vault.adapter as any;
		const basePath: string = adapter.basePath ?? adapter.getBasePath?.() ?? "";
		const absPath = nodePath.join(basePath, folder.path);
		await this.loadEpub(() => parseEpubDir(absPath), initialPos);
	}

	private resetViewState(): void {
		this.sections = [];
		this.units = [];
		this.sectionIndexById.clear();
		this.sectionIndexBySpine = [];
		this.unitIndexBySection.clear();
		this.sectionSpreadCounts = [];
		this.sectionColumnCounts = [];
		this.sectionStartSpreads = [];
		this.unitStartSpreads = [];
		this.spreadMeasureCache.clear();
		this.unitDomCache.clear();
		this.currentSpread = 0;
		this.currentUnitIndex = 0;
		this.totalSpreads = 1;
		this.previousPosition = null;
		this.measurementBucketKey = "";
		this.mountedUnitIndices.prev = -1;
		this.mountedUnitIndices.next = -1;
		this.offsetMap.clear();
		this.savedHighlights = [];
		this.collapsedSections.clear();
		this.layoutMode = "spread";
		this.linkPreviewCache.clear();
		this.linkPreviewPending.clear();
		this.hoveredLinkPreviewKey = null;
		this.paneTab = "annotations";
	}

	private async loadEpub(parse: () => Promise<EpubBook>, initialPos?: { unitIndex: number; spread: number }): Promise<void> {
		try {
			if (this.book) revokeImageUrls(this.book);
			this.book = await parse();
			// Remove loading element before measuring so the spread gets full
			// flex height — otherwise .tmr-loading (also flex:1) steals half
			// the vertical space, inflating measured spread counts.
			this.contentEl.querySelector(".tmr-loading")?.remove();
			// Ensure body font is loaded before any canvas-based text measurement.
			await document.fonts.ready;
			// Important: keep spread in layout while measuring section pagination.
			this.spreadEl?.removeClass("tmr-hidden");
			// Let layout settle so spread width/height are valid for measurement.
			// Single rAF is not enough when the reader pane is still animating
			// (e.g. hover-peek sidebar plugins that open/close on hover mid-open).
			// Measuring mid-animation yields bad section spread counts that get
			// cached against the final width bucket and survive recovery.
			await this.waitForStableGeometry();
			this.layoutMode = this.resolveLayoutMode();
			this.syncSpreadLayoutMode(this.spreadEl);
			this.measurementBucketKey = this.getLayoutBucketKey();
			this.buildSectionIndex();
			await this.buildRenderUnits();
			await this.loadSavedHighlights();
			this.restorePaneTab();
			const startUnit = Math.min(initialPos?.unitIndex ?? 0, Math.max(0, this.units.length - 1));
			const startSpread = initialPos?.spread ?? 0;
			await this.mountCurrentUnit(startUnit, startSpread);
			this.renderToc();
			this.buildProgressSegments();
			this.updateProgress();
			this.showSpread();
		} catch (err) {
			console.error("[ThirdMindReader] epub parse error", err);
			this.showError(`Failed to open epub: ${(err as Error).message}`);
		}
	}

	private async loadMarkdown(file: TFile): Promise<void> {
		if (!this.contentNode) return;
		const content = await this.app.vault.cachedRead(file);
		await MarkdownRenderer.render(this.app, content, this.contentNode, file.path, this);
		this.paginateVisibleContent();
		this.showSpread();
	}

	// ─── REGION: Section & Unit Modeling ─────────────────────────────────────
	private buildSectionIndex(): void {
		if (!this.book) return;
		// Walk ALL TOC items (parents and leaves) so that part dividers and
		// other parent-only entries with their own spine item become sections
		// instead of being silently absorbed into the preceding section.
		const tocItems: { label: string; href: string }[] = [];
		const walkAll = (items: EpubTocItem[]): void => {
			for (const item of items) {
				tocItems.push({ label: item.label.trim() || "Untitled", href: item.href });
				if (item.children.length > 0) walkAll(item.children);
			}
		};
		walkAll(this.book.toc);

		const rawSections: { label: string; href: string; startSpine: number }[] = [];
		const seenSpines = new Set<number>();
		for (const entry of tocItems) {
			const path = entry.href.split("#", 1)[0];
			const idx = this.book.spine.findIndex((s) => s.href === path);
			if (idx >= 0 && !seenSpines.has(idx)) {
				seenSpines.add(idx);
				rawSections.push({ label: entry.label, href: entry.href, startSpine: idx });
			}
		}

		if (rawSections.length === 0) {
			for (let i = 0; i < this.book.spine.length; i++) {
				rawSections.push({ label: `Section ${i + 1}`, href: this.book.spine[i].href, startSpine: i });
			}
		}

		rawSections.sort((a, b) => a.startSpine - b.startSpine);
		this.sections = rawSections.map((s, i) => {
			const nextStart = rawSections[i + 1]?.startSpine ?? this.book!.spine.length;
			return {
				id: `sec-${i}`,
				label: s.label,
				tocHref: s.href,
				startSpine: s.startSpine,
				endSpine: Math.max(s.startSpine, nextStart - 1),
			};
		});

		this.sectionIndexById.clear();
		this.sectionIndexBySpine = new Array(this.book.spine.length).fill(0);
		this.sections.forEach((section, idx) => {
			this.sectionIndexById.set(section.id, idx);
			for (let s = section.startSpine; s <= section.endSpine; s++) this.sectionIndexBySpine[s] = idx;
		});
	}

	// Geometry key encodes both width and height. Pagination depends on
	// both (column count is height-driven via getColumnCountForContent),
	// so a width-only cache key can't detect when only height changed —
	// which happens when e.g. a header or footer expands.
	private getLayoutBucketKey(): string {
		if (!this.spreadEl) return "";
		const w = this.spreadEl.clientWidth > 0 ? this.spreadEl.clientWidth : this.contentEl.clientWidth;
		const h = this.spreadEl.clientHeight > 0 ? this.spreadEl.clientHeight : this.contentEl.clientHeight;
		const mode = this.resolveLayoutMode();
		return `${Math.max(0, Math.round(w))}x${Math.max(0, Math.round(h))}@${mode}`;
	}

	// Wait until the spread element's width and height remain unchanged for
	// `minStableFrames` consecutive animation frames AND at least `minElapsedMs`
	// of wall time has passed. The elapsed floor is what catches animations
	// that start *after* the wait begins (e.g. sidebar auto-collapses once the
	// new epub tab activates) — without it, stability can "prove" too early
	// against the pre-animation geometry, then the animation fires, then the
	// measurement cache holds values that were wrong all along.
	private async waitForStableGeometry(
		minStableFrames = 6,
		maxFrames = 90,
		minElapsedMs = 400,
	): Promise<void> {
		if (!this.spreadEl) return;
		const start = performance.now();
		let stableFrames = 0;
		let lastW = -1;
		let lastH = -1;
		for (let i = 0; i < maxFrames; i++) {
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
			if (!this.spreadEl) return;
			const w = this.spreadEl.clientWidth;
			const h = this.spreadEl.clientHeight;
			if (w > 0 && h > 0 && w === lastW && h === lastH) {
				stableFrames++;
				if (stableFrames >= minStableFrames && performance.now() - start >= minElapsedMs) return;
			} else {
				stableFrames = 0;
				lastW = w;
				lastH = h;
			}
		}
	}

	private ensureMeasurementNodes(): void {
		if (!this.contentEl || this.measurementSpreadEl) return;
		const spread = this.contentEl.createEl("div", { cls: "tmr-spread" });
		spread.style.position = "absolute";
		spread.style.left = "-99999px";
		spread.style.top = "0";
		spread.style.visibility = "hidden";
		spread.style.pointerEvents = "none";
		const content = spread.createEl("div", { cls: "tmr-content" });
		this.measurementSpreadEl = spread;
		this.measurementContentEl = content;
	}

	private applyPagination(
		spread: HTMLElement,
		content: HTMLElement,
		mode: LayoutMode = this.layoutMode,
	): { innerWidth: number; colWidth: number; gap: number } {
		const cs = getComputedStyle(spread);
		const fallbackWidth = this.spreadEl?.clientWidth ?? this.contentEl.clientWidth;
		const spreadWidth = spread.clientWidth > 0 ? spread.clientWidth : fallbackWidth;
		const innerWidth = Math.max(100, spreadWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
		const gap = this.getColumnGap(mode, spread);
		const colWidth = Math.max(100, mode === "single" ? innerWidth : (innerWidth - gap) / 2);
		content.style.columnWidth = `${colWidth}px`;
		content.style.columnGap = `${gap}px`;
		return { innerWidth, colWidth, gap };
	}

	private getSpreadCountForContent(content: HTMLElement, pageWidth: number, gap: number): number {
		const stride = pageWidth + gap;
		if (stride <= 0) return 1;
		return Math.max(1, Math.ceil(content.scrollWidth / stride));
	}

	private getColumnCountForContent(content: HTMLElement, colWidth: number, gap: number): number {
		const parent = content.parentElement;
		if (!parent) return 1;
		const containerHeight = parent.clientHeight;
		if (containerHeight <= 0) return 1;

		// Temporarily remove column layout and constrain to a single column
		// width so we can measure the content's natural (single-column) height.
		const savedColWidth = content.style.columnWidth;
		const savedColGap = content.style.columnGap;
		const savedWidth = content.style.width;
		content.style.columnWidth = "";
		content.style.columnGap = "";
		content.style.width = `${colWidth}px`;

		const naturalHeight = content.scrollHeight;

		// Restore column layout
		content.style.columnWidth = savedColWidth;
		content.style.columnGap = savedColGap;
		content.style.width = savedWidth;

		if (naturalHeight <= containerHeight) return 1;

		// For multi-column content, count via scrollWidth
		const stride = colWidth + gap;
		if (stride <= 0) return 1;
		return Math.max(1, Math.ceil(content.scrollWidth / stride));
	}

	private async measureSection(sectionIdx: number): Promise<{ spreads: number; columns: number }> {
		if (!this.book) return { spreads: 1, columns: 1 };
		const section = this.sections[sectionIdx];
		const bucket = this.getLayoutBucketKey();
		const key = `${section.id}@${bucket}`;
		const cached = this.spreadMeasureCache.get(key);
		if (cached !== undefined) {
			const cachedColumns = this.sectionColumnCounts[sectionIdx] ?? cached;
			return { spreads: cached, columns: cachedColumns };
		}

		this.ensureMeasurementNodes();
		if (!this.measurementSpreadEl || !this.measurementContentEl) return { spreads: 1, columns: 1 };

		const width = this.spreadEl?.clientWidth || this.contentEl.clientWidth;
		const height = this.spreadEl?.clientHeight || this.contentEl.clientHeight;
		this.measurementSpreadEl.style.width = `${Math.max(200, width)}px`;
		this.measurementSpreadEl.style.height = `${Math.max(200, height)}px`;
		this.measurementContentEl.empty();
		await renderSpineRange(this.book, section.startSpine, section.endSpine, this.measurementContentEl);
		this.annotateItalicBlocks(this.measurementContentEl);
		this.syncSpreadLayoutMode(this.measurementSpreadEl);
		const { innerWidth, colWidth, gap } = this.applyPagination(this.measurementSpreadEl, this.measurementContentEl);
		const spreads = this.getSpreadCountForContent(this.measurementContentEl, innerWidth, gap);
		const columns = this.getColumnCountForContent(this.measurementContentEl, colWidth, gap);
		this.spreadMeasureCache.set(key, spreads);
		this.sectionColumnCounts[sectionIdx] = columns;
		this.measurementContentEl.empty();
		return { spreads, columns };
	}

	private async buildRenderUnits(): Promise<void> {
		if (!this.book) return;
		this.units = [];
		this.unitIndexBySection.clear();
		this.sectionSpreadCounts = new Array(this.sections.length).fill(1);
		this.sectionColumnCounts = new Array(this.sections.length).fill(1);
		this.sectionStartSpreads = new Array(this.sections.length).fill(0);
		this.unitStartSpreads = [];
		this.totalSpreads = 0;

		for (let i = 0; i < this.sections.length; i++) {
			const measured = await this.measureSection(i);
			this.sectionSpreadCounts[i] = measured.spreads;
			this.sectionColumnCounts[i] = measured.columns;
			await new Promise<void>((r) => requestAnimationFrame(() => r()));
		}

		for (let i = 0; i < this.sections.length; i++) {
			const a = this.sections[i];
			const aCount = this.sectionSpreadCounts[i];
			const aCols = this.sectionColumnCounts[i] ?? 1;
			if (this.layoutMode === "spread" && aCount === 1 && aCols === 1 && i + 1 < this.sections.length) {
				const b = this.sections[i + 1];
				const bCount = this.sectionSpreadCounts[i + 1];
				const bCols = this.sectionColumnCounts[i + 1] ?? 1;
				if (bCount === 1 && bCols === 1) {
					const unit: RenderUnit = {
						id: `unit-${this.units.length}`,
						sectionIds: [a.id, b.id],
						sectionOffsets: [0, 0],
						startSpine: a.startSpine,
						endSpine: b.endSpine,
						spreadCount: 1,
					};
					this.unitIndexBySection.set(a.id, this.units.length);
					this.unitIndexBySection.set(b.id, this.units.length);
					this.units.push(unit);
					i++;
					continue;
				}
			}

			const unit: RenderUnit = {
				id: `unit-${this.units.length}`,
				sectionIds: [a.id],
				sectionOffsets: [0],
				startSpine: a.startSpine,
				endSpine: a.endSpine,
				spreadCount: aCount,
				// Short section that couldn't pair with a neighbour: flag for
				// centered single-column rendering instead of half-empty spread.
				singlePage: aCount === 1 && aCols === 1,
			};
			this.unitIndexBySection.set(a.id, this.units.length);
			this.units.push(unit);
		}
		this.rebuildOffsets();
	}

	private rebuildOffsets(): void {
		let unitAcc = 0;
		this.unitStartSpreads = this.units.map((u) => {
			const v = unitAcc;
			unitAcc += u.spreadCount;
			return v;
		});
		this.totalSpreads = Math.max(1, unitAcc);

		this.sectionStartSpreads = new Array(this.sections.length).fill(0);
		this.units.forEach((unit, unitIdx) => {
			const base = this.unitStartSpreads[unitIdx] ?? 0;
			unit.sectionIds.forEach((id, idx) => {
				const sectionIdx = this.sectionIndexById.get(id);
				if (sectionIdx === undefined) return;
				const offset = unit.sectionOffsets[idx] ?? 0;
				this.sectionStartSpreads[sectionIdx] = base + offset;
			});
		});
	}

	private async getUnitDom(unitIdx: number): Promise<HTMLElement | null> {
		if (!this.book) return null;
		const existing = this.unitDomCache.get(unitIdx);
		if (existing) return existing;
		const unit = this.units[unitIdx];
		if (!unit) return null;

		const node = document.createElement("div");
		node.className = "tmr-unit";
		await renderSpineRange(this.book, unit.startSpine, unit.endSpine, node);
		this.annotateItalicBlocks(node);
		this.offsetMap.prepareUnit(node);
		this.unitDomCache.set(unitIdx, node);
		return node;
	}

	private async mountCurrentUnit(unitIdx: number, spread: number): Promise<void> {
		if (this.isGlossActive()) this.dismissGloss();
		const token = ++this.renderToken;
		this.currentUnitIndex = Math.max(0, Math.min(unitIdx, this.units.length - 1));
		const unit = this.units[this.currentUnitIndex];
		if (!unit || !this.contentNode) return;

		const currentDom = await this.getUnitDom(this.currentUnitIndex);
		if (token !== this.renderToken || !currentDom || !this.contentNode) return;

		this.contentNode.empty();
		this.contentNode.appendChild(currentDom);
		this.applyContentLayout(unit);
		this.preloadLinkPreviewsForUnit(currentDom);
		// Relayout pretext at the current column width for cursor-precise offsets.
		const colWidth = this.getRenderColumnWidth(unit);
		this.offsetMap.relayout(colWidth);
		this.buildTocAnchorPageMap();
		this.currentSpread = Math.max(0, Math.min(spread, unit.spreadCount - 1));
		this.goToSpread(this.currentSpread);
		this.renderSavedHighlights();
		this.hideAnnotationPreview();
		await this.mountAdjacentUnits();
		this.updateProgress();
		this.updateTocActive();
		this.schedulePositionSave();
	}

	private async mountAdjacentUnits(): Promise<void> {
		if (!this.prevHost || !this.nextHost) return;
		const prevIdx = this.currentUnitIndex - 1;
		const nextIdx = this.currentUnitIndex + 1;

		if (prevIdx >= 0) {
			const prevDom = await this.getUnitDom(prevIdx);
			if (prevDom && this.mountedUnitIndices.prev !== prevIdx) {
				this.prevHost.empty();
				this.prevHost.appendChild(prevDom);
				this.mountedUnitIndices.prev = prevIdx;
			}
		} else if (this.mountedUnitIndices.prev !== -1) {
			this.prevHost.empty();
			this.mountedUnitIndices.prev = -1;
		}

		if (nextIdx < this.units.length) {
			const nextDom = await this.getUnitDom(nextIdx);
			if (nextDom && this.mountedUnitIndices.next !== nextIdx) {
				this.nextHost.empty();
				this.nextHost.appendChild(nextDom);
				this.mountedUnitIndices.next = nextIdx;
			}
		} else if (this.mountedUnitIndices.next !== -1) {
			this.nextHost.empty();
			this.mountedUnitIndices.next = -1;
		}

		const keep = new Set([this.currentUnitIndex, prevIdx, nextIdx]);
		for (const [idx, node] of Array.from(this.unitDomCache.entries())) {
			if (!keep.has(idx)) {
				node.remove();
				this.unitDomCache.delete(idx);
			}
		}
	}

	// ─── REGION: Navigation ──────────────────────────────────────────────────
	private getCurrentUnit(): RenderUnit | null {
		return this.units[this.currentUnitIndex] ?? null;
	}

	private getCurrentSectionIndex(): number {
		const unit = this.getCurrentUnit();
		if (!unit) return 0;
		for (let i = 0; i < unit.sectionIds.length; i++) {
			const id = unit.sectionIds[i];
			const idx = this.sectionIndexById.get(id);
			if (idx === undefined) continue;
			const count = this.sectionSpreadCounts[idx] ?? 1;
			const start = unit.sectionOffsets[i] ?? 0;
			if (this.currentSpread >= start && this.currentSpread < start + count) return idx;
		}
		const first = unit.sectionIds[0];
		return this.sectionIndexById.get(first) ?? 0;
	}

	private getSpreadOffsetWithinUnit(sectionIdx: number): number {
		const unit = this.getCurrentUnit();
		if (!unit) return 0;
		for (let i = 0; i < unit.sectionIds.length; i++) {
			const idx = this.sectionIndexById.get(unit.sectionIds[i]);
			if (idx === sectionIdx) return unit.sectionOffsets[i] ?? 0;
		}
		return 0;
	}

	private getGlobalSpread(): number {
		return (this.unitStartSpreads[this.currentUnitIndex] ?? 0) + this.currentSpread;
	}

	async advance(): Promise<void> {
		const unit = this.getCurrentUnit();
		if (!unit) return;
		// While extending, keep the selection alive across the turn so the far
		// endpoint can be set on a later spread.
		if (this.isGlossActive() && !this.isExtending) this.dismissGloss();
		if (this.currentSpread < unit.spreadCount - 1) {
			this.goToSpread(this.currentSpread + 1);
			this.registerReadingTurn(1);
			return;
		}
		if (this.currentUnitIndex < this.units.length - 1) {
			await this.mountCurrentUnit(this.currentUnitIndex + 1, 0);
			this.registerReadingTurn(1);
		}
	}

	async retreat(): Promise<void> {
		if (this.isGlossActive() && !this.isExtending) this.dismissGloss();
		if (this.currentSpread > 0) {
			this.goToSpread(this.currentSpread - 1);
			this.registerReadingTurn(-1);
			return;
		}
		if (this.currentUnitIndex > 0) {
			const prevUnit = this.units[this.currentUnitIndex - 1];
			await this.mountCurrentUnit(this.currentUnitIndex - 1, Math.max(0, prevUnit.spreadCount - 1));
			this.registerReadingTurn(-1);
		}
	}

	/** Tally reader-driven page-turns toward the Back-pill decay. Forward turns
	 *  accumulate; once {@link BACK_PILL_COMMIT_TURNS} land with no backward turn
	 *  in between, the pill is dismissed (the dot stays). A backward turn means
	 *  the reader is heading back toward the origin — peeking, not committing —
	 *  so the count resets and the pill stays put. No-op without a live anchor or
	 *  once already dismissed. Seeks and jumps bypass this (they don't route
	 *  through advance/retreat), which is intended — only linear reading commits. */
	private registerReadingTurn(dir: 1 | -1): void {
		if (!this.previousPosition || this.backPillDismissed) return;
		if (dir > 0) {
			this.backForwardTurns++;
			if (this.backForwardTurns >= BACK_PILL_COMMIT_TURNS) this.backPillDismissed = true;
		} else {
			this.backForwardTurns = 0;
		}
		this.updateBackMarker();
	}

	private goToSpread(n: number): void {
		const unit = this.getCurrentUnit();
		if (!this.contentNode || !unit) return;
		const clamped = Math.max(0, Math.min(n, unit.spreadCount - 1));
		const stride = this.getNavigationStride();
		this.currentSpread = clamped;
		this.contentNode.style.transform = `translateX(-${clamped * stride}px)`;
		const sectionIdx = this.getCurrentSectionIndex();
		this.spineIndex = this.sections[sectionIdx]?.startSpine ?? 0;
		this.updateProgress();
		this.updateTocActive();
	}

	private getPageWidth(): number {
		if (!this.spreadEl) return 0;
		const cs = getComputedStyle(this.spreadEl);
		return this.spreadEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
	}

	private paginateVisibleContent(): void {
		if (!this.spreadEl || !this.contentNode) return;
		this.applyPagination(this.spreadEl, this.contentNode);
	}

	/** Apply the correct column layout for the given unit.
	 *  Single-page units get a centered narrow column; all others get the
	 *  standard two-column spread layout. */
	private applyContentLayout(unit: RenderUnit): void {
		if (!this.contentNode) return;
		this.syncSpreadLayoutMode(this.spreadEl);
		if (this.layoutMode === "single") {
			this.contentNode.removeClass("tmr-single-page");
			this.paginateVisibleContent();
			return;
		}
		if (unit.singlePage) {
			// Clear inline column styles so the CSS class takes over
			this.contentNode.style.columnWidth = "";
			this.contentNode.style.columnGap = "";
			this.contentNode.addClass("tmr-single-page");
		} else {
			this.contentNode.removeClass("tmr-single-page");
			this.paginateVisibleContent();
		}
	}

	private async handleResize(): Promise<void> {
		if (!this.book || !this.spreadEl) {
			this.paginateVisibleContent();
			this.goToSpread(this.currentSpread);
			return;
		}

		// If the leaf is hidden (background tab, collapsed split, minimised
		// window) the spread element's client dimensions drop to 0. Running
		// the rebuild path here measures against zero-sized geometry and
		// poisons the pagination model — symptoms are NaN page counters and
		// a dead progress bar once the view is brought back to the front.
		// Defer entirely; the next resize fired while visible will recover.
		if (this.spreadEl.clientWidth <= 0 || this.spreadEl.clientHeight <= 0) {
			return;
		}

		// Ensure the pane has stopped animating before reading geometry.
		// Without this, a hover-peek sidebar closing mid-debounce can fire
		// handleResize while clientWidth is still in motion, and we either
		// rebuild against the wrong bucket or skip the rebuild entirely.
		await this.waitForStableGeometry();

		// Re-check visibility after the wait — the view could have been
		// hidden during the stability window (e.g. user tabbed away).
		if (!this.spreadEl || this.spreadEl.clientWidth <= 0 || this.spreadEl.clientHeight <= 0) {
			return;
		}
		this.layoutMode = this.resolveLayoutMode();
		this.syncSpreadLayoutMode(this.spreadEl);

		const oldSectionIdx = this.getCurrentSectionIndex();
		const oldSectionSpreadOffset = this.currentSpread - this.getSpreadOffsetWithinUnit(oldSectionIdx);
		const bucket = this.getLayoutBucketKey();
		if (bucket === this.measurementBucketKey) {
			const unit = this.getCurrentUnit();
			if (unit) this.applyContentLayout(unit);
			else this.paginateVisibleContent();
			this.goToSpread(this.currentSpread);
			return;
		}

		this.measurementBucketKey = bucket;
		this.spreadMeasureCache.clear();
		this.unitDomCache.clear();
		await this.buildRenderUnits();

		const section = this.sections[oldSectionIdx];
		if (!section) {
			await this.mountCurrentUnit(0, 0);
			return;
		}

		const targetUnitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const targetOffset = this.getSpreadOffsetInUnitBySectionId(this.units[targetUnitIdx], section.id);
		const sectionCount = this.sectionSpreadCounts[oldSectionIdx] ?? 1;
		const targetSpread = targetOffset + Math.max(0, Math.min(oldSectionSpreadOffset, sectionCount - 1));
		await this.mountCurrentUnit(targetUnitIdx, targetSpread);
	}

	private getSpreadOffsetInUnitBySectionId(unit: RenderUnit | undefined, sectionId: string): number {
		if (!unit) return 0;
		for (let i = 0; i < unit.sectionIds.length; i++) {
			if (unit.sectionIds[i] === sectionId) return unit.sectionOffsets[i] ?? 0;
		}
		return 0;
	}

	private findTarget(id: string): Element | null {
		if (!id || !this.contentNode) return null;
		try {
			return this.contentNode.querySelector(`#${CSS.escape(id)}`);
		} catch {
			return null;
		}
	}

	private scrollToTarget(target: Element): void {
		if (!this.contentNode) return;
		const pageWidth = this.getPageWidth();
		if (pageWidth <= 0) return;
		const targetRect = target.getBoundingClientRect();
		const contentRect = this.contentNode.getBoundingClientRect();
		const offsetX = targetRect.left - contentRect.left;
		const spread = Math.floor(offsetX / this.getNavigationStride());
		const unit = this.getCurrentUnit();
		if (unit && spread >= 0 && spread < unit.spreadCount) this.goToSpread(spread);
	}

	private getReadableLineWidth(): number {
		const raw = getComputedStyle(this.contentEl).getPropertyValue("--tmr-line-width").trim();
		const width = parseFloat(raw);
		return Number.isFinite(width) && width > 0 ? width : 680;
	}

	private getMinSidePaddingPx(spread: HTMLElement | null = this.spreadEl): number {
		if (!spread) return 48;
		const fontSize = parseFloat(getComputedStyle(spread).fontSize);
		return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 3 : 48;
	}

	private getLayoutCandidateWidth(spread: HTMLElement | null = this.spreadEl): number {
		if (!spread) return 0;
		return Math.max(100, spread.clientWidth - this.getMinSidePaddingPx(spread) * 2);
	}

	private resolveLayoutMode(
		candidateWidth = this.getLayoutCandidateWidth(),
		previous: LayoutMode = this.layoutMode,
	): LayoutMode {
		const readableWidth = this.getReadableLineWidth();
		const minSpreadCol = Math.max(
			ReaderView.SINGLE_PAGE_MIN_SPREAD_COL,
			Math.min(ReaderView.SINGLE_PAGE_MAX_SPREAD_COL, readableWidth * ReaderView.SINGLE_PAGE_BREAK_RATIO),
		);
		const breakpoint = minSpreadCol * 2 + ReaderView.GAP;
		if (previous === "single") {
			return candidateWidth > breakpoint + ReaderView.SINGLE_PAGE_HYSTERESIS ? "spread" : "single";
		}
		return candidateWidth < breakpoint - ReaderView.SINGLE_PAGE_HYSTERESIS ? "single" : "spread";
	}

	private syncSpreadLayoutMode(spread: HTMLElement | null, mode: LayoutMode = this.layoutMode): void {
		if (!spread) return;
		spread.toggleClass("tmr-layout-single", mode === "single");
	}

	private getColumnGap(mode: LayoutMode = this.layoutMode, spread: HTMLElement | null = this.spreadEl): number {
		return mode === "single" ? this.getSinglePageGap(spread) : ReaderView.GAP;
	}

	private getNavigationStride(): number {
		return this.getPageWidth() + this.getColumnGap();
	}

	private getRenderColumnWidth(unit: RenderUnit | null): number {
		const pageWidth = this.getPageWidth();
		if (pageWidth <= 0) return 340;
		if (this.layoutMode === "single") return pageWidth;
		if (unit?.singlePage) return Math.max(100, Math.min(pageWidth, this.getReadableLineWidth()));
		return Math.max(100, (pageWidth - ReaderView.GAP) / 2);
	}

	private getSinglePageGap(spread: HTMLElement | null = this.spreadEl): number {
		if (!spread) return this.getMinSidePaddingPx(spread);
		const cs = getComputedStyle(spread);
		const left = parseFloat(cs.paddingLeft);
		const right = parseFloat(cs.paddingRight);
		const gap = Math.min(
			Number.isFinite(left) ? left : this.getMinSidePaddingPx(spread),
			Number.isFinite(right) ? right : this.getMinSidePaddingPx(spread),
		);
		return Math.max(this.getMinSidePaddingPx(spread), gap);
	}

	private handleLinkHover(anchor: HTMLAnchorElement, e: MouseEvent): void {
		const href = anchor.getAttribute("href")?.trim() ?? "";
		if (!href || href.startsWith("http") || href.startsWith("mailto:")) return;

		if (href.startsWith("#")) {
			const targetEl = this.findTarget(href.slice(1));
			if (targetEl) this.showTooltip(targetEl, e);
			return;
		}

		const key = this.getLinkPreviewKey(anchor);
		if (!key) return;

		this.hoveredLinkPreviewKey = key;
		const cached = this.linkPreviewCache.get(key);
		if (cached) {
			this.showTooltipPreview(cached, e);
			return;
		}
		if (cached === null && this.linkPreviewCache.has(key)) return;

		void this.ensureLinkPreview(anchor).then((preview) => {
			if (!preview || this.hoveredLinkPreviewKey !== key) return;
			this.showTooltipPreview(preview, e);
		});
	}

	private preloadLinkPreviewsForUnit(unitRoot: HTMLElement): void {
		const seen = new Set<string>();
		unitRoot.querySelectorAll("a[href]").forEach((anchorEl) => {
			const anchor = anchorEl as HTMLAnchorElement;
			const key = this.getLinkPreviewKey(anchor);
			if (!key || seen.has(key)) return;
			seen.add(key);
			void this.ensureLinkPreview(anchor);
		});
	}

	private getLinkPreviewKey(anchor: HTMLAnchorElement): string | null {
		const href = anchor.getAttribute("href")?.trim() ?? "";
		if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
			return null;
		}
		const baseHref = this.getAnchorSourceHref(anchor);
		if (!baseHref) return null;
		return resolveEpubHref(baseHref, href)?.resolvedHref ?? null;
	}

	private getAnchorSourceHref(anchor: HTMLAnchorElement): string | null {
		if (!this.book) return null;
		const spineHost = anchor.closest(".tmr-spine-item") as HTMLElement | null;
		const spineIndex = parseInt(spineHost?.dataset.spineIndex ?? "", 10);
		if (Number.isFinite(spineIndex) && this.book.spine[spineIndex]) {
			return this.book.spine[spineIndex].href;
		}
		return this.book.spine[this.spineIndex]?.href ?? null;
	}

	private ensureLinkPreview(anchor: HTMLAnchorElement): Promise<EpubLinkPreview | null> {
		if (!this.book) return Promise.resolve(null);
		const href = anchor.getAttribute("href")?.trim() ?? "";
		const baseHref = this.getAnchorSourceHref(anchor);
		const key = baseHref ? this.getLinkPreviewKey(anchor) : null;
		if (!href || !baseHref || !key) return Promise.resolve(null);

		if (this.linkPreviewCache.has(key)) {
			return Promise.resolve(this.linkPreviewCache.get(key) ?? null);
		}

		const pending = this.linkPreviewPending.get(key);
		if (pending) return pending;

		const task = extractLinkPreview(this.book, baseHref, href)
			.then((preview) => {
				this.linkPreviewCache.set(key, preview);
				this.linkPreviewPending.delete(key);
				return preview;
			})
			.catch(() => {
				this.linkPreviewCache.set(key, null);
				this.linkPreviewPending.delete(key);
				return null;
			});
		this.linkPreviewPending.set(key, task);
		return task;
	}

	private resolveRelativePath(path: string): string {
		const parts = path.split("/");
		const resolved: string[] = [];
		for (const part of parts) {
			if (part === "..") resolved.pop();
			else if (part !== "." && part !== "") resolved.push(part);
		}
		return resolved.join("/");
	}

	private async navigateToHref(href: string): Promise<void> {
		if (!this.book) return;
		this.savePosition();
		const [rawPath, fragment] = href.split("#", 2);
		const currentItem = this.book.spine[this.spineIndex];
		const currentDir = currentItem?.href.includes("/")
			? currentItem.href.substring(0, currentItem.href.lastIndexOf("/") + 1)
			: "";
		const resolved = rawPath ? this.resolveRelativePath(currentDir + rawPath) : currentItem?.href ?? "";
		const targetSpine = this.book.spine.findIndex((s) => s.href === resolved);
		if (targetSpine < 0) return;
		await this.jumpToSpine(targetSpine, fragment ?? null);
	}

	private async navigateToTocHref(href: string): Promise<void> {
		if (!this.book) return;
		this.savePosition();
		const [path, fragment] = href.split("#", 2);
		const targetSpine = this.book.spine.findIndex((s) => s.href === path);
		if (targetSpine < 0) return;
		await this.jumpToSpine(targetSpine, fragment ?? null);
	}

	private async jumpToSpine(targetSpine: number, fragment: string | null): Promise<void> {
		const sectionIdx = this.sectionIndexBySpine[targetSpine] ?? 0;
		const section = this.sections[sectionIdx];
		if (!section) return;
		const targetUnitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const spreadOffset = this.getSpreadOffsetInUnitBySectionId(this.units[targetUnitIdx], section.id);
		await this.mountCurrentUnit(targetUnitIdx, spreadOffset);
		if (fragment) {
			const namespacedId = `s${targetSpine}-${fragment}`;
			const target = this.findTarget(namespacedId);
			if (target) this.scrollToTarget(target);
		}
	}

	private updateTocActive(): void {
		if (!this.book) return;
		const currentHref = this.book.spine[this.spineIndex]?.href;
		if (!currentHref) return;
		const allItems = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".tmr-toc-item"));
		allItems.forEach((el) => el.removeClass("tmr-toc-active"));

		// Find the deepest ToC anchor at or before the current spread.
		let activeSubHref: string | null = null;
		for (let i = this.tocAnchorPageMap.length - 1; i >= 0; i--) {
			if (this.tocAnchorPageMap[i].spreadOffset <= this.currentSpread) {
				activeSubHref = this.tocAnchorPageMap[i].href;
				break;
			}
		}
		// Discard map hit if it belongs to a different spine doc than what's visible.
		if (activeSubHref && activeSubHref.split("#")[0] !== currentHref) activeSubHref = null;

		let subActivated = false;
		let level0Activated = false;
		let firstSubEl: HTMLElement | null = null;
		for (const el of allItems) {
			const elHref = el.dataset.href ?? "";
			if (elHref.split("#")[0] !== currentHref) continue;
			if (el.dataset.level === "0") {
				el.addClass("tmr-toc-active");
				level0Activated = true;
			} else if (!subActivated && (!activeSubHref || elHref === activeSubHref)) {
				el.addClass("tmr-toc-active");
				subActivated = true;
				firstSubEl = el;
			}
		}
		// Sub-item active but structural parent (level-0) lives in a different spine doc —
		// walk backwards to the nearest preceding level-0 item and give it the card state.
		if (subActivated && !level0Activated && firstSubEl) {
			const idx = allItems.indexOf(firstSubEl);
			for (let i = idx - 1; i >= 0; i--) {
				if (allItems[i].dataset.level === "0") {
					allItems[i].addClass("tmr-toc-active");
					break;
				}
			}
		}
	}

	private buildTocAnchorPageMap(): void {
		this.tocAnchorPageMap = [];
		if (!this.book || !this.contentNode) return;
		const stride = this.getNavigationStride();
		if (stride <= 0) return;
		const contentRect = this.contentNode.getBoundingClientRect();
		const entries: Array<{ spreadOffset: number; href: string }> = [];
		const walk = (items: EpubTocItem[]): void => {
			for (const item of items) {
				const sepIdx = item.href.indexOf("#");
				if (sepIdx !== -1) {
					const path = item.href.slice(0, sepIdx);
					const hash = item.href.slice(sepIdx + 1);
					// IDs in the rendered DOM are namespaced as `s${spineIdx}-${originalId}`
					// (see epub.ts renderSpineRange). Resolve the spine index to build the key.
					const spineIdx = this.book!.spine.findIndex((s) => s.href === path);
					if (spineIdx !== -1) {
						const target = this.findTarget(`s${spineIdx}-${hash}`);
						if (target) {
							const rect = target.getBoundingClientRect();
							const spreadOffset = Math.max(0, Math.floor((rect.left - contentRect.left) / stride));
							entries.push({ spreadOffset, href: item.href });
						}
					}
				}
				if (item.children.length > 0) walk(item.children);
			}
		};
		walk(this.book.toc);
		entries.sort((a, b) => a.spreadOffset - b.spreadOffset);
		this.tocAnchorPageMap = entries;
	}

	private annotateItalicBlocks(container: HTMLElement): void {
		const allBlocks = Array.from(container.querySelectorAll("p, div"));
		const candidates = allBlocks.filter((el) => {
			if (el.querySelector("p, div, blockquote, section, article")) return false;
			return (el.textContent?.trim() ?? "").length > 0;
		});

		const italic = candidates.map((el) => this.isItalicElement(el as HTMLElement));
		let i = 0;
		while (i < candidates.length) {
			if (!italic[i]) {
				i++;
				continue;
			}
			let end = i;
			while (end < candidates.length && italic[end]) end++;
			if (end - i >= 3) {
				for (let j = i; j < end; j++) candidates[j].classList.add("tmr-italic-block");
			}
			i = end;
		}

		for (let k = 0; k < candidates.length; k++) {
			const el = candidates[k] as HTMLElement;
			if (el.classList.contains("tmr-italic-block")) continue;
			// A single italic leaf block counts as verse once it spans more than
			// one line (≥1 explicit <br>). The old ≥2 bar boxed 3-line poems but
			// dropped 2-line couplets, which the source encodes identically —
			// purely a line-count artifact. One <br> in an italic block is almost
			// always verse, so this keeps couplets consistent with longer poems.
			if (italic[k] && el.querySelectorAll("br").length >= 1) el.classList.add("tmr-italic-block");
		}
	}

	private isItalicElement(el: HTMLElement): boolean {
		const text = el.textContent?.trim() ?? "";
		if (!text) return false;
		let italicLen = 0;
		el.querySelectorAll("em, i").forEach((child) => {
			italicLen += child.textContent?.length ?? 0;
		});
		return italicLen / text.length >= 0.8;
	}

	// ─── REGION: Gloss UI ────────────────────────────────────────────────────

	private isGlossActive(): boolean {
		return this.activeHighlight !== null;
	}

	/** True when a text field has focus — any reader-owned input, textarea, or
	 *  contenteditable. Reader navigation and shortcuts defer to it so typing
	 *  isn't hijacked by page turns or panel toggles. */
	isTextInputFocused(): boolean {
		const el = document.activeElement as HTMLElement | null;
		return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
	}

	/** The gloss mode a numeric shortcut (1–5) maps to right now, or null if the
	 *  shortcut isn't currently actionable: the GlossBar is hidden, a mode input
	 *  panel is open (the number belongs to that field), or the mode is suppressed
	 *  in Lite mode. Mirrors the GlossBar tile order. Used by the gloss commands'
	 *  checkCallback so `1`–`5` only fire over a live selection. */
	glossShortcutMode(slot: number): string | null {
		if (!this.glossBarEl || this.glossBarEl.hasClass("tmr-hidden")) return null;
		if (this.glossInputEl?.hasClass("tmr-hidden") === false) return null;
		const mode = GLOSS_MODES[slot - 1];
		if (!mode) return null;
		// Lite mode hides the AI tiles — only Emphasise (1) stays live.
		if (!this.plugin.settings.aiFeaturesEnabled && mode.id !== "emphasise") return null;
		return mode.id;
	}

	/** Flip 3C mode on/off. Shared by the TOC footer button and the
	 *  "Toggle 3C mode" command. Snaps the 3C theme to Obsidian's current colour
	 *  scheme when turning on so the user needn't switch manually after. */
	async toggleTmrMode(): Promise<void> {
		const newMode = this.plugin.settings.tmrMode === "3c" ? "obsidian" : "3c";
		this.plugin.settings.tmrMode = newMode;
		if (newMode === "3c") {
			this.plugin.settings.tmrTheme = document.body.classList.contains("theme-light") ? "light" : "dark";
		}
		await this.plugin.saveSettings();
	}

	private ensureGlossBar(): HTMLElement {
		if (this.glossBarEl) return this.glossBarEl;
		const bar = document.body.createEl("div", { cls: "tmr-gloss-bar tmr-hidden" });
		GLOSS_MODES.forEach((mode, idx) => {
			const tile = bar.createEl("button", { cls: "tmr-gloss-tile" });
			tile.dataset.glossMode = mode.id;
			tile.dataset.shortcut = String(idx + 1);
			setIcon(tile, mode.icon);
			// Prevent mousedown from clearing the text selection before the click fires.
			this.registerDomEvent(tile, "mousedown", (e: MouseEvent) => e.preventDefault());
			this.registerDomEvent(tile, "click", (e: MouseEvent) => {
				e.stopPropagation();
				this.openGlossInput(mode.id);
			});
			// Custom tile tooltip (theme-synced, tinted per-mode). Replaces the
			// neutral Obsidian aria-label tooltip so the hint can inherit the
			// tile's fill colour and carry the numeric shortcut hint.
			this.registerDomEvent(tile, "mouseenter", () => {
				const label = `${mode.label} (${idx + 1})`;
				this.showGlossTileTooltip(tile, mode.id, label);
			});
			this.registerDomEvent(tile, "mouseleave", () => this.hideGlossTileTooltip());
			// Separator stroke after the standard-highlight tile (Emphasise),
			// before the AI tiles. Hidden in Lite mode along with those tiles.
			if (idx === 0) bar.createEl("div", { cls: "tmr-gloss-sep" });
		});

		// Extend-across-pages action (not a gloss mode). Stays visible in Lite
		// mode — cross-page highlighting matters for plain Emphasise too.
		bar.createEl("div", { cls: "tmr-gloss-sep tmr-gloss-sep-extend" });
		const extendTile = bar.createEl("button", { cls: "tmr-gloss-tile tmr-gloss-tile-extend" });
		setIcon(extendTile, "unfold-horizontal");
		this.registerDomEvent(extendTile, "mousedown", (e: MouseEvent) => e.preventDefault());
		this.registerDomEvent(extendTile, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.beginExtend();
		});
		this.registerDomEvent(extendTile, "mouseenter", () =>
			this.showGlossTileTooltip(extendTile, "extend", "Extend across pages"));
		this.registerDomEvent(extendTile, "mouseleave", () => this.hideGlossTileTooltip());

		this.glossBarEl = bar;
		this.syncGlossBarTheme();
		return bar;
	}

	private ensureGlossTileTooltip(): HTMLElement {
		if (this.glossTileTooltipEl) return this.glossTileTooltipEl;
		const el = document.body.createEl("div", { cls: "tmr-gloss-tooltip tmr-hidden" });
		this.glossTileTooltipEl = el;
		this.syncGlossTileTooltipTheme();
		return el;
	}

	private syncGlossTileTooltipTheme(): void {
		const el = this.glossTileTooltipEl;
		if (!el) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			el.addClass("tmr-3c-mode");
			el.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			el.removeClass("tmr-3c-mode");
			el.removeAttribute("data-tmr-theme");
		}
	}

	private showGlossTileTooltip(tile: HTMLElement, modeId: string, label: string): void {
		const el = this.ensureGlossTileTooltip();
		el.dataset.glossMode = modeId;
		el.setText(label);
		el.removeClass("tmr-hidden");
		const tileRect = tile.getBoundingClientRect();
		const tipRect = el.getBoundingClientRect();
		const margin = 6;
		const left = Math.max(4, Math.min(
			tileRect.left + tileRect.width / 2 - tipRect.width / 2,
			window.innerWidth - tipRect.width - 4,
		));
		const top = tileRect.bottom + margin;
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	private hideGlossTileTooltip(): void {
		this.glossTileTooltipEl?.addClass("tmr-hidden");
	}

	private syncGlossBarTheme(): void {
		if (!this.glossBarEl) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			this.glossBarEl.addClass("tmr-3c-mode");
			this.glossBarEl.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			this.glossBarEl.removeClass("tmr-3c-mode");
			this.glossBarEl.removeAttribute("data-tmr-theme");
		}
	}

	private onSelectionMouseUp(): void {
		const sel = window.getSelection();
		// A click while extending sets the far endpoint of the anchored range.
		if (this.isExtending) {
			if (sel) this.finishExtend(sel);
			return;
		}
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		if (!this.spreadEl || !this.spreadEl.contains(range.startContainer)) return;
		this.finalizeSelection(sel, range.getBoundingClientRect());
	}

	/** Resolve a native selection to a stored `CursorRange`, paint the active
	 *  overlay, and raise the GlossBar at `anchorRect`. Shared by the normal
	 *  mouseup path and the anchored cross-page extend. */
	private finalizeSelection(sel: Selection, anchorRect: DOMRect): void {
		const cursorRange = this.offsetMap.selectionToCursors(sel);
		if (!cursorRange) return;
		this.clearHighlightOverlay();
		this.activeHighlight = cursorRange;
		this.activeSelectionText = sel.toString();
		this.activeSelectionRect = anchorRect;
		this.renderHighlightOverlay(cursorRange);
		this.glossInputEl?.addClass("tmr-hidden");
		this.activeGlossMode = null;
		this.showGlossBar(anchorRect, this.selectionReachesSpreadEnd(sel));
	}

	/** True when the selection ends on the last visible line of the spread —
	 *  i.e. the next run of text flows onto a further spread in this unit. This
	 *  is the only case where "Extend across pages" is useful, so the tile is
	 *  gated on it to keep the bar uncluttered during normal selection. Column-
	 *  count-agnostic: it asks whether the following text is off the visible
	 *  viewport, which holds for both single- and two-page layouts. */
	private selectionReachesSpreadEnd(sel: Selection): boolean {
		if (!this.spreadEl || !this.contentNode || sel.rangeCount === 0) return false;
		const next = this.rectAfterSelectionEnd(sel.getRangeAt(0));
		// No following text in this unit → nothing to extend into.
		if (!next) return false;

		// Compare against the usable reading box, not spreadEl's outer rect: the
		// spread carries large side padding, and in two-page view the next
		// spread's column begins *inside* that right padding (just past the
		// visible columns). Comparing to the padded edge — plus a margin from the
		// column gap so a glyph at the rightmost column's own edge can't trigger —
		// is what makes this work in both single- and two-page layouts.
		const view = this.spreadEl.getBoundingClientRect();
		const sCs = getComputedStyle(this.spreadEl);
		const padR = parseFloat(sCs.paddingRight) || 0;
		const padB = parseFloat(sCs.paddingBottom) || 0;
		const gap = parseFloat(getComputedStyle(this.contentNode).columnGap) || 0;
		const margin = Math.max(8, gap / 2);
		const rightEdge = view.right - padR;
		const bottomEdge = view.bottom - padB;

		// Following text sits in a further column (past the visible reading area)
		// or below the visible bottom → the selection reached the page's last line.
		return next.left >= rightEdge + margin || next.top >= bottomEdge;
	}

	/** Bounding rect of the position immediately after a range's end: the next
	 *  character in the same text node, else the first character of the next
	 *  non-empty text node in document order within the content. Null at the end
	 *  of the unit's content. */
	private rectAfterSelectionEnd(range: Range): DOMRect | null {
		const node = range.endContainer;
		const offset = range.endOffset;
		const probe = document.createRange();
		if (node.nodeType === Node.TEXT_NODE && offset < (node.textContent?.length ?? 0)) {
			probe.setStart(node, offset);
			probe.setEnd(node, offset + 1);
			const r = probe.getBoundingClientRect();
			if (r.width || r.height) return r;
		}
		const nextNode = this.nextTextNode(node);
		if (!nextNode) return null;
		probe.setStart(nextNode, 0);
		probe.setEnd(nextNode, Math.min(1, nextNode.textContent?.length ?? 0));
		const r = probe.getBoundingClientRect();
		return r.width || r.height ? r : null;
	}

	/** Next non-whitespace text node after `from` in document order, scoped to
	 *  the content node. */
	private nextTextNode(from: Node): Text | null {
		const root = this.contentNode;
		if (!root || !root.contains(from)) return null;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		walker.currentNode = from;
		let n = walker.nextNode();
		while (n) {
			// Skip descendants of `from`: when the selection ends on an element
			// boundary, the walker would otherwise dive back into the just-
			// selected text and report an on-screen rect.
			if (!from.contains(n) && (n.textContent?.trim().length ?? 0) > 0) return n as Text;
			n = walker.nextNode();
		}
		return null;
	}

	/** Arm anchored cross-page selection: freeze the current selection's start
	 *  as the anchor, keep the selection alive, hide the bar, and surface a hint.
	 *  The next reader click (`finishExtend`) sets the far endpoint. */
	private beginExtend(): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
		const range = sel.getRangeAt(0);
		if (!this.spreadEl?.contains(range.startContainer)) return;
		this.extendAnchor = { node: range.startContainer, offset: range.startOffset };
		this.isExtending = true;
		this.glossBarEl?.addClass("tmr-hidden");
		this.hideGlossTileTooltip();
		this.showExtendHint();
	}

	/** Complete an anchored selection: span from the frozen anchor to the just-
	 *  clicked point (ordered into document order), then run the standard
	 *  finalize pipeline. Aborts cleanly if either boundary has left the DOM
	 *  (e.g. the reader crossed a unit boundary or relayed out mid-gesture). */
	private finishExtend(sel: Selection): void {
		const anchor = this.extendAnchor;
		this.isExtending = false;
		this.extendAnchor = null;
		this.hideExtendHint();
		if (!anchor || sel.rangeCount === 0) return;

		const endRange = sel.getRangeAt(0);
		const endNode = endRange.endContainer;
		const endOffset = endRange.endOffset;
		const sp = this.spreadEl;
		if (!sp || !sp.contains(anchor.node) || !sp.contains(endNode)) return;

		// Order the two boundary points so setStart/setEnd never go backwards.
		const probe = document.createRange();
		probe.setStart(anchor.node, anchor.offset);
		probe.setEnd(anchor.node, anchor.offset);
		let rel: number;
		try { rel = probe.comparePoint(endNode, endOffset); } catch { return; }

		const full = document.createRange();
		try {
			if (rel >= 0) {
				full.setStart(anchor.node, anchor.offset);
				full.setEnd(endNode, endOffset);
			} else {
				full.setStart(endNode, endOffset);
				full.setEnd(anchor.node, anchor.offset);
			}
		} catch { return; }
		if (full.collapsed) return;

		// Position the bar at the click (the visible endpoint); the full range's
		// own rect would reach off-screen onto the anchor's page.
		const clickRect = endRange.getBoundingClientRect();
		const rect = clickRect.width || clickRect.height || clickRect.top || clickRect.left
			? clickRect
			: full.getBoundingClientRect();

		sel.removeAllRanges();
		sel.addRange(full);
		this.finalizeSelection(sel, rect);
	}

	private ensureExtendHint(): HTMLElement {
		if (this.extendHintEl) return this.extendHintEl;
		const el = document.body.createEl("div", {
			cls: "tmr-extend-hint tmr-hidden",
			text: "Turn the page, then click where the highlight should end · Esc to cancel",
		});
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			el.addClass("tmr-3c-mode");
			el.setAttribute("data-tmr-theme", tmrTheme);
		}
		this.extendHintEl = el;
		return el;
	}

	private showExtendHint(): void {
		this.ensureExtendHint().removeClass("tmr-hidden");
	}

	private hideExtendHint(): void {
		this.extendHintEl?.addClass("tmr-hidden");
	}

	/** Position a fixed-position floater (bar or input) relative to a selection
	 *  rect, flipping below if above doesn't fit and clamping to the viewport. */
	private positionFloater(el: HTMLElement, selectionRect: DOMRect): void {
		el.style.left = "0px";
		el.style.top = "0px";
		const rect = el.getBoundingClientRect();
		const margin = 8;
		const flipBelow = selectionRect.top < rect.height + margin + 16;
		const top = flipBelow
			? selectionRect.bottom + margin
			: selectionRect.top - rect.height - margin;
		const midX = selectionRect.left + selectionRect.width / 2;
		const maxLeft = window.innerWidth - rect.width - 8;
		const left = Math.max(8, Math.min(midX - rect.width / 2, maxLeft));
		el.style.left = `${left}px`;
		el.style.top = `${Math.max(8, top)}px`;
	}

	private showGlossBar(selectionRect: DOMRect, canExtend = false): void {
		const bar = this.ensureGlossBar();
		// Lite mode (no AI) collapses the bar to the Emphasise tile only.
		bar.toggleClass("tmr-gloss-lite", !this.plugin.settings.aiFeaturesEnabled);
		// Extend control only surfaces when the selection runs to the page end.
		bar.toggleClass("tmr-gloss-can-extend", canExtend);
		bar.removeClass("tmr-hidden");
		this.positionFloater(bar, selectionRect);
	}

	private ensureGlossInput(): HTMLElement {
		if (this.glossInputEl) return this.glossInputEl;
		const panel = document.body.createEl("div", { cls: "tmr-gloss-input tmr-hidden" });
		const input = panel.createEl("input", {
			cls: "tmr-gloss-input-field",
			attr: { type: "text" },
		});
		const submitBtn = panel.createEl("button", { cls: "tmr-gloss-input-submit" });
		setIcon(submitBtn, "corner-down-left");
		submitBtn.setAttribute("aria-label", "Submit annotation");
		this.registerDomEvent(submitBtn, "mousedown", (e) => e.preventDefault());
		this.registerDomEvent(submitBtn, "click", (e) => {
			e.stopPropagation();
			void this.onGlossSubmit();
		});
		this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				void this.onGlossSubmit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.dismissGloss();
			}
		});
		this.glossInputEl = panel;
		this.syncGlossInputTheme();
		return panel;
	}

	private syncGlossInputTheme(): void {
		if (!this.glossInputEl) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			this.glossInputEl.addClass("tmr-3c-mode");
			this.glossInputEl.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			this.glossInputEl.removeClass("tmr-3c-mode");
			this.glossInputEl.removeAttribute("data-tmr-theme");
		}
	}

	openGlossInput(modeId: string): void {
		const mode = GLOSS_MODES.find((m) => m.id === modeId);
		if (!mode) return;
		if (!this.activeHighlight || !this.activeSelectionRect) return;
		this.activeGlossMode = modeId;
		this.glossBarEl?.addClass("tmr-hidden");
		const panel = this.ensureGlossInput();
		this.syncGlossInputTheme();
		panel.dataset.glossMode = modeId;
		const input = panel.querySelector(".tmr-gloss-input-field") as HTMLInputElement | null;
		if (input) {
			input.value = "";
			input.placeholder = GLOSS_PLACEHOLDERS[modeId] ?? "";
		}
		panel.removeClass("tmr-hidden");
		this.positionFloater(panel, this.activeSelectionRect);
		input?.focus();
	}

	private async onGlossSubmit(): Promise<void> {
		const mode = this.activeGlossMode;
		const highlight = this.activeHighlight;
		if (!mode || !highlight) return;
		const input = this.glossInputEl?.querySelector(".tmr-gloss-input-field") as HTMLInputElement | null;
		const userText = input?.value.trim() ?? "";
		// Non-emphasise modes require at least some text. Emphasise-with-empty
		// writes a bare colour-flagged callout (spec §Phase 2, Emphasise).
		if (mode !== "emphasise" && userText.length === 0) {
			input?.focus();
			return;
		}
		const quote = this.activeSelectionText ?? "";
		try {
			await this.persistGloss(mode, userText, quote, highlight);
		} catch (err) {
			console.error("persistGloss failed", err);
			new Notice("Third Mind Reader: failed to save annotation");
			return;
		}
		// All AI modes open the Conversations tab immediately on submit so
		// the user lands in the chat surface without manual navigation, then the
		// initial AI call is fired into the now-open card's live log so the first
		// turn streams token-by-token like every follow-up.
		if (GLOSS_AI_MODES.has(mode)) {
			if (!this.highlightsOpen) this.toggleHighlightsPanel();
			this.setPaneTab("conversations");
			const idx = this.savedHighlights.length - 1;
			this.openConversationByIdx(idx);
			const saved = this.savedHighlights[idx];
			if (saved) {
				void this.doAiExchange(saved, this.activeConvLog).catch((err) =>
					console.error("[ThirdMindReader] initial AI call failed", err),
				);
			}
		}
		this.dismissGloss();
	}

	private async persistGloss(
		modeId: string,
		userText: string,
		quote: string,
		highlight: CursorRange,
	): Promise<void> {
		const path = this.getCompanionDocPath();
		if (!path) return;
		const callout = this.buildCallout(modeId, userText, quote, highlight);
		await this.ensureCompanionDoc(path);
		const existing = await this.app.vault.adapter.read(path);
		const pad = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		await this.app.vault.adapter.write(path, existing + pad + callout + "\n");

		const chars = this.offsetMap.cursorRangeToChars(highlight);
		const entry = this.offsetMap.get(highlight.paraId);
		const prefix = entry ? entry.text.replace(/\s+/g, " ").trim().slice(0, ANCHOR_PREFIX_LEN) : "";
		// Synthesise the in-memory record so the freshly saved highlight is
		// renderable without a re-parse. AI-bearing modes get a `pending`
		// state because `buildCallout` writes the pending marker for them.
		const isAiMode = GLOSS_AI_MODES.has(modeId);
		this.savedHighlights.push({
			mode: modeId,
			paraIdHint: highlight.paraId,
			endParaIdHint: highlight.endParaId,
			startChar: chars?.startChar ?? -1,
			endChar: chars?.endChar ?? -1,
			prefix,
			userText,
			quote,
			turns: [],
			aiState: isAiMode ? "pending" : "complete",
			legacyCursors: null,
		});
		this.renderSavedHighlights();
		new Notice(`${modeId[0].toUpperCase()}${modeId.slice(1)} saved`);
		// The initial AI call for AI-bearing modes is fired by `onGlossSubmit`
		// once the Conversations card is open, so the first turn streams into the
		// live log just like every follow-up turn.
	}

	/** Parse the companion doc on book load so prior-session highlights are
	 *  re-rendered in the reader. Missing file = empty list (silent). */
	private async loadSavedHighlights(): Promise<void> {
		this.savedHighlights = [];
		const path = this.getCompanionDocPath();
		if (!path) return;
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(path))) return;
			const content = await adapter.read(path);
			this.savedHighlights = parseSavedHighlights(content);
		} catch (err) {
			console.error("[ThirdMindReader] loadSavedHighlights failed", err);
		} finally {
			// Companion-doc existence is now resolved for this book — sync the
			// note button (it may not exist yet for a never-annotated book).
			this.updateCompanionDocButton();
		}
	}

	// ─── REGION: Highlights & Annotations ───────────────────────────────────
	/** Paint all saved highlights that land inside the currently-mounted unit.
	 *  Called after every mount (DOM gets wiped by `contentNode.empty()`, so we
	 *  rebuild the overlay from scratch) and after a successful persist. */
	private renderSavedHighlights(): void {
		// Runs on every unit mount + after each annotation submit, so it's the
		// natural place to refresh the note button once the first save creates
		// the companion doc.
		this.updateCompanionDocButton();
		if (!this.contentNode) return;
		this.contentNode.querySelectorAll(".tmr-saved-highlight-overlay").forEach((n) => n.remove());
		if (this.savedHighlights.length === 0) return;

		const overlay = document.createElement("div");
		overlay.className = "tmr-saved-highlight-overlay";
		const contentRect = this.contentNode.getBoundingClientRect();

		for (let idx = 0; idx < this.savedHighlights.length; idx++) {
			const saved = this.savedHighlights[idx];
			// Resolve paraId via prefix — recovers from paragraph-index drift
			// if the source epub's paragraph count shifts (split/merge). Falls
			// back to the hint when no prefix is stored (legacy anchors).
			const resolvedId = saved.prefix
				? this.offsetMap.findParaIdByPrefix(saved.prefix, saved.paraIdHint)
				: saved.paraIdHint;
			if (!resolvedId) continue;
			const entry = this.offsetMap.get(resolvedId);
			// Only render if the paragraph lives in the *current* unit's DOM —
			// prepareUnit populates paraIds for adjacent units too, so presence in
			// the offsetMap alone doesn't mean the paragraph is on screen.
			if (!entry || !this.contentNode.contains(entry.element)) continue;

			// For cross-paragraph highlights, verify the end paragraph is also in
			// this unit's DOM. If not (cross-unit selection), skip rendering.
			const endParaId = saved.endParaIdHint;
			if (endParaId && endParaId !== resolvedId) {
				const endEntry = this.offsetMap.get(endParaId);
				if (!endEntry || !this.contentNode.contains(endEntry.element)) continue;
			}

			let cursorRange: CursorRange | null = null;
			if (saved.startChar >= 0 && saved.endChar >= 0) {
				cursorRange = this.offsetMap.charRangeToCursorRange(
					resolvedId, saved.startChar, saved.endChar, endParaId);
			} else if (saved.legacyCursors) {
				cursorRange = { paraId: resolvedId, ...saved.legacyCursors };
			}
			if (!cursorRange) continue;

			for (const range of this.offsetMap.cursorsToRanges(cursorRange)) {
				for (const r of Array.from(range.getClientRects())) {
					if (r.width === 0 || r.height === 0) continue;
					const rectEl = document.createElement("div");
					rectEl.className = "tmr-saved-highlight-rect";
					if (idx === this.activeConversationIdx) {
						rectEl.classList.add("tmr-saved-highlight-rect-active");
					}
					rectEl.dataset.mode = saved.mode;
					rectEl.dataset.highlightIdx = String(idx);
					rectEl.style.left = `${r.left - contentRect.left}px`;
					rectEl.style.top = `${r.top - contentRect.top}px`;
					rectEl.style.width = `${r.width}px`;
					rectEl.style.height = `${r.height}px`;
					overlay.appendChild(rectEl);
				}
			}
		}
		this.contentNode.appendChild(overlay);
	}

	/** Hit-test the pointer against rendered highlight rects. On enter, surface
	 *  a body-scoped preview with the annotation's user text; on exit, hide it.
	 *  Tracks `hoveredHighlightIdx` so we don't thrash the DOM as the pointer
	 *  moves across rects belonging to the same highlight. */
	private handleAnnotationHover(e: MouseEvent): void {
		if (!this.contentNode || this.savedHighlights.length === 0) {
			if (this.hoveredHighlightIdx !== -1) this.hideAnnotationPreview();
			return;
		}
		const overlay = this.contentNode.querySelector(".tmr-saved-highlight-overlay");
		if (!overlay) {
			if (this.hoveredHighlightIdx !== -1) this.hideAnnotationPreview();
			return;
		}

		const rects = overlay.querySelectorAll<HTMLElement>(".tmr-saved-highlight-rect");
		let matchedIdx = -1;
		for (const rectEl of Array.from(rects)) {
			const r = rectEl.getBoundingClientRect();
			if (e.clientX >= r.left && e.clientX <= r.right &&
				e.clientY >= r.top  && e.clientY <= r.bottom) {
				matchedIdx = parseInt(rectEl.dataset.highlightIdx ?? "-1", 10);
				break;
			}
		}

		if (matchedIdx === -1) {
			if (this.hoveredHighlightIdx !== -1) this.hideAnnotationPreview();
			return;
		}

		const saved = this.savedHighlights[matchedIdx];
		if (!saved) return;

		if (matchedIdx !== this.hoveredHighlightIdx) {
			this.hoveredHighlightIdx = matchedIdx;
			this.populateAnnotationPreview(saved);
		}
		this.positionAnnotationPreview(e.clientX, e.clientY);
	}

	/** Hit-test the click against rendered highlight rects. If the pointer
	 *  lands on a rect for an AI-bearing highlight, open the Conversations
	 *  tab and expand its card; returns true so the caller can stop other
	 *  handlers (anchor navigation etc.) from firing. Non-AI highlights and
	 *  empty hits return false. */
	private handleHighlightClick(e: MouseEvent): boolean {
		if (!this.contentNode || this.savedHighlights.length === 0) return false;
		const overlay = this.contentNode.querySelector(".tmr-saved-highlight-overlay");
		if (!overlay) return false;

		const rects = overlay.querySelectorAll<HTMLElement>(".tmr-saved-highlight-rect");
		let matchedIdx = -1;
		for (const rectEl of Array.from(rects)) {
			const r = rectEl.getBoundingClientRect();
			if (e.clientX >= r.left && e.clientX <= r.right &&
				e.clientY >= r.top  && e.clientY <= r.bottom) {
				matchedIdx = parseInt(rectEl.dataset.highlightIdx ?? "-1", 10);
				break;
			}
		}
		if (matchedIdx === -1) return false;

		const saved = this.savedHighlights[matchedIdx];
		if (!saved || !GLOSS_AI_MODES_ALL.has(saved.mode)) return false;

		// Bare-flagged callouts (Exclaim/Enquiry with no prompt and no AI
		// turn) only show in the Conversations list when the corresponding
		// quick-settings toggle is on. Without it, expanding the card would
		// not be visible — so respect that and bail.
		if (
			this.isBareFlaggedConversation(saved) &&
			!this.plugin.settings.showBareFlaggedConversations
		) {
			return false;
		}

		if (!this.highlightsOpen) this.toggleHighlightsPanel();
		this.setPaneTab("conversations");
		this.openConversationByIdx(matchedIdx);
		return true;
	}

	private ensureAnnotationPreview(): HTMLElement {
		if (this.annotationPreviewEl) return this.annotationPreviewEl;
		const el = document.body.createEl("div", {
			cls: "tmr-annotation-preview tmr-hidden",
		});
		this.annotationPreviewEl = el;
		this.syncAnnotationPreviewTheme();
		return el;
	}

	private populateAnnotationPreview(saved: SavedHighlight): void {
		const el = this.ensureAnnotationPreview();
		el.empty();
		el.dataset.glossMode = saved.mode;
		el.createEl("div", { cls: "tmr-annotation-preview-mode",
			text: saved.mode[0].toUpperCase() + saved.mode.slice(1) });

		const CHARS = ReaderView.TOOLTIP_MAX_CHARS;
		let body: string;
		const isComplete = saved.aiState === "complete";

		if ((saved.mode === "exclaim" || saved.mode === "enquiry") && isComplete && saved.turns.length > 0) {
			// Conversation view: interleave You/AI turns until the char budget runs out.
			const parts: string[] = [];
			let used = 0;
			for (const turn of saved.turns) {
				const prefix = turn.role === "user" ? "You: " : "AI: ";
				const content = turn.content
					.replace(/\[\^[^\]]+\]:.*$/gm, "")
					.replace(/\[\^[^\]]+\]/g, "")
					.trim();
				const sep = parts.length > 0 ? 2 : 0; // "\n\n" between turns
				const available = CHARS - used - sep;
				if (available <= 15) break;
				if (prefix.length + content.length <= available) {
					parts.push(prefix + content);
					used += sep + prefix.length + content.length;
				} else {
					parts.push((prefix + content.slice(0, available - prefix.length)).trimEnd() + "…");
					break;
				}
			}
			body = parts.join("\n\n");
		} else if (saved.mode === "explain" && isComplete) {
			// Explain: show the first AI response only.
			const first = saved.turns.find((t) => t.role === "assistant");
			body = first
				? first.content.replace(/\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim()
				: "";
			if (body.length > CHARS) body = body.slice(0, CHARS).trimEnd() + "…";
		} else {
			// Examine, Emphasise, or any mode with a pending/error AI state: show the user's note.
			body = saved.userText.trim();
		}

		if (body.length > 0) {
			const bodyEl = el.createEl("div", { cls: "tmr-annotation-preview-body" });
			setInlineMarkdown(bodyEl, body);
		} else {
			const emptyText = GLOSS_AI_MODES.has(saved.mode) && isComplete
				? "(no response)"
				: "No note yet — add one from the Highlights panel";
			el.createEl("div", { cls: "tmr-annotation-preview-body tmr-annotation-preview-empty", text: emptyText });
		}

		el.removeClass("tmr-hidden");
	}

	private positionAnnotationPreview(clientX: number, clientY: number): void {
		const el = this.annotationPreviewEl;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const margin = 12;
		let x = clientX + 16;
		let y = clientY + 18;
		if (x + rect.width + margin > window.innerWidth) x = clientX - rect.width - 16;
		if (y + rect.height + margin > window.innerHeight) y = clientY - rect.height - 18;
		el.style.left = `${Math.max(margin, x)}px`;
		el.style.top  = `${Math.max(margin, y)}px`;
	}

	private hideAnnotationPreview(): void {
		this.hoveredHighlightIdx = -1;
		this.annotationPreviewEl?.addClass("tmr-hidden");
	}

	private syncAnnotationPreviewTheme(): void {
		const el = this.annotationPreviewEl;
		if (!el) return;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			el.addClass("tmr-3c-mode");
			el.setAttribute("data-tmr-theme", tmrTheme);
		} else {
			el.removeClass("tmr-3c-mode");
			el.removeAttribute("data-tmr-theme");
		}
	}

	private getCompanionDocPath(): string | null {
		if (!this.book && !this.currentFile) return null;
		const raw = this.book?.title || this.currentFile?.basename || "Book";
		const safe = raw.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "Book";
		return `Library/Annotations/${safe}-Annotations.md`;
	}

	private async ensureCompanionDoc(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(path)) return;
		const folder = path.substring(0, path.lastIndexOf("/"));
		if (folder && !(await adapter.exists(folder))) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				// Folder may have been created in a parallel call — re-check below.
			}
		}
		const title = this.book?.title ?? this.currentFile?.basename ?? "Book";
		const sourceLink = this.currentFile ? `[[${this.currentFile.path}]]` : "";
		const frontmatter = [
			"---",
			`title: "${title.replace(/"/g, '\\"')}"`,
			`source: ${sourceLink}`,
			"tags: [annotations, third-mind-reader]",
			`created: ${new Date().toISOString()}`,
			"---",
			"",
			`# ${title} — Annotations`,
			"",
		].join("\n");
		await adapter.write(path, frontmatter);
	}

	private buildCallout(
		modeId: string,
		userText: string,
		quote: string,
		highlight: CursorRange,
	): string {
		const match = /^s(\d+)-p(\d+)$/.exec(highlight.paraId);
		const spineIdx = match ? parseInt(match[1], 10) : 0;
		const paraIdx = match ? parseInt(match[2], 10) : 0;
		const sectionIdx = this.sectionIndexBySpine[spineIdx] ?? 0;
		const sectionLabel = this.sections[sectionIdx]?.label ?? "";

		const snippet = quote.replace(/\s+/g, " ").trim();
		const snippetShort = snippet.length > 48 ? snippet.slice(0, 48).trim() + "…" : snippet;
		const header = [snippetShort, sectionLabel, `¶${paraIdx}`].filter(Boolean).join(" · ");

		// CFI-style anchor: absolute char offsets within the paragraph's text
		// (segment-agnostic) + a URL-encoded text prefix for drift recovery.
		// Legacy cursor fields dropped — parser still handles old format.
		const chars = this.offsetMap.cursorRangeToChars(highlight);
		const entry = this.offsetMap.get(highlight.paraId);
		const prefixRaw = entry ? entry.text.replace(/\s+/g, " ").trim().slice(0, ANCHOR_PREFIX_LEN) : "";
		const prefix = encodeURIComponent(prefixRaw);
		let anchor: string;
		if (!chars) {
			anchor = `<!-- tmr-anchor spine:${spineIdx} para:${highlight.paraId} prefix:"${prefix}" -->`;
		} else if (highlight.endParaId) {
			// Cross-paragraph: endChars holds the end offset within endParaId.
			// chars:S,-1 is a sentinel so old plugin versions skip this anchor cleanly.
			anchor =
				`<!-- tmr-anchor spine:${spineIdx} para:${highlight.paraId} ` +
				`chars:${chars.startChar},-1 endPara:"${highlight.endParaId}" ` +
				`endChars:${chars.endChar} prefix:"${prefix}" -->`;
		} else {
			anchor =
				`<!-- tmr-anchor spine:${spineIdx} para:${highlight.paraId} ` +
				`chars:${chars.startChar},${chars.endChar} prefix:"${prefix}" -->`;
		}

		const lines: string[] = [];
		lines.push(`> [!${modeId}]- ${header}`);
		lines.push(`> ${anchor}`);
		if (quote.length > 0) {
			for (const ql of quote.split(/\r?\n/)) lines.push(`> > ${ql}`);
		}
		if (userText.length > 0) {
			lines.push(">");
			for (const ul of userText.split(/\r?\n/)) lines.push(`> ${ul}`);
		}
		if (GLOSS_AI_MODES.has(modeId)) {
			lines.push(">");
			lines.push("> <!-- ai response pending -->");
		}
		return lines.join("\n");
	}

	private renderHighlightOverlay(cursorRange: CursorRange): void {
		if (!this.contentNode) return;
		const ranges = this.offsetMap.cursorsToRanges(cursorRange);
		if (ranges.length === 0) return;

		const overlay = document.createElement("div");
		overlay.className = "tmr-highlight-overlay";
		const contentRect = this.contentNode.getBoundingClientRect();
		for (const range of ranges) {
			for (const r of Array.from(range.getClientRects())) {
				if (r.width === 0 || r.height === 0) continue;
				const rectEl = document.createElement("div");
				rectEl.className = "tmr-highlight-rect";
				rectEl.style.left = `${r.left - contentRect.left}px`;
				rectEl.style.top = `${r.top - contentRect.top}px`;
				rectEl.style.width = `${r.width}px`;
				rectEl.style.height = `${r.height}px`;
				overlay.appendChild(rectEl);
			}
		}
		this.contentNode.appendChild(overlay);
		this.highlightOverlayEl = overlay;
	}

	private clearHighlightOverlay(): void {
		this.highlightOverlayEl?.remove();
		this.highlightOverlayEl = null;
		this.activeHighlight = null;
	}

	private dismissGloss(): void {
		this.glossBarEl?.addClass("tmr-hidden");
		this.glossInputEl?.addClass("tmr-hidden");
		this.activeGlossMode = null;
		this.activeSelectionText = null;
		this.activeSelectionRect = null;
		// Tear down any armed extend (Escape-cancel, outside-click, or a unit
		// boundary all route here).
		this.isExtending = false;
		this.extendAnchor = null;
		this.hideExtendHint();
		this.clearHighlightOverlay();
		window.getSelection()?.removeAllRanges();
	}

	// ── Footnote / cross-reference tooltip ─────────────────────────────────────

	private ensureTooltipNode(): HTMLElement {
		if (this.tooltipEl) return this.tooltipEl;
		const el = document.body.createEl("div", { cls: "tmr-tooltip tmr-hidden" });
		this.tooltipEl = el;
		const { tmrMode, tmrTheme } = this.plugin.settings;
		if (tmrMode === "3c") {
			el.addClass("tmr-3c-mode");
			el.setAttribute("data-tmr-theme", tmrTheme);
		}
		return el;
	}

	private showTooltip(target: Element, e: MouseEvent): void {
		// Calibre-style epubs use empty <a id="..."> bookmarks before content — step forward
		let el: Element = target;
		if (!el.textContent?.trim()) {
			let sib = el.nextElementSibling;
			while (sib && !sib.textContent?.trim()) sib = sib.nextElementSibling;
			if (sib) el = sib;
		}
		const img = el.querySelector("img");
		if (img) {
			const caption = el.querySelector("figcaption, .caption, p");
			this.renderTooltip(
				{
					kind: "image",
					imageSrc: img.getAttribute("src") ?? undefined,
					caption: caption?.textContent?.trim() || undefined,
				},
				e,
			);
		} else {
			const text = (el.textContent ?? "").trim().replace(/^\d+[\.\)]\s*/, "");
			if (!text) return;
			this.renderTooltip(this.buildInlineTextPreview(text), e);
		}
	}

	private showTooltipPreview(preview: EpubLinkPreview, e: MouseEvent): void {
		this.renderTooltip(preview, e);
	}

	private renderTooltip(preview: EpubLinkPreview, e: MouseEvent): void {
		const tooltip = this.ensureTooltipNode();
		tooltip.empty();
		if (preview.kind === "image" && preview.imageSrc) {
			const img = createEl("img") as HTMLImageElement;
			img.src = preview.imageSrc;
			img.style.cssText = "max-width:280px;height:auto;display:block;border-radius:4px;";
			tooltip.appendChild(img);
			if (preview.caption?.trim()) {
				tooltip.createEl("p", { cls: "tmr-tooltip-caption", text: preview.caption.trim() });
			}
		} else {
			tooltip.createEl("p", {
				cls: "tmr-tooltip-text",
				text: (preview.text ?? "").trim(),
			});
		}

		tooltip.style.left = "0px";
		tooltip.style.top = "0px";
		tooltip.style.visibility = "hidden";
		tooltip.removeClass("tmr-hidden");

		const rect = tooltip.getBoundingClientRect();
		const maxLeft = Math.max(ReaderView.TOOLTIP_MARGIN, window.innerWidth - rect.width - ReaderView.TOOLTIP_MARGIN);
		const x = Math.max(
			ReaderView.TOOLTIP_MARGIN,
			Math.min(e.clientX + ReaderView.TOOLTIP_OFFSET_X, maxLeft),
		);
		const preferredBelow = e.clientY + ReaderView.TOOLTIP_OFFSET_Y;
		const preferredAbove = e.clientY - rect.height - 12;
		const y = preferredBelow + rect.height <= window.innerHeight - ReaderView.TOOLTIP_MARGIN
			? preferredBelow
			: Math.max(
				ReaderView.TOOLTIP_MARGIN,
				Math.min(preferredAbove, window.innerHeight - rect.height - ReaderView.TOOLTIP_MARGIN),
			);
		tooltip.style.left = `${x}px`;
		tooltip.style.top = `${y}px`;
		tooltip.style.visibility = "";
	}

	private hideTooltip(): void {
		if (!this.tooltipEl) return;
		this.tooltipEl.style.visibility = "";
		this.tooltipEl.addClass("tmr-hidden");
	}

	private buildInlineTextPreview(text: string): EpubLinkPreview {
		const trimmed = text.trim();
		if (trimmed.length <= ReaderView.TOOLTIP_MAX_CHARS) {
			return { kind: "text", text: trimmed };
		}
		return {
			kind: "text",
			text: trimmed.slice(0, ReaderView.TOOLTIP_MAX_CHARS).trimEnd() + "…",
			truncated: true,
		};
	}

	// ─── REGION: Progress & Position ─────────────────────────────────────────
	private buildProgressSegments(): void {
		if (!this.progressBarEl) return;
		this.progressBarEl.querySelectorAll(".tmr-progress-segment").forEach((el) => el.remove());
		const backBtn = this.progressBarEl.querySelector(".tmr-progress-back");
		for (let i = 0; i < this.sections.length; i++) {
			const seg = createEl("div", { cls: "tmr-progress-segment" });
			seg.dataset.section = String(i);
			seg.dataset.label = this.sections[i].label;
			seg.style.flexGrow = String(this.sectionSpreadCounts[i] ?? 1);
			seg.createEl("div", { cls: "tmr-progress-segment-fill" });
			this.progressBarEl.insertBefore(seg, backBtn);
		}
	}

	private updateProgress(): void {
		if (!this.book) return;
		const globalSpread = this.getGlobalSpread();
		const total = Math.max(1, this.totalSpreads);
		if (this.globalPageEl) this.globalPageEl.setText(`${globalSpread + 1} of ${total}`);

		const currentSectionIdx = this.getCurrentSectionIndex();
		const sectionStart = this.sectionStartSpreads[currentSectionIdx] ?? 0;
		const sectionCount = this.sectionSpreadCounts[currentSectionIdx] ?? 1;
		const localSpread = globalSpread - sectionStart;
		const localPage = Math.max(1, localSpread + 1);
		if (this.localPageEl) {
			this.localPageEl.setText(`${localPage} / ${sectionCount}`);
			this.localPageEl.toggleClass("tmr-page-info-max", localPage === sectionCount);
		}

		this.contentEl.querySelectorAll(".tmr-progress-segment").forEach((seg) => {
			const sectionIdx = parseInt((seg as HTMLElement).dataset.section ?? "0", 10);
			const fill = seg.querySelector(".tmr-progress-segment-fill") as HTMLElement | null;
			if (!fill) return;
			const start = this.sectionStartSpreads[sectionIdx] ?? 0;
			const count = this.sectionSpreadCounts[sectionIdx] ?? 1;
			const end = start + count - 1;
			if (globalSpread > end) {
				fill.style.width = "100%";
				seg.addClass("tmr-progress-complete");
				seg.removeClass("tmr-progress-current");
			} else if (globalSpread >= start) {
				const local = globalSpread - start;
				fill.style.width = `${((local + 1) / count) * 100}%`;
				seg.removeClass("tmr-progress-complete");
				seg.addClass("tmr-progress-current");
			} else {
				fill.style.width = "0%";
				seg.removeClass("tmr-progress-complete");
				seg.removeClass("tmr-progress-current");
			}
		});
		this.updateBackMarker();
	}

	private onProgressMouseDown(e: MouseEvent): void {
		if ((e.target as Element).closest(".tmr-progress-back, .tmr-progress-back-marker")) return;
		if (!this.book) return;
		this.isDraggingProgress = true;
		void this.seekToProgressPosition(e);
	}

	private onProgressMouseMove(e: MouseEvent): void {
		this.pendingProgressMouseEvent = e;
		if (this.progressTooltipRaf !== null) return;
		this.progressTooltipRaf = requestAnimationFrame(() => {
			this.progressTooltipRaf = null;
			const ev = this.pendingProgressMouseEvent;
			this.pendingProgressMouseEvent = null;
			if (!ev) return;
			this.showProgressTooltip(ev);
			if (this.isDraggingProgress) void this.seekToProgressPosition(ev);
		});
	}

	private showProgressTooltip(e: MouseEvent): void {
		if (!this.progressBarEl || !this.progressTipEl) return;
		const seg = (e.target as Element).closest(".tmr-progress-segment") as HTMLElement | null;
		if (!seg) {
			this.progressTipEl.addClass("tmr-hidden");
			return;
		}
		const label = seg.dataset.label ?? "";
		if (!label) {
			this.progressTipEl.addClass("tmr-hidden");
			return;
		}
		this.progressTipEl.setText(label);
		this.progressTipEl.removeClass("tmr-hidden");
		const barRect = this.progressBarEl.getBoundingClientRect();
		const x = e.clientX - barRect.left;
		const tipWidth = this.progressTipEl.offsetWidth;
		this.progressTipEl.style.left = `${Math.max(0, Math.min(x - tipWidth / 2, barRect.width - tipWidth))}px`;
	}

	private async seekToProgressPosition(e: MouseEvent): Promise<void> {
		if (!this.progressBarEl || !this.book) return;
		const seg = (e.target as Element).closest(".tmr-progress-segment") as HTMLElement | null;
		const barRect = this.progressBarEl.getBoundingClientRect();
		let targetSectionIdx = 0;
		let sectionFraction = 0;

		if (seg) {
			targetSectionIdx = parseInt(seg.dataset.section ?? "0", 10);
			const segRect = seg.getBoundingClientRect();
			sectionFraction = Math.max(0, Math.min(1, (e.clientX - segRect.left) / Math.max(1, segRect.width)));
		} else {
			const fraction = Math.max(0, Math.min(1, (e.clientX - barRect.left) / Math.max(1, barRect.width)));
			const scaled = fraction * this.sections.length;
			targetSectionIdx = Math.min(Math.floor(scaled), this.sections.length - 1);
			sectionFraction = Math.max(0, Math.min(1, scaled - targetSectionIdx));
		}

		const section = this.sections[targetSectionIdx];
		if (!section) return;
		const unitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const sectionCount = this.sectionSpreadCounts[targetSectionIdx] ?? 1;
		const offsetInSection = Math.min(Math.floor(sectionFraction * sectionCount), sectionCount - 1);
		const offsetInUnit = this.getSpreadOffsetInUnitBySectionId(this.units[unitIdx], section.id);
		const targetSpread = Math.max(0, Math.min(offsetInUnit + offsetInSection, (this.units[unitIdx]?.spreadCount ?? 1) - 1));
		await this.mountCurrentUnit(unitIdx, targetSpread);
	}

	private savePosition(): void {
		this.previousPosition = { unitIndex: this.currentUnitIndex, spread: this.currentSpread };
		// A fresh jump supersedes any prior anchor: re-arm the pill at the new
		// return point and restart the commit count.
		this.backForwardTurns = 0;
		this.backPillDismissed = false;
		this.backPillHovering = false;
	}

	/** Current reading fraction (0..1) from the global spread index, for the
	 *  Library card progress bar. A single-spread book reports 1 (fully visible);
	 *  0 means the first spread of a multi-spread book, which the Library labels
	 *  "Unread". */
	private getProgressFraction(): number {
		if (this.totalSpreads <= 1) return 1;
		return Math.max(0, Math.min(1, this.getGlobalSpread() / (this.totalSpreads - 1)));
	}

	/** Persist the live reading position for `path`, merging onto any existing
	 *  entry so sibling fields (the right-rail `pane` choice) survive — the old
	 *  bare-object assignment silently dropped them. Caches `pct` for the Library. */
	private writeBookPosition(path: string): void {
		const existing = this.plugin.settings.bookPositions[path] ?? {};
		const pct = this.getProgressFraction();
		this.plugin.settings.bookPositions[path] = {
			...existing,
			unitIndex: this.currentUnitIndex,
			spread: this.currentSpread,
			pct,
		};
		// Position lives in data.json, not a vault file, so no vault event fires —
		// poke any open Library so its card ticks live as the reader advances.
		this.plugin.updateLibraryProgress(path, pct);
	}

	private schedulePositionSave(): void {
		const path = this.currentFile?.path ?? this.currentFolder?.path;
		if (!path) return;
		if (this.positionSaveTimer !== null) window.clearTimeout(this.positionSaveTimer);
		this.positionSaveTimer = window.setTimeout(() => {
			this.positionSaveTimer = null;
			this.writeBookPosition(path);
			void this.plugin.persistSettings();
		}, 800);
	}

	private async goBack(): Promise<void> {
		if (!this.previousPosition) return;
		const pos = this.previousPosition;
		this.previousPosition = null;
		this.backForwardTurns = 0;
		this.backPillDismissed = false;
		this.backPillHovering = false;
		await this.mountCurrentUnit(pos.unitIndex, pos.spread);
	}

	private updateBackMarker(): void {
		const backBtn = this.contentEl.querySelector(".tmr-progress-back") as HTMLElement | null;
		const marker = this.contentEl.querySelector(".tmr-progress-back-marker") as HTMLElement | null;
		if (!backBtn) return;
		if (!this.previousPosition || !this.progressBarEl) {
			backBtn.addClass("tmr-hidden");
			marker?.addClass("tmr-hidden");
			return;
		}
		const prevUnit = this.units[this.previousPosition.unitIndex];
		if (!prevUnit) {
			backBtn.addClass("tmr-hidden");
			marker?.addClass("tmr-hidden");
			return;
		}
		// The dot rides the bar for the anchor's whole life. The pill is the
		// obtrusive part: it shows while uncommitted, decays (fades out via the
		// dismissed class — not display:none, so it animates) once committed, and
		// is transiently re-summoned while the dot is hovered.
		marker?.removeClass("tmr-hidden");
		backBtn.removeClass("tmr-hidden");
		backBtn.toggleClass("tmr-progress-back-dismissed", this.backPillDismissed && !this.backPillHovering);

		// Coordinate system match the fill bar: each section is a flex segment
		// with equal visual width, so compute x from the segment's actual
		// offsetLeft + a local fraction within it. Falls back to linear spread
		// ratio if segments are not yet laid out.
		const prevGlobalSpread = (this.unitStartSpreads[this.previousPosition.unitIndex] ?? 0) + this.previousPosition.spread;
		const barWidth = this.progressBarEl.clientWidth;
		let x = 0;
		const sectionIdx = this.sectionStartSpreads.findIndex((start, i) => {
			const count = this.sectionSpreadCounts[i] ?? 1;
			return prevGlobalSpread >= start && prevGlobalSpread < start + count;
		});
		const segEl = sectionIdx >= 0
			? this.progressBarEl.querySelector(`.tmr-progress-segment[data-section="${sectionIdx}"]`) as HTMLElement | null
			: null;
		if (segEl && sectionIdx >= 0) {
			const start = this.sectionStartSpreads[sectionIdx] ?? 0;
			const count = Math.max(1, this.sectionSpreadCounts[sectionIdx] ?? 1);
			const localFraction = Math.max(0, Math.min(1, (prevGlobalSpread - start + 0.5) / count));
			x = segEl.offsetLeft + segEl.offsetWidth * localFraction;
		} else {
			const ratio = this.totalSpreads <= 1 ? 0 : prevGlobalSpread / (this.totalSpreads - 1);
			x = ratio * barWidth;
		}

		// Marker dot sits on the bar at the exact return point.
		if (marker) marker.style.left = `${x}px`;

		// Clamp the pill so it never hangs off the bar edges. The marker dot
		// on the bar still sits at the true return point, making the spatial
		// link legible even near the extremes.
		const btnWidth = backBtn.offsetWidth || 60;
		const half = btnWidth / 2;
		const clampedX = Math.max(half, Math.min(barWidth - half, x));
		backBtn.style.left = `${clampedX}px`;
	}

	private showSpread(): void {
		this.contentEl.querySelector(".tmr-loading")?.remove();
		this.spreadEl?.removeClass("tmr-hidden");
	}

	private showError(msg: string): void {
		const loading = this.contentEl.querySelector(".tmr-loading");
		if (loading) {
			loading.setText(msg);
			loading.addClass("tmr-error");
		}
	}
}

// ─── REGION: ThirdMindReader Plugin ──────────────────────────────────────────
export default class ThirdMindReader extends Plugin {
	_openingEpub = false;
	settings: ThirdMindReaderSettings = { ...DEFAULT_SETTINGS };
	/** Debounce timer collapsing a burst of vault events (e.g. a folder move) into
	 *  a single Library re-scan. */
	private _libraryRefreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.injectFonts();
		this.registerView(READER_VIEW_TYPE, (leaf) => new ReaderView(leaf, this));
		this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new LibraryView(leaf, this));
		this.registerExtensions(["epub"], READER_VIEW_TYPE);
		this.addSettingTab(new TmrSettingTab(this.app, this));
		this.addRibbonIcon("library", "Open Library", () => this.activateLibraryView());
		this.addReaderCommands();

		// Make sure the Library folder exists so the empty-state prompt ("drop
		// .epub files into your Library folder") points somewhere real on a fresh
		// install. Non-blocking — failure just falls back to lazy creation.
		void this.ensureLibraryFolder();

		// Intercept epub clicks in the file explorer so they always open in a
		// new tab instead of replacing the active leaf (mirrors Cmd+Click).
		// Runs in capture phase so it fires before Obsidian's own click handler.
		this.registerDomEvent(document, "click", (e: MouseEvent) => {
			if (e.button !== 0) return;
			const fileTitle = (e.target as Element).closest(".nav-file-title") as HTMLElement | null;
			if (!fileTitle) return;
			const path =
				fileTitle.dataset.path ??
				(fileTitle.closest(".nav-file") as HTMLElement | null)?.dataset.path;
			if (!path?.endsWith(".epub")) return;
			e.stopImmediatePropagation();
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) void this.openEpubInNewTab(file.path);
		}, { capture: true });

		this.registerVaultEvents();
	}

	/** Create the `Library/` root on load if it's missing, so a fresh install
	 *  has the folder the empty-state prompt tells users to drop epubs into.
	 *  Idempotent and tolerant of a parallel creation race. */
	private async ensureLibraryFolder(): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (await adapter.exists(LIBRARY_ROOT)) return;
		try {
			await this.app.vault.createFolder(LIBRARY_ROOT);
		} catch {
			// Already created (race or pre-existing) — nothing to do.
		}
	}

	/** Live Library upkeep. Keeps reading position (and the display override)
	 *  attached to a book as it moves between collections (bug B4), keeps the
	 *  metadata/marks caches honest, and refreshes any open Library view when its
	 *  `Library/` contents change — no manual reload needed. */
	private registerVaultEvents(): void {
		const inLibrary = (p: string) => p === LIBRARY_ROOT || p.startsWith(LIBRARY_ROOT + "/");

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const newPath = file.path;
				let changed = false;
				// The one move-survival casualty: reading position is path-keyed.
				if (this.settings.bookPositions[oldPath]) {
					this.settings.bookPositions[newPath] = this.settings.bookPositions[oldPath];
					delete this.settings.bookPositions[oldPath];
					changed = true;
				}
				// The display override is path-keyed too — carry it along.
				if (this.settings.libraryOverrides[oldPath]) {
					this.settings.libraryOverrides[newPath] = this.settings.libraryOverrides[oldPath];
					delete this.settings.libraryOverrides[oldPath];
					changed = true;
				}
				if (changed) void this.persistSettings();
				invalidateMetaCache(oldPath);
				invalidateMetaCache(newPath);
				if (inLibrary(oldPath) || inLibrary(newPath)) this.refreshLibraryViews();
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (inLibrary(file.path)) this.refreshLibraryViews();
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				invalidateMetaCache(file.path);
				if (inLibrary(file.path)) this.refreshLibraryViews();
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				// A companion-doc edit changes a book's mark count; an epub re-save
				// changes its metadata. Both live under Library/ and want a refresh.
				if (!inLibrary(file.path)) return;
				invalidateMetaCache(file.path);
				this.refreshLibraryViews();
			})
		);
	}

	/** Re-scan + repaint every open Library view, debounced so a burst of vault
	 *  events (a folder move emits many) collapses into a single refresh. */
	private refreshLibraryViews(): void {
		if (this._libraryRefreshTimer !== null) window.clearTimeout(this._libraryRefreshTimer);
		this._libraryRefreshTimer = window.setTimeout(() => {
			this._libraryRefreshTimer = null;
			this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE).forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof LibraryView) void view.refresh();
			});
		}, 150);
	}

	/** Surgically update one book's progress on any open Library — fill bar +
	 *  label only, no re-scan/repaint — so it's cheap enough to call on every
	 *  reader position-save (gives a live tick when the Library shares a split). */
	updateLibraryProgress(path: string, pct: number): void {
		this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof LibraryView) view.updateBookProgress(path, pct);
		});
	}

	onunload(): void {
		document.getElementById("tmr-bundled-fonts")?.remove();
		this.app.workspace.detachLeavesOfType(READER_VIEW_TYPE);
		this.app.workspace.detachLeavesOfType(LIBRARY_VIEW_TYPE);
	}

	/** The reader view of the currently-active leaf, or null. Reader commands
	 *  gate on this so their hotkeys only act while a book is in focus (and fall
	 *  through to other handlers otherwise). */
	private activeReaderView(): ReaderView | null {
		return this.app.workspace.getActiveViewOfType(ReaderView);
	}

	/** Register reader actions as commands. ONLY modifier-combo / no-default
	 *  hotkeys live here — Obsidian command hotkeys are global, and a bare key
	 *  (t / h / 1–5 / ← / →) would steal the keystroke from the editor app-wide.
	 *  Those bare keys are handled instead by a view-scoped keydown listener in
	 *  `ReaderView.onOpen`, so they only act while the reader is the active leaf.
	 *  Each command gates on `activeReaderView()` via `checkCallback` so it does
	 *  nothing from another pane; users can rebind any of these in Settings →
	 *  Hotkeys. */
	private addReaderCommands(): void {
		this.addCommand({
			id: "open-library",
			name: "Open Library",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "l" }],
			callback: () => this.activateLibraryView(),
		});
		this.addCommand({
			id: "open-annotations",
			name: "Open annotation notes",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "a" }],
			checkCallback: (checking) => {
				const v = this.activeReaderView();
				if (!v) return false;
				if (!checking) void v.openCompanionDoc();
				return true;
			},
		});
		this.addCommand({
			// No default hotkey: 3C-mode toggling is the least-used reader action
			// and Shift+Mod+3 clashes with the macOS screenshot shortcut. Exposed
			// for users to bind to a combo of their choosing.
			id: "toggle-3c-mode",
			name: "Toggle 3C mode",
			checkCallback: (checking) => {
				const v = this.activeReaderView();
				if (!v) return false;
				if (!checking) void v.toggleTmrMode();
				return true;
			},
		});
	}

	private injectFonts(): void {
		document.getElementById("tmr-bundled-fonts")?.remove();
		const dir = this.manifest.dir!;
		const adapter = this.app.vault.adapter as any;
		const faces: { family: string; weight: string; style: string; file: string }[] = [
			{ family: "Rosarivo", weight: "400", style: "normal", file: "Rosarivo-Regular.ttf" },
			{ family: "Rosarivo", weight: "400", style: "italic", file: "Rosarivo-Italic.ttf" },
			{ family: "Labrada", weight: "100 900", style: "normal", file: "Labrada-VariableFont_wght.ttf" },
			{ family: "Labrada", weight: "100 900", style: "italic", file: "Labrada-Italic-VariableFont_wght.ttf" },
			{ family: "Kode Mono", weight: "400 700", style: "normal", file: "KodeMono-VariableFont_wght.ttf" },
		];
		const css = faces.map(({ family, weight, style, file }) => {
			const url = adapter.getResourcePath(`${dir}/fonts/${file}`);
			return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; src: url("${url}") format("truetype"); }`;
		}).join("\n");

		const el = document.createElement("style");
		el.id = "tmr-bundled-fonts";
		el.textContent = css;
		document.head.appendChild(el);
	}

	async openEpubInNewTab(filePath: string): Promise<void> {
		// Dedup: if this book is already open in a reader tab, reveal it rather than
		// spawning a duplicate (mirrors the companion-doc dedup, and makes Library
		// card clicks idempotent — bug B3). `getState().file` is the live path.
		const existing = this.app.workspace.getLeavesOfType(READER_VIEW_TYPE).find((leaf) => {
			const view = leaf.view;
			return view instanceof ReaderView && view.getState()?.file === filePath;
		});
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		this._openingEpub = true;
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			active: true,
			state: { file: filePath },
		});
		this.app.workspace.revealLeaf(leaf);
		this._openingEpub = false;
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		// Beta-only: re-show the Library feedback hint after every reload/update so
		// testers are reminded where to report. Reset in-memory on each load (no
		// persist needed); drop this line together with FEEDBACK_BETA for 1.0.
		this.settings.feedbackHintShown = false;
		// Fresh object with every mode filled — guards against a shared
		// reference to DEFAULT_SETTINGS and forward-compat for new modes.
		this.settings.systemPrompts = { ...DEFAULT_SYSTEM_PROMPTS, ...this.settings.systemPrompts };
		let needsPersist = this.migrateApiKeysToSecretStorage();
		// Migration: installs predating the AI master switch that already have a
		// provider configured come up with AI on, so they don't silently drop to
		// Lite (matches the "auto-on with provider" rule for new providers).
		if (data && data.aiFeaturesEnabled === undefined && this.settings.aiProviders.length > 0) {
			this.settings.aiFeaturesEnabled = true;
			needsPersist = true;
		}
		if (needsPersist) await this.persistSettings();
	}

	/** Move any legacy plaintext API keys out of data.json and into Obsidian's
	 *  encrypted secret storage, then resolve every provider's runtime
	 *  `apiKey` from storage. Returns true if a migration write occurred. */
	private migrateApiKeysToSecretStorage(): boolean {
		let migrated = false;
		for (const provider of this.settings.aiProviders) {
			if (provider.apiKey && !provider.apiKeyId) {
				const id = `tmr-apikey-${this.randomSecretId()}`;
				this.app.secretStorage.setSecret(id, provider.apiKey);
				provider.apiKeyId = id;
				migrated = true;
			}
			provider.apiKey = provider.apiKeyId
				? (this.app.secretStorage.getSecret(provider.apiKeyId) ?? undefined)
				: undefined;
		}
		return migrated;
	}

	private randomSecretId(): string {
		return (Math.random().toString(36) + Math.random().toString(36))
			.replace(/[^a-z0-9]/g, "")
			.slice(0, 16);
	}

	/** Write settings to disk with resolved API keys stripped — only the
	 *  `apiKeyId` reference is persisted, never the key itself. */
	persistSettings(): Promise<void> {
		const data: ThirdMindReaderSettings = {
			...this.settings,
			aiProviders: this.settings.aiProviders.map((p) => {
				const copy = { ...p };
				delete copy.apiKey;
				return copy;
			}),
		};
		return this.saveData(data);
	}

	async saveSettings(): Promise<void> {
		await this.persistSettings();
		this.app.workspace.getLeavesOfType(READER_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof ReaderView) { view.applyThemeClasses(); view.applyAiFeaturesState(); }
		});
		this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof LibraryView) view.applyThemeClasses();
		});
	}

	/** Open (or reveal) the Library home view. Replaces the old `activateView`,
	 *  which constructed a fileless ReaderView stuck on "Opening…" (bug B1).
	 *  Reuses an already-open Library leaf rather than spawning duplicates. */
	private async activateLibraryView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}
}

// ─── REGION: Settings Tab ────────────────────────────────────────────────────
/** Plugin settings tab. AI provider configuration only — theme/3C-mode
 *  toggles live in the ToC footer (per-leaf, immediate-effect surface).
 *
 *  Each provider is rendered as an inline editor with a "Test connection"
 *  button (calls `probeProvider()`) and a delete affordance. The default-
 *  model picker at the top selects which provider new conversations use.
 *
 *  Per-mode overrides land in Phase D when the GlossBar tile activations
 *  are wired to chat() — until then `aiDefaults.perMode` stays empty and
 *  every mode falls through to `primaryProviderId`. */
// ─── Beta feedback form ──────────────────────────────────────────────────────
// Opens an anonymous Google Form in the browser with the plugin/Obsidian/OS
// versions prefilled. Flip FEEDBACK_BETA to false (or delete the Setting block in
// display()) for the public 1.0 build.
const FEEDBACK_BETA = true;
const FEEDBACK_FORM_BASE =
	"https://docs.google.com/forms/d/e/1FAIpQLSeHKYS9X0lG4ty2ZiRTry5FDBl2GOCbeeBxBBsGbRKdHVBlRg/viewform";
const FEEDBACK_ENTRY = {
	pluginVersion: "entry.1098526630",
	obsidianVersion: "entry.855869142",
	os: "entry.1381515979",
};

function feedbackOsLabel(): string {
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	if (Platform.isIosApp) return "iOS";
	if (Platform.isAndroidApp) return "Android";
	return "Unknown";
}

/** Build the prefilled Google Form URL. OS comes from Obsidian's `Platform` (not
 *  `navigator`, which the ESLint plugin flags). Opened in the system browser. */
function buildFeedbackUrl(pluginVersion: string): string {
	const params = new URLSearchParams({ usp: "pp_url" });
	params.set(FEEDBACK_ENTRY.pluginVersion, pluginVersion);
	params.set(FEEDBACK_ENTRY.obsidianVersion, apiVersion);
	params.set(FEEDBACK_ENTRY.os, feedbackOsLabel());
	return `${FEEDBACK_FORM_BASE}?${params.toString()}`;
}

class TmrSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ThirdMindReader) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName("Third Mind Reader").setHeading();

		// ── Beta feedback (kept at the top so testers don't miss it) ──────
		if (FEEDBACK_BETA) {
			new Setting(containerEl)
				.setName("Beta feedback")
				.setDesc("Opens an anonymous feedback form in your browser, with your plugin version, Obsidian version, and OS filled in automatically.")
				.addButton(b => b
					.setButtonText("Send feedback")
					.setCta()
					.onClick(() => {
						window.open(buildFeedbackUrl(this.plugin.manifest.version), "_blank");
					}));
		}

		new Setting(containerEl)
			.setName("Enable AI features")
			.setDesc("Master switch for the AI Gloss modes (Explain/Examine/Exclaim/Enquiry) and the Conversations pane. When off, the reader runs Lite: the GlossBar shows only Emphasise and the Highlights pane drops its tab bar. Auto-enables when you add your first provider.")
			.addToggle(t => t
				.setValue(this.plugin.settings.aiFeaturesEnabled)
				.onChange(async (v) => {
					this.plugin.settings.aiFeaturesEnabled = v;
					await this.plugin.saveSettings();
				}));

		// ── Default model ────────────────────────────────────────────────
		new Setting(containerEl).setName("Default model").setHeading();
		new Setting(containerEl)
			.setName("Primary provider")
			.setDesc("Used for new AI conversations unless a per-mode override is set.")
			.addDropdown(dd => {
				dd.addOption("", "(none)");
				for (const p of this.plugin.settings.aiProviders) {
					dd.addOption(p.id, `${p.id} (${p.kind})`);
				}
				dd.setValue(this.plugin.settings.aiDefaults.primaryProviderId ?? "");
				dd.onChange(async (v) => {
					this.plugin.settings.aiDefaults.primaryProviderId = v || null;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Stream responses")
			.setDesc(
				"Show AI replies token-by-token as they generate, with a live "
				+ "\"Loading model…\" → \"Thinking…\" indicator. Applies to local "
				+ "providers (LM Studio, Ollama); cloud providers always buffer.")
			.addToggle(t => t
				.setValue(this.plugin.settings.streaming)
				.onChange(async (v) => {
					this.plugin.settings.streaming = v;
					await this.plugin.saveSettings();
				}));

		// ── Providers list ───────────────────────────────────────────────
		new Setting(containerEl).setName("AI providers").setHeading();
		if (this.plugin.settings.aiProviders.length === 0) {
			containerEl.createEl("div", {
				cls: "setting-item-description",
				text: "No providers configured. Add one below — local providers (LM Studio, Ollama) need only an endpoint URL; Anthropic and OpenAI need an API key.",
			});
		}
		for (let i = 0; i < this.plugin.settings.aiProviders.length; i++) {
			this.renderProviderEditor(containerEl, i);
		}

		// ── Add provider ────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Add provider")
			.setDesc("Cloud providers need an API key.")
			.addButton(b => b.setButtonText("+ Anthropic").onClick(() => this.addProvider("anthropic")))
			.addButton(b => b.setButtonText("+ OpenAI").onClick(() => this.addProvider("openai")));
		new Setting(containerEl)
			.setName("Add local provider")
			.setDesc("All use an OpenAI-compatible endpoint; the preset prefills the default port (LM Studio :1234, Ollama :11434).")
			.addButton(b => b.setButtonText("+ LM Studio").onClick(() => this.addProvider("openai-compatible", "lm-studio")))
			.addButton(b => b.setButtonText("+ Ollama").onClick(() => this.addProvider("openai-compatible", "ollama")))
			.addButton(b => b.setButtonText("+ OpenAI-compatible").onClick(() => this.addProvider("openai-compatible", "generic")));

		// ── AI system prompts ────────────────────────────────────────────
		this.renderSystemPromptsSection(containerEl);

		// ── Apple Books Import ───────────────────────────────────────────
		this.renderImportSection(containerEl);
	}

	private renderProviderEditor(parent: HTMLElement, idx: number): void {
		const provider = this.plugin.settings.aiProviders[idx];
		const details = parent.createEl("details", { cls: "tmr-settings-provider" });
		const summary = details.createEl("summary", { cls: "tmr-settings-provider-summary" });
		summary.createSpan({ cls: "tmr-settings-provider-name", text: provider.id || "(unnamed)" });
		const runtimeLabel = provider.localRuntime === "lm-studio" ? " · LM Studio"
			: provider.localRuntime === "ollama" ? " · Ollama" : "";
		summary.createSpan({ cls: "tmr-settings-provider-kind", text: ` — ${provider.kind}${runtimeLabel}` });
		const wrap = details;

		new Setting(wrap)
			.setName("Identifier")
			.setDesc("User-facing name shown in the model picker.")
			.addText(t => t.setValue(provider.id).onChange(async v => {
				provider.id = v;
				await this.plugin.saveSettings();
			}));

		if (provider.kind === "openai-compatible") {
			new Setting(wrap)
				.setName("Endpoint")
				.setDesc("Base URL — e.g. http://localhost:1234 (LM Studio) or http://localhost:11434 (Ollama). The /v1/chat/completions path is appended automatically.")
				.addText(t => t.setValue(provider.endpoint ?? "").onChange(async v => {
					provider.endpoint = v;
					await this.plugin.saveSettings();
				}));
		}

		if (provider.kind !== "openai-compatible") {
			new Setting(wrap)
				.setName("API key")
				.setDesc("Held in Obsidian's encrypted secret storage — never written to the plugin's data file.")
				.addComponent(el => new SecretComponent(this.app, el)
					.setValue(provider.apiKeyId ?? "")
					.onChange(async secretId => {
						provider.apiKeyId = secretId || undefined;
						provider.apiKey = secretId
							? (this.app.secretStorage.getSecret(secretId) ?? undefined)
							: undefined;
						await this.plugin.saveSettings();
					}));
		}

		let modelText: TextComponent | null = null;
		new Setting(wrap)
			.setName("Default model")
			.setDesc("Model id sent in chat requests when this provider is selected. Examples: claude-haiku-4-5-20251001 / gpt-4o-mini / llama-3-8b-instruct.")
			.addText(t => {
				modelText = t;
				t.setValue(provider.defaultModel ?? "").onChange(async v => {
					provider.defaultModel = v;
					await this.plugin.saveSettings();
				});
			})
			.addExtraButton(b => b
				.setIcon("list")
				.setTooltip("Browse models from the server")
				.onClick(() => void pickModel(this.app, provider, async (model) => {
					provider.defaultModel = model;
					modelText?.setValue(model);
					await this.plugin.saveSettings();
				})));

		new Setting(wrap)
			.then(s => s.settingEl.addClass("tmr-settings-provider-actions"))
			.addButton(b => b
				.setButtonText("Test connection")
				.onClick(async () => {
					b.setDisabled(true).setButtonText("Testing…");
					const result = await probeProvider(provider);
					b.setDisabled(false).setButtonText("Test connection");
					if (result.available) {
						new Notice(`✓ ${provider.id}: ${result.models.length} models available`);
					} else {
						new Notice(`✗ ${provider.id}: ${result.error ?? "unreachable"}`);
					}
				}))
			.addExtraButton(b => b
				.setIcon("trash-2")
				.setTooltip("Remove provider")
				.onClick(async () => {
					this.plugin.settings.aiProviders.splice(idx, 1);
					if (this.plugin.settings.aiDefaults.primaryProviderId === provider.id) {
						this.plugin.settings.aiDefaults.primaryProviderId = null;
					}
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	private async addProvider(kind: ProviderKind, runtime?: LocalRuntime): Promise<void> {
		const idBase = kind === "anthropic" ? "Anthropic"
			: kind === "openai" ? "OpenAI"
			: runtime === "lm-studio" ? "LM Studio"
			: runtime === "ollama" ? "Ollama"
			: "Local";
		let id = idBase;
		let n = 2;
		while (this.plugin.settings.aiProviders.some(p => p.id === id)) {
			id = `${idBase} ${n++}`;
		}
		const provider: AiProvider = { id, kind };
		if (kind === "openai-compatible") {
			provider.localRuntime = runtime ?? "generic";
			// Ollama defaults to :11434; LM Studio and a bare OpenAI-compatible
			// server both default to :1234 (the user can edit either).
			provider.endpoint = runtime === "ollama"
				? "http://localhost:11434"
				: "http://localhost:1234";
		}
		// First provider added flips the AI master switch on, so the full
		// GlossBar + Conversations surface light up without a separate step.
		if (this.plugin.settings.aiProviders.length === 0) {
			this.plugin.settings.aiFeaturesEnabled = true;
		}
		this.plugin.settings.aiProviders.push(provider);
		await this.plugin.saveSettings();
		this.display();
	}

	// ── AI system prompts ───────────────────────────────────────────────────

	private renderSystemPromptsSection(container: HTMLElement): void {
		const details = container.createEl("details", { cls: "tmr-settings-accordion" });
		const summary = details.createEl("summary", { cls: "tmr-settings-accordion-summary" });
		summary.createSpan({ text: "AI system prompts" });

		details.createEl("p", {
			cls: "setting-item-description tmr-settings-accordion-intro",
			text: "Instructions sent to the model for each AI Gloss mode. Use {book} as a "
				+ "placeholder for the book title; the selected passage is appended automatically.",
		});

		const modes: { id: AiPromptMode; label: string; desc: string }[] = [
			{ id: "explain", label: "Explain", desc: "Concise, knowledge-only answers." },
			{ id: "examine", label: "Examine", desc: "In-depth research with cited footnotes." },
			{ id: "exclaim", label: "Exclaim", desc: "Warm, empathetic response to a reaction." },
			{ id: "enquiry", label: "Enquiry", desc: "Open-ended, conversational discussion." },
		];

		for (const { id, label, desc } of modes) {
			let textArea!: TextAreaComponent;
			const setting = new Setting(details)
				.setName(label)
				.setDesc(desc)
				.addTextArea(t => {
					textArea = t;
					t.setValue(this.plugin.settings.systemPrompts[id]);
					t.inputEl.rows = 5;
					t.inputEl.addClass("tmr-settings-prompt-input");
					t.onChange(async v => {
						this.plugin.settings.systemPrompts[id] = v;
						await this.plugin.saveSettings();
					});
				})
				.addExtraButton(b => b
					.setIcon("rotate-ccw")
					.setTooltip("Reset to default")
					.onClick(async () => {
						this.plugin.settings.systemPrompts[id] = DEFAULT_SYSTEM_PROMPTS[id];
						textArea.setValue(DEFAULT_SYSTEM_PROMPTS[id]);
						await this.plugin.saveSettings();
					}));
			setting.settingEl.addClass("tmr-settings-prompt-row");
		}
	}

	// ── Apple Books import ──────────────────────────────────────────────────

	private importEntries: ImportEntry[] = [];

	private renderImportSection(container: HTMLElement): void {
		const section = container.createEl("div", { cls: "tmr-settings-import-section" });

		const head = new Setting(section)
			.setName("Apple Books Import")
			.setDesc("Import exploded epub folders from Apple Books as proper .epub files. "
				+ "Select one or more book folders — each must contain a mimetype file.")
			.addButton(b => b
				.setButtonText("Select epub folders…")
				.setCta()
				.onClick(async () => {
					const picked = await this.pickEpubFolders();
					if (!picked.length) return;
					this.importEntries = this.validateEpubFolders(picked);
					if (this.importEntries.length) this.renderImportResults(resultsEl);
				}));
		head.settingEl.addClass("tmr-settings-import-head");

		const resultsEl = section.createEl("div", { cls: "tmr-settings-import-results" });
	}

	private renderImportResults(container: HTMLElement): void {
		container.empty();
		if (this.importEntries.length === 0) {
			container.createEl("p", {
				cls: "setting-item-description",
				text: "No epub folders found — check the source path.",
			});
			return;
		}
		container.createEl("p", {
			cls: "setting-item-description",
			text: `Found ${this.importEntries.length} book${this.importEntries.length === 1 ? "" : "s"}:`,
		});

		for (const entry of this.importEntries) {
			const row = container.createEl("div", { cls: "tmr-settings-import-entry" });
			const cb = row.createEl("input") as HTMLInputElement;
			cb.type = "checkbox";
			cb.checked = entry.checked;
			cb.addEventListener("change", () => { entry.checked = cb.checked; });
			row.createSpan({ cls: "tmr-settings-import-entry-name", text: entry.name });
			row.createSpan({ cls: "tmr-settings-import-entry-arrow", text: "→" });
			const nameInput = row.createEl("input") as HTMLInputElement;
			nameInput.type = "text";
			nameInput.className = "tmr-settings-import-entry-rename";
			nameInput.value = entry.finalName;
			nameInput.addEventListener("input", () => { entry.finalName = nameInput.value; });
		}

		const footer = container.createEl("div", { cls: "tmr-settings-import-footer" });
		const statusEl = footer.createEl("div", { cls: "tmr-settings-import-status" });
		const btn = footer.createEl("button", { cls: "mod-cta", text: "Import selected" });
		btn.addEventListener("click", async () => {
			const toImport = this.importEntries.filter(e => e.checked);
			if (!toImport.length) { new Notice("No books selected."); return; }
			btn.disabled = true;
			btn.textContent = "Importing…";
			const imported = await this.importBooks(toImport, statusEl);
			btn.textContent = "Import selected";
			btn.disabled = imported > 0;
		});
	}

	private validateEpubFolders(paths: string[]): ImportEntry[] {
		const results: ImportEntry[] = [];
		for (const folderPath of paths) {
			const name = nodePath.basename(folderPath);
			try {
				const mimetype = fs.readFileSync(nodePath.join(folderPath, "mimetype"), "utf8").trim();
				if (mimetype !== "application/epub+zip") {
					new Notice(`Skipped "${name}" — not an epub folder.`);
					continue;
				}
			} catch {
				new Notice(`Skipped "${name}" — no mimetype file found.`);
				continue;
			}
			results.push({
				folderPath,
				name,
				finalName: name.replace(/\.(epub|book)$/i, "").trim() || name,
				checked: true,
			});
		}
		return results;
	}

	private async importBooks(entries: ImportEntry[], statusEl: HTMLElement): Promise<number> {
		const vaultBase = (this.plugin.app.vault.adapter as any).basePath as string;
		const outputDir = nodePath.join(vaultBase, "Library", "Imported");
		try {
			fs.mkdirSync(outputDir, { recursive: true });
		} catch (e) {
			new Notice(`Could not create output folder: ${(e as Error).message}`);
			return 0;
		}

		statusEl.empty();
		let imported = 0;
		for (const entry of entries) {
			const safe = (entry.finalName || entry.name).replace(/[\\/:*?"<>|]+/g, "_").trim() || "Book";
			let outputPath = nodePath.join(outputDir, `${safe}.epub`);
			let n = 2;
			while (fs.existsSync(outputPath)) {
				outputPath = nodePath.join(outputDir, `${safe} ${n++}.epub`);
			}
			try {
				await new Promise<void>((resolve, reject) => {
					exec(`zip -X -r "${outputPath}" mimetype *`, { cwd: entry.folderPath }, err => {
						err ? reject(err) : resolve();
					});
				});
				imported++;
			} catch (e) {
				statusEl.createEl("div", {
					cls: "tmr-settings-import-status-line tmr-settings-import-err",
					text: `✗ ${safe}: ${(e as Error).message?.slice(0, 120) ?? "unknown error"}`,
				});
			}
		}

		if (imported > 0) {
			const ok = statusEl.createEl("div", { cls: "tmr-settings-import-status-line tmr-settings-import-ok" });
			setIcon(ok.createSpan({ cls: "tmr-settings-import-status-icon" }), "book-check");
			ok.createSpan({ text: `${imported} book${imported === 1 ? "" : "s"} imported` });
			new Notice("Import complete — check Library/Imported/ in your vault.");
		}
		return imported;
	}

	private async pickEpubFolders(): Promise<string[]> {
		try {
			const electron = require("electron") as any;
			const dialog = electron.remote?.dialog;
			if (!dialog) {
				new Notice("Folder picker unavailable in this version of Obsidian.");
				return [];
			}
			const result = await dialog.showOpenDialog({
				properties: ["openFile", "multiSelections"],
				filters: [{ name: "EPUB", extensions: ["epub"] }],
				title: "Select epub files to import",
			});
			return result.canceled ? [] : result.filePaths;
		} catch {
			return [];
		}
	}
}

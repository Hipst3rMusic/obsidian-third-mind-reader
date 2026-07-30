/** The right-rail Highlights pane — Annotations list, Conversations list, and
 *  the AI chat surface — extracted from `ReaderView` so any view can host it.
 *
 *  The pane owns its own DOM, its own render state (open tab, sort, collapsed
 *  chapters, open conversation) and the whole AI-exchange path including the
 *  companion-doc writers that keep callout bodies in sync with `turns`. What it
 *  does *not* own is anything book-shaped: the saved-highlight list, how a
 *  highlight maps to a chapter, how to navigate to one, or where the companion
 *  doc lives. Those come from the {@link HighlightsPaneHost} — the seam that
 *  lets a PDF view drive the identical pane with page numbers where the EPUB
 *  reader supplies spine sections.
 *
 *  Leaf module by construction (obsidian + ai-client + gloss only) so main.ts
 *  can import it without an esbuild circular-import hazard around runtime
 *  `const` values — same reason gloss.ts and pdf-gloss.ts stand alone. */

import {
	App,
	Component,
	MarkdownRenderer,
	Menu,
	Notice,
	SuggestModal,
	TFile,
	setIcon,
	setTooltip,
} from "obsidian";
import {
	chat,
	probeModelLoaded,
	probeProvider,
	type AiProvider,
	type ChatMessage,
} from "./ai-client";
import {
	GLOSS_AI_MODES,
	GLOSS_MODES,
	GLOSS_PLACEHOLDERS,
	SOURCE_LINK_RE,
	applyGlossTheme,
	type ConversationTurn,
	type GlossHostSettings,
	type SavedHighlight,
} from "./gloss";

export type PaneTab = "annotations" | "conversations";

/** Gloss modes that issue an AI request. Emphasise is excluded — it never
 *  calls the model. */
export type AiPromptMode = "explain" | "examine" | "exclaim" | "enquiry";

export const DEFAULT_SYSTEM_PROMPTS: Record<AiPromptMode, string> = {
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

/** Build a mode-specific system prompt from the user-editable template,
 *  substituting the document title and appending the source quote as context so
 *  the model knows what passage is being discussed. Shared by both hosts — only
 *  the title differs (book title for EPUB, file basename for PDF). */
export function buildGlossSystemPrompt(
	settings: HighlightsPaneSettings,
	title: string,
	saved: SavedHighlight,
): string {
	const quoteCtx = saved.quote.trim()
		? `\n\nSelected passage:\n"${saved.quote.trim()}"`
		: "";
	const template = settings.systemPrompts[saved.mode as AiPromptMode]
		?? DEFAULT_SYSTEM_PROMPTS[saved.mode as AiPromptMode]
		?? `You are a helpful reading assistant for "{book}".`;
	return template.replace(/\{book\}/g, title) + quoteCtx;
}

/** The slice of plugin settings the pane reads. Extends the gloss floaters'
 *  slice (3C mode/theme + the AI master switch) with the AI-exchange knobs. */
export interface HighlightsPaneSettings extends GlossHostSettings {
	aiProviders: AiProvider[];
	aiDefaults: { primaryProviderId: string | null };
	streaming: boolean;
	showBareFlaggedConversations: boolean;
	systemPrompts: Record<AiPromptMode, string>;
	/** Per-document record; only `pane` is the pane's business. Keyed by vault
	 *  path, shared with the reader's position store. */
	bookPositions: Record<string, { pane?: PaneTab }>;
}

/** Drag-to-resize for a slide-in pane. No painted handle — an invisible strip
 *  along the pane's inner border flips the cursor to ew-resize (OS window
 *  idiom). Width is written as an inline `--tmr-pane-w` on the panel, so it's
 *  session-scoped for free: the shell DOM (and the var with it) is rebuilt on
 *  every document load. `edge` is where the strip sits on the panel; `bounds`
 *  is the element the pane must stay inside. */
export function makePaneResizable(
	owner: Component,
	panel: HTMLElement,
	edge: "left" | "right",
	bounds: HTMLElement,
): void {
	const grip = panel.createEl("div", { cls: `tmr-pane-resize-edge tmr-pane-resize-edge-${edge}` });
	owner.registerDomEvent(grip, "pointerdown", (e: PointerEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const startX = e.clientX;
		const startW = panel.getBoundingClientRect().width;
		// Mirror the CSS clamp (max-width: calc(100% - 60px)) so the stored
		// width never exceeds what the panel can actually render.
		const maxW = bounds.clientWidth - 60;
		grip.setPointerCapture(e.pointerId);
		document.body.addClass("tmr-pane-resizing");
		// Width writes are rAF-throttled: pointermove outpaces the frame rate,
		// and unthrottled style writes smear repaints in Electron.
		let pendingX: number | null = null;
		let raf = 0;
		const onMove = (ev: PointerEvent) => {
			pendingX = ev.clientX;
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				if (pendingX === null) return;
				const delta = edge === "left" ? startX - pendingX : pendingX - startX;
				// Floor = the CSS default width, so dragging to the smallest size
				// doubles as reset-to-default.
				const w = Math.max(340, Math.min(maxW, startW + delta));
				panel.style.setProperty("--tmr-pane-w", `${w}px`);
			});
		};
		const onUp = () => {
			if (raf) cancelAnimationFrame(raf);
			grip.removeEventListener("pointermove", onMove);
			grip.removeEventListener("pointerup", onUp);
			grip.removeEventListener("pointercancel", onUp);
			document.body.removeClass("tmr-pane-resizing");
		};
		grip.addEventListener("pointermove", onMove);
		grip.addEventListener("pointerup", onUp);
		grip.addEventListener("pointercancel", onUp);
	});
}

/** Everything book-shaped the pane needs from whichever view is hosting it. */
export interface HighlightsPaneHost {
	readonly app: App;
	settings(): HighlightsPaneSettings;
	saveSettings(): Promise<void>;
	/** The live saved-highlight array. Never cached by the pane — the host
	 *  reassigns it on book change, and `deleteHighlightAt` splices it in place. */
	savedHighlights(): SavedHighlight[];
	/** Companion doc path for the current book, or null when there is no book. */
	companionDocPath(): string | null;
	/** Grouping + doc-order keys for one highlight. EPUB resolves these from the
	 *  spine section; a PDF host would resolve them from the page. */
	sectionOf(saved: SavedHighlight): { id: string; label: string; spineIdx: number; paraIdx: number };
	/** Repaint the host's saved-highlight overlays (picks up the active-
	 *  conversation styling change). */
	repaintHighlights(): void;
	/** Navigate the host to a highlight's source passage. */
	jumpToSource(idx: number, closePanel: boolean): void;
	/** Mode-specific system prompt, with the book title + source quote folded in. */
	buildAiSystemPrompt(saved: SavedHighlight): string;
	/** Persist / restore the active tab for the current book. */
	persistTab(tab: PaneTab): void;
	restoreTab(): PaneTab | undefined;
	/** Hover tooltip for `[N]` citation pills (the host owns the floater). */
	showCitationTooltip(text: string, e: MouseEvent): void;
	hideCitationTooltip(): void;
	/** Fired whenever the panel opens or closes, so the host can coordinate its
	 *  own chrome (the reader folds its search bar away under the panel). */
	onPanelToggle(open: boolean): void;
	/** Drag-to-resize wiring — the host owns the geometry constraints. */
	makeResizable(panel: HTMLElement, edge: "left" | "right"): void;
}

/** User-facing label for a pre-token live-exchange phase (the animated dots are
 *  appended separately). "streaming" never reaches here — it renders text. */
function pendingLabel(phase: "connecting" | "loading" | "thinking"): string {
	return phase === "connecting" ? "Connecting"
		: phase === "loading" ? "Loading model"
		: "Thinking";
}

/** Sort priority for the Conversations list: Exclaim → Explain → Examine
 *  → Enquiry, matching the GlossBar tile order. Spec §"Sort order". */
const CONV_MODE_PRIORITY: Record<string, number> = {
	exclaim: 0,
	explain: 1,
	examine: 2,
	enquiry: 3,
};

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
export async function pickModel(
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

export class HighlightsPane extends Component {
	// ─── DOM ────────────────────────────────────────────────────────────────
	private panelEl: HTMLElement | null = null;
	private toggleEl: HTMLElement | null = null;
	private backdropEl: HTMLElement | null = null;
	private noteBtnEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private conversationsListEl: HTMLElement | null = null;
	private convCardsEl: HTMLElement | null = null;
	/** Chat-screen container — sibling of the cards list + filter row inside
	 *  the conversations panel. Holds the back button + conversation surface
	 *  for the open conversation. Its `data-conversation-idx` is the source of
	 *  truth for "which conversation is open": it survives list re-renders and
	 *  pane toggles, so `renderConversationsList` restores from it. */
	private convChatEl: HTMLElement | null = null;
	private convFilterRowEl: HTMLElement | null = null;
	private paneTabsEl: HTMLElement | null = null;

	// ─── Render state ───────────────────────────────────────────────────────
	private paneTab: PaneTab = "annotations";
	private convFilterOpen = false;
	private convSort: "priority" | "recent" | "chapter" = "priority";
	private open = false;
	/** Index into `savedHighlights` whose note is currently being edited inline
	 *  in the Annotations pane; null when no editor is open. Render-state, so the
	 *  editor survives the full re-renders triggered elsewhere. */
	private editingNoteIdx: number | null = null;
	/** Section IDs whose Annotations-pane chapter group is collapsed. In-memory
	 *  only — resets to all-expanded when a book opens (cleared by `reset`). */
	private collapsedSections = new Set<string>();
	/** Index into `savedHighlights` of the currently open conversation, or
	 *  -1 when none is open. Drives the `tmr-saved-highlight-rect-active` class
	 *  on overlay rects so the source passage stays visually pinned during the
	 *  exchange. Cleared by `closeConversation` when the chat screen closes. */
	private activeConvIdx = -1;
	/** Live `.tmr-conv-log` element of the currently-open conversation surface, or
	 *  null when no chat screen is open. Lets the initial auto-fired AI exchange
	 *  stream into the open chat's DOM (it's started right after the chat opens,
	 *  so there's no `log` argument to thread through). */
	private activeConvLog: HTMLElement | null = null;
	/** Abort controller for the in-flight streamed AI exchange, if any. Aborted
	 *  when the hosting chat screen closes or the view unloads so a stream
	 *  never outlives its surface. Null when no exchange is running. */
	private activeStreamAbort: AbortController | null = null;
	/** Monotonic render token + per-log generation. `renderConversationLog` is
	 *  async (awaits MarkdownRenderer per turn); concurrent calls on the same log
	 *  would interleave into one tree. A render checks its generation after each
	 *  await and bails if a newer render has superseded it. */
	private convRenderSeq = 0;
	private convLogSeq = new WeakMap<HTMLElement, number>();

	constructor(private host: HighlightsPaneHost) {
		super();
	}

	private get app(): App { return this.host.app; }
	private get saved(): SavedHighlight[] { return this.host.savedHighlights(); }

	/** True while the panel is slid in. */
	get isOpen(): boolean { return this.open; }
	/** Index of the open conversation, or -1 — read by the host's overlay painter. */
	get activeConversationIdx(): number { return this.activeConvIdx; }

	onunload(): void {
		this.abortActiveStream();
	}

	/** Cancel any in-flight streamed exchange so it can't write into dead DOM. */
	abortActiveStream(): void {
		this.activeStreamAbort?.abort();
		this.activeStreamAbort = null;
		this.activeConvLog = null;
	}

	/** Drop all per-book render state. Called when the host loads a new book. */
	reset(): void {
		this.collapsedSections.clear();
		this.editingNoteIdx = null;
		// Close any open chat screen — its dataset idx points into the old
		// book's savedHighlights and must not survive into the next one.
		if (this.activeConvIdx !== -1 || this.convChatEl?.dataset.conversationIdx) {
			this.closeConversation();
		}
		this.paneTab = "annotations";
	}

	// ─── Mount ──────────────────────────────────────────────────────────────

	/** Build the pane's DOM into the host's shell root: floating toggle, the
	 *  slide-in panel, and the dismiss backdrop, in that order. Called on every
	 *  shell rebuild (i.e. once per book load), so every element ref is
	 *  reassigned here. */
	mount(root: HTMLElement, opts: { floatingToggle?: boolean } = {}): void {
		// The shell is rebuilt closed, so the flag has to follow the DOM —
		// otherwise switching books with the pane open leaves `open === true`
		// against a closed panel and the next toggle is swallowed closing it.
		this.open = false;
		this.toggleEl = null;
		// Highlights navigation panel — mirrors the TOC shell but slides in from
		// the right. Populated from `savedHighlights` on every open, grouped by
		// section. Click-to-jump mounts the hosting unit and scrolls the
		// paragraph into view.
		//
		// The floating hover-reveal toggle is the reader's affordance; the PDF
		// host opts out of it and puts a button in the native PDF toolbar.
		if (opts.floatingToggle !== false) {
			const hlToggle = root.createEl("button", { cls: "tmr-highlights-toggle" });
			setIcon(hlToggle, "pencil-line");
			hlToggle.ariaLabel = "Highlights";
			this.registerDomEvent(hlToggle, "click", () => this.toggle());
			this.toggleEl = hlToggle;
		}

		const hlPanel = root.createEl("div", { cls: "tmr-highlights-panel" });
		hlPanel.inert = true; // Tab-proof while closed — see tocPanel.
		const hlHeader = hlPanel.createEl("div", { cls: "tmr-highlights-header" });
		hlHeader.createEl("span", { cls: "tmr-highlights-title", text: "Highlights" });
		// Note button — opens the companion annotation doc. Lives in the header
		// (above the tab bar) so it's reachable from both tabs, and so readers
		// who only Emphasise (no conversations) can still get to their notes.
		const hlNote = hlHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-highlights-note" });
		setIcon(hlNote, "file-pen");
		setTooltip(hlNote, "Open annotation notes");
		this.registerDomEvent(hlNote, "click", () => this.openCompanionDoc());
		this.noteBtnEl = hlNote;
		this.refreshCompanionDocButton();
		const hlClose = hlHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-highlights-close" });
		setIcon(hlClose, "x");
		this.registerDomEvent(hlClose, "click", () => this.toggle());

		// Tab bar (Annotations / Conversations) lives between the header and
		// the content. Two segmented buttons; click swaps which list is
		// visible. Active tab persists per-book via the host.
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
		this.registerDomEvent(annTab, "click", () => this.setTab("annotations"));
		this.registerDomEvent(convTab, "click", () => this.setTab("conversations"));
		this.paneTabsEl = tabs;

		this.listEl = hlPanel.createEl("div", { cls: "tmr-highlights-list" });
		const convListEl = hlPanel.createEl("div", { cls: "tmr-conversations-list tmr-hidden" });
		this.conversationsListEl = convListEl;
		this.convCardsEl = convListEl.createEl("div", { cls: "tmr-conv-cards" });
		const filterRow = convListEl.createEl("div", { cls: "tmr-conv-filter-row" });
		this.buildConvFilterRow(filterRow);
		// Chat screen — hidden until a conversation opens; replaces the cards
		// + filter row (via the container's tmr-conv-chat-open class) while
		// the tabs and header above stay put.
		this.convChatEl = convListEl.createEl("div", { cls: "tmr-conv-screen" });
		this.panelEl = hlPanel;
		this.host.makeResizable(hlPanel, "left");

		const hlBackdrop = root.createEl("div", { cls: "tmr-highlights-backdrop" });
		this.registerDomEvent(hlBackdrop, "click", () => this.toggle());
		this.backdropEl = hlBackdrop;
	}

	// ─── Panel chrome ───────────────────────────────────────────────────────

	toggle(): void {
		this.open = !this.open;
		const panel = this.panelEl;
		if (panel) panel.inert = !this.open;
		if (this.open) {
			this.applyPaneTabUI();
			this.renderActivePane();
			this.refreshCompanionDocButton();
			panel?.addClass("tmr-highlights-open");
			this.backdropEl?.addClass("tmr-highlights-backdrop-visible");
			this.toggleEl?.addClass("tmr-highlights-toggle-hidden");
		} else {
			panel?.removeClass("tmr-highlights-open");
			this.backdropEl?.removeClass("tmr-highlights-backdrop-visible");
			this.toggleEl?.removeClass("tmr-highlights-toggle-hidden");
			// Clear active-highlight styling when the panel is dismissed.
			if (this.activeConvIdx !== -1) {
				this.activeConvIdx = -1;
				this.host.repaintHighlights();
			}
		}
		this.host.onPanelToggle(this.open);
	}

	/** Switch the active right-rail tab. Persists via the host so re-opening
	 *  the book restores the same tab. Re-renders the now-visible list. */
	setTab(tab: PaneTab): void {
		if (this.paneTab === tab) return;
		this.paneTab = tab;
		this.applyPaneTabUI();
		this.renderActivePane();
		this.host.persistTab(tab);
	}

	/** Sync the tab-bar active state and list visibility with `paneTab`.
	 *  Called from `toggle` (when the panel opens) and `setTab` (on tab
	 *  click). Pure DOM swap; no data work. */
	private applyPaneTabUI(): void {
		const tabs = this.paneTabsEl;
		if (tabs) {
			tabs.dataset.active = this.paneTab;
			tabs.querySelectorAll<HTMLElement>(".tmr-pane-tab").forEach((el) => {
				el.toggleClass("tmr-pane-tab-active", el.dataset.paneTab === this.paneTab);
			});
		}
		const ann = this.listEl;
		const conv = this.conversationsListEl;
		if (ann) ann.toggleClass("tmr-hidden", this.paneTab !== "annotations");
		if (conv) conv.toggleClass("tmr-hidden", this.paneTab !== "conversations");
	}

	/** Reflect the AI-features master switch: the pane hides its Annotations/
	 *  Conversations tab bar, showing only the Annotations list. */
	applyAiFeaturesState(): void {
		const lite = !this.host.settings().aiFeaturesEnabled;
		this.panelEl?.toggleClass("tmr-pane-lite", lite);
		if (lite && this.paneTab !== "annotations") this.paneTab = "annotations";
		this.applyPaneTabUI();
	}

	/** Stamp 3C mode + theme onto the panel, which lives outside `.tmr-root`'s
	 *  token scope for the purposes of the mode colours. */
	syncTheme(): void {
		applyGlossTheme(this.panelEl, this.host.settings());
	}

	/** Restore `paneTab` from the host's per-book record. Called once the host
	 *  knows which book it has loaded. */
	restoreTab(): void {
		const stored = this.host.restoreTab();
		// Lite mode has no Conversations tab — always land on Annotations.
		this.paneTab = this.host.settings().aiFeaturesEnabled ? (stored ?? "annotations") : "annotations";
	}

	/** Open (or focus) the book's companion annotation doc in a markdown tab.
	 *  No-op when the doc doesn't exist yet (no annotations made). Bound to the
	 *  Highlights-pane header button so it's reachable from either tab. */
	async openCompanionDoc(): Promise<void> {
		const path = this.host.companionDocPath();
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
	refreshCompanionDocButton(): void {
		if (!this.noteBtnEl) return;
		const path = this.host.companionDocPath();
		const exists = !!path && this.app.vault.getAbstractFileByPath(path) instanceof TFile;
		this.noteBtnEl.toggleClass("tmr-hidden", !exists);
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
	renderActivePane(): void {
		if (this.paneTab === "annotations") this.renderHighlightsList();
		else this.renderConversationsList();
	}

	// ─── Annotations tab ────────────────────────────────────────────────────

	/** Build the grouped list of saved highlights for the sidebar. Groups by
	 *  the host section's label. Renders in document order so the sidebar
	 *  reflects reading order. */
	private renderHighlightsList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		if (this.saved.length === 0) {
			list.createEl("div", {
				cls: "tmr-highlights-empty",
				text: "No highlights yet — select any text to begin annotating.",
			});
			return;
		}

		// Stable doc-order sort: by spine index, then by start-char within the paragraph.
		const ordered = this.saved.map((saved, idx) => {
			const { id, label, spineIdx, paraIdx } = this.host.sectionOf(saved);
			return { saved, idx, paraIdx, spineIdx, sectionId: id, sectionLabel: label };
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
			this.host.jumpToSource(idx, true);
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
		const saved = this.saved[idx];
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
		this.host.repaintHighlights();
		this.renderHighlightsList();
	}

	/** Delete an annotation: excise its callout from the companion doc, drop it
	 *  from the in-memory list, and repaint overlays + pane. Confirmation-gated
	 *  because the callout (and any AI conversation it holds) is removed. */
	private async deleteHighlightAt(idx: number): Promise<void> {
		const saved = this.saved[idx];
		if (!saved) return;
		const ok = window.confirm(
			"Delete this annotation? It will be removed from the companion doc. This cannot be undone (the doc remains in vault history).",
		);
		if (!ok) return;

		const path = this.host.companionDocPath();
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (file) {
			try {
				await this.app.vault.process(file, (doc) => this.removeCalloutFromDoc(doc, saved));
			} catch (err) {
				console.error("[ThirdMindReader] deleteHighlightAt failed", err);
				new Notice("Third Mind Reader: failed to delete annotation");
				return;
			}
		}

		this.saved.splice(idx, 1);
		this.editingNoteIdx = null;
		this.host.repaintHighlights();
		this.renderHighlightsList();
		if (this.paneTab === "conversations") this.renderConversationsList();
		new Notice("Annotation deleted");
	}

	// ─── Conversations tab ──────────────────────────────────────────────────

	/** Build the Conversations tab list. Filters `savedHighlights` to
	 *  AI-bearing modes (Exclaim/Explain/Examine/Enquiry — Emphasise is
	 *  permanently excluded), sorts by mode priority then doc order, and
	 *  renders one card per entry. Clicking a card opens the chat screen
	 *  (`openConversation`), which replaces the list content until the back
	 *  button returns to it. */
	private renderConversationsList(): void {
		const list = this.convCardsEl;
		if (!list) return;
		list.empty();

		const showBare = this.host.settings().showBareFlaggedConversations;
		const conversations = this.saved
			.map((saved, idx) => ({ saved, idx }))
			.filter(({ saved }) => GLOSS_AI_MODES.has(saved.mode))
			.filter(({ saved }) => showBare || !this.isBareFlagged(saved));

		const hasConversations = conversations.length > 0;
		if (this.convFilterRowEl) this.convFilterRowEl.toggleClass("tmr-hidden", !hasConversations);

		if (!hasConversations) {
			// A chat can't stay open with nothing to return to (e.g. the last
			// conversation was just deleted) — fall back to the empty state.
			if (this.convChatEl?.dataset.conversationIdx !== undefined) this.closeConversation();
			list.createEl("div", {
				cls: "tmr-highlights-empty",
				text: "No conversations yet — use Explain, Examine, Exclaim or Enquiry on a selection to start one.",
			});
			return;
		}

		const enriched = conversations.map((entry) => {
			const { spineIdx, paraIdx } = this.host.sectionOf(entry.saved);
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
		for (const { saved, idx } of ordered) {
			// Chapter headers when sorting by chapter — mirrors Annotations tab grouping.
			if (this.convSort === "chapter") {
				const section = this.host.sectionOf(saved);
				if (section.id !== lastSectionId) {
					lastSectionId = section.id;
					list.createEl("div", {
						cls: "tmr-highlights-section-header",
						text: section.label,
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
				this.openConversation(idx);
			});
		}

		// Re-render any open chat screen against the fresh data (tab switch,
		// data refresh, pane reopen). The screen's dataset survives the list
		// rebuild — it lives outside `convCardsEl`. Restore without navigating:
		// a persisted open chat must not yank the reader back to its source.
		const openIdxStr = this.convChatEl?.dataset.conversationIdx;
		if (openIdxStr !== undefined) {
			const openIdx = parseInt(openIdxStr, 10);
			const openSaved = this.saved[openIdx];
			if (openSaved && GLOSS_AI_MODES.has(openSaved.mode)) {
				this.openConversation(openIdx, false);
			} else {
				// The conversation is gone (deleted / book changed) — fall back
				// to the list.
				this.closeConversation();
			}
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

	/** Open the chat screen for `savedHighlights[idx]`. The screen replaces
	 *  the list content (cards + filter row) inside the conversations panel —
	 *  tabs and header stay put. `jumpToSource` navigates the reader to the
	 *  source paragraph — true for explicit user opens, false when *restoring*
	 *  a persisted open chat (pane reopen / data refresh), so a remembered
	 *  conversation never yanks the reader away from where it is. */
	openConversation(idx: number, jumpToSource = true): void {
		const screen = this.convChatEl;
		const saved = this.saved[idx];
		if (!screen || !saved) return;

		screen.empty();
		screen.dataset.conversationIdx = String(idx);
		screen.dataset.glossMode = saved.mode;
		this.conversationsListEl?.addClass("tmr-conv-chat-open");

		// Back button — the only dismissal affordance (Esc stays global).
		const back = screen.createEl("button", { cls: "tmr-conv-back" });
		setIcon(back, "chevron-left");
		setTooltip(back, "Back to conversations");
		this.registerDomEvent(back, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.closeConversation();
		});

		this.renderConversationSurface(screen, saved);
		// Pin the highlight in active styling for the duration of the open
		// conversation. On an explicit open, also jump the reader to the source
		// paragraph; on a restore, repaint styling without navigating so the
		// reader keeps its current position.
		this.activeConvIdx = idx;
		if (jumpToSource) {
			this.host.jumpToSource(idx, false);
		} else {
			this.host.repaintHighlights();
		}
	}

	/** Close the chat screen back to the conversations list. The list never
	 *  unmounted, so its scroll position is preserved. Cancels any in-flight
	 *  stream and drops the active-highlight styling. */
	private closeConversation(): void {
		this.activeStreamAbort?.abort();
		this.activeConvIdx = -1;
		this.activeConvLog = null;
		const screen = this.convChatEl;
		this.conversationsListEl?.removeClass("tmr-conv-chat-open");
		if (screen) {
			// Clear the open-marker immediately (the list-restore logic keys
			// off it) but keep the DOM + mode tint alive through the 220ms
			// slide-out; tear down once the screen is off-stage. A conversation
			// reopened mid-exit re-adds the class and owns the screen — skip.
			delete screen.dataset.conversationIdx;
			window.setTimeout(() => {
				if (this.conversationsListEl?.hasClass("tmr-conv-chat-open")) return;
				screen.empty();
				delete screen.dataset.glossMode;
			}, 250);
		}
		this.host.repaintHighlights();
	}

	private renderConversationSurface(host: HTMLElement, saved: SavedHighlight): void {
		const surface = host.createEl("div", { cls: "tmr-conv-surface" });

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
		});
		const sendBtn = chatboxTop.createEl("button", { cls: "tmr-conv-send" });
		setIcon(sendBtn, "send-horizontal");
		sendBtn.disabled = true;

		// Bottom: model picker + settings button. The label surfaces the
		// user-given provider name from settings (provider.id), not the raw
		// model id — the picker dialog still lists raw model ids; the hover
		// tooltip carries the currently resolved one.
		const chatboxBottom = chatbox.createEl("div", { cls: "tmr-conv-chatbox-bottom" });
		const provider = this.getActiveProvider();
		const modelPicker = chatboxBottom.createEl("div", { cls: "tmr-conv-model-picker" });
		setIcon(modelPicker, "chevron-down");
		modelPicker.createEl("span", { text: provider ? provider.id : "No model configured" });
		if (provider?.defaultModel) setTooltip(modelPicker, provider.defaultModel);
		// Clickable when a provider is resolved: opens the model browser for it
		// and updates this provider's default model. No-op when unconfigured.
		if (provider) {
			modelPicker.addClass("tmr-conv-model-picker-clickable");
			this.registerDomEvent(modelPicker, "click", (e: MouseEvent) => {
				e.stopPropagation();
				void pickModel(this.app, provider, (model) => {
					provider.defaultModel = model;
					setTooltip(modelPicker, model);
					void this.host.saveSettings();
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
			textarea.setCssProps({ height: "auto" });
			textarea.setCssProps({ height: Math.min(textarea.scrollHeight, 80) + "px" });
			sendBtn.disabled = textarea.value.trim().length === 0;
		});
		this.registerDomEvent(textarea, "click", (e: MouseEvent) => e.stopPropagation());
		this.registerDomEvent(sendBtn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			const text = textarea.value.trim();
			if (!text) return;
			textarea.value = "";
			textarea.setCssProps({ height: "auto" });
			sendBtn.disabled = true;
			this.submitConversationMessage(saved, log, text);
		});
		this.registerDomEvent(chatbox, "click", (e: MouseEvent) => e.stopPropagation());
		this.registerDomEvent(textarea, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (!sendBtn.disabled) sendBtn.click();
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
						this.host.showCitationTooltip(`${cite.title} — ${cite.url}`, e));
					this.registerDomEvent(span, "mouseleave", () => this.host.hideCitationTooltip());
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

	/** Fire the initial AI exchange for a freshly-created annotation into
	 *  whichever chat log is open right now (the host opens the card first, so
	 *  the first turn streams token-by-token like every follow-up). */
	runInitialExchange(saved: SavedHighlight): void {
		void this.doAiExchange(saved, this.activeConvLog).catch((err) =>
			console.error("[ThirdMindReader] initial AI call failed", err),
		);
	}

	/** Core AI exchange: sends turns to the provider, writes the assistant
	 *  turn (or error) back into `saved`, patches the companion doc, and
	 *  refreshes the conversations list.
	 *
	 *  When called from `runInitialExchange` (initial auto-fire), `saved.turns`
	 *  is empty — the first user turn is seeded from `saved.userText` before the
	 *  API call fires. When called from `submitConversationMessage`, the user
	 *  turn is already in `saved.turns`. */
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

		const provider = this.getActiveProvider();
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
			this.host.settings().streaming && provider.kind === "openai-compatible";
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
				systemPrompt: this.host.buildAiSystemPrompt(saved),
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

	private getActiveProvider(): AiProvider | null {
		const s = this.host.settings();
		const primary = s.aiProviders.find((p) => p.id === s.aiDefaults.primaryProviderId);
		return primary ?? s.aiProviders[0] ?? null;
	}

	// ─── Companion-doc writers ──────────────────────────────────────────────

	private async patchCalloutInDoc(saved: SavedHighlight): Promise<void> {
		const path = this.host.companionDocPath();
		if (!path) return;
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		try {
			// AI-bearing callouts are rebuilt from `turns`; non-AI (Emphasise)
			// callouts carry a free-text note in `userText` instead.
			await this.app.vault.process(file, (doc) =>
				GLOSS_AI_MODES.has(saved.mode)
					? this.rewriteCalloutBody(doc, saved)
					: this.rewriteEmphasiseNote(doc, saved),
			);
		} catch (err) {
			console.error("[ThirdMindReader] patchCalloutInDoc failed", err);
		}
	}

	/** The anchor-comment substrings that identify one saved highlight uniquely.
	 *  Two shapes, because the two sources anchor differently: an EPUB entry is
	 *  `para:` (+ a `chars:` disambiguator when several marks share a paragraph),
	 *  a PDF entry is `pdfPage:` + `pdfSel:`. Getting this wrong is silent — the
	 *  rewriters simply fail to find the callout and return the doc untouched. */
	private anchorTokens(saved: SavedHighlight): string[] {
		if (saved.pdfPage !== undefined && saved.pdfSel) {
			return [`pdfPage:${saved.pdfPage}`, `pdfSel:${saved.pdfSel.join(",")}`];
		}
		// Cross-para anchors store the `chars:S,-1` sentinel in the doc; the real
		// end offset lives in `endChars:` (folded into saved.endChar on parse).
		const charsToken = saved.startChar >= 0
			? (saved.endParaIdHint
				? `chars:${saved.startChar},-1`
				: `chars:${saved.startChar},${saved.endChar}`)
			: null;
		return charsToken
			? [`para:${saved.paraIdHint}`, charsToken]
			: [`para:${saved.paraIdHint}`];
	}

	/** Locate a single callout in `lines` by its anchor comment. Returns the
	 *  header line index (`> [!mode]`), the anchor comment line index, and the
	 *  exclusive end index (first line past the callout body). Null when the
	 *  callout cannot be found. Shared by the body rewriters and the delete path. */
	private findCalloutBounds(
		lines: string[],
		saved: SavedHighlight,
	): { startIdx: number; anchorIdx: number; endIdx: number } | null {
		// Tokens must end at a field boundary. Anchor fields are space-separated,
		// so a bare `includes` would let `pdfSel:2,0,4,5` match a *different*
		// mark's `pdfSel:2,0,4,50` and rewrite the wrong callout.
		const tokens = this.anchorTokens(saved).map(
			(t) => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=\\s)"),
		);
		let anchorIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!tokens.every((t) => t.test(line))) continue;
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

	/** The callout's existing interop deep-link line, if it has one. The
	 *  rewriters rebuild the body from the model, and the link is the one piece
	 *  that lives only in the doc — carried through verbatim rather than
	 *  reconstructed, since only the PDF child can mint it. */
	private existingSourceLink(lines: string[], anchorIdx: number, endIdx: number): string | null {
		for (let i = anchorIdx + 1; i < endIdx; i++) {
			const stripped = lines[i].replace(/^>\s?/, "").trim();
			if (SOURCE_LINK_RE.test(stripped)) return lines[i];
		}
		return null;
	}

	/** Rewrite the body lines of a single callout (from anchor line to the
	 *  first non-`>` line) to reflect `saved.turns` and `saved.aiState`. */
	private rewriteCalloutBody(doc: string, saved: SavedHighlight): string {
		const lines = doc.split("\n");
		const bounds = this.findCalloutBounds(lines, saved);
		if (!bounds) return doc;
		const { anchorIdx, endIdx } = bounds;

		// Rebuild body: source quote → deep link → turns → state marker.
		const body: string[] = [];
		if (saved.quote.trim()) {
			for (const ql of saved.quote.split("\n")) body.push(`> > ${ql}`);
		}
		const sourceLink = this.existingSourceLink(lines, anchorIdx, endIdx);
		if (sourceLink) body.push(sourceLink);
		for (const turn of saved.turns) {
			const prefix = turn.role === "user" ? "User" : "AI";
			const contentLines = turn.content.split("\n");
			body.push(`> ${prefix}: ${contentLines[0]}`);
			// Paragraph breaks emit a bare `>` (no trailing space) so the line
			// round-trips through the parser unchanged.
			for (let i = 1; i < contentLines.length; i++) {
				body.push(contentLines[i].length ? `> ${contentLines[i]}` : ">");
			}
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
	 *  Mirrors the non-AI branch of `buildCallout`: source quote, then a blank
	 *  `>` separator + the note lines when a note is present. An empty note
	 *  collapses the callout back to its bare form. */
	private rewriteEmphasiseNote(doc: string, saved: SavedHighlight): string {
		const lines = doc.split("\n");
		const bounds = this.findCalloutBounds(lines, saved);
		if (!bounds) return doc;
		const { anchorIdx, endIdx } = bounds;

		const body: string[] = [];
		if (saved.quote.length > 0) {
			for (const ql of saved.quote.split(/\r?\n/)) body.push(`> > ${ql}`);
		}
		const sourceLink = this.existingSourceLink(lines, anchorIdx, endIdx);
		if (sourceLink) body.push(sourceLink);
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

	/** A bare-flagged conversation is an AI-mode callout with no user prompt
	 *  text and no AI turns — only valid for Exclaim/Enquiry submitted with
	 *  empty input. Filtered out of the Conversations list by default; the
	 *  chat-box gear popover toggles visibility. */
	isBareFlagged(saved: SavedHighlight): boolean {
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
		const settings = this.host.settings();

		menu.addItem((item) =>
			item
				.setTitle("Show bare-flagged Exclaims/Enquiries")
				.setIcon("eye")
				.setChecked(settings.showBareFlaggedConversations)
				.onClick(async () => {
					settings.showBareFlaggedConversations = !settings.showBareFlaggedConversations;
					await this.host.saveSettings();
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
}

import {
	Plugin,
	PluginSettingTab,
	Setting,
	App,
	ItemView,
	WorkspaceLeaf,
	FileSystemAdapter,
	type ViewStateResult,
	type ViewState,
	TFile,
	TFolder,
	setIcon,
	addIcon,
	Notice,
	SecretComponent,
	TextAreaComponent,
	TextComponent,
	Modal,
	Platform,
	Scope,
	apiVersion,
	getLinkpath,
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
	resolveRelativePath,
	EpubBook,
	EpubDrmError,
	EpubTocItem,
	type EpubLinkPreview,
} from "./epub";
import { OffsetMap, type CursorRange, isRegisterableBlock, REGISTERABLE_BLOCK_SELECTOR } from "./pretext-layer";
import { probeProvider, type AiProvider, type ProviderKind, type LocalRuntime } from "./ai-client";
import { LibraryView, LIBRARY_VIEW_TYPE } from "./library-view";
import { type LibraryOverride, invalidateMetaCache, LIBRARY_ROOT, companionDocPath, sanitizeFileName } from "./library-scan";
// Shared Gloss grammar — the annotation surface, saved-highlight model, and
// companion-doc writers that the EPUB reader and the PDF controller both drive.
import {
	ANCHOR_PREFIX_LEN,
	AnnotationPreview,
	GLOSS_AI_MODES,
	GLOSS_MODES,
	GlossSurface,
	appendCallout,
	applyGlossTheme,
	buildCallout,
	calloutHeader,
	ensureCompanionDoc,
	hitTestHighlightRects,
	isTextInputFocused,
	parseSavedHighlights,
	type SavedHighlight,
} from "./gloss";
// The right-rail Highlights pane (Annotations / Conversations / AI chat). Owns
// its own DOM and the whole AI-exchange path; ReaderView is its first host.
import {
	DEFAULT_SYSTEM_PROMPTS,
	HighlightsPane,
	buildGlossSystemPrompt,
	makePaneResizable,
	pickModel,
	type AiPromptMode,
	type HighlightsPaneHost,
	type PaneTab,
} from "./highlights-pane";
import { PdfGlossManager } from "./pdf-gloss";
// Bundled 3C typefaces (OFL/Apache). Imported as base64 data URLs (see
// esbuild.config.mjs `dataurl` loader) so they ship inside main.js and render
// for BRAT testers, whose vaults never receive the loose fonts/ folder.
import RosarivoRegular from "./fonts/Rosarivo-Regular.ttf";
import RosarivoItalic from "./fonts/Rosarivo-Italic.ttf";
import LabradaRegular from "./fonts/Labrada-VariableFont_wght.ttf";
import LabradaItalic from "./fonts/Labrada-Italic-VariableFont_wght.ttf";
import KodeMono from "./fonts/KodeMono-VariableFont_wght.ttf";

export const READER_VIEW_TYPE = "third-mind-reader";

// Book search: shortest queryable string, total hits collected before bailing,
// and how many rows actually render (the rest collapse into a "more" footer).
const SEARCH_MIN_CHARS = 2;
const SEARCH_MAX_HITS = 500;
const SEARCH_RENDER_CAP = 100;

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
	/** One-time flag: the "How to use the reader" help modal auto-opens the first
	 *  time a book is opened, then sets this so it never auto-opens again. The
	 *  help button (next to the ToC toggle) re-opens it on demand. */
	helpShown: boolean;
}

const DEFAULT_SETTINGS: ThirdMindReaderSettings = {
	tmrMode: "obsidian",
	tmrTheme: "dark",
	bookPositions: {},
	aiProviders: [],
	aiDefaults: { primaryProviderId: null },
	aiFeaturesEnabled: false,
	streaming: true,
	showBareFlaggedConversations: false,
	systemPrompts: { ...DEFAULT_SYSTEM_PROMPTS },
	libraryOverrides: {},
	libraryCollectionOrder: [],
	feedbackHintShown: false,
	helpShown: false,
};

/** Consecutive forward page-turns (with no backward turn) after a large jump
 *  before the "Back" pill decays. The return-point dot on the bar persists; the
 *  pill is the obtrusive part, so it recedes once the reader has committed to
 *  the destination. A backward turn = peeking, and resets the count. */
const BACK_PILL_COMMIT_TURNS = 3;

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

/** One registerable block of the book-search index. `paraId` is predicted to
 *  match what prepareUnit stamps at mount (same walk, same filter), so a hit
 *  can ride the saved-highlight jump path. */
interface BookSearchEntry {
	paraId: string;
	sectionIdx: number;
	text: string;
	textLower: string;
}

interface BookSearchHit {
	entry: BookSearchEntry;
	start: number;
	end: number;
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

/** Persisted reader leaf state (getState/setState round-trip). Obsidian
 *  sometimes hands the state back nested one level deep on tab restore,
 *  hence the recursive `state` field. */
interface ReaderViewState extends Record<string, unknown> {
	file?: string;
	unitIndex?: number;
	spread?: number;
	state?: ReaderViewState;
}

/** A cheat-sheet row: a keycap, an optional colour-flagged mode label, and a
 *  description. Recreated from the `HelpPopoup` component in the 3C Pencil DLS. */
interface HelpRow {
	key: string;
	label?: { text: string; color: string };
	desc: string;
}

const HELP_GROUPS: { heading: string; rows: HelpRow[] }[] = [
	{
		heading: "Reading",
		rows: [
			{ key: "← / →", desc: "Previous / Next Page" },
			{ key: "t", desc: "Table Of Contents" },
			{ key: "h", desc: "Highlights & Annotations" },
			{ key: "s", desc: "Search in book" },
			{ key: "Esc", desc: "Close a panel or dismiss the Gloss toolbar" },
		],
	},
	{
		heading: "Annotating – Select Text, Then Press",
		rows: [
			{ key: "Select Text", desc: "Surfaces the Gloss toolbar over your selection" },
			{ key: "1", label: { text: "Emphasise", color: "#50805c" }, desc: "Plain highlight with annotation" },
			{ key: "2", label: { text: "Exclaim", color: "#af4d4d" }, desc: "Capture a reaction as first AI turn" },
			{ key: "3", label: { text: "Explain", color: "#ac9c5d" }, desc: "Ask AI to clarify" },
			{ key: "4", label: { text: "Examine", color: "#6396a2" }, desc: "Ask the AI to explore, with citations" },
			{ key: "5", label: { text: "Enquiry", color: "#a7a3a5" }, desc: "Open back-and-forth conversation with AI" },
		],
	},
];

/** "How to use the Reader" — a keyboard/action cheat sheet recreated from the
 *  3C DLS `HelpPopoup` component. Auto-opens once on first book open (gated by
 *  `settings.helpShown`); re-openable any time from the help button beside the
 *  ToC toggle. Pure presentation — reads no plugin state. */
class HelpModal extends Modal {
	onOpen(): void {
		const { modalEl, contentEl } = this;
		modalEl.addClass("tmr-help-modal");
		contentEl.empty();

		const header = contentEl.createDiv({ cls: "tmr-help-header" });
		header.createEl("h2", { cls: "tmr-help-title", text: "How to use the Reader" });
		header.createEl("p", {
			cls: "tmr-help-intro",
			text: "Third Mind Reader is keyboard-first. Hover over the page to reveal the panel buttons, everything else is a keystroke away.",
		});

		for (const group of HELP_GROUPS) {
			const section = contentEl.createDiv({ cls: "tmr-help-section" });
			section.createDiv({ cls: "tmr-help-group", text: group.heading });
			for (const row of group.rows) {
				const rowEl = section.createDiv({ cls: "tmr-help-row" });
				rowEl.createDiv({ cls: "tmr-help-keycol" })
					.createSpan({ cls: "tmr-help-keycap", text: row.key });
				const desc = rowEl.createDiv({ cls: "tmr-help-desc" });
				if (row.label) {
					const lbl = desc.createSpan({ cls: "tmr-help-mode", text: row.label.text });
					lbl.style.color = row.label.color;
				}
				desc.createSpan({ cls: "tmr-help-action", text: row.desc });
			}
		}

		contentEl.createEl("p", {
			cls: "tmr-help-foot",
			text: "Gloss shortcuts (1-5) only trigger while text is selected and toolbar is showing. AI modes need a provider configured in settings.",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
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
	/** True once a unit has actually mounted for the current book. Guards the
	 *  onClose position flush: a view closed mid-load (plugin reload/update
	 *  tears views down while the async load is in flight) still sits at the
	 *  0/0 reset values, and flushing those would overwrite the real stored
	 *  position with {unitIndex: 0, spread: 0, pct: 1} — the "sent back to
	 *  the start" poison. */
	private hasMountedUnit = false;
	/** Durable "where the user is" anchor — section index + in-section spread
	 *  offset + that section's spread count — captured on every goToSpread,
	 *  when the unit model is guaranteed valid. handleResize re-seeks from
	 *  this instead of re-deriving from live model state: a resize pass can
	 *  run while another pass holds this.units mid-rebuild (transiently
	 *  empty), and deriving the section from an empty model fabricated
	 *  "section 0" — the post-reload yank back to the cover. */
	private posAnchor: { sectionIdx: number; offset: number; count: number } | null = null;
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
	// Keyed `sectionId@geometryBucket`; persists across resizes (values are only
	// valid for their own bucket by construction). Cleared on book change.
	private spreadMeasureCache = new Map<string, { spreads: number; columns: number }>();
	// Exact position per committed geometry bucket, saved when a resize leaves
	// it. Fractional spread⇄page count ratios (7 spreads ⇄ 15 pages) make the
	// scaled remap drift by one on round-trips; returning to a known bucket
	// restores the exact spot instead. Cleared on book change.
	private lastPositionByBucket = new Map<string, { unitIndex: number; spread: number }>();

	// Unit DOM is geometry-independent (pretext prepares offsets from font
	// metrics; pagination is CSS columns re-applied at mount), so the cache is
	// keyed by spine range and survives resize rebuilds — only book load clears it.
	private unitDomCache = new Map<string, HTMLElement>();
	private mountedUnitKeys = { prev: "", next: "" };
	private renderToken = 0;
	/** Monotonic id for queued layout passes; a pass whose id is stale by the
	 *  time it reaches the front of the chain is skipped (a newer one follows). */
	private layoutPassId = 0;
	/** Serializes geometry passes (initial load + resize rebuilds) so they never
	 *  interleave on the shared pagination model / measurement DOM (Case File 08). */
	private layoutChain: Promise<void> = Promise.resolve();
	private offsetMap = new OffsetMap();
	private layoutMode: LayoutMode = "spread";

	/** The shared GlossBar / input / tooltip floaters. Constructed in `onOpen`
	 *  and added as a child component, so its DOM and listeners die with the
	 *  view. The PDF controller drives an identical instance. */
	private glossSurface!: GlossSurface;
	/** The right-rail Annotations / Conversations pane. Constructed in the
	 *  constructor and added as a child component, so its DOM, listeners and
	 *  in-flight AI stream die with the view. */
	private pane!: HighlightsPane;
	private highlightOverlayEl: HTMLElement | null = null;
	// Book search (see In-Book Search feature spec). The index promise is the
	// lazy cache: built on first use per book, dropped in resetViewState.
	private searchOpen = false;
	private searchBarEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	private searchResultsEl: HTMLElement | null = null;
	private searchQuery = "";
	private searchDebounce: number | null = null;
	private searchIndexPromise: Promise<BookSearchEntry[]> | null = null;
	private searchHits: BookSearchHit[] = [];
	/** Keyboard-focused result row (combobox pattern — DOM focus stays in the
	 *  input; ↑/↓ move this index, Enter jumps). −1 = nothing focused. */
	private searchActiveIdx = -1;
	// Esc interception — a keymap Scope pushed while this reader is the active
	// leaf, so layer dismissal preempts app/plugin hotkeys (see onOpen).
	private escScope: Scope | null = null;
	private escScopePushed = false;
	private activeHighlight: CursorRange | null = null;
	private activeSelectionText: string | null = null;
	private activeSelectionRect: DOMRect | null = null;
	/** Anchored cross-page selection. While `isExtending`, the start boundary is
	 *  frozen in `extendAnchor` (a live DOM point — valid as long as the unit's
	 *  DOM persists, i.e. within-unit page turns), the selection survives
	 *  navigation, and the next reader click sets the far endpoint. */
	private isExtending = false;
	private extendAnchor: { node: Node; offset: number } | null = null;
	private extendHintEl: HTMLElement | null = null;
	private savedHighlights: SavedHighlight[] = [];
	/** Shared hover-preview floater for saved highlights. Child component, so
	 *  its DOM dies with the view; the PDF controller drives its own instance. */
	private annotationPreview!: AnnotationPreview;

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
		// Built here rather than in onOpen so `applyAiFeaturesState` (which
		// `saveSettings` fans out to every open view) can never race ahead of it.
		this.glossSurface = new GlossSurface({
			app: this.app,
			settings: () => this.plugin.settings,
			sourcePath: () => this.getCompanionDocPath() ?? "",
			onExtend: () => this.beginExtend(),
			onSubmit: (mode, text) => this.onGlossSubmit(mode, text),
			onDismiss: () => this.dismissGloss(),
		});
		this.addChild(this.glossSurface);
		this.annotationPreview = new AnnotationPreview(() => this.plugin.settings);
		this.addChild(this.annotationPreview);
		this.pane = new HighlightsPane(this.paneHost());
		this.addChild(this.pane);
	}

	/** The book-shaped seam the Highlights pane reads the reader through: the
	 *  saved-highlight list, spine-section grouping, navigation, and where the
	 *  companion doc lives. A PDF host supplies the same shape with pages. */
	private paneHost(): HighlightsPaneHost {
		return {
			app: this.app,
			settings: () => this.plugin.settings,
			saveSettings: () => this.plugin.saveSettings(),
			savedHighlights: () => this.savedHighlights,
			companionDocPath: () => this.getCompanionDocPath(),
			sectionOf: (saved) => {
				const match = /^s(\d+)-p(\d+)$/.exec(saved.paraIdHint);
				const spineIdx = match ? parseInt(match[1], 10) : 0;
				const paraIdx = match ? parseInt(match[2], 10) : 0;
				const section = this.sections[this.sectionIndexBySpine[spineIdx] ?? 0];
				return { id: section?.id ?? "", label: section?.label ?? "—", spineIdx, paraIdx };
			},
			repaintHighlights: () => this.renderSavedHighlights(),
			jumpToSource: (idx, closePanel) => void this.jumpToHighlight(idx, closePanel),
			buildAiSystemPrompt: (saved) => this.buildAiSystemPrompt(saved),
			persistTab: (tab) => this.persistPaneTab(tab),
			restoreTab: () => {
				const path = this.currentFile?.path ?? this.currentFolder?.path;
				return path ? this.plugin.settings.bookPositions[path]?.pane : undefined;
			},
			showCitationTooltip: (text, e) => this.renderTooltip({ kind: "text", text }, e),
			hideCitationTooltip: () => this.hideTooltip(),
			onPanelToggle: (open) => {
				// The panel slides over the search corner — hide the bar the same
				// way and fold the results card away with it.
				this.searchBarEl?.toggleClass("tmr-search-bar-hidden", open);
				if (open && this.searchOpen) this.toggleBookSearch(false);
			},
			makeResizable: (panel, edge) => this.makePaneResizable(panel, edge),
		};
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
				this.queueResize();
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

		// Escape must beat app/plugin hotkeys (quick-peek-sidebar binds bare Esc;
		// unbound, the app still refocuses the editor). A DOM listener can never
		// win that race — Obsidian's keymap listens on `window` in the CAPTURE
		// phase, registered at boot — so we go through the keymap itself: a
		// Scope pushed while this reader is the active leaf. The handler is a
		// CATCH-ALL (null key) on purpose: a specific-key registration would
		// terminate the scope chain even when it declines, swallowing Esc for
		// the whole app while reading; a catch-all that returns undefined lets
		// the event fall through to the root scope's hotkeys untouched.
		// Dismissal runs in transience order, one layer per press, and fires
		// even while a panel input has focus (scope follows the active leaf,
		// not DOM focus).
		this.escScope = new Scope(this.app.scope);
		this.escScope.register(null, null, (_evt, ctx) => {
			if (ctx.key !== "Escape") return;
			if (this.isGlossActive()) this.dismissGloss();
			else if (this.searchOpen) this.toggleBookSearch(false);
			else if (this.tocOpen) this.toggleToc();
			else if (this.pane.isOpen) this.pane.toggle();
			else return;
			return false; // consumed — keymap preventDefaults and stops here
		});
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncEscScope()));
		this.syncEscScope();

		// Reader bare-key shortcuts (t / h / s / 1–5 / ← / →) are handled HERE,
		// scoped to this view: the handler no-ops unless this reader is the active
		// leaf, so the keys never interfere with typing in a note or any other view.
		// They are deliberately NOT Obsidian command hotkeys — command hotkeys are
		// global and a bare key (especially the arrows) steals the keystroke from
		// the editor app-wide. Only modifier combos are safe as commands, so just
		// those live in `addReaderCommands`.
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (this.app.workspace.getActiveViewOfType(ReaderView) !== this) return;
			// While a text field (gloss input, note editor, chat box, search…) has
			// focus, keystrokes belong to it: navigation and shortcuts yield.
			const typing = isTextInputFocused();
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
			if (!typing && (e.key === "t" || e.key === "h" || e.key === "s") && !e.ctrlKey && !e.metaKey && !e.altKey) {
				// preventDefault matters for `s`: the toggle focuses the search
				// input, and without it this same keystroke's default action
				// types an "s" into the field it just opened.
				e.preventDefault();
				if (e.key === "t") this.toggleToc();
				else if (e.key === "h") this.pane.toggle();
				else this.toggleBookSearch();
			}
		});

		this.registerDomEvent(document, "mousedown", (e: MouseEvent) => {
			// Book search: a click outside the bar and the results card
			// collapses both.
			if (this.searchOpen) {
				const t = e.target as Node;
				if (!this.searchBarEl?.contains(t) && !this.searchResultsEl?.contains(t)) {
					this.toggleBookSearch(false);
				}
			}
			// The end-click of an extend is resolved on mouseup — never dismiss it.
			if (this.isExtending) return;
			// Shift-click extends the live selection (browser handles the range
			// growth); dismissing here would wipe it before it can extend.
			if (e.shiftKey) return;
			if (!this.isGlossActive()) return;
			const target = e.target as Node;
			if (this.glossSurface.containsNode(target)) return;
			// The wikilink popover lives on document.body, outside the panel —
			// a click there is a suggestion pick, not an outside click.
			if (
				this.glossSurface.suggestOpen &&
				target instanceof Element &&
				target.closest(".suggestion-container")
			)
				return;
			this.dismissGloss();
		});
	}

	/** Push/pop the Esc scope so it's active exactly while this reader is the
	 *  active leaf. `popScope` tolerates out-of-order removal (drops the scope
	 *  from the stack even when it isn't on top), so overlapping reader tabs
	 *  can't corrupt the keymap stack. */
	private syncEscScope(): void {
		if (!this.escScope) return;
		const active = this.app.workspace.getActiveViewOfType(ReaderView) === this;
		if (active === this.escScopePushed) return;
		this.escScopePushed = active;
		if (active) this.app.keymap.pushScope(this.escScope);
		else this.app.keymap.popScope(this.escScope);
	}

	async onClose(): Promise<void> {
		if (this.escScopePushed && this.escScope) this.app.keymap.popScope(this.escScope);
		this.escScopePushed = false;
		this.escScope = null;
		this.pane.abortActiveStream();
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
		this.extendHintEl?.remove();
		this.extendHintEl = null;
		this.isExtending = false;
		this.extendAnchor = null;
		this.annotationPreview.hide();
		this.clearHighlightOverlay();
		if (this.progressTooltipRaf !== null) cancelAnimationFrame(this.progressTooltipRaf);
		this.progressTooltipRaf = null;
		// Flush any pending debounced save so the last position isn't lost on close.
		if (this.positionSaveTimer !== null) {
			window.clearTimeout(this.positionSaveTimer);
			this.positionSaveTimer = null;
		}
		const closePath = this.currentFile?.path ?? this.currentFolder?.path;
		// hasMountedUnit: never flush the 0/0 reset values of a view that got
		// closed before its load finished — see the field doc.
		if (closePath && this.book && this.hasMountedUnit) {
			this.writeBookPosition(closePath);
			void this.plugin.persistSettings();
		}
		this.contentEl.empty();
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as ReaderViewState;
		const filePath = s.state?.file ?? s.file;
		if (filePath) {
			const incomingUnit = s.state?.unitIndex ?? s.unitIndex;
			const incomingSpread = s.state?.spread ?? s.spread;
			const storedPos = this.plugin.settings.bookPositions[filePath];
			// bookPositions outranks the leaf's serialized position. The workspace
			// snapshot goes stale the moment a page turns (page turns never
			// requestSaveLayout), and on plugin reload/update Obsidian rebuilds the
			// leaf from that snapshot — trusting its defined-but-stale zeros sent
			// readers back to the cover on every update. bookPositions is flushed
			// within 800ms of every turn and again on close, so it is always at
			// least as fresh as anything the layout can hand us.
			const savedUnitIndex: number = storedPos?.unitIndex ?? incomingUnit ?? 0;
			const savedSpread: number = storedPos?.spread ?? incomingSpread ?? 0;

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
				// Undocumented but stable leaf-internal history — the only way to
				// know whether this leaf held content before the epub landed in it.
				const hist = (this.leaf as unknown as { history?: { back?: { state: ViewState }[] } }).history;
				if (hist?.back?.length) {
					// The leaf already holds content the user navigated to (e.g. Cmd+O
					// replacing the active tab). Don't clobber it: open the book in a
					// dedicated tab and revert this leaf to where it was.
					const originatingLeaf = this.leaf;
					const restoreState = hist.back[hist.back.length - 1].state;
					void this.plugin.openEpubInNewTab(filePath);
					setTimeout(() => {
						void originatingLeaf.setViewState(restoreState);
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

	getState(): ReaderViewState {
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
		applyGlossTheme(root, this.plugin.settings);
		// Body-scoped floaters stamped once at creation also need to track later
		// mode/theme flips — the extend hint in particular is created lazily and
		// then cached for the life of the view.
		applyGlossTheme(this.tooltipEl, this.plugin.settings);
		applyGlossTheme(this.extendHintEl, this.plugin.settings);
		this.glossSurface.syncTheme();
		this.annotationPreview.syncTheme();
		this.pane.syncTheme();
		this.updateTocFooter();
		requestAnimationFrame(() => this.renderSavedHighlights());
	}

	private updateTocFooter(): void {
		const modeBtn = this.contentEl.querySelector<HTMLElement>(".tmr-toc-mode-btn");
		const themeBtn = this.contentEl.querySelector<HTMLElement>(".tmr-toc-theme-btn");
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

		const helpToggle = root.createEl("button", { cls: "tmr-help-toggle" });
		setIcon(helpToggle, "circle-help");
		helpToggle.ariaLabel = "How to use the reader";
		this.registerDomEvent(helpToggle, "click", () => new HelpModal(this.app).open());

		// Page-turn affordances: floating chevrons at the far edges, revealed on
		// reader hover (same idiom as the panel toggles). advance()/retreat()
		// no-op at the boundaries, so no disabled state is needed.
		const prevPage = root.createEl("button", { cls: "tmr-page-nav tmr-page-nav-prev" });
		setIcon(prevPage, "chevron-left");
		prevPage.ariaLabel = "Previous page";
		this.registerDomEvent(prevPage, "click", () => void this.retreat());

		const nextPage = root.createEl("button", { cls: "tmr-page-nav tmr-page-nav-next" });
		setIcon(nextPage, "chevron-right");
		nextPage.ariaLabel = "Next page";
		this.registerDomEvent(nextPage, "click", () => void this.advance());

		const tocPanel = root.createEl("div", { cls: "tmr-toc" });
		// Closed slide-in panels are translated off-canvas but stay rendered
		// and focusable; inert keeps Tab out of them. Without it, focusing a
		// hidden control makes the browser scroll .view-content sideways to
		// reveal it, shoving the whole reader (overflow:hidden doesn't stop
		// focus-scroll). Synced in toggleToc / toggleHighlightsPanel.
		tocPanel.inert = true;
		const tocHeader = tocPanel.createEl("div", { cls: "tmr-toc-header" });
		this.tocTitleEl = tocHeader.createEl("span", { cls: "tmr-toc-title", text: "Contents" });
		const tocClose = tocHeader.createEl("button", { cls: "tmr-pane-hdr-btn tmr-toc-close" });
		setIcon(tocClose, "x");
		this.registerDomEvent(tocClose, "click", () => this.toggleToc());
		this.tocListEl = tocPanel.createEl("div", { cls: "tmr-toc-list" });

		const tocFooter = tocPanel.createEl("div", { cls: "tmr-toc-footer" });
		const modeBtn = tocFooter.createEl("button", { cls: "tmr-toc-mode-btn" });
		// eslint-disable-next-line no-unsanitized/property -- Safe: LOGO_3C_SVG is a compile-time SVG constant.
		modeBtn.innerHTML = LOGO_3C_SVG;
		this.registerDomEvent(modeBtn, "click", () => void this.toggleTmrMode());
		const themeBtn = tocFooter.createEl("button", { cls: "tmr-toc-theme-btn" });
		this.registerDomEvent(themeBtn, "click", async () => {
			this.plugin.settings.tmrTheme = this.plugin.settings.tmrTheme === "dark" ? "light" : "dark";
			await this.plugin.saveSettings();
		});

		this.makePaneResizable(tocPanel, "right");

		const tocBackdrop = root.createEl("div", { cls: "tmr-toc-backdrop" });
		this.registerDomEvent(tocBackdrop, "click", () => this.toggleToc());

		// Book search — one morphing element (the library-search pattern): a
		// ghost icon button beside the Highlights toggle that expands leftward
		// into the field on open (right-anchored, so width growth IS leftward
		// expansion). Results drop into a separate card beneath it. See the
		// In-Book Search spec + BookSearchButton components.
		const searchBar = root.createEl("div", { cls: "tmr-search-bar" });
		searchBar.ariaLabel = "Search in book";
		const searchIcon = searchBar.createEl("span", { cls: "tmr-search-bar-icon" });
		setIcon(searchIcon, "tmr-icon-book-search");
		this.searchInputEl = searchBar.createEl("input", {
			cls: "tmr-book-search-input",
			attr: { type: "text", placeholder: "Reveal a passage…", spellcheck: "false" },
		});
		// Collapsed to width 0 but still in the DOM — keep it out of the tab
		// order until the bar opens (same focus-leak family as the blur() on
		// close). Synced in toggleBookSearch.
		this.searchInputEl.tabIndex = -1;
		const searchClear = searchBar.createEl("button", { cls: "tmr-book-search-clear" });
		setIcon(searchClear, "x");
		searchClear.ariaLabel = "Clear search";
		this.searchResultsEl = root.createEl("div", { cls: "tmr-book-search tmr-hidden" });
		this.searchBarEl = searchBar;
		this.searchOpen = false;
		this.searchQuery = "";
		this.searchHits = [];
		this.registerDomEvent(searchBar, "click", () => {
			if (!this.searchOpen) this.toggleBookSearch(true);
		});
		this.registerDomEvent(this.searchInputEl, "input", () => {
			const value = this.searchInputEl?.value ?? "";
			if (this.searchDebounce !== null) window.clearTimeout(this.searchDebounce);
			this.searchDebounce = window.setTimeout(() => {
				this.searchDebounce = null;
				this.searchQuery = value;
				void this.renderSearchResults();
			}, 200);
		});
		// Result-list keyboard navigation, combobox-style: focus never leaves
		// the field; ↑/↓ move a virtual active row, Enter jumps to it (first
		// result when nothing is focused yet). preventDefault keeps the arrows
		// from moving the text caret.
		this.registerDomEvent(this.searchInputEl, "keydown", (e: KeyboardEvent) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				this.moveSearchActive(e.key === "ArrowDown" ? 1 : -1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				const hit = this.searchHits[Math.max(0, this.searchActiveIdx)];
				if (hit) void this.jumpToSearchHit(hit);
			}
		});
		// The × clears a non-empty query; on an empty one it collapses the bar
		// (the mock's × is the expanded bar's only affordance).
		this.registerDomEvent(searchClear, "click", (e: MouseEvent) => {
			e.stopPropagation();
			if (this.searchInputEl?.value) {
				this.searchInputEl.value = "";
				this.searchQuery = "";
				void this.renderSearchResults();
				this.searchInputEl.focus();
			} else {
				this.toggleBookSearch(false);
			}
		});
		// Delegated row clicks — rows re-render per keystroke, so a single
		// listener on the host instead of one per row.
		this.registerDomEvent(this.searchResultsEl, "click", (e: MouseEvent) => {
			const row = (e.target as Element).closest<HTMLElement>(".tmr-book-search-row");
			const idx = row ? parseInt(row.dataset.hitIdx ?? "", 10) : NaN;
			const hit = Number.isNaN(idx) ? undefined : this.searchHits[idx];
			if (hit) void this.jumpToSearchHit(hit);
		});

		// Highlights navigation panel — the pane builds its own toggle, panel and
		// backdrop into the shell root, in that order.
		this.pane.mount(root);
		this.applyAiFeaturesState();

		this.spreadEl = root.createEl("div", { cls: "tmr-spread tmr-hidden" });
		this.contentNode = this.spreadEl.createEl("div", { cls: "tmr-content" });
		this.syncSpreadLayoutMode(this.spreadEl);

		this.cacheHost = root.createEl("div", { cls: "tmr-hidden" });
		this.prevHost = this.cacheHost.createEl("div");
		this.nextHost = this.cacheHost.createEl("div");

		this.resizeObserver?.disconnect();
		// Observe the BORDER box, not the default content box. The spread's
		// horizontal padding grows with pane width (gutters), which pins the
		// content box at the line-width cap — a default observer is blind to
		// the pane widening past that cap (Case File 09: sidebars closing
		// never fired a resize, leaving the reader stuck in single-page mode).
		if (this.spreadEl) this.resizeObserver?.observe(this.spreadEl, { box: "border-box" });

		this.registerDomEvent(this.spreadEl, "mouseover", (e: MouseEvent) => {
			const target = e.target as Element;
			const cite = target.closest<HTMLElement>(".tmr-citation");
			const anchor = target.closest<HTMLAnchorElement>("a[href]");
			const ridEl = target.closest<HTMLElement>("[data-rid]");

			if (cite) {
				const text = cite.dataset.citeText;
				if (text) this.renderTooltip(this.buildInlineTextPreview(text), e);
			} else if (anchor) {
				this.handleLinkHover(anchor, e);
			} else if (ridEl?.dataset.rid) {
				const targetEl = this.findTarget(ridEl.dataset.rid);
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
			const anchor = (e.target as Element).closest("a[href]");
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
		// Trackpad two-finger horizontal swipe → page turn, exactly one page per
		// physical swipe. Accumulate horizontal delta and fire once past a
		// threshold, then DISARM. Re-arming is magnitude-based: the momentum tail
		// decays but stays above SWIPE_REARM_FLOOR for its whole duration, so it's
		// ignored; only once the gesture physically settles (near-zero delta) does
		// the next swipe become possible. To page repeatedly, swipe in succession.
		// Vertical-dominant scroll (plain mouse wheel) stays inert.
		const SWIPE_THRESHOLD = 45;
		const SWIPE_IDLE_RESET_MS = 150;
		let swipeAccum = 0;
		let swipeArmed = true;
		let swipeIdleTimer: number | null = null;
		this.registerDomEvent(this.spreadEl, "wheel", (e: WheelEvent) => {
			// Keep navigation transform-driven; native wheel scrolling causes horizontal drift.
			e.preventDefault();
			if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
			// Full stop resets everything (belt-and-braces with the floor re-arm).
			if (swipeIdleTimer !== null) window.clearTimeout(swipeIdleTimer);
			swipeIdleTimer = window.setTimeout(() => {
				swipeAccum = 0;
				swipeArmed = true;
				swipeIdleTimer = null;
			}, SWIPE_IDLE_RESET_MS);
			// While disarmed, swallow every event (the momentum tail keeps resetting
			// the idle timer above) and only re-arm once the wheel stream has fully
			// stopped for SWIPE_IDLE_RESET_MS. Re-arming on a momentary low-delta dip
			// instead would catch the lull at the gesture→momentum handoff and let the
			// inertial tail fire a second page turn — one physical flick, two pages.
			if (!swipeArmed) return;
			// Reversed direction: start counting the new direction fresh.
			if (swipeAccum !== 0 && Math.sign(e.deltaX) !== Math.sign(swipeAccum)) swipeAccum = 0;
			swipeAccum += e.deltaX;
			if (Math.abs(swipeAccum) < SWIPE_THRESHOLD) return;
			swipeArmed = false;
			const dir = swipeAccum;
			swipeAccum = 0;
			if (dir > 0) void this.advance();
			else void this.retreat();
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

	/** Drag-to-resize for this view's slide-in panes (TOC and Highlights).
	 *  The reader's `contentEl` is the bound the pane must stay inside. */
	private makePaneResizable(panel: HTMLElement, edge: "left" | "right"): void {
		makePaneResizable(this, panel, edge, this.contentEl);
	}

	toggleToc(): void {
		this.tocOpen = !this.tocOpen;
		const toc = this.contentEl.querySelector<HTMLElement>(".tmr-toc");
		const backdrop = this.contentEl.querySelector(".tmr-toc-backdrop");
		const toggle = this.contentEl.querySelector(".tmr-toc-toggle");
		// The help button shares the ToC toggle's corner; hide it the same way
		// while the ToC pane is open so it doesn't float over the panel.
		const helpToggle = this.contentEl.querySelector(".tmr-help-toggle");
		if (toc) toc.inert = !this.tocOpen;
		if (this.tocOpen) {
			toc?.addClass("tmr-toc-open");
			backdrop?.addClass("tmr-toc-backdrop-visible");
			toggle?.addClass("tmr-toc-toggle-hidden");
			helpToggle?.addClass("tmr-toc-toggle-hidden");
			requestAnimationFrame(() => {
				const active = this.contentEl.querySelector(".tmr-toc-item.tmr-toc-active");
				active?.scrollIntoView({ block: "center", behavior: "smooth" });
			});
		} else {
			toc?.removeClass("tmr-toc-open");
			backdrop?.removeClass("tmr-toc-backdrop-visible");
			toggle?.removeClass("tmr-toc-toggle-hidden");
			helpToggle?.removeClass("tmr-toc-toggle-hidden");
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

	// ─── Book search (Phase 5 — see In-Book Search feature spec) ─────────────

	toggleBookSearch(force?: boolean): void {
		const open = force ?? !this.searchOpen;
		if (open === this.searchOpen) return;
		this.searchOpen = open;
		this.searchBarEl?.toggleClass("tmr-search-bar-open", open);
		this.searchResultsEl?.toggleClass("tmr-hidden", !open);
		if (this.searchInputEl) this.searchInputEl.tabIndex = open ? 0 : -1;
		if (open) {
			// One transient layer at a time: opening search over a live gloss
			// bar/input dismisses it (mirrors the Escape ordering).
			if (this.isGlossActive()) this.dismissGloss();
			// Kick the lazy index and repaint (instant on later opens — the
			// promise is cached per book; last query persists for the session).
			void this.renderSearchResults();
			this.searchInputEl?.focus();
		} else {
			// A collapsed bar must not keep keyboard focus: the typing guard
			// would swallow the reader hotkeys (s to reopen, t/h, arrows) while
			// every keystroke kept typing into the hidden field.
			this.searchInputEl?.blur();
		}
	}

	private getSearchIndex(): Promise<BookSearchEntry[]> {
		this.searchIndexPromise ??= this.buildSearchIndex();
		return this.searchIndexPromise;
	}

	/** Build the full-book text index from the raw spine XHTML — the same
	 *  source renderSpineRange reads, parsed with DOMParser (nothing rendered
	 *  or mounted). The walk mirrors prepareUnit (same block selector, same
	 *  isRegisterableBlock filter, paraCount reset per spine item) so the
	 *  predicted paraIds line up with the mounted DOM. */
	private async buildSearchIndex(): Promise<BookSearchEntry[]> {
		const book = this.book;
		if (!book) return [];
		const index: BookSearchEntry[] = [];
		const parser = new DOMParser();
		for (let sectionIdx = 0; sectionIdx < this.sections.length; sectionIdx++) {
			const section = this.sections[sectionIdx];
			for (let spine = section.startSpine; spine <= section.endSpine; spine++) {
				const item = book.spine[spine];
				if (!item) continue;
				let raw: string;
				try {
					const filePath = book.opfDir + item.href;
					if (book.zip) raw = await book.zip.file(filePath)!.async("string");
					else if (book.dirPath) raw = await fs.promises.readFile(nodePath.join(book.dirPath, filePath), "utf8");
					else continue;
				} catch { continue; }
				const body = parser.parseFromString(raw, "text/html").querySelector("body");
				if (!body) continue;
				// Mirror renderSpineRange's strip — style/script text must not
				// leak into textContent or offsets drift from the rendered DOM.
				body.querySelectorAll("style, script").forEach((el) => el.remove());
				let paraCount = 0;
				for (const el of Array.from(body.querySelectorAll<HTMLElement>(REGISTERABLE_BLOCK_SELECTOR))) {
					if (!isRegisterableBlock(el)) continue;
					const text = el.textContent ?? "";
					index.push({
						paraId: `s${spine}-p${paraCount}`,
						sectionIdx,
						text,
						textLower: text.toLocaleLowerCase(),
					});
					paraCount++;
				}
			}
		}
		return index;
	}

	private runBookSearch(index: BookSearchEntry[], query: string): BookSearchHit[] {
		const q = query.trim().toLocaleLowerCase();
		if (q.length < SEARCH_MIN_CHARS) return [];
		const hits: BookSearchHit[] = [];
		for (const entry of index) {
			let from = 0;
			let at: number;
			while ((at = entry.textLower.indexOf(q, from)) !== -1) {
				hits.push({ entry, start: at, end: at + q.length });
				from = at + q.length;
				if (hits.length >= SEARCH_MAX_HITS) return hits;
			}
		}
		return hits;
	}

	private async renderSearchResults(): Promise<void> {
		const host = this.searchResultsEl;
		if (!host) return;
		const query = this.searchQuery;
		const index = await this.getSearchIndex();
		// Stale-render guard: query changed or shell rebuilt while indexing.
		if (this.searchResultsEl !== host || this.searchQuery !== query) return;
		host.empty();
		this.searchHits = [];
		this.searchActiveIdx = -1;
		if (query.trim().length < SEARCH_MIN_CHARS) return;
		const hits = this.runBookSearch(index, query);
		this.searchHits = hits;
		if (hits.length === 0) {
			host.createEl("div", { cls: "tmr-book-search-empty", text: "No matches" });
			return;
		}
		const hlRanges = this.savedHighlights.length > 0
			? this.buildSearchHighlightRanges(index)
			: null;
		hits.slice(0, SEARCH_RENDER_CAP).forEach((hit, i) => {
			const row = host.createEl("div", { cls: "tmr-book-search-row" });
			row.dataset.hitIdx = String(i);
			// Hits inside a saved highlight re-add the annotation card's accent
			// bar + mode icon slots; plain hits stay bare.
			const overlap = hlRanges?.get(hit.entry.paraId)
				?.find((r) => hit.start < r.end && hit.end > r.start);
			if (overlap) {
				row.dataset.glossMode = overlap.mode;
				const iconEl = row.createEl("span", { cls: "tmr-book-search-row-icon" });
				const modeMeta = GLOSS_MODES.find((m) => m.id === overlap.mode);
				if (modeMeta) setIcon(iconEl, modeMeta.icon);
			}
			const rowBody = row.createEl("div", { cls: "tmr-book-search-row-body" });
			rowBody.createEl("div", {
				cls: "tmr-book-search-row-section",
				text: this.sections[hit.entry.sectionIdx]?.label ?? "—",
			});
			const snippet = rowBody.createEl("div", { cls: "tmr-book-search-row-snippet" });
			const parts = this.searchSnippet(hit);
			snippet.appendText(parts.before);
			snippet.createEl("strong", { text: parts.match });
			snippet.appendText(parts.after);
		});
		if (hits.length > SEARCH_RENDER_CAP) {
			const capped = hits.length >= SEARCH_MAX_HITS;
			host.createEl("div", {
				cls: "tmr-book-search-more",
				text: `${hits.length - SEARCH_RENDER_CAP}${capped ? "+" : ""} more — refine your search`,
			});
		}
	}

	/** Move the keyboard-focused result row by `delta`, clamped to the rendered
	 *  rows (searchHits can exceed SEARCH_RENDER_CAP; navigation stays within
	 *  what's on screen). Row order matches searchHits order, so the index is
	 *  valid for both styling and the Enter-to-jump lookup. */
	private moveSearchActive(delta: number): void {
		const rows = this.searchResultsEl?.querySelectorAll<HTMLElement>(".tmr-book-search-row");
		if (!rows || rows.length === 0) return;
		const next = Math.max(0, Math.min(rows.length - 1, this.searchActiveIdx + delta));
		if (next === this.searchActiveIdx) return;
		this.searchActiveIdx = next;
		rows.forEach((row, i) => row.toggleClass("tmr-book-search-row-active", i === next));
		rows[next].scrollIntoView({ block: "nearest" });
	}

	/** ±~50 chars of context around the match, snapped to word boundaries. */
	private searchSnippet(hit: BookSearchHit): { before: string; match: string; after: string } {
		const text = hit.entry.text;
		let s = Math.max(0, hit.start - 50);
		let e = Math.min(text.length, hit.end + 50);
		if (s > 0) {
			const sp = text.indexOf(" ", s);
			if (sp !== -1 && sp < hit.start) s = sp + 1;
		}
		if (e < text.length) {
			const sp = text.lastIndexOf(" ", e);
			if (sp > hit.end) e = sp;
		}
		return {
			before: (s > 0 ? "…" : "") + text.slice(s, hit.start),
			match: text.slice(hit.start, hit.end),
			after: text.slice(hit.end, e) + (e < text.length ? "…" : ""),
		};
	}

	/** Char-range highlight coverage per index paragraph, resolved against the
	 *  live savedHighlights[] at render time (they can change mid-session).
	 *  Start paragraphs resolve the way the overlay painter does: paraId hint
	 *  verified against the stored prefix, full scan as fallback; end paragraphs
	 *  are taken from the hint verbatim (same as renderSavedHighlights).
	 *  Cross-paragraph highlights fully cover the paragraphs between their
	 *  boundaries. */
	private buildSearchHighlightRanges(
		index: BookSearchEntry[],
	): Map<string, { mode: string; start: number; end: number }[]> {
		const norm = (s: string) => s.replace(/\s+/g, " ").trim();
		const byId = new Map(index.map((e) => [e.paraId, e] as const));
		const ranges = new Map<string, { mode: string; start: number; end: number }[]>();
		const add = (paraId: string, mode: string, start: number, end: number) => {
			let list = ranges.get(paraId);
			if (!list) ranges.set(paraId, (list = []));
			list.push({ mode, start, end });
		};
		for (const saved of this.savedHighlights) {
			let startEntry = byId.get(saved.paraIdHint) ?? null;
			const needle = norm(saved.prefix);
			if (needle && (!startEntry || !norm(startEntry.text).startsWith(needle))) {
				startEntry = index.find((e) => norm(e.text).startsWith(needle)) ?? startEntry;
			}
			if (!startEntry) continue;
			const endId = saved.endParaIdHint;
			if (!endId || endId === startEntry.paraId) {
				add(startEntry.paraId, saved.mode, saved.startChar, saved.endChar);
				continue;
			}
			add(startEntry.paraId, saved.mode, saved.startChar, startEntry.text.length);
			add(endId, saved.mode, 0, saved.endChar);
			const s = /^s(\d+)-p(\d+)$/.exec(startEntry.paraId);
			const e = /^s(\d+)-p(\d+)$/.exec(endId);
			if (s && e && s[1] === e[1]) {
				for (let p = parseInt(s[2], 10) + 1; p < parseInt(e[2], 10); p++) {
					const mid = byId.get(`s${s[1]}-p${p}`);
					if (mid) add(mid.paraId, saved.mode, 0, mid.text.length);
				}
			}
		}
		return ranges;
	}

	/** Mirror of jumpToHighlight for a search hit — mount the section's unit,
	 *  resolve the paragraph (prefix match with the predicted paraId as hint),
	 *  scroll it into the visible spread. The popover stays open by design. */
	private async jumpToSearchHit(hit: BookSearchHit): Promise<void> {
		const match = /^s(\d+)-p(\d+)$/.exec(hit.entry.paraId);
		if (!match) return;
		const spineIdx = parseInt(match[1], 10);
		const sectionIdx = this.sectionIndexBySpine[spineIdx] ?? -1;
		const section = this.sections[sectionIdx];
		if (!section) return;
		this.savePosition();
		const targetUnitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const spreadOffset = this.getSpreadOffsetInUnitBySectionId(this.units[targetUnitIdx], section.id);
		await this.mountCurrentUnit(targetUnitIdx, spreadOffset);
		const prefix = hit.entry.text.slice(0, 48);
		const resolvedId = this.offsetMap.findParaIdByPrefix(prefix, hit.entry.paraId) ?? hit.entry.paraId;
		const entry = this.offsetMap.get(resolvedId);
		if (entry?.element) this.scrollToTarget(entry.element);
		// Flash on the next frame so the rects measure against settled layout
		// (same reason renderSavedHighlights paints in rAF after a mount).
		requestAnimationFrame(() => this.flashSearchMatch(resolvedId, hit));
		// Keep the walk-every-mention flow: focus returns to the field so the
		// next keystroke refines the query instead of firing a reader hotkey.
		this.searchInputEl?.focus();
	}

	/** Temporary overlay over the jumped-to match (spec: match flash) — without
	 *  it, landing on a dense spread means visually grepping the page. Rides
	 *  the selection-overlay pipeline: char offsets → CursorRange → client
	 *  rects inside .tmr-content. CSS fades the rects; the overlay node is
	 *  removed after the animation (or, under reduced motion, the same timeout
	 *  ends a static flash). */
	private flashSearchMatch(paraId: string, hit: BookSearchHit): void {
		if (!this.contentNode) return;
		this.contentNode.querySelectorAll(".tmr-search-flash-overlay").forEach((n) => n.remove());
		const cursorRange = this.offsetMap.charRangeToCursorRange(paraId, hit.start, hit.end);
		if (!cursorRange) return;
		const overlay = document.createElement("div");
		overlay.className = "tmr-search-flash-overlay";
		const contentRect = this.contentNode.getBoundingClientRect();
		for (const range of this.offsetMap.cursorsToRanges(cursorRange)) {
			for (const r of Array.from(range.getClientRects())) {
				if (r.width === 0 || r.height === 0) continue;
				const rectEl = document.createElement("div");
				rectEl.className = "tmr-search-flash-rect";
				rectEl.style.left = `${r.left - contentRect.left}px`;
				rectEl.style.top = `${r.top - contentRect.top}px`;
				rectEl.style.width = `${r.width}px`;
				rectEl.style.height = `${r.height}px`;
				overlay.appendChild(rectEl);
			}
		}
		if (overlay.childElementCount === 0) return;
		this.contentNode.appendChild(overlay);
		window.setTimeout(() => overlay.remove(), 4600);
	}

	/** Reflect the AI-features master switch across this view: the GlossBar
	 *  collapses to the lone Emphasise tile (Lite) and the Highlights pane hides
	 *  its Annotations/Conversations tab bar, showing only the Annotations list.
	 *  Public so `saveSettings` can fan it out to open views on a toggle. */
	applyAiFeaturesState(): void {
		this.glossSurface.syncModeState();
		this.pane.applyAiFeaturesState();
	}

	/** Toggle the right-rail pane. Public so the plugin's command can reach it
	 *  without knowing the pane exists. */
	toggleHighlightsPane(): void {
		this.pane.toggle();
	}

	/** Open this book's companion annotation doc. Delegates to the pane, which
	 *  owns the header button that does the same thing; exposed here for the
	 *  "Open annotation notes" command. */
	openCompanionDoc(): Promise<void> {
		return this.pane.openCompanionDoc();
	}

	/** Persist the active pane tab into the per-book position record so
	 *  re-opening the book lands on the same tab. Mirrors
	 *  `schedulePositionSave`'s write but is fire-and-forget (debounce-less)
	 *  because tab toggles are user-paced, not stream-of-events. */
	private persistPaneTab(tab: PaneTab): void {
		const path = this.currentFile?.path ?? this.currentFolder?.path;
		if (!path) return;
		const existing = this.plugin.settings.bookPositions[path] ?? {
			unitIndex: this.currentUnitIndex,
			spread: this.currentSpread,
		};
		this.plugin.settings.bookPositions[path] = { ...existing, pane: tab };
		void this.plugin.persistSettings();
	}

	/** Mode-specific system prompt for this book. The template logic is shared
	 *  with the PDF host; only the title differs. */
	private buildAiSystemPrompt(saved: SavedHighlight): string {
		const book = this.book?.title ?? this.currentFile?.basename ?? "the current book";
		return buildGlossSystemPrompt(this.plugin.settings, book, saved);
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
		if (closeHighlightsPanel && this.pane.isOpen) this.pane.toggle();
	}

	private async loadFile(file: TFile, initialPos?: { unitIndex: number; spread: number }): Promise<void> {
		this.resetViewState();
		this.renderShell();
		if (file.extension === "epub") {
			await this.loadEpub(async () => {
				const data = await this.app.vault.readBinary(file);
				return parseEpub(data);
			}, initialPos);
		} else {
			this.showError(`Unsupported file type: .${file.extension}`);
		}
	}

	private async loadFolder(folder: TFolder, initialPos?: { unitIndex: number; spread: number }): Promise<void> {
		this.resetViewState();
		this.renderShell();
		const adapter = this.app.vault.adapter;
		const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
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
		this.lastPositionByBucket.clear();
		this.currentSpread = 0;
		this.currentUnitIndex = 0;
		this.totalSpreads = 1;
		this.hasMountedUnit = false;
		this.posAnchor = null;
		this.previousPosition = null;
		this.measurementBucketKey = "";
		this.mountedUnitKeys.prev = "";
		this.mountedUnitKeys.next = "";
		this.offsetMap.clear();
		this.savedHighlights = [];
		// Drops collapsed-chapter state, the open-note editor, the tab, and any
		// open chat screen (whose dataset idx points into the old book's list).
		this.pane.reset();
		this.layoutMode = "spread";
		this.linkPreviewCache.clear();
		this.linkPreviewPending.clear();
		this.hoveredLinkPreviewKey = null;
		// Book search: index and query are per-book; the popover DOM itself is
		// rebuilt by renderShell right after this.
		this.searchIndexPromise = null;
		this.searchQuery = "";
		this.searchHits = [];
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
			// The initial build runs through the same serial chain as resize
			// rebuilds, so a sidebar toggle during load queues behind it instead
			// of interleaving with it (Case File 08's load-time variant).
			await this.runLayoutPass(async () => {
				await this.waitForStableGeometry();
				// The pass can resume long after it started (rAF suspends while
				// the window is occluded) — the view may have been torn down in
				// the meantime. Building against a dead DOM yields NaN geometry.
				if (!this.spreadEl?.isConnected) return;
				this.layoutMode = this.resolveLayoutMode();
				this.syncSpreadLayoutMode(this.spreadEl);
				// Capture the bucket from the same geometry the measurements are
				// about to use. If geometry shifts mid-build, the queued resize
				// pass sees a different live bucket and rebuilds cleanly.
				this.measurementBucketKey = this.getLayoutBucketKey();
				this.buildSectionIndex();
				await this.buildRenderUnits();
				await this.loadSavedHighlights();
				this.pane.restoreTab();
				if (!this.spreadEl?.isConnected) return; // torn down mid-build
				const startUnit = Math.min(initialPos?.unitIndex ?? 0, Math.max(0, this.units.length - 1));
				const startSpread = initialPos?.spread ?? 0;
				await this.mountCurrentUnit(startUnit, startSpread);
			});
			this.renderToc();
			this.buildProgressSegments();
			this.updateProgress();
			this.showSpread();
			// First book open ever: surface the cheat sheet once, then remember.
			if (!this.plugin.settings.helpShown) {
				this.plugin.settings.helpShown = true;
				void this.plugin.saveSettings();
				new HelpModal(this.app).open();
			}
		} catch (err) {
			// DRM is a known limitation, not a failure — state it plainly and skip
			// the console noise, since there's nothing here to debug.
			if (err instanceof EpubDrmError) {
				this.showError(err.message);
				return;
			}
			console.error("[ThirdMindReader] epub parse error", err);
			this.showError(`Failed to open epub: ${(err as Error).message}`);
		}
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
		this.sectionIndexBySpine = new Array<number>(this.book.spine.length).fill(0);
		this.sections.forEach((section, idx) => {
			this.sectionIndexById.set(section.id, idx);
			for (let s = section.startSpine; s <= section.endSpine; s++) this.sectionIndexBySpine[s] = idx;
		});
	}

	// Geometry key encodes everything pagination actually depends on: the
	// spread's CONTENT-box width/height (clientWidth minus the gutter padding —
	// past the line-width cap extra pane width becomes padding and layout is
	// genuinely unchanged, so above-cap resizes short-circuit instead of
	// triggering a full rebuild), the layout mode, and the column gap (single
	// mode derives its gap from the padding, which varies at equal content box).
	private getLayoutBucketKey(): string {
		if (!this.spreadEl) return "";
		const cs = getComputedStyle(this.spreadEl);
		const rawW = this.spreadEl.clientWidth > 0 ? this.spreadEl.clientWidth : this.contentEl.clientWidth;
		const rawH = this.spreadEl.clientHeight > 0 ? this.spreadEl.clientHeight : this.contentEl.clientHeight;
		const w = rawW - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
		const h = rawH - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
		const mode = this.resolveLayoutMode();
		const gap = Math.round(this.getColumnGap(mode));
		return `${Math.max(0, Math.round(w))}x${Math.max(0, Math.round(h))}@${mode}:${gap}`;
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
		const spread = this.contentEl.createEl("div", { cls: "tmr-spread tmr-measure-host" });
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
		// `innerWidth` comes from float padding math and can run a sub-pixel wider
		// than the pixel-snapped `.tmr-content` box the columns actually live in
		// (this divergence only shows up at fractional UI zoom). Compute the column
		// width against the real box so two columns are guaranteed to fit.
		const usableInner = content.clientWidth > 0 ? Math.min(innerWidth, content.clientWidth) : innerWidth;
		const colWidth = Math.max(100, mode === "single" ? usableInner : (usableInner - gap) / 2);
		// CSS `column-width` is a *minimum*: if the applied value rounds up even a
		// hair past what fits, multicol drops from two columns to one full-width
		// column and the right page is clipped by `overflow: clip`. Apply a value
		// just under the true column width as the minimum so two columns always
		// fit; the returned `colWidth` stays the true rendered width so stride and
		// column-count measurement remain exact.
		const cssColWidth = mode === "single" ? colWidth : Math.max(100, Math.floor(colWidth) - 1);
		content.style.columnWidth = `${cssColWidth}px`;
		content.style.columnGap = `${gap}px`;
		return { innerWidth, colWidth, gap };
	}

	private getSpreadCountForContent(content: HTMLElement, pageWidth: number, gap: number): number {
		const stride = pageWidth + gap;
		if (stride <= 0) return 1;
		return Math.max(1, Math.ceil(content.scrollWidth / stride));
	}

	private getColumnCountForContent(content: HTMLElement, colWidth: number): number {
		// Ink-extent probe, read from the REAL multicol layout. The old probe
		// compared the content's natural height (reflowed as one flat 700px
		// block) against the column height — but fragmentation makes real
		// column consumption exceed flat height: a `break-inside: avoid-column`
		// block that would straddle the column boundary is pushed whole into
		// column 2 even though the flat total fits column 1. Marginal sections
		// (Myth of Sisyphus ToC) mis-classified as one column, pairing trusted
		// it, and the pair's partner rendered in a clipped, unreachable third
		// column. `.tmr-content` fills sequentially (`column-fill: auto`), so
		// ink past the first column's right edge means content truly fragments
		// there — no height heuristic, no extra reflow.
		const range = document.createRange();
		range.selectNodeContents(content);
		const ink = range.getBoundingClientRect();
		if (ink.width <= 0) return 1;
		const left = content.getBoundingClientRect().left;
		// +1px sub-pixel slack (fractional zoom); the 48px column gap keeps the
		// two outcomes unambiguous.
		return ink.right - left <= colWidth + 1 ? 1 : 2;
	}

	private async measureSection(sectionIdx: number): Promise<{ spreads: number; columns: number; fromCache: boolean }> {
		if (!this.book) return { spreads: 1, columns: 1, fromCache: false };
		const section = this.sections[sectionIdx];
		const bucket = this.getLayoutBucketKey();
		const key = `${section.id}@${bucket}`;
		const cached = this.spreadMeasureCache.get(key);
		if (cached) return { ...cached, fromCache: true };

		this.ensureMeasurementNodes();
		if (!this.measurementSpreadEl || !this.measurementContentEl) return { spreads: 1, columns: 1, fromCache: false };

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
		// Column count only gates pairing/singlePage, which test `=== 1`; a
		// multi-spread section can't be single-column, so skip its ink probe.
		const columns = spreads > 1 ? 2 : this.getColumnCountForContent(this.measurementContentEl, colWidth);
		// Cache only if geometry held still across the measurement. The cache
		// persists across resizes now, so a value measured mid-animation must
		// not survive keyed against a bucket it doesn't represent.
		if (this.getLayoutBucketKey() === bucket) {
			this.spreadMeasureCache.set(key, { spreads, columns });
		}
		this.measurementContentEl.empty();
		return { spreads, columns, fromCache: false };
	}

	private async buildRenderUnits(isStale?: () => boolean): Promise<void> {
		if (!this.book) return;
		this.units = [];
		this.unitIndexBySection.clear();
		this.sectionSpreadCounts = new Array<number>(this.sections.length).fill(1);
		this.sectionColumnCounts = new Array<number>(this.sections.length).fill(1);
		this.sectionStartSpreads = new Array<number>(this.sections.length).fill(0);
		this.unitStartSpreads = [];
		this.totalSpreads = 0;

		for (let i = 0; i < this.sections.length; i++) {
			// Superseded by a newer queued pass: stop burning frames on a model
			// that will be rebuilt immediately after. Caller handles the bail.
			if (isStale?.()) return;
			const measured = await this.measureSection(i);
			this.sectionSpreadCounts[i] = measured.spreads;
			this.sectionColumnCounts[i] = measured.columns;
			// Yield a frame only when real measurement work happened — a cache-hit
			// rebuild (returning to a known pane size) runs without pacing.
			if (!measured.fromCache) await new Promise<void>((r) => requestAnimationFrame(() => r()));
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

		this.sectionStartSpreads = new Array<number>(this.sections.length).fill(0);
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

	/** Cache key for a unit's rendered DOM. Spine range, not unit index: unit
	 *  indices shift when pairing changes across rebuilds, but the same spine
	 *  range always renders the same DOM. */
	private unitDomKey(unit: RenderUnit): string {
		return `${unit.startSpine}-${unit.endSpine}`;
	}

	private async getUnitDom(unitIdx: number): Promise<HTMLElement | null> {
		if (!this.book) return null;
		const unit = this.units[unitIdx];
		if (!unit) return null;
		const key = this.unitDomKey(unit);
		const existing = this.unitDomCache.get(key);
		if (existing) return existing;

		const node = document.createElement("div");
		node.className = "tmr-unit";
		await renderSpineRange(this.book, unit.startSpine, unit.endSpine, node);
		this.annotateItalicBlocks(node);
		this.offsetMap.prepareUnit(node);
		this.unitDomCache.set(key, node);
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
		this.buildTocAnchorPageMap();
		this.currentSpread = Math.max(0, Math.min(spread, unit.spreadCount - 1));
		this.goToSpread(this.currentSpread);
		this.renderSavedHighlights();
		this.hideAnnotationPreview();
		await this.mountAdjacentUnits();
		this.updateProgress();
		this.updateTocActive();
		this.hasMountedUnit = true;
		this.schedulePositionSave();
	}

	private async mountAdjacentUnits(): Promise<void> {
		if (!this.prevHost || !this.nextHost) return;
		const prevIdx = this.currentUnitIndex - 1;
		const nextIdx = this.currentUnitIndex + 1;

		const prevKey = this.units[prevIdx] ? this.unitDomKey(this.units[prevIdx]) : "";
		const nextKey = this.units[nextIdx] ? this.unitDomKey(this.units[nextIdx]) : "";

		if (prevIdx >= 0) {
			const prevDom = await this.getUnitDom(prevIdx);
			if (prevDom && this.mountedUnitKeys.prev !== prevKey) {
				this.prevHost.empty();
				this.prevHost.appendChild(prevDom);
				this.mountedUnitKeys.prev = prevKey;
			}
		} else if (this.mountedUnitKeys.prev !== "") {
			this.prevHost.empty();
			this.mountedUnitKeys.prev = "";
		}

		if (nextIdx < this.units.length) {
			const nextDom = await this.getUnitDom(nextIdx);
			if (nextDom && this.mountedUnitKeys.next !== nextKey) {
				this.nextHost.empty();
				this.nextHost.appendChild(nextDom);
				this.mountedUnitKeys.next = nextKey;
			}
		} else if (this.mountedUnitKeys.next !== "") {
			this.nextHost.empty();
			this.mountedUnitKeys.next = "";
		}

		const currentUnit = this.units[this.currentUnitIndex];
		const keep = new Set(
			[currentUnit, this.units[prevIdx], this.units[nextIdx]]
				.filter((u): u is RenderUnit => !!u)
				.map((u) => this.unitDomKey(u)),
		);
		for (const [key, node] of Array.from(this.unitDomCache.entries())) {
			if (!keep.has(key)) {
				node.remove();
				this.unitDomCache.delete(key);
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

	/** Tally reader-driven page-turns toward the Back-pill decay. Turns moving
	 *  away from the return anchor accumulate; once {@link BACK_PILL_COMMIT_TURNS}
	 *  land with no toward-turn in between, the pill is dismissed (the dot stays).
	 *  A turn toward the anchor means the reader is heading back to the origin —
	 *  peeking, not committing — so the count resets and the pill stays put.
	 *  No-op without a live anchor or once already dismissed. Seeks and jumps
	 *  bypass this (they don't route through advance/retreat), which is
	 *  intended — only linear reading commits. */
	private registerReadingTurn(dir: 1 | -1): void {
		if (!this.previousPosition || this.backPillDismissed) return;
		const anchor = (this.unitStartSpreads[this.previousPosition.unitIndex] ?? 0)
			+ this.previousPosition.spread;
		// Commit/peek is relative to the return anchor, not absolute direction:
		// after a backward jump the anchor sits ahead, so paging backward is the
		// reader committing to the new locale. Called post-navigation, so
		// getGlobalSpread() is already the landing spread.
		const movingAway = (this.getGlobalSpread() - anchor) * dir >= 0;
		if (movingAway) {
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
		// Far jumps snap instead of sliding. Animating thousands of px in
		// 250ms reads as a blur at best — and on translucent themes the
		// compositor leaves every intermediate frame as a trail over the
		// transparent backdrop (the conversation-jump "smear"). Only
		// adjacent page turns keep the transition.
		const targetX = clamped * stride;
		const liveTransform = getComputedStyle(this.contentNode).transform;
		const liveX = liveTransform === "none" ? 0 : -new DOMMatrixReadOnly(liveTransform).m41;
		if (Math.abs(liveX - targetX) > stride * 1.5) {
			this.contentNode.addClass("tmr-no-transition");
			this.contentNode.style.transform = `translateX(-${targetX}px)`;
			void this.contentNode.offsetWidth; // commit without transition
			this.contentNode.removeClass("tmr-no-transition");
		} else {
			this.contentNode.style.transform = `translateX(-${targetX}px)`;
		}
		const sectionIdx = this.getCurrentSectionIndex();
		this.spineIndex = this.sections[sectionIdx]?.startSpine ?? 0;
		this.posAnchor = {
			sectionIdx,
			offset: clamped - this.getSpreadOffsetWithinUnit(sectionIdx),
			count: Math.max(1, this.sectionSpreadCounts[sectionIdx] ?? 1),
		};
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
			this.contentNode.style.removeProperty("column-width");
			this.contentNode.style.removeProperty("column-gap");
			this.contentNode.addClass("tmr-single-page");
		} else {
			this.contentNode.removeClass("tmr-single-page");
			this.paginateVisibleContent();
		}
	}

	/** Append a geometry pass to the serial chain. Passes never overlap — a
	 *  rebuild in flight finishes before the next starts — which is the whole
	 *  Case File 08 fix: concurrent passes interleaved on the shared section
	 *  arrays, measurement caches, and measurement DOM node. */
	private runLayoutPass(fn: () => Promise<void>): Promise<void> {
		const run = this.layoutChain.then(fn).catch((err) => {
			console.error("[ThirdMindReader] layout pass failed", err);
		});
		this.layoutChain = run;
		return run;
	}

	/** Debounced ResizeObserver entry point. Coalesces: only the newest queued
	 *  pass runs; a pass superseded while waiting in the chain is skipped, and
	 *  one superseded mid-rebuild bails early via the staleness probe. */
	private queueResize(): void {
		const id = ++this.layoutPassId;
		void this.runLayoutPass(async () => {
			if (id !== this.layoutPassId) return;
			await this.handleResize(() => id !== this.layoutPassId);
		});
	}

	private async handleResize(isStale?: () => boolean): Promise<void> {
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

		// Re-seek from the durable anchor, not from live model state — this
		// pass may run while another has this.units mid-rebuild (see posAnchor).
		const anchor = this.posAnchor;
		const oldSectionIdx = anchor?.sectionIdx ?? this.getCurrentSectionIndex();
		const oldSectionSpreadOffset = anchor?.offset ?? (this.currentSpread - this.getSpreadOffsetWithinUnit(oldSectionIdx));
		const oldSectionCount = anchor?.count ?? Math.max(1, this.sectionSpreadCounts[oldSectionIdx] ?? 1);
		const bucket = this.getLayoutBucketKey();
		if (bucket === this.measurementBucketKey) {
			const unit = this.getCurrentUnit();
			if (unit) this.applyContentLayout(unit);
			else this.paginateVisibleContent();
			this.goToSpread(this.currentSpread);
			return;
		}

		// Remember exactly where we are in the bucket we're leaving, so a
		// round-trip back restores this spot instead of re-deriving it.
		if (this.measurementBucketKey) {
			this.lastPositionByBucket.set(this.measurementBucketKey, {
				unitIndex: this.currentUnitIndex,
				spread: this.currentSpread,
			});
		}

		// Caches are NOT cleared here: measurement entries are keyed by geometry
		// bucket and unit DOM is geometry-independent, so both stay valid across
		// resizes. Returning to a previously-seen pane size is all cache hits.
		await this.buildRenderUnits(isStale);
		if (isStale?.()) {
			// Superseded mid-build: the model is part-built for a bucket we never
			// committed. Blank the key so the successor pass can't short-circuit
			// against it, and let that pass rebuild + remount cleanly.
			this.measurementBucketKey = "";
			return;
		}
		this.measurementBucketKey = bucket;

		const section = this.sections[oldSectionIdx];
		if (!section) {
			// Can't resolve the section — clamp to the nearest valid unit
			// instead of teleporting to the cover.
			await this.mountCurrentUnit(Math.min(this.currentUnitIndex, this.units.length - 1), 0);
			return;
		}

		const targetUnitIdx = this.unitIndexBySection.get(section.id) ?? 0;
		const targetOffset = this.getSpreadOffsetInUnitBySectionId(this.units[targetUnitIdx], section.id);
		const sectionCount = this.sectionSpreadCounts[oldSectionIdx] ?? 1;
		// Scale the in-section offset by the count ratio so a mode flip lands on
		// the equivalent position: spread→single hits the LEFT page of the old
		// spread (s → 2s), single→spread the spread containing the old page
		// (p → ⌊p/2⌋). Same-mode rebuilds scale 1:1 and behave as before.
		const scaledOffset = Math.floor((oldSectionSpreadOffset * sectionCount) / oldSectionCount);
		const targetSpread = targetOffset + Math.max(0, Math.min(scaledOffset, sectionCount - 1));

		// Round-trip restore: units are deterministic per bucket (measurements
		// come from the bucket-keyed cache), so a memo from the last visit to
		// this bucket is exact. Trust it only when the scaled estimate lands on
		// or one spread below it — that window is precisely the floor()'s drift,
		// so real navigation while away (≥1 spread the other way) wins instead.
		const memo = this.lastPositionByBucket.get(bucket);
		if (memo && memo.unitIndex < this.units.length) {
			const memoGlobal = (this.unitStartSpreads[memo.unitIndex] ?? 0) + memo.spread;
			const targetGlobal = (this.unitStartSpreads[targetUnitIdx] ?? 0) + targetSpread;
			const drift = memoGlobal - targetGlobal;
			if (drift >= 0 && drift <= 1) {
				await this.mountCurrentUnit(memo.unitIndex, memo.spread);
				return;
			}
		}
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

	/** Mirrors the `4.5rem` floor of `--tmr-side-pad` in styles.css — keep the two
	 *  in step or the layout breakpoint drifts from the gutters it assumes. */
	private getMinSidePaddingPx(spread: HTMLElement | null = this.spreadEl): number {
		if (!spread) return 72;
		const fontSize = parseFloat(getComputedStyle(spread).fontSize);
		return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 4.5 : 72;
	}

	private getLayoutCandidateWidth(spread: HTMLElement | null = this.spreadEl): number {
		if (!spread) return 0;
		return Math.max(100, spread.clientWidth - this.getMinSidePaddingPx(spread) * 2);
	}

	/** Electron UI-zoom factor (Cmd +/-): 1 at the default scale, >1 zoomed in,
	 *  <1 zoomed out. Falls back to 1 if unavailable. */
	private getZoomFactor(): number {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron's webFrame is only reachable via require() in Obsidian's renderer.
			const { webFrame } = require("electron") as { webFrame: { getZoomFactor: () => number } };
			const factor = webFrame.getZoomFactor();
			return Number.isFinite(factor) && factor > 0 ? factor : 1;
		} catch {
			return 1;
		}
	}

	private resolveLayoutMode(
		candidateWidth = this.getLayoutCandidateWidth(),
		previous: LayoutMode = this.layoutMode,
	): LayoutMode {
		// Decide on the *physical* pane width. `clientWidth` is reported in CSS
		// pixels that shrink as UI zoom (Cmd +/-) rises, but the breakpoint is
		// anchored to the fixed `--tmr-line-width`; comparing the two frames let
		// a non-default UI scale collapse a comfortably-wide window into
		// single-page. Multiplying by the zoom factor ties the decision to the
		// physical window size, so the spread is stable across UI scales (and
		// identical to the old behaviour at the default scale, where factor = 1).
		const physicalWidth = candidateWidth * this.getZoomFactor();
		const readableWidth = this.getReadableLineWidth();
		const minSpreadCol = Math.max(
			ReaderView.SINGLE_PAGE_MIN_SPREAD_COL,
			Math.min(ReaderView.SINGLE_PAGE_MAX_SPREAD_COL, readableWidth * ReaderView.SINGLE_PAGE_BREAK_RATIO),
		);
		const breakpoint = minSpreadCol * 2 + ReaderView.GAP;
		if (previous === "single") {
			return physicalWidth > breakpoint + ReaderView.SINGLE_PAGE_HYSTERESIS ? "spread" : "single";
		}
		return physicalWidth < breakpoint - ReaderView.SINGLE_PAGE_HYSTERESIS ? "single" : "spread";
	}

	private syncSpreadLayoutMode(spread: HTMLElement | null, mode: LayoutMode = this.layoutMode): void {
		if (!spread) return;
		spread.toggleClass("tmr-layout-single", mode === "single");
		// Mirrored onto the root so the footer's `--tmr-side-pad` tracks the
		// spread's — the progress bar spans the reading column, not the pane.
		this.contentEl.toggleClass("tmr-layout-single", mode === "single");
	}

	private getColumnGap(mode: LayoutMode = this.layoutMode, spread: HTMLElement | null = this.spreadEl): number {
		return mode === "single" ? this.getSinglePageGap(spread) : ReaderView.GAP;
	}

	private getNavigationStride(): number {
		return this.getPageWidth() + this.getColumnGap();
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
		const spineHost = anchor.closest<HTMLElement>(".tmr-spine-item");
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

	private async navigateToHref(href: string): Promise<void> {
		if (!this.book) return;
		this.savePosition();
		const [rawPath, fragment] = href.split("#", 2);
		const currentItem = this.book.spine[this.spineIndex];
		const currentDir = currentItem?.href.includes("/")
			? currentItem.href.substring(0, currentItem.href.lastIndexOf("/") + 1)
			: "";
		const resolved = rawPath ? resolveRelativePath(currentDir + rawPath) : currentItem?.href ?? "";
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

	/** The gloss mode a numeric shortcut (1–5) maps to right now, or null if the
	 *  shortcut isn't currently actionable: the GlossBar is hidden, a mode input
	 *  panel is open (the number belongs to that field), or the mode is suppressed
	 *  in Lite mode. Mirrors the GlossBar tile order. Used by the gloss commands'
	 *  checkCallback so `1`–`5` only fire over a live selection. */
	glossShortcutMode(slot: number): string | null {
		return this.glossSurface.shortcutMode(slot);
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
		this.glossSurface.hideInput();
		this.glossSurface.showBar(anchorRect, this.selectionReachesSpreadEnd(sel));
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
		this.glossSurface.hideBar();
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
		applyGlossTheme(el, this.plugin.settings);
		this.extendHintEl = el;
		return el;
	}

	private showExtendHint(): void {
		this.ensureExtendHint().removeClass("tmr-hidden");
	}

	private hideExtendHint(): void {
		this.extendHintEl?.addClass("tmr-hidden");
	}

	openGlossInput(modeId: string): void {
		if (!this.activeHighlight || !this.activeSelectionRect) return;
		this.glossSurface.openInput(modeId, this.activeSelectionRect);
	}

	/** A gloss tile was submitted. `text` is already trimmed and validated by the
	 *  surface (only Emphasise may be empty). */
	private async onGlossSubmit(mode: string, userText: string): Promise<void> {
		const highlight = this.activeHighlight;
		if (!highlight) return;
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
		// initial AI call is fired into the now-open chat's live log so the first
		// turn streams token-by-token like every follow-up.
		if (GLOSS_AI_MODES.has(mode)) {
			if (!this.pane.isOpen) this.pane.toggle();
			this.pane.setTab("conversations");
			const idx = this.savedHighlights.length - 1;
			this.pane.openConversation(idx);
			const saved = this.savedHighlights[idx];
			if (saved) this.pane.runInitialExchange(saved);
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
		const file = await ensureCompanionDoc(
			this.app,
			path,
			this.book?.title ?? this.currentFile?.basename ?? "Book",
			this.currentFile ? `[[${this.currentFile.path}]]` : "",
		);
		if (!file) return;
		await appendCallout(this.app, file, callout);

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
		try {
			const file = this.app.vault.getFileByPath(path);
			if (!file) return;
			const content = await this.app.vault.cachedRead(file);
			this.savedHighlights = parseSavedHighlights(content);
		} catch (err) {
			console.error("[ThirdMindReader] loadSavedHighlights failed", err);
		} finally {
			// Companion-doc existence is now resolved for this book — sync the
			// note button (it may not exist yet for a never-annotated book).
			this.pane.refreshCompanionDocButton();
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
		this.pane.refreshCompanionDocButton();
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
			}
			if (!cursorRange) continue;

			for (const range of this.offsetMap.cursorsToRanges(cursorRange)) {
				for (const r of Array.from(range.getClientRects())) {
					if (r.width === 0 || r.height === 0) continue;
					const rectEl = document.createElement("div");
					rectEl.className = "tmr-saved-highlight-rect";
					if (idx === this.pane.activeConversationIdx) {
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
	 *  The shared preview tracks its own index so the DOM isn't rebuilt as the
	 *  pointer moves across rects belonging to the same highlight. */
	private handleAnnotationHover(e: MouseEvent): void {
		// Footnote refs, citations and links summon their own floater via the
		// spread's mouseover handler — give that one priority instead of
		// stacking the annotation preview beneath it (both fire when the ref
		// sits inside a saved highlight's rect).
		const hoverEl = e.target instanceof Element ? e.target : null;
		const overlay = this.contentNode?.querySelector(".tmr-saved-highlight-overlay");
		if (
			hoverEl?.closest(".tmr-citation, a[href], [data-rid]") ||
			!overlay ||
			this.savedHighlights.length === 0
		) {
			this.hideAnnotationPreview();
			return;
		}

		const matchedIdx = hitTestHighlightRects(overlay, e.clientX, e.clientY);
		const saved = matchedIdx === -1 ? null : this.savedHighlights[matchedIdx];
		if (!saved) {
			this.hideAnnotationPreview();
			return;
		}
		this.annotationPreview.showFor(matchedIdx, saved, e.clientX, e.clientY);
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

		const matchedIdx = hitTestHighlightRects(overlay, e.clientX, e.clientY);
		if (matchedIdx === -1) return false;

		const saved = this.savedHighlights[matchedIdx];
		if (!saved || !GLOSS_AI_MODES.has(saved.mode)) return false;

		// Bare-flagged callouts (Exclaim/Enquiry with no prompt and no AI
		// turn) only show in the Conversations list when the corresponding
		// quick-settings toggle is on. Without it, expanding the card would
		// not be visible — so respect that and bail.
		if (
			this.pane.isBareFlagged(saved) &&
			!this.plugin.settings.showBareFlaggedConversations
		) {
			return false;
		}

		if (!this.pane.isOpen) this.pane.toggle();
		this.pane.setTab("conversations");
		this.pane.openConversation(matchedIdx);
		return true;
	}

	private hideAnnotationPreview(): void {
		if (this.annotationPreview.hoveredIdx !== -1) this.annotationPreview.hide();
	}

	private getCompanionDocPath(): string | null {
		if (!this.book && !this.currentFile) return null;
		return companionDocPath(this.book?.title || this.currentFile?.basename || "Book");
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

		const header = calloutHeader(quote, sectionLabel, `¶${paraIdx}`);

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

		return buildCallout({ modeId, header, anchor, quote, userText });
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
		this.glossSurface.hide();
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
		applyGlossTheme(el, this.plugin.settings);
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
			const text = (el.textContent ?? "").trim().replace(/^\d+[.)]\s*/, "");
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
			const img = createEl("img");
			img.src = preview.imageSrc;
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

		tooltip.setCssProps({ left: "0px", top: "0px", visibility: "hidden" });
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
		tooltip.setCssProps({ left: `${x}px`, top: `${y}px`, visibility: "" });
	}

	private hideTooltip(): void {
		if (!this.tooltipEl) return;
		this.tooltipEl.setCssProps({ visibility: "" });
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
			const fill = seg.querySelector<HTMLElement>(".tmr-progress-segment-fill");
			if (!fill) return;
			const start = this.sectionStartSpreads[sectionIdx] ?? 0;
			const count = this.sectionSpreadCounts[sectionIdx] ?? 1;
			const end = start + count - 1;
			if (globalSpread > end) {
				fill.setCssProps({ width: "100%" });
				seg.addClass("tmr-progress-complete");
				seg.removeClass("tmr-progress-current");
			} else if (globalSpread >= start) {
				const local = globalSpread - start;
				fill.setCssProps({ width: `${((local + 1) / count) * 100}%` });
				seg.removeClass("tmr-progress-complete");
				seg.addClass("tmr-progress-current");
			} else {
				fill.setCssProps({ width: "0%" });
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
		const seg = (e.target as Element).closest<HTMLElement>(".tmr-progress-segment");
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
		const seg = (e.target as Element).closest<HTMLElement>(".tmr-progress-segment");
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
		// A pass racing a rebuild (or a view torn down mid-load) can hold
		// transient garbage — never persist it.
		if (!Number.isFinite(this.currentUnitIndex) || !Number.isFinite(this.currentSpread)) return;
		const existing = this.plugin.settings.bookPositions[path] ?? {};
		// totalSpreads <= 1 means the pagination model isn't live yet (mid-load
		// or mid-rebuild): getProgressFraction() would report 1 ("finished").
		// Keep the previous pct; genuine one-spread books still get 1 on their
		// first save because existing.pct starts undefined.
		const livePct = this.getProgressFraction();
		const pct = this.totalSpreads > 1 ? livePct : (existing.pct ?? livePct);
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
		const backBtn = this.contentEl.querySelector<HTMLElement>(".tmr-progress-back");
		const marker = this.contentEl.querySelector<HTMLElement>(".tmr-progress-back-marker");
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
			? this.progressBarEl.querySelector<HTMLElement>(`.tmr-progress-segment[data-section="${sectionIdx}"]`)
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

	/** PDF Gloss manager — desktop only, absent when the platform gate declines.
	 *  Held so settings changes and the pane command can reach attached PDFs. */
	private pdfGloss: PdfGlossManager | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		// Obsidian's bundled Lucide set predates `book-search` — register the
		// glyph ourselves (Lucide 24-grid paths scaled onto Obsidian's 100-grid).
		// setIcon stamps this id as a class on the svg, so it must not collide
		// with any element class (`.tmr-book-search` is the results card).
		addIcon(
			"tmr-icon-book-search",
			'<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/><circle cx="10.5" cy="8" r="2.5"/><path d="m13.3 10.8 1.7 1.7"/></g>',
		);
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

		// Intercept epub clicks so a book always lands in its own tab instead of
		// replacing the active leaf (mirrors Cmd+Click). Two sources: the file
		// explorer, and internal links inside notes — `.internal-link[data-href]`
		// covers reading-view anchors and the rendered `source:` property link on
		// every companion doc, which is the link a reader actually clicks.
		// Runs in capture phase so it fires before Obsidian's own click handler.
		// Modified clicks fall through untouched: Cmd/Alt/Shift already carry
		// their own destination (new tab, split, window) and shouldn't be hijacked.
		this.registerDomEvent(document, "click", (e: MouseEvent) => {
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			const target = e.target as Element;
			const fileTitle = target.closest<HTMLElement>(".nav-file-title");
			// `a[data-href]` is deliberately narrow — the reader's own ToC rows are
			// `div[data-href]` carrying epub-internal hrefs, not vault paths.
			const link = target.closest<HTMLElement>(".internal-link[data-href], a[data-href]");
			const href =
				fileTitle?.dataset.path ??
				fileTitle?.closest<HTMLElement>(".nav-file")?.dataset.path ??
				link?.dataset.href;
			if (!href) return;
			// Drop any `#heading` / `^block` subpath before the extension test.
			const linkpath = getLinkpath(href);
			if (!linkpath.endsWith(".epub")) return;
			const file = this.app.metadataCache.getFirstLinkpathDest(
				linkpath,
				this.app.workspace.getActiveFile()?.path ?? "",
			);
			if (!(file instanceof TFile)) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			void this.openEpubInNewTab(file.path);
		}, { capture: true });

		this.registerVaultEvents();

		// PDF Gloss: augment Obsidian's native PDF viewer with the same GlossBar.
		// Desktop-only for now (mobile PDF belongs to the Phase 5.5 track), and
		// internally feature-gated — an unrecognised viewer simply stays native.
		if (Platform.isDesktopApp) {
			this.pdfGloss = new PdfGlossManager(
				this.app, () => this.settings, () => this.saveSettings(),
			);
			this.addChild(this.pdfGloss);
		}

		this.app.workspace.onLayoutReady(() => void this.repairCompanionSourceLinks());
	}

	/** Companion docs created before 2026-07-24 wrote `source:` unquoted, which
	 *  YAML parses as a nested list — the wikilink never resolved, so the note
	 *  had no graph edge to its book. Quote the value wherever the old form
	 *  survives. Runs each load; no-ops once every doc is migrated. */
	private async repairCompanionSourceLinks(): Promise<void> {
		const folder = this.app.vault.getFolderByPath(LIBRARY_ROOT + "/Annotations");
		if (!folder) return;
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			try {
				const content = await this.app.vault.cachedRead(child);
				const fmEnd = content.indexOf("\n---", 4);
				if (!content.startsWith("---\n") || fmEnd === -1) continue;
				if (!/^source: \[\[.*\]\][ \t]*$/m.test(content.slice(0, fmEnd))) continue;
				await this.app.vault.process(child, (doc) =>
					doc.replace(/^source: (\[\[.*\]\])[ \t]*$/m, 'source: "$1"'),
				);
			} catch (err) {
				console.error("[ThirdMindReader] source-link repair failed", child.path, err);
			}
		}
	}

	/** Create the `Library/` root on load if it's missing, so a fresh install
	 *  has the folder the empty-state prompt tells users to drop epubs into.
	 *  Idempotent and tolerant of a parallel creation race. */
	private async ensureLibraryFolder(): Promise<void> {
		if (this.app.vault.getFolderByPath(LIBRARY_ROOT)) return;
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
			// No default hotkey: `s` toggles it from inside the reader (see the
			// view-scoped keydown listener); the command exists so users can
			// bind their own combo — including Cmd+F, which we deliberately
			// don't claim by default (it would shadow Obsidian's own search).
			id: "search-in-book",
			name: "Search in book",
			checkCallback: (checking) => {
				const v = this.activeReaderView();
				if (!v) return false;
				if (!checking) v.toggleBookSearch();
				return true;
			},
		});
		this.addCommand({
			// No default hotkey: `h` toggles it from inside the reader and from a
			// PDF (both view-scoped keydown listeners); the command exists so the
			// pane is reachable by a bindable combo, and it is the only affordance
			// users of a customised PDF toolbar may have.
			id: "toggle-highlights-pane",
			name: "Toggle highlights & annotations pane",
			checkCallback: (checking) => {
				const reader = this.activeReaderView();
				const pdf = this.pdfGloss?.activeController() ?? null;
				if (!reader && !pdf) return false;
				if (!checking) {
					if (reader) reader.toggleHighlightsPane();
					else pdf?.togglePane();
				}
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
		// `url` is a base64 data URL baked into main.js at build time (see the
		// font imports at the top of this file), so the @font-face sources are
		// self-contained and render wherever the plugin runs — no reliance on a
		// fonts/ folder on disk, which BRAT never delivers to testers.
		const faces: { family: string; weight: string; style: string; url: string }[] = [
			{ family: "Rosarivo", weight: "400", style: "normal", url: RosarivoRegular },
			{ family: "Rosarivo", weight: "400", style: "italic", url: RosarivoItalic },
			{ family: "Labrada", weight: "100 900", style: "normal", url: LabradaRegular },
			{ family: "Labrada", weight: "100 900", style: "italic", url: LabradaItalic },
			{ family: "Kode Mono", weight: "400 700", style: "normal", url: KodeMono },
		];
		const css = faces.map(({ family, weight, style, url }) =>
			`@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: ${style}; src: url("${url}") format("truetype"); }`
		).join("\n");

		// obsidianmd/no-forbidden-elements is switched off for this file in
		// eslint.config.mjs because of this one site: the @font-face data-URLs
		// are compiled into main.js (esbuild dataurl loader), so this CSS only
		// exists at runtime and can't live in styles.css.
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
			await this.app.workspace.revealLeaf(existing);
			return;
		}
		this._openingEpub = true;
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: READER_VIEW_TYPE,
			active: true,
			state: { file: filePath },
		});
		await this.app.workspace.revealLeaf(leaf);
		this._openingEpub = false;
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<ThirdMindReaderSettings> | null;
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
		this.pdfGloss?.applySettings();
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
		await workspace.revealLeaf(leaf);
	}
}

// ─── REGION: Settings Tab ────────────────────────────────────────────────────
/** Plugin settings tab. AI provider configuration only — theme/3C-mode
 *  toggles live in the ToC footer (per-leaf, immediate-effect surface).
 *
 *  Each provider is rendered as an inline editor with a "Test connection"
 *  button (calls `probeProvider()`) and a delete affordance. The default-
 *  model picker selects which provider new conversations use; every mode
 *  falls through to `primaryProviderId`. */
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

		// ── Providers list ───────────────────────────────────────────────
		new Setting(containerEl).setName("AI providers").setHeading();

		// ── Add provider (cloud + local, one dropdown) ───────────────────
		// Local-first: TMR prioritises on-device inference, so LM Studio /
		// Ollama lead the list and LM Studio is the default selection.
		let pendingProvider = "lm-studio";
		new Setting(containerEl)
			.setName("Add provider")
			.setDesc("Local options use an OpenAI-compatible endpoint with the default port prefilled (LM Studio :1234, Ollama :11434). Anthropic and OpenAI need an API key.")
			.addDropdown(d => d
				.addOption("lm-studio", "LM Studio (local)")
				.addOption("ollama", "Ollama (local)")
				.addOption("generic", "OpenAI-compatible (local)")
				.addOption("anthropic", "Anthropic")
				.addOption("openai", "OpenAI")
				.setValue(pendingProvider)
				.onChange(v => { pendingProvider = v; }))
			.addButton(b => b.setButtonText("Add").setCta().onClick(() => {
				switch (pendingProvider) {
					case "ollama": return this.addProvider("openai-compatible", "ollama");
					case "generic": return this.addProvider("openai-compatible", "generic");
					case "anthropic": return this.addProvider("anthropic");
					case "openai": return this.addProvider("openai");
					default: return this.addProvider("openai-compatible", "lm-studio");
				}
			}));

		if (this.plugin.settings.aiProviders.length === 0) {
			containerEl.createEl("div", {
				cls: "setting-item-description",
				text: "No providers configured. Add one above — local providers (LM Studio, Ollama) need only an endpoint URL; Anthropic and OpenAI need an API key.",
			});
		}
		for (let i = 0; i < this.plugin.settings.aiProviders.length; i++) {
			this.renderProviderEditor(containerEl, i);
		}

		// ── Default model ────────────────────────────────────────────────
		// Sits below the providers list: the natural flow is add a provider
		// first, then pick which one is the default.
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
				.onClick(() => void pickModel(this.app, provider, (model) => {
					provider.defaultModel = model;
					modelText?.setValue(model);
					void this.plugin.saveSettings();
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
			const cb = row.createEl("input");
			cb.type = "checkbox";
			cb.checked = entry.checked;
			cb.addEventListener("change", () => { entry.checked = cb.checked; });
			row.createSpan({ cls: "tmr-settings-import-entry-name", text: entry.name });
			row.createSpan({ cls: "tmr-settings-import-entry-arrow", text: "→" });
			const nameInput = row.createEl("input");
			nameInput.type = "text";
			nameInput.className = "tmr-settings-import-entry-rename";
			nameInput.value = entry.finalName;
			nameInput.addEventListener("input", () => { entry.finalName = nameInput.value; });
		}

		const footer = container.createEl("div", { cls: "tmr-settings-import-footer" });
		const statusEl = footer.createEl("div", { cls: "tmr-settings-import-status" });
		const btn = footer.createEl("button", { cls: "mod-cta", text: "Import selected" });
		const onImportClick = async () => {
			const toImport = this.importEntries.filter(e => e.checked);
			if (!toImport.length) { new Notice("No books selected."); return; }
			btn.disabled = true;
			btn.textContent = "Importing…";
			const imported = await this.importBooks(toImport, statusEl);
			btn.textContent = "Import selected";
			btn.disabled = imported > 0;
		};
		btn.addEventListener("click", () => void onImportClick());
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
		const adapter = this.plugin.app.vault.adapter;
		const vaultBase = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
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
			const safe = sanitizeFileName(entry.finalName || entry.name);
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
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron's remote dialog is only reachable via require() in Obsidian's renderer.
			const electron = require("electron") as {
				remote?: {
					dialog?: {
						showOpenDialog: (opts: {
							properties: string[];
							filters: { name: string; extensions: string[] }[];
							title: string;
						}) => Promise<{ canceled: boolean; filePaths: string[] }>;
					};
				};
			};
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

/** PDF Gloss — the GlossBar annotation grammar on Obsidian's *native* PDF
 *  viewer. See `Feature Docs/PDF Gloss - Feature Spec.md`.
 *
 *  We never re-render a PDF and never patch native behaviour: this module only
 *  adds listeners and DOM on top of the viewer Obsidian already ships. The
 *  anchor is Obsidian's own `#page=N&selection=a,b,c,d` deep-link format, so a
 *  TMR callout links back into the PDF for every other part of the app too.
 *
 *  Everything here rides undocumented internals (`PDFViewerChild`). They are
 *  feature-detected up front by {@link supportsPdfGloss}: any miss and we simply
 *  don't attach, leaving a fully working native viewer. Degrade to "no PDF
 *  gloss", never to a broken PDF.
 */

import { App, Component, Notice, Platform, TAbstractFile, TFile, View, setIcon, setTooltip } from "obsidian";
import {
	ANCHOR_PREFIX_LEN,
	AnnotationPreview,
	GLOSS_AI_MODES,
	GlossSurface,
	type SavedHighlight,
	appendCallout,
	applyGlossTheme,
	buildCallout,
	calloutHeader,
	ensureCompanionDoc,
	getSafeViewport,
	hitTestHighlightRects,
	isTextInputFocused,
	parseSavedHighlights,
	registerTouchSelectionRaise,
} from "./gloss";
import {
	HighlightsPane,
	buildGlossSystemPrompt,
	makePaneResizable,
	type HighlightsPaneHost,
	type HighlightsPaneSettings,
} from "./highlights-pane";
import { companionDocPath } from "./library-scan";

// ─── Native viewer internals (undocumented; feature-detected before use) ─────

interface PdfTextLayer {
	highlighter?: { textDivs?: HTMLElement[] };
}

interface PdfPageView {
	textLayer?: PdfTextLayer;
}

interface PdfEventBus {
	on(name: string, cb: (e: { pageNumber?: number }) => void): void;
	off(name: string, cb: (e: { pageNumber?: number }) => void): void;
}

/** The slice of Obsidian's `PDFViewerChild` we depend on. Signatures
 *  cross-checked against PDF++'s `typings.d.ts`. */
interface PdfViewerChild {
	containerEl: HTMLElement;
	file: TFile | null;
	toolbar?: PdfToolbar;
	/** Obsidian's wrapper around pdf.js. The scrolling element is pdf.js's own
	 *  `container` (`.pdf-viewer-container`), one level deeper — the wrapper has
	 *  no `container` of its own. */
	pdfViewer: {
		eventBus: PdfEventBus;
		pdfViewer?: { container?: HTMLElement; pagesCount?: number };
	};
	/** Four comma-separated ints over the page's text divs —
	 *  `beginIndex,beginOffset,endIndex,endOffset`. Null when the current
	 *  selection doesn't resolve inside `pageEl`. */
	getTextSelectionRangeStr(pageEl: HTMLElement): string | null;
	highlightText(page: number, range: [[number, number], [number, number]]): void;
	clearTextHighlight(): void;
	applySubpath(subpath: string): void;
	getPage(page: number): PdfPageView | null;
	getMarkdownLink?(subpath: string, alias?: string): string;
}

/** The native PDF toolbar. Only the right-hand button strip matters to us —
 *  it's where the Highlights toggle goes (the reader's hover-reveal floating
 *  button has no equivalent affordance here, and the toolbar is the native
 *  place a viewer action belongs). Optional throughout: absence just means no
 *  toolbar button, not a broken attach. */
interface PdfToolbar {
	toolbarRightEl?: HTMLElement;
}

interface PdfViewerComponent {
	child?: PdfViewerChild;
	then(cb: (child: PdfViewerChild) => void): void;
}

interface PdfView extends View {
	viewer?: PdfViewerComponent;
	/** `.view-content`, and the same element as `child.containerEl`. Declared here
	 *  because it lives on `ItemView`, not `View`. Stable across viewer rebuilds,
	 *  which `child` is not — so it's what we watch for one. */
	contentEl: HTMLElement;
}

/** Every internal the controller touches, across all PDF Gloss phases. One
 *  missing member → no attach at all, rather than a half-working surface that
 *  breaks somewhere later. */
function supportsPdfGloss(child: unknown): child is PdfViewerChild {
	const c = child as Partial<PdfViewerChild> | null | undefined;
	return (
		!!c &&
		c.containerEl instanceof HTMLElement &&
		typeof c.getTextSelectionRangeStr === "function" &&
		typeof c.highlightText === "function" &&
		typeof c.clearTextHighlight === "function" &&
		typeof c.applySubpath === "function" &&
		typeof c.getPage === "function" &&
		typeof c.pdfViewer?.eventBus?.on === "function"
	);
}

// ─── Manager: attach a controller to every PDF view ──────────────────────────

/** Watches the workspace for PDF leaves and gives each one a
 *  {@link PdfGlossController}. Controllers are added as children of their view,
 *  so they unload with the leaf; the manager only handles discovery and the
 *  "this view swapped to a different file" case. */
export class PdfGlossManager extends Component {
	/** Strong map, deliberately: a controller is parented to its *view*, so the
	 *  view's lifecycle (not the plugin's) is what unloads it. On plugin
	 *  unload/reload we must therefore detach every one ourselves, which means
	 *  holding a real reference to each. Entries for closed leaves are pruned on
	 *  each scan so this doesn't pin dead views. */
	private controllers = new Map<View, PdfGlossController>();
	/** Views with a `viewer.then` callback already queued. `then` accumulates
	 *  callbacks, so without this a scan storm would register dozens. */
	private awaiting = new WeakSet<View>();
	/** One per PDF view, watching `contentEl`'s direct children. A plugin that
	 *  patches `PDFViewerChild` applies its patches by reloading every open viewer
	 *  (PDF++ does `viewer.unload(); viewer.load(); viewer.loadFile()`), which
	 *  discards the child and empties `contentEl` while firing no workspace event
	 *  — leaving us bound to a dead child. `contentEl` survives and holds only
	 *  four direct children, so childList on it is a precise "viewer rebuilt"
	 *  signal. */
	private observers = new Map<View, MutationObserver>();

	constructor(
		private app: App,
		private settings: () => HighlightsPaneSettings,
		private saveSettings: () => Promise<void>,
		/** Report a page-based reading fraction for a PDF, so its Library card
		 *  tracks progress the way an epub's does. */
		private onProgress: (path: string, pct: number) => void,
	) {
		super();
	}

	/** The controller for the PDF view the user is currently in, if any. Lets
	 *  the plugin's commands reach the pane the same way `activeReaderView`
	 *  reaches the reader's. */
	activeController(): PdfGlossController | null {
		const view = this.app.workspace.activeLeaf?.view;
		return (view && this.controllers.get(view)) ?? null;
	}

	/** Fan a settings change out to every attached PDF view — the mirror of
	 *  `saveSettings`' sweep over open reader views. */
	applySettings(): void {
		for (const controller of this.controllers.values()) controller.applySettings();
	}

	onload(): void {
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scan()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scan()));
		this.app.workspace.onLayoutReady(() => this.scan());
	}

	onunload(): void {
		// Without this, a plugin reload leaves live controllers attached to every
		// open PDF view — old listeners running against a dead plugin, and a
		// second controller stacked on top when the new instance attaches.
		for (const [view, controller] of this.controllers) view.removeChild(controller);
		this.controllers.clear();
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
	}

	private scan(): void {
		const live = new Set(this.app.workspace.getLeavesOfType("pdf").map((l) => l.view));
		for (const view of Array.from(this.controllers.keys())) {
			if (!live.has(view)) this.controllers.delete(view);
		}
		for (const [view, observer] of Array.from(this.observers)) {
			if (!live.has(view)) {
				observer.disconnect();
				this.observers.delete(view);
			}
		}
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) this.consider(leaf.view as PdfView);
	}

	/** Re-run {@link consider} whenever the viewer's DOM is rebuilt under us.
	 *  Idempotent; the observer outlives any individual controller, which is the
	 *  point — the controller is what gets orphaned. */
	private watch(view: PdfView): void {
		if (this.observers.has(view) || !(view.contentEl instanceof HTMLElement)) return;
		const observer = new MutationObserver(() => this.consider(view));
		observer.observe(view.contentEl, { childList: true });
		this.observers.set(view, observer);
	}

	private consider(view: PdfView): void {
		if (!view) return;
		this.watch(view);
		const viewer = view.viewer;
		// Deferred view (Obsidian 1.7+): the viewer doesn't exist until the leaf
		// actually loads. Never force it — a later scan will catch it.
		if (!viewer || typeof viewer.then !== "function") return;

		if (viewer.child) {
			this.attach(view, viewer.child);
			return;
		}
		if (this.awaiting.has(view)) return;
		this.awaiting.add(view);
		viewer.then((child) => {
			this.awaiting.delete(view);
			this.attach(view, child);
		});
	}

	private attach(view: PdfView, child: PdfViewerChild): void {
		const existing = this.controllers.get(view);
		if (existing) {
			// Same document, and our DOM is still in it — already wired. The button
			// is still re-asserted: the toolbar is rebuilt on reload and can arrive
			// after the child does, so an earlier mount may have had nowhere to put it.
			if (existing.child === child && existing.isMounted()) {
				existing.ensureToolbarButton();
				return;
			}
			// Either the leaf swapped files, or the viewer was reloaded under us and
			// emptied `contentEl`. Both leave the old child (and its DOM) dead.
			view.removeChild(existing);
			this.controllers.delete(view);
		}
		if (!supportsPdfGloss(child)) return;
		const controller = new PdfGlossController(
			this.app, this.settings, this.saveSettings, child, view, this.onProgress,
		);
		this.controllers.set(view, controller);
		view.addChild(controller);
	}
}

// ─── Controller: one attached PDF view ───────────────────────────────────────

/** A resolved same-page selection, held between `mouseup` and submit. */
interface PendingSelection {
	/** 1-indexed page number, from `pageEl.dataset.pageNumber`. */
	page: number;
	/** `[beginIndex, beginOffset, endIndex, endOffset]` over the page's text divs. */
	sel: [number, number, number, number];
	/** The selected text, whitespace-normalised (PDF text layers break per
	 *  rendered line, so the raw string is full of incidental newlines). */
	text: string;
	rect: DOMRect;
}

export class PdfGlossController extends Component {
	private surface: GlossSurface | null = null;
	private preview: AnnotationPreview | null = null;
	private pane: HighlightsPane | null = null;
	/** Body-scoped floater for `[N]` citation pills. The reader hands the pane
	 *  its own richer tooltip; a PDF has none, so the controller owns this one. */
	private citationTipEl: HTMLElement | null = null;
	private pending: PendingSelection | null = null;
	/** Every entry parsed from the companion doc, in document order — including
	 *  non-PDF ones, so `data-highlight-idx` indexes the same list the pane will
	 *  use in Phase D. Non-PDF entries are simply skipped at paint time. */
	private saved: SavedHighlight[] = [];
	private unloaded = false;
	/** Non-zero while a submit is in flight. `reloadHighlights` replaces `saved`
	 *  wholesale, and the vault `modify` from our own `appendCallout` lands mid-
	 *  flow, leaving the AI exchange mutating an object no longer in the list.
	 *  Suppressing the reparse is safe — in-memory state is authoritative. */
	private persisting = 0;
	/** Companion path the current `saved` list was read for. `undefined` means
	 *  "never loaded"; `null` means "loaded, but this view has no file yet".
	 *  Distinguishing the two is what lets the first render trigger a load. */
	private loadedPath: string | null | undefined = undefined;
	private onTextLayerRendered = (e: { pageNumber?: number }): void => {
		// A rendered page proves the toolbar exists, which it may not have when the
		// child was handed to us. Cheap to re-assert; a no-op once the button is up.
		this.ensureToolbarButton();
		// `viewer.then` can hand us a child before `child.file` is populated, so
		// the load in `onload` may have had no path to read. The first rendered
		// text layer is the earliest reliable point at which the file is known —
		// so treat a changed path as "load now, then repaint everything".
		if (this.companionPath() !== this.loadedPath) {
			void this.reloadHighlights();
			return;
		}
		if (typeof e.pageNumber === "number") this.paintPage(e.pageNumber);
	};

	/** Debounce for the progress write below: `pagechanging` fires on every page
	 *  boundary a scroll crosses, and each write persists data.json. */
	private progressTimer: number | null = null;
	private onPageChanging = (e: { pageNumber?: number }): void => {
		const path = this.child.file?.path;
		const total = this.child.pdfViewer.pdfViewer?.pagesCount;
		if (!path || typeof e.pageNumber !== "number" || typeof total !== "number") return;
		// Same convention as the reader's spread fraction, so both formats mean the
		// same thing on a Library card: page 1 of many is 0 ("Unread"), the last
		// page is 1. A single-page document is wholly visible, so it reports 1.
		const pct = total > 1 ? Math.max(0, Math.min(1, (e.pageNumber - 1) / (total - 1))) : 1;
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		this.progressTimer = window.setTimeout(() => {
			this.progressTimer = null;
			this.onProgress(path, pct);
		}, 800);
	};

	constructor(
		private app: App,
		private settings: () => HighlightsPaneSettings,
		private saveSettings: () => Promise<void>,
		readonly child: PdfViewerChild,
		private view: View,
		private onProgress: (path: string, pct: number) => void,
	) {
		super();
	}

	onload(): void {
		this.surface = new GlossSurface({
			app: this.app,
			settings: this.settings,
			sourcePath: () => this.companionPath() ?? "",
			// No `disabledModes`: the AI tiles are live now that the pane is here
			// to receive their output. No `onExtend` either — same-page
			// selections only in v1, so the tile is never built (spec decision 5).
			onSubmit: (modeId, text) => this.persist(modeId, text),
			onDismiss: () => this.dismiss(),
		});
		this.addChild(this.surface);
		this.preview = new AnnotationPreview(this.settings);
		this.addChild(this.preview);
		this.mountPane();

		this.registerDomEvent(this.child.containerEl, "mouseup", () => this.raiseForSelection());
		this.registerDomEvent(this.child.containerEl, "click", (e: MouseEvent) => this.onClick(e));
		// Pointer only. Touch synthesises mousemove on tap, which would raise the
		// preview under the finger and strand it there — mouseleave never fires
		// without a pointer to leave with. The tap grammar replaces it (onClick).
		if (!Platform.isMobile) {
			this.registerDomEvent(this.child.containerEl, "mousemove", (e: MouseEvent) => this.onMouseMove(e));
			this.registerDomEvent(this.child.containerEl, "mouseleave", () => this.preview?.hide());
		}
		this.registerDomEvent(document, "mousedown", (e: MouseEvent) => this.onDocMouseDown(e));
		// Touch has no usable mouseup; the bar rises off a settled selection.
		registerTouchSelectionRaise(this, this.surface, () => this.raiseForSelection());
		// Second half of the touch two-step: a tap on the preview itself opens the
		// conversation. The preview is body-scoped, so this can't live on the
		// container. `defaultPrevented` is what stops the tap that *raised* the
		// preview from immediately hiding it again — `onClick` marks it handled.
		if (Platform.isMobile) {
			this.registerDomEvent(document, "click", (e: MouseEvent) => {
				const preview = this.preview;
				if (e.defaultPrevented || !preview) return;
				const onPreview = (e.target as Element | null)?.closest(".tmr-annotation-preview");
				const idx = preview.hoveredIdx;
				const saved = onPreview && idx !== -1 ? this.saved[idx] : null;
				preview.hide();
				if (saved) this.openConversationFor(idx, saved);
			});
		}
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => this.onKeyDown(e));
		// A fixed-position floater over text that just scrolled away is worse
		// than no floater. The scroll container is pdf.js's own viewer wrapper.
		const scroller = this.child.pdfViewer.pdfViewer?.container;
		if (scroller) {
			this.registerDomEvent(scroller, "scroll", () => {
				this.dismiss();
				this.preview?.hide();
			});
		}

		// Pages virtualize: pdf.js renders a handful at a time and announces each
		// text layer as it lands. That single signal covers first paint, scrolling
		// back to a page, and zoom (which re-renders every visible text layer), so
		// repainting here is all the upkeep the overlays need.
		this.child.pdfViewer.eventBus.on("textlayerrendered", this.onTextLayerRendered);

		// Reading position for the Library card. pdf.js announces the current page
		// (not the rendered one) on `pagechanging`, which is the only signal that
		// means "the reader is here now" — scroll, deep link and page box alike.
		this.child.pdfViewer.eventBus.on("pagechanging", this.onPageChanging);

		// Keep the overlays honest when the companion doc is edited directly —
		// in another pane, on another device, or by our own writes.
		this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
			if (file.path !== this.companionPath()) return;
			// A streaming AI exchange writes the doc on every turn — the event
			// firing here. Re-parsing would swap the list out from under it, so
			// skip until the chat closes; in-memory state is already current.
			if (this.persisting > 0) return;
			if (this.pane && this.pane.activeConversationIdx !== -1) return;
			void this.reloadHighlights();
		}));

		void this.reloadHighlights();
	}

	onunload(): void {
		this.unloaded = true;
		this.child.pdfViewer.eventBus.off?.("textlayerrendered", this.onTextLayerRendered);
		this.child.pdfViewer.eventBus.off?.("pagechanging", this.onPageChanging);
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		this.clearOverlays();
		// Everything we grafted onto Obsidian's own DOM comes back off: the pane
		// host class, the pane itself, and the toolbar button.
		this.child.containerEl.removeClass("tmr-pdf-pane-host");
		this.child.containerEl
			.querySelectorAll(".tmr-highlights-panel, .tmr-highlights-backdrop")
			.forEach((n) => n.remove());
		this.child.toolbar?.toolbarRightEl?.querySelector(".tmr-pdf-pane-toggle")?.remove();
		this.citationTipEl?.remove();
		this.citationTipEl = null;
		this.pending = null;
		this.saved = [];
	}

	// ── Highlights pane ─────────────────────────────────────────────────────

	/** Mount the shared Highlights pane into the native PDF view. The pane's DOM
	 *  is absolutely positioned, so `containerEl` (Obsidian's `.view-content`,
	 *  normally static) gets a namespaced class that supplies both the
	 *  positioning context and the `--tmr-*` token layer — the pane lives far
	 *  outside `.tmr-root` and would otherwise render untokened. Purely
	 *  additive, and removed again in `onunload`. */
	private mountPane(): void {
		const host = this.child.containerEl;
		host.addClass("tmr-pdf-pane-host");
		const pane = new HighlightsPane(this.paneHost());
		this.pane = pane;
		this.addChild(pane);
		// No floating toggle: the native toolbar is the right home for a viewer
		// action, and the reader's hover-reveal pattern has nothing to hang off.
		pane.mount(host, { floatingToggle: false });
		pane.restoreTab();
		pane.applyAiFeaturesState();
		pane.syncTheme();
		applyGlossTheme(host, this.settings());
		this.ensureToolbarButton();
	}

	/** True while the DOM we grafted onto the viewer is still there. A viewer
	 *  reload empties `containerEl`, so a controller can be bound to a live child
	 *  and still have nothing on screen. */
	isMounted(): boolean {
		return !!this.child.containerEl.querySelector(".tmr-highlights-panel");
	}

	/** Put the Highlights toggle in the native toolbar's right strip unless it's
	 *  already there. Re-runnable by design: the toolbar is rebuilt on every viewer
	 *  reload and can lag the child, so mount time isn't always the right moment. */
	ensureToolbarButton(): void {
		const strip = this.child.toolbar?.toolbarRightEl;
		if (!strip || strip.querySelector(".tmr-pdf-pane-toggle")) return;
		const btn = strip.createEl("button", { cls: "clickable-icon tmr-pdf-pane-toggle" });
		setIcon(btn, "pencil-line");
		setTooltip(btn, "Highlights & annotations");
		this.registerDomEvent(btn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.pane?.toggle();
		});
	}

	/** Toggle the pane. Public so the plugin's command can reach it. */
	togglePane(): void {
		this.pane?.toggle();
	}

	/** Re-read settings into every surface this controller owns: the AI master
	 *  switch (gloss tiles + pane tab bar) and 3C mode/theme (pane, floaters,
	 *  and the painted overlays, whose mode colours are stamped per-overlay). */
	applySettings(): void {
		this.pane?.applyAiFeaturesState();
		this.pane?.syncTheme();
		this.surface?.syncModeState();
		this.surface?.syncTheme();
		this.preview?.syncTheme();
		applyGlossTheme(this.child.containerEl, this.settings());
		this.repaintAll();
	}

	/** The book-shaped seam the pane reads a PDF through. Where the reader
	 *  resolves spine sections and paragraph offsets, this resolves pages and
	 *  Obsidian's own `#page=N&selection=…` deep links. */
	private paneHost(): HighlightsPaneHost {
		return {
			app: this.app,
			settings: this.settings,
			saveSettings: this.saveSettings,
			savedHighlights: () => this.saved,
			companionDocPath: () => this.companionPath(),
			// Pages are the PDF's chapters: the Annotations tab groups by page and
			// sorts by page then by position of the selection's first text div.
			sectionOf: (saved) => {
				const page = saved.pdfPage ?? 0;
				return {
					id: page ? `page-${page}` : "",
					label: page ? `Page ${page}` : "—",
					spineIdx: page,
					paraIdx: saved.pdfSel?.[0] ?? 0,
				};
			},
			repaintHighlights: () => this.repaintAll(),
			jumpToSource: (idx, closePanel) => this.jumpToHighlight(idx, closePanel),
			buildAiSystemPrompt: (saved) =>
				buildGlossSystemPrompt(this.settings(), this.child.file?.basename ?? "this document", saved),
			persistTab: (tab) => {
				const path = this.child.file?.path;
				if (!path) return;
				const positions = this.settings().bookPositions;
				positions[path] = { ...positions[path], pane: tab };
				void this.saveSettings();
			},
			restoreTab: () => {
				const path = this.child.file?.path;
				return path ? this.settings().bookPositions[path]?.pane : undefined;
			},
			showCitationTooltip: (text, e) => this.showCitationTooltip(text, e),
			hideCitationTooltip: () => this.hideCitationTooltip(),
			// Nothing of ours to get out of the way on a PDF — the reader folds
			// its search bar away here.
			onPanelToggle: () => { /* no chrome to coordinate */ },
			makeResizable: (panel, edge) =>
				makePaneResizable(this, panel, edge, this.child.containerEl),
		};
	}

	/** Scroll the viewer to a highlight's page and selection using Obsidian's own
	 *  deep-link machinery, then repaint so the active-conversation styling lands
	 *  on the target. Pages already rendered need the explicit repaint; ones that
	 *  render as a result of the jump are covered by `textlayerrendered`. */
	private jumpToHighlight(idx: number, closePanel: boolean): void {
		const saved = this.saved[idx];
		if (!saved?.pdfPage || !saved.pdfSel) return;
		try {
			this.child.applySubpath(`#page=${saved.pdfPage}&selection=${saved.pdfSel.join(",")}`);
		} catch (err) {
			console.error("[ThirdMindReader] PDF jumpToSource failed", err);
		}
		// `applySubpath` paints Obsidian's own transient selection highlight over
		// the same span; ours is the durable one, so clear theirs to avoid two
		// tints stacked on one passage.
		try { this.child.clearTextHighlight(); } catch { /* best-effort */ }
		this.repaintAll();
		if (closePanel && this.pane?.isOpen) this.pane.toggle();
	}

	private showCitationTooltip(text: string, e: MouseEvent): void {
		let tip = this.citationTipEl;
		if (!tip) {
			tip = document.body.createDiv({ cls: "tmr-tooltip" });
			this.citationTipEl = tip;
		}
		applyGlossTheme(tip, this.settings());
		tip.empty();
		tip.createDiv({ cls: "tmr-tooltip-text", text });
		tip.removeClass("tmr-hidden");
		// Clamp to the viewport the same way the reader's tooltip does.
		const rect = tip.getBoundingClientRect();
		const safe = getSafeViewport();
		const x = Math.min(e.clientX + 14, safe.right - rect.width - 16);
		const y = Math.min(e.clientY + 18, safe.bottom - rect.height - 16);
		tip.style.left = `${Math.max(safe.left + 16, x)}px`;
		tip.style.top = `${Math.max(safe.top + 16, y)}px`;
	}

	private hideCitationTooltip(): void {
		this.citationTipEl?.addClass("tmr-hidden");
	}

	// ── Selection ───────────────────────────────────────────────────────────

	/** Resolve the live selection into a pending anchor and raise the GlossBar
	 *  over it. Reached from mouseup on a pointer, and from a settled
	 *  `selectionchange` on touch. */
	private raiseForSelection(): void {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
			this.dismiss();
			return;
		}
		const range = sel.getRangeAt(0);
		if (!this.child.containerEl.contains(range.commonAncestorContainer)) return;

		const startPage = pageElOf(range.startContainer);
		const endPage = pageElOf(range.endContainer);
		// Same-page selections only in v1: the anchor format is per-page, and
		// Obsidian's own copy-link doesn't span pages either.
		if (!startPage || startPage !== endPage) return;

		const page = parseInt(startPage.dataset.pageNumber ?? "", 10);
		if (!Number.isFinite(page)) return;

		let selStr: string | null = null;
		try {
			selStr = this.child.getTextSelectionRangeStr(startPage);
		} catch {
			return;
		}
		const parts = selStr?.split(",").map((n) => parseInt(n, 10));
		if (!parts || parts.length !== 4 || !parts.every(Number.isFinite)) return;

		const text = sel.toString().replace(/\s+/g, " ").trim();
		if (!text) return;

		this.pending = {
			page,
			sel: parts as [number, number, number, number],
			text,
			rect: range.getBoundingClientRect(),
		};
		this.surface?.showBar(this.pending.rect);
	}

	private onDocMouseDown(e: MouseEvent): void {
		if (!this.surface || (!this.surface.barVisible && !this.surface.inputOpen)) return;
		// Shift-click extends the live selection (the browser handles the range
		// growth); dismissing here would wipe it before it can extend.
		if (e.shiftKey) return;
		const target = e.target as Node;
		if (this.surface.containsNode(target)) return;
		// The wikilink popover lives on document.body, outside the panel — a
		// click there is a suggestion pick, not an outside click.
		if (
			this.surface.suggestOpen &&
			target instanceof Element &&
			target.closest(".suggestion-container")
		)
			return;
		this.dismiss();
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (!this.surface) return;
		if (e.key === "Escape") {
			// One layer per press, in transience order — same ordering the reader
			// uses, so Escape never skips past the gloss bar to close the pane.
			if (this.surface.barVisible || this.surface.inputOpen) {
				e.preventDefault();
				this.dismiss();
			} else if (this.pane?.isOpen && this.isActiveView()) {
				e.preventDefault();
				this.pane.toggle();
			}
			return;
		}
		if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
		if (isTextInputFocused()) return;
		// `h` toggles the pane, matching the reader. Unlike the gloss shortcuts
		// below (which are self-scoping — the bar is only up in the PDF the user
		// just selected in) this needs an explicit active-view check, or reading
		// an EPUB would toggle every open PDF's pane too.
		if (e.key === "h" && this.isActiveView() && !this.surface.barVisible) {
			e.preventDefault();
			this.pane?.toggle();
			return;
		}
		// GlossBar numeric shortcuts (1–5), live only while the bar is up and no
		// input has focus. `shortcutMode` already accounts for Lite mode.
		if (!/^[1-5]$/.test(e.key)) return;
		const mode = this.surface.shortcutMode(parseInt(e.key, 10));
		if (!mode || !this.pending) return;
		e.preventDefault();
		e.stopPropagation();
		this.surface.openInput(mode, this.pending.rect);
	}

	private isActiveView(): boolean {
		return this.app.workspace.activeLeaf?.view === this.view;
	}

	/** Hit-test a click against the painted rects. A click on an AI-bearing
	 *  highlight opens the pane's Conversations tab and expands that card —
	 *  EPUB parity. Non-AI highlights stay inert. */
	private onClick(e: MouseEvent): void {
		if (!this.pane || this.saved.length === 0) return;
		const idx = hitTestHighlightRects(this.child.containerEl, e.clientX, e.clientY);
		if (idx === -1) return;
		const saved = this.saved[idx];
		if (!saved) return;
		// Touch has no hover, so the preview needs a tap of its own, and the pane
		// sits behind a second tap — opening it on the first would hijack the read
		// every time a thumb landed on an old highlight. Emphasise highlights get
		// the preview too: on a phone it's the only way to read their note.
		if (Platform.isMobile) {
			e.preventDefault();
			this.preview?.showFor(idx, saved, e.clientX, e.clientY);
			return;
		}
		this.openConversationFor(idx, saved);
	}

	/** Open the pane's Conversations tab on a highlight's card — EPUB parity.
	 *  Non-AI highlights stay inert. Reached from a pointer click, and from the
	 *  second tap of the touch two-step. */
	private openConversationFor(idx: number, saved: SavedHighlight): void {
		const pane = this.pane;
		if (!pane || !GLOSS_AI_MODES.has(saved.mode)) return;
		// Bare-flagged callouts only appear in the list when the quick-settings
		// toggle is on; expanding a card nobody can see would be a dead end.
		if (pane.isBareFlagged(saved) && !this.settings().showBareFlaggedConversations) return;
		if (!pane.isOpen) pane.toggle();
		pane.setTab("conversations");
		pane.openConversation(idx);
	}

	private onMouseMove(e: MouseEvent): void {
		const preview = this.preview;
		if (!preview) return;
		if (this.saved.length === 0) {
			if (preview.hoveredIdx !== -1) preview.hide();
			return;
		}
		const idx = hitTestHighlightRects(this.child.containerEl, e.clientX, e.clientY);
		const saved = idx === -1 ? null : this.saved[idx];
		if (!saved) {
			if (preview.hoveredIdx !== -1) preview.hide();
			return;
		}
		preview.showFor(idx, saved, e.clientX, e.clientY);
	}

	private dismiss(): void {
		this.surface?.hide();
		this.pending = null;
	}

	// ── Persistent highlight painting ───────────────────────────────────────

	/** Re-read the companion doc and repaint every rendered page. Cheap enough
	 *  to run on any change: parsing is a string scan and only a handful of
	 *  pages are ever rendered at once. */
	private async reloadHighlights(): Promise<void> {
		const path = this.companionPath();
		// Claimed up front, not after the await: several text layers can render
		// while the read is in flight, and each would otherwise kick its own.
		this.loadedPath = path;
		let parsed: SavedHighlight[] = [];
		if (path) {
			const file = this.app.vault.getFileByPath(path);
			if (file) {
				try {
					parsed = parseSavedHighlights(await this.app.vault.cachedRead(file));
				} catch (err) {
					console.error("[ThirdMindReader] PDF companion-doc read failed", err);
				}
			}
		}
		// The read is async — the leaf may have closed underneath us, in which
		// case `onunload` already cleared the overlays and must stay cleared.
		if (this.unloaded) return;
		this.saved = parsed;
		this.preview?.hide();
		this.repaintAll();
		this.pane?.refreshCompanionDocButton();
		this.pane?.renderActivePane();
	}

	private repaintAll(): void {
		for (const pageEl of this.pageEls()) {
			const page = parseInt(pageEl.dataset.pageNumber ?? "", 10);
			if (Number.isFinite(page)) this.paintPage(page);
		}
	}

	private clearOverlays(): void {
		this.child.containerEl
			.querySelectorAll(".tmr-saved-highlight-overlay")
			.forEach((n) => n.remove());
	}

	private pageEls(): HTMLElement[] {
		return Array.from(this.child.containerEl.querySelectorAll<HTMLElement>(".page"));
	}

	/** Paint one page's highlights. Idempotent — the page's existing overlay is
	 *  dropped first, so a repaint from any trigger converges on the same DOM. */
	private paintPage(page: number): void {
		const pageEl = this.child.containerEl
			.querySelector<HTMLElement>(`.page[data-page-number="${page}"]`);
		if (!pageEl) return;
		pageEl.querySelectorAll(".tmr-saved-highlight-overlay").forEach((n) => n.remove());

		const entries = this.saved
			.map((saved, idx) => ({ saved, idx }))
			.filter(({ saved }) => saved.pdfPage === page && !!saved.pdfSel);
		if (entries.length === 0) return;

		let divs: HTMLElement[] = [];
		try {
			divs = this.child.getPage(page)?.textLayer?.highlighter?.textDivs ?? [];
		} catch {
			return;
		}
		if (divs.length === 0) return;

		// `tmr-pdf-overlay` is what puts the `--tmr-c-*` mode colours in scope:
		// this overlay sits inside Obsidian's PDF view, far outside `.tmr-root`.
		const overlay = createDiv({ cls: "tmr-saved-highlight-overlay tmr-pdf-overlay" });
		applyGlossTheme(overlay, this.settings());
		// `inset: 0` resolves against the page's padding box, so the rect origin
		// has to skip the border too.
		const pageRect = pageEl.getBoundingClientRect();
		const originX = pageRect.left + pageEl.clientLeft;
		const originY = pageRect.top + pageEl.clientTop;
		let painted = 0;

		for (const { saved, idx } of entries) {
			const sel = saved.pdfSel;
			if (!sel) continue;
			// A replaced PDF keeps the same indices but different text underneath.
			// Detecting that is the whole job of the stored prefix — mark and skip
			// rather than confidently highlighting the wrong passage.
			if (!prefixStillMatches(divs, sel, saved.prefix)) {
				saved.pdfOrphaned = true;
				continue;
			}
			saved.pdfOrphaned = false;
			const range = buildRangeFromTextDivs(divs, sel);
			if (!range) continue;
			// The open conversation's source passage stays visually pinned for the
			// duration of the exchange — the stronger tint + outline variant.
			const isActive = idx === this.pane?.activeConversationIdx;
			for (const r of Array.from(range.getClientRects())) {
				if (r.width === 0 || r.height === 0) continue;
				const rectEl = overlay.createDiv({ cls: "tmr-saved-highlight-rect" });
				if (isActive) rectEl.addClass("tmr-saved-highlight-rect-active");
				rectEl.dataset.mode = saved.mode;
				rectEl.dataset.highlightIdx = String(idx);
				rectEl.style.left = `${r.left - originX}px`;
				rectEl.style.top = `${r.top - originY}px`;
				rectEl.style.width = `${r.width}px`;
				rectEl.style.height = `${r.height}px`;
				painted++;
			}
		}
		// Between the canvas and the text layer: visible over the page image,
		// under the (transparent) selectable text so selection still works.
		if (painted > 0) pageEl.insertBefore(overlay, pageEl.querySelector(".textLayer"));
	}

	// ── Persist ─────────────────────────────────────────────────────────────

	private companionPath(): string | null {
		const file = this.child.file;
		return file ? companionDocPath(file.basename) : null;
	}

	private async persist(modeId: string, userText: string): Promise<void> {
		const pending = this.pending;
		const file = this.child.file;
		const path = this.companionPath();
		if (!pending || !file || !path) {
			this.dismiss();
			return;
		}
		this.persisting++;
		try {
			const doc = await ensureCompanionDoc(this.app, path, file.basename, `[[${file.path}]]`);
			if (!doc) return;

			const selStr = pending.sel.join(",");
			const subpath = `#page=${pending.page}&selection=${selStr}`;
			const alias = `p.${pending.page}`;
			// Native deep link: jump-to-annotation works from the graph, from
			// search, from a phone with TMR absent. Interop, not data — TMR
			// itself resolves through the anchor comment below.
			let sourceLink = `[[${file.path}${subpath}|${alias}]]`;
			try {
				sourceLink = this.child.getMarkdownLink?.(subpath, alias) ?? sourceLink;
			} catch {
				// Fall back to the hand-built wikilink.
			}

			const prefix = encodeURIComponent(pending.text.slice(0, ANCHOR_PREFIX_LEN));
			// PDF pages don't reflow, so `pdfSel` is stable for the life of the
			// document build; `prefix` is the drift check for a *replaced* file.
			const anchor =
				`<!-- tmr-anchor pdfPage:${pending.page} pdfSel:${selStr} prefix:"${prefix}" -->`;

			await appendCallout(this.app, doc, buildCallout({
				modeId,
				header: calloutHeader(pending.text, alias),
				anchor,
				quote: pending.text,
				userText,
				sourceLink,
			}));
			new Notice(`${modeId[0].toUpperCase()}${modeId.slice(1)} saved`);
			// Paint it now rather than waiting on the vault `modify` event, which
			// is debounced and would leave the new highlight invisible for a beat.
			await this.reloadHighlights();
			// AI modes land the reader in the chat surface straight away, then fire
			// the first exchange into the now-open log so it streams like every
			// follow-up. Callouts are appended, so the new entry is the last one.
			if (GLOSS_AI_MODES.has(modeId) && this.pane) {
				const idx = this.saved.length - 1;
				if (!this.pane.isOpen) this.pane.toggle();
				this.pane.setTab("conversations");
				this.pane.openConversation(idx);
				// Read the entry only now: everything above is synchronous, so
				// this is the same object the pane just bound its chat surface to.
				const fresh = this.saved[idx];
				if (fresh) this.pane.runInitialExchange(fresh);
			}
		} catch (err) {
			console.error("[ThirdMindReader] PDF gloss persist failed", err);
			new Notice("Third Mind Reader: failed to save annotation");
		} finally {
			this.persisting--;
			this.dismiss();
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a character offset within a text div to a concrete `(node, offset)`
 *  DOM point. Usually the div holds one text node and this is trivial, but the
 *  find bar wraps its matches in `<span>`s — walking keeps us correct when a
 *  search has split the div we're anchored to. */
function textPointIn(div: HTMLElement | undefined, offset: number): { node: Text; offset: number } | null {
	if (!div) return null;
	const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
	let remaining = offset;
	let last: Text | null = null;
	let node = walker.nextNode() as Text | null;
	while (node) {
		if (remaining <= node.length) return { node, offset: remaining };
		remaining -= node.length;
		last = node;
		node = walker.nextNode() as Text | null;
	}
	// Offset past the end (text shrank): clamp to the div's last character.
	return last ? { node: last, offset: last.length } : null;
}

/** Rebuild a live `Range` from a stored `[beginIndex, beginOffset, endIndex,
 *  endOffset]` tuple over a page's text divs. Null when the indices no longer
 *  address anything paintable. */
function buildRangeFromTextDivs(
	divs: HTMLElement[],
	sel: [number, number, number, number],
): Range | null {
	const [beginIndex, beginOffset, endIndex, endOffset] = sel;
	const start = textPointIn(divs[beginIndex], beginOffset);
	const end = textPointIn(divs[endIndex], endOffset);
	if (!start || !end) return null;
	const range = document.createRange();
	try {
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
	} catch {
		return null;
	}
	return range.collapsed ? null : range;
}

/** The text a stored selection currently covers, read from `textContent` rather
 *  than a Range — an off-screen page's `Range.toString()` returns "", which
 *  would orphan every highlight the moment it scrolled out of view. */
function selectionTextFromDivs(divs: HTMLElement[], sel: [number, number, number, number]): string {
	const [beginIndex, beginOffset, endIndex, endOffset] = sel;
	if (!divs[beginIndex] || !divs[endIndex]) return "";
	if (beginIndex === endIndex) {
		return (divs[beginIndex].textContent ?? "").slice(beginOffset, endOffset);
	}
	let out = (divs[beginIndex].textContent ?? "").slice(beginOffset);
	for (let i = beginIndex + 1; i < endIndex; i++) out += " " + (divs[i].textContent ?? "");
	return out + " " + (divs[endIndex].textContent ?? "").slice(0, endOffset);
}

/** How many significant characters the drift check compares. Enough to catch a
 *  different document build, short enough that PDF text-extraction quirks
 *  (spacing, ligatures near the tail) don't cause false orphaning. */
const DRIFT_CHECK_CHARS = 20;

/** True when the text at the stored indices still starts the way it did when
 *  the annotation was written. Whitespace is stripped from both sides: PDF text
 *  layers space words by position, so incidental spacing shifts between builds
 *  are noise, not drift. An entry with no stored prefix (legacy) always passes. */
function prefixStillMatches(
	divs: HTMLElement[],
	sel: [number, number, number, number],
	prefix: string,
): boolean {
	if (!prefix) return true;
	const strip = (s: string) => s.replace(/\s+/g, "").toLowerCase();
	const actual = strip(selectionTextFromDivs(divs, sel));
	const expected = strip(prefix);
	if (!actual || !expected) return false;
	const k = Math.min(DRIFT_CHECK_CHARS, actual.length, expected.length);
	return actual.slice(0, k) === expected.slice(0, k);
}

/** The `.page` element a DOM node sits inside, or null. pdf.js stamps each with
 *  `data-page-number`; that's the page the selection anchors to. */
function pageElOf(node: Node): HTMLElement | null {
	const el = node instanceof Element ? node : node.parentElement;
	return el?.closest<HTMLElement>(".page") ?? null;
}

import { ItemView, WorkspaceLeaf, setIcon, setTooltip, Menu, Modal, Setting, App, TextComponent, Notice } from "obsidian";
import type ThirdMindReader from "./main";
import { LOGO_3C_SVG } from "./main";
import { scanLibrary, computeCollections, detectExplodedEpubs, type LibraryBook } from "./library-scan";

export const LIBRARY_VIEW_TYPE = "tmr-library";

/** Rotating subtitle greetings. Cosmetic — one is picked at random per mount.
 *  Copy set owned by Rohan (spec R4); this is the seed. */
const GREETINGS = [
	"Pick something to read.",
	"What are you in the mood for?",
	"Where did we leave off?",
	"The shelves are yours.",
	"Something old, or something new?",
];

/**
 * The plugin's home surface: a grid of every book in the vault's `Library/`
 * folder. This is the destination the ribbon and command palette open by
 * default, replacing the empty "Opening…" reader tab (bug B1).
 *
 * Phase C added the collection strip (folder-derived tabs + Everything), tab
 * filtering, Add-Folder, Import, drag-reorder, global search, and the
 * exploded-epub import nudge. Phase D wires real reading progress + annotation
 * marks onto the cards and live-refreshes on vault changes (see
 * `Feature Docs/Library View - Feature Spec.md`).
 */
export class LibraryView extends ItemView {
	/** Full scan result; the strip/grid filter this in memory (no re-scan on
	 *  tab switch). Repopulated by `render()`/`refresh()`. */
	private books: LibraryBook[] = [];
	/** Active collection filter: "" = Everything, else a subfolder name. */
	private activeCollection = "";
	/** Subtitle greeting, picked once per mount so full re-renders (override
	 *  saves, vault events, focus refreshes) don't flicker it to a new phrase. */
	private greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
	/** Global search: when `searchQuery` is non-empty the body shows matches
	 *  across all collections, grouped by collection (ignoring `activeCollection`). */
	private searchOpen = false;
	private searchQuery = "";
	/** Persistent search element (collapsed icon ⇆ expanded field) — toggled by
	 *  class so the width animates instead of rebuilding the strip. */
	private searchEl: HTMLElement | null = null;
	private searchInputEl: HTMLInputElement | null = null;
	/** Exploded `.epub` folders found in `Library/` — drives the import nudge. */
	private explodedFolders: string[] = [];
	/** Repaint targets carved out by `render()` so state changes don't re-scan. */
	private stripEl: HTMLElement | null = null;
	private feedbackHintEl: HTMLElement | null = null;
	private nudgeEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	/** Tabs Group + its sliding active-indicator (the Conversations-pane pattern,
	 *  positioned with JS because the Library has variable-width tabs). */
	private tabsGroupEl: HTMLElement | null = null;
	private tabIndicatorEl: HTMLElement | null = null;
	private tabResizeObserver: ResizeObserver | null = null;
	/** While a user tab-switch is gliding, ignore the ResizeObserver's instant
	 *  reposition (the active/inactive font-weight change reflows the tabs and
	 *  would otherwise snap the pill mid-slide). */
	private tabIndicatorAnimating = false;
	private tabIndicatorAnimTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: ThirdMindReader) {
		super(leaf);
	}

	getViewType(): string {
		return LIBRARY_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Library";
	}

	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		// In 3C mode the Library's light/dark variant follows Obsidian's appearance
		// (not the reader's tmrTheme), so re-apply when the user switches themes.
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyThemeClasses()));
		await this.render();
	}

	async onClose(): Promise<void> {
		this.tabResizeObserver?.disconnect();
		this.tabResizeObserver = null;
		if (this.tabIndicatorAnimTimer !== null) window.clearTimeout(this.tabIndicatorAnimTimer);
		this.feedbackHintEl?.remove();
		this.feedbackHintEl = null;
		this.contentEl.empty();
	}

	/** Re-scan and re-render. Called after a per-book override is saved, and live
	 *  from the plugin's vault create/delete/rename/modify handlers when `Library/`
	 *  contents change (debounced there). */
	async refresh(): Promise<void> {
		await this.render();
	}

	/** Live, in-place update of a single card's progress (fill bar + label) — no
	 *  re-scan — called from the reader on each position-save. The cached book is
	 *  updated too so a later full repaint keeps the value. */
	updateBookProgress(path: string, pct: number): void {
		const book = this.books.find((b) => b.path === path);
		if (book) book.progress = pct;
		if (!this.bodyEl) return;
		const cards = Array.from(this.bodyEl.querySelectorAll<HTMLElement>(".tmr-lib-card"));
		const card = cards.find((c) => c.dataset.path === path);
		if (!card) return;
		const fill = card.querySelector<HTMLElement>(".tmr-lib-card-track-fill");
		const pctEl = card.querySelector<HTMLElement>(".tmr-lib-card-pct");
		if (fill) fill.style.width = `${Math.round(pct * 100)}%`;
		if (pctEl) pctEl.setText(pct > 0 ? `${Math.round(pct * 100)}%` : "Unread");
	}

	/** 3C/theme plumbing. `tmrMode` is the shared global toggle (the reader follows
	 *  it too); but unlike the reader, the Library's light/dark variant tracks
	 *  Obsidian's own appearance rather than the reader's `tmrTheme` — there's no
	 *  separate light/dark control here. Called on mount, from `saveSettings()` when
	 *  the toggle flips, and on Obsidian `css-change`. */
	applyThemeClasses(): void {
		const root = this.contentEl;
		if (!root.classList.contains("tmr-root")) return;
		if (this.plugin.settings.tmrMode === "3c") {
			root.addClass("tmr-3c-mode");
			const theme = document.body.classList.contains("theme-light") ? "light" : "dark";
			root.setAttribute("data-tmr-theme", theme);
		} else {
			root.removeClass("tmr-3c-mode");
			root.removeAttribute("data-tmr-theme");
		}
		this.sync3cToggle();
	}

	private async render(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("tmr-root", "tmr-library");
		this.applyThemeClasses();

		this.buildHeader(root);

		// Sticky strip above a scrolling body; nudge sits between them. These
		// containers are repainted on state change without re-scanning.
		this.stripEl = root.createEl("div", { cls: "tmr-lib-strip" });
		this.nudgeEl = root.createEl("div", { cls: "tmr-lib-nudge-slot" });
		this.bodyEl = root.createEl("div", { cls: "tmr-lib-body" });

		// Header/strip paint synchronously above; the grid fills in once the scan
		// resolves. Empty/loading skeleton refinement is R6 (owned by Rohan).
		this.books = await scanLibrary(
			this.app.vault,
			this.plugin.settings.libraryOverrides,
			this.plugin.settings.bookPositions,
		);
		this.explodedFolders = await detectExplodedEpubs(this.app.vault);

		// Guard against a view that closed/re-rendered while the scan was awaiting.
		if (!root.isConnected) return;

		const collections = computeCollections(this.app.vault, this.plugin.settings.libraryCollectionOrder);
		// Self-heal: the tab strip mirrors the live folder tree, so prune any
		// reorder-hint entries whose folders no longer exist (e.g. a collection
		// deleted in the file explorer) rather than letting them resurrect a tab.
		const order = this.plugin.settings.libraryCollectionOrder;
		const prunedOrder = order.filter((c) => collections.includes(c));
		if (prunedOrder.length !== order.length) {
			this.plugin.settings.libraryCollectionOrder = prunedOrder;
			void this.plugin.persistSettings();
		}
		// Drop a stale active collection that no longer exists.
		if (this.activeCollection && !collections.includes(this.activeCollection)) this.activeCollection = "";

		this.paintStrip();
		this.paintNudge();
		this.paintBody();
	}

	private buildHeader(root: HTMLElement): void {
		const header = root.createEl("div", { cls: "tmr-lib-header" });
		header.createEl("div", {
			cls: "tmr-lib-eyebrow",
			text: this.app.vault.getName().toUpperCase(),
		});
		header.createEl("h1", { cls: "tmr-lib-title", text: "The Library" });
		header.createEl("p", {
			cls: "tmr-lib-subtitle",
			text: this.greeting,
		});
	}

	// ── Collection strip ────────────────────────────────────────────────────

	private paintStrip(): void {
		const strip = this.stripEl;
		if (!strip) return;
		strip.empty();

		const tabs = strip.createEl("div", { cls: "tmr-lib-tabs" });
		this.tabsGroupEl = tabs;
		// Sliding active-indicator behind the tabs (Conversations-pane pattern).
		this.tabIndicatorEl = tabs.createEl("div", { cls: "tmr-lib-tab-indicator" });
		this.renderTab(tabs, "", "Everything");
		const collections = computeCollections(this.app.vault, this.plugin.settings.libraryCollectionOrder);
		for (const c of collections) this.renderTab(tabs, c, c);

		// Position the indicator once laid out, and keep it parked under the active
		// tab across reflow / font-load / pane-resize (no animation for those).
		this.tabResizeObserver?.disconnect();
		this.tabResizeObserver = new ResizeObserver(() => this.positionTabIndicator(false));
		this.tabResizeObserver.observe(tabs);

		// Add-Folder sits with the tabs; the action cluster pins to the right.
		const addFolder = this.iconButton(strip, "folder-plus", "New collection");
		this.registerDomEvent(addFolder, "click", () => this.promptAddFolder());

		strip.createEl("div", { cls: "tmr-lib-strip-spacer" });

		this.renderSearchControl(strip);

		this.render3cToggle(strip);

		// Import lives in settings, so this opens the settings tab — hence the gear
		// icon (per the updated DLS); the action is still "import a book".
		const addBook = this.iconButton(strip, "settings", "Settings");
		this.registerDomEvent(addBook, "click", () => this.openSettings());

		if (!this.plugin.settings.feedbackHintShown) this.showFeedbackHint(addBook);

		this.positionTabIndicator(false);
	}

	/** One persistent element: collapsed it's an icon button; open it grows into a
	 *  global filter field. Open/close toggle a class (no strip rebuild) so the
	 *  width animates at constant height — no vertical reflow of the view. */
	private renderSearchControl(strip: HTMLElement): void {
		const wrap = strip.createEl("div", { cls: "tmr-lib-search" });
		this.searchEl = wrap;
		wrap.toggleClass("tmr-lib-search-open", this.searchOpen);
		setTooltip(wrap, "Search");

		setIcon(wrap.createEl("span", { cls: "tmr-lib-search-icon" }), "search");

		const input = wrap.createEl("input", { cls: "tmr-lib-search-input" });
		this.searchInputEl = input;
		input.type = "text";
		input.placeholder = "I'm looking for…";
		input.value = this.searchQuery;
		input.tabIndex = this.searchOpen ? 0 : -1;

		const clear = wrap.createEl("button", { cls: "tmr-lib-search-clear" });
		setIcon(clear, "x");
		setTooltip(clear, "Close search");

		// Collapsed: a click anywhere on the icon box opens it.
		this.registerDomEvent(wrap, "click", () => {
			if (!this.searchOpen) this.openSearch();
		});
		this.registerDomEvent(input, "input", () => {
			this.searchQuery = input.value;
			this.paintBody(); // body only — keep the field focused mid-type
		});
		this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				this.collapseSearch();
			}
		});
		this.registerDomEvent(clear, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.collapseSearch();
		});
	}

	private openSearch(): void {
		this.searchOpen = true;
		this.searchEl?.addClass("tmr-lib-search-open");
		const input = this.searchInputEl;
		if (input) {
			input.tabIndex = 0;
			window.setTimeout(() => {
				input.focus();
				input.setSelectionRange(input.value.length, input.value.length);
			}, 0);
		}
	}

	private collapseSearch(): void {
		this.searchOpen = false;
		this.searchQuery = "";
		this.searchEl?.removeClass("tmr-lib-search-open");
		if (this.searchInputEl) {
			this.searchInputEl.value = "";
			this.searchInputEl.tabIndex = -1;
			this.searchInputEl.blur();
		}
		this.paintBody();
	}

	private renderTab(container: HTMLElement, value: string, label: string): void {
		const tab = container.createEl("button", { cls: "tmr-lib-tab", text: label });
		tab.dataset.collection = value;
		tab.toggleClass("tmr-lib-tab-active", this.activeCollection === value);
		this.registerDomEvent(tab, "click", () => this.selectCollection(value));

		// "Everything" is pinned leftmost; the rest are drag-reorderable. (R9 owns
		// the richer drop affordance; this is the functional baseline.)
		if (value) this.wireTabDrag(tab, value);
	}

	private wireTabDrag(tab: HTMLElement, value: string): void {
		tab.draggable = true;
		this.registerDomEvent(tab, "dragstart", (e: DragEvent) => {
			e.dataTransfer?.setData("text/plain", value);
			tab.addClass("tmr-lib-tab-dragging");
		});
		this.registerDomEvent(tab, "dragend", () => {
			tab.removeClass("tmr-lib-tab-dragging");
			this.stripEl?.querySelectorAll(".tmr-lib-tab-dragover")
				.forEach((t) => t.removeClass("tmr-lib-tab-dragover"));
		});
		this.registerDomEvent(tab, "dragover", (e: DragEvent) => {
			e.preventDefault();
			tab.addClass("tmr-lib-tab-dragover");
		});
		this.registerDomEvent(tab, "dragleave", () => tab.removeClass("tmr-lib-tab-dragover"));
		this.registerDomEvent(tab, "drop", (e: DragEvent) => {
			e.preventDefault();
			const from = e.dataTransfer?.getData("text/plain");
			if (from) this.reorderCollection(from, value);
		});
	}

	/** Move collection `from` to sit just before `to`, materialise the full
	 *  collection order into settings, and persist it. */
	private reorderCollection(from: string, to: string): void {
		if (from === to) return;
		const cols = computeCollections(this.app.vault, this.plugin.settings.libraryCollectionOrder);
		const fromIdx = cols.indexOf(from);
		if (fromIdx === -1) return;
		cols.splice(fromIdx, 1);
		const toIdx = cols.indexOf(to);
		cols.splice(toIdx === -1 ? cols.length : toIdx, 0, from);
		this.plugin.settings.libraryCollectionOrder = cols;
		void this.plugin.saveSettings();
		this.paintStrip();
	}

	private selectCollection(value: string): void {
		const wasSearching = this.searchOpen || this.searchQuery !== "";
		if (this.activeCollection === value && !wasSearching) return;
		this.activeCollection = value;
		// Selecting a collection exits global search (collapse via class, no rebuild).
		if (wasSearching) {
			this.searchOpen = false;
			this.searchQuery = "";
			this.searchEl?.removeClass("tmr-lib-search-open");
			if (this.searchInputEl) {
				this.searchInputEl.value = "";
				this.searchInputEl.tabIndex = -1;
			}
		}
		this.stripEl?.querySelectorAll<HTMLElement>(".tmr-lib-tab").forEach((t) =>
			t.toggleClass("tmr-lib-tab-active", t.dataset.collection === value)
		);
		this.positionTabIndicator(true);
		this.paintBody();
	}

	/** Park the sliding indicator under the active tab. `animate` lets a user tab
	 *  switch glide; layout/reflow repositions jump instantly. When the view isn't
	 *  laid out yet (opened in a background tab) it retries on later frames. */
	private positionTabIndicator(animate: boolean, retries = 0): void {
		const group = this.tabsGroupEl;
		const indicator = this.tabIndicatorEl;
		if (!group || !indicator) return;
		const active = group.querySelector<HTMLElement>(".tmr-lib-tab-active");
		if (!active) {
			indicator.setCssProps({ opacity: "0" });
			return;
		}
		if (active.offsetWidth === 0) {
			indicator.setCssProps({ opacity: "0" });
			if (retries < 60 && indicator.isConnected) {
				requestAnimationFrame(() => this.positionTabIndicator(false, retries + 1));
			}
			return;
		}
		const place = () => {
			indicator.setCssProps({
				opacity: "1",
				left: `${active.offsetLeft}px`,
				width: `${active.offsetWidth}px`,
			});
		};
		if (animate) {
			// Glide to the target; hold off the resize-snap until it settles.
			place();
			this.tabIndicatorAnimating = true;
			if (this.tabIndicatorAnimTimer !== null) window.clearTimeout(this.tabIndicatorAnimTimer);
			this.tabIndicatorAnimTimer = window.setTimeout(() => {
				this.tabIndicatorAnimating = false;
			}, 260);
		} else {
			// Resize/layout reposition — but never snap over a slide in progress.
			if (this.tabIndicatorAnimating) return;
			indicator.setCssProps({ transition: "none" });
			place();
			void indicator.offsetWidth; // flush so the next change animates
			indicator.setCssProps({ transition: "" });
		}
	}

	private iconButton(parent: HTMLElement, icon: string, label: string): HTMLElement {
		const btn = parent.createEl("button", { cls: "tmr-lib-icon-btn" });
		setIcon(btn, icon);
		setTooltip(btn, label);
		btn.ariaLabel = label;
		return btn;
	}

	/** The 3C-mode toggle (DLS `Em4F4`): an icon button carrying the 3C logo. It
	 *  flips the *global* `tmrMode`, so the reader follows too; `saveSettings()`
	 *  re-themes every open view and calls back into `applyThemeClasses` →
	 *  `sync3cToggle`, which is what updates this button's active state (here and on
	 *  any other open Library, including when toggled from the reader). */
	private render3cToggle(strip: HTMLElement): void {
		const btn = strip.createEl("button", { cls: "tmr-lib-icon-btn tmr-lib-3c-btn" });
		// eslint-disable-next-line no-unsanitized/property -- Safe: LOGO_3C_SVG is a compile-time SVG constant.
		btn.innerHTML = LOGO_3C_SVG;
		this.registerDomEvent(btn, "click", async () => {
			this.plugin.settings.tmrMode = this.plugin.settings.tmrMode === "3c" ? "obsidian" : "3c";
			await this.plugin.saveSettings();
		});
		this.sync3cToggle();
	}

	/** Reflect the live `tmrMode` on the 3C toggle (active = 3C on). Queries the
	 *  button so it can be driven from `applyThemeClasses` regardless of who flipped
	 *  the mode. No-op until the strip (and button) exist. */
	private sync3cToggle(): void {
		const btn = this.stripEl?.querySelector<HTMLElement>(".tmr-lib-3c-btn");
		if (!btn) return;
		const on = this.plugin.settings.tmrMode === "3c";
		btn.toggleClass("tmr-lib-3c-btn-active", on);
		const label = on ? "3C mode (on)" : "3C mode (off)";
		btn.ariaLabel = label;
		setTooltip(btn, label);
	}

	/** Open (or reveal) the importer. Interim: surfaces the importer in the
	 *  settings tab; a dedicated in-Library import modal is deferred. */
	/** Opens the plugin's settings tab (where the book importer lives), not a
	 *  standalone importer — every "import" entry point routes here. */
	private openSettings(): void {
		// Undocumented app.setting API — the only route to a specific settings tab.
		const setting = (this.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		}).setting;
		setting?.open?.();
		setting?.openTabById?.(this.plugin.manifest.id);
	}

	/** One-time hint pointing first-time users to where beta feedback lives: a
	 *  pill above the settings gear (same shape as the reader's progress "Back"
	 *  pill). Body-scoped + fixed so the strip's overflow can't clip it. Shown
	 *  once ever (persisted via settings.feedbackHintShown); dismisses on click of
	 *  the hint or the gear, or after a timeout. */
	private showFeedbackHint(anchor: HTMLElement): void {
		this.plugin.settings.feedbackHintShown = true;
		void this.plugin.saveSettings();

		this.feedbackHintEl?.remove();
		const hint = document.body.createEl("div", { cls: "tmr-lib-feedback-hint" });
		this.feedbackHintEl = hint;
		hint.createSpan({ text: "Thanks for trying the beta! You can leave feedback in the settings page here" });
		const caret = hint.createEl("div", { cls: "tmr-lib-feedback-hint-caret" });

		// Hug the text: shrink to the narrowest width that preserves the natural
		// wrap (at the CSS max-width), removing trailing dead space on the shorter
		// line. CSS can't do this for a fixed-position box (its containing block is
		// the viewport, so fit-content resolves to the single-line width).
		const targetH = hint.offsetHeight;
		let lo = 60, hi = hint.offsetWidth;
		while (hi - lo > 4) {
			const mid = (lo + hi) / 2;
			hint.style.width = `${mid}px`;
			if (hint.offsetHeight > targetH) lo = mid; else hi = mid;
		}
		hint.style.width = `${Math.ceil(hi)}px`;

		const place = () => {
			const r = anchor.getBoundingClientRect();
			if (!r.width) return;
			const margin = 8;
			const gearCenter = r.left + r.width / 2;
			const left = Math.max(margin, Math.min(gearCenter - hint.offsetWidth / 2, window.innerWidth - hint.offsetWidth - margin));
			hint.style.top = `${Math.round(r.top - hint.offsetHeight - margin)}px`;
			hint.style.left = `${Math.round(left)}px`;
			// Point the caret at the gear itself, even when the pill is clamped
			// against the window edge (otherwise it drifts toward the pill centre).
			const caretX = Math.max(12, Math.min(gearCenter - left, hint.offsetWidth - 12));
			caret.style.left = `${Math.round(caretX)}px`;
		};
		place();
		// Force a reflow so the opacity transition plays, then reveal. (We avoid
		// requestAnimationFrame here — it's paused while the window is backgrounded.)
		void hint.offsetWidth;
		hint.addClass("tmr-lib-feedback-hint-visible");

		const dismiss = () => {
			hint.remove();
			if (this.feedbackHintEl === hint) this.feedbackHintEl = null;
		};
		this.registerDomEvent(hint, "click", () => { dismiss(); this.openSettings(); });
		this.registerDomEvent(anchor, "click", dismiss);
		window.setTimeout(dismiss, 9000);
	}

	private promptAddFolder(): void {
		new FolderNameModal(this.app, async (name) => {
			const clean = name.trim().replace(/[\\/:*?"<>|]+/g, "").trim();
			if (!clean || clean === "Annotations") return;
			const path = `Library/${clean}`;
			if (!this.app.vault.getAbstractFileByPath(path)) {
				try {
					await this.app.vault.createFolder(path);
				} catch (e) {
					new Notice(`Couldn't create folder: ${(e as Error).message}`);
					return;
				}
			}
			// The new (possibly empty) folder now exists, so the tab strip — a pure
			// mirror of the folder tree — surfaces it on the next paint. Nothing is
			// persisted to keep it alive; deleting the folder removes the tab.
			this.activeCollection = clean;
			this.paintStrip();
			this.paintBody();
		}).open();
	}

	// ── Exploded-epub import nudge ──────────────────────────────────────────

	private paintNudge(): void {
		const slot = this.nudgeEl;
		if (!slot) return;
		slot.empty();
		const n = this.explodedFolders.length;
		if (n === 0) return;

		const banner = slot.createEl("div", { cls: "tmr-lib-nudge" });
		banner.createEl("span", {
			cls: "tmr-lib-nudge-text",
			text: `Found ${n} book${n === 1 ? "" : "s"} that ${n === 1 ? "needs" : "need"} to be imported.`,
		});
		const cta = banner.createEl("button", { cls: "tmr-lib-nudge-cta", text: "Import" });
		this.registerDomEvent(cta, "click", () => this.openSettings());
		const dismiss = banner.createEl("button", { cls: "tmr-lib-nudge-dismiss" });
		setIcon(dismiss, "x");
		setTooltip(dismiss, "Dismiss");
		this.registerDomEvent(dismiss, "click", () => slot.empty());
	}

	// ── Book grid ───────────────────────────────────────────────────────────

	private paintBody(): void {
		const body = this.bodyEl;
		if (!body) return;
		body.empty();

		if (this.books.length === 0) {
			this.renderEmptyState(body);
			return;
		}

		const query = this.searchQuery.trim();
		if (query) {
			this.renderSearchResults(body, query);
			return;
		}

		const visible = this.activeCollection
			? this.books.filter((b) => b.collection === this.activeCollection)
			: this.books;

		if (visible.length === 0) {
			body.createEl("div", {
				cls: "tmr-lib-collection-empty",
				text: "No books in this collection yet.",
			});
			return;
		}

		this.renderGrid(body, visible);
	}

	/** Global search results, grouped by collection with a separator + label so a
	 *  match's collection is always legible. Visual layout is R2 (owned by Rohan);
	 *  this is the functional baseline. */
	private renderSearchResults(body: HTMLElement, query: string): void {
		const q = query.toLowerCase();
		const matches = this.books.filter(
			(b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q)
		);

		if (matches.length === 0) {
			body.createEl("div", {
				cls: "tmr-lib-collection-empty",
				text: `No matches for "${query}".`,
			});
			return;
		}

		// Group matches by collection ("" = root), ordered: named collections in
		// the user's order first, then root last (labelled "Library").
		const groups = new Map<string, LibraryBook[]>();
		for (const b of matches) {
			const key = b.collection || "";
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
		}
		const ordered = computeCollections(this.app.vault, this.plugin.settings.libraryCollectionOrder)
			.filter((c) => groups.has(c));
		if (groups.has("")) ordered.push("");

		for (const key of ordered) {
			const group = body.createEl("div", { cls: "tmr-lib-search-group" });
			group.createEl("div", {
				cls: "tmr-lib-search-group-label",
				text: key || "Library",
			});
			this.renderGrid(group, groups.get(key)!);
		}
	}

	private renderGrid(parent: HTMLElement, books: LibraryBook[]): void {
		const grid = parent.createEl("div", { cls: "tmr-lib-grid" });
		for (const book of books) this.renderCard(grid, book);
	}

	private renderCard(grid: HTMLElement, book: LibraryBook): void {
		const card = grid.createEl("div", { cls: "tmr-lib-card" });
		card.setAttribute("role", "button");
		card.dataset.path = book.path;
		card.tabIndex = 0;

		const head = card.createEl("div", { cls: "tmr-lib-card-head" });
		head.createEl("div", { cls: "tmr-lib-card-title", text: book.title });
		if (book.author) {
			head.createEl("div", { cls: "tmr-lib-card-author", text: `— ${book.author}` });
		}

		// Hover-revealed ellipsis: a visible handle for the same menu that
		// right-clicking anywhere on the card already opens. Click must not
		// bubble to the card's open-on-click / Enter handlers.
		const menuBtn = card.createEl("button", { cls: "tmr-lib-card-menu" });
		setIcon(menuBtn, "ellipsis");
		menuBtn.setAttribute("aria-label", "More options");
		this.registerDomEvent(menuBtn, "click", (e: MouseEvent) => {
			e.stopPropagation();
			this.showCardMenu(e, book);
			// Drop focus after a mouse click so the button doesn't stay revealed
			// once the menu is dismissed (keyboard activation, detail 0, keeps it).
			if (e.detail > 0) menuBtn.blur();
		});
		this.registerDomEvent(menuBtn, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") e.stopPropagation();
		});

		const foot = card.createEl("div", { cls: "tmr-lib-card-foot" });
		const track = foot.createEl("div", { cls: "tmr-lib-card-track" });
		const fill = track.createEl("div", { cls: "tmr-lib-card-track-fill" });
		fill.style.width = `${Math.round(book.progress * 100)}%`;

		const stats = foot.createEl("div", { cls: "tmr-lib-card-stats" });
		stats.createEl("span", {
			cls: "tmr-lib-card-pct",
			// progress = the reader's cached `pct`; 0 (or never-opened) reads "Unread".
			text: book.progress > 0 ? `${Math.round(book.progress * 100)}%` : "Unread",
		});
		// Marks hidden at zero per spec.
		if (book.marks > 0) {
			const marks = stats.createEl("span", { cls: "tmr-lib-card-marks" });
			setIcon(marks.createEl("span", { cls: "tmr-lib-card-marks-icon" }), "bookmark");
			marks.createEl("span", { text: String(book.marks) });
		}

		const open = () => void this.plugin.openEpubInNewTab(book.path);
		this.registerDomEvent(card, "click", open);
		this.registerDomEvent(card, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				open();
			}
		});
		this.registerDomEvent(card, "contextmenu", (e: MouseEvent) => {
			e.preventDefault();
			this.showCardMenu(e, book);
		});
	}

	/** Card right-click menu. Minimal for now (open + edit details); the fuller
	 *  context-menu pattern is R8 (owned by Rohan). */
	private showCardMenu(e: MouseEvent, book: LibraryBook): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Open book")
				.setIcon("book-open")
				.onClick(() => void this.plugin.openEpubInNewTab(book.path))
		);
		menu.addItem((item) =>
			item
				.setTitle("Edit details…")
				.setIcon("pencil")
				.onClick(() => {
					new EditBookDetailsModal(this.app, book, async (title, author) => {
						this.applyOverride(book, title, author);
						await this.plugin.saveSettings();
						await this.refresh();
					}).open();
				})
		);
		menu.showAtMouseEvent(e);
	}

	/** Write (or clear) the per-book override. A field is stored only when it
	 *  differs from the raw OPF value, so reverting to the original prunes it and
	 *  keeps `data.json` clean. An empty title falls back to the raw title. */
	private applyOverride(book: LibraryBook, title: string, author: string): void {
		const overrides = this.plugin.settings.libraryOverrides;
		const next: { title?: string; author?: string } = { ...overrides[book.path] };

		const trimmedTitle = title.trim();
		if (trimmedTitle && trimmedTitle !== book.rawTitle) next.title = trimmedTitle;
		else delete next.title;

		const trimmedAuthor = author.trim();
		if (trimmedAuthor !== book.rawAuthor) next.author = trimmedAuthor;
		else delete next.author;

		if (next.title === undefined && next.author === undefined) {
			delete overrides[book.path];
		} else {
			overrides[book.path] = next;
		}
	}

	private renderEmptyState(parent: HTMLElement): void {
		const empty = parent.createEl("div", { cls: "tmr-lib-empty" });
		empty.createEl("div", { cls: "tmr-lib-empty-title", text: "Your library is empty" });
		empty.createEl("div", {
			cls: "tmr-lib-empty-hint",
			text: "Import a book, or drop .epub files into your Library folder.",
		});
		const importBtn = empty.createEl("button", {
			cls: "tmr-lib-empty-import",
			text: "Import a book",
		});
		this.registerDomEvent(importBtn, "click", () => this.openSettings());
	}
}

/**
 * Small modal to override a book's displayed title/author. Stores a display-only
 * override (see `applyOverride`); the epub file is never touched. "Reset to
 * original" restores the raw OPF values, which prunes the override on save.
 */
class EditBookDetailsModal extends Modal {
	private titleValue: string;
	private authorValue: string;

	constructor(
		app: App,
		private book: LibraryBook,
		private onSave: (title: string, author: string) => void | Promise<void>
	) {
		super(app);
		this.titleValue = book.title;
		this.authorValue = book.author;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Edit book details");
		contentEl.createEl("p", {
			cls: "tmr-lib-edit-note",
			text: "Display only — your epub file is never modified.",
		});

		let titleInput: TextComponent;
		let authorInput: TextComponent;

		new Setting(contentEl).setName("Title").addText((t) => {
			titleInput = t;
			t.setValue(this.titleValue).onChange((v) => (this.titleValue = v));
		});

		new Setting(contentEl)
			.setName("Author")
			.setDesc(
				this.book.rawAuthor
					? `Original: ${this.book.rawAuthor}`
					: "No author in the epub metadata."
			)
			.addText((t) => {
				authorInput = t;
				t.setValue(this.authorValue).onChange((v) => (this.authorValue = v));
			});

		new Setting(contentEl)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Reset to original")
					.onClick(() => {
						this.titleValue = this.book.rawTitle;
						this.authorValue = this.book.rawAuthor;
						titleInput.setValue(this.titleValue);
						authorInput.setValue(this.authorValue);
					})
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						await this.onSave(this.titleValue, this.authorValue);
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Single-field prompt for a new collection (subfolder) name. */
class FolderNameModal extends Modal {
	private value = "";

	constructor(app: App, private onSubmit: (name: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("New collection");

		const submit = async () => {
			if (!this.value.trim()) return;
			this.close();
			await this.onSubmit(this.value);
		};

		new Setting(contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("e.g. Essays").onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					void submit();
				}
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Create").setCta().onClick(() => void submit()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

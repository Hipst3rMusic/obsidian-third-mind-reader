/** Shared Gloss grammar — everything the annotation layer needs that is not
 *  specific to one reading surface.
 *
 *  Extracted from `main.ts` for PDF Gloss Phase A (see
 *  `Feature Docs/PDF Gloss - Feature Spec.md`): the EPUB `ReaderView` and the
 *  PDF `PdfGlossController` both drive the *same* GlossBar / input / tooltip
 *  floaters and write the *same* companion-doc callouts. Nothing here knows
 *  about epubs, pretext offsets, or pdf.js — hosts supply the anchor.
 */

import {
	App,
	Component,
	Notice,
	Platform,
	TFile,
	AbstractInputSuggest,
	prepareFuzzySearch,
	setIcon,
} from "obsidian";

// ─── Modes ───────────────────────────────────────────────────────────────────

/** Gloss annotation modes. Per-mode button fill + icon fill colours are
 *  DLS primitive hex values (Oh Dear, Look, Learn, All Good, Shadow-500 /
 *  Look, Prince-900, Dawn-800, Empire-600, Empire-800W) — semantic and
 *  theme-independent. See Feature Docs/Gloss - Feature Spec.md. */
export const GLOSS_MODES = [
	{ id: "emphasise", label: "Emphasise", icon: "highlighter" },
	{ id: "exclaim",   label: "Exclaim",   icon: "circle-alert" },
	{ id: "explain",   label: "Explain",   icon: "help-circle" },
	{ id: "examine",   label: "Examine",   icon: "search" },
	{ id: "enquiry",   label: "Enquiry",   icon: "message-circle-more" },
] as const;

/** Placeholder copy per gloss mode; exact phrasing from Feature Spec §Phase 2. */
export const GLOSS_PLACEHOLDERS: Record<string, string> = {
	emphasise: "your thought...",
	exclaim:   "what just happened...",
	explain:   "what's unclear...",
	examine:   "what do you want to explore...",
	enquiry:   "your question...",
};

/** Modes that get a `<!-- ai response pending -->` slot at submit time and
 *  that auto-fire an AI call immediately after the callout is written.
 *  Emphasise is never AI-bearing. */
export const GLOSS_AI_MODES = new Set(["exclaim", "explain", "examine", "enquiry"]);

export const ANCHOR_PREFIX_LEN = 48;

/** The slice of plugin settings the shared floaters read. `ThirdMindReaderSettings`
 *  satisfies this structurally, so hosts just hand over their settings object. */
export interface GlossHostSettings {
	tmrMode: "obsidian" | "3c";
	tmrTheme: "light" | "dark";
	aiFeaturesEnabled: boolean;
}

/** Stamp 3C mode + theme onto an element that lives outside `.tmr-root`.
 *  Every gloss floater — and the PDF highlight overlay, which is painted inside
 *  Obsidian's own PDF view — needs this to pick up the `--tmr-c-*` mode colours,
 *  since those tokens are scoped to the elements that carry these classes. */
export function applyGlossTheme(el: HTMLElement | null, settings: GlossHostSettings): void {
	if (!el) return;
	if (settings.tmrMode === "3c") {
		el.addClass("tmr-3c-mode");
		el.setAttribute("data-tmr-theme", settings.tmrTheme);
	} else {
		el.removeClass("tmr-3c-mode");
		el.removeAttribute("data-tmr-theme");
	}
}

// ─── Saved-highlight model + companion-doc parser ────────────────────────────

/** A single conversation turn parsed out of a callout body. Multi-line
 *  turns are reconstructed by appending continuation lines (lines without
 *  a `User:` / `AI:` prefix that follow a turn header) to `content`. */
export interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
}

/** A saved highlight as parsed from the companion doc. We keep raw char offsets
 *  and the text prefix rather than resolving to a CursorRange here — resolution
 *  happens at paint time against the live OffsetMap so highlights can recover
 *  from paragraph-index drift (paraId hint stale but prefix still matches). */
export interface SavedHighlight {
	mode: string;
	/** Empty string on PDF anchors, which have no paragraph model — those carry
	 *  `pdfPage` / `pdfSel` instead. */
	paraIdHint: string;
	/** For cross-paragraph highlights: the paraId of the paragraph where the
	 *  selection ends. Absent for single-paragraph highlights. */
	endParaIdHint?: string;
	startChar: number;
	endChar: number;
	prefix: string;
	/** 1-indexed PDF page (`pageEl.dataset.pageNumber`). Present only on PDF
	 *  anchors; its presence is what marks an entry as PDF-anchored. */
	pdfPage?: number;
	/** Obsidian's native four-int text-layer selection
	 *  (beginIndex, beginOffset, endIndex, endOffset) — the same tuple its
	 *  `#page=N&selection=a,b,c,d` deep links use. */
	pdfSel?: [number, number, number, number];
	/** Transient (never persisted): set when the text at `pdfSel` no longer
	 *  matches `prefix`, i.e. the PDF file was replaced with a different build.
	 *  Such entries are skipped at paint time rather than highlighting the wrong
	 *  passage — detection, not recovery. */
	pdfOrphaned?: boolean;
	/** User's annotation text (lines inside the callout after the anchor,
	 *  excluding the source quote and any `<!-- ... -->` pending markers).
	 *  Shown in the hover preview. */
	userText: string;
	/** Source text quoted inside the callout (`> > ...` lines). Shown in the
	 *  hover preview as context under the annotation. */
	quote: string;
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

/** The PDF interop deep-link line (`— [[file.pdf#page=N&selection=…|p.N]]`).
 *  Navigation, not annotation content: the parser skips it, and the callout
 *  rewriters must carry it through untouched or a single AI exchange would
 *  silently strip every PDF callout's link back into the document. */
export const SOURCE_LINK_RE = /^—\s*(?:\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\))\s*$/;

/** Parse `<!-- tmr-anchor ... -->` comments out of a companion-doc markdown
 *  string, pairing each with the mode declared on the preceding callout line.
 *  Accepts the EPUB `chars:S,E prefix:"..."` format, the legacy
 *  `start:s,g end:s,g` format, and the PDF `pdfPage:N pdfSel:a,b,c,d` format. */
export function parseSavedHighlights(md: string): SavedHighlight[] {
	const result: SavedHighlight[] = [];
	const modeRe = /^>\s*\[!(exclaim|explain|examine|emphasise|enquiry)\]/;
	const anchorRe = /<!--\s*tmr-anchor\s+([^>]*?)-->/;
	const fieldRe =
		/(spine|para|chars|prefix|endPara|endChars|pdfPage|pdfSel):(?:"((?:[^"\\]|\\.)*)"|(\S+))/g;
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

		// PDF anchor: page + the four-int native text-layer selection. Both are
		// required — a half-written anchor can't be painted or jumped to.
		let pdfPage: number | undefined;
		let pdfSel: [number, number, number, number] | undefined;
		if (fields.pdfPage && fields.pdfSel) {
			const page = parseInt(fields.pdfPage, 10);
			const sel = fields.pdfSel.split(",").map((n) => parseInt(n, 10));
			if (Number.isFinite(page) && sel.length === 4 && sel.every(Number.isFinite)) {
				pdfPage = page;
				pdfSel = sel as [number, number, number, number];
			}
		}

		const paraIdHint = fields.para ?? "";
		// EPUB entries are identified by paraId, PDF entries by page+selection.
		// Neither → an anchor we can't resolve; skip it rather than half-render.
		if (!paraIdHint && pdfPage === undefined) { pendingMode = null; i++; continue; }

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
			} else if (SOURCE_LINK_RE.test(stripped.trim())) {
				// PDF interop deep link — navigation, not annotation content.
				currentTurn = null;
			} else if (stripped.trim().length === 0) {
				// Blank line inside a callout. If we're mid-turn, treat as a
				// paragraph break rather than resetting — multi-paragraph AI
				// responses write `> ` blank lines that must not orphan the
				// continuation lines that follow. One `\n` only: the following
				// continuation line adds its own, so the pair round-trips back
				// to exactly one blank `>` line on rewrite (two would compound,
				// growing every paragraph break on each rewrite).
				if (currentTurn) currentTurn.content += "\n";
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

		// A blank line before the state marker (`>` + `<!-- ai response
		// pending -->`) or at the end of the callout leaves a trailing newline
		// the rewriter would re-emit as another blank line — trim so rewrites
		// stay idempotent.
		for (const t of turns) t.content = t.content.replace(/\n+$/, "");

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
			pdfPage,
			pdfSel,
			userText,
			quote: quoteLines.join("\n").trim(),
			turns,
			aiState,
			aiError,
		});
		pendingMode = null;
		i = j;
	}
	return result;
}

// ─── Companion doc ───────────────────────────────────────────────────────────

/** Resolve a companion doc's `TFile`, creating doc (and folder) on first use.
 *  Null only if creation fails outright. Shared by every annotatable format —
 *  a PDF's annotations are a first-class vault node exactly like an EPUB's. */
export async function ensureCompanionDoc(
	app: App,
	path: string,
	title: string,
	sourceLink: string,
): Promise<TFile | null> {
	const existing = app.vault.getFileByPath(path);
	if (existing) return existing;
	const folder = path.substring(0, path.lastIndexOf("/"));
	if (folder && !app.vault.getFolderByPath(folder)) {
		try {
			await app.vault.createFolder(folder);
		} catch {
			// Folder may have been created in a parallel call — re-check below.
		}
	}
	const frontmatter = [
		"---",
		`title: "${title.replace(/"/g, '\\"')}"`,
		// Quoted: YAML parses a bare `[[X]]` as a nested list, so Obsidian
		// would never resolve the wikilink and the note gets no graph edge.
		`source: "${sourceLink}"`,
		"tags: [annotations, third-mind-reader]",
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		`# ${title} — Annotations`,
		"",
	].join("\n");
	try {
		return await app.vault.create(path, frontmatter);
	} catch {
		// Doc may have been created in a parallel call — re-resolve.
		return app.vault.getFileByPath(path);
	}
}

/** Append a freshly built callout to a companion doc, normalising the blank-line
 *  padding so consecutive entries never run together. */
export async function appendCallout(app: App, file: TFile, callout: string): Promise<void> {
	await app.vault.process(file, (existing) => {
		const pad = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
		return existing + pad + callout + "\n";
	});
}

/** Maintain the companion doc's `ai-pending` frontmatter count.
 *
 *  A **discovery hint**, not state: it lets "Process pending AI requests" find
 *  flagged docs through `metadataCache` without opening a single file. The
 *  per-callout `<!-- ai response pending -->` marker stays ground truth, and
 *  processing always recounts from the parse rather than trusting this number.
 *  Cleared (not zeroed) at zero, so a fully-answered doc carries no key. */
export async function setAiPendingCount(app: App, file: TFile, count: number): Promise<void> {
	try {
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			if (count > 0) fm[AI_PENDING_KEY] = count;
			else delete fm[AI_PENDING_KEY];
		});
	} catch (err) {
		// A stale hint costs a doc being skipped by the vault-wide sweep until
		// the book is next opened; never worth failing the write it rode in on.
		console.error("[ThirdMindReader] setAiPendingCount failed", err);
	}
}

/** Frontmatter key carrying the pending-exchange count. */
export const AI_PENDING_KEY = "ai-pending";

// ─── Callout editing ─────────────────────────────────────────────────────────
//
// Pure string surgery over a companion doc: locate one callout by its anchor
// comment and rewrite its body from a SavedHighlight. Lives here rather than in
// the Highlights pane because the deferred-queue processor (Mobile spec, Tier 1)
// has to resolve exchanges in docs whose book is not open, so it has no pane —
// and two implementations of "find the callout" would be two ways to silently
// rewrite the wrong one.

/** The anchor-comment substrings that identify one saved highlight uniquely.
 *  Two shapes, because the two sources anchor differently: an EPUB entry is
 *  `para:` (+ a `chars:` disambiguator when several marks share a paragraph),
 *  a PDF entry is `pdfPage:` + `pdfSel:`. Getting this wrong is silent — the
 *  rewriters simply fail to find the callout and return the doc untouched. */
export function anchorTokens(saved: SavedHighlight): string[] {
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
export function findCalloutBounds(
	lines: string[],
	saved: SavedHighlight,
): { startIdx: number; anchorIdx: number; endIdx: number } | null {
	// Tokens must end at a field boundary. Anchor fields are space-separated,
	// so a bare `includes` would let `pdfSel:2,0,4,5` match a *different*
	// mark's `pdfSel:2,0,4,50` and rewrite the wrong callout.
	const tokens = anchorTokens(saved).map(
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
export function existingSourceLink(lines: string[], anchorIdx: number, endIdx: number): string | null {
	for (let i = anchorIdx + 1; i < endIdx; i++) {
		const stripped = lines[i].replace(/^>\s?/, "").trim();
		if (SOURCE_LINK_RE.test(stripped)) return lines[i];
	}
	return null;
}

/** Rewrite the body lines of a single callout (from anchor line to the
 *  first non-`>` line) to reflect `saved.turns` and `saved.aiState`. */
export function rewriteCalloutBody(doc: string, saved: SavedHighlight): string {
	const lines = doc.split("\n");
	const bounds = findCalloutBounds(lines, saved);
	if (!bounds) return doc;
	const { anchorIdx, endIdx } = bounds;

	// Rebuild body: source quote → deep link → turns → state marker.
	const body: string[] = [];
	if (saved.quote.trim()) {
		for (const ql of saved.quote.split("\n")) body.push(`> > ${ql}`);
	}
	const sourceLink = existingSourceLink(lines, anchorIdx, endIdx);
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

/** Assemble the callout body. Format-neutral: the caller supplies the header
 *  text and the already-rendered `<!-- tmr-anchor ... -->` line, since only it
 *  knows how its own anchors are shaped. `sourceLink`, when given, is written
 *  as an em-dash interop line under the quote (PDFs carry a native deep link
 *  there so jump-to-annotation works with TMR absent). */
export function buildCallout(opts: {
	modeId: string;
	header: string;
	anchor: string;
	quote: string;
	userText: string;
	sourceLink?: string;
}): string {
	const lines: string[] = [];
	lines.push(`> [!${opts.modeId}]- ${opts.header}`);
	lines.push(`> ${opts.anchor}`);
	if (opts.quote.length > 0) {
		for (const ql of opts.quote.split(/\r?\n/)) lines.push(`> > ${ql}`);
	}
	if (opts.sourceLink) lines.push(`> — ${opts.sourceLink}`);
	if (opts.userText.length > 0) {
		lines.push(">");
		for (const ul of opts.userText.split(/\r?\n/)) lines.push(`> ${ul}`);
	}
	if (GLOSS_AI_MODES.has(opts.modeId)) {
		lines.push(">");
		lines.push("> <!-- ai response pending -->");
	}
	return lines.join("\n");
}

/** `snippet · rest…` callout header, with the snippet clipped to one line. */
export function calloutHeader(quote: string, ...rest: string[]): string {
	const snippet = quote.replace(/\s+/g, " ").trim();
	const snippetShort = snippet.length > 48 ? snippet.slice(0, 48).trim() + "…" : snippet;
	return [snippetShort, ...rest].filter(Boolean).join(" · ");
}

// ─── Annotation preview floater ──────────────────────────────────────────────

/** Character budget for the hover preview body, matching the reader's
 *  footnote-tooltip cap so both floaters clip at the same length. */
const PREVIEW_MAX_CHARS = 900;

/** Render inline markdown (bold, italic, code) into `el` synchronously.
 *  HTML-escapes the text first so this is safe for untrusted content.
 *  Handles: **bold**, *italic*, ***bold-italic***, `code`. */
function setInlineMarkdown(el: HTMLElement, text: string): void {
	const esc = text
		.replace(/&/g, "&amp;").replace(/</g, "&lt;")
		.replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	// eslint-disable-next-line no-unsanitized/property -- Safe: the text is fully HTML-escaped above, so the only markup that can reach the DOM is the tags these replaces emit.
	el.innerHTML = esc
		.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\*(.+?)\*/g, "<em>$1</em>")
		.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Strip footnote markers and definitions from an AI turn for preview display. */
function stripFootnotes(content: string): string {
	return content.replace(/\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]+\]/g, "").trim();
}

/** The body-scoped floater shown when the pointer rests on a saved highlight.
 *  Hosts hit-test their own rects and call {@link showFor}; the index bookkeeping
 *  that keeps the DOM from thrashing as the pointer crosses rects belonging to
 *  the same highlight lives here. */
export class AnnotationPreview extends Component {
	private el: HTMLElement | null = null;
	private idx = -1;

	constructor(private settings: () => GlossHostSettings) {
		super();
	}

	onunload(): void {
		this.el?.remove();
		this.el = null;
		this.idx = -1;
	}

	/** Index of the highlight currently previewed, or -1. */
	get hoveredIdx(): number {
		return this.idx;
	}

	/** Surface the preview for highlight `idx`. Repopulates only when the index
	 *  actually changes; otherwise just tracks the pointer. */
	showFor(idx: number, saved: SavedHighlight, clientX: number, clientY: number): void {
		if (idx !== this.idx) {
			this.idx = idx;
			this.populate(saved);
		}
		this.position(clientX, clientY);
	}

	hide(): void {
		this.idx = -1;
		this.el?.addClass("tmr-hidden");
	}

	syncTheme(): void {
		applyGlossTheme(this.el, this.settings());
	}

	private ensureEl(): HTMLElement {
		if (this.el) return this.el;
		this.el = document.body.createEl("div", { cls: "tmr-annotation-preview tmr-hidden" });
		this.syncTheme();
		return this.el;
	}

	private populate(saved: SavedHighlight): void {
		const el = this.ensureEl();
		el.empty();
		el.dataset.glossMode = saved.mode;
		el.createEl("div", { cls: "tmr-annotation-preview-mode",
			text: saved.mode[0].toUpperCase() + saved.mode.slice(1) });

		const CHARS = PREVIEW_MAX_CHARS;
		let body: string;
		const isComplete = saved.aiState === "complete";

		if ((saved.mode === "exclaim" || saved.mode === "enquiry") && isComplete && saved.turns.length > 0) {
			// Conversation view: interleave You/AI turns until the char budget runs out.
			const parts: string[] = [];
			let used = 0;
			for (const turn of saved.turns) {
				const prefix = turn.role === "user" ? "You: " : "AI: ";
				const content = stripFootnotes(turn.content);
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
			body = first ? stripFootnotes(first.content) : "";
			if (body.length > CHARS) body = body.slice(0, CHARS).trimEnd() + "…";
		} else {
			// Examine, Emphasise, or any mode with a pending/error AI state: show the user's note.
			body = saved.userText.trim();
		}

		if (body.length > 0) {
			setInlineMarkdown(el.createEl("div", { cls: "tmr-annotation-preview-body" }), body);
		} else {
			const emptyText = GLOSS_AI_MODES.has(saved.mode) && isComplete
				? "(no response)"
				: "No note yet — add one from the Highlights panel";
			el.createEl("div", {
				cls: "tmr-annotation-preview-body tmr-annotation-preview-empty",
				text: emptyText,
			});
		}

		el.removeClass("tmr-hidden");
	}

	private position(clientX: number, clientY: number): void {
		const el = this.el;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const safe = getSafeViewport();
		const margin = 12;
		let x = clientX + 16;
		let y = clientY + 18;
		if (x + rect.width + margin > safe.right) x = clientX - rect.width - 16;
		if (y + rect.height + margin > safe.bottom) y = clientY - rect.height - 18;
		el.style.left = `${Math.max(safe.left + margin, x)}px`;
		el.style.top  = `${Math.max(safe.top + margin, y)}px`;
	}
}

/** Bounds a body-appended floater may occupy, in client coordinates.
 *
 *  Every tooltip, preview and popover in the plugin clamps itself to
 *  `window.innerWidth/innerHeight`. On a phone that viewport runs *underneath*
 *  the status bar and Obsidian's floating navbar, so a preview clamped to it
 *  lands half-hidden behind the navbar and a flipped-up tooltip can sit under
 *  the notch. This is the same viewport with those regions taken off.
 *
 *  The navbar is measured rather than derived from `--mobile-toolbar-height`:
 *  it floats above the bottom safe-area inset rather than inside it, so its
 *  real top edge is the only figure that doesn't need two tokens added up
 *  correctly. On desktop there's no navbar and every inset resolves to 0, so
 *  this collapses to the plain viewport and callers behave exactly as before. */
export function getSafeViewport(): { top: number; left: number; right: number; bottom: number } {
	const bodyStyle = getComputedStyle(document.body);
	const inset = (name: string): number => {
		const value = parseFloat(bodyStyle.getPropertyValue(name));
		return Number.isFinite(value) ? value : 0;
	};
	const navbar = document.body.querySelector<HTMLElement>(".mobile-navbar");
	const navbarTop = navbar?.getBoundingClientRect().top ?? 0;
	return {
		top: inset("--safe-area-inset-top"),
		left: inset("--safe-area-inset-left"),
		right: window.innerWidth - inset("--safe-area-inset-right"),
		bottom: navbarTop > 0 ? navbarTop : window.innerHeight - inset("--safe-area-inset-bottom"),
	};
}

/** The band Obsidian's floating navbar pill occupies, or null where there isn't
 *  one — desktop, and tablets, where Obsidian sets `.mobile-navbar { display:
 *  none }` and the rect measures 0×0. Phase C docks the GlossBar here (see
 *  Mobile/GlossBarActive): iOS puts its own selection menu wherever it finds
 *  room, so anything anchored to the selection is competing for those pixels.
 *
 *  Vertical geometry comes from `offsetTop`/`offsetHeight`, NOT from the client
 *  rect: the auto-hide moves the navbar with `transform: translateY(...)` rather
 *  than removing it, so the rect's top is wrong exactly when the user is reading
 *  — which is when the slot is wanted. Offsets are layout values and a transform
 *  never touches them. Left and width still come from the rect, which keeps
 *  subpixel precision and only a *vertical* transform is in play.
 *
 *  Don't be tempted to derive the top from `innerHeight` and the height instead:
 *  the pill's clearance above the home indicator is a bottom *margin* under
 *  `is-floating-nav` and bottom *padding* otherwise, so that arithmetic is right
 *  in one configuration and 32px out in the other. Padding is still subtracted
 *  from the height, since when it is used it sits inside the box. */
export function getNavbarSlot(): { left: number; top: number; width: number; height: number } | null {
	if (!Platform.isMobile) return null;
	const navbar = document.body.querySelector<HTMLElement>(".mobile-navbar");
	if (!navbar || navbar.offsetHeight < 1) return null;
	const rect = navbar.getBoundingClientRect();
	if (rect.width < 1) return null;
	const padBottom = parseFloat(getComputedStyle(navbar).paddingBottom);
	const inset = Number.isFinite(padBottom) ? padBottom : 0;
	return {
		left: rect.left,
		width: rect.width,
		top: navbar.offsetTop,
		height: navbar.offsetHeight - inset,
	};
}

/** Hit-test a pointer position against painted highlight rects, returning the
 *  `data-highlight-idx` of the first rect under it, or -1. Rects are
 *  `pointer-events: none` so selection passes through — hence the manual test. */
export function hitTestHighlightRects(root: ParentNode, clientX: number, clientY: number): number {
	for (const rectEl of Array.from(root.querySelectorAll<HTMLElement>(".tmr-saved-highlight-rect"))) {
		const r = rectEl.getBoundingClientRect();
		if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
			return parseInt(rectEl.dataset.highlightIdx ?? "-1", 10);
		}
	}
	return -1;
}

/** True when a text field has focus, so bare-key shortcuts yield to typing. */
export function isTextInputFocused(): boolean {
	const el = document.activeElement as HTMLElement | null;
	return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// ─── Wikilink autocomplete ───────────────────────────────────────────────────

/** `[[` autocomplete for the gloss input. Obsidian's native link suggest is
 *  bound to CodeMirror editors, so this rebuilds it for a plain `<input>`:
 *  fuzzy-matches vault files against the text between an unclosed `[[` and the
 *  caret, and on pick splices in the shortest unambiguous linktext — resolved
 *  from the companion doc's path, since that's where the annotation lands. */
class WikilinkSuggest extends AbstractInputSuggest<TFile> {
	/** Read by the gloss input's own Enter/Escape handler: while the popover is
	 *  open those keys belong to its keymap scope (select / close), not to
	 *  submit / dismiss. */
	isSuggestOpen = false;

	constructor(
		app: App,
		private textInput: HTMLInputElement,
		private getSourcePath: () => string,
	) {
		super(app, textInput);
	}

	open(): void {
		super.open();
		this.isSuggestOpen = true;
	}

	close(): void {
		super.close();
		this.isSuggestOpen = false;
	}

	/** The unclosed `[[` context the caret sits in, or null when there is none
	 *  (which hides the popover — `getSuggestions` returns empty). */
	private linkContext(): { start: number; query: string } | null {
		const caret = this.textInput.selectionStart ?? this.textInput.value.length;
		const before = this.textInput.value.slice(0, caret);
		const start = before.lastIndexOf("[[");
		if (start === -1) return null;
		const query = before.slice(start + 2);
		if (query.includes("]]")) return null;
		return { start, query };
	}

	protected getSuggestions(_query: string): TFile[] {
		const ctx = this.linkContext();
		if (!ctx) return [];
		const files = this.app.vault.getFiles();
		if (!ctx.query) {
			// Bare `[[` — most recently modified files, like the editor's list.
			return files.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, 10);
		}
		const fuzzy = prepareFuzzySearch(ctx.query);
		const scored: { file: TFile; score: number }[] = [];
		for (const file of files) {
			const match = fuzzy(file.path);
			if (match) scored.push({ file, score: match.score });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, 10).map((s) => s.file);
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({
			cls: "suggestion-title",
			text: file.extension === "md" ? file.basename : file.name,
		});
		const parent = file.parent?.path;
		if (parent && parent !== "/") content.createDiv({ cls: "suggestion-note", text: parent + "/" });
	}

	selectSuggestion(file: TFile): void {
		const ctx = this.linkContext();
		if (!ctx) {
			this.close();
			return;
		}
		const value = this.textInput.value;
		const caret = this.textInput.selectionStart ?? value.length;
		// Consume the auto-paired `]]` sitting just after the caret, if any.
		const end = value.startsWith("]]", caret) ? caret + 2 : caret;
		const linktext = this.app.metadataCache.fileToLinktext(file, this.getSourcePath());
		const inserted = `[[${linktext}]]`;
		this.textInput.value = value.slice(0, ctx.start) + inserted + value.slice(end);
		const newCaret = ctx.start + inserted.length;
		this.textInput.setSelectionRange(newCaret, newCaret);
		this.close();
		this.textInput.focus();
	}
}

// ─── GlossSurface ────────────────────────────────────────────────────────────

export interface GlossSurfaceOptions {
	app: App;
	/** Live plugin settings — read on every show so the floaters track theme
	 *  and Lite-mode changes without re-registration. */
	settings: () => GlossHostSettings;
	/** Vault path the `[[` autocomplete resolves links against (the companion
	 *  doc, since that's where the annotation lands). */
	sourcePath: () => string;
	/** Modes that render greyed and unclickable, mapped to the tooltip that
	 *  explains why (PDF Phase A greys the AI tiles — spec decision 4). */
	disabledModes?: () => Map<string, string>;
	/** Cross-page extend. Omitted → the tile is never built, which is how PDFs
	 *  opt out (same-page selections only in v1). */
	onExtend?: () => void;
	/** A tile was submitted with `text`. Empty text only reaches here for
	 *  Emphasise — the other modes require content. */
	onSubmit: (modeId: string, text: string) => void | Promise<void>;
	/** The user dismissed the input with Escape. Hosts tear down their own
	 *  selection state here; the surface has already hidden itself. */
	onDismiss: () => void;
	/** The input panel opened. Tiles are clicked *inside* the surface, so a host
	 *  that needs to react to the input appearing — the reader dims the page
	 *  behind it on mobile — can't see it through its own entry points. Closing
	 *  already routes through `onDismiss` or the host's own submit handler. */
	onInputOpen?: () => void;
}

/** The GlossBar, its per-tile tooltip, and the annotation input — the three
 *  body-scoped floaters that make up the Gloss interaction. One instance per
 *  host view; hosts drive it with `showBar` / `openInput` / `hide` and receive
 *  submissions through `onSubmit`. Extends `Component` so DOM listeners and the
 *  floater nodes are torn down with the host (`host.addChild(surface)`). */
export class GlossSurface extends Component {
	private barEl: HTMLElement | null = null;
	private inputEl: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;
	private linkSuggest: WikilinkSuggest | null = null;
	private activeMode: string | null = null;
	private vvListener: (() => void) | null = null;
	private kbdObserver: ResizeObserver | null = null;
	private kbdTimers: number[] = [];

	constructor(private opts: GlossSurfaceOptions) {
		super();
	}

	onunload(): void {
		this.untrackKeyboard();
		this.linkSuggest?.close();
		this.barEl?.remove();
		this.inputEl?.remove();
		this.tooltipEl?.remove();
		this.barEl = this.inputEl = this.tooltipEl = null;
		this.linkSuggest = null;
		this.activeMode = null;
	}

	// ── State the host queries ──────────────────────────────────────────────

	get barVisible(): boolean {
		return !!this.barEl && !this.barEl.hasClass("tmr-hidden");
	}

	get inputOpen(): boolean {
		return !!this.inputEl && !this.inputEl.hasClass("tmr-hidden");
	}

	/** The mode whose input panel is open, or null. */
	get mode(): string | null {
		return this.activeMode;
	}

	get suggestOpen(): boolean {
		return this.linkSuggest?.isSuggestOpen ?? false;
	}

	/** True when `node` sits inside one of the floaters — i.e. a mousedown there
	 *  is interaction, not an outside click. */
	containsNode(node: Node): boolean {
		return !!this.barEl?.contains(node) || !!this.inputEl?.contains(node);
	}

	/** The gloss mode a numeric shortcut (1–5) maps to right now, or null if the
	 *  shortcut isn't currently actionable: the GlossBar is hidden, a mode input
	 *  panel is open (the number belongs to that field), or the mode is
	 *  suppressed in Lite mode / disabled on this surface. Mirrors tile order. */
	shortcutMode(slot: number): string | null {
		if (!this.barVisible) return null;
		if (this.inputOpen) return null;
		const mode = GLOSS_MODES[slot - 1];
		if (!mode) return null;
		// Lite mode hides the AI tiles — only Emphasise (1) stays live.
		if (!this.opts.settings().aiFeaturesEnabled && mode.id !== "emphasise") return null;
		if (this.opts.disabledModes?.().has(mode.id)) return null;
		return mode.id;
	}

	// ── Show / hide ─────────────────────────────────────────────────────────

	showBar(selectionRect: DOMRect, canExtend = false): void {
		const bar = this.ensureBar();
		// Extend control only surfaces when the selection runs to the page end.
		bar.toggleClass("tmr-gloss-can-extend", canExtend);
		this.syncModeState();
		bar.removeClass("tmr-hidden");
		this.syncTheme();
		// Read the slot on every raise rather than caching it: a rotation or an
		// iPad Split View change moves it, and there is no re-registration hook.
		const slot = getNavbarSlot();
		bar.toggleClass("tmr-gloss-docked", !!slot);
		if (slot) {
			// The tile click needs the selection rect, which positionFloater
			// would normally have recorded.
			this.lastRect = selectionRect;
			bar.style.left = `${slot.left}px`;
			bar.style.top = `${slot.top}px`;
			bar.style.width = `${slot.width}px`;
			bar.style.height = `${slot.height}px`;
		} else {
			bar.style.removeProperty("width");
			bar.style.removeProperty("height");
			this.positionFloater(bar, selectionRect);
		}
	}

	/** Re-apply which tiles are live. Called on every raise, and by hosts when
	 *  the AI master switch flips while the bar is already up. */
	syncModeState(): void {
		const bar = this.barEl;
		if (!bar) return;
		// Lite mode (no AI) collapses the bar to the Emphasise tile only.
		bar.toggleClass("tmr-gloss-lite", !this.opts.settings().aiFeaturesEnabled);
		const disabled = this.opts.disabledModes?.() ?? new Map<string, string>();
		for (const tile of Array.from(bar.querySelectorAll<HTMLElement>(".tmr-gloss-tile"))) {
			const id = tile.dataset.glossMode;
			tile.toggleClass("tmr-gloss-tile-disabled", !!id && disabled.has(id));
		}
	}

	openInput(modeId: string, selectionRect: DOMRect): void {
		// The raised bar *is* the "there is a live selection" signal — without it
		// the host has nothing to anchor a submit to, and the input would collect
		// text that silently goes nowhere.
		if (!this.barVisible) return;
		if (!GLOSS_MODES.some((m) => m.id === modeId)) return;
		if (this.opts.disabledModes?.().has(modeId)) return;
		this.activeMode = modeId;
		this.barEl?.addClass("tmr-hidden");
		this.hideTileTooltip();
		const panel = this.ensureInput();
		this.syncInputTheme();
		panel.dataset.glossMode = modeId;
		const input = panel.querySelector<HTMLInputElement>(".tmr-gloss-input-field");
		if (input) {
			input.value = "";
			input.placeholder = GLOSS_PLACEHOLDERS[modeId] ?? "";
		}
		panel.removeClass("tmr-hidden");
		// On touch the input has to clear the on-screen keyboard, which the
		// selection rect knows nothing about; on desktop it still opens over the
		// selection it belongs to.
		if (Platform.isMobile) {
			panel.addClass("tmr-gloss-input-docked");
			this.lastRect = selectionRect;
			// Clear any inline top a previous desktop-style open may have left
			// behind, which would outrank the stylesheet and fight `bottom`.
			panel.style.removeProperty("top");
			this.trackKeyboard();
		} else {
			this.positionFloater(panel, selectionRect);
		}
		input?.focus();
		this.opts.onInputOpen?.();
	}

	hideBar(): void {
		this.barEl?.addClass("tmr-hidden");
		this.hideTileTooltip();
	}

	hideInput(): void {
		this.untrackKeyboard();
		this.inputEl?.addClass("tmr-hidden");
		this.inputEl?.removeClass("tmr-gloss-input-docked");
		this.inputEl?.removeClass("tmr-gloss-input-top");
		this.inputEl?.removeClass("tmr-gloss-input-ready");
		this.inputEl?.style.removeProperty("bottom");
		this.linkSuggest?.close();
		this.activeMode = null;
	}

	/** Keep the docked input above the on-screen keyboard.
	 *
	 *  Two rounds of device testing killed one assumption each: the *layout*
	 *  viewport does not shrink for the keyboard (so a fixed `bottom: 16px` sits
	 *  behind the keys), and neither, on this platform, does `visualViewport`.
	 *  What demonstrably does move is Obsidian's own app container — that is why
	 *  the book repaginates and why the search bar clears the keyboard for free.
	 *  So measure every box that could report it and trust the shortest, rather
	 *  than betting the feature on one of them (`keyboardTop`).
	 *
	 *  Three triggers, because the keyboard slides in over ~300ms and which of
	 *  them fires is exactly what's in question: `visualViewport` events if it
	 *  moves at all, a ResizeObserver on the containers, and a short ladder of
	 *  timers as the backstop. The last timer also unlocks the top-docked
	 *  fallback — if nothing has reported a keyboard by then, the panel goes to
	 *  the top of the screen where it is at least reachable. */
	private trackKeyboard(): void {
		this.untrackKeyboard();
		const vv = window.visualViewport;
		if (vv) {
			this.vvListener = () => this.layoutDockedInput();
			vv.addEventListener("resize", this.vvListener);
			vv.addEventListener("scroll", this.vvListener);
		}
		this.kbdObserver = new ResizeObserver(() => this.layoutDockedInput());
		for (const el of this.keyboardBoxes()) this.kbdObserver.observe(el);
		// The ladder runs to 1.6s because the device showed the containers still
		// reporting full height at 700ms — the keyboard reports late, not never
		// (every box read 852 in the fallback dump, then the observer corrected
		// the panel a moment later). Only the last rung may give up.
		const rungs = [80, 200, 400, 700, 1100, 1600];
		for (const [i, ms] of rungs.entries()) {
			this.kbdTimers.push(
				window.setTimeout(() => this.layoutDockedInput(i === rungs.length - 1), ms),
			);
		}
		this.layoutDockedInput();
	}

	private untrackKeyboard(): void {
		const vv = window.visualViewport;
		if (vv && this.vvListener) {
			vv.removeEventListener("resize", this.vvListener);
			vv.removeEventListener("scroll", this.vvListener);
		}
		this.vvListener = null;
		this.kbdObserver?.disconnect();
		this.kbdObserver = null;
		for (const t of this.kbdTimers) window.clearTimeout(t);
		this.kbdTimers = [];
	}

	/** Elements that shrink when the keyboard opens, if anything does. */
	private keyboardBoxes(): HTMLElement[] {
		const sel = ".app-container, .workspace, .mod-root, .workspace-leaf.mod-active";
		return Array.from(document.body.querySelectorAll<HTMLElement>(sel));
	}

	/** Lowest screen y that is *not* under the keyboard, per the most pessimistic
	 *  box that reports one. Falls back to the full window height. */
	private keyboardTop(): number {
		const full = window.innerHeight;
		let top = full;
		const vv = window.visualViewport;
		if (vv) top = Math.min(top, vv.offsetTop + vv.height);
		for (const el of this.keyboardBoxes()) {
			const bottom = el.getBoundingClientRect().bottom;
			// A collapsed or hidden container reports 0 and would win every time.
			if (bottom > full * 0.4) top = Math.min(top, bottom);
		}
		return top;
	}

	/** One-line dump of every candidate box, for the fallback Notice. */
	private keyboardReport(): string {
		const vv = window.visualViewport;
		const parts = [
			`win ${Math.round(window.innerHeight)}`,
			vv ? `vv ${Math.round(vv.offsetTop + vv.height)}` : "vv none",
		];
		for (const el of this.keyboardBoxes()) {
			const cls = el.className.split(/\s+/)[0] || "?";
			parts.push(`${cls} ${Math.round(el.getBoundingClientRect().bottom)}`);
		}
		return parts.join(" · ");
	}

	private layoutDockedInput(allowFallback = false): void {
		const panel = this.inputEl;
		if (!panel || !panel.hasClass("tmr-gloss-input-docked")) return;
		const covered = window.innerHeight - this.keyboardTop();
		// Rounding noise in a container's rect is not a keyboard.
		if (covered > 24) {
			panel.removeClass("tmr-gloss-input-top");
			// Offsetting `bottom` (not `top`) keeps the panel's height auto —
			// setting both edges on a fixed element stretches it, not moves it.
			panel.style.bottom = `${covered + 16}px`;
			// Revealed only once placed: until the keyboard reports itself the
			// resting `bottom` is under the keys, and showing the panel there
			// first is the very bug this replaced. The rise is CSS.
			panel.addClass("tmr-gloss-input-ready");
		} else if (allowFallback) {
			panel.style.removeProperty("bottom");
			panel.addClass("tmr-gloss-input-top");
			panel.addClass("tmr-gloss-input-ready");
			// Mobile has no console, and this branch means every box we know how
			// to measure claims the keyboard isn't there. Report what they said,
			// so a third round has data instead of another guess. Remove once the
			// bottom-docked path is confirmed on device.
			new Notice(`gloss dock: ${this.keyboardReport()}`, 8000);
		}
	}

	/** Retract every floater. Does *not* fire `onDismiss` — hosts call this from
	 *  their own dismissal path, so re-entering would loop. */
	hide(): void {
		this.hideBar();
		this.hideInput();
	}

	syncTheme(): void {
		const settings = this.opts.settings();
		for (const el of [this.barEl, this.inputEl, this.tooltipEl]) applyGlossTheme(el, settings);
	}

	// ── Floater construction ────────────────────────────────────────────────

	private ensureBar(): HTMLElement {
		if (this.barEl) return this.barEl;
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
				if (this.opts.disabledModes?.().has(mode.id)) return;
				this.openInput(mode.id, this.lastRect ?? tile.getBoundingClientRect());
			});
			// Custom tile tooltip (theme-synced, tinted per-mode). Replaces the
			// neutral Obsidian aria-label tooltip so the hint can inherit the
			// tile's fill colour and carry the numeric shortcut hint. A disabled
			// tile shows the host's reason instead of the shortcut hint.
			this.registerDomEvent(tile, "mouseenter", () => {
				// Touch synthesises mouseenter on tap, so without this the tooltip
				// fires on the very gesture that opens the input — and its hint is
				// a keyboard shortcut the phone has no way to send anyway.
				if (Platform.isMobile) return;
				const reason = this.opts.disabledModes?.().get(mode.id);
				this.showTileTooltip(tile, mode.id, reason ?? `${mode.label} (${idx + 1})`);
			});
			this.registerDomEvent(tile, "mouseleave", () => this.hideTileTooltip());
			// Separator stroke after the standard-highlight tile (Emphasise),
			// before the AI tiles. Hidden in Lite mode along with those tiles.
			if (idx === 0) bar.createEl("div", { cls: "tmr-gloss-sep" });
		});

		// Extend-across-pages action (not a gloss mode). Stays visible in Lite
		// mode — cross-page highlighting matters for plain Emphasise too. Hosts
		// without a cross-page model (PDF) omit `onExtend` and get no tile.
		const onExtend = this.opts.onExtend;
		if (onExtend) {
			bar.createEl("div", { cls: "tmr-gloss-sep tmr-gloss-sep-extend" });
			const extendTile = bar.createEl("button", { cls: "tmr-gloss-tile tmr-gloss-tile-extend" });
			setIcon(extendTile, "unfold-horizontal");
			this.registerDomEvent(extendTile, "mousedown", (e: MouseEvent) => e.preventDefault());
			this.registerDomEvent(extendTile, "click", (e: MouseEvent) => {
				e.stopPropagation();
				onExtend();
			});
			this.registerDomEvent(extendTile, "mouseenter", () => {
				if (Platform.isMobile) return;
				this.showTileTooltip(extendTile, "extend", "Extend across pages");
			});
			this.registerDomEvent(extendTile, "mouseleave", () => this.hideTileTooltip());
		}

		this.barEl = bar;
		this.syncTheme();
		return bar;
	}

	private ensureInput(): HTMLElement {
		if (this.inputEl) return this.inputEl;
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
			void this.submit();
		});
		this.registerDomEvent(input, "keydown", (e: KeyboardEvent) => {
			// While the wikilink popover is open, Enter/Escape belong to it —
			// its keymap scope (document-level) selects / closes once this
			// element-level handler declines the event.
			if (this.linkSuggest?.isSuggestOpen && (e.key === "Enter" || e.key === "Escape")) return;
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				void this.submit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				this.opts.onDismiss();
			}
		});
		// Bracket pairing, mirroring the native editor: typing `[[` drops a
		// matching `]]` after the caret. Registered before WikilinkSuggest is
		// constructed so its own `input` listener sees the paired value.
		this.registerDomEvent(input, "input", (e: Event) => {
			if ((e as InputEvent).data !== "[") return;
			const caret = input.selectionStart ?? 0;
			if (!input.value.slice(0, caret).endsWith("[[")) return;
			if (input.value.startsWith("]", caret)) return;
			input.value = input.value.slice(0, caret) + "]]" + input.value.slice(caret);
			input.setSelectionRange(caret, caret);
		});
		this.linkSuggest = new WikilinkSuggest(this.opts.app, input, () => this.opts.sourcePath());
		this.inputEl = panel;
		this.syncInputTheme();
		return panel;
	}

	private syncInputTheme(): void {
		applyGlossTheme(this.inputEl, this.opts.settings());
	}

	private async submit(): Promise<void> {
		const mode = this.activeMode;
		if (!mode) return;
		const input = this.inputEl?.querySelector<HTMLInputElement>(".tmr-gloss-input-field");
		const text = input?.value.trim() ?? "";
		// Non-emphasise modes require at least some text. Emphasise-with-empty
		// writes a bare colour-flagged callout (spec §Phase 2, Emphasise).
		if (mode !== "emphasise" && text.length === 0) {
			input?.focus();
			return;
		}
		await this.opts.onSubmit(mode, text);
	}

	// ── Tile tooltip ────────────────────────────────────────────────────────

	private showTileTooltip(tile: HTMLElement, modeId: string, label: string): void {
		const el = this.ensureTileTooltip();
		el.dataset.glossMode = modeId;
		el.setText(label);
		el.removeClass("tmr-hidden");
		const tileRect = tile.getBoundingClientRect();
		const tipRect = el.getBoundingClientRect();
		const safe = getSafeViewport();
		const margin = 6;
		const left = Math.max(safe.left + 4, Math.min(
			tileRect.left + tileRect.width / 2 - tipRect.width / 2,
			safe.right - tipRect.width - 4,
		));
		el.style.left = `${left}px`;
		el.style.top = `${tileRect.bottom + margin}px`;
	}

	private hideTileTooltip(): void {
		this.tooltipEl?.addClass("tmr-hidden");
	}

	private ensureTileTooltip(): HTMLElement {
		if (this.tooltipEl) return this.tooltipEl;
		const el = document.body.createEl("div", { cls: "tmr-gloss-tooltip tmr-hidden" });
		this.tooltipEl = el;
		this.syncTheme();
		return el;
	}

	// ── Positioning ─────────────────────────────────────────────────────────

	/** Rect the bar was last raised at. A tile click re-uses it so the input
	 *  panel opens over the selection, not over the tile. */
	private lastRect: DOMRect | null = null;

	/** Position a fixed-position floater (bar or input) relative to a selection
	 *  rect, flipping below if above doesn't fit and clamping to the viewport. */
	private positionFloater(el: HTMLElement, selectionRect: DOMRect): void {
		this.lastRect = selectionRect;
		el.setCssProps({ left: "0px", top: "0px" });
		const rect = el.getBoundingClientRect();
		const safe = getSafeViewport();
		const margin = 8;
		// Flip below when there isn't room above *within the safe area* — on a
		// phone the 16px of slack was being measured against the top of the
		// screen, i.e. behind the status bar.
		const flipBelow = selectionRect.top - safe.top < rect.height + margin + 16;
		const top = flipBelow
			? selectionRect.bottom + margin
			: selectionRect.top - rect.height - margin;
		const midX = selectionRect.left + selectionRect.width / 2;
		const maxLeft = safe.right - rect.width - 8;
		const left = Math.max(safe.left + 8, Math.min(midX - rect.width / 2, maxLeft));
		el.style.left = `${left}px`;
		el.style.top = `${Math.min(Math.max(safe.top + 8, top), safe.bottom - rect.height - 8)}px`;
	}
}

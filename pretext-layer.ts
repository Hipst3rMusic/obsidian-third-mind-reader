import {
	prepareWithSegments,
	layoutWithLines,
	type PreparedTextWithSegments,
	type LayoutCursor,
	type LayoutLinesResult,
} from "@chenglou/pretext";

// ─── Constants ───────────────────────────────────────────────────────────────

export const BODY_FONT = "15px Labrada, serif";
const BODY_LINE_HEIGHT = 15 * 1.65; // matches styles.css: font-size 15px, line-height 1.65
const MIN_OPENER_CHARS = 200;
const LEADING_WRAPPER_SELECTOR =
	'[class*="dropcap" i], [class*="drop-cap" i], [class*="initial" i], [class*="versal" i]';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParagraphEntry {
	paraId: string;                        // "s3-p7"
	element: HTMLElement;                  // live DOM <p> reference
	text: string;                          // textContent at preparation time
	prepared: PreparedTextWithSegments;
	layout: LayoutLinesResult | null;      // populated on relayout
	isChapterOpener: boolean;
}

/** A highlight range stored as pretext cursors — stable across re-renders.
 *  When `endParaId` is set and differs from `paraId`, the range spans multiple
 *  paragraphs: `start` is relative to `paraId`, `end` is relative to `endParaId`. */
export interface CursorRange {
	paraId: string;
	start: LayoutCursor;
	end: LayoutCursor;
	endParaId?: string;
}

// ─── OffsetMap ───────────────────────────────────────────────────────────────

export class OffsetMap {
	private entries = new Map<string, ParagraphEntry>();
	private orderedIds: string[] = [];

	/** Walk all <p> elements in a rendered unit, prepare each with pretext,
	 *  stamp data-para-id, and detect chapter openers for drop caps.
	 *  Additive: paraIds include a globally-unique spineIndex, so preparing
	 *  multiple units (current + prev + next) accumulates cleanly. Full reset
	 *  happens on book load via `clear()`. */
	prepareUnit(unitEl: HTMLElement, font: string = BODY_FONT): void {
		const spineItems = Array.from(unitEl.querySelectorAll(".tmr-spine-item")) as HTMLElement[];
		for (const spineItem of spineItems) {
			const spineIndex = parseInt(spineItem.dataset.spineIndex ?? "0", 10);
			// Body prose + list items are both annotatable. Lists stay DOM-rendered
			// (no pretext display layout), but registering them lets a selection
			// inside an <li> resolve to a CursorRange, so the GlossBar fires there.
			const blocks = Array.from(spineItem.querySelectorAll("p, li")) as HTMLElement[];
			const chapterOpenerIdx = findChapterOpenerIndex(spineItem);

			let paraCount = 0;
			for (const el of blocks) {
				if (!isRegisterableBlock(el)) continue;
				const text = el.textContent ?? "";

				const paraId = `s${spineIndex}-p${paraCount}`;
				el.dataset.paraId = paraId;

				// Only genuine prose <p> gets a drop cap (never an <li>). ToC entries,
				// dedications, epigraphs, and chapter-number-only pages all pass
				// findChapterOpenerIndex (heading → first <p>) but are too short to
				// warrant decoration.
				const isChapterOpener =
					el.tagName === "P" &&
					paraCount === chapterOpenerIdx &&
					text.trim().length >= MIN_OPENER_CHARS;

				if (isChapterOpener) {
					// Source-epub drop caps wrap the first letter in a span/b/i so
					// we can't rely on ::first-letter landing on the right glyph.
					// Flatten the leading wrapper before styling.
					normalizeLeadingWrapper(el);
					el.classList.add("tmr-drop-cap");
				}

				const prepared = prepareWithSegments(text, font);

				const entry: ParagraphEntry = {
					paraId,
					element: el,
					text,
					prepared,
					layout: null,
					isChapterOpener,
				};

				this.entries.set(paraId, entry);
				this.orderedIds.push(paraId);
				paraCount++;
			}
		}
	}

	/** Relayout all prepared paragraphs at the given column width.
	 *  Pure arithmetic — fast enough to call on every resize. */
	relayout(columnWidth: number, lineHeight: number = BODY_LINE_HEIGHT): void {
		for (const entry of this.entries.values()) {
			entry.layout = layoutWithLines(entry.prepared, columnWidth, lineHeight);
		}
	}

	/** Convert a DOM Selection to a CursorRange (for highlight creation).
	 *  Supports both single-paragraph and cross-paragraph selections. For
	 *  cross-paragraph ranges `endParaId` is set on the returned CursorRange. */
	selectionToCursors(sel: Selection): CursorRange | null {
		if (sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);

		const startP = findParentParagraph(range.startContainer);
		const endP = findParentParagraph(range.endContainer);
		if (!startP || !endP) return null;

		const paraId = startP.dataset.paraId;
		if (!paraId) return null;

		const startEntry = this.entries.get(paraId);
		if (!startEntry) return null;

		const startOffset = getCharOffsetInParagraph(startP, range.startContainer, range.startOffset);
		if (startOffset < 0) return null;

		const start = charOffsetToCursor(startEntry.prepared.segments, startOffset);
		if (!start) return null;

		const endParaId = endP.dataset.paraId;
		if (!endParaId) return null;

		// Single-paragraph case
		if (endParaId === paraId) {
			const endOffset = getCharOffsetInParagraph(endP, range.endContainer, range.endOffset);
			if (endOffset < 0) return null;
			const end = charOffsetToCursor(startEntry.prepared.segments, endOffset);
			if (!end) return null;
			return { paraId, start, end };
		}

		// Cross-paragraph case
		const endEntry = this.entries.get(endParaId);
		if (!endEntry) return null;
		const endOffset = getCharOffsetInParagraph(endP, range.endContainer, range.endOffset);
		if (endOffset < 0) return null;
		const end = charOffsetToCursor(endEntry.prepared.segments, endOffset);
		if (!end) return null;
		return { paraId, start, end, endParaId };
	}

	/** Convert a CursorRange back to a DOM Range (for rendering highlights).
	 *  Handles both single-paragraph and cross-paragraph ranges. */
	cursorsToRange(cursorRange: CursorRange): Range | null {
		const startEntry = this.entries.get(cursorRange.paraId);
		if (!startEntry) return null;

		const startOffset = cursorToCharOffset(startEntry.prepared.segments, cursorRange.start);
		if (startOffset < 0) return null;
		const startPos = charOffsetToTextNode(startEntry.element, startOffset);
		if (!startPos) return null;

		const endParaId = cursorRange.endParaId ?? cursorRange.paraId;
		const endEntry = this.entries.get(endParaId);
		if (!endEntry) return null;

		const endOffset = cursorToCharOffset(endEntry.prepared.segments, cursorRange.end);
		if (endOffset < 0) return null;
		const endPos = charOffsetToTextNode(endEntry.element, endOffset);
		if (!endPos) return null;

		const range = document.createRange();
		range.setStart(startPos.node, startPos.offset);
		range.setEnd(endPos.node, endPos.offset);
		return range;
	}

	/** Convert a CursorRange to an array of per-paragraph DOM Ranges for rendering.
	 *  Single-paragraph ranges return a single-element array (same as cursorsToRange).
	 *  Cross-paragraph ranges are split into one Range per paragraph so that
	 *  getClientRects() on each sub-range only returns text-width rects —
	 *  a single spanning Range would produce a full-block-width rect for every
	 *  fully-enclosed middle paragraph. */
	cursorsToRanges(cursorRange: CursorRange): Range[] {
		// Single-paragraph: delegate to the existing method
		if (!cursorRange.endParaId || cursorRange.endParaId === cursorRange.paraId) {
			const r = this.cursorsToRange(cursorRange);
			return r ? [r] : [];
		}

		const startIdx = this.orderedIds.indexOf(cursorRange.paraId);
		const endIdx = this.orderedIds.indexOf(cursorRange.endParaId);
		// Fall back to a single spanning range if we can't find both in the ordered list
		if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
			const r = this.cursorsToRange(cursorRange);
			return r ? [r] : [];
		}

		const ranges: Range[] = [];
		for (let i = startIdx; i <= endIdx; i++) {
			const paraId = this.orderedIds[i];
			const entry = this.entries.get(paraId);
			if (!entry) continue;

			let startPos: { node: Text; offset: number } | null;
			let endPos: { node: Text; offset: number } | null;

			if (i === startIdx) {
				const off = cursorToCharOffset(entry.prepared.segments, cursorRange.start);
				startPos = charOffsetToTextNode(entry.element, off);
				endPos = charOffsetToTextNode(entry.element, entry.text.length);
			} else if (i === endIdx) {
				startPos = charOffsetToTextNode(entry.element, 0);
				const off = cursorToCharOffset(entry.prepared.segments, cursorRange.end);
				endPos = charOffsetToTextNode(entry.element, off);
			} else {
				startPos = charOffsetToTextNode(entry.element, 0);
				endPos = charOffsetToTextNode(entry.element, entry.text.length);
			}

			if (!startPos || !endPos) continue;
			const r = document.createRange();
			r.setStart(startPos.node, startPos.offset);
			r.setEnd(endPos.node, endPos.offset);
			ranges.push(r);
		}
		return ranges;
	}

	/** Convert a CursorRange to absolute character offsets.
	 *  For single-paragraph ranges both offsets are within `paraId`.
	 *  For cross-paragraph ranges `startChar` is within `paraId` and
	 *  `endChar` is within `endParaId`. Segment-agnostic — survives
	 *  pretext re-segmentation across versions. */
	cursorRangeToChars(cursorRange: CursorRange): { startChar: number; endChar: number } | null {
		const startEntry = this.entries.get(cursorRange.paraId);
		if (!startEntry) return null;
		const startChar = cursorToCharOffset(startEntry.prepared.segments, cursorRange.start);
		if (startChar < 0) return null;

		const endParaId = cursorRange.endParaId ?? cursorRange.paraId;
		const endEntry = this.entries.get(endParaId);
		if (!endEntry) return null;
		const endChar = cursorToCharOffset(endEntry.prepared.segments, cursorRange.end);
		if (endChar < 0) return null;
		return { startChar, endChar };
	}

	/** Inverse of cursorRangeToChars — rebuild a CursorRange from stored
	 *  character offsets. Called at paint time for saved highlights.
	 *  `endParaId` is optional; when absent both offsets are within `paraId`. */
	charRangeToCursorRange(
		paraId: string,
		startChar: number,
		endChar: number,
		endParaId?: string,
	): CursorRange | null {
		const startEntry = this.entries.get(paraId);
		if (!startEntry) return null;
		const start = charOffsetToCursor(startEntry.prepared.segments, startChar);
		if (!start) return null;

		const resolvedEndParaId = endParaId ?? paraId;
		const endEntry = this.entries.get(resolvedEndParaId);
		if (!endEntry) return null;
		const end = charOffsetToCursor(endEntry.prepared.segments, endChar);
		if (!end) return null;

		const result: CursorRange = { paraId, start, end };
		if (endParaId && endParaId !== paraId) result.endParaId = endParaId;
		return result;
	}

	/** Locate a paraId by its opening text (reflow-recovery). Prefers `hintParaId`
	 *  if its text still matches the prefix; otherwise scans all entries for
	 *  the first whose normalized text starts with `prefix`. Whitespace is
	 *  collapsed on both sides so minor source-whitespace changes don't break
	 *  recovery. */
	findParaIdByPrefix(prefix: string, hintParaId?: string): string | null {
		if (!prefix) return hintParaId && this.entries.has(hintParaId) ? hintParaId : null;
		const norm = (s: string) => s.replace(/\s+/g, " ").trim();
		const needle = norm(prefix);
		if (hintParaId) {
			const hint = this.entries.get(hintParaId);
			if (hint && norm(hint.text).startsWith(needle)) return hintParaId;
		}
		for (const [paraId, entry] of this.entries) {
			if (norm(entry.text).startsWith(needle)) return paraId;
		}
		return null;
	}

	get(paraId: string): ParagraphEntry | null {
		return this.entries.get(paraId) ?? null;
	}

	get size(): number {
		return this.entries.size;
	}

	clear(): void {
		this.entries.clear();
		this.orderedIds = [];
	}
}

// ─── Chapter opener detection ────────────────────────────────────────────────

const HEADING_SELECTOR = "h1, h2, h3, [epub\\:type='title'], [data-epub-type='title']";

/**
 * Source epubs sometimes ship their own drop-cap styling by wrapping the first
 * glyph in a styled span (e.g. `<p><span class="dropcap">W</span>hen ...</p>`).
 * That wrapper's font-size/float collides with our `::first-letter` rule —
 * the wrapper gets one treatment, our rule targets the *next* letter, and the
 * result is the "first letter as superscript, second letter enlarged" bug.
 *
 * Flatten the leading wrapper so the paragraph begins with a plain text node
 * and `::first-letter` lands on the intended glyph.
 */
function normalizeLeadingWrapper(p: HTMLElement): void {
	const first = p.firstElementChild as HTMLElement | null;
	if (!first) return;
	// Only consider inline wrappers at the very start — no intervening text.
	if (p.firstChild !== first) return;
	const isLeadingWrapper =
		first.matches(LEADING_WRAPPER_SELECTOR) ||
		// Short inline element with a single grapheme, common naked-dropcap shape.
		(/^(SPAN|B|I|EM|STRONG)$/.test(first.tagName) &&
			(first.textContent ?? "").trim().length <= 2);
	if (!isLeadingWrapper) return;
	const text = document.createTextNode(first.textContent ?? "");
	first.replaceWith(text);
}

/**
 * Find the index (among non-empty <p> elements) of the first paragraph
 * that follows a heading in this spine item. Returns -1 if no heading exists
 * (title pages, copyright pages, dedications don't get drop caps).
 */
/** A block is annotatable if it holds inline prose: any non-empty <p>, or a
 *  leaf <li> (no nested paragraph or sub-list). Container <li>s are skipped so
 *  their inner <p>/<li> register individually instead of double-counting. */
function isRegisterableBlock(el: HTMLElement): boolean {
	if (!(el.textContent ?? "").trim()) return false;
	if (el.tagName === "P") return true;
	if (el.tagName === "LI") return !el.querySelector("p, ul, ol, li");
	return false;
}

function findChapterOpenerIndex(spineItem: HTMLElement): number {
	const headings = spineItem.querySelectorAll(HEADING_SELECTOR);
	if (headings.length === 0) return -1;

	// Find the last heading, then the first <p> after it
	const lastHeading = headings[headings.length - 1];
	let node: Element | null = lastHeading;

	// Walk forward through siblings and descendants to find the first <p>
	while (node) {
		const nextP = walkToNextParagraph(node, spineItem);
		if (nextP) {
			// Count the opener's index among the same blocks prepareUnit registers,
			// so it matches paraCount even when a list precedes it.
			const blocks = Array.from(spineItem.querySelectorAll("p, li")) as HTMLElement[];
			let nonEmptyIdx = 0;
			for (const el of blocks) {
				if (!isRegisterableBlock(el)) continue;
				if (el === nextP) return nonEmptyIdx;
				nonEmptyIdx++;
			}
			return -1;
		}
		break;
	}

	return -1;
}

/** Walk DOM forward from `start` to find the next <p> element within `boundary`. */
function walkToNextParagraph(start: Element, boundary: HTMLElement): HTMLElement | null {
	let current: Node | null = start;
	while (current) {
		// Check next sibling and its descendants
		if (current.nextSibling) {
			current = current.nextSibling;
			if (current.nodeType === Node.ELEMENT_NODE) {
				const el = current as HTMLElement;
				if (el.tagName === "P" && (el.textContent ?? "").trim()) return el;
				const inner = el.querySelector("p");
				if (inner && (inner.textContent ?? "").trim()) return inner as HTMLElement;
			}
		} else {
			// Move up to parent's next sibling
			current = current.parentElement;
			if (!current || current === boundary) return null;
		}
	}
	return null;
}

// ─── DOM ↔ cursor conversion helpers ─────────────────────────────────────────

/** Find the closest ancestor block we registered — a <p> or <li> stamped with
 *  a data-para-id during prepareUnit. */
function findParentParagraph(node: Node): HTMLElement | null {
	let current: Node | null = node;
	while (current) {
		if (current.nodeType === Node.ELEMENT_NODE) {
			const el = current as HTMLElement;
			if (el.dataset.paraId) return el;
		}
		current = current.parentNode;
	}
	return null;
}

/** Compute the character offset from the start of a paragraph to a position
 *  within one of its descendant text nodes. */
function getCharOffsetInParagraph(paragraph: HTMLElement, node: Node, offset: number): number {
	const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
	let charCount = 0;
	let current: Text | null;
	while ((current = walker.nextNode() as Text | null)) {
		if (current === node) return charCount + offset;
		charCount += current.textContent?.length ?? 0;
	}
	return -1;
}

/** Convert a character offset within a paragraph's textContent to a
 *  {node, offset} position in the DOM text node tree. */
function charOffsetToTextNode(paragraph: HTMLElement, charOffset: number): { node: Text; offset: number } | null {
	const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
	let remaining = charOffset;
	let current: Text | null;
	while ((current = walker.nextNode() as Text | null)) {
		const len = current.textContent?.length ?? 0;
		if (remaining <= len) return { node: current, offset: remaining };
		remaining -= len;
	}
	return null;
}

/** Convert a character offset to a LayoutCursor by walking pretext segments. */
function charOffsetToCursor(segments: string[], charOffset: number): LayoutCursor | null {
	let remaining = charOffset;
	for (let i = 0; i < segments.length; i++) {
		const segLen = segments[i].length;
		if (remaining <= segLen) {
			return { segmentIndex: i, graphemeIndex: remaining };
		}
		remaining -= segLen;
	}
	// Past the end — clamp to final position
	if (segments.length > 0) {
		const last = segments.length - 1;
		return { segmentIndex: last, graphemeIndex: segments[last].length };
	}
	return null;
}

/** Convert a LayoutCursor back to a character offset by summing segment lengths. */
function cursorToCharOffset(segments: string[], cursor: LayoutCursor): number {
	let offset = 0;
	for (let i = 0; i < cursor.segmentIndex && i < segments.length; i++) {
		offset += segments[i].length;
	}
	return offset + cursor.graphemeIndex;
}

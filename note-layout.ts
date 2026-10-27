/** Companion-doc layout: `## Chapter` headings in book order, with the plugin's
 *  callouts in book order beneath them. Pure string surgery. Only our own
 *  callouts ever move; headings and text the reader wrote stay where they are. */

/** A heading's span over a callout key's first element: the spine index for
 *  EPUBs, the page for PDFs. Half-open. */
export interface NoteSection {
	title: string;
	start: number;
	end: number;
}

/** Book position of a callout: `[spine, para, char]` or `[page, textDiv, offset]`. */
export type CalloutKey = number[];

interface CalloutSpan {
	start: number;
	end: number;
	key: CalloutKey | null;
}

interface HeadingRegion {
	headingIdx: number;
	title: string;
	end: number;
}

const OUR_CALLOUT_RE = /^>\s*\[!(?:exclaim|explain|examine|emphasise|enquiry|bookmark)\]/;
const ANY_CALLOUT_RE = /^>\s*\[!/;
const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const REGION_BREAK_RE = /^#{1,2}\s/;

export function calloutKey(lines: string[]): CalloutKey | null {
	const anchor = lines.find((l) => l.includes("tmr-anchor"));
	if (!anchor) return null;
	const pdf = /pdfPage:(\d+)\s+pdfSel:(\d+),(\d+)/.exec(anchor);
	if (pdf) return [Number(pdf[1]), Number(pdf[2]), Number(pdf[3])];
	const para = /para:"?s(\d+)-p(\d+)/.exec(anchor);
	if (!para) return null;
	const chars = /chars:(-?\d+)/.exec(anchor);
	return [Number(para[1]), Number(para[2]), chars ? Number(chars[1]) : -1];
}

function compareKeys(a: CalloutKey, b: CalloutKey): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

function bodyStart(lines: string[]): number {
	if (lines[0] !== "---") return 0;
	const close = lines.indexOf("---", 1);
	return close === -1 ? 0 : close + 1;
}

function scanCallouts(lines: string[]): CalloutSpan[] {
	const spans: CalloutSpan[] = [];
	let i = bodyStart(lines);
	while (i < lines.length) {
		if (!OUR_CALLOUT_RE.test(lines[i])) { i++; continue; }
		let j = i + 1;
		while (j < lines.length && lines[j].startsWith(">") && !ANY_CALLOUT_RE.test(lines[j])) j++;
		spans.push({ start: i, end: j, key: calloutKey(lines.slice(i, j)) });
		i = j;
	}
	return spans;
}

function scanRegions(lines: string[]): HeadingRegion[] {
	const regions: HeadingRegion[] = [];
	for (let i = bodyStart(lines); i < lines.length; i++) {
		const m = SECTION_HEADING_RE.exec(lines[i]);
		if (!m) continue;
		let end = i + 1;
		while (end < lines.length && !REGION_BREAK_RE.test(lines[end])) end++;
		regions.push({ headingIdx: i, title: m[1], end });
	}
	return regions;
}

const isBlank = (line: string | undefined): boolean => line !== undefined && line.trim() === "";

function insertBefore(lines: string[], idx: number, block: string[]): string[] {
	const head = lines.slice(0, idx);
	const lead = head.length && !isBlank(head[head.length - 1]) ? [""] : [];
	return [...head, ...lead, ...block, "", ...lines.slice(idx)];
}

function insertAfter(lines: string[], idx: number, block: string[]): string[] {
	const tail = lines.slice(idx + 1);
	const trail = tail.length && !isBlank(tail[0]) ? [""] : [];
	return [...lines.slice(0, idx + 1), "", ...block, ...trail, ...tail];
}

function append(lines: string[], block: string[]): string[] {
	const out = lines.slice();
	while (out.length && isBlank(out[out.length - 1])) out.pop();
	return [...out, "", ...block, ""];
}

/** Place `callout` under its section's heading (created in book order if
 *  missing), before the first callout that comes later in the book. A heading
 *  only matches if its callouts fall in the section's range, since chapter
 *  titles repeat. No section, or no anchor: append at the end. */
export function insertCallout(doc: string, callout: string, section: NoteSection | null): string {
	const lines = doc.split("\n");
	const block = callout.split("\n");
	const key = calloutKey(block);
	if (!section || !key) return append(lines, block).join("\n");

	const callouts = scanCallouts(lines);
	const regions = scanRegions(lines);
	const within = (r: HeadingRegion) => callouts.filter((c) => c.start > r.headingIdx && c.start < r.end);
	const keysIn = (r: HeadingRegion) => within(r).flatMap((c) => (c.key ? [c.key] : []));
	const inSection = (k: CalloutKey) => k[0] >= section.start && k[0] < section.end;

	const named = regions.filter((r) => r.title === section.title);
	const target = named.find((r) => keysIn(r).some(inSection)) ?? named.find((r) => keysIn(r).length === 0);
	if (target) {
		const later = within(target).find((c) => c.key && compareKeys(c.key, key) > 0);
		if (later) return insertBefore(lines, later.start, block).join("\n");
		let last = target.end - 1;
		while (last > target.headingIdx && isBlank(lines[last])) last--;
		return insertAfter(lines, last, block).join("\n");
	}

	const headed = [`## ${section.title}`, "", ...block];
	const next = regions.find((r) => {
		const keys = keysIn(r);
		return keys.length > 0 && Math.min(...keys.map((k) => k[0])) >= section.end;
	});
	return (next ? insertBefore(lines, next.headingIdx, headed) : append(lines, headed)).join("\n");
}

/** The heading for an EPUB spine index, given the book's sections (inclusive spine ranges). */
export function spineNoteSection(
	sections: { label: string; startSpine: number; endSpine: number }[],
	spine: number,
): NoteSection | null {
	const section = sections.find((s) => spine >= s.startSpine && spine <= s.endSpine);
	if (!section) return null;
	const title = section.label.replace(/\s+/g, " ").trim() || "Untitled";
	return { title, start: section.startSpine, end: section.endSpine + 1 };
}

/** True when `organiseNote` would change the note: an anchored callout outside
 *  every `##` section, or an older callout missing the blank lines new ones get. */
export function needsOrganising(doc: string): boolean {
	const lines = doc.split("\n");
	const regions = scanRegions(lines);
	const unfiled = scanCallouts(lines).some((c) => c.key && !regions.some((r) => c.start > r.headingIdx && c.start < r.end));
	return unfiled || spaceCallouts(doc) !== doc;
}

const BLANK_QUOTE_RE = /^>\s*$/;
const NESTED_QUOTE_RE = /^>\s?>/;

/** Give older callouts the blank lines new ones get: under the quote, or lazy
 *  continuation folds the next line into it, and between a prompt and its `AI:` reply. */
function spaceCallouts(doc: string): string {
	const out: string[] = [];
	let ours = false;
	let afterPrompt = false;
	for (const line of doc.split("\n")) {
		const header = ANY_CALLOUT_RE.test(line);
		if (header) {
			ours = OUR_CALLOUT_RE.test(line);
			afterPrompt = false;
		} else if (!line.startsWith(">")) {
			ours = false;
		}
		const text = line.replace(/^>\s?/, "");
		const prev = out[out.length - 1] ?? "";
		const underQuote = NESTED_QUOTE_RE.test(prev) && !NESTED_QUOTE_RE.test(line) && !BLANK_QUOTE_RE.test(line)
			&& !/^(<!--|—)/.test(text.trim());
		const replyUnderPrompt = afterPrompt && text.startsWith("AI:") && !BLANK_QUOTE_RE.test(prev);
		if (ours && !header && (underQuote || replyUnderPrompt)) out.push(">");
		if (ours && text.startsWith("User:")) afterPrompt = true;
		else if (ours && text.startsWith("AI:")) afterPrompt = false;
		out.push(line);
	}
	return out.join("\n");
}

const FOLD_RE =/^(>\s*\[!(?:exclaim|explain|examine|emphasise|enquiry|bookmark)\])([+-])/;

/** Lines `[from, to)` of the `##` section containing `line`, or null outside one. */
export function sectionRangeAt(doc: string, line: number): { from: number; to: number } | null {
	const region = scanRegions(doc.split("\n")).find((r) => line >= r.headingIdx && line < r.end);
	return region ? { from: region.headingIdx, to: region.end } : null;
}

export function hasCollapsedCallout(doc: string, range?: { from: number; to: number }): boolean {
	const lines = doc.split("\n").slice(range?.from ?? 0, range?.to);
	return lines.some((l) => FOLD_RE.exec(l)?.[2] === "-");
}

/** Set every foldable callout of ours in `range` (default: the whole note) to
 *  expanded `+` or collapsed `-`. Unfoldable callouts and other callouts are left alone. */
export function setCalloutFold(doc: string, expanded: boolean, range?: { from: number; to: number }): string {
	const lines = doc.split("\n");
	const from = range?.from ?? 0;
	const to = range?.to ?? lines.length;
	for (let i = from; i < to; i++) lines[i] = lines[i].replace(FOLD_RE, `$1${expanded ? "+" : "-"}`);
	return lines.join("\n");
}

/** Delete the callout at lines `[start, end)` with one adjacent blank line, and
 *  its `##` heading too when nothing but blank lines would remain under it. */
export function removeCallout(lines: string[], start: number, end: number): string {
	if (lines[end] === "") end++;
	else if (start > 0 && lines[start - 1] === "") start--;
	const out = [...lines.slice(0, start), ...lines.slice(end)];
	const region = scanRegions(out).find((r) => start > r.headingIdx && start <= r.end);
	if (region && out.slice(region.headingIdx + 1, region.end).every(isBlank)) {
		out.splice(region.headingIdx, region.end - region.headingIdx);
	}
	return out.join("\n");
}

/** File every anchored callout under its section heading, in book order, and
 *  rule off older replies. Anything else in the note, including the reader's own text, stays put. */
export function organiseNote(doc: string, sectionFor: (key: CalloutKey) => NoteSection | null): string {
	const lines = spaceCallouts(doc).split("\n");
	const callouts = scanCallouts(lines).filter((c): c is CalloutSpan & { key: CalloutKey } => c.key !== null);
	if (!callouts.length) return doc;
	const blocks = callouts.map((c) => ({ key: c.key, text: lines.slice(c.start, c.end).join("\n") }));
	for (const c of callouts.slice().reverse()) {
		const end = isBlank(lines[c.end]) ? c.end + 1 : c.end;
		lines.splice(c.start, end - c.start);
	}
	let out = lines.join("\n");
	for (const b of blocks.sort((x, y) => compareKeys(x.key, y.key))) {
		out = insertCallout(out, b.text, sectionFor(b.key));
	}
	return out;
}

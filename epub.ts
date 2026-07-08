import JSZip from "jszip";
import * as nodePath from "path";
import { promises as nodeFs } from "fs";
import DOMPurify from "dompurify";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EpubManifestItem {
	id: string;
	href: string;         // path relative to OPF directory
	mediaType: string;
	properties?: string;
}

export interface EpubTocItem {
	label: string;
	href: string;
	children: EpubTocItem[];
}

export interface EpubLinkPreview {
	kind: "text" | "image";
	text?: string;
	imageSrc?: string;
	caption?: string;
}

export interface EpubCitation {
	text: string;  // full citation text incl. "[N]" prefix
	href: string;  // navigable target: "<bibliography-spine-href>#tmr-cite-N"
}

export interface EpubBook {
	title: string;
	spine: EpubManifestItem[];
	manifest: Record<string, EpubManifestItem>;
	toc: EpubTocItem[];
	imageMap: Record<string, string>;  // href → blob URL
	blobUrls: string[];
	opfDir: string;
	cssCache: Record<string, string>;  // manifest-relative href → css text
	citations: Record<number, EpubCitation>;  // citation number → text + navigable target
	// One of these will be set depending on source format
	zip?: JSZip;
	dirPath?: string;  // absolute path for exploded epubs
}

export interface ResolvedEpubHref {
	path: string;
	fragment: string | null;
	resolvedHref: string;
}

const previewDocCache = new WeakMap<EpubBook, Map<string, Promise<Document | null>>>();
const PREVIEW_MAX_CHARS = 900;
const NOTEISH_PATH_RE = /(note|footnote|endnote|gloss|appendix|backmatter|reference|bibliograph|index)/i;
const NOTEISH_ATTR_RE = /\b(footnote|endnote|gloss|glossary|glossdef|note|fn\d*|rfn\d*)\b/i;
const NOTEISH_MARKER_RE = /^(?:\d+|[*†‡§¶])(?:[.)]|\s)\s*\S/;

export function revokeImageUrls(book: EpubBook): void {
	book.blobUrls.forEach((url) => URL.revokeObjectURL(url));
	book.blobUrls = [];
}

// ─── Parse from zip (standard .epub file) ────────────────────────────────────

export async function parseEpub(data: ArrayBuffer): Promise<EpubBook> {
	const zip = await JSZip.loadAsync(data);
	const fs: EpubFS = {
		readString: (p) => zip.file(p)!.async("string"),
		readBytes: async (p) => {
			const bytes = await zip.file(p)!.async("uint8array");
			return bytes;
		},
		exists: async (p) => zip.file(p) !== null,
	};
	const book = await parseWithFS(fs);
	book.zip = zip;
	return book;
}

// ─── Parse from directory (exploded epub) ────────────────────────────────────

export async function parseEpubDir(absoluteDirPath: string): Promise<EpubBook> {
	const fs: EpubFS = {
		readString: (p) => nodeFs.readFile(nodePath.join(absoluteDirPath, p), "utf8"),
		readBytes: async (p) => {
			const buf = await nodeFs.readFile(nodePath.join(absoluteDirPath, p));
			return new Uint8Array(buf);
		},
		exists: async (p) => {
			try {
				await nodeFs.access(nodePath.join(absoluteDirPath, p));
				return true;
			} catch {
				return false;
			}
		},
	};
	const book = await parseWithFS(fs);
	book.dirPath = absoluteDirPath;
	return book;
}

// ─── Lightweight metadata read (Library scan) ────────────────────────────────

export interface EpubMeta {
	title: string;
	author: string;
}

/** Cheap metadata-only read: decompress just `container.xml` + the OPF and
 *  parse title + author. Unlike `parseEpub`/`parseWithFS` it does NOT decompress
 *  chapters, images, or CSS, and does not scan the spine for citations — so the
 *  Library can scan a whole folder without paying the full-load cost per book. */
export async function readEpubMeta(data: ArrayBuffer): Promise<EpubMeta> {
	const zip = await JSZip.loadAsync(data);
	const containerFile = zip.file("META-INF/container.xml");
	if (!containerFile) throw new Error("readEpubMeta: missing META-INF/container.xml");
	const opfPath = parseContainerXml(await containerFile.async("string"));
	const opfFile = zip.file(opfPath);
	if (!opfFile) throw new Error(`readEpubMeta: missing OPF at ${opfPath}`);
	const { title, author } = parseOpf(await opfFile.async("string"), "");
	return { title, author };
}

// ─── Shared parse logic ───────────────────────────────────────────────────────

interface EpubFS {
	readString(path: string): Promise<string>;
	readBytes(path: string): Promise<Uint8Array>;
	exists(path: string): Promise<boolean>;
}

async function parseWithFS(fs: EpubFS): Promise<EpubBook> {
	// 1. container.xml → OPF path
	const containerXml = await fs.readString("META-INF/container.xml");
	const opfPath = parseContainerXml(containerXml);
	const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";

	// 2. OPF → spine + manifest + title
	const opfXml = await fs.readString(opfPath);
	const { title, spine, manifest } = parseOpf(opfXml, opfDir);

	// 3. nav.xhtml → ToC (fall back to toc.ncx)
	const navItem = Object.values(manifest).find(i => i.properties === "nav");
	let toc: EpubTocItem[] = [];
	if (navItem && await fs.exists(opfDir + navItem.href)) {
		const navXml = await fs.readString(opfDir + navItem.href);
		toc = parseNav(navXml);
		const navDir = navItem.href.includes("/")
			? navItem.href.substring(0, navItem.href.lastIndexOf("/") + 1)
			: "";
		toc = resolveTocHrefs(toc, navDir);
	} else {
		// Try toc.ncx
		const ncxItem = Object.values(manifest).find(i => i.mediaType === "application/x-dtbncx+xml");
		if (ncxItem && await fs.exists(opfDir + ncxItem.href)) {
			const ncxXml = await fs.readString(opfDir + ncxItem.href);
			toc = parseNcx(ncxXml);
			const ncxDir = ncxItem.href.includes("/")
				? ncxItem.href.substring(0, ncxItem.href.lastIndexOf("/") + 1)
				: "";
			toc = resolveTocHrefs(toc, ncxDir);
		}
	}
	// If every chapter is nested under a single root wrapper entry (a common
	// epub conversion artifact), hoist the children to avoid a redundant top
	// item that adds no navigational value.
	if (toc.length === 1 && toc[0].children.length > 0) toc = toc[0].children;

	// 4. Pre-load images as blob URLs
	const imageMap: Record<string, string> = {};
	const blobUrls: string[] = [];
	const imageItems = Object.values(manifest).filter(i => i.mediaType.startsWith("image/"));
	await Promise.all(
		imageItems.map(async (item) => {
			const filePath = opfDir + item.href;
			if (!await fs.exists(filePath)) return;
			const bytes = await fs.readBytes(filePath);
			const blob = new Blob([bytes.buffer as ArrayBuffer], { type: item.mediaType });
			const url = URL.createObjectURL(blob);
			imageMap[item.href] = url;
			blobUrls.push(url);
		})
	);

	// 5. Pre-load CSS files for layout style extraction
	const cssCache: Record<string, string> = {};
	const cssItems = Object.values(manifest).filter(i => i.mediaType === "text/css");
	await Promise.all(
		cssItems.map(async (item) => {
			const filePath = opfDir + item.href;
			if (!await fs.exists(filePath)) return;
			try { cssCache[item.href] = await fs.readString(filePath); } catch { /* skip */ }
		})
	);

	// 6. Pre-scan spine items for bibliography-style citations (e.g. "[78] Author...")
	const citations = await parseCitationsFromSpine(fs, opfDir, spine);

	return { title, spine, manifest, toc, imageMap, blobUrls, opfDir, cssCache, citations };
}

/** Walk every spine item looking for paragraphs whose text begins with "[N] ".
 *  These are taken as bibliography entries — the most common epub convention
 *  for end-of-book endnotes/references (and what the Naval Almanack uses via
 *  the Scribe publishing platform). Stored once at book-load so [N] markers
 *  anywhere in the body text can resolve to their full citation. */
async function parseCitationsFromSpine(fs: EpubFS, opfDir: string, spine: EpubManifestItem[]): Promise<Record<number, EpubCitation>> {
	const citations: Record<number, EpubCitation> = {};
	const re = /^\s*\[(\d+)\]\s+\S/;
	// Process spine in order so the first occurrence of each citation wins.
	for (const item of spine) {
		const path = opfDir + item.href;
		if (!await fs.exists(path)) continue;
		let html: string;
		try { html = await fs.readString(path); } catch { continue; }
		// Cheap pre-filter: only parse if the file contains anything resembling a citation
		if (!/\[\d+\]/.test(html)) continue;
		const doc = new DOMParser().parseFromString(html, 'text/html');
		doc.querySelectorAll('p, li, div').forEach(el => {
			// Skip elements that contain block children — we want leaf paragraphs only
			if (el.querySelector('p, li, div')) return;
			const text = (el.textContent ?? '').trim();
			const m = re.exec(text);
			if (!m) return;
			const n = parseInt(m[1], 10);
			if (!Number.isFinite(n)) return;
			// First occurrence wins — bibliographies are usually unique
			if (citations[n] === undefined) {
				citations[n] = { text, href: `${item.href}#tmr-cite-${n}` };
			}
		});
	}
	return citations;
}

/** Add id="tmr-cite-N" to bibliography paragraphs so citation links can
 *  navigate to them. Runs before the spine-prefix step, so the id picks up
 *  the standard sNN- prefix and resolves via the reader's findTarget. */
function tagCitationTargets(root: HTMLElement, citations: Record<number, EpubCitation> | undefined): void {
	if (!citations || Object.keys(citations).length === 0) return;
	const re = /^\s*\[(\d+)\]\s+\S/;
	root.querySelectorAll('p, li, div').forEach(el => {
		if (el.querySelector('p, li, div')) return;
		if (el.id) return;  // don't clobber an existing id
		const m = re.exec((el.textContent ?? '').trim());
		if (!m) return;
		const n = parseInt(m[1], 10);
		if (citations[n] !== undefined) el.id = `tmr-cite-${n}`;
	});
}

export function resolveEpubHref(baseHref: string, href: string): ResolvedEpubHref | null {
	const trimmed = href.trim();
	if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;

	const [rawPath, rawFragment] = trimmed.split("#", 2);
	const baseDir = baseHref.includes("/")
		? baseHref.substring(0, baseHref.lastIndexOf("/") + 1)
		: "";
	const path = rawPath
		? resolveRelativePath(baseDir + safeDecodeURI(rawPath))
		: baseHref;
	const fragment = rawFragment ? safeDecodeURI(rawFragment) : null;
	return {
		path,
		fragment,
		resolvedHref: fragment ? `${path}#${fragment}` : path,
	};
}

export async function extractLinkPreview(
	book: EpubBook,
	baseHref: string,
	href: string,
): Promise<EpubLinkPreview | null> {
	const resolved = resolveEpubHref(baseHref, href);
	if (!resolved) return null;

	const doc = await getPreviewDocument(book, resolved.path);
	if (!doc) return null;

	const body = doc.querySelector("body");
	if (!body) return null;

	let target: Element | null = resolved.fragment
		? doc.getElementById(resolved.fragment)
		: body.firstElementChild ?? body;
	if (!target) return null;

	// Calibre-style epubs use empty <a id="..."> bookmark anchors placed immediately
	// before the actual content element. Step forward past empty siblings to content.
	if (!target.textContent?.trim()) {
		let sib = target.nextElementSibling;
		while (sib && !sib.textContent?.trim()) sib = sib.nextElementSibling;
		if (sib) target = sib;
	}

	const imagePreview = buildImagePreview(target, resolved.path, book);
	if (imagePreview) return imagePreview;

	// For direct fragment targets: use the element's text directly rather than
	// relying on heuristics designed for whole-page discovery. The heuristics
	// filter by noteish class/path, but Calibre epubs use generic class names.
	if (resolved.fragment) {
		const directText = normalizePreviewText(target.textContent ?? "");
		if (directText.length >= 12 && directText.length <= 2200) {
			const cleaned = directText.replace(/^(?:\d+|[*†‡§¶])(?:[.)\s])\s*/, "").trim();
			return { kind: "text", text: truncatePreviewText(cleaned.length >= 12 ? cleaned : directText) };
		}
	}

	return buildTextPreview(target, resolved.path);
}

export async function renderSpineRange(
	book: EpubBook,
	startSpine: number,
	endSpine: number,
	container: HTMLElement,
): Promise<void> {
	container.empty();

	const start = Math.max(0, startSpine);
	const end = Math.min(endSpine, book.spine.length - 1);
	if (start > end) return;

	for (let i = start; i <= end; i++) {
		const item = book.spine[i];
		const wrapper = document.createElement("div");
		wrapper.className = "tmr-spine-item";
		wrapper.dataset.spineIndex = String(i);
		container.appendChild(wrapper);

		let raw: string;
		const filePath = book.opfDir + item.href;

		if (book.zip) {
			raw = await book.zip.file(filePath)!.async("string");
		} else if (book.dirPath) {
			raw = await nodeFs.readFile(nodePath.join(book.dirPath, filePath), "utf8");
		} else {
			throw new Error("EpubBook has neither zip nor dirPath");
		}

		const parser = new DOMParser();
		const doc = parser.parseFromString(raw, "text/html");
		const body = doc.querySelector("body");
		if (!body) continue;

		// Extract epub CSS and apply layout properties as inline styles
		const cssTexts = collectCssTexts(doc, item, book);
		applyLayoutStyles(body, cssTexts);

		// Strip stylesheets and scripts — our CSS provides visual styling
		body.querySelectorAll("style, script, link[rel='stylesheet']").forEach(el => el.remove());

		// Filter inline styles: keep layout properties, strip visual ones
		filterInlineStyles(body);

		// Strip active/dangerous content (event handlers, scripts, framing/active
		// elements, javascript: URLs, remote resources) before these nodes go live
		// via importNode below. The parsed doc is inert until then, so this is the
		// race-free moment to sanitise untrusted epub HTML.
		sanitizeEpubBody(body);

		// De-linkify anchors that wrap block content (epub conversion artifacts)
		const blockSel = "p, div, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, section, figure";
		body.querySelectorAll("a[href]").forEach(a => {
			if (a.querySelector(blockSel)) a.removeAttribute("href");
		});

		// Import body children into the wrapper
		Array.from(body.childNodes).forEach(node =>
			wrapper.appendChild(document.importNode(node, true))
		);

		// Tag bibliography paragraphs with id="tmr-cite-N" before prefixing,
		// so citation links resolve to them.
		tagCitationTargets(wrapper, book.citations);

		// Namespace ids to avoid collisions between spine items
		const prefix = `s${i}-`;
		wrapper.querySelectorAll("[id]").forEach(el => {
			el.id = prefix + el.id;
		});
		// Fix same-document fragment links to use namespaced ids
		wrapper.querySelectorAll("a[href^='#']").forEach(a => {
			const href = a.getAttribute("href")!;
			a.setAttribute("href", "#" + prefix + href.slice(1));
		});
		// Fix data-rid references (used for tooltip wiring)
		wrapper.querySelectorAll("[data-rid]").forEach(el => {
			(el as HTMLElement).dataset.rid = prefix + (el as HTMLElement).dataset.rid!;
		});

		// Fix image src to use pre-loaded blob URLs
		const xhtmlDir = item.href.includes("/")
			? item.href.substring(0, item.href.lastIndexOf("/") + 1)
			: "";
		rewriteImageRefs(wrapper, xhtmlDir, book);

		// Wrap consecutive callout-tagged elements into unified .tmr-callout-group cards
		wrapCalloutGroups(wrapper);

		// Wrap [N] citation markers in body text with hoverable .tmr-citation spans
		wrapCitations(wrapper, book.citations);

		// Yield to the browser so Obsidian stays responsive
		await new Promise<void>(r => requestAnimationFrame(() => r()));
	}
}

/** Rewrite every image reference inside `root` to the pre-loaded blob URL.
 *
 *  Handles three quirks that broke on non-flat epubs:
 *    - `..` / `.` segments in `src` (e.g. `../images/fig1.jpg` from a nested
 *      xhtml/ folder) — normalised via `resolveRelativePath`.
 *    - Percent-encoded filenames (spaces, unicode) — manifest stores raw hrefs,
 *      so we decode the src before lookup.
 *    - SVG `<image>` elements (common on cover pages and scholarly figures),
 *      which use `href` or the legacy `xlink:href` and are invisible to an
 *      `img` selector. */
function rewriteImageRefs(root: ParentNode, xhtmlDir: string, book: EpubBook): void {
	const tryLookup = (src: string | null): string | null => {
		if (!src || src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("http")) return null;
		const decoded = safeDecodeURI(src);
		const joined = resolveRelativePath(xhtmlDir + decoded);
		return book.imageMap[joined]
			?? book.imageMap[decoded]
			?? book.imageMap[xhtmlDir + decoded]
			?? book.imageMap[src]
			?? null;
	};

	root.querySelectorAll("img").forEach((img) => {
		const blobUrl = tryLookup(img.getAttribute("src"));
		if (blobUrl) img.setAttribute("src", blobUrl);
	});

	// SVG <image> — check `href` first, then the legacy `xlink:href` attribute.
	root.querySelectorAll("image").forEach((el) => {
		const href = el.getAttribute("href") ?? el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
		const blobUrl = tryLookup(href);
		if (!blobUrl) return;
		el.setAttribute("href", blobUrl);
		// Also clear the xlink fallback so it doesn't race with a stale path.
		if (el.hasAttributeNS("http://www.w3.org/1999/xlink", "href")) {
			el.setAttributeNS("http://www.w3.org/1999/xlink", "href", blobUrl);
		}
	});
}

async function getPreviewDocument(book: EpubBook, path: string): Promise<Document | null> {
	let cache = previewDocCache.get(book);
	if (!cache) {
		cache = new Map<string, Promise<Document | null>>();
		previewDocCache.set(book, cache);
	}

	let pending = cache.get(path);
	if (!pending) {
		pending = (async () => {
			try {
				const raw = await readBookTextFile(book, path);
				const parser = new DOMParser();
				return parser.parseFromString(raw, "text/html");
			} catch {
				return null;
			}
		})();
		cache.set(path, pending);
	}

	return pending;
}

async function readBookTextFile(book: EpubBook, path: string): Promise<string> {
	const filePath = book.opfDir + path;
	if (book.zip) {
		const file = book.zip.file(filePath);
		if (!file) throw new Error(`Missing epub asset: ${filePath}`);
		return file.async("string");
	}
	if (book.dirPath) {
		return nodeFs.readFile(nodePath.join(book.dirPath, filePath), "utf8");
	}
	throw new Error("EpubBook has neither zip nor dirPath");
}

function buildImagePreview(target: Element, path: string, book: EpubBook): EpubLinkPreview | null {
	const block = findClosest(target, "figure, aside, div, p, section, article") ?? target;
	const img = block.matches("img") ? block as HTMLImageElement : block.querySelector("img");
	if (!img) return null;

	const xhtmlDir = path.includes("/")
		? path.substring(0, path.lastIndexOf("/") + 1)
		: "";
	const blobUrl = lookupImageBlobUrl(book, xhtmlDir, img.getAttribute("src"));
	if (!blobUrl) return null;

	const caption = normalizePreviewText(
		block.querySelector("figcaption, .caption, p")?.textContent ?? ""
	);
	const previewCaption = caption ? truncatePreviewText(caption) : undefined;
	return {
		kind: "image",
		imageSrc: blobUrl,
		caption: previewCaption,
	};
}

function buildTextPreview(target: Element, path: string): EpubLinkPreview | null {
	const pathLooksNoteLike = NOTEISH_PATH_RE.test(path);
	const blocks = collectCandidateBlocks(target);
	for (const block of blocks) {
		if (!isTextPreviewCandidate(block, pathLooksNoteLike)) continue;
		const text = normalizePreviewText(block.textContent ?? "");
		if (!text) continue;
		return { kind: "text", text: truncatePreviewText(text) };
	}
	return null;
}

function collectCandidateBlocks(target: Element): Element[] {
	const result: Element[] = [];
	const seen = new Set<Element>();
	let node: Element | null = target;
	while (node && node.tagName.toLowerCase() !== "body") {
		if (
			node.matches("p, li, dd, dt, blockquote, aside, div, section, article, figure") &&
			!seen.has(node)
		) {
			result.push(node);
			seen.add(node);
		}
		node = node.parentElement;
	}
	return result;
}

function isTextPreviewCandidate(block: Element, pathLooksNoteLike: boolean): boolean {
	if (block.matches("h1, h2, h3, h4, h5, h6, nav")) return false;
	if (block.closest("nav")) return false;

	const text = normalizePreviewText(block.textContent ?? "");
	if (text.length < 12 || text.length > 2200) return false;

	const semanticChain = block.closest('[epub\\:type="footnote"], [epub\\:type="endnote"], [epub\\:type="glossary"], [epub\\:type="glossdef"], [type="footnote"], [type="endnote"], [type="glossary"], [type="glossdef"]');
	if (semanticChain) return true;
	if (hasNoteishAttrs(block)) return true;
	if (block.matches("dd, dt")) return true;
	if (looksLikeBacklinkedNote(block)) return true;
	if (pathLooksNoteLike && !block.matches("section, article")) return true;
	return false;
}

function looksLikeBacklinkedNote(block: Element): boolean {
	const text = normalizePreviewText(block.textContent ?? "");
	if (!NOTEISH_MARKER_RE.test(text)) return false;

	const firstLink = block.querySelector("a[href]");
	if (!firstLink) return false;
	const linkText = normalizePreviewText(firstLink.textContent ?? "");
	return linkText.length > 0 && linkText.length <= 8;
}

function hasNoteishAttrs(el: Element): boolean {
	const bits = [
		el.id,
		el.getAttribute("class") ?? "",
		el.getAttribute("epub:type") ?? "",
		el.getAttribute("type") ?? "",
	];
	return NOTEISH_ATTR_RE.test(bits.join(" "));
}

function lookupImageBlobUrl(book: EpubBook, xhtmlDir: string, src: string | null): string | null {
	if (!src || src.startsWith("blob:") || src.startsWith("data:") || src.startsWith("http")) return null;
	const decoded = safeDecodeURI(src);
	const joined = resolveRelativePath(xhtmlDir + decoded);
	return book.imageMap[joined]
		?? book.imageMap[decoded]
		?? book.imageMap[xhtmlDir + decoded]
		?? book.imageMap[src]
		?? null;
}

function normalizePreviewText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncatePreviewText(text: string): string {
	if (text.length <= PREVIEW_MAX_CHARS) return text;
	return text.slice(0, PREVIEW_MAX_CHARS).trimEnd() + "…";
}

function findClosest<T extends Element>(el: Element | null, selector: string): T | null {
	return (el?.closest(selector) as T | null) ?? null;
}

function safeDecodeURI(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

// ─── CSS extraction and layout style application ─────────────────────────────

function collectCssTexts(doc: Document, item: EpubManifestItem, book: EpubBook): string[] {
	const cssTexts: string[] = [];

	// Inline <style> from <head>
	doc.querySelectorAll("head style").forEach(el => {
		if (el.textContent) cssTexts.push(el.textContent);
	});

	// Linked stylesheets — resolve href relative to the XHTML file's directory
	const xhtmlDir = item.href.includes("/")
		? item.href.substring(0, item.href.lastIndexOf("/") + 1)
		: "";
	doc.querySelectorAll('head link[rel="stylesheet"]').forEach(link => {
		const href = link.getAttribute("href");
		if (!href) return;
		const resolved = resolveRelativePath(xhtmlDir + href);
		const cssText = book.cssCache[resolved];
		if (cssText) cssTexts.push(cssText);
	});

	// Some epubs put <style> in <body> (non-standard but happens)
	doc.querySelectorAll("body style").forEach(el => {
		if (el.textContent) cssTexts.push(el.textContent);
	});

	return cssTexts;
}

/** Layout properties to preserve from epub CSS — everything else gets stripped.
 *  height/max-height are intentionally excluded: epub pages often use these
 *  for fixed-page vertical centering (e.g. height: 100vh), which inflates
 *  column measurements and prevents short sections from pairing correctly. */
const LAYOUT_PROPS = [
	'text-align', 'text-indent', 'vertical-align',
	'display', 'float', 'clear',
	'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
	'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
	'width', 'max-width',
	'list-style-type',
];

/** Block-level tags eligible to be flagged as epub callout blocks.
 *  LI/DD/DT are excluded: they live inside list/dl parents where we cannot
 *  insert a wrapping div without producing invalid HTML. */
const CALLOUT_ELIGIBLE_TAGS = new Set([
	'P', 'DIV', 'SECTION', 'ASIDE', 'BLOCKQUOTE', 'ARTICLE', 'FIGURE',
]);

/** Return true if this CSS rule carries visual properties that indicate the
 *  epub author intended a callout/sidebar block: a non-trivial border-left or
 *  a non-transparent background colour.  We use these as a semantic signal
 *  rather than reproducing the original colours, which are stripped. */
function hasCalloutIndicators(style: CSSStyleDeclaration): boolean {
	// border-left — check shorthand and width longhand (Chromium exposes both)
	const bl = style.getPropertyValue('border-left');
	const blw = style.getPropertyValue('border-left-width');
	if ((bl && bl !== 'none' && bl !== '0' && bl !== '0px') ||
		(blw && blw !== '0' && blw !== '0px' && blw !== 'none')) {
		return true;
	}
	// background-color — skip transparent / white / fully-clear values
	const bg = style.getPropertyValue('background-color');
	if (bg &&
		bg !== 'transparent' &&
		bg !== 'rgba(0, 0, 0, 0)' &&
		bg !== 'rgb(255, 255, 255)' &&
		bg !== 'initial' &&
		bg !== 'inherit') {
		return true;
	}
	return false;
}

/**
 * Parse epub CSS via constructable stylesheets (CSSOM) and apply layout
 * properties as inline styles on matching elements.  This preserves
 * text-align, margins, etc. even after we strip the epub stylesheets.
 *
 * Additionally, rules that carry callout indicators (border-left, background)
 * cause matching block elements to receive a `data-epub-callout` attribute so
 * our CSS can render them with 3C-appropriate callout styling.
 */
function applyLayoutStyles(body: Element, cssTexts: string[]): void {
	if (cssTexts.length === 0) return;

	const allCss = cssTexts.join("\n");

	let sheet: CSSStyleSheet;
	try {
		sheet = new CSSStyleSheet();
		// @import is not supported in constructable stylesheets — strip it
		sheet.replaceSync(allCss.replace(/@import\s+[^;]+;/g, ''));
	} catch {
		return; // CSS parse error — skip gracefully
	}

	for (const rule of Array.from(sheet.cssRules)) {
		if (!(rule instanceof CSSStyleRule)) continue;

		const propsToApply: [string, string][] = [];
		for (const prop of LAYOUT_PROPS) {
			const value = rule.style.getPropertyValue(prop);
			if (!value) continue;
			// Skip viewport-relative values (vh, vw, vmin, vmax) — these are
			// designed for fixed-page epub layouts and break our reflow model
			// by making elements fill the viewport, inflating column counts.
			if (/\d+(vh|vw|vmin|vmax)/.test(value)) continue;
			propsToApply.push([prop, value]);
		}

		const callout = hasCalloutIndicators(rule.style);
		if (propsToApply.length === 0 && !callout) continue;

		try {
			body.querySelectorAll(rule.selectorText).forEach(el => {
				for (const [prop, value] of propsToApply) {
					// Don't override existing inline styles (higher CSS precedence)
					if (!(el as HTMLElement).style.getPropertyValue(prop)) {
						(el as HTMLElement).style.setProperty(prop, value);
					}
				}
				if (callout && CALLOUT_ELIGIBLE_TAGS.has(el.tagName)) {
					el.setAttribute('data-epub-callout', '');
				}
			});
		} catch {
			// Invalid selector for querySelectorAll (pseudo-elements, etc.) — skip
		}
	}
}

/** Visual properties to strip from inline styles */
const VISUAL_PROPS = new Set([
	'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
	'color', 'background', 'background-color', 'background-image',
	'line-height', 'letter-spacing', 'word-spacing',
	'border', 'border-color', 'border-style', 'border-width',
	'border-top', 'border-bottom', 'border-left', 'border-right',
	'box-shadow', 'text-shadow', 'text-decoration', 'text-decoration-color',
]);

/** True if el is a visual separator (arrow, rule, bullet) rather than content.
 *  Used to distinguish ↓ / → / — dividers from substantive callout items. */
function isSeparatorEl(el: Element): boolean {
	const text = (el.textContent ?? '').trim();
	return text.length <= 3 && /^[←-⇿─-➿*·•\-–—]+$/.test(text);
}

/** Wrap runs of consecutive [data-epub-callout] siblings in a single
 *  .tmr-callout-group container so they render as one unified card.
 *
 *  Inside each group:
 *   - Inline padding is stripped from items so the CSS can own the spacing
 *     (the epub's padding: 1em is too cramped for a centered card layout).
 *   - Separator elements (↓ etc.) get .tmr-callout-sep — kept visible as a
 *     subtle progression cue overlaid on the divider hairline.
 *   - Two consecutive non-separator items (e.g. a quote + its attribution)
 *     mean the second is a logical continuation of the first; mark it with
 *     .tmr-callout-continuation so CSS can drop the divider between them. */
function wrapCalloutGroups(root: HTMLElement): void {
	// Parents inside list/table contexts can't host a wrapping div
	const UNWRAPPABLE = new Set(['UL', 'OL', 'DL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);
	// Strip these from items inside groups so the card's CSS owns layout.
	// text-align/text-indent get stripped because applyLayoutStyles takes the
	// first-matching rule for a property (not the most-specific), so a generic
	// `p { text-align: justify }` ends up overriding our card's center alignment.
	const PROPS_TO_STRIP = [
		'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
		'text-align', 'text-indent',
	];

	const parents = new Set<Element>();
	root.querySelectorAll('[data-epub-callout]').forEach(el => {
		if (el.parentElement && !UNWRAPPABLE.has(el.parentElement.tagName)) {
			parents.add(el.parentElement);
		}
	});

	parents.forEach(parent => {
		let run: Element[] = [];
		const flush = () => {
			if (run.length === 0) return;
			const group = document.createElement('div');
			group.className = 'tmr-callout-group';
			parent.insertBefore(group, run[0]);
			let prevWasContent = false;
			for (const el of run) {
				const html = el as HTMLElement;
				// Strip inline layout properties so the card's CSS owns them
				for (const p of PROPS_TO_STRIP) html.style.removeProperty(p);
				if (!html.getAttribute('style')?.trim()) html.removeAttribute('style');

				if (isSeparatorEl(el)) {
					el.classList.add('tmr-callout-sep');
					prevWasContent = false;
				} else {
					if (prevWasContent) el.classList.add('tmr-callout-continuation');
					prevWasContent = true;
				}
				group.appendChild(el);
			}
			run = [];
		};
		for (const child of Array.from(parent.children)) {
			if ((child as HTMLElement).hasAttribute('data-epub-callout')) {
				run.push(child);
			} else {
				flush();
			}
		}
		flush();
	});
}

/** Walk text nodes under `root` and wrap "[N]" patterns with a citation link.
 *  These are real <a> elements pointing at the bibliography entry, so they
 *  inherit the reader's standard link colour and click-to-navigate behaviour;
 *  data-cite-text carries the full text for an instant hover tooltip.
 *  Skips elements that already are citations or live in a bibliography list. */
function wrapCitations(root: HTMLElement, citations: Record<number, EpubCitation> | undefined): void {
	if (!citations || Object.keys(citations).length === 0) return;
	const SKIP_PARENTS = new Set(['SCRIPT', 'STYLE', 'A', 'CODE', 'PRE', 'BUTTON']);

	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = (node as Text).parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			if (SKIP_PARENTS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
			if (parent.closest('.tmr-citation, .scribe_bibliography')) return NodeFilter.FILTER_REJECT;
			if (!/\[\d+\]/.test(node.nodeValue ?? '')) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	const targets: Text[] = [];
	let n: Node | null;
	while ((n = walker.nextNode())) targets.push(n as Text);

	const re = /\[(\d+)\]/g;
	for (const node of targets) {
		const text = node.nodeValue ?? '';
		re.lastIndex = 0;
		const pieces: Node[] = [];
		let cursor = 0;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const num = parseInt(m[1], 10);
			const cite = citations[num];
			if (cite === undefined) continue;
			if (m.index > cursor) pieces.push(document.createTextNode(text.slice(cursor, m.index)));
			const link = document.createElement('a');
			link.className = 'tmr-citation';
			link.setAttribute('href', cite.href);
			link.dataset.cite = String(num);
			link.dataset.citeText = cite.text;
			link.textContent = `[${num}]`;
			pieces.push(link);
			cursor = m.index + m[0].length;
		}
		if (pieces.length === 0) continue;
		if (cursor < text.length) pieces.push(document.createTextNode(text.slice(cursor)));
		const parent = node.parentNode!;
		for (const piece of pieces) parent.insertBefore(piece, node);
		parent.removeChild(node);
	}
}

/** Strip visual inline styles but keep layout ones (text-align, margin, etc.) */
function filterInlineStyles(body: Element): void {
	body.querySelectorAll("[style]").forEach(el => {
		const htmlEl = el as HTMLElement;
		for (const prop of VISUAL_PROPS) {
			htmlEl.style.removeProperty(prop);
		}
		if (!htmlEl.getAttribute("style")?.trim()) {
			htmlEl.removeAttribute("style");
		}
	});
}

/** Block remote (off-device) resource URLs. Legitimate epub assets are in-zip
 *  relative paths (rewritten to blob: URLs after import), so any absolute or
 *  protocol-relative URL on a resource-loading attribute is external — a
 *  tracking-pixel / phone-home vector that would fire when the book is opened. */
const REMOTE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;
/** Attributes that auto-fetch a resource on render (not via a user click). */
const RESOURCE_ATTRS = ["src", "poster", "background"];
const XLINK_NS = "http://www.w3.org/1999/xlink";

let purifyHookInstalled = false;
function ensurePurifyHook(): void {
	if (purifyHookInstalled) return;
	purifyHookInstalled = true;
	// DOMPurify treats http(s) URLs as "safe", so it keeps remote <img src> etc.
	// Strip those here. Anchor hrefs are left alone — they navigate on click,
	// they don't auto-load, so they're not a silent phone-home vector.
	DOMPurify.addHook("afterSanitizeAttributes", (node) => {
		const el = node;
		for (const attr of RESOURCE_ATTRS) {
			const v = el.getAttribute(attr);
			if (v && REMOTE_URL.test(v)) el.removeAttribute(attr);
		}
		// SVG <image>/<use> auto-load via xlink:href; an <a>'s xlink:href is a link.
		if (el.tagName.toLowerCase() !== "a") {
			const xv = el.getAttributeNS(XLINK_NS, "href");
			if (xv && REMOTE_URL.test(xv)) {
				el.removeAttributeNS(XLINK_NS, "href");
				el.removeAttribute("href");
			}
		}
	});
}

/** Remove active/dangerous content from parsed (still-inert) epub HTML before it
 *  is imported into the live DOM. DOMPurify strips <script>, inline event
 *  handlers, framing/active elements and javascript: code URLs; FORBID covers
 *  form controls and responsive srcset; the hook blocks remote resources. Runs
 *  IN_PLACE so the element references the surrounding pipeline has already built
 *  up (layout styles, citation ids) survive untouched. */
function sanitizeEpubBody(body: Element): void {
	ensurePurifyHook();
	DOMPurify.sanitize(body, {
		IN_PLACE: true,
		FORBID_TAGS: ["form", "input", "button", "select", "textarea", "iframe", "object", "embed", "base", "meta"],
		FORBID_ATTR: ["srcset"],
	});
}

// ─── Internal parsers ─────────────────────────────────────────────────────────

function parseContainerXml(xml: string): string {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	const rootfile = doc.querySelector("rootfile");
	if (!rootfile) throw new Error("container.xml: no rootfile element found");
	return rootfile.getAttribute("full-path") ?? "";
}

function parseOpf(xml: string, _opfDir: string): {
	title: string;
	author: string;
	spine: EpubManifestItem[];
	manifest: Record<string, EpubManifestItem>;
} {
	const doc = new DOMParser().parseFromString(xml, "application/xml");

	const title = doc.querySelector("metadata > title, metadata *|title")?.textContent?.trim() ?? "Untitled";
	// First dc:creator only; multi-author handling deferred.
	const author = doc.querySelector("metadata > creator, metadata *|creator")?.textContent?.trim() ?? "";

	const manifest: Record<string, EpubManifestItem> = {};
	doc.querySelectorAll("manifest > item").forEach((el) => {
		const id = el.getAttribute("id") ?? "";
		manifest[id] = {
			id,
			href: el.getAttribute("href") ?? "",
			mediaType: el.getAttribute("media-type") ?? "",
			properties: el.getAttribute("properties") ?? undefined,
		};
	});

	const spine: EpubManifestItem[] = [];
	doc.querySelectorAll("spine > itemref").forEach((el) => {
		const idref = el.getAttribute("idref") ?? "";
		if (manifest[idref]) spine.push(manifest[idref]);
	});

	return { title, author, spine, manifest };
}

function parseNav(xml: string): EpubTocItem[] {
	const doc = new DOMParser().parseFromString(xml, "application/xhtml+xml");
	const tocNav = doc.querySelector('nav[epub\\:type="toc"], nav[*|type="toc"]');
	if (!tocNav) return [];
	const ol = tocNav.querySelector("ol");
	if (!ol) return [];
	return parseTocOl(ol);
}

function parseNcx(xml: string): EpubTocItem[] {
	const doc = new DOMParser().parseFromString(xml, "application/xml");
	const navMap = doc.querySelector("navMap");
	if (!navMap) return [];
	return parseNcxPoints(navMap);
}

function parseNcxPoints(parent: Element): EpubTocItem[] {
	const items: EpubTocItem[] = [];
	parent.querySelectorAll(":scope > navPoint").forEach((point) => {
		const label = point.querySelector("navLabel > text")?.textContent?.trim() ?? "";
		const href = point.querySelector("content")?.getAttribute("src") ?? "";
		items.push({ label, href, children: parseNcxPoints(point) });
	});
	return items;
}

function parseTocOl(ol: Element): EpubTocItem[] {
	const items: EpubTocItem[] = [];
	ol.querySelectorAll(":scope > li").forEach((li) => {
		const a = li.querySelector("a");
		if (!a) return;
		const childOl = li.querySelector(":scope > ol");
		items.push({
			label: a.textContent?.trim() ?? "",
			href: a.getAttribute("href") ?? "",
			children: childOl ? parseTocOl(childOl) : [],
		});
	});
	return items;
}

// ─── ToC href resolution ──────────────────────────────────────────────────────

export function resolveRelativePath(path: string): string {
	const parts = path.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "..") resolved.pop();
		else if (part !== "." && part !== "") resolved.push(part);
	}
	return resolved.join("/");
}

function resolveTocHrefs(items: EpubTocItem[], baseDir: string): EpubTocItem[] {
	return items.map(item => {
		const [path, fragment] = item.href.split("#", 2);
		const resolvedPath = path ? resolveRelativePath(baseDir + path) : "";
		const resolvedHref = fragment ? `${resolvedPath}#${fragment}` : resolvedPath;
		return {
			...item,
			href: resolvedHref,
			children: resolveTocHrefs(item.children, baseDir),
		};
	});
}

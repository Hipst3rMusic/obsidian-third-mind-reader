import { type Vault, TFile, TFolder, normalizePath } from "obsidian";
import { readEpubMeta } from "./epub";

/** Minimal shape the scan needs from `settings.bookPositions[path]`: the cached
 *  reading fraction and timestamp the reader writes on each position-save. */
export interface BookProgress {
	pct?: number;
	lastRead?: number;
}

/** A per-book display override. The epub file is never modified; these values
 *  only change how the Library renders. A field is absent when not overridden. */
export interface LibraryOverride {
	title?: string;
	author?: string;
}

/** What the reader opens a book *with*: the plugin's own reader for epubs,
 *  Obsidian's native viewer (augmented by PDF Gloss) for PDFs. */
export type BookKind = "epub" | "pdf";

/** A single book as surfaced in the Library grid. */
export interface LibraryBook {
	/** Vault-relative path to the single-file .epub or .pdf. */
	path: string;
	/** Which viewer this book opens in, and which format label the card shows. */
	kind: BookKind;
	/** Display title: the override if present, else OPF <dc:title> (or filename). */
	title: string;
	/** Display author: the override if present, else OPF <dc:creator> (may be ""). */
	author: string;
	/** Un-overridden OPF title — pre-fills the edit modal and powers "reset to original". */
	rawTitle: string;
	/** Un-overridden OPF author. */
	rawAuthor: string;
	/** Immediate subfolder under `Library/`, or "" for a root-level book. */
	collection: string;
	/** 0..1 reading fraction, from `settings.bookPositions[path].pct` (0 if unread). */
	progress: number;
	/** Epoch ms of last reading activity; 0 for never-opened books. Sort key for
	 *  the shelf — see `sortForShelf` in library-view.ts. */
	lastRead: number;
	/** Annotation count — `> [!mode]-` callout headers in the companion doc. */
	marks: number;
	/** Whether a companion doc exists for this book (independent of mark count). */
	hasCompanion: boolean;
}

export const DEFAULT_LIBRARY_ROOT = "Library";

let configuredRoot = DEFAULT_LIBRARY_ROOT;
let configuredAnnotations = `${DEFAULT_LIBRARY_ROOT}/Annotations`;

/** A blank value falls back to the default rather than the vault root, which
 *  would sweep every epub in the vault into the Library. */
export function configureLibraryPaths(root: string, annotations: string): void {
	configuredRoot = normalizePath(root.trim() || DEFAULT_LIBRARY_ROOT);
	configuredAnnotations = normalizePath(annotations.trim() || `${configuredRoot}/Annotations`);
}

export function libraryRootPath(): string {
	return configuredRoot;
}

export function annotationsFolderPath(): string {
	return configuredAnnotations;
}

interface MetaCacheEntry {
	mtime: number;
	title: string;
	author: string;
}

/** Module-level cache keyed by path, validated against file mtime, so re-opening
 *  the Library within a session doesn't re-unzip every OPF. Vault rename/modify
 *  handlers call `invalidateMetaCache` to keep it honest. */
const metaCache = new Map<string, MetaCacheEntry>();

export function invalidateMetaCache(path?: string): void {
	if (path) metaCache.delete(path);
	else metaCache.clear();
}

/** Make a book title safe for use as a vault file name: illegal filename
 *  characters → `_`, whitespace collapsed, "Book" fallback for empty results.
 *  Single source of truth — the reader, the Library scan, and the importer all
 *  sanitise through here. */
export function sanitizeFileName(raw: string): string {
	return raw.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "Book";
}

/** Resolve a book's companion-doc path from its **raw OPF title**. The reader
 *  keys the doc by `book.title` (the parsed OPF title, not the Library display
 *  override), so marks must resolve against `rawTitle`. Shared by the reader's
 *  `getCompanionDocPath` and the Library scan, so the write and read paths can
 *  never drift apart. */
export function companionDocPath(rawTitle: string): string {
	return normalizePath(`${annotationsFolderPath()}/${sanitizeFileName(rawTitle)}-Annotations.md`);
}

/** Each Gloss entry begins with a `> [!mode]-` header line (see `buildCallout`),
 *  so counting those headers gives the mark count without parsing anchors. */
const CALLOUT_HEADER_RE = /^>\s*\[!(?:exclaim|explain|examine|emphasise|enquiry)\]/gim;

/** Marks cache keyed by companion-doc path, validated against the doc's mtime so
 *  re-scans (and the live `modify` refresh) only re-read a doc that changed. */
const marksCache = new Map<string, { mtime: number; marks: number }>();

/** Count annotation callouts in a book's companion doc. Returns 0 marks and
 *  `hasCompanion: false` when no doc exists. */
async function readMarks(vault: Vault, rawTitle: string): Promise<{ marks: number; hasCompanion: boolean }> {
	const path = companionDocPath(rawTitle);
	const file = vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return { marks: 0, hasCompanion: false };

	const cached = marksCache.get(path);
	if (cached && cached.mtime === file.stat.mtime) return { marks: cached.marks, hasCompanion: true };

	try {
		const text = await vault.cachedRead(file);
		const marks = text.match(CALLOUT_HEADER_RE)?.length ?? 0;
		marksCache.set(path, { mtime: file.stat.mtime, marks });
		return { marks, hasCompanion: true };
	} catch {
		// Doc exists but couldn't be read — treat as a companion with 0 marks.
		return { marks: 0, hasCompanion: true };
	}
}

/**
 * Enumerate single-file `.epub` and `.pdf` books under `Library/`, excluding the
 * annotations folder. Exploded `.epub` directories are deliberately not returned
 * — they surface as an import nudge instead.
 *
 * `overrides` (keyed by path) replace the displayed title/author without
 * touching the epub; the raw OPF values are retained for the editor.
 * `positions` (= `settings.bookPositions`) supplies the cached reading fraction;
 * `marks`/`hasCompanion` resolve from the companion doc, keyed by raw OPF title.
 */
export async function scanLibrary(
	vault: Vault,
	overrides: Record<string, LibraryOverride> = {},
	positions: Record<string, BookProgress> = {}
): Promise<LibraryBook[]> {
	const prefix = libraryRootPath() + "/";
	const annotationsPrefix = annotationsFolderPath() + "/";
	const files = vault.getFiles().filter(
		(f) =>
			(f.extension === "epub" || f.extension === "pdf") &&
			f.path.startsWith(prefix) &&
			!f.path.startsWith(annotationsPrefix)
	);

	const books: LibraryBook[] = [];
	for (const file of files) {
		const kind: BookKind = file.extension === "pdf" ? "pdf" : "epub";
		let title: string;
		let author: string;

		const cached = metaCache.get(file.path);
		if (kind === "pdf") {
			// No OPF to read: the filename is the title, and the author stays empty
			// until someone sets one in Edit details. The filename is also what PDF
			// Gloss keys its companion doc by (`companionDocPath(file.basename)`),
			// so marks resolve here without inventing a second convention.
			title = file.basename;
			author = "";
		} else if (cached && cached.mtime === file.stat.mtime) {
			title = cached.title;
			author = cached.author;
		} else {
			try {
				const data = await vault.readBinary(file);
				const meta = await readEpubMeta(data);
				title = meta.title;
				author = meta.author;
				metaCache.set(file.path, { mtime: file.stat.mtime, title, author });
			} catch {
				// Malformed / unreadable epub — fall back to the filename so one bad
				// book never breaks the whole scan.
				title = file.basename;
				author = "";
			}
		}

		const ov = overrides[file.path];
		const { marks, hasCompanion } = await readMarks(vault, title);
		const pct = positions[file.path]?.pct;
		const lastRead = positions[file.path]?.lastRead;
		books.push({
			path: file.path,
			kind,
			title: ov?.title ?? title,
			author: ov?.author ?? author,
			rawTitle: title,
			rawAuthor: author,
			collection: collectionOf(file.path),
			progress: typeof pct === "number" ? Math.max(0, Math.min(1, pct)) : 0,
			lastRead: typeof lastRead === "number" ? lastRead : 0,
			marks,
			hasCompanion,
		});
	}

	// Alphabetical baseline only — display order is the view's call
	// (`sortForShelf`). This is the recency sort's stable tie-break.
	books.sort((a, b) => a.title.localeCompare(b.title));
	return books;
}

/** `Library/Eastern/foo.epub` → "Eastern"; `Library/foo.epub` → "" (root). */
function collectionOf(path: string): string {
	const rest = path.slice(libraryRootPath().length + 1);
	const slash = rest.indexOf("/");
	return slash === -1 ? "" : rest.slice(0, slash);
}

/**
 * The collection tabs to show — a pure mirror of the live `Library/` folder tree:
 * every immediate subfolder including empty ones, `Annotations/` excluded, with
 * nothing persisted deciding a tab's existence. "Everything" is prepended by the
 * view and is not part of this list.
 *
 * `order` is only an ordering hint (from drag-to-reorder): folders named in it
 * come first, the rest alphabetically. Names of dead folders are ignored.
 */
export function computeCollections(vault: Vault, order: string[]): string[] {
	const root = vault.getAbstractFileByPath(libraryRootPath());
	const folders = root instanceof TFolder
		? root.children
			.filter((c): c is TFolder => c instanceof TFolder && c.path !== annotationsFolderPath())
			.map((c) => c.name)
		: [];

	const live = new Set(folders);
	const ordered: string[] = [];
	for (const c of order) if (live.has(c) && !ordered.includes(c)) ordered.push(c);
	const rest = folders
		.filter((c) => !ordered.includes(c))
		.sort((a, b) => a.localeCompare(b));
	return [...ordered, ...rest];
}

/**
 * Find exploded `.epub` directories under `Library/` — unzipped book folders the
 * reader can't open in place (the Apple Books shape), detected by probing for
 * `META-INF/container.xml` or `mimetype`. Recurses into collection folders but
 * never into a detected epub's internals; `Annotations/` is skipped.
 */
export async function detectExplodedEpubs(vault: Vault): Promise<string[]> {
	const adapter = vault.adapter;
	const found: string[] = [];

	const walk = async (dir: string): Promise<void> => {
		let folders: string[];
		try {
			folders = (await adapter.list(dir)).folders;
		} catch {
			return;
		}
		for (const folder of folders) {
			if (folder === annotationsFolderPath() || folder.startsWith(annotationsFolderPath() + "/")) continue;
			const isExploded =
				(await adapter.exists(`${folder}/META-INF/container.xml`)) ||
				(await adapter.exists(`${folder}/mimetype`));
			if (isExploded) found.push(folder);
			else await walk(folder);
		}
	};

	await walk(libraryRootPath());
	return found;
}

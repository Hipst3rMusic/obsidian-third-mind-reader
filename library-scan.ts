import { type Vault, TFile, TFolder } from "obsidian";
import { readEpubMeta } from "./epub";

/** Minimal shape the scan needs from `settings.bookPositions[path]`: the cached
 *  reading fraction the reader writes on each position-save. */
export interface BookProgress {
	pct?: number;
}

/** A per-book display override. The epub file is never modified; these values
 *  only change how the Library renders. A field is absent when not overridden. */
export interface LibraryOverride {
	title?: string;
	author?: string;
}

/** A single book as surfaced in the Library grid. */
export interface LibraryBook {
	/** Vault-relative path to the single-file .epub. */
	path: string;
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
	/** Annotation count — `> [!mode]-` callout headers in the companion doc. */
	marks: number;
	/** Whether a companion doc exists for this book (independent of mark count). */
	hasCompanion: boolean;
}

export const LIBRARY_ROOT = "Library";
const ANNOTATIONS_PREFIX = "Library/Annotations/";

interface MetaCacheEntry {
	mtime: number;
	title: string;
	author: string;
}

/** Module-level cache keyed by path, validated against file mtime, so re-opening
 *  the Library within a session doesn't re-unzip every OPF. Phase D's vault
 *  rename/modify handlers call `invalidateMetaCache` to keep it honest. */
const metaCache = new Map<string, MetaCacheEntry>();

export function invalidateMetaCache(path?: string): void {
	if (path) metaCache.delete(path);
	else metaCache.clear();
}

/** Resolve a book's companion-doc path from its **raw OPF title**. The reader
 *  keys the doc by `book.title` (the parsed OPF title, not the Library display
 *  override), so marks must resolve against `rawTitle`, sanitised identically to
 *  the reader's `getCompanionDocPath`. */
function companionDocPath(rawTitle: string): string {
	const safe = rawTitle.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "Book";
	return `${ANNOTATIONS_PREFIX}${safe}-Annotations.md`;
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
 * Enumerate single-file `.epub` books under `Library/` and resolve their
 * title/author via the cheap `readEpubMeta` path. Excludes the annotations
 * folder. Exploded `.epub` directories are intentionally not returned here —
 * they're surfaced as an import nudge in Phase C.
 *
 * `overrides` (keyed by path) replace the displayed title/author without
 * touching the epub; the raw OPF values are retained on the book for the editor.
 *
 * `positions` (keyed by path, = `settings.bookPositions`) supplies the cached
 * reading fraction; `marks`/`hasCompanion` are resolved from each book's
 * companion doc (keyed by raw OPF title).
 */
export async function scanLibrary(
	vault: Vault,
	overrides: Record<string, LibraryOverride> = {},
	positions: Record<string, BookProgress> = {}
): Promise<LibraryBook[]> {
	const prefix = LIBRARY_ROOT + "/";
	const files = vault.getFiles().filter(
		(f) =>
			f.extension === "epub" &&
			f.path.startsWith(prefix) &&
			!f.path.startsWith(ANNOTATIONS_PREFIX)
	);

	const books: LibraryBook[] = [];
	for (const file of files) {
		let title: string;
		let author: string;

		const cached = metaCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) {
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
				// book never breaks the whole scan. Dedicated broken-card treatment
				// is R5 (owned by Rohan).
				title = file.basename;
				author = "";
			}
		}

		const ov = overrides[file.path];
		const { marks, hasCompanion } = await readMarks(vault, title);
		const pct = positions[file.path]?.pct;
		books.push({
			path: file.path,
			title: ov?.title ?? title,
			author: ov?.author ?? author,
			rawTitle: title,
			rawAuthor: author,
			collection: collectionOf(file.path),
			progress: typeof pct === "number" ? Math.max(0, Math.min(1, pct)) : 0,
			marks,
			hasCompanion,
		});
	}

	// Stable alphabetical order for now; recency-based sort is a Phase D/E concern.
	books.sort((a, b) => a.title.localeCompare(b.title));
	return books;
}

/** `Library/Eastern/foo.epub` → "Eastern"; `Library/foo.epub` → "" (root). */
function collectionOf(path: string): string {
	const rest = path.slice(LIBRARY_ROOT.length + 1);
	const slash = rest.indexOf("/");
	return slash === -1 ? "" : rest.slice(0, slash);
}

/**
 * The collection tabs to show — a **pure mirror of the live `Library/` folder
 * tree**: every immediate subfolder (including empty ones; `Annotations/` always
 * excluded), read straight from the vault so a folder dropped in appears and a
 * folder deleted disappears, with nothing persisted deciding a tab's existence.
 * "Everything" is prepended by the view and is not part of this list.
 *
 * `order` is only an **ordering hint** (from drag-to-reorder): live folders named
 * in it come first in that order, the rest follow alphabetically. Entries for
 * folders that no longer exist are ignored here (and pruned by the view).
 */
export function computeCollections(vault: Vault, order: string[]): string[] {
	const root = vault.getAbstractFileByPath(LIBRARY_ROOT);
	const folders = root instanceof TFolder
		? root.children
			.filter((c): c is TFolder => c instanceof TFolder && c.name !== "Annotations")
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
 * reader can't open in place (the Apple Books shape). Detected cheaply by probing
 * each folder for the epub signature (`META-INF/container.xml` or `mimetype`).
 * Recurses into ordinary collection folders but never into a detected epub's
 * internals; `Annotations/` is skipped. Returns the folder paths.
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
			if (folder === "Library/Annotations" || folder.startsWith(ANNOTATIONS_PREFIX)) continue;
			const isExploded =
				(await adapter.exists(`${folder}/META-INF/container.xml`)) ||
				(await adapter.exists(`${folder}/mimetype`));
			if (isExploded) found.push(folder);
			else await walk(folder);
		}
	};

	await walk(LIBRARY_ROOT);
	return found;
}

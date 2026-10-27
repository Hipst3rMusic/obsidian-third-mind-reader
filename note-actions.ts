import { type App, type EditorChange, MarkdownView, type Plugin, type TFile } from "obsidian";
import { isCompanionDoc } from "./library-scan";
import { hasCollapsedCallout, sectionRangeAt, setCalloutFold } from "./note-layout";

type LineRange = { from: number; to: number };

/** Rewrites the fold markers themselves, so the state persists and behaves the
 *  same in every view mode. In an editor it goes through a transaction, keeping
 *  the cursor and undo history; in reading view it edits the file. */
async function fold(
	app: App,
	view: MarkdownView | null,
	file: TFile,
	expand: (doc: string) => boolean,
	range?: LineRange,
): Promise<void> {
	if (view?.file === file && view.getMode() === "source") {
		const editor = view.editor;
		const doc = editor.getValue();
		const before = doc.split("\n");
		const after = setCalloutFold(doc, expand(doc), range).split("\n");
		const changes: EditorChange[] = [];
		before.forEach((line, i) => {
			if (line !== after[i]) changes.push({ from: { line: i, ch: 0 }, to: { line: i, ch: line.length }, text: after[i] });
		});
		if (changes.length) editor.transaction({ changes });
		return;
	}
	await app.vault.process(file, (doc) => setCalloutFold(doc, expand(doc), range));
}

/** Expand / collapse all annotations in a companion note: a header button on
 *  the note, palette commands for the whole note, and editor commands for the
 *  chapter under the cursor. */
export function registerNoteFoldActions(plugin: Plugin): void {
	const { app } = plugin;
	const buttons = new WeakMap<MarkdownView, HTMLElement>();

	const markdownViews = (): MarkdownView[] =>
		app.workspace.getLeavesOfType("markdown").flatMap((l) => (l.view instanceof MarkdownView ? [l.view] : []));

	const sync = (): void => {
		for (const view of markdownViews()) {
			const wanted = !!view.file && isCompanionDoc(view.file);
			const button = buttons.get(view);
			if (wanted && !button) {
				buttons.set(view, view.addAction("chevrons-up-down", "Expand or collapse all annotations", () => {
					if (view.file) void fold(app, view, view.file, hasCollapsedCallout);
				}));
			} else if (!wanted && button) {
				button.remove();
				buttons.delete(view);
			}
		}
	};
	plugin.registerEvent(app.workspace.on("layout-change", sync));
	plugin.registerEvent(app.workspace.on("file-open", sync));
	plugin.registerEvent(app.metadataCache.on("resolved", sync));
	app.workspace.onLayoutReady(sync);
	plugin.register(() => {
		for (const view of markdownViews()) buttons.get(view)?.remove();
	});

	const activeNote = (): TFile | null => {
		const file = app.workspace.getActiveFile();
		return file && isCompanionDoc(file) ? file : null;
	};

	for (const expanded of [true, false]) {
		const verb = expanded ? "Expand" : "Collapse";
		plugin.addCommand({
			id: `${verb.toLowerCase()}-all-annotations`,
			name: `${verb} all annotations in this note`,
			checkCallback: (checking) => {
				const file = activeNote();
				if (!file) return false;
				if (!checking) void fold(app, app.workspace.getActiveViewOfType(MarkdownView), file, () => expanded);
				return true;
			},
		});
		plugin.addCommand({
			id: `${verb.toLowerCase()}-chapter-annotations`,
			name: `${verb} annotations in this chapter`,
			editorCheckCallback: (checking, editor, ctx) => {
				const file = ctx.file;
				if (!file || !isCompanionDoc(file) || !(ctx instanceof MarkdownView)) return false;
				const range = sectionRangeAt(editor.getValue(), editor.getCursor().line);
				if (!range) return false;
				if (!checking) void fold(app, ctx, file, () => expanded, range);
				return true;
			},
		});
	}
}

/** Deferred AI queue — the desktop half of Mobile spec Tier 1.
 *
 *  A mobile session with no reachable provider writes the user's turn into the
 *  companion doc and stops, leaving a `<!-- ai response pending -->` marker.
 *  The companion doc *is* the queue: no new storage, and Obsidian Sync is the
 *  transport. This module answers those markers from a desktop session.
 *
 *  Deliberately headless — it takes a `TFile` and never a view, which is what
 *  lets the palette command drain every flagged doc in the vault without
 *  opening a single book.
 */

import { App, TFile } from "obsidian";
import { chat, tokenBudget, type AiProvider, type ChatMessage } from "./ai-client";
import {
	AI_PENDING_KEY,
	GLOSS_AI_MODES,
	parseSavedHighlights,
	rewriteCalloutBody,
	setAiPendingCount,
	type ConversationTurn,
	type SavedHighlight,
} from "./gloss";
import { buildGlossSystemPrompt, type HighlightsPaneSettings } from "./highlights-pane";

export interface QueueResult {
	/** Exchanges that came back with an answer. */
	resolved: number;
	/** Exchanges that reached a provider and failed — error marker written. */
	failed: number;
	/** The provider rate-limited us and the drain stopped early. Whatever was
	 *  left keeps its pending marker, so the next run picks it up. */
	rateLimited?: boolean;
}

/** Every companion doc currently flagged as holding pending exchanges.
 *
 *  Reads `metadataCache` only: no file is opened, and a vault with hundreds of
 *  annotation docs costs one cache lookup each. The flag is a hint — a doc that
 *  lies about it simply processes zero exchanges, and one that lost its flag is
 *  picked up the next time its book is opened. */
export function findFlaggedDocs(app: App): TFile[] {
	return app.vault.getMarkdownFiles().filter((file) => {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		return typeof fm?.[AI_PENDING_KEY] === "number" && fm[AI_PENDING_KEY] > 0;
	});
}

/** Resolve every pending exchange in one companion doc, oldest first.
 *
 *  Re-reads and re-parses the doc rather than trusting the caller's model: the
 *  file may have been edited (or synced) since it was last loaded, and the
 *  marker is ground truth while the frontmatter count is only a hint. Each
 *  exchange is written back before the next one starts, so an interrupted run
 *  leaves the finished ones finished rather than losing the batch. */
export async function processPendingInFile(
	app: App,
	file: TFile,
	settings: HighlightsPaneSettings,
	provider: AiProvider,
): Promise<QueueResult> {
	const content = await app.vault.read(file);
	const saved = parseSavedHighlights(content);
	const pending = saved.filter(
		(h) => h.aiState === "pending" && GLOSS_AI_MODES.has(h.mode) && conversationTurns(h).length > 0,
	);
	if (!pending.length) {
		// Nothing to do, but the hint said otherwise — correct it so the next
		// sweep doesn't keep re-opening this file.
		await setAiPendingCount(app, file, 0);
		return { resolved: 0, failed: 0 };
	}

	// The book title the prompts interpolate. Frontmatter first (written by
	// ensureCompanionDoc), then the doc's own name minus the suffix we add.
	const title = String(
		app.metadataCache.getFileCache(file)?.frontmatter?.title
		?? file.basename.replace(/-Annotations$/, ""),
	);

	const model = provider.defaultModel;
	if (!model) return { resolved: 0, failed: 0 };

	let resolved = 0;
	let failed = 0;
	for (const entry of pending) {
		entry.turns = conversationTurns(entry);
		const messages: ChatMessage[] = entry.turns.map((t) => ({ role: t.role, content: t.content }));
		try {
			const res = await chat(provider, model, {
				messages,
				systemPrompt: buildGlossSystemPrompt(settings, title, entry),
				...tokenBudget(entry.mode),
				// Never stream here: there is no chat log to stream into, and a
				// buffered call is the one shape both cloud and local support.
				stream: false,
			});
			entry.turns.push({ role: "assistant", content: res.content });
			entry.aiState = "complete";
			delete entry.aiError;
			resolved++;
		} catch (err) {
			const msg = (err as Error).message ?? "Unknown error";
			// A rate limit will hit every remaining exchange in the batch, so stop
			// and leave them pending rather than burning the queue down into a
			// column of identical errors. Common on free tiers, not exotic.
			if (/\b429\b|rate limit/i.test(msg)) {
				return { resolved, failed, rateLimited: true };
			}
			entry.aiState = "error";
			entry.aiError = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
			failed++;
		}
		await app.vault.process(file, (doc) => rewriteCalloutBody(doc, entry));
	}

	// Recount from the model we just mutated, not from what we started with:
	// failures leave an error marker, not a pending one.
	await setAiPendingCount(app, file, countPending(saved));
	return { resolved, failed };
}

/** The turns to send for one entry, seeding the opener from `userText` when the
 *  callout carries no `User:` prefix. Phase 2 callouts wrote the user's line
 *  bare, so the parser leaves `turns` empty; `doAiExchange` seeds the same way,
 *  and without the mirror here such an exchange is filtered out as "nothing
 *  pending" and has its flag cleared, silently dropping the request. */
function conversationTurns(saved: SavedHighlight): ConversationTurn[] {
	if (saved.turns.length > 0) return saved.turns;
	const opener = saved.userText.trim();
	return opener ? [{ role: "user", content: opener }] : [];
}

function countPending(saved: SavedHighlight[]): number {
	return saved.filter((h) => h.aiState === "pending").length;
}

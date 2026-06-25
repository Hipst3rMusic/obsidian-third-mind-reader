/** Provider-agnostic AI chat client.
 *
 *  Speaks to three provider kinds via a single `chat()` entry point:
 *  - anthropic           → POST /v1/messages on api.anthropic.com
 *  - openai              → POST /v1/chat/completions on api.openai.com
 *  - openai-compatible   → POST /v1/chat/completions on a user-supplied endpoint
 *                          (Ollama, LM Studio, llama.cpp server, vLLM, etc.)
 *
 *  Local-first: probe results in main.ts settings rank reachable local
 *  endpoints above cloud providers when picking the global default.
 *
 *  v1 = single-shot, awaited responses. Streaming will be added later if
 *  awaited responses feel sluggish on local Ollama. Tools / web search are
 *  passed through opaquely (provider-specific spec) so each mode adapter
 *  in main.ts can decorate the request without this file knowing about
 *  Anthropic vs OpenAI tool schema differences. */

import { requestUrl } from "obsidian";

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

/** Which local runtime an openai-compatible provider points at. Carried as
 *  metadata so presets can prefill the right port and future lifecycle features
 *  (LM Studio `ttl`, Ollama `keep_alive`) can branch on it. "generic" = a hand-
 *  configured OpenAI-compatible server with no runtime-specific behaviour. */
export type LocalRuntime = "lm-studio" | "ollama" | "generic";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface ChatRequest {
	messages: ChatMessage[];
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	/** Provider-specific tool spec list. Anthropic uses `{name, description,
	 *  input_schema}`; OpenAI uses `{type:"function", function:{...}}`.
	 *  Caller is responsible for shape; this client passes through. */
	tools?: unknown[];
	/** Request a token-by-token stream. Only honoured for openai-compatible
	 *  providers (local servers like LM Studio / Ollama, which permit a direct
	 *  browser `fetch`); anthropic/openai cloud kinds ignore it and return a
	 *  single buffered response. If the streaming `fetch` fails (CORS, network)
	 *  the client transparently falls back to the buffered path. */
	stream?: boolean;
	/** Invoked with each incremental content chunk during a streamed response.
	 *  Reasoning-model `delta.reasoning` chunks are ignored — only user-facing
	 *  `delta.content` is forwarded. */
	onDelta?: (delta: string) => void;
	/** Fired once the streamed response's headers arrive. For LM Studio this is
	 *  the moment just-in-time model loading completes (the server holds the
	 *  response open while loading), so the UI can switch a "Loading model…"
	 *  indicator over to "Thinking…". Never fired on the buffered path. */
	onResponseStart?: () => void;
	/** Abort an in-flight streamed request (e.g. the conversation was closed or
	 *  the reader navigated away). */
	signal?: AbortSignal;
}

export interface ChatResponse {
	/** Concatenated text content from the response. For tool-bearing turns
	 *  this excludes tool_use blocks — the caller inspects `raw` for those. */
	content: string;
	/** Original provider response for callers that need tool_use blocks,
	 *  citation metadata, finish reasons, token counts, etc. */
	raw: any;
}

export interface AiProvider {
	/** User-facing identifier, e.g. "Local LM Studio" or "Anthropic". Must be
	 *  unique within the providers list — used as a stable key in
	 *  `settings.aiDefaults.primaryProviderId` and per-conversation pins. */
	id: string;
	kind: ProviderKind;
	/** Required for openai-compatible (e.g. "http://localhost:1234" for LM
	 *  Studio, "http://localhost:11434" for Ollama). Trailing slashes are
	 *  stripped at request time. */
	endpoint?: string;
	/** For openai-compatible providers: which local runtime this points at.
	 *  Set by the "+ LM Studio" / "+ Ollama" / "+ OpenAI-compatible" presets;
	 *  drives the default port and (later) runtime-specific lifecycle. */
	localRuntime?: LocalRuntime;
	/** Resolved API key for anthropic / openai. Populated at runtime from
	 *  Obsidian's encrypted secret storage (keyed by `apiKeyId`) — it is
	 *  NEVER persisted to data.json. May be undefined if the secret is
	 *  missing; callers branch on that. */
	apiKey?: string;
	/** Secret-storage ID for the API key. This is the only key-related field
	 *  written to data.json; the actual key lives in `app.secretStorage`. */
	apiKeyId?: string;
	/** Model id used when this provider is the default. Examples:
	 *  - anthropic:         "claude-haiku-4-5-20251001"
	 *  - openai:            "gpt-4o-mini"
	 *  - openai-compatible: depends on the local server's model list */
	defaultModel?: string;
}

export interface ProbeResult {
	available: boolean;
	models: string[];
	error?: string;
}

/** Hit the provider's `/v1/models` endpoint to confirm reachability and
 *  enumerate available models. Used by the settings tab "Test connection"
 *  button and at plugin load to mark unreachable providers in the picker.
 *
 *  Always returns a result object — does not throw. Callers branch on
 *  `result.available`. */
export async function probeProvider(provider: AiProvider): Promise<ProbeResult> {
	try {
		if (provider.kind === "anthropic") {
			if (!provider.apiKey) {
				return { available: false, models: [], error: "missing api key" };
			}
			const res = await requestUrl({
				url: "https://api.anthropic.com/v1/models",
				headers: {
					"x-api-key": provider.apiKey,
					"anthropic-version": "2023-06-01",
				},
				throw: false,
			});
			if (res.status >= 400) {
				return { available: false, models: [], error: `HTTP ${res.status}` };
			}
			const data = res.json?.data ?? [];
			return { available: true, models: data.map((m: any) => m.id) };
		}

		const endpoint = endpointFor(provider);
		if (!endpoint) {
			return { available: false, models: [], error: "missing endpoint" };
		}
		const headers: Record<string, string> = {};
		if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
		const res = await requestUrl({
			url: `${endpoint}/v1/models`,
			headers,
			throw: false,
		});
		if (res.status >= 400) {
			return { available: false, models: [], error: `HTTP ${res.status}` };
		}
		const data = res.json?.data ?? [];
		return { available: true, models: data.map((m: any) => m.id) };
	} catch (err) {
		return { available: false, models: [], error: (err as Error).message };
	}
}

/** Determine whether `model` is already resident in the local server's memory,
 *  so the UI can show "Loading model…" only when a genuine cold load is coming.
 *  Returns true (loaded) / false (reachable but not loaded) / null (can't tell:
 *  cloud provider, unreachable server, or an unrecognised model/runtime). Never
 *  throws.
 *
 *  LM Studio reports an explicit per-model `state` at `/api/v0/models`; Ollama
 *  lists only currently-resident models at `/api/ps` (presence == loaded). When
 *  the runtime is unset (hand-configured server) both are attempted — LM Studio
 *  first, since a stated value beats mere presence. */
export async function probeModelLoaded(
	provider: AiProvider,
	model: string,
): Promise<boolean | null> {
	if (provider.kind !== "openai-compatible") return null;
	const endpoint = endpointFor(provider);
	if (!endpoint) return null;
	const rt = provider.localRuntime;
	if (rt === "ollama") return probeOllamaLoaded(endpoint, model);
	if (rt === "lm-studio") return probeLmStudioLoaded(endpoint, provider.apiKey, model);
	// Unknown runtime: try LM Studio's stateful endpoint, then Ollama's.
	const lm = await probeLmStudioLoaded(endpoint, provider.apiKey, model);
	if (lm !== null) return lm;
	return probeOllamaLoaded(endpoint, model);
}

async function probeLmStudioLoaded(
	endpoint: string,
	apiKey: string | undefined,
	model: string,
): Promise<boolean | null> {
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const res = await requestUrl({ url: `${endpoint}/api/v0/models`, headers, throw: false });
		if (res.status >= 400) return null;
		const data = res.json?.data;
		if (!Array.isArray(data)) return null;
		const entry = data.find((m: any) => m?.id === model);
		// Model absent from the list → not an LM Studio model we can speak to.
		if (!entry) return null;
		return entry.state === "loaded";
	} catch {
		return null;
	}
}

async function probeOllamaLoaded(
	endpoint: string,
	model: string,
): Promise<boolean | null> {
	try {
		const res = await requestUrl({ url: `${endpoint}/api/ps`, throw: false });
		if (res.status >= 400) return null;
		const models = res.json?.models;
		if (!Array.isArray(models)) return null;
		// /api/ps lists only resident models — presence == loaded.
		return models.some((m: any) => m?.model === model || m?.name === model);
	} catch {
		return null;
	}
}

/** Send a chat completion request and return the assistant's text response.
 *  Throws on any non-2xx status with a truncated body excerpt for diagnostics
 *  — callers (mode handlers in main.ts) translate the throw into a user-
 *  visible error bubble in the conversation surface. */
export async function chat(
	provider: AiProvider,
	model: string,
	req: ChatRequest,
): Promise<ChatResponse> {
	switch (provider.kind) {
		case "anthropic":
			return chatAnthropic(provider, model, req);
		case "openai":
		case "openai-compatible":
			// Streaming is only attempted for openai-compatible (local) endpoints:
			// cloud OpenAI rejects browser-origin `fetch` on CORS, so it stays on
			// the buffered `requestUrl` path.
			if (req.stream && req.onDelta && provider.kind === "openai-compatible") {
				return chatOpenAILikeStreaming(provider, model, req);
			}
			return chatOpenAILike(provider, model, req);
	}
}

async function chatAnthropic(
	provider: AiProvider,
	model: string,
	req: ChatRequest,
): Promise<ChatResponse> {
	if (!provider.apiKey) throw new Error("Anthropic API key not configured");
	const body: Record<string, any> = {
		model,
		max_tokens: req.maxTokens ?? 1024,
		// Anthropic's messages API accepts only user/assistant roles; system
		// content goes in the top-level `system` field. Callers shouldn't
		// route a `system`-roled message in `messages`, but if they do we
		// downgrade to user rather than 400.
		messages: req.messages.map(m => ({
			role: m.role === "system" ? "user" : m.role,
			content: m.content,
		})),
	};
	if (req.systemPrompt) body.system = req.systemPrompt;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	if (req.tools?.length) body.tools = req.tools;

	const res = await requestUrl({
		url: "https://api.anthropic.com/v1/messages",
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": provider.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(`Anthropic ${res.status}: ${truncate(res.text)}`);
	}
	const json = res.json;
	const content = (json.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
	return { content, raw: json };
}

async function chatOpenAILike(
	provider: AiProvider,
	model: string,
	req: ChatRequest,
): Promise<ChatResponse> {
	const endpoint = endpointFor(provider);
	if (!endpoint) throw new Error("Endpoint not configured");
	const messages = [...req.messages];
	if (req.systemPrompt) messages.unshift({ role: "system", content: req.systemPrompt });
	const body: Record<string, any> = {
		model,
		messages: messages.map(m => ({ role: m.role, content: m.content })),
	};
	if (req.maxTokens) body.max_tokens = req.maxTokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	if (req.tools?.length) body.tools = req.tools;

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;

	const res = await requestUrl({
		url: `${endpoint}/v1/chat/completions`,
		method: "POST",
		headers,
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(`${provider.kind} ${res.status}: ${truncate(res.text)}`);
	}
	const json = res.json;
	const content = json.choices?.[0]?.message?.content ?? "";
	return { content, raw: json };
}

/** Streamed variant of {@link chatOpenAILike} for local openai-compatible
 *  servers. Uses `fetch` (not Obsidian's `requestUrl`, which buffers the whole
 *  body before resolving) so content arrives token-by-token via Server-Sent
 *  Events. Accumulates the full text for the returned `ChatResponse` while
 *  forwarding each chunk to `req.onDelta`.
 *
 *  Resilience: a `fetch` rejection that is NOT an abort (CORS, connection
 *  refused) falls back to the buffered path so the user still gets an answer.
 *  Aborts propagate so the caller can distinguish a cancelled request. */
async function chatOpenAILikeStreaming(
	provider: AiProvider,
	model: string,
	req: ChatRequest,
): Promise<ChatResponse> {
	const endpoint = endpointFor(provider);
	if (!endpoint) throw new Error("Endpoint not configured");
	const messages = [...req.messages];
	if (req.systemPrompt) messages.unshift({ role: "system", content: req.systemPrompt });
	const body: Record<string, any> = {
		model,
		messages: messages.map(m => ({ role: m.role, content: m.content })),
		stream: true,
	};
	if (req.maxTokens) body.max_tokens = req.maxTokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	// `tools` intentionally omitted: streamed tool_call deltas need reassembly
	// and no conversation mode passes tools through the streaming path yet.

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;

	let res: Response;
	try {
		res = await fetch(`${endpoint}/v1/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: req.signal,
		});
	} catch (err) {
		// User-initiated cancel: surface it. Anything else (CORS/network) →
		// retry on the buffered transport so streaming failure is never fatal.
		if (req.signal?.aborted) throw err;
		return chatOpenAILike(provider, model, req);
	}

	// Headers received — for LM Studio this is the instant JIT loading finished.
	req.onResponseStart?.();

	if (res.status >= 400 || !res.body) {
		const text = await res.text().catch(() => "");
		throw new Error(`${provider.kind} ${res.status}: ${truncate(text)}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let lastRaw: any = null;

	// SSE frames are newline-delimited `data: {json}` lines; a single frame's
	// JSON never contains a raw newline, so splitting on "\n" is safe. Any
	// partial trailing line is held in `buffer` until the next chunk completes
	// it (a `data:` payload can straddle two reads).
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "" || payload === "[DONE]") continue;
			try {
				const json = JSON.parse(payload);
				lastRaw = json;
				const delta = json.choices?.[0]?.delta?.content;
				if (delta) {
					content += delta;
					req.onDelta?.(delta);
				}
			} catch {
				// Malformed complete frame — drop it. (Genuine cross-chunk
				// splits never reach here: a line with no trailing "\n" stays
				// in `buffer` and isn't parsed until the next read completes it.)
			}
		}
	}

	return { content, raw: lastRaw };
}

function endpointFor(provider: AiProvider): string {
	if (provider.kind === "openai") return "https://api.openai.com";
	if (provider.kind === "openai-compatible") {
		return (provider.endpoint ?? "").replace(/\/$/, "");
	}
	return "";
}

function truncate(s: string, n = 200): string {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

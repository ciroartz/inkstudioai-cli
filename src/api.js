import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export const USER_AGENT = `inkstudioai-cli/${VERSION} (node ${process.versions.node}; ${process.platform})`;
/** The MCP server adds "; mcp" so the server can count MCP use apart from the CLI. */
export const MCP_USER_AGENT = USER_AGENT.replace(/\)$/, "; mcp)");

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Wait for the response headers of a generation. A server that does not
 * stream answers only after the whole generation (provider timeouts stay under 55 s).
 */
const GENERATION_HEADERS_TIMEOUT_MS = 90_000;
/** The server sends a heartbeat every 10 s, so 45 s without data means the stream is stuck. */
const GENERATION_IDLE_TIMEOUT_MS = 45_000;

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: Record<string, any>, signedOut?: boolean }} [info]
   *   `signedOut` marks a request that never left this computer because no key is configured.
   */
  constructor(message, { status = 0, code = "error", body = {}, signedOut = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
    this.signedOut = signedOut;
  }
}

/** No API key is configured at all. */
export function notSignedIn() {
  return new ApiError("You are not signed in.", { status: 401, code: "unauthorized", signedOut: true });
}

/**
 * @typedef {{ event: string, data: any }} SseEvent
 * @typedef {ReturnType<typeof createClient>} Client
 */

/** @param {{ baseUrl: string, apiKey?: string, userAgent?: string }} options */
export function createClient({ baseUrl, apiKey, userAgent = USER_AGENT }) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ body?: unknown, auth?: boolean, query?: Record<string, unknown>, accept?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
   *   `timeoutMs: 0` turns off the fixed timeout; the caller then controls time through `signal`.
   */
  async function send(method, path, options = {}) {
    const url = new URL(baseUrl + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    /** @type {Record<string, string>} */
    const headers = { "User-Agent": userAgent, Accept: options.accept ?? "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.auth) {
      if (!apiKey) throw notSignedIn();
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const signals = [options.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
      (item) => item !== undefined,
    );
    const signal = signals.length > 1 ? anySignal(signals) : signals[0];
    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      throw networkError(error, url.origin);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  /** @param {string} method @param {string} path @param {Parameters<typeof send>[2]} [options] */
  async function json(method, path, options) {
    const response = await send(method, path, options);
    return /** @type {Promise<any>} */ (response.json());
  }

  return {
    baseUrl,
    hasKey: Boolean(apiKey),
    styles: () => json("GET", "/styles"),
    pricing: () => json("GET", "/pricing"),
    me: () => json("GET", "/me", { auth: true }),
    /** @param {{ page?: number, limit?: number }} query */
    designs: (query) => json("GET", "/designs", { auth: true, query }),
    /** @param {{ q?: string, page?: number, limit?: number }} query */
    gallery: (query) => json("GET", "/gallery", { query }),
    /** @param {string} sku */
    checkout: (sku) => json("POST", "/checkout", { auth: true, body: { sku } }),
    /** @param {string} clientName */
    startDeviceLogin: (clientName) => json("POST", "/auth/device", { body: { clientName } }),
    /** @param {string} deviceCode */
    pollDeviceLogin: (deviceCode) => json("POST", "/auth/token", { body: { deviceCode } }),

    /**
     * Create a design. Streams progress through `onEvent` when the server
     * answers with Server-Sent Events, and resolves with the `complete` data.
     * After the server accepts the request, a broken or stuck connection is a
     * `stream_closed` error: the server can keep the generation, so the caller
     * must not suggest a blind retry.
     * @param {Record<string, unknown>} body
     * @param {{ onEvent?: (event: SseEvent) => void, signal?: AbortSignal }} [options]
     */
    async generate(body, { onEvent, signal } = {}) {
      const origin = new URL(baseUrl).origin;
      const stalled = new AbortController();
      let timedOut = false;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      /** @param {number} ms */
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          stalled.abort();
        }, ms);
      };
      arm(GENERATION_HEADERS_TIMEOUT_MS);
      try {
        let response;
        try {
          response = await send("POST", "/generations", {
            auth: true,
            body,
            accept: "text/event-stream",
            timeoutMs: 0,
            signal: signal ? anySignal([signal, stalled.signal]) : stalled.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw new ApiError("Cancelled.", { code: "cancelled" });
          if (timedOut) throw streamClosed(`${origin} did not answer in time.`);
          throw error;
        }
        arm(GENERATION_IDLE_TIMEOUT_MS);
        try {
          if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
            return checkComplete(await response.json());
          }
          const chunks = touch(/** @type {any} */ (response.body), () => arm(GENERATION_IDLE_TIMEOUT_MS));
          for await (const event of readEvents(chunks)) {
            if (event.event === "complete") return checkComplete(event.data);
            if (event.event === "error") {
              const data = event.data ?? {};
              throw new ApiError(data.message || "Generation failed.", {
                status: data.status,
                code: data.code,
                body: data,
              });
            }
            onEvent?.(event);
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          if (signal?.aborted) throw new ApiError("Cancelled.", { code: "cancelled" });
          if (timedOut) throw streamClosed("The server stopped sending updates before the design was ready.");
          throw streamClosed("The connection closed before the design was ready.");
        }
        throw streamClosed("The connection closed before the design was ready.");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse a Server-Sent Events body. Handles events split across chunks,
 * CRLF line endings, comment lines, and multi-line data.
 * @param {AsyncIterable<Uint8Array>} body
 * @returns {AsyncGenerator<SseEvent>}
 */
export async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = /\r?\n\r?\n/.exec(buffer))) {
      const event = parseEvent(buffer.slice(0, end.index));
      buffer = buffer.slice(end.index + end[0].length);
      if (event) yield event;
    }
  }
  // An event without its closing blank line was cut off; the SSE rules drop it.
}

/** Call `onData` for every chunk, so an idle timer can restart. @param {AsyncIterable<Uint8Array>} body @param {() => void} onData */
async function* touch(body, onData) {
  for await (const chunk of body) {
    onData();
    yield chunk;
  }
}

/** @param {string} message */
function streamClosed(message) {
  return new ApiError(message, { code: "stream_closed" });
}

/** The `complete` data must carry the image URL, or the design is not usable. @param {unknown} data */
function checkComplete(data) {
  const result = /** @type {Record<string, any>} */ (data);
  if (!result || typeof result !== "object" || typeof result.imageUrl !== "string" || !result.imageUrl) {
    throw streamClosed("The server answered without the finished design.");
  }
  return result;
}

/** @param {string} block @returns {SseEvent | undefined} */
function parseEvent(block) {
  let event = "message";
  /** @type {string[]} */
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  const raw = data.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

/** @param {Response} response */
async function errorFromResponse(response) {
  const text = await response.text().catch(() => "");
  /** @type {Record<string, any>} */
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // A proxy error page or an empty body.
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  if (body.retryAfterSeconds === undefined && retryAfter > 0) body.retryAfterSeconds = retryAfter;
  return new ApiError(
    typeof body.error === "string" ? body.error : `The server answered HTTP ${response.status}.`,
    { status: response.status, code: body.code ?? codeForStatus(response.status), body },
  );
}

/** @param {number} status */
function codeForStatus(status) {
  if (status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "error";
}

/** @param {unknown} error @param {string} origin */
function networkError(error, origin) {
  const err = /** @type {{ name?: string, cause?: { code?: string } }} */ (error);
  if (err?.name === "TimeoutError") {
    return new ApiError(`${origin} did not answer in time. Try again.`, { code: "network" });
  }
  if (err?.name === "AbortError") return new ApiError("Cancelled.", { code: "cancelled" });
  const detail = err?.cause?.code ? ` (${err.cause.code})` : "";
  return new ApiError(`Could not reach ${origin}${detail}. Check your connection and try again.`, {
    code: "network",
  });
}

/** AbortSignal.any is Node 20.3+; this covers Node 18. @param {AbortSignal[]} signals */
function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

const MODERATION_REASONS = /** @type {Record<string, string>} */ ({
  sexual_minors: "sexual content involving minors",
  sexual_explicit: "explicit sexual content",
  hate: "hateful content",
  violence_incitement: "incitement to violence",
  harassment: "harassment",
  other: "the content policy",
});

/**
 * Turn an error into a message and next steps. Shared by the CLI and the MCP
 * server. Stream errors use the codes of generationEvents.ts ("auth",
 * "credits"); plain JSON errors use the codes of the public API.
 * @param {unknown} error
 * @param {string} site
 * @param {"flag" | "env" | "file"} [keySource] where the rejected key came from
 * @returns {{ message: string, hints: string[] }}
 */
export function describeError(error, site, keySource) {
  if (!(error instanceof ApiError)) {
    return { message: error instanceof Error ? error.message : String(error), hints: [] };
  }
  const { code, body } = error;
  switch (code) {
    case "unauthorized":
    case "auth":
      if (error.signedOut) {
        return {
          message: "You are not signed in.",
          hints: ["Run `inkstudioai login` to sign in. New accounts get a free design."],
        };
      }
      return {
        message: "Your API key is unknown or revoked.",
        hints: [
          // A flag or environment key wins over a new login, so name the one to change.
          keySource === "flag"
            ? "Pass a valid key with --api-key, or drop the flag and run `inkstudioai login`."
            : keySource === "env"
              ? "Set INKSTUDIO_API_KEY to a valid key, or unset it and run `inkstudioai login`."
              : "Run `inkstudioai login` to sign in again.",
        ],
      };
    case "paywall":
      return {
        message: "You have no free design left and no active plan.",
        hints: [
          "Run `inkstudioai pricing` to see the plans.",
          "Run `inkstudioai buy <sku>` to buy one.",
        ],
      };
    case "plan_required":
      return {
        message: "Credit packs need an active plan.",
        hints: ["Buy a plan first. Run `inkstudioai pricing` to see the plans."],
      };
    case "rate_limited":
      return {
        message: "Too many requests.",
        hints: [`Try again in ${body.retryAfterSeconds ?? 60} seconds.`],
      };
    case "daily_limit":
      return {
        message: "Your account reached its daily API generation limit.",
        hints: [`Try again in ${formatDuration(body.retryAfterSeconds ?? 3600)}, or use ${site}.`],
      };
    case "moderation": {
      const reason = MODERATION_REASONS[body.reason] ?? MODERATION_REASONS.other;
      const field = body.field && body.field !== "prompt" ? ` in ${body.field}` : "";
      return {
        message: `The prompt was blocked: it breaks the rule on ${reason}${field}.`,
        hints: ["Change the prompt and try again. A blocked prompt does not use a generation."],
      };
    }
    case "stream_closed":
      return {
        message: error.message,
        hints: [
          "The design may still be saved to your account, and it may have used a generation.",
          "Run `inkstudioai designs` to check if it was saved.",
        ],
      };
    case "provider":
    case "timeout":
    case "upload":
      return {
        message: error.message,
        hints: ["No generation was used. Try again in a moment."],
      };
    default:
      return { message: error.message, hints: [] };
  }
}

/** @param {number} seconds */
function formatDuration(seconds) {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

// A local server that follows the public API (https://inkstudioai.com/api/v1/openapi.json), for the CLI tests.
import { createServer } from "node:http";

export const VALID_KEY = "isk_test_valid_key_0001";
export const OTHER_KEY = "isk_test_other_key_0002";
export const IMAGE_BYTES = Buffer.from("RIFF0000WEBPVP8 fake image bytes");

/** The same plans and packs as GET /api/v1/pricing, in its order. */
export const PRICING = {
  currency: "usd",
  pricingUrl: "https://inkstudioai.com/pricing",
  plans: [
    { sku: "7-day-access", label: "7-Day Access", durationDays: 7, premiumCredits: 10, priceUsd: 12.99 },
    { sku: "14-day-access", label: "14-Day Access", durationDays: 14, premiumCredits: 20, priceUsd: 16.99 },
    { sku: "30-day-access", label: "30-Day Access", durationDays: 30, premiumCredits: 30, priceUsd: 23.99 },
  ],
  creditPacks: [
    { sku: "credits-20", label: "20 Credits", credits: 20, priceUsd: 9.99, requiresPlan: true },
    { sku: "credits-50", label: "50 Credits", credits: 50, priceUsd: 19.99, requiresPlan: true },
    { sku: "credits-120", label: "120 Credits", credits: 120, priceUsd: 39.99, requiresPlan: true },
  ],
};

/**
 * "paid": an active plan. "free": a new account with its free design and no
 * plan. "none": no free design and no plan, so a generation answers 402.
 * @typedef {"paid" | "free" | "none"} Account
 */

/** @param {string} email @param {Account} account */
function me(email, account) {
  const links = { account: "https://inkstudioai.com/account", pricing: "https://inkstudioai.com/pricing" };
  if (account === "paid") {
    return {
      email,
      name: "Ana",
      plan: { active: true, expiresOn: "2026-11-01T10:00:00.000Z" },
      freeGenerations: 0,
      premiumCredits: { plan: 8, purchased: 20, total: 28 },
      designsGenerated: 14,
      generation: { canGenerate: true, tier: "paid", dailyLimit: 50, usedToday: 3 },
      links,
    };
  }
  return {
    email,
    name: "Ana",
    plan: { active: false, expiresOn: null },
    freeGenerations: account === "free" ? 1 : 0,
    premiumCredits: { plan: 0, purchased: 0, total: 0 },
    designsGenerated: account === "free" ? 0 : 1,
    generation: { canGenerate: account === "free", tier: account === "free" ? "free" : null, dailyLimit: 50, usedToday: 0 },
    links,
  };
}

/**
 * @typedef {{
 *   account: Account,
 *   generation: "stream" | "json" | "moderation" | "rate_limited" | "reset" | "cut_off",
 *   designSaved: boolean,
 *   tokenAnswers: string[],
 *   imagePath: string,
 * }} MockState
 */

export async function startMockServer() {
  /** @type {{ method: string, path: string, headers: import("node:http").IncomingHttpHeaders, body: any }[]} */
  const requests = [];
  /** @type {MockState} */
  const state = {
    account: "paid",
    generation: "stream",
    designSaved: true,
    tokenAnswers: ["authorization_pending", "slow_down", "authorization_pending", "ok"],
    imagePath: "/cdn/design.webp",
  };
  let origin = "";

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", origin);
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });

    /** @param {number} status @param {unknown} data @param {Record<string, string>} [headers] */
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const keyOf = () => (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const authed = () => [VALID_KEY, OTHER_KEY].includes(keyOf());
    const unauthorized = () => json(401, { error: "Invalid API key", code: "unauthorized" });
    const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`;

    switch (route) {
      case "GET /cdn/design.webp":
        res.writeHead(200, { "content-type": "image/webp" });
        return res.end(IMAGE_BYTES);
      case "GET /cdn/large.png":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.alloc(2_000_000));
      case "GET /styles":
        return json(200, {
          styles: [
            { id: "minimal", label: "Minimal", colorOptional: true },
            { id: "fine-line", label: "Fine line", colorOptional: true },
            { id: "black-and-gray", label: "Black and gray", colorOptional: false },
          ],
        });
      case "GET /pricing":
        return json(200, PRICING);
      case "GET /me":
        if (!authed()) return unauthorized();
        return json(200, me(keyOf() === VALID_KEY ? "ana@example.com" : "other@example.com", state.account));
      case "GET /gallery":
        return json(200, {
          designs: [
            {
              id: "g1",
              imageUrl: `${origin}/cdn/design.webp`,
              prompt: `${url.searchParams.get("q") ?? "rose"} wrapped around a dagger`,
              style: "japanese",
              url: "https://inkstudioai.com/tattoos/dragon-dagger",
            },
          ],
          page: 1,
          limit: Number(url.searchParams.get("limit") ?? 12),
          total: 30,
          hasMore: true,
        });
      case "GET /designs":
        if (!authed()) return unauthorized();
        return json(200, { designs: [], page: 1, limit: 20, total: 0, hasMore: false });
      case "POST /checkout":
        if (!authed()) return unauthorized();
        if (PRICING.creditPacks.some((pack) => pack.sku === body?.sku)) {
          if (state.account !== "paid") {
            return json(403, {
              error: "Credit packs require an active plan",
              code: "plan_required",
              pricingUrl: PRICING.pricingUrl,
            });
          }
        } else if (!PRICING.plans.some((plan) => plan.sku === body?.sku)) {
          return json(400, { error: "Unknown sku", code: "validation" });
        }
        return json(200, { url: `https://checkout.stripe.com/c/pay/cs_test_${body.sku}` });
      case "POST /auth/device":
        return json(200, {
          deviceCode: "d".repeat(43),
          userCode: "WDJB-MJHT",
          verificationUrl: "https://inkstudioai.com/cli/authorize",
          verificationUrlComplete: "https://inkstudioai.com/cli/authorize?code=WDJB-MJHT",
          expiresIn: 600,
          interval: 5,
        });
      case "POST /auth/token": {
        const answer = state.tokenAnswers.shift() ?? "expired_token";
        if (answer === "502") {
          res.writeHead(502, { "content-type": "text/html" });
          return res.end("<html>Bad gateway</html>");
        }
        if (answer === "ok") return json(200, { apiKey: VALID_KEY, keyId: "key_1", email: "ana@example.com" });
        return json(400, { error: answer, code: answer });
      }
      case "POST /generations":
        return generation();
      default:
        return json(404, { error: "Not found", code: "not_found" });
    }

    async function generation() {
      if (!authed()) return unauthorized();
      if (state.account === "none") {
        return json(402, { error: "No access", code: "paywall", pricingUrl: PRICING.pricingUrl });
      }
      if (state.generation === "rate_limited") {
        return json(429, { error: "Too many requests", code: "rate_limited", retryAfterSeconds: 42 }, { "retry-after": "42" });
      }
      const free = state.account === "free";
      const complete = {
        id: state.designSaved ? "6718f0c2a1b2c3d4e5f60718" : null,
        imageUrl: `${origin}${state.imagePath}`,
        prompt: body.prompt,
        style: body.style ?? "minimal",
        color: Boolean(body.color),
        background: body.background ?? "white",
        tier: free ? "free" : "paid",
        ...(free ? { freeGenerationsRemaining: 0 } : {}),
        provider: "openai",
        model: "gpt-image-2.5-flare",
        createdAt: "2026-10-24T09:00:00.000Z",
      };
      if (state.generation === "json" || !String(req.headers.accept).includes("text/event-stream")) {
        return json(200, complete);
      }
      const events = [
        ["status", { stage: "queued" }],
        ["status", { stage: "moderating" }],
        ["heartbeat", { elapsedMs: 10000 }],
        ["status", { stage: "generating", etaSeconds: 24, provider: "openai" }],
        state.generation === "moderation"
          ? ["error", { code: "moderation", message: "Blocked", status: 422, reason: "hate", field: "prompt" }]
          : ["complete", { ...complete, traceId: "trace_1", latencySeconds: 21.4 }],
      ];
      let text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (state.generation === "reset") {
        // The connection breaks after the server accepted the request.
        res.write(`event: status\ndata: ${JSON.stringify({ stage: "generating" })}\n\n`);
        await new Promise((done) => setTimeout(done, 20));
        return res.destroy();
      }
      // The last event loses its closing blank line, as when a proxy cuts the stream.
      if (state.generation === "cut_off") text = text.replace(/\n\n$/, "");
      // Odd-sized chunks split event names, JSON, separators, and multibyte characters.
      const bytes = Buffer.from(text);
      for (let i = 0; i < bytes.length; i += 7) {
        res.write(bytes.subarray(i, i + 7));
        await new Promise((done) => setTimeout(done, 1));
      }
      res.end();
    }
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  // Node 18 runs top-level after() hooks only once the event loop is empty, so
  // a listening server would keep the test process alive forever.
  server.unref();
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: `${origin}/api/v1`,
    requests,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

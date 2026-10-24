import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { main } from "../src/cli.js";
import { IMAGE_BYTES, OTHER_KEY, PRICING, VALID_KEY, startMockServer } from "./mock-server.mjs";

// Top-level await, not before(): Node 18 can run a top-level before() hook
// after the beforeEach() hooks of a describe() suite.
const api = await startMockServer();
let home = "";

after(() => api.close());
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inkstudioai-cli-"));
  api.requests.length = 0;
  api.state.account = "paid";
  api.state.generation = "stream";
  api.state.designSaved = true;
  api.state.imagePath = "/cdn/design.webp";
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/**
 * Run the CLI in process against the mock server.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string>, stdin?: string, apiUrl?: string, now?: number, tty?: boolean }} [options]
 *   `tty` makes stdin and stderr look like a terminal.
 */
async function run(argv, { env = {}, stdin = "", apiUrl, now = 0, tty = false } = {}) {
  let stdout = "";
  let stderr = "";
  const input = Object.assign(Readable.from(stdin ? [stdin] : []), tty ? { isTTY: true } : {});
  /** @type {number[]} */
  const sleeps = [];
  /** @type {string[]} */
  const opened = [];
  const code = await main(argv, {
    env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), INKSTUDIO_API_URL: apiUrl ?? api.url, ...env },
    cwd: home,
    stdin: input,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text), isTTY: tty },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
    open: (target) => opened.push(target),
  });
  return { code, stdout, stderr, sleeps, opened };
}

const TODAY = Date.parse("2026-10-24T10:00:00.000Z");
const configFile = () => join(home, "config", "inkstudioai", "config.json");
const authHeaders = (path) => api.requests.filter((r) => r.path.endsWith(path)).map((r) => r.headers.authorization);

describe("login", () => {
  test("device flow polls through pending and slow_down, then saves the key privately", async () => {
    api.state.tokenAnswers = ["authorization_pending", "slow_down", "authorization_pending", "ok"];
    const result = await run(["login"], { now: TODAY });

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.sleeps, [5000, 5000, 10000, 10000]);
    assert.match(result.stderr, /WDJB-MJHT/);
    assert.match(result.stderr, /free tattoo design/);
    assert.deepEqual(result.opened, [
      "https://inkstudioai.com/cli/authorize?code=WDJB-MJHT&utm_source=cli&utm_medium=referral",
    ]);
    assert.match(result.stdout, /Signed in as ana@example\.com/);
    assert.match(result.stdout, /Active, 8 days left \(ends Nov 1, 10:00 UTC\)/);
    assert.match(result.stdout, /28 \(8 plan, 20 purchased\) for the image tools on the website/);
    assert.doesNotMatch(result.stdout, /less than 2 days/);

    assert.equal(JSON.parse(readFileSync(configFile(), "utf8")).apiKey, VALID_KEY);
    if (process.platform !== "win32") {
      assert.equal(statSync(configFile()).mode & 0o777, 0o600);
      assert.equal(statSync(join(home, "config", "inkstudioai")).mode & 0o777, 0o700);
    }
    const device = api.requests.find((r) => r.path.endsWith("/auth/device"));
    assert.match(device?.body.clientName, /^inkstudioai CLI on /);
    assert.match(String(device?.headers["user-agent"]), /^inkstudioai-cli\/0\.1\.1 \(node \d+/);
  });

  test("a denied request stops polling and saves nothing", async () => {
    api.state.tokenAnswers = ["authorization_pending", "access_denied", "ok"];
    const result = await run(["login", "--no-browser"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /denied/);
    assert.equal(result.sleeps.length, 2);
    assert.deepEqual(result.opened, []);
    assert.equal(existsSync(configFile()), false);
  });

  test("a temporary 502 during polling does not stop the sign-in", async () => {
    api.state.tokenAnswers = ["authorization_pending", "502", "ok"];
    const result = await run(["login", "--no-browser"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.sleeps.length, 3);
    assert.equal(JSON.parse(readFileSync(configFile(), "utf8")).apiKey, VALID_KEY);
  });

  test("--with-key reads stdin and rejects a key the server does not know", async () => {
    const bad = await run(["login", "--with-key"], { stdin: "isk_unknown\n" });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /inkstudioai login/);
    assert.equal(existsSync(configFile()), false);

    const good = await run(["login", "--with-key"], { stdin: `${VALID_KEY}\n` });
    assert.equal(good.code, 0, good.stderr);
    assert.equal(JSON.parse(readFileSync(configFile(), "utf8")).apiKey, VALID_KEY);
  });
});

test("key precedence: --api-key, then INKSTUDIO_API_KEY, then the saved key", async () => {
  await run(["login", "--key", VALID_KEY]);
  api.requests.length = 0;

  await run(["whoami"]);
  await run(["whoami"], { env: { INKSTUDIO_API_KEY: OTHER_KEY } });
  await run(["whoami", "--api-key", VALID_KEY], { env: { INKSTUDIO_API_KEY: OTHER_KEY } });
  assert.deepEqual(authHeaders("/me"), [`Bearer ${VALID_KEY}`, `Bearer ${OTHER_KEY}`, `Bearer ${VALID_KEY}`]);

  const logout = await run(["logout"]);
  assert.equal(logout.code, 0);
  assert.match(logout.stdout, /still works on the server/);
  assert.equal(existsSync(configFile()), false);
});

describe("generate", () => {
  test("streams progress over split SSE chunks and saves the image to --out", async () => {
    const result = await run(
      ["gen", "a fox in a crescent moon, café style", "-s", "fine-line", "--color", "--skin", "-o", "out/"],
      { env: { INKSTUDIO_API_KEY: VALID_KEY } },
    );

    assert.equal(result.code, 0, result.stderr);
    const request = api.requests.find((r) => r.path.endsWith("/generations"));
    assert.equal(request?.headers.accept, "text/event-stream");
    assert.deepEqual(request?.body, {
      prompt: "a fox in a crescent moon, café style",
      style: "fine-line",
      color: true,
      background: "skin",
    });
    const saved = join(home, "out", "a-fox-in-a-crescent-moon-cafe-style.webp");
    assert.deepEqual(readFileSync(saved), IMAGE_BYTES);
    assert.match(result.stdout, /File\s+out[\\/]a-fox-in-a-crescent-moon-cafe-style\.webp/);
    assert.match(result.stdout, /fine-line, color, on skin/);
    assert.match(result.stderr, /Design ready/);
  });

  test("--json prints the complete payload with the saved file, and nothing else", async () => {
    const result = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });

    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.id, "6718f0c2a1b2c3d4e5f60718");
    assert.equal(payload.traceId, "trace_1");
    assert.equal(payload.file, "rose.webp");
    assert.equal(result.stderr, "");
    assert.ok(readdirSync(home).includes("rose.webp"));
  });

  test("--no-save only prints the URL", async () => {
    const result = await run(["generate", "rose", "--no-save"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\/cdn\/design\.webp/);
    assert.ok(!readdirSync(home).some((name) => name.endsWith(".webp")));
  });

  test("402 paywall shows the error, then the plans, and asks nothing off a terminal", async () => {
    api.state.account = "none";
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });

    assert.equal(result.code, 1);
    const error = result.stderr.indexOf("no free design left and no active plan");
    assert.ok(error >= 0, result.stderr);
    assert.ok(error < result.stderr.indexOf("Plans"), "the error comes before the plans");
    for (const plan of PRICING.plans) assert.match(result.stderr, new RegExp(`${plan.sku}\\s+${plan.label}`));
    assert.match(result.stderr, /7-day-access\s+7-Day Access\s+\$12\.99/);
    assert.match(result.stderr, /Buy a plan: inkstudioai buy 7-day-access/);
    assert.doesNotMatch(result.stderr, /\[Y\/n\]/);
    assert.equal(result.stderr.match(/no free design left/g)?.length, 1, "the error is printed once");
    assert.equal(api.requests.filter((r) => r.path.endsWith("/checkout")).length, 0);
    assert.deepEqual(result.opened, []);

    // CI and --json never ask either, even on a terminal.
    const ci = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY, CI: "true" }, tty: true, stdin: "y\n" });
    assert.doesNotMatch(ci.stderr, /\[Y\/n\]/);
    const json = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY }, tty: true });
    assert.equal(JSON.parse(json.stdout).code, "paywall");
    assert.equal(api.requests.filter((r) => r.path.endsWith("/checkout")).length, 0);
  });

  test("402 paywall in a terminal offers checkout for the cheapest plan", async () => {
    api.state.account = "none";
    const env = { INKSTUDIO_API_KEY: VALID_KEY, NO_COLOR: "1" };
    const yes = await run(["generate", "rose"], { env, tty: true, stdin: "\n" });

    assert.equal(yes.code, 1);
    assert.match(yes.stderr, /Open checkout for 7-day-access \(\$12\.99\)\? \[Y\/n\]/);
    assert.deepEqual(api.requests.filter((r) => r.path.endsWith("/checkout")).map((r) => r.body), [{ sku: "7-day-access" }]);
    assert.deepEqual(yes.opened, ["https://checkout.stripe.com/c/pay/cs_test_7-day-access"]);

    api.requests.length = 0;
    const no = await run(["generate", "rose"], { env, tty: true, stdin: "n\n" });
    assert.equal(api.requests.filter((r) => r.path.endsWith("/checkout")).length, 0);
    assert.match(no.stderr, /Buy later: inkstudioai buy 7-day-access/);
  });

  test("401 with a key says it is unknown or revoked", async () => {
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: "isk_revoked" } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown or revoked/);
    // The environment key wins over a new login, so the hint names it.
    assert.match(result.stderr, /Set INKSTUDIO_API_KEY to a valid key/);
  });

  test("no key at all says the user is not signed in", async () => {
    for (const argv of [["generate", "rose"], ["whoami"]]) {
      const result = await run(argv);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /You are not signed in\./);
      assert.match(result.stderr, /Run inkstudioai login to sign in\. New accounts get a free design\./);
      assert.doesNotMatch(result.stderr, /revoked/);
    }
    assert.equal(api.requests.length, 0);
    const json = await run(["whoami", "--json"]);
    assert.equal(JSON.parse(json.stdout).code, "unauthorized");
  });

  test("text output links the saved designs, try-on, and stencil pages with UTM", async () => {
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /Saved to\s+http:\/\/127\.0\.0\.1:\d+\/account\?view=tattoos&utm_source=cli&utm_medium=referral\n/,
    );
    // Links follow the API origin. The mock image is http, which the simulator cannot load, so the plain page is linked.
    assert.match(result.stdout, /Try it on your skin\s+http:\/\/127\.0\.0\.1:\d+\/tools\/try-tattoo\?utm_source=cli/);
    assert.match(result.stdout, /Make a stencil\s+http:\/\/127\.0\.0\.1:\d+\/tools\/tattoo-to-stencil\?utm_source=cli/);
    assert.doesNotMatch(result.stdout, /\/cdn\/design\.webp\?utm|account\/tattoos/);

    const json = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.doesNotMatch(json.stdout, /try-tattoo|utm_source/);
  });

  test("an https design links the simulator with the design loaded", async () => {
    const { default: http } = await import("node:http");
    // A local proxy answers like the API, but with an https image URL; the image is not downloaded.
    const proxy = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "1", imageUrl: "https://cdn.inkstudioai.com/free-tattoo-designs/a b.webp", style: "minimal", tier: "paid" }));
    });
    await new Promise((done) => proxy.listen(0, "127.0.0.1", () => done(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (proxy.address()).port;
    try {
      const result = await run(["generate", "rose", "--no-save"], {
        env: { INKSTUDIO_API_KEY: VALID_KEY },
        apiUrl: `http://127.0.0.1:${port}/api/v1`,
      });
      assert.equal(result.code, 0, result.stderr);
      const link = result.stdout.match(/Try it on your skin\s+(\S+)/)?.[1] ?? "";
      const url = new URL(link);
      assert.equal(url.pathname, "/tools/try-tattoo");
      assert.equal(url.searchParams.get("design"), "https://cdn.inkstudioai.com/free-tattoo-designs/a b.webp");
      assert.equal(url.searchParams.get("utm_source"), "cli");
    } finally {
      await new Promise((done) => proxy.close(done));
    }
  });

  test("a design the server could not save to the account has no Saved to line", async () => {
    api.state.designSaved = false;
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Saved to/);
    assert.match(result.stderr, /not added to your account history/);
  });

  test("a free account shows the free quality and the designs left", async () => {
    api.state.account = "free";
    const status = await run(["whoami"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.match(status.stdout, /Plan\s+No active plan/);
    assert.match(status.stdout, /Free designs\s+1/);
    assert.match(status.stdout, /Next design\s+Free quality/);

    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Quality\s+free \(0 free designs left\)/);
    assert.match(result.stderr, /That was your free design\..*inkstudioai pricing/);
    const json = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(JSON.parse(json.stdout).freeGenerationsRemaining, 0);
  });

  test("a moderation error in the stream shows the reason", async () => {
    api.state.generation = "moderation";
    const result = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "moderation");
    assert.equal(payload.reason, "hate");
    assert.match(payload.error, /hateful content/);
  });

  test("429 shows when to retry", async () => {
    api.state.generation = "rate_limited";
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Try again in 42 seconds/);
  });

  test("a stream reset after the server accepted the request points to the saved designs, not a retry", async () => {
    api.state.generation = "reset";
    const result = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /connection closed before the design was ready/);
    assert.match(result.stderr, /inkstudioai designs/);
    assert.doesNotMatch(result.stderr, /try again|Could not reach/i);
  });

  test("a stream that ends without a complete event is not a finished design", async () => {
    // The complete event arrives without its closing blank line, so it was cut off.
    api.state.generation = "cut_off";
    const result = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });

    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.code, "stream_closed");
    assert.ok(payload.hints.some((/** @type {string} */ hint) => hint.includes("inkstudioai designs")));
    assert.ok(!readdirSync(home).some((name) => name.endsWith(".webp")));
  });

  test("a failed download after the design is made exits 3 and keeps the result in --json", async () => {
    api.state.imagePath = "/cdn/missing.webp";
    const result = await run(["generate", "rose", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });

    assert.equal(result.code, 3);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.imageUrl, /\/cdn\/missing\.webp$/);
    assert.equal(payload.id, "6718f0c2a1b2c3d4e5f60718");
    assert.equal(payload.file, null);
    assert.match(payload.saveError, /HTTP 404/);

    const text = await run(["generate", "rose"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(text.code, 3);
    assert.match(text.stdout, /Image\s+http:\/\/127\.0\.0\.1:\d+\/cdn\/missing\.webp/);
    assert.match(text.stderr, /Could not save the image: HTTP 404/);
  });

  test("-o does not overwrite a file without --force, and fixes a wrong extension", async () => {
    const env = { INKSTUDIO_API_KEY: VALID_KEY };
    writeFileSync(join(home, "lotus.webp"), "keep me");
    const refused = await run(["generate", "lotus", "-o", "lotus.webp"], { env });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /lotus\.webp already exists\. Use --force/);
    assert.equal(readFileSync(join(home, "lotus.webp"), "utf8"), "keep me");
    assert.equal(api.requests.length, 0, "no generation is used");

    const forced = await run(["generate", "lotus", "-o", "lotus.webp", "--force"], { env });
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(readFileSync(join(home, "lotus.webp")), IMAGE_BYTES);

    // lotus.png would be saved as lotus.webp, which exists: refuse before the generation.
    const before = api.requests.length;
    const renamed = await run(["generate", "lotus", "-o", "lotus.png", "--json"], { env });
    assert.equal(renamed.code, 2);
    assert.match(JSON.parse(renamed.stdout).error, /lotus\.webp already exists/);
    assert.equal(api.requests.length, before, "no generation is used");
    assert.equal(existsSync(join(home, "lotus.png")), false);

    const fresh = await run(["generate", "lotus", "-o", "art/lotus.png"], { env });
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, /File\s+art[\\/]lotus\.webp/);
    assert.match(fresh.stderr, /ends in \.webp/);
  });

  test("a missing prompt is a usage error", async () => {
    const result = await run(["generate"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
    assert.equal(result.code, 2);
    assert.equal(api.requests.length, 0);
  });
});

test("gallery works without a key and prints the site URL", async () => {
  const result = await run(["gallery", "dragon", "--limit", "5"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /dragon wrapped around a dagger/);
  assert.match(result.stdout, /https:\/\/inkstudioai\.com\/tattoos\/dragon-dagger\?utm_source=cli&utm_medium=referral/);
  assert.doesNotMatch(result.stdout, /design\.webp\?utm/);
  assert.match(result.stdout, /inkstudioai gallery dragon --page 2/);
  assert.deepEqual(authHeaders("/gallery"), [undefined]);
});

test("buy prints the checkout URL and INKSTUDIO_NO_BROWSER keeps the browser closed", async () => {
  const env = { INKSTUDIO_API_KEY: VALID_KEY };
  const quiet = await run(["buy", "7-day-access"], { env: { ...env, INKSTUDIO_NO_BROWSER: "1" } });
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.match(quiet.stdout, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_7-day-access/);
  assert.deepEqual(quiet.opened, []);

  const opened = await run(["buy", "7-day-access"], { env });
  assert.deepEqual(opened.opened, ["https://checkout.stripe.com/c/pay/cs_test_7-day-access"]);

  const unknown = await run(["buy", "lifetime"], { env });
  assert.equal(unknown.code, 1);
  // Commands in messages are formatted like hints, without raw backticks.
  assert.match(unknown.stderr, /Unknown sku "lifetime"\. Run inkstudioai pricing/);
  assert.doesNotMatch(unknown.stderr, /`/);
});

test("a credit pack without a plan answers plan_required", async () => {
  api.state.account = "free";
  const result = await run(["buy", "credits-20"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Credit packs need an active plan/);
  assert.match(result.stderr, /Run inkstudioai pricing/);
  assert.deepEqual(result.opened, []);

  const json = await run(["buy", "credits-20", "--json"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.code, "plan_required");
  assert.equal(payload.status, 403);

  api.state.account = "paid";
  const paid = await run(["buy", "credits-20", "--no-browser"], { env: { INKSTUDIO_API_KEY: VALID_KEY } });
  assert.equal(paid.code, 0, paid.stderr);
});

test("pricing lists the catalog and links the pricing page with UTM", async () => {
  const result = await run(["pricing"]);
  assert.equal(result.code, 0, result.stderr);
  for (const item of [...PRICING.plans, ...PRICING.creditPacks]) {
    assert.match(result.stdout, new RegExp(`${item.sku}\\s+${item.label}\\s+\\$${item.priceUsd}`));
  }
  assert.match(result.stdout, /Compare plans: https:\/\/inkstudioai\.com\/pricing\?utm_source=cli&utm_medium=referral/);
});

test("whoami warns when the plan ends in less than 2 days", async () => {
  const env = { INKSTUDIO_API_KEY: VALID_KEY };
  const result = await run(["whoami"], { env, now: Date.parse("2026-10-31T09:00:00.000Z") });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Active, 1 day left \(ends Nov 1, 10:00 UTC\)/);
  assert.match(result.stdout, /less than 2 days.*inkstudioai buy <sku>/);

  const lastDay = await run(["whoami"], { env, now: Date.parse("2026-11-01T05:30:00.000Z") });
  assert.match(lastDay.stdout, /Active, 5 hours left/);
});

test("an unreachable server gives a clear network error", async () => {
  const result = await run(["styles"], { apiUrl: "http://127.0.0.1:9/api/v1" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Could not reach http:\/\/127\.0\.0\.1:9/);
});

test("usage errors are JSON with --json, and `help` shows the help", async () => {
  const missing = await run(["generate", "--json"]);
  assert.equal(missing.code, 2);
  assert.deepEqual(Object.keys(JSON.parse(missing.stdout)).sort(), ["code", "error", "hints"]);
  assert.equal(JSON.parse(missing.stdout).code, "usage");
  assert.equal(missing.stderr, "");

  const badOption = await run(["--json", "styles", "--bogus"]);
  assert.equal(badOption.code, 2);
  assert.equal(JSON.parse(badOption.stdout).code, "usage");

  const unknown = await run(["frobnicate", "--json"]);
  assert.equal(unknown.code, 2);
  assert.match(JSON.parse(unknown.stdout).error, /Unknown command "frobnicate"/);

  const help = await run(["help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage {2}inkstudioai <command>/);
  const genHelp = await run(["help", "gen"]);
  assert.match(genHelp.stdout, /Usage {2}inkstudioai generate/);
});

test("only web URLs open in the browser, and buy --json opens nothing", async () => {
  const env = { INKSTUDIO_API_KEY: VALID_KEY };
  const json = await run(["buy", "7-day-access", "--json"], { env });
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(json.opened, []);

  // A server that answers with another scheme gets no browser.
  const local = await run(["open", "account"], { apiUrl: "http://127.0.0.1:9/api/v1" });
  assert.deepEqual(local.opened, ["http://127.0.0.1:9/account?utm_source=cli&utm_medium=referral"]);
  // The key would travel unencrypted, so a plain http API URL is refused.
  const plain = await run(["open", "account"], { apiUrl: "http://example.com/api/v1" });
  assert.equal(plain.code, 2);
  assert.deepEqual(plain.opened, []);
  assert.match(plain.stderr, /INKSTUDIO_API_URL must use https/);
});

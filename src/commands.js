import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { ApiError, USER_AGENT, describeError, notSignedIn } from "./api.js";
import { configPath, deleteConfig, readConfig, withUtm, writeConfig } from "./config.js";
import { columns, formatDate, formatElapsed, formatHint, formatPlanEnd, formatPrice, truncate } from "./ui.js";

/** @typedef {import("./cli.js").Context} Context */

export class UsageError extends Error {}

const SAMPLE_PROMPT = "a fox in a crescent moon";

/**
 * @typedef {{
 *   summary: string,
 *   usage: string,
 *   description?: string,
 *   options?: Record<string, { type: "string" | "boolean", short?: string }>,
 *   optionHelp?: [string, string][],
 *   examples?: string[],
 *   group: "start" | "designs" | "account" | "agents",
 *   run: (ctx: Context) => Promise<void>,
 * }} Command
 */

/** @type {Record<string, Command>} */
export const COMMANDS = {
  login: {
    group: "start",
    summary: "Sign in or create an account. New accounts get a free design.",
    usage: "login [--key <isk_...> | --with-key] [--no-browser]",
    description:
      "Opens the browser to sign in. Approve the code shown in the terminal, and the CLI saves an API key on this computer. No account yet? Create one on the same page. New accounts get one free tattoo design.",
    options: {
      key: { type: "string" },
      "with-key": { type: "boolean" },
      "no-browser": { type: "boolean" },
    },
    optionHelp: [
      ["--key <isk_...>", "Save a key from your account page instead"],
      ["--with-key", "Read the key from stdin (in a terminal, paste it and press Enter)"],
      ["--no-browser", "Print the link but do not open a browser"],
    ],
    examples: ["inkstudioai login", "echo $KEY | inkstudioai login --with-key"],
    run: login,
  },
  logout: {
    group: "account",
    summary: "Remove the saved API key from this computer",
    usage: "logout",
    run: logout,
  },
  whoami: {
    group: "account",
    summary: "Show your plan, free designs, credits, and usage today",
    usage: "whoami",
    run: whoami,
  },
  generate: {
    group: "start",
    summary: "Create a tattoo design from a text prompt",
    usage: "generate <prompt...> [options]",
    description:
      "Creates a design and saves the image in the current directory. The design is also saved privately to your account.",
    options: {
      style: { type: "string", short: "s" },
      color: { type: "boolean", short: "c" },
      skin: { type: "boolean" },
      negative: { type: "string" },
      out: { type: "string", short: "o" },
      force: { type: "boolean" },
      "no-save": { type: "boolean" },
      open: { type: "boolean" },
    },
    optionHelp: [
      ["-s, --style <id>", "Style id, see `inkstudioai styles` (default: minimal)"],
      ["-c, --color", "Color ink instead of black ink"],
      ["--skin", "Show the design on skin instead of a white background"],
      ["--negative <text>", "Things to leave out of the design"],
      ["-o, --out <path>", "File or directory for the image"],
      ["--force", "Overwrite the --out file if it exists"],
      ["--no-save", "Do not download the image, only print its URL"],
      ["--open", "Open the image when it is ready"],
    ],
    examples: [
      `inkstudioai generate "${SAMPLE_PROMPT}" --style fine-line`,
      'inkstudioai gen "koi fish with waves" -s japanese --color -o designs/',
      'inkstudioai gen "rose and dagger" --skin --open',
    ],
    run: generate,
  },
  styles: {
    group: "designs",
    summary: "List the style ids",
    usage: "styles",
    run: styles,
  },
  designs: {
    group: "designs",
    summary: "List the designs saved to your account",
    usage: "designs [--limit <n>] [--page <n>]",
    options: { limit: { type: "string" }, page: { type: "string" } },
    optionHelp: [
      ["--limit <n>", "Designs per page, 1 to 50 (default: 20)"],
      ["--page <n>", "Page number (default: 1)"],
    ],
    run: designs,
  },
  gallery: {
    group: "designs",
    summary: "Search the public gallery for ideas (no login needed)",
    usage: "gallery [query...] [--limit <n>] [--page <n>]",
    options: { limit: { type: "string" }, page: { type: "string" } },
    optionHelp: [
      ["--limit <n>", "Designs per page, 1 to 50 (default: 12)"],
      ["--page <n>", "Page number (default: 1)"],
    ],
    examples: ["inkstudioai gallery dragon", "inkstudioai gallery minimalist wave --limit 5"],
    run: gallery,
  },
  pricing: {
    group: "account",
    summary: "Show plans and credit packs",
    usage: "pricing",
    run: pricing,
  },
  buy: {
    group: "account",
    summary: "Buy a plan or credit pack with Stripe checkout",
    usage: "buy <sku> [--no-browser]",
    description: "Opens Stripe checkout in the browser. The purchase is added to the signed-in account.",
    options: { "no-browser": { type: "boolean" } },
    optionHelp: [["--no-browser", "Print the checkout link but do not open it"]],
    examples: ["inkstudioai buy 7-day-access"],
    run: buy,
  },
  open: {
    group: "account",
    summary: "Open the website (account, pricing, or developers)",
    usage: "open [account|pricing|developers]",
    run: openSite,
  },
  mcp: {
    group: "agents",
    summary: "Run an MCP server over stdio for Claude, Cursor, and other agents",
    usage: "mcp",
    description:
      "Starts a Model Context Protocol server on stdin and stdout. To sign in, ask the agent to use the login tool, run `inkstudioai login` first, or set INKSTUDIO_API_KEY in the client config.",
    examples: ["claude mcp add inkstudioai -- npx -y inkstudioai mcp"],
    run: async (ctx) => {
      const { runMcpServer } = await import("./mcp.js");
      await runMcpServer(ctx.io, ctx.apiKeyFlag);
    },
  },
};

export const ALIASES = /** @type {Record<string, string>} */ ({ gen: "generate", status: "whoami" });

/* ------------------------------------------------------------------ login */

/** @param {Context} ctx */
async function login(ctx) {
  const { values, io } = ctx;
  let key = /** @type {string | undefined} */ (values.key);
  if (values["with-key"]) {
    const terminal = Boolean(/** @type {{ isTTY?: boolean }} */ (io.stdin).isTTY);
    if (terminal) ctx.note("Paste your API key, then press Enter:");
    key = ((terminal ? await readLine(io.stdin) : await readStream(io.stdin)) ?? "").trim();
  }
  if (key !== undefined) {
    if (!key.startsWith("isk_")) {
      throw new UsageError(`API keys start with "isk_". Create one at ${ctx.link("/account?view=api-keys")}`);
    }
    const me = await ctx.client(key).me();
    const file = writeConfig(io.env, { apiKey: key, email: me.email, savedAt: new Date().toISOString() });
    return finishLogin(ctx, me, file, key);
  }

  const client = ctx.client();
  const start = await client.startDeviceLogin(`inkstudioai CLI on ${hostname()}`.slice(0, 80));
  const { e } = ctx;
  const verifyUrl = withUtm(start.verificationUrlComplete ?? start.verificationUrl, "cli");
  ctx.note(
    [
      "",
      `  ${e.bold("Sign in to Ink Studio AI")}`,
      "",
      `  Code   ${e.bold(e.yellow(start.userCode))}`,
      `  Link   ${e.cyan(verifyUrl)}`,
      "",
      `  Check that the page shows the same code, then approve.`,
      `  ${e.dim("New here? Create an account on that page. New accounts get one free tattoo design.")}`,
      "",
    ].join("\n"),
  );
  ctx.openUrl(verifyUrl);

  const spinner = ctx.spinner();
  spinner.start(`Waiting for approval in the browser ${e.dim("(Ctrl+C to cancel)")}`, "Waiting for approval in the browser...");
  let result;
  try {
    result = await pollForKey(ctx, client, start);
  } finally {
    spinner.stop();
  }
  const file = writeConfig(io.env, {
    apiKey: result.apiKey,
    keyId: result.keyId,
    email: result.email,
    savedAt: new Date().toISOString(),
  });
  const me = await ctx.client(result.apiKey).me();
  finishLogin(ctx, me, file, result.apiKey);
}

/**
 * Poll /auth/token per RFC 8628: wait `interval`, add 5 s on slow_down.
 * Network errors and server errors (5xx) are temporary, so polling goes on
 * until the code expires.
 * @param {Context} ctx
 * @param {import("./api.js").Client} client
 * @param {{ deviceCode: string, interval?: number, expiresIn?: number }} start
 */
async function pollForKey(ctx, client, start) {
  let interval = Math.max(1, start.interval || 5) * 1000;
  const deadline = ctx.io.now() + (start.expiresIn ?? 600) * 1000;
  while (ctx.io.now() < deadline) {
    await ctx.io.sleep(interval);
    try {
      return await client.pollDeviceLogin(start.deviceCode);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status >= 500) continue;
      switch (error.code) {
        case "authorization_pending":
        case "network":
          break;
        case "slow_down":
        case "rate_limited":
          interval += 5000;
          break;
        case "access_denied":
          throw new ApiError("The sign-in request was denied in the browser.", { code: error.code });
        case "expired_token":
          throw new ApiError("The code expired. Run `inkstudioai login` again.", { code: error.code });
        default:
          throw error;
      }
    }
  }
  throw new ApiError("The code expired. Run `inkstudioai login` again.", { code: "expired_token" });
}

/** @param {Context} ctx @param {any} me @param {string} file @param {string} key */
function finishLogin(ctx, me, file, key) {
  if (ctx.json) return ctx.printJson({ saved: file, account: me });
  const { c } = ctx;
  ctx.print(`${c.green("✔")} Signed in as ${c.bold(me.email)}`);
  ctx.print(c.dim(`  Key saved to ${tildify(file, ctx.io.env)}`));
  if (ctx.io.env.INKSTUDIO_API_KEY) {
    ctx.print(c.yellow("  INKSTUDIO_API_KEY is set in this shell and takes precedence over the saved key."));
  }
  ctx.print("");
  printAccount(ctx, me, { key, source: "file" });
  ctx.print("");
  if (me.generation?.canGenerate) {
    ctx.print(`Next: ${c.cyan(`inkstudioai generate "${SAMPLE_PROMPT}"`)}`);
  } else {
    ctx.print(`Next: ${c.cyan("inkstudioai pricing")} to pick a plan`);
  }
}

/** @param {Context} ctx */
async function logout(ctx) {
  const { io, c } = ctx;
  const file = configPath(io.env);
  const had = Boolean(readConfig(io.env).apiKey);
  deleteConfig(io.env);
  if (ctx.json) return ctx.printJson({ removed: had, path: file });
  if (!had) {
    ctx.print("No saved key on this computer.");
  } else {
    ctx.print(`${c.green("✔")} Removed the saved key from ${tildify(file, io.env)}`);
    ctx.print(
      `  The key still works on the server. Revoke it at ${c.cyan(ctx.link("/account?view=api-keys"))}`,
    );
  }
  if (io.env.INKSTUDIO_API_KEY) {
    ctx.print(c.yellow("  INKSTUDIO_API_KEY is still set in this shell."));
  }
}

/* ---------------------------------------------------------------- account */

/** @param {Context} ctx */
async function whoami(ctx) {
  const me = await ctx.client().me();
  if (ctx.json) return ctx.printJson(me);
  printAccount(ctx, me, ctx.apiKey);
}

/**
 * @param {Context} ctx @param {any} me
 * @param {import("./config.js").ResolvedKey} apiKey
 */
function printAccount(ctx, me, { key, source }) {
  const { c } = ctx;
  const credits = me.premiumCredits ?? {};
  const generation = me.generation ?? {};
  const limitReached = generation.dailyLimit !== undefined && (generation.usedToday ?? 0) >= generation.dailyLimit;
  const next = !generation.canGenerate
    ? generation.tier && limitReached
      ? `${c.yellow("Daily API limit reached.")} Try again tomorrow (UTC) or use ${ctx.link("")}`
      : `${c.yellow("No access.")} Run ${c.cyan("inkstudioai pricing")}`
    : generation.tier === "free"
      ? `${c.green("Free quality")} ${c.dim("(uses your free design)")}`
      : c.green("Paid quality");
  const sourceLabel = { flag: "--api-key", env: "INKSTUDIO_API_KEY", file: "config file" }[source ?? "file"];
  const left = me.plan?.active ? timeLeft(me.plan.expiresOn, ctx.io.now()) : undefined;
  ctx.print(
    columns([
      [c.dim("Account"), `${c.bold(me.email)}${me.name ? c.dim(` (${me.name})`) : ""}`],
      [
        c.dim("Plan"),
        !me.plan?.active
          ? c.yellow("No active plan")
          : left
            ? `${c.green("Active")}, ${left.text} ${c.dim(`(ends ${formatPlanEnd(me.plan.expiresOn, ctx.io.now())})`)}`
            : c.green("Active"),
      ],
      [c.dim("Free designs"), String(me.freeGenerations ?? 0)],
      [
        c.dim("Premium credits"),
        `${credits.total ?? 0} ${c.dim(`(${credits.plan ?? 0} plan, ${credits.purchased ?? 0} purchased) for the image tools on the website`)}`,
      ],
      [c.dim("Designs made"), String(me.designsGenerated ?? 0)],
      [
        c.dim("API today"),
        `${generation.usedToday ?? 0} of ${generation.dailyLimit ?? "?"} generations`,
      ],
      [c.dim("Next design"), next],
      [c.dim("API key"), `${key ? `${key.slice(0, 12)}…` : ""} ${c.dim(`(${sourceLabel})`)}`],
    ]),
  );
  if (left?.soon) {
    ctx.print(
      `\n${c.yellow("Your plan ends in less than 2 days.")} Extend it: ${c.cyan("inkstudioai buy <sku>")} ${c.dim("(inkstudioai pricing lists the skus)")}`,
    );
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * "8 days left", or hours on the last day. `soon` is true under 2 days.
 * @param {string | null | undefined} iso @param {number} now
 */
function timeLeft(iso, now) {
  const end = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(end)) return undefined;
  const ms = end - now;
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.max(1, Math.ceil(ms / HOUR_MS));
  const text = days >= 1 ? `${days} ${days === 1 ? "day" : "days"} left` : `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  return { text, soon: ms < 2 * DAY_MS };
}

/** @param {Context} ctx */
async function pricing(ctx) {
  const data = await ctx.client().pricing();
  if (ctx.json) return ctx.printJson(data);
  printPricing(ctx, data);
  ctx.print("");
  const compare = data.pricingUrl ? withUtm(data.pricingUrl, "cli") : ctx.link("/pricing");
  ctx.print(`Buy: ${ctx.c.cyan("inkstudioai buy <sku>")}   Compare plans: ${ctx.c.cyan(compare)}`);
}

/**
 * @param {Context} ctx @param {any} data
 * @param {(text: string) => void} [write]
 * @param {import("./ui.js").Colors} [c]
 */
function printPricing(ctx, data, write = ctx.print, c = ctx.c) {
  const plans = (data.plans ?? []).map((/** @type {any} */ plan) => [
    c.bold(plan.sku),
    plan.label,
    formatPrice(plan.priceUsd),
    c.dim(`${plan.durationDays} days, ${plan.premiumCredits} premium credits`),
  ]);
  const packs = (data.creditPacks ?? []).map((/** @type {any} */ pack) => [
    c.bold(pack.sku),
    pack.label,
    formatPrice(pack.priceUsd),
    c.dim(`${pack.credits} premium credits`),
  ]);
  const table = columns([...plans, ...packs], "  ").split("\n");
  write(c.bold("Plans"));
  write(table.slice(0, plans.length).join("\n"));
  if (packs.length) {
    write("");
    write(`${c.bold("Credit packs")} ${c.dim("(need an active plan)")}`);
    write(table.slice(plans.length).join("\n"));
  }
  write("");
  write(
    c.dim("A plan gives unlimited text-to-tattoo designs (50 a day through the API) and premium credits for the image tools on the website."),
  );
}

/** @param {Context} ctx */
async function buy(ctx) {
  const sku = ctx.positionals[0];
  if (!sku) {
    await pricing(ctx);
    if (!ctx.json) ctx.print(`\nUsage: ${ctx.c.cyan("inkstudioai buy <sku>")}`);
    return;
  }
  await checkout(ctx, sku);
}

/** Create a Stripe checkout and open it. @param {Context} ctx @param {string} sku */
async function checkout(ctx, sku) {
  let result;
  try {
    result = await ctx.client().checkout(sku);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "validation" || error.code === "not_found")) {
      throw new ApiError(`Unknown sku "${sku}". Run \`inkstudioai pricing\` to see the skus.`, {
        status: error.status,
        code: error.code,
        body: error.body,
      });
    }
    throw error;
  }
  if (ctx.json) return ctx.printJson(result);
  const opened = ctx.openUrl(result.url);
  const { c } = ctx;
  ctx.print(opened ? "Opening Stripe checkout in your browser:" : "Open this link to pay with Stripe:");
  ctx.print(`  ${c.cyan(result.url)}`);
  ctx.print(c.dim(`After payment, run ${c.cyan("inkstudioai whoami")} to see your plan and credits.`));
}

const SITE_PAGES = /** @type {Record<string, string>} */ ({
  account: "/account",
  pricing: "/pricing",
  developers: "/developers",
});

/** @param {Context} ctx */
async function openSite(ctx) {
  const page = ctx.positionals[0];
  if (page && !(page in SITE_PAGES)) {
    throw new UsageError(`Unknown page "${page}". Use account, pricing, or developers.`);
  }
  const url = ctx.link(page ? SITE_PAGES[page] : "");
  ctx.openUrl(url);
  if (ctx.json) return ctx.printJson({ url });
  ctx.print(ctx.c.cyan(url));
}

/* ---------------------------------------------------------------- designs */

const STAGES = /** @type {Record<string, string>} */ ({
  queued: "Waiting in line",
  moderating: "Checking the prompt",
  generating: "Drawing the design",
  uploading: "Uploading the image",
  saving: "Saving to your account",
  done: "Finishing",
});

/** @param {Context} ctx */
async function generate(ctx) {
  const { values, c, e } = ctx;
  const prompt = ctx.positionals.join(" ").trim();
  if (!prompt) throw new UsageError("Write a prompt, for example: inkstudioai generate \"" + SAMPLE_PROMPT + "\"");
  if (prompt.length > 4000) throw new UsageError("The prompt can have at most 4000 characters.");
  const body = {
    prompt,
    style: values.style,
    color: values.color ? true : undefined,
    background: values.skin ? "skin" : undefined,
    negativePrompt: values.negative,
  };

  const out = /** @type {string | undefined} */ (values.out);
  const force = Boolean(values.force);
  if (out && !values["no-save"] && !force) {
    // Fail before the generation is used. The extension can still change after the download.
    const target = resolve(ctx.io.cwd, out);
    const given = extname(target);
    // The saved name can take the server's image extension, so check those names too.
    const candidates = IMAGE_EXTENSION.test(given)
      ? [".webp", ".png", ".jpg", ".jpeg"].map((ext) => target.slice(0, -given.length) + ext)
      : [target];
    const taken = given ? candidates.find((file) => existsSync(file) && !statSync(file).isDirectory()) : undefined;
    if (taken) {
      throw new UsageError(
        `${relativeTo(ctx.io.cwd, taken)} already exists. Use --force to overwrite it, or choose another --out.`,
      );
    }
  }
  if (!ctx.apiKey.key) throw notSignedIn();

  const started = ctx.io.now();
  let stage = "Sending the prompt";
  /** @type {number | undefined} */
  let eta;
  const spinner = ctx.spinner();
  spinner.start(() => {
    const time = formatElapsed(ctx.io.now() - started) + (eta ? ` of ~${eta}s` : "");
    return `${stage} ${e.dim(time)}`;
  }, "Generating the design...");

  let result;
  try {
    result = await ctx.client().generate(body, {
      onEvent(event) {
        if (event.event !== "status") return;
        stage = STAGES[event.data?.stage] ?? stage;
        if (event.data?.etaSeconds) eta = Math.round(event.data.etaSeconds);
      },
    });
  } catch (error) {
    spinner.stop();
    if (error instanceof ApiError && error.code === "paywall" && !ctx.json) {
      await offerPlan(ctx, error);
      ctx.exitCode = 1;
      return;
    }
    if (error instanceof ApiError && error.code === "validation" && /unknown style/i.test(error.message)) {
      throw new ApiError(`Unknown style "${values.style}". Run \`inkstudioai styles\` to see the style ids.`, {
        status: error.status,
        code: error.code,
        body: error.body,
      });
    }
    throw error;
  }
  spinner.stop(ctx.json ? undefined : `${e.green("✔")} Design ready in ${formatElapsed(ctx.io.now() - started)}`);

  /** @type {{ file: string, renamed: boolean } | undefined} */
  let saved;
  /** @type {string | undefined} */
  let saveError;
  if (!values["no-save"]) {
    try {
      saved = await saveImage(result.imageUrl, out, prompt, ctx.io.cwd, force);
    } catch (error) {
      saveError = `Could not save the image: ${/** @type {Error} */ (error).message}`;
      // The design exists and used a generation; exit 3 tells scripts not to retry.
      ctx.exitCode = 3;
    }
  }
  const file = saved?.file;
  if (values.open) {
    if (file) ctx.openFile(resolve(ctx.io.cwd, file));
    else ctx.openUrl(result.imageUrl);
  }

  if (ctx.json) {
    if (saveError) return ctx.printJson({ ...result, file: null, saveError });
    return ctx.printJson(file ? { ...result, file } : result);
  }
  const look = [
    result.style,
    result.color ? "color" : "black ink",
    result.background === "skin" ? "on skin" : "white background",
  ].join(", ");
  /** @type {string[][]} */
  const rows = [];
  if (file) rows.push([c.dim("File"), c.bold(file)]);
  rows.push([c.dim("Image"), c.cyan(result.imageUrl)]);
  rows.push([c.dim("Style"), look]);
  rows.push([
    c.dim("Quality"),
    result.tier === "free"
      ? `free ${c.dim(`(${result.freeGenerationsRemaining ?? 0} free designs left)`)}`
      : String(result.tier ?? ""),
  ]);
  // id is null when the server made the image but could not add it to the account history.
  if (result.id) rows.push([c.dim("Saved to"), ctx.link("/account?view=tattoos")]);
  ctx.print(columns(rows));
  // The simulator loads a linked design from an https URL; other URLs get the plain page.
  const tryOn = result.imageUrl.startsWith("https://")
    ? `/tools/try-tattoo?design=${encodeURIComponent(result.imageUrl)}`
    : "/tools/try-tattoo";
  ctx.print("");
  ctx.print(
    columns([
      [c.dim("Try it on your skin"), c.cyan(ctx.link(tryOn))],
      [c.dim("Make a stencil"), c.cyan(ctx.link("/tools/tattoo-to-stencil"))],
    ]),
  );
  if (!result.id) {
    ctx.note(e.dim("The design was not added to your account history. Keep the image link."));
  }
  if (saved?.renamed) {
    ctx.note(e.dim(`The server sent a ${extname(saved.file)} image, so the file name ends in ${extname(saved.file)}.`));
  }
  if (saveError) {
    ctx.note(`${e.red("✖")} ${saveError}`);
    ctx.note(
      result.id
        ? "  The design is saved to your account. Download it from the image link above."
        : "  Download it from the image link above.",
    );
  }
  if (result.tier === "free" && !result.freeGenerationsRemaining) {
    ctx.note(
      `\n${e.yellow("That was your free design.")} Get a plan for more: ${e.cyan("inkstudioai pricing")}`,
    );
  }
}

/**
 * The error first, then the plans. In an interactive terminal, offer checkout
 * for the cheapest plan.
 * @param {Context} ctx @param {ApiError} error
 */
async function offerPlan(ctx, error) {
  const { e } = ctx;
  const { message, hints } = describeError(error, ctx.link(""), ctx.apiKey?.source);
  ctx.note(`${e.red("✖")} ${message}`);
  let data;
  try {
    data = await ctx.client().pricing();
  } catch {
    for (const hint of hints) ctx.note(`  ${formatHint(hint, e)}`);
    return;
  }
  ctx.note("");
  printPricing(ctx, data, ctx.note, e);
  ctx.note("");
  /** @type {any} */
  const plan = [...(data.plans ?? [])].sort((a, b) => a.priceUsd - b.priceUsd)[0];
  if (!plan) return;
  if (!canAsk(ctx)) {
    ctx.note(`Buy a plan: ${e.cyan(`inkstudioai buy ${plan.sku}`)}`);
    return;
  }
  ctx.io.stderr.write(`Open checkout for ${e.bold(plan.sku)} (${formatPrice(plan.priceUsd)})? [Y/n] `);
  const answer = await readLine(ctx.io.stdin);
  if (answer !== undefined && /^\s*(y|yes)?\s*$/i.test(answer)) {
    await checkout(ctx, plan.sku);
  } else {
    ctx.note(`${answer === undefined ? "\n" : ""}Buy later: ${e.cyan(`inkstudioai buy ${plan.sku}`)}`);
  }
}

/** A person at a terminal can answer a question; scripts, --json, and CI cannot. @param {Context} ctx */
function canAsk(ctx) {
  const { env } = ctx.io;
  const ci = Boolean(env.CI) && env.CI !== "false" && env.CI !== "0";
  const tty = /** @type {{ isTTY?: boolean }} */ (ctx.io.stdin).isTTY && ctx.io.stderr.isTTY;
  return Boolean(tty) && !ctx.json && !ci;
}

/** @param {Context} ctx */
async function styles(ctx) {
  const data = await ctx.client().styles();
  if (ctx.json) return ctx.printJson(data);
  const { c } = ctx;
  ctx.print(
    columns(
      (data.styles ?? []).map((/** @type {any} */ style) => [
        c.bold(style.id),
        style.label,
        style.colorOptional === false ? c.dim("black ink only") : "",
      ]),
    ),
  );
  ctx.print(`\nUse one: ${c.cyan(`inkstudioai generate "${SAMPLE_PROMPT}" --style <id>`)}`);
}

/** @param {Context} ctx */
async function designs(ctx) {
  const query = { page: intOption(ctx, "page", 1, Infinity), limit: intOption(ctx, "limit", 20, 50) };
  const data = await ctx.client().designs(query);
  if (ctx.json) return ctx.printJson(data);
  const { c } = ctx;
  if (!data.designs?.length) {
    ctx.print(
      data.page > 1
        ? "No designs on this page."
        : `No designs yet. Create one: ${c.cyan(`inkstudioai generate "${SAMPLE_PROMPT}"`)}`,
    );
    return;
  }
  const width = promptWidth(ctx, 30);
  ctx.print(
    columns(
      data.designs.flatMap((/** @type {any} */ design) => [
        [c.dim(formatDate(design.createdAt)), c.bold(design.style ?? ""), truncate(design.prompt ?? "", width)],
        ["", "", c.cyan(design.imageUrl)],
      ]),
    ),
  );
  printPageFooter(ctx, data, "designs", "");
}

/** @param {Context} ctx */
async function gallery(ctx) {
  const q = ctx.positionals.join(" ").trim() || undefined;
  const query = { q, page: intOption(ctx, "page", 1, Infinity), limit: intOption(ctx, "limit", 12, 50) };
  const data = await ctx.client().gallery(query);
  if (ctx.json) return ctx.printJson(data);
  const { c } = ctx;
  if (!data.designs?.length) {
    ctx.print(q ? `No gallery designs match "${q}".` : "The gallery is empty.");
    return;
  }
  const width = promptWidth(ctx, 18);
  ctx.print(
    columns(
      data.designs.flatMap((/** @type {any} */ design) => [
        [c.bold(design.style ?? ""), truncate(design.prompt ?? "", width)],
        ["", c.cyan(design.url ? withUtm(design.url, "cli") : design.imageUrl)],
      ]),
    ),
  );
  printPageFooter(ctx, data, "gallery", q ? ` ${quoteArg(q)}` : "");
  ctx.print(c.dim(`Make your own: inkstudioai generate "<your idea>"`));
}

/**
 * @param {Context} ctx
 * @param {{ page: number, limit: number, total?: number, hasMore?: boolean, designs: unknown[] }} data
 * @param {string} command @param {string} args
 */
function printPageFooter(ctx, data, command, args) {
  const { c } = ctx;
  const first = (data.page - 1) * data.limit + 1;
  const last = first + data.designs.length - 1;
  const total = data.total === undefined ? "" : ` of ${data.total}`;
  const limit = ctx.values.limit === undefined ? "" : ` --limit ${data.limit}`;
  const next = data.hasMore
    ? `  Next page: ${c.cyan(`inkstudioai ${command}${args} --page ${data.page + 1}${limit}`)}`
    : "";
  ctx.print(`\n${c.dim(`${first}-${last}${total}`)}${next}`);
}

/* ---------------------------------------------------------------- helpers */

/** @param {Context} ctx @param {string} name @param {number} fallback @param {number} max */
function intOption(ctx, name, fallback, max) {
  const raw = ctx.values[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`--${name} must be a whole number from 1${max === Infinity ? "" : ` to ${max}`}.`);
  }
  return value;
}

/** @param {Context} ctx @param {number} used */
function promptWidth(ctx, used) {
  return Math.max(30, Math.min(80, (ctx.io.stdout.columns ?? 100) - used));
}

/** @param {string} text */
function quoteArg(text) {
  return /^[\w-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

/** @param {NodeJS.ReadableStream} stream */
async function readStream(stream) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

/**
 * Read up to the first line break, or to the end (Ctrl+D). Undefined when the
 * input ends before any text.
 * @param {NodeJS.ReadableStream} stream @returns {Promise<string | undefined>}
 */
async function readLine(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
    if (/[\r\n]/.test(text)) break;
  }
  return text ? text.split(/\r?\n/)[0] : undefined;
}

/** @param {string} file @param {NodeJS.ProcessEnv} env */
function tildify(file, env) {
  const home = env.HOME ?? env.USERPROFILE;
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/** @param {string} prompt */
function slugify(prompt) {
  const slug = prompt
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const short = slug.length > 60 ? slug.slice(0, 60).replace(/-[^-]*$/, "") : slug;
  return short || "tattoo-design";
}

const EXTENSIONS = /** @type {Record<string, string>} */ ({
  "image/webp": ".webp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
});

/**
 * Download the image. Without --out, or with a directory, the name is a slug
 * of the prompt that does not overwrite an existing file. A --out file name
 * gets the extension of the image type the server sent, and an existing file
 * is overwritten only with --force.
 * @param {string} url @param {string | undefined} out @param {string} prompt @param {string} cwd @param {boolean} force
 * @returns {Promise<{ file: string, renamed: boolean }>} the path relative to cwd when inside it
 */
async function saveImage(url, out, prompt, cwd, force) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const urlExt = extname(new URL(url).pathname).toLowerCase();
  const ext = EXTENSIONS[type] ?? (/^\.(webp|png|jpe?g)$/.test(urlExt) ? urlExt : ".png");

  let target;
  let renamed = false;
  let overwrite = false;
  const outPath = out ? resolve(cwd, out) : cwd;
  if (!out || /[\\/]$/.test(out) || (existsSync(outPath) && statSync(outPath).isDirectory())) {
    mkdirSync(outPath, { recursive: true });
    const base = join(outPath, slugify(prompt));
    target = `${base}${ext}`;
    for (let n = 2; existsSync(target); n++) target = `${base}-${n}${ext}`;
  } else {
    const given = extname(outPath);
    const sameType = given.toLowerCase() === ext || (ext === ".jpg" && given.toLowerCase() === ".jpeg");
    target = given && sameType ? outPath : `${given && IMAGE_EXTENSION.test(given) ? outPath.slice(0, -given.length) : outPath}${ext}`;
    renamed = Boolean(given) && target !== outPath;
    overwrite = force;
    mkdirSync(dirname(target), { recursive: true });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    writeFileSync(target, bytes, { flag: overwrite ? "w" : "wx" });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
    throw new Error(`${relativeTo(cwd, target)} already exists. Use --force to overwrite it`);
  }
  return { file: relativeTo(cwd, target), renamed };
}

const IMAGE_EXTENSION = /^\.(webp|png|jpe?g|gif|avif)$/i;

/** @param {string} cwd @param {string} target */
function relativeTo(cwd, target) {
  const rel = relative(cwd, target);
  return rel && !rel.startsWith("..") ? rel : target;
}

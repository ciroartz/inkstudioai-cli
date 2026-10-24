import { parseArgs } from "node:util";
import { ApiError, VERSION, createClient, describeError } from "./api.js";
import { apiBaseUrl, resolveApiKey, siteUrl, withUtm } from "./config.js";
import { ALIASES, COMMANDS, UsageError } from "./commands.js";
import { columns, createColors, createSpinner, formatHint, isSafeUrl, openWithSystem, padEnd } from "./ui.js";

/**
 * Everything the CLI touches outside its own code, so tests can run it in process.
 * @typedef {{
 *   env: NodeJS.ProcessEnv,
 *   cwd: string,
 *   stdin: NodeJS.ReadableStream,
 *   stdout: import("./ui.js").Output,
 *   stderr: import("./ui.js").Output,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   open: (target: string) => void,
 * }} Io
 */

/**
 * @typedef {{
 *   io: Io,
 *   values: Record<string, string | boolean | undefined>,
 *   positionals: string[],
 *   json: boolean,
 *   site: string,
 *   link: (path: string) => string,
 *   apiKey: import("./config.js").ResolvedKey,
 *   apiKeyFlag: string | undefined,
 *   c: import("./ui.js").Colors,
 *   e: import("./ui.js").Colors,
 *   client: (key?: string) => import("./api.js").Client,
 *   print: (text: string) => void,
 *   note: (text: string) => void,
 *   printJson: (value: unknown) => void,
 *   spinner: () => ReturnType<typeof createSpinner>,
 *   openUrl: (url: string) => boolean,
 *   openFile: (path: string) => boolean,
 *   exitCode?: number,
 * }} Context
 */

/** @type {Record<string, { type: "string" | "boolean", short?: string }>} */
const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  "api-key": { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
};

/** @returns {Io} */
export function systemIo() {
  return {
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    open: openWithSystem,
  };
}

/**
 * Run the CLI and return the exit code: 0 ok, 1 error, 2 usage error,
 * 3 design created but the image file not saved.
 * @param {string[]} argv @param {Io} io
 */
export async function main(argv, io) {
  const { tokens } = parseArgs({
    args: argv,
    options: GLOBAL_OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const commandToken = tokens.find((token) => token.kind === "positional");
  const typed = commandToken?.kind === "positional" ? commandToken.value : undefined;
  const name = typed && (ALIASES[typed] ?? typed);
  const command = name ? COMMANDS[name] : undefined;
  const err = createColors(io.stderr, io.env, argv.includes("--no-color"));
  const wantsJson = tokens.some((token) => token.kind === "option" && token.name === "json");
  /** @param {string} message @param {string} hint */
  const usageError = (message, hint) => {
    if (wantsJson) {
      io.stdout.write(`${JSON.stringify({ error: message, code: "usage", hints: [hint] }, null, 2)}\n`);
    } else {
      io.stderr.write(`${err.red("error")} ${formatHint(message, err)}\n`);
      io.stderr.write(`${formatHint(hint, err)}\n`);
    }
    return 2;
  };

  if (typed === "help") {
    const c = createColors(io.stdout, io.env, argv.includes("--no-color"));
    const topic = tokens.filter((token) => token.kind === "positional")[1];
    const topicName = topic?.kind === "positional" ? (ALIASES[topic.value] ?? topic.value) : undefined;
    io.stdout.write(`${topicName && COMMANDS[topicName] ? commandHelp(topicName, c) : mainHelp(c)}\n`);
    return 0;
  }
  if (typed && !command) {
    return usageError(`Unknown command "${typed}".`, "Run `inkstudioai --help` to see the commands.");
  }

  let parsed;
  try {
    const rest = commandToken ? argv.filter((_, i) => i !== commandToken.index) : argv;
    parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...command?.options },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    return usageError(/** @type {Error} */ (error).message, `Run \`inkstudioai ${name ? `${name} ` : ""}--help\` for usage.`);
  }
  const { values, positionals } = parsed;
  const noColor = Boolean(values["no-color"]);
  const c = createColors(io.stdout, io.env, noColor);

  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || values.help) {
    io.stdout.write(`${command && name ? commandHelp(name, c) : mainHelp(c)}\n`);
    return 0;
  }

  let ctx;
  try {
    ctx = createContext(io, values, positionals, c, createColors(io.stderr, io.env, noColor));
  } catch (error) {
    // For example an INKSTUDIO_API_URL that is not https.
    return usageError(/** @type {Error} */ (error).message, "Fix the setting, or unset it to use https://inkstudioai.com.");
  }
  try {
    await command.run(ctx);
    return ctx.exitCode ?? 0;
  } catch (error) {
    if (error instanceof UsageError) {
      return usageError(error.message, `Run \`inkstudioai ${name} --help\` for usage.`);
    }
    const { message, hints } = describeError(error, ctx.link(""), ctx.apiKey?.source);
    if (ctx.json) {
      const extra = error instanceof ApiError ? { ...error.body, code: error.code, status: error.status } : {};
      ctx.printJson({ ...extra, error: message, hints });
    } else {
      ctx.note(`${ctx.e.red("✖")} ${formatHint(message, ctx.e)}`);
      for (const hint of hints) ctx.note(`  ${formatHint(hint, ctx.e)}`);
    }
    return 1;
  }
}

/**
 * @param {Io} io @param {Record<string, string | boolean | undefined>} values @param {string[]} positionals
 * @param {import("./ui.js").Colors} c @param {import("./ui.js").Colors} e
 * @returns {Context}
 */
function createContext(io, values, positionals, c, e) {
  const json = Boolean(values.json);
  const apiKeyFlag = /** @type {string | undefined} */ (values["api-key"]);
  const apiKey = resolveApiKey(io.env, apiKeyFlag, (text) => io.stderr.write(text));
  const noBrowser =
    Boolean(values["no-browser"]) || (Boolean(io.env.INKSTUDIO_NO_BROWSER) && io.env.INKSTUDIO_NO_BROWSER !== "0");
  const site = siteUrl(io.env);
  return {
    io,
    values,
    positionals,
    json,
    site,
    // Website pages get utm_source=cli; API, image, and checkout URLs do not.
    link: (path) => withUtm(site + path, "cli"),
    apiKey,
    apiKeyFlag,
    c,
    e,
    client: (key) => createClient({ baseUrl: apiBaseUrl(io.env), apiKey: key ?? apiKey.key }),
    print: (text) => io.stdout.write(`${text}\n`),
    note: (text) => io.stderr.write(`${text}\n`),
    printJson: (value) => io.stdout.write(`${JSON.stringify(value, null, 2)}\n`),
    spinner: () => (json ? { start() {}, stop() {} } : createSpinner(io.stderr, e)),
    // Only web pages: the server picks these URLs, and the system opener runs any scheme.
    openUrl(url) {
      if (noBrowser || !isSafeUrl(url)) return false;
      io.open(url);
      return true;
    },
    openFile(path) {
      if (noBrowser) return false;
      io.open(path);
      return true;
    },
  };
}

const GROUPS = /** @type {const} */ ([
  ["start", "Get started"],
  ["designs", "Designs"],
  ["account", "Account and plans"],
  ["agents", "AI agents"],
]);

/** @param {import("./ui.js").Colors} c */
function mainHelp(c) {
  // One column width for every section, so the summaries line up.
  const width = Math.max(...globalOptionRows().map(([flag]) => flag.length), ...Object.keys(COMMANDS).map((n) => n.length));
  const sections = GROUPS.map(([group, title]) => {
    const rows = Object.entries(COMMANDS)
      .filter(([, command]) => command.group === group)
      .map(([name, command]) => [padEnd(c.bold(name), width), command.summary]);
    return `${c.bold(title)}\n${columns(rows)}`;
  });
  return [
    `${c.bold("inkstudioai")} ${c.dim(VERSION)}  AI tattoo designs from your terminal`,
    "",
    `${c.bold("Usage")}  inkstudioai <command> [options]`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    c.bold("Global options"),
    columns(globalOptionRows()),
    "",
    c.bold("Examples"),
    columns([
      [c.dim("$ npx inkstudioai login")],
      [c.dim('$ inkstudioai generate "a fox in a crescent moon" --style fine-line')],
      [c.dim("$ inkstudioai gallery dragon")],
    ]),
    "",
    `Run ${c.cyan("inkstudioai <command> --help")} for details. Docs: ${c.cyan(withUtm("https://inkstudioai.com/developers"))}`,
  ].join("\n");
}

function globalOptionRows() {
  return [
    ["--json", "Print raw JSON for scripts and agents"],
    ["--api-key <key>", "Use this key instead of INKSTUDIO_API_KEY or the saved key"],
    ["--no-color", "Turn off colors (NO_COLOR also works)"],
    ["-h, --help", "Show help"],
    ["-v, --version", "Show the version"],
  ];
}

/** @param {string} name @param {import("./ui.js").Colors} c */
function commandHelp(name, c) {
  const command = COMMANDS[name];
  const alias = Object.entries(ALIASES).find(([, target]) => target === name)?.[0];
  const lines = [`${c.bold("Usage")}  inkstudioai ${command.usage}`, "", formatHint(command.description ?? command.summary, c)];
  if (alias) lines.push(c.dim(`Alias: ${alias}`));
  if (command.optionHelp) lines.push("", c.bold("Options"), columns(command.optionHelp.map(([flag, text]) => [flag, formatHint(text, c)])));
  lines.push("", c.bold("Global options"), columns(globalOptionRows()));
  if (command.examples) {
    lines.push("", c.bold("Examples"), columns(command.examples.map((example) => [c.dim(`$ ${example}`)])));
  }
  return lines.join("\n");
}

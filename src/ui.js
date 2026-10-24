import { spawn } from "node:child_process";

/** @typedef {{ write(text: string): unknown, isTTY?: boolean, columns?: number }} Output */

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Colors follow NO_COLOR, FORCE_COLOR, --no-color, and whether the stream is a terminal.
 * @param {Output} stream @param {NodeJS.ProcessEnv} env @param {boolean} disabled
 */
export function createColors(stream, env, disabled) {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const enabled =
    !disabled && !("NO_COLOR" in env) && (forced || (Boolean(stream.isTTY) && env.TERM !== "dumb"));
  /** @param {number} open @param {number} close */
  const style = (open, close) => (/** @type {unknown} */ text) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);
  return {
    enabled,
    bold: style(1, 22),
    dim: style(2, 22),
    red: style(31, 39),
    green: style(32, 39),
    yellow: style(33, 39),
    magenta: style(35, 39),
    cyan: style(36, 39),
  };
}

/** @typedef {ReturnType<typeof createColors>} Colors */

/** Commands in backticks become cyan, and the backticks go away. @param {string} text @param {Colors} c */
export function formatHint(text, c) {
  return text.replace(/`([^`]+)`/g, (_, code) => c.cyan(code));
}

/** @param {string} text */
export function visibleLength(text) {
  return text.replace(ANSI, "").length;
}

/** @param {string} text @param {number} width */
export function padEnd(text, width) {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

/** @param {string} text @param {number} max */
export function truncate(text, max) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Align rows of cells into columns. The last column is not padded.
 * @param {string[][]} rows @param {string} [indent]
 */
export function columns(rows, indent = "  ") {
  /** @type {number[]} */
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      if (i < row.length - 1) widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows
    .map((row) => indent + row.map((cell, i) => (i < row.length - 1 ? padEnd(cell, widths[i] + 2) : cell)).join(""))
    .map((line) => line.trimEnd())
    .join("\n");
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line spinner on a terminal. The text can be a function so elapsed
 * time stays current. Off a terminal it prints the first text once.
 * @param {Output} stream @param {Colors} c
 */
export function createSpinner(stream, c) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  /** @type {string | (() => string)} */
  let text = "";
  let frame = 0;
  const current = () => (typeof text === "function" ? text() : text);
  const render = () => {
    stream.write(`\r\x1b[2K${c.magenta(FRAMES[frame++ % FRAMES.length])} ${current()}`);
  };
  return {
    /**
     * @param {string | (() => string)} value
     * @param {string} [plain] the line to print instead off a terminal
     */
    start(value, plain) {
      text = value;
      if (!stream.isTTY) {
        stream.write(`${plain ?? current()}\n`);
        return;
      }
      stream.write("\x1b[?25l");
      render();
      timer = setInterval(render, 80);
    },
    /** @param {string} [final] */
    stop(final) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
        stream.write("\r\x1b[2K\x1b[?25h");
      }
      if (final) stream.write(`${final}\n`);
    },
  };
}

/**
 * Open a URL or a file with the system handler. Errors are ignored because
 * the caller always prints the target too.
 * @param {string} target
 */
export function openWithSystem(target) {
  if (process.platform === "win32" && target.includes('"')) return;
  const [command, args, options] =
    process.platform === "darwin"
      ? ["open", [target], {}]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', `"${target}"`], { windowsVerbatimArguments: true }]
        : ["xdg-open", [target], {}];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true, ...options });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener on this system.
  }
}

/**
 * True for https URLs, and for http URLs on this computer (a local test server).
 * @param {string} target
 */
export function isSafeUrl(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** @param {string | null | undefined} iso */
export function formatDate(iso) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * "Nov 1, 10:00 UTC", with the year when it is not the current year.
 * @param {string} iso @param {number} now
 */
export function formatPlanEnd(iso, now) {
  const date = new Date(iso);
  const year = date.getUTCFullYear() === new Date(now).getUTCFullYear() ? {} : { year: "numeric" };
  const day = date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...year });
  const time = date.toLocaleTimeString("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day}, ${time} UTC`;
}

/** @param {number} usd */
export function formatPrice(usd) {
  return `$${Number(usd).toFixed(2)}`;
}

/** @param {number} ms */
export function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

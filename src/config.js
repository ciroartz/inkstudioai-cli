import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://inkstudioai.com/api/v1";

/**
 * @typedef {{ apiKey?: string, keyId?: string, email?: string, savedAt?: string }} StoredConfig
 * @typedef {{ key: string | undefined, source: "flag" | "env" | "file" | undefined }} ResolvedKey
 */

/** @param {NodeJS.ProcessEnv} env */
export function configDir(env) {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "inkstudioai");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "inkstudioai");
  return join(homedir(), ".config", "inkstudioai");
}

/** @param {NodeJS.ProcessEnv} env */
export function configPath(env) {
  return join(configDir(env), "config.json");
}

let warnedCorrupt = false;

/**
 * A missing file is an empty config. A file that is not a JSON object is
 * ignored too, with one warning on stderr per process.
 * @param {NodeJS.ProcessEnv} env @param {(text: string) => void} [warn]
 * @returns {StoredConfig}
 */
export function readConfig(env, warn = (text) => process.stderr.write(text)) {
  const file = configPath(env);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // Reported below.
  }
  if (!warnedCorrupt) {
    warnedCorrupt = true;
    warn(`warning: ${file} is not valid JSON, so the saved key is ignored. Run inkstudioai login to replace it.\n`);
  }
  return {};
}

/**
 * Write the config readable only by the current user (dir 0700, file 0600).
 * @param {NodeJS.ProcessEnv} env @param {StoredConfig} config
 */
export function writeConfig(env, config) {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = configPath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/** @param {NodeJS.ProcessEnv} env */
export function deleteConfig(env) {
  rmSync(configPath(env), { force: true });
}

/**
 * Key precedence: --api-key, then INKSTUDIO_API_KEY, then the config file.
 * @param {NodeJS.ProcessEnv} env @param {string | undefined} flag
 * @param {(text: string) => void} [warn] @returns {ResolvedKey}
 */
export function resolveApiKey(env, flag, warn) {
  if (flag) return { key: flag, source: "flag" };
  if (env.INKSTUDIO_API_KEY) return { key: env.INKSTUDIO_API_KEY, source: "env" };
  const stored = readConfig(env, warn).apiKey;
  return stored ? { key: stored, source: "file" } : { key: undefined, source: undefined };
}

/** @param {NodeJS.ProcessEnv} env */
export function apiBaseUrl(env) {
  const base = (env.INKSTUDIO_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  // The key travels in a header, so only https, or http to this computer, is allowed.
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`INKSTUDIO_API_URL is not a valid URL: ${base}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("INKSTUDIO_API_URL must use https (http is allowed only for localhost).");
  }
  return base;
}

/**
 * Site origin for links, derived from the API URL so staging links stay on staging.
 * @param {NodeJS.ProcessEnv} env
 */
export function siteUrl(env) {
  const base = apiBaseUrl(env);
  return base === DEFAULT_API_URL ? "https://inkstudioai.com" : new URL(base).origin;
}

/**
 * Add attribution to a website page URL, so visits from the CLI and the MCP
 * server count in analytics. Use it only for pages: API, image, and checkout
 * URLs stay as they are.
 * @param {string} url @param {"cli" | "mcp"} [source]
 */
export function withUtm(url, source = "cli") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.searchParams.set("utm_source", source);
  parsed.searchParams.set("utm_medium", "referral");
  return parsed.toString();
}

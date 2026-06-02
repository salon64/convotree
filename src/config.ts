import fs from "fs";
import path from "path";
import os from "os";
import { Config } from "./models/types.js";

const CONFIG_DIR = path.join(os.homedir(), ".convotree");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const DEFAULT_DB_PATH = path.join(CONFIG_DIR, "tree.db");

const DEFAULTS: Config = {
  provider: "anthropic",
  // Drop-in replacement for the now-deprecated claude-sonnet-4-20250514.
  // Sonnet keeps auxiliary calls (brancher/summarizer/merger) cheap; set
  // `model` to e.g. "claude-opus-4-8" in config.json for higher-fidelity work.
  model: "claude-sonnet-4-6",
  max_tokens: 8192,
  api_keys: {},
  db_path: DEFAULT_DB_PATH,
  default_context_mode: "summary",
};

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  let config: Config = { ...DEFAULTS };

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    } catch (e: any) {
      // Don't brick the tool on a hand-edit typo — warn (to stderr, safe for the
      // stdio MCP server) and fall back to defaults.
      console.error(`⚠ convotree: ignoring invalid JSON in ${CONFIG_PATH} (${e?.message ?? e}); using defaults.`);
    }
  }

  // Env override for the DB path (handy for tests / alternate stores).
  if (process.env.CONVOTREE_DB) config.db_path = process.env.CONVOTREE_DB;

  return config;
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Path to the config file (for the `config` CLI command to show users).
export const CONFIG_FILE = CONFIG_PATH;

// Raw read/write of the on-disk config — no DEFAULTS merge, no env overrides —
// so the `config` command only persists what the user actually set.
export function readRawConfig(): Record<string, any> {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeRawConfig(cfg: Record<string, any>): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

export function getApiKey(config: Config): string {
  const provider = config.provider;
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  const key = config.api_keys[provider] ?? process.env[envVar];

  if (!key) {
    throw new Error(
      `No API key found for provider "${provider}". ` +
        `Set "api_keys.${provider}" in ~/.convotree/config.json or the ${envVar} env var.`
    );
  }
  return key;
}

/** Environment isolation shared by every third-party CLI launcher. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Default `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: 190000 = 95% of the 200K window
 * Claude Code assumes for any model id it does not recognize. Callers with a
 * model whose real window differs must pass the real context length (or an
 * explicit window) so auto-compaction fires at the right point instead of
 * ~5x too early on 1M models (compact thrash) or too late on small ones.
 */
export const DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW = 190000;

/** Fraction of the real context window at which Claude Code should compact. */
export const CLAUDE_AUTO_COMPACT_HEADROOM = 0.95;

function asPositiveFiniteNumber(value) {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for a Claude Code session.
 * Explicit window wins; otherwise derive 95% of the model's real context
 * length; otherwise the 190000 default (200K-assumption models).
 * @param {{ autoCompactWindow?: unknown, contextLength?: unknown }} [opts]
 * @returns {number} a positive integer window
 */
export function resolveClaudeAutoCompactWindow(opts = {}) {
  const explicit = asPositiveFiniteNumber(opts.autoCompactWindow);
  if (explicit !== undefined) return Math.floor(explicit);
  const contextLength = asPositiveFiniteNumber(opts.contextLength);
  if (contextLength !== undefined) {
    return Math.floor(contextLength * CLAUDE_AUTO_COMPACT_HEADROOM);
  }
  return DEFAULT_CLAUDE_AUTO_COMPACT_WINDOW;
}

/**
 * Read the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` baked into a generated profile's
 * settings.json. Used by the launch paths so `launch --profile <1M-model>`
 * keeps the per-model threshold instead of clobbering it with the 190000
 * default (which would reintroduce compact thrash on large-window models).
 * Never throws — missing/unparseable/invalid profiles yield undefined and the
 * caller falls back to the default.
 * @param {string} [configDir] absolute profile dir (<claudeHome>/profiles/<name>)
 * @returns {number|undefined} positive integer window, or undefined
 */
export function readProfileAutoCompactWindow(configDir) {
  try {
    if (!configDir) return undefined;
    const raw = readFileSync(join(String(configDir), "settings.json"), "utf8");
    const value = JSON.parse(raw)?.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const n = Number(String(value ?? "").trim());
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "EDITOR",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "NO_COLOR",
  "PAGER",
  "PATHEXT",
  "PATH",
  "Path",
  "PWD",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "VISUAL",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

function safeKey(key) {
  return SAFE_KEYS.has(key) || key.startsWith("LC_");
}

/**
 * Third-party CLI binaries must not inherit OmniRoute/provider/database secrets
 * merely because the parent loaded its server `.env`. Operators can explicitly
 * opt into the historical full-shell behavior with `--inherit-env`.
 */
export function buildSafeCliLaunchEnv(source = process.env, { inheritEnv = false } = {}) {
  if (inheritEnv) return { ...source };
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => safeKey(key) && value !== undefined)
  );
}

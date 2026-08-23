import { readFileSync } from "node:fs";

/**
 * Resolved connection config for the Codex app-server WS transport.
 *
 * The app-server is a locally-running `codex app-server` process reachable over a
 * single WebSocket speaking JSON-RPC 2.0. It self-manages OpenAI auth + model
 * routing; the ONLY credential OmniRoute presents is the capability token, sent as
 * `Authorization: Bearer <hex>` on the WS handshake.
 */
export interface CodexAppServerConfig {
  /** ws:// or wss:// URL of the app-server (e.g. "ws://ts-egress:1456"). */
  url: string;
  /** Capability token (hex string) sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Working directory passed to `thread/start { cwd }` inside the codex container. */
  cwd: string;
  /**
   * Optional codex approval policy override (AskForApproval). Defaults to "never"
   * in the executor so codex runs non-interactively and never blocks the turn on
   * its own approval — the harness that consumes OmniRoute owns execution policy.
   */
  approvalPolicy?: string;
  /**
   * Optional codex sandbox override (SandboxMode). Defaults to "danger-full-access"
   * in the executor so codex's own sandbox does not gate the model; the harness is
   * the real gate. Callers may tighten this per request via providerSpecificData.
   */
  sandbox?: string;
}

type ProviderSpecificData = Record<string, unknown> | null | undefined;

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Read the capability token, preferring an inline token, then a token FILE path.
 * The token file (produced by `codex app-server --ws-token-file <path>`) holds the
 * same hex string that is presented as the bearer token.
 */
function resolveToken(psd: ProviderSpecificData): string | null {
  const inline = firstString(
    psd?.codexAppServerToken,
    process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN
  );
  if (inline) return inline;

  const tokenFile = firstString(
    psd?.codexAppServerTokenFile,
    process.env.OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE
  );
  if (!tokenFile) return null;
  try {
    const contents = readFileSync(tokenFile, "utf8").trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

function isWebSocketUrl(url: string): boolean {
  return url.startsWith("ws://") || url.startsWith("wss://");
}

/**
 * Resolve the app-server connection config from providerSpecificData with env
 * fallbacks. Returns `null` when not fully configured (URL + token both required)
 * so the gating predicate `isCodexAppServerRequired` stays false and Codex falls
 * back to its other transports.
 */
export function resolveAppServerConfig(psd: ProviderSpecificData): CodexAppServerConfig | null {
  const url = firstString(psd?.codexAppServerUrl, process.env.OMNIROUTE_CODEX_APPSERVER_WS);
  if (!url || !isWebSocketUrl(url)) return null;

  const token = resolveToken(psd);
  if (!token) return null;

  const cwd =
    firstString(psd?.codexAppServerCwd, process.env.OMNIROUTE_CODEX_APPSERVER_CWD) ?? "/tmp";

  const approvalPolicy =
    firstString(psd?.codexAppServerApprovalPolicy, process.env.OMNIROUTE_CODEX_APPSERVER_APPROVAL) ??
    undefined;
  const sandbox =
    firstString(psd?.codexAppServerSandbox, process.env.OMNIROUTE_CODEX_APPSERVER_SANDBOX) ??
    undefined;

  return { url, token, cwd, ...(approvalPolicy ? { approvalPolicy } : {}), ...(sandbox ? { sandbox } : {}) };
}

import {
  MUSE_CODE_DEFAULT_POLL_INTERVAL_SEC,
  MUSE_CODE_DEVICE_GRANT,
  isMuseDcaToken,
  museCodeHeaders,
} from "@omniroute/open-sse/config/museCode.ts";
import {
  mintMuseApiKey,
  type MuseMintedKey,
} from "@omniroute/open-sse/services/museCodeAuth.ts";
import { MUSE_CODE_CONFIG } from "../constants/oauth";

const AUTH_ORIGIN = "https://auth.meta.com";
// The device endpoint never issues codes valid longer than a day; refuse
// anything outside (0, 24h] instead of polling a bogus deadline (#14267).
const MAX_DEVICE_EXPIRY_SECONDS = 86400;
// Bounded upstream calls: the device endpoints are interactive-paced, so a
// hung socket must fail instead of stalling the connect flow (#14267).
const REQUEST_TIMEOUT_MS = 20000;

// Recognized device-poll error codes, each mapped to a fixed message.
// Upstream descriptions are always discarded: they are free text and must
// never reach UI error paths (#14267).
const POLL_ERROR_MESSAGES: Record<string, string> = {
  authorization_pending: "Authorization pending.",
  slow_down: "Authorization pending.",
  access_denied: "Authorization denied.",
  expired_token: "Device code expired.",
  invalid_grant: "Authorization failed.",
};

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Muse Code device authorization response missing ${field}`);
  }
  return value.trim();
}

function verifiedAuthorizationUrl(data: Record<string, unknown>): {
  url: string;
  complete: string;
} {
  const complete = requiredText(data.verification_uri_complete, "verification_uri_complete");
  const plain = typeof data.verification_uri === "string" ? data.verification_uri : "";
  for (const candidate of [complete, plain]) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("Muse Code returned an invalid authorization URL.");
    }
    if (url.origin !== AUTH_ORIGIN || url.username || url.password) {
      throw new Error("Muse Code returned an authorization URL for an unexpected origin.");
    }
  }
  return { url: plain, complete };
}

async function postForm(
  url: string,
  params: Record<string, string>
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: museCodeHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams(params),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { error: "invalid_response" };
  }
  return { ok: response.ok, status: response.status, data };
}

/** Allowlist the poll fields the shared loop consumes; drop everything else. */
function sanitizePollData(data: Record<string, unknown>): Record<string, unknown> {
  if (typeof data.access_token === "string" && data.access_token.trim()) {
    const clean: Record<string, unknown> = { access_token: data.access_token };
    if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in)) {
      clean.expires_in = data.expires_in;
    }
    if (typeof data.token_type === "string" && data.token_type.trim()) {
      clean.token_type = data.token_type;
    }
    return clean;
  }
  const error =
    typeof data.error === "string" && Object.hasOwn(POLL_ERROR_MESSAGES, data.error)
      ? data.error
      : "invalid_response";
  const clean: Record<string, unknown> = { error };
  if (error !== "invalid_response") {
    clean.error_description = POLL_ERROR_MESSAGES[error];
  }
  return clean;
}

export const museCode = {
  config: MUSE_CODE_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    let result: { ok: boolean; data: Record<string, unknown> };
    try {
      result = await postForm(config.deviceCodeUrl, { client_id: config.clientId });
    } catch {
      throw new Error("Muse Code device authorization request failed.");
    }
    const { ok, data } = result;
    if (!ok) {
      throw new Error("Muse Code device authorization request failed.");
    }
    const expiresIn = Number(data.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_DEVICE_EXPIRY_SECONDS) {
      throw new Error("Muse Code returned an invalid device code expiry.");
    }
    const { url, complete } = verifiedAuthorizationUrl(data);
    const interval = Number(data.interval);
    return {
      device_code: requiredText(data.device_code, "device_code"),
      user_code: requiredText(data.user_code, "user_code"),
      verification_uri: url,
      verification_uri_complete: complete,
      expires_in: expiresIn,
      interval:
        Number.isFinite(interval) && interval > 0
          ? interval
          : MUSE_CODE_DEFAULT_POLL_INTERVAL_SEC,
    };
  },
  pollToken: async (config, deviceCode: string) => {
    let result: { ok: boolean; data: Record<string, unknown> };
    try {
      result = await postForm(config.tokenUrl, {
        client_id: config.clientId,
        device_code: deviceCode,
        grant_type: MUSE_CODE_DEVICE_GRANT,
      });
    } catch {
      return { ok: false, data: { error: "network_error" } };
    }
    return { ok: result.ok, data: sanitizePollData(result.data) };
  },
  /**
   * After the device grant, mint the subscription inference key. CLIProxyAPI
   * keeps the `dca:` token as the durable credential and remints the API key
   * on 401. Mint at login is best-effort: a DCA-only record is still saved and
   * reminted on the first request. We persist the DCA token as refreshToken.
   */
  postExchange: async (tokens: { access_token?: string }) => {
    const dcaToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    if (!dcaToken) {
      throw new Error("Muse Code device flow completed without an access token.");
    }
    try {
      const minted = await mintMuseApiKey(dcaToken);
      return { minted, dcaToken };
    } catch {
      return { dcaToken };
    }
  },
  mapTokens: (
    tokens: Record<string, unknown>,
    extra?: { minted?: MuseMintedKey; dcaToken?: string }
  ) => {
    const dcaToken =
      extra?.dcaToken || (typeof tokens.access_token === "string" ? tokens.access_token : "");
    const minted = extra?.minted;
    const inferenceKey = minted?.apiKey || (isMuseDcaToken(dcaToken) ? "" : dcaToken);
    const hasMintedKey = Boolean(minted?.apiKey);
    const dcaExpiresAt =
      typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : undefined;
    return {
      accessToken: inferenceKey || dcaToken,
      refreshToken: dcaToken,
      // Minted inference keys do not inherit the DCA expiry (CLIProxyAPI leaves
      // `expired` empty once an API key exists). Remint is on-demand / 401.
      expiresIn: hasMintedKey
        ? undefined
        : typeof tokens.expires_in === "number"
          ? tokens.expires_in
          : undefined,
      tokenType: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
      email: minted?.email,
      displayName: minted?.name,
      providerSpecificData: {
        dcaToken,
        authKind: "oauth",
        baseUrl: minted?.baseUrl,
        email: minted?.email,
        name: minted?.name,
        subsTierName: minted?.subsTierName,
        subsTierId: minted?.subsTierId,
        isSubsActive: minted?.isSubsActive,
        hasPaymentMethod: minted?.hasPaymentMethod,
        requirePayment: minted?.requirePayment,
        canSubscribe: minted?.canSubscribe,
        dcaExpiresAt: dcaExpiresAt ? new Date(dcaExpiresAt).toISOString() : undefined,
        lastRefresh: new Date().toISOString(),
      },
    };
  },
};

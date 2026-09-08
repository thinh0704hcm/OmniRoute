import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { unavailableResponse } from "@omniroute/open-sse/utils/error.ts";

export type RateLimitedCredentials = {
  allRateLimited: true;
  retryAfter?: string | number | Date | null;
  retryAfterHuman?: string;
};

export function isAllRateLimitedCredentials(value: unknown): value is RateLimitedCredentials {
  return (
    !!value &&
    typeof value === "object" &&
    (value as RateLimitedCredentials).allRateLimited === true
  );
}

export function rateLimitedProviderResponse(
  provider: string,
  credentials: RateLimitedCredentials
): Response {
  const base = unavailableResponse(
    HTTP_STATUS.RATE_LIMITED,
    `[${provider}] All accounts rate limited`,
    credentials.retryAfter,
    credentials.retryAfterHuman
  );
  // Quota observability: explicit remaining=0 + provider so callers can
  // tell silent quota death (ollama 1000/mo) from transport errors.
  const headers = new Headers(base.headers);
  headers.set("X-Quota-Remaining", "0");
  headers.set("X-Quota-Provider", provider);
  return new Response(base.body, { status: base.status, headers });
}

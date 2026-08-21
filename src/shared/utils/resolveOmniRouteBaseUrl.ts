const DEFAULT_OMNIROUTE_BASE_URL = "http://localhost:20128";

type OmniRouteBaseUrlEnv = {
  OMNIROUTE_BASE_URL?: string;
  BASE_URL?: string;
  NEXT_PUBLIC_BASE_URL?: string;
  OMNIROUTE_PORT?: string | number;
  PORT?: string | number;
};

function normalizeBaseUrl(value?: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function resolveOmniRouteBaseUrl(env: OmniRouteBaseUrlEnv = process.env): string {
  const explicitBase =
    normalizeBaseUrl(env.OMNIROUTE_BASE_URL) ||
    normalizeBaseUrl(env.BASE_URL) ||
    normalizeBaseUrl(env.NEXT_PUBLIC_BASE_URL);

  if (explicitBase) {
    return explicitBase;
  }

  const rawPort = env.OMNIROUTE_PORT ?? env.PORT;
  const port = String(rawPort ?? "").trim() || "20128";
  return `http://localhost:${port}`;
}

export { DEFAULT_OMNIROUTE_BASE_URL };

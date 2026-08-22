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

function normalizePort(value?: string | number): number | null {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function resolveOmniRouteBaseUrl(env: OmniRouteBaseUrlEnv = process.env): string {
  const explicitBase =
    normalizeBaseUrl(env.OMNIROUTE_BASE_URL) ||
    normalizeBaseUrl(env.BASE_URL) ||
    normalizeBaseUrl(env.NEXT_PUBLIC_BASE_URL);
  if (explicitBase) return explicitBase;

  const port = normalizePort(env.OMNIROUTE_PORT) ?? normalizePort(env.PORT);
  return port ? `http://localhost:${port}` : DEFAULT_OMNIROUTE_BASE_URL;
}

export { DEFAULT_OMNIROUTE_BASE_URL };

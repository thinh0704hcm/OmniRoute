const BARE_OFFSET_PATTERN = /([+-]\d{2})(\d{2})$/;

function normalizeBareOffset(value: string): string {
  return value.replace(BARE_OFFSET_PATTERN, "$1:$2");
}

export function normalizePublishedAt(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = new Date(normalizeBareOffset(trimmed));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return null;
}

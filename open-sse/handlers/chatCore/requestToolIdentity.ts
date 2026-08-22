import {
  readNamespaceToolIdentityMap,
  readToolNameAliasMap,
  type NamespaceToolIdentity,
} from "../../translator/helpers/toolNameAliases.ts";

export type NamespaceIdentity = NamespaceToolIdentity;

export interface RequestToolMetadata {
  toolNameAliasMap: Map<string, string> | null;
  namespaceToolIdentityMap: Map<string, NamespaceIdentity> | null;
}

/**
 * Return a string-valued copy only when the complete map is an alias ledger.
 *
 * The legacy `_toolNameMap` side channel can carry either response aliases or
 * namespace identities. Checking every value before copying keeps those two
 * contracts separate and gives callers a real `Map<string, string>` instead of
 * asserting an identity map into the alias shape.
 */
export function toToolNameAliasMap(
  map: ReadonlyMap<string, unknown> | null
): Map<string, string> | null {
  if (!map || map.size === 0) return null;

  const aliases = new Map<string, string>();
  for (const [wireName, originalName] of map) {
    if (typeof originalName !== "string") return null;
    aliases.set(wireName, originalName);
  }
  return aliases;
}

/**
 * Extract the #7936 request-tool identity map from the translated body and
 * strip both side channels before dispatch.
 *
 * #9780 — prefer the dedicated `_namespaceToolIdentityMap`: on a pivot the
 * openai->claude/gemini step publishes its own alias `Map<string, string>` on
 * `_toolNameMap`, so that property alone can yield aliases instead of
 * identities. The `_toolNameMap` read stays as the fallback for the non-pivot
 * producers (executors/base.ts, cliproxyapi.ts, antigravity).
 */
export function extractRequestToolIdentityMap(
  translatedBody: Record<string, unknown>
): Map<string, NamespaceIdentity> | null {
  return extractRequestToolMetadata(translatedBody).namespaceToolIdentityMap;
}

/** Extract alias and namespace channels independently, then strip private metadata. */
export function extractRequestToolMetadata(
  translatedBody: Record<string, unknown>
): RequestToolMetadata {
  const toolNameAliasMap = readToolNameAliasMap(translatedBody);
  const namespaceToolIdentityMap = readNamespaceToolIdentityMap(translatedBody);
  delete translatedBody._namespaceToolIdentityMap;
  delete translatedBody._toolNameAliasMap;
  delete translatedBody._toolNameMap;
  return { toolNameAliasMap, namespaceToolIdentityMap };
}

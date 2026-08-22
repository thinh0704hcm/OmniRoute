import { createHash } from "node:crypto";

export const TOOL_NAME_ALIAS_MAP_PROPERTY = "_toolNameAliasMap";
export const NAMESPACE_TOOL_IDENTITY_MAP_PROPERTY = "_namespaceToolIdentityMap";

export type ToolNameAliasMap = Map<string, string>;
export type NamespaceToolIdentity = { namespace: string; name: string };
export type NamespaceToolIdentityMap = Map<string, NamespaceToolIdentity>;
export type ToolNamePolicy = "preserve" | "lowercase";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isStringMap(value: unknown): value is Map<string, string> {
  if (!(value instanceof Map)) return false;
  for (const [key, mapped] of value) {
    if (typeof key !== "string" || typeof mapped !== "string") return false;
  }
  return true;
}

function isNamespaceIdentityMap(value: unknown): value is NamespaceToolIdentityMap {
  if (!(value instanceof Map)) return false;
  for (const [key, identity] of value) {
    if (
      typeof key !== "string" ||
      !identity ||
      typeof identity !== "object" ||
      typeof (identity as NamespaceToolIdentity).namespace !== "string" ||
      typeof (identity as NamespaceToolIdentity).name !== "string"
    ) {
      return false;
    }
  }
  return true;
}

export function readToolNameAliasMap(value: unknown): ToolNameAliasMap | null {
  const record = toRecord(value);
  if (!record) return null;
  const dedicated = record[TOOL_NAME_ALIAS_MAP_PROPERTY];
  if (isStringMap(dedicated)) return new Map(dedicated);

  // Compatibility with translators/executors that still publish the legacy
  // string-valued side channel. Object-valued namespace maps are deliberately
  // rejected here and handled by readNamespaceToolIdentityMap instead.
  return isStringMap(record._toolNameMap) ? new Map(record._toolNameMap) : null;
}

export function readNamespaceToolIdentityMap(value: unknown): NamespaceToolIdentityMap | null {
  const record = toRecord(value);
  if (!record) return null;
  const dedicated = record[NAMESPACE_TOOL_IDENTITY_MAP_PROPERTY];
  if (isNamespaceIdentityMap(dedicated)) return new Map(dedicated);
  return isNamespaceIdentityMap(record._toolNameMap) ? new Map(record._toolNameMap) : null;
}

function attachMap(target: unknown, property: string, value: ReadonlyMap<string, unknown>): void {
  const record = toRecord(target);
  if (!record || value.size === 0) return;
  Object.defineProperty(record, property, {
    value: new Map(value),
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function attachToolNameAliasMap(target: unknown, aliases: ToolNameAliasMap | null): void {
  if (aliases?.size) attachMap(target, TOOL_NAME_ALIAS_MAP_PROPERTY, aliases);
}

export function attachNamespaceToolIdentityMap(
  target: unknown,
  identities: NamespaceToolIdentityMap | null
): void {
  if (identities?.size) attachMap(target, NAMESPACE_TOOL_IDENTITY_MAP_PROPERTY, identities);
}

/** Exact lookup first; case-fold fallback is accepted only when it is unambiguous. */
export function resolveToolNameAlias(
  wireName: string,
  aliases: ReadonlyMap<string, string> | null | undefined
): string | undefined {
  if (!aliases || !wireName) return undefined;
  const exact = aliases.get(wireName);
  if (exact !== undefined) return exact;

  const folded = wireName.toLowerCase();
  let resolved: string | undefined;
  for (const [candidate, original] of aliases) {
    if (candidate.toLowerCase() !== folded) continue;
    if (resolved !== undefined && resolved !== original) return undefined;
    resolved = original;
  }
  return resolved;
}

/**
 * Compose target-wire -> intermediate aliases with intermediate -> client aliases.
 * Carrying both maps also tolerates providers that echo an intermediate spelling
 * even after accepting a rewritten declaration.
 */
export function composeToolNameAliasMaps(
  targetAliases: ToolNameAliasMap | null,
  clientAliases: ToolNameAliasMap | null
): ToolNameAliasMap | null {
  if (!targetAliases?.size) return clientAliases?.size ? new Map(clientAliases) : null;
  if (!clientAliases?.size) return new Map(targetAliases);

  const composed = new Map<string, string>();
  for (const [wireName, intermediateName] of targetAliases) {
    composed.set(
      wireName,
      resolveToolNameAlias(intermediateName, clientAliases) ?? intermediateName
    );
  }
  for (const [wireName, originalName] of clientAliases) {
    if (!composed.has(wireName)) composed.set(wireName, originalName);
  }
  return composed;
}

function collectNamesFromTools(tools: unknown, names: string[]): void {
  if (!Array.isArray(tools)) return;
  for (const value of tools) {
    const tool = toRecord(value);
    if (!tool) continue;
    const fn = toRecord(tool.function);
    if (typeof fn?.name === "string" && fn.name.length > 0) names.push(fn.name);
    if (typeof tool.name === "string" && tool.name.length > 0 && tool.type !== "namespace") {
      names.push(tool.name);
    }
    if (Array.isArray(tool.functionDeclarations)) {
      for (const declaration of tool.functionDeclarations) {
        const record = toRecord(declaration);
        if (typeof record?.name === "string" && record.name.length > 0) names.push(record.name);
      }
    }
    // Responses namespace tools keep the namespace itself intact while their
    // callable children participate in the alias contract.
    if (tool.type === "namespace") collectNamesFromTools(tool.tools, names);
  }
}

export function buildDeclaredToolNameIdentityMap(body: unknown): ToolNameAliasMap | null {
  const root = toRecord(body);
  if (!root) return null;
  const names: string[] = [];
  collectNamesFromTools(root.tools, names);
  if (names.length === 0) return null;
  return new Map(names.map((name) => [name, name]));
}

function safeLowercaseBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "tool"
  );
}

function hashedAlias(
  base: string,
  original: string,
  hashLength: number,
  maxLength: number
): string {
  const hash = createHash("sha256").update(original).digest("hex").slice(0, hashLength);
  const prefixLength = Math.max(1, maxLength - hash.length - 1);
  return `${base.slice(0, prefixLength)}_${hash}`;
}

function buildLowercaseAliasAssignments(
  originalNames: readonly string[],
  maxLength: number
): { byOriginal: Map<string, string>; aliases: ToolNameAliasMap } {
  const uniqueNames = [...new Set(originalNames.filter(Boolean))];
  const grouped = new Map<string, string[]>();
  for (const original of uniqueNames) {
    const base = safeLowercaseBase(original);
    const values = grouped.get(base) ?? [];
    values.push(original);
    grouped.set(base, values);
  }

  const byOriginal = new Map<string, string>();
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const [base, originals] of grouped) {
    // Stable order makes aliases independent of request-array iteration order.
    originals.sort((left, right) => left.localeCompare(right));
    const exactLowercaseOwner = originals.find((original) => original === base);
    if (exactLowercaseOwner && base.length <= maxLength) {
      byOriginal.set(exactLowercaseOwner, base);
      aliases.set(base, exactLowercaseOwner);
      used.add(base);
    }

    for (const original of originals) {
      if (byOriginal.has(original)) continue;
      let wireName =
        originals.length === 1 && base.length <= maxLength && !used.has(base)
          ? base
          : hashedAlias(base, original, 8, maxLength);
      let hashLength = 10;
      while (used.has(wireName) && hashLength <= 32) {
        wireName = hashedAlias(base, original, hashLength, maxLength);
        hashLength += 2;
      }
      byOriginal.set(original, wireName);
      aliases.set(wireName, original);
      used.add(wireName);
    }
  }
  return { byOriginal, aliases };
}

function collectReferencedToolNames(root: JsonRecord): string[] {
  const names: string[] = [];
  collectNamesFromTools(root.tools, names);

  const collectCall = (value: unknown): void => {
    const record = toRecord(value);
    const fn = toRecord(record?.function);
    if (typeof fn?.name === "string" && fn.name.length > 0) names.push(fn.name);
    if (typeof record?.name === "string" && record.name.length > 0) names.push(record.name);
    if (
      record &&
      (record.type === "function_call" || record.type === "custom_tool_call") &&
      typeof record.name === "string"
    ) {
      names.push(record.name);
    }
  };

  if (Array.isArray(root.messages)) {
    for (const messageValue of root.messages) {
      const message = toRecord(messageValue);
      if (!message) continue;
      if (Array.isArray(message.tool_calls)) message.tool_calls.forEach(collectCall);
      collectCall(message.function_call);
      if (
        (message.role === "function" || message.role === "tool") &&
        typeof message.name === "string"
      ) {
        names.push(message.name);
      }
      if (Array.isArray(message.content)) {
        for (const blockValue of message.content) {
          const block = toRecord(blockValue);
          if (block?.type === "tool_use" && typeof block.name === "string") names.push(block.name);
        }
      }
    }
  }
  if (Array.isArray(root.input)) root.input.forEach(collectCall);

  const toolChoice = toRecord(root.tool_choice);
  const choiceFunction = toRecord(toolChoice?.function);
  if (typeof choiceFunction?.name === "string") names.push(choiceFunction.name);
  if (toolChoice?.type === "function" && typeof toolChoice.name === "string") {
    names.push(toolChoice.name);
  }
  return names;
}

function rewriteToolsCopyOnWrite(tools: unknown, aliasFor: (name: string) => string): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.map((value) => {
    const tool = toRecord(value);
    if (!tool) return value;
    let next = tool;
    const fn = toRecord(tool.function);
    if (typeof fn?.name === "string") {
      next = { ...next, function: { ...fn, name: aliasFor(fn.name) } };
    }
    if (
      typeof tool.name === "string" &&
      tool.type !== "namespace" &&
      (tool.type === "function" ||
        tool.type === "custom" ||
        tool.input_schema !== undefined ||
        tool.parameters !== undefined)
    ) {
      next = { ...next, name: aliasFor(tool.name) };
    }
    if (Array.isArray(tool.functionDeclarations)) {
      next = {
        ...next,
        functionDeclarations: tool.functionDeclarations.map((declaration) => {
          const record = toRecord(declaration);
          return record && typeof record.name === "string"
            ? { ...record, name: aliasFor(record.name) }
            : declaration;
        }),
      };
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      next = { ...next, tools: rewriteToolsCopyOnWrite(tool.tools, aliasFor) };
    }
    return next;
  });
}

/** Return a copy-on-write request plus wire -> client aliases for lowercase-only lanes. */
export function rewriteToolNamesForPolicy(
  body: unknown,
  policy: ToolNamePolicy,
  maxLength = 64
): { body: unknown; aliases: ToolNameAliasMap | null } {
  const root = toRecord(body);
  if (!root || policy !== "lowercase") return { body, aliases: null };
  const referencedNames = collectReferencedToolNames(root);
  if (referencedNames.length === 0) return { body, aliases: null };
  const { byOriginal, aliases } = buildLowercaseAliasAssignments(referencedNames, maxLength);
  const aliasFor = (name: string): string => byOriginal.get(name) ?? name;
  const result: JsonRecord = { ...root };

  if (Array.isArray(root.tools)) result.tools = rewriteToolsCopyOnWrite(root.tools, aliasFor);
  if (Array.isArray(root.messages)) {
    result.messages = root.messages.map((messageValue) => {
      const message = toRecord(messageValue);
      if (!message) return messageValue;
      let next = message;
      if (Array.isArray(message.tool_calls)) {
        next = {
          ...next,
          tool_calls: message.tool_calls.map((callValue) => {
            const call = toRecord(callValue);
            const fn = toRecord(call?.function);
            return call && typeof fn?.name === "string"
              ? { ...call, function: { ...fn, name: aliasFor(fn.name) } }
              : callValue;
          }),
        };
      }
      const functionCall = toRecord(message.function_call);
      if (typeof functionCall?.name === "string") {
        next = { ...next, function_call: { ...functionCall, name: aliasFor(functionCall.name) } };
      }
      if (
        (message.role === "function" || message.role === "tool") &&
        typeof message.name === "string"
      ) {
        next = { ...next, name: aliasFor(message.name) };
      }
      if (Array.isArray(message.content)) {
        next = {
          ...next,
          content: message.content.map((blockValue) => {
            const block = toRecord(blockValue);
            return block?.type === "tool_use" && typeof block.name === "string"
              ? { ...block, name: aliasFor(block.name) }
              : blockValue;
          }),
        };
      }
      return next;
    });
  }
  if (Array.isArray(root.input)) {
    result.input = root.input.map((itemValue) => {
      const item = toRecord(itemValue);
      return item &&
        (item.type === "function_call" || item.type === "custom_tool_call") &&
        typeof item.name === "string"
        ? { ...item, name: aliasFor(item.name) }
        : itemValue;
    });
  }

  const toolChoice = toRecord(root.tool_choice);
  const choiceFunction = toRecord(toolChoice?.function);
  if (toolChoice && typeof choiceFunction?.name === "string") {
    result.tool_choice = {
      ...toolChoice,
      function: { ...choiceFunction, name: aliasFor(choiceFunction.name) },
    };
  } else if (toolChoice?.type === "function" && typeof toolChoice.name === "string") {
    result.tool_choice = { ...toolChoice, name: aliasFor(toolChoice.name) };
  }

  return { body: result, aliases };
}

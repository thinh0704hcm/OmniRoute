/**
 * AI Horde image-generation provider entry.
 *
 * Chat still goes through oai.aihorde.net. Image jobs use the native Horde
 * async API (`/v2/generate/async`). `models` is a live getter so
 * imageRegistry stays under the file-size cap and zero-worker names are
 * never advertised.
 *
 * The catalog service (`aihordeImageCatalog.ts`) pulls in server-only deps
 * (`safeOutboundFetch` → proxy/tls + `better-sqlite3`). It must NEVER be
 * statically imported here — this module is reachable from client components
 * (MediaPageClient → imageRegistry) and a static import drags the entire
 * server graph into the Webpack client bundle → `Module not found: Can't
 * resolve 'fs' | 'module'`. On the client the getter short-circuits to
 * `[]`; on the server it loads the service via dynamic `import()`, which
 * both Webpack and Turbopack treat as a split point that excludes the
 * server graph from the client bundle. `models` stays a synchronous array
 * so the client's synchronous `toProviderModels(IMAGE_PROVIDERS)` keeps
 * working.
 */

interface ImageModelEntry {
  id: string;
  name: string;
  inputModalities: string[];
}

/**
 * Module-level cache + loader Promise for the live Horde image catalog. On
 * the server, `models` resolves the catalog once via dynamic `import()`;
 * on the client it stays `[]`. `models` is a synchronous getter — the
 * first server-side read returns `[]` and kicks off the async load, and
 * subsequent reads after it resolves return the live catalog. Await
 * `whenServerModelsReady()` to block until the catalog is populated.
 */
let cachedServerModels: ImageModelEntry[] = [];

let catalogLoaderPromise: Promise<void> | null = null;

/** Load the live catalog on the server (no-op on the client). */
function ensureServerModels(): Promise<void> {
  if (catalogLoaderPromise) return catalogLoaderPromise;
  if (typeof window !== "undefined") return Promise.resolve();
  catalogLoaderPromise = import("../../../../services/aihordeImageCatalog.ts").then(
    ({ getCachedAiHordeImageCatalogEntries }) => {
      cachedServerModels = getCachedAiHordeImageCatalogEntries().map((entry) => ({
        id: entry.id.startsWith("aihorde/") ? entry.id.slice("aihorde/".length) : entry.id,
        name: entry.name,
        inputModalities: entry.inputModalities,
      }));
    }
  );
  return catalogLoaderPromise;
}

/** Resolve once the live catalog has been loaded on the server. */
export function whenServerModelsReady(): Promise<void> {
  return ensureServerModels();
}

export const AI_HORDE_IMAGE_PROVIDER = {
  id: "aihorde",
  alias: "horde",
  baseUrl: "https://aihorde.net/api",
  authType: "apikey",
  authHeader: "apikey",
  format: "aihorde",
  get models(): ImageModelEntry[] {
    if (typeof window === "undefined") {
      void ensureServerModels();
      return cachedServerModels;
    }
    return [];
  },
  supportedSizes: ["512x512", "768x768", "1024x1024", "1024x768", "768x1024"],
};

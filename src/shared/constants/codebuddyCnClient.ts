/**
 * CodeBuddy CN (Tencent — copilot.tencent.com) client version string.
 *
 * Deliberately dependency-free. It is the single source of truth across OAuth
 * (src/lib/oauth/constants/oauth.ts), chat completions
 * (open-sse/config/providers/registry/codebuddy-cn) and usage/quota
 * (open-sse/services/usage/codebuddy-cn.ts): a version string that differs
 * between one account's auth and its chat calls is the internally-inconsistent
 * fingerprint Tencent's WAF flags as anomalous (#12702).
 *
 * It lives here, rather than in `lib/oauth/constants/oauth`, because the provider
 * registry is reachable from Client Components (via
 * src/shared/constants/cliTools.ts). Importing the OAuth constants module from a
 * registry entry drags its whole graph — including
 * `open-sse/utils/cursorAgentCliVersion` -> `node:path` — into the browser
 * bundle, which fails the production build under both Turbopack and webpack.
 */
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.108.1 CodeBuddy/2.108.1";

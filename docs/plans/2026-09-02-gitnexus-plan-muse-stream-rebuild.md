# GitNexus Engineering Plan

> Task: Surgically repair Muse Spark contributor-free streaming and routing compatibility, rebuild an immutable OmniRoute image, qualify it, and promote it to squrvq with rollback gates.
> Evidence verified at commit 004160feccab8545a02a54f71ed1166d7a7acd13; GitNexus index is at the same commit, but refresh was skipped because the repository runner is 1.4.1 while the stored index was produced by analyzer 1.6.10; no PDG layer is available.
> Evidence provenance schema 2; global dirty digest 7dd09d121d72f55a4ec00fa38ba5c6bf4732a160ceb29ddc1b9c39ac1c46749c; cited-path manifest 22 sorted entries; exact generated plan path excluded.

## 1. Objective

Keep opencode-zen/muse-spark-1.2-contributor-free as the first claude-opus-5 combo target only after all of these conditions hold:

- [verified] Anthropic streaming delivers the real Responses terminal event through translation as stop_reason end_turn with non-zero upstream usage, rather than a synthetic max_tokens / 0-token terminator.
- [verified] OpenAI Responses streaming emits exactly one response.completed event and does not end as an incomplete/disconnected SSE event.
- [verified] Muse output-budget protection mutates max_output_tokens, the actual Responses API field, and never injects max_tokens into a Responses request.
- [verified] Non-auto tool_choice semantics skip the Muse target in a combo and continue to a compatible target; OmniRoute must not coerce required, named, or none to auto.
- [verified] Both OpenCode registry aliases advertise the measured contributor-free total context window as 1,048,576 tokens; the untested paid muse-spark-1.2 metadata is left unchanged.
- [assumed] The reviewed patch is committed before image construction so the immutable image label and tag identify the exact source.

Decision: keep the free model in the chain after the canary and public gates pass. If either protocol still loses its terminal event or a non-auto tool request reaches Muse, roll back and temporarily remove only this model from the chain.

## 2. Current Behaviour

- [verified] Production squrvq routes the unprefixed claude-opus-5 combo to opencode-zen/muse-spark-1.2-contributor-free first. Direct model requests confirmed this is the contributor-free model, not the paid muse-spark-1.2.
- [verified] open-sse/executors/opencode.ts:352-462 wraps successful Muse responses. On an SSE response it emits each response.completed data line with one newline, immediately cancels the upstream reader, and closes before emitting the following empty line that terminates the SSE frame.
- [verified] open-sse/utils/stream.ts:1227-1231 feeds those lines to the multiline SSE normalizer. The normalizer holds the terminal data until a blank delimiter. At EOF, stream.ts:2281-2285 drains the held frame into normalizedTailLines and clears buffer, but the translate branch at stream.ts:2668 onward reads only buffer. The response.completed payload and its usage are therefore dropped on Responses-to-Claude translation.
- [verified] open-sse/utils/streamHandler.ts:591-597 then closes a Claude stream that has visible text but no translated terminal and synthesizes stop_reason max_tokens with zero usage. The 128,000 value in Claude Code's message is its configured output ceiling, not evidence of a 128K context window.
- [verified] Direct live probes against https://squrvq.tail0bec0f.ts.net reproduced this six of six times on /v1/messages and on the claude-opus-5 combo: visible OK text followed by synthetic max_tokens and usage 0/0.
- [verified] Direct and combo /v1/responses probes completed successfully six of six times with real usage. The previously reported Codex disconnect was not reproduced; the only matching production call log was HTTP 499 Request aborted, which identifies a client abort, not a provider-side length limit.
- [verified] The free model accepted max_output_tokens 8,192 at approximately 1,040,017 reported input tokens and rejected requests once combined allowance crossed approximately 1,048,576. It also accepted 200K, 300K, 500K, 800K, and 1M-class inputs. The dirty 131,072 and 200,000 registry edits are contradicted by the endpoint.
- [verified] A 190K-class prompt with max_output_tokens 512 produced an empty 502 once, while the same request at 8,192 completed. Hidden reasoning can exhaust a small output budget even though the context window is much larger.
- [verified] Muse accepts only tool_choice auto. Direct Anthropic and OpenAI-protocol probes returned HTTP 400 for none, required, and named choices; fourteen stored failures included named web_search.
- [verified] deriveRequestCompatibilityRequirements in open-sse/services/combo/comboStructure.ts:500-518 reads max_tokens and max_completion_tokens but ignores Responses max_output_tokens.
- [verified] computeCompatRejectedTargets at comboStructure.ts:564-574 only permanently excludes vision mismatches. Its last-resort tier can resurrect another hard mismatch, so a known non-auto tool-choice mismatch needs an explicit non-resurrection rule.

## 3. Relevant Architecture

- [verified] Model-specific targetFormat openai-responses is declared in both OpenCode registry entries. OpencodeExecutor resolves this before BaseExecutor dispatch and therefore receives a Responses-shaped body.
- [verified] The request path is combo target resolution -> filterTargetsByRequestCompatibility -> handleSingleModel -> chatCore translation -> OpencodeExecutor -> upstream Responses SSE -> createSSEStream translation/passthrough -> disconnect-aware terminal validation.
- [verified] RegistryModel in open-sse/config/providers/shared.ts is the provider-scoped metadata contract. open-sse/config/providerModels.ts already resolves raw provider IDs to aliases for exact model metadata such as targetFormat.
- [verified] comboStructure.ts centralizes request-shape derivation, hard compatibility reasons, fail-closed behavior, exhaustion diagnostics, and construction of the last-resort compatibility tier.
- [verified] scripts/ops/oracle-deploy.mjs qualifies immutable images in the isolated omniroute-canary, then scripts/ops/oracleDeploy.ts promotes only after backups, local gates, public gates, and rollback tagging. Production is omniroute-parallel behind squrvq.
- [inferred] The narrowest safe runtime repair is to make the OpenCode wrapper emit a complete terminal SSE frame. Modifying shared createSSEStream is unnecessary for this provider repair and would expose every streaming provider to a larger regression surface.

## 4. GitNexus Findings

- [graph] mcp__gitnexus__context(name=normalizeMuseSparkResponse,file_path=open-sse/executors/opencode.ts) found one production caller, OpencodeExecutor.execute, and no indexed process membership. Result: epistemic exact.
- [graph] mcp__gitnexus__impact(target_uid=Method:open-sse/executors/opencode.ts:OpencodeExecutor.normalizeMuseSparkResponse#2,direction=upstream,maxDepth=3,summaryOnly=true) reported 9 impacted symbols, LOW risk, one direct caller, and one module.
- [graph] The depth-1 accounting for normalizeMuseSparkResponse is complete: OpencodeExecutor.execute is the sole direct dependent.
- [graph] mcp__gitnexus__context(name=createSSEStream,file_path=open-sse/utils/stream.ts) found five direct callers spanning logger wrappers and tests.
- [graph] mcp__gitnexus__impact(target_uid=Function:open-sse/utils/stream.ts:createSSEStream,direction=upstream,maxDepth=3,summaryOnly=true) reported 25 impacted symbols, CRITICAL risk, five modules, and the handleChatCore process.
- [graph] The depth-1 accounting for createSSEStream is complete: createPassthroughStreamWithLogger, createSSETransformStreamWithLogger, tests/unit/stream-passthrough-usage-estimation.test.ts, tests/integration/sse-correctness.test.ts::makeStream, and tests/unit/claude-stream-reconstructed-body.test.ts::processClaudeStream.
- [graph] mcp__gitnexus__query(search_query="tool_choice forced named required unsupported model combo fallback target eligibility") identified getTargetCompatibilityFailures and describeCapabilityFilterExhaustion as the established compatibility path.
- [graph] mcp__gitnexus__impact(target_uid=Function:open-sse/services/combo/comboStructure.ts:getTargetCompatibilityFailures,direction=upstream,maxDepth=3,summaryOnly=true) reported 6 impacted symbols, HIGH aggregate risk, and the handleRoundRobinCombo process.
- [graph] The depth-1 accounting for getTargetCompatibilityFailures is complete: filterTargetsByRequestCompatibility and describeCapabilityFilterExhaustion are its two direct dependents.
- [graph] mcp__gitnexus__trace from applyContinuityFilters to getTargetCompatibilityFailures returned a two-hop path through describeCapabilityFilterExhaustion with 0.85-confidence CALLS edges.
- [graph] GitNexus query/resource process discovery found the routing symbols but its cluster/process resource wrapper did not yield usable structured cluster metadata; source and symbol-level graph evidence therefore carry the plan.
- [graph] Index freshness is commit-current but analyzer provenance is stale relative to the local runner. No graph result is treated as stronger than the source reads above.

## 5. Statement-Level PDG Findings

No PDG layer is indexed. mcp__gitnexus__pdg_query reported no PDG layer and requested gitnexus analyze --pdg. Refresh was not attempted because the local 1.4.1 runner does not match the stored 1.6.10 analyzer provenance. The following ordering constraints are source-verified, not represented as PDG claims:

- [verified] In OpencodeExecutor.normalizeMuseSparkResponse, terminal detection occurs after the data line is enqueued but before the empty delimiter is forwarded. reader.cancel and controller.close are the terminal side effects; the delimiter must be emitted before both.
- [verified] The wrapper's closed flag prevents duplicate closure and must continue to suppress post-completion ping frames.
- [verified] BaseExecutor dispatch receives a mutable target-format request body. The Muse budget helper runs before every direct/rotated dispatch, so it must be idempotent and must touch only max_output_tokens for Muse IDs.
- [verified] In stream.ts flush, multilineSseDataLineNormalizer.normalize mutates its pending-frame state and transfers the terminal payload to normalizedTailLines. Because translate mode ignores that array, repairing the provider's frame boundary upstream is sufficient for this path without changing the shared flush state machine.
- [verified] In comboStructure, deriveRequestCompatibilityRequirements feeds getTargetCompatibilityFailures, which feeds both filtering and exhaustion diagnostics. The same canonical tool-choice classification must be reused for filtering, diagnostics, compatFilterFailOpen, and last-resort non-resurrection.
- [verified] applyContinuityFilters runs compatibility filtering before dispatch. A Muse target excluded there consumes no provider request and permits the remaining priority chain to proceed.

## 6. Proposed Changes

### 6.1 Correct provider-scoped capability metadata

- File: open-sse/config/providers/shared.ts
- Symbol: RegistryModel
- [verified] Add an optional, canonical supported-tool-choice-modes field whose vocabulary is auto, none, required, and named. This describes semantic support without abusing unsupportedParams, which would strip the field and silently change caller intent.
- Constraint: omitted means unknown, not unrestricted.

- File: open-sse/config/providerModels.ts
- Symbols: getProviderModels and the existing exact provider/model lookup pattern used by getModelTargetFormat
- [verified] Add a provider-alias-aware getter for the new modes. It must strip a provider prefix exactly and must not borrow a duplicate model's metadata from another provider via global fuzzy lookup.
- Constraint: return null/undefined for unknown metadata so existing models keep current behavior.

- Files: open-sse/config/providers/registry/opencode/index.ts and open-sse/config/providers/registry/opencode/zen/index.ts
- Symbols: opencodeProvider and opencode_zenProvider contributor-free model rows
- [verified] Set contextLength to 1_048_576 and the supported modes to auto only for muse-spark-1.2-contributor-free.
- [verified] Remove the dirty speculative contextLength values from paid muse-spark-1.2; it was not tested. Preserve targetFormat openai-responses and supportsReasoning.

### 6.2 Repair the Muse Responses wrapper

- File: open-sse/executors/opencode.ts
- Symbols: MUSE_SPARK_MIN_OUTPUT_TOKENS, applyMuseSparkMinOutputTokens, normalizeMuseSparkResponse, OpencodeExecutor.execute
- [verified] Set the provider-specific floor to 8,192, the currently verified passing budget for both a 190K prompt and the 1.04M boundary probe.
- [verified] Read and write max_output_tokens only. Preserve a missing/non-numeric field rather than synthesizing max_tokens or an unsolicited budget; leave non-Muse requests untouched.
- [verified] Remove the Chat-Completions-shaped length/usage rewrite path from the Muse wrapper. This model is dispatched as Responses, so choices[].finish_reason and completion_tokens rewrites are no-ops and their current comments encode the disproven 128K theory.
- [verified] Preserve non-streaming JSON byte-for-byte.
- [verified] For streaming SSE, emit every line unchanged. When response.completed is detected, emit the terminating blank line, then cancel the upstream reader and close. Apply the same complete-frame rule when the terminal data line arrives as the final unterminated buffer at EOF.
- Constraint: emit response.completed once, suppress all post-terminal pings, preserve response usage, retain abort/cancel cleanup, and do not buffer the entire stream.

### 6.3 Make combo compatibility protocol-aware

- File: open-sse/services/combo/comboStructure.ts
- Symbols: RequestCompatibilityRequirements, deriveRequestCompatibilityRequirements, getTargetCompatibilityFailures, HARD_COMPAT_REASONS, describeCapabilityFilterExhaustion, filterTargetsByRequestCompatibility, computeCompatRejectedTargets
- [verified] Include max_output_tokens when deriving requestedOutputTokens so Responses requests participate in output and context checks.
- [verified] Canonicalize tool_choice from supported client shapes: omitted -> no constraint; auto/string or type:auto -> auto; none -> none; required/type:any -> required; named function/tool objects -> named. Unknown malformed shapes remain unclassified and continue to downstream validation.
- [verified] Compare a classified mode with provider-scoped model metadata. Add tool_choice as a hard failure only when support is explicitly known and excludes the requested mode.
- [verified] Add a specific capability-mismatch diagnostic for tool-choice semantics without echoing the tool name or request payload.
- [verified] Never let compatFilterFailOpen or computeCompatRejectedTargets resurrect a target with an explicit tool_choice mismatch. Keep existing handling for unrelated compatibility reasons unchanged.
- Constraint: auto and omitted requests keep Muse eligible; forced/none requests keep the fallback chain order after Muse is removed; a Muse-only combo fails before provider dispatch with sanitized HTTP 400 capability_mismatch.

### 6.4 Keep the shared streaming hub unchanged

- File intentionally unchanged: open-sse/utils/stream.ts
- [graph] createSSEStream is a CRITICAL hub with 25 upstream dependents.
- [inferred] The translate-mode normalizedTailLines gap remains a valid follow-up hardening candidate, but it is not needed once the provider emits a valid SSE frame. Record it in section 12 rather than expanding this patch.

## 7. Implementation Sequence

1. Re-anchor the dirty overlap. Verify the section 11 provenance before editing. Preserve AGENTS.md, CLAUDE.md, docs/llms.txt, and unrelated .commandcode content. Treat the current four Muse-related unstaged files as user work to reconcile, not overwrite: retain the intent to fix Muse, replace only the disproven 131,072/200,000 metadata and max_tokens synthesis.
2. Update the two registry tests first, then extend RegistryModel and the provider-scoped getter and correct both contributor-free rows. Assert paid muse-spark-1.2 remains without a newly invented context limit.
3. In the existing Muse executor test file, add exact Responses-body and SSE-frame regressions, then update applyMuseSparkMinOutputTokens and normalizeMuseSparkResponse in one coherent change.
4. Extend the same test to pipe the wrapper output through createSSEStream in Responses-to-Claude translate mode. Require one message_delta with end_turn, real input/output usage, one message_stop, and no synthetic max_tokens. Also require the direct Responses stream to contain exactly one response.completed and zero ping events.
5. Add table-driven combo tests for Anthropic, Chat Completions, and Responses tool_choice shapes. Then update comboStructure's canonical classification, output-budget derivation, filtering, diagnostics, fail-open behavior, and last-resort pool construction.
6. Run Prettier on only changed source/test files. Run focused tests, typecheck, cycle check, full lint, both non-overlapping test runners, then build:release. Stop on the first failure and do not create a candidate image.
7. Commit the reviewed patch so the candidate has an exact source identity. Require a clean tree before image creation; user-owned instruction changes must either be intentionally included in that commit or left out of the deployment checkout, never silently swept into the image.
8. Build a runner-base image with org.opencontainers.image.revision equal to the 12-character candidate commit and an immutable tag such as omniroute:muse-stream-<sha12>. Inspect the label, then transfer the exact image to oracle-vps with docker save piped to docker load; compare image IDs on both hosts.
9. Export OMNIROUTE_SMOKE_API_KEY from the already reviewed local credential source without printing it. Run oracle-deploy status, then qualify the candidate with both opencode-zen/muse-spark-1.2-contributor-free and claude-opus-5 as explicit models.
10. Promote only after qualification succeeds. The orchestrator must capture the database/config/gateway backups and tag omniroute:rollback-canary before recreating omniroute-parallel.
11. Against public squrvq, run the exact direct and combo Anthropic/Responses streaming probes used in diagnosis. Check health, container status, revision/image identity, call logs, and logs filtered with grep -i "error\|fatal\|exception". If any acceptance gate fails, run the repository rollback command immediately.
12. Observe at least three direct and three combo successes per protocol after cutover. Keep Muse in the chain only if terminal counts, usage, selected target behavior, and client completion all pass.

## 8. Test Strategy

### Focused automated tests

- tests/unit/opencode-muse-spark-min-output.test.ts
  - max_output_tokens 64 -> helper -> 8,192; max_tokens is absent.
  - max_output_tokens at/above floor -> unchanged.
  - missing/non-numeric budget -> no synthesized field.
  - non-Muse request -> unchanged.
  - non-streaming Responses JSON -> byte-equivalent payload.
  - terminal split across chunks and terminal at EOF -> complete response.completed frame.
  - response.completed followed by ping -> exactly one terminal, no ping, prompt/output usage preserved.
  - wrapper -> createSSEStream Responses-to-Claude -> end_turn, real usage, one message_stop, no max_tokens.

- tests/unit/opencode-muse-spark-responses-10867.test.ts
  - base OpenCode free row -> targetFormat openai-responses, context 1,048,576, tool-choice modes auto only.
  - paid row -> no new context claim.

- tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts
  - Zen overlay has the identical verified free-row metadata and keeps the paid row unclaimed.

- tests/unit/combo-context-window-filter.test.ts
  - Responses max_output_tokens is included in requestedOutputTokens and requiredContextTokens.
  - A known output cap smaller than max_output_tokens hard-filters the target.
  - Context ordering uses input estimate plus Responses output reserve without changing advisory context behavior.

- tests/unit/8488-capability-filter-fail-closed.test.ts
  - omitted/auto tool_choice keeps Muse.
  - OpenAI none/required/named and Anthropic any/tool exclude Muse and retain a compatible second target.
  - compatFilterFailOpen does not restore Muse for an explicit mode mismatch.
  - computeCompatRejectedTargets does not put Muse into the last-resort tier.
  - Muse-only forced choice returns sanitized capability_mismatch with zero dispatches.

### Existing regression boundaries

- [verified] tests/unit/stream-utils.test.ts covers Responses passthrough completion and usage summaries.
- [verified] tests/unit/silent-sse-close-responses-no-terminal.test.ts proves that a real response.completed prevents a synthetic response.failed close.
- [verified] Existing #8488 tests cover tools/vision/structured-output fail-closed behavior and must remain green.

### Verification commands

1. node --import tsx/esm --test tests/unit/opencode-muse-spark-min-output.test.ts tests/unit/opencode-muse-spark-responses-10867.test.ts tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts tests/unit/combo-context-window-filter.test.ts tests/unit/8488-capability-filter-fail-closed.test.ts
2. npm run typecheck:core
3. npm run check:cycles
4. npm run lint
5. npm run test:unit
6. npm run test:vitest
7. npm run build:release
8. docker build --target runner-base --build-arg OMNIROUTE_BUILD_SHA=<sha12> --tag omniroute:muse-stream-<sha12> .
9. docker image inspect omniroute:muse-stream-<sha12> --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{.Id}}'
10. docker save omniroute:muse-stream-<sha12> | ssh oracle-vps docker load
11. node --import tsx/esm scripts/ops/oracle-deploy.mjs status
12. node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --image omniroute:muse-stream-<sha12> --sha <sha12> --model opencode-zen/muse-spark-1.2-contributor-free --model claude-opus-5
13. node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --image omniroute:muse-stream-<sha12> --sha <sha12> --model opencode-zen/muse-spark-1.2-contributor-free --model claude-opus-5
14. ssh oracle-vps docker logs --since=15m omniroute-parallel | grep -i "error\|fatal\|exception"
15. Rollback to the previous known-good image: node --import tsx/esm scripts/ops/oracle-deploy.mjs rollback

### Public protocol gates

- Anthropic direct and claude-opus-5 combo: HTTP 200; visible text; exactly one message_stop; message_delta.stop_reason=end_turn; input_tokens and output_tokens greater than zero; no max_tokens.
- Responses direct and combo: HTTP 200; exactly one response.completed; response.status=completed; real usage; no response.failed; no post-terminal ping delivered.
- Forced named tool direct: expected upstream HTTP 400 remains honest.
- Forced named/required/none tool through claude-opus-5 combo: Muse has zero call-log attempts; a compatible later target is selected or the combo returns pre-dispatch capability_mismatch if none exists.
- Context metadata: authenticated /v1/models reports the contributor-free row at 1,048,576. Do not repeat the million-token load probe during every deployment.

## 9. Risk and Impact Analysis

- [graph] OpencodeExecutor.normalizeMuseSparkResponse: LOW graph risk; its sole direct dependent is OpencodeExecutor.execute. Risk is SSE ordering, cancellation, and duplicate terminal emission. Mitigate with chunk-boundary, EOF, ping, passthrough, and translated-Claude tests.
- [graph] getTargetCompatibilityFailures: HIGH depth-3 graph risk because it reaches handleRoundRobinCombo. Its direct dependents are filterTargetsByRequestCompatibility and describeCapabilityFilterExhaustion; both receive explicit tests.
- [graph] createSSEStream: CRITICAL and intentionally unchanged. Its five direct callers are accounted for in section 4; the new executor integration test exercises it without changing it.
- [verified] Registry metadata is duplicated under opencode and opencode-zen. Both rows and both tests must change together to prevent alias-dependent routing.
- [verified] The new tool-choice field is optional. Unknown models preserve current behavior, avoiding a global fail-closed regression.
- [verified] The 8,192 floor changes explicit tiny Muse output budgets and can reduce the remaining input allowance near the 1,048,576 boundary. The measured 1,040,017 + 8,192 request passed; the test must ensure the helper does not synthesize a budget when absent.
- [inferred] Early cancel after a fully framed response.completed remains necessary because the upstream sends post-completion pings and may hold the HTTP connection open.
- [verified] No database migration, transaction, or persistent runtime-state mutation is required.
- [verified] Deployment mutates production only through the existing locked qualifier/promoter, which records backups and rollback image identity first.
- [assumed] The build host has enough memory for runner-base. If the default Turbopack build is OOM-killed, use the documented OMNIROUTE_USE_TURBOPACK=0 build argument on an adequately sized build host; do not weaken test gates.

## 10. Files Expected to Change

| File                                                          | Symbols                                                                                                                                      | Reason                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| open-sse/config/providers/shared.ts                           | RegistryModel                                                                                                                                | Represent provider-scoped canonical tool-choice support.               |
| open-sse/config/providerModels.ts                             | getProviderModels / exact model metadata getter pattern                                                                                      | Resolve the new metadata without cross-provider leakage.               |
| open-sse/config/providers/registry/opencode/index.ts          | opencodeProvider Muse rows                                                                                                                   | Correct the free window/modes and remove the unverified paid limit.    |
| open-sse/config/providers/registry/opencode/zen/index.ts      | opencode_zenProvider Muse rows                                                                                                               | Keep the Zen overlay identical for verified free metadata.             |
| open-sse/executors/opencode.ts                                | MUSE_SPARK_MIN_OUTPUT_TOKENS, applyMuseSparkMinOutputTokens, normalizeMuseSparkResponse, execute                                             | Use the Responses budget field and emit a complete terminal SSE frame. |
| open-sse/services/combo/comboStructure.ts                     | RequestCompatibilityRequirements, deriveRequestCompatibilityRequirements, getTargetCompatibilityFailures, filter/diagnostic/fallback helpers | Add Responses budget parity and non-auto tool-choice filtering.        |
| tests/unit/opencode-muse-spark-min-output.test.ts             | Muse executor regressions                                                                                                                    | Prove body shape, framing, deduplication, and Claude translation.      |
| tests/unit/opencode-muse-spark-responses-10867.test.ts        | base registry assertions                                                                                                                     | Lock verified base metadata.                                           |
| tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts | Zen registry assertions                                                                                                                      | Lock verified Zen metadata.                                            |
| tests/unit/combo-context-window-filter.test.ts                | Responses compatibility cases                                                                                                                | Lock max_output_tokens parity.                                         |
| tests/unit/8488-capability-filter-fail-closed.test.ts         | hard compatibility cases                                                                                                                     | Lock tool-choice skip, fail-closed, and non-resurrection behavior.     |

No change is planned for open-sse/utils/stream.ts, open-sse/utils/streamHandler.ts, comboCompatFallback.ts, targetResolution.ts, deployment scripts, AGENTS.md, CLAUDE.md, docs/llms.txt, or user credentials.

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Repair Muse contributor-free terminal SSE framing, Responses output budgeting, context metadata, and combo tool-choice compatibility; then rebuild and safely promote squrvq."
  acceptance_criteria:
    - "Anthropic direct/combo streams end once with end_turn and real usage."
    - "Responses direct/combo streams emit exactly one response.completed."
    - "Muse request bodies use max_output_tokens and never add max_tokens."
    - "Non-auto tool_choice skips Muse without semantic coercion or last-resort resurrection."
    - "Contributor-free context metadata is 1048576 under both OpenCode aliases; paid metadata is not invented."
    - "Focused tests, typecheck, cycles, lint, test:unit, test:vitest, build:release, image qualification, public probes, and rollback anchor all pass."
  evidence_provenance:
    schema_version: 2
    head_commit: "004160feccab8545a02a54f71ed1166d7a7acd13"
    generated_plan_path: "docs/plans/2026-09-02-gitnexus-plan-muse-stream-rebuild.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "7dd09d121d72f55a4ec00fa38ba5c6bf4732a160ceb29ddc1b9c39ac1c46749c"
    cited_path_manifest:
      - path: "Dockerfile"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:ec0536caa43cbb8c16ad8a923fd87c23faaeb1c3a3dda5ee6cf5c6b5838afe5e"
        index_digest: "sha256:ec0536caa43cbb8c16ad8a923fd87c23faaeb1c3a3dda5ee6cf5c6b5838afe5e"
        worktree_digest: "sha256:ec0536caa43cbb8c16ad8a923fd87c23faaeb1c3a3dda5ee6cf5c6b5838afe5e"
        untracked_digest: "absent"
      - path: "contrib/vps/compose.oracle.yaml"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:e4ed0e4a59cfd0e31c19ca4a05391539c5fb46a0fa546a611b98a95d4118f695"
        index_digest: "sha256:e4ed0e4a59cfd0e31c19ca4a05391539c5fb46a0fa546a611b98a95d4118f695"
        worktree_digest: "sha256:e4ed0e4a59cfd0e31c19ca4a05391539c5fb46a0fa546a611b98a95d4118f695"
        untracked_digest: "absent"
      - path: "open-sse/config/providerModels.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:16baa72fe1b9aadad8f848bd05a79a8b51085ae133515a8f32328d1cd24ac477"
        index_digest: "sha256:16baa72fe1b9aadad8f848bd05a79a8b51085ae133515a8f32328d1cd24ac477"
        worktree_digest: "sha256:16baa72fe1b9aadad8f848bd05a79a8b51085ae133515a8f32328d1cd24ac477"
        untracked_digest: "absent"
      - path: "open-sse/config/providers/registry/opencode/index.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "unstaged"
        rename_from: null
        rename_to: null
        head_digest: "sha256:d7de7d4b4f5ee6c2720d121a95350ac3f9b575b69112366e1e3093062e3a6482"
        index_digest: "sha256:d7de7d4b4f5ee6c2720d121a95350ac3f9b575b69112366e1e3093062e3a6482"
        worktree_digest: "sha256:35718f22cd7074815d727d0a0e61d81d7681583a3cfc570f9961b5e4e060df19"
        untracked_digest: "absent"
      - path: "open-sse/config/providers/registry/opencode/zen/index.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "unstaged"
        rename_from: null
        rename_to: null
        head_digest: "sha256:0cafb508fb0dc2c1bec3d03cb6b55a7e56d01e5ebdfa9e54be1a574901877309"
        index_digest: "sha256:0cafb508fb0dc2c1bec3d03cb6b55a7e56d01e5ebdfa9e54be1a574901877309"
        worktree_digest: "sha256:2a86aa6f16ec563c5ab859955e73440a4bc5d3b62ea603067654a63796f7ed90"
        untracked_digest: "absent"
      - path: "open-sse/config/providers/shared.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:d9124a70179123bfeb94f4d5d93c94fb8ca8c651ab8f44a231483bdfc689fbb5"
        index_digest: "sha256:d9124a70179123bfeb94f4d5d93c94fb8ca8c651ab8f44a231483bdfc689fbb5"
        worktree_digest: "sha256:d9124a70179123bfeb94f4d5d93c94fb8ca8c651ab8f44a231483bdfc689fbb5"
        untracked_digest: "absent"
      - path: "open-sse/executors/opencode.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "unstaged"
        rename_from: null
        rename_to: null
        head_digest: "sha256:983e76ce9d733f6aea275603408801e34275e6145df95c4b81e9d152d4d9b441"
        index_digest: "sha256:983e76ce9d733f6aea275603408801e34275e6145df95c4b81e9d152d4d9b441"
        worktree_digest: "sha256:fae07e98afc3f3ab66399f44c62e3aa7fb1a5ed01b19dfc08a0104637ca2ca33"
        untracked_digest: "absent"
      - path: "open-sse/services/combo/comboCompatFallback.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:50ae6abe1b93234252eef221f974e668b0c1fdf10321eba19683caa577fa7b8d"
        index_digest: "sha256:50ae6abe1b93234252eef221f974e668b0c1fdf10321eba19683caa577fa7b8d"
        worktree_digest: "sha256:50ae6abe1b93234252eef221f974e668b0c1fdf10321eba19683caa577fa7b8d"
        untracked_digest: "absent"
      - path: "open-sse/services/combo/comboStructure.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:93240eab1103d3d02110764633056b79192eb37b0565094acf3446d2a8d4ad90"
        index_digest: "sha256:93240eab1103d3d02110764633056b79192eb37b0565094acf3446d2a8d4ad90"
        worktree_digest: "sha256:93240eab1103d3d02110764633056b79192eb37b0565094acf3446d2a8d4ad90"
        untracked_digest: "absent"
      - path: "open-sse/services/combo/targetResolution.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:ba63e36ef2ff2ed7b736c512a7ce7f2a1cf9e9c8002a2cfd8896257d00a556a4"
        index_digest: "sha256:ba63e36ef2ff2ed7b736c512a7ce7f2a1cf9e9c8002a2cfd8896257d00a556a4"
        worktree_digest: "sha256:ba63e36ef2ff2ed7b736c512a7ce7f2a1cf9e9c8002a2cfd8896257d00a556a4"
        untracked_digest: "absent"
      - path: "open-sse/utils/stream.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:ae05538775b6ab362f9984bb480605fd4b28505ab7c46d8f61c5743702bb620b"
        index_digest: "sha256:ae05538775b6ab362f9984bb480605fd4b28505ab7c46d8f61c5743702bb620b"
        worktree_digest: "sha256:ae05538775b6ab362f9984bb480605fd4b28505ab7c46d8f61c5743702bb620b"
        untracked_digest: "absent"
      - path: "open-sse/utils/streamHandler.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:a0f9d78804381d8ebef34d942246cf9ed2b16fd63fd53cdc187aa9a6f4c2fd4d"
        index_digest: "sha256:a0f9d78804381d8ebef34d942246cf9ed2b16fd63fd53cdc187aa9a6f4c2fd4d"
        worktree_digest: "sha256:a0f9d78804381d8ebef34d942246cf9ed2b16fd63fd53cdc187aa9a6f4c2fd4d"
        untracked_digest: "absent"
      - path: "package.json"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:1162f1bd192e000983403e81a99446713790011081f317f353299740bd1bc1e1"
        index_digest: "sha256:1162f1bd192e000983403e81a99446713790011081f317f353299740bd1bc1e1"
        worktree_digest: "sha256:1162f1bd192e000983403e81a99446713790011081f317f353299740bd1bc1e1"
        untracked_digest: "absent"
      - path: "scripts/ops/oracle-deploy.mjs"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:a38d505727c21141464ea580c2e5e31d4c5b1392f067ffcd508dbeaf7eb54c6f"
        index_digest: "sha256:a38d505727c21141464ea580c2e5e31d4c5b1392f067ffcd508dbeaf7eb54c6f"
        worktree_digest: "sha256:a38d505727c21141464ea580c2e5e31d4c5b1392f067ffcd508dbeaf7eb54c6f"
        untracked_digest: "absent"
      - path: "scripts/ops/oracleDeploy.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:af90b55f21b33e9b45a5928f7f73638607c2e4d05ae3d537eedd2a4a3fc2e40f"
        index_digest: "sha256:af90b55f21b33e9b45a5928f7f73638607c2e4d05ae3d537eedd2a4a3fc2e40f"
        worktree_digest: "sha256:af90b55f21b33e9b45a5928f7f73638607c2e4d05ae3d537eedd2a4a3fc2e40f"
        untracked_digest: "absent"
      - path: "tests/unit/8488-capability-filter-fail-closed.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:5d767df360f73cb2550d38d0948593d212f9ec370c5a872ef06b0afc36944169"
        index_digest: "sha256:5d767df360f73cb2550d38d0948593d212f9ec370c5a872ef06b0afc36944169"
        worktree_digest: "sha256:5d767df360f73cb2550d38d0948593d212f9ec370c5a872ef06b0afc36944169"
        untracked_digest: "absent"
      - path: "tests/unit/combo-context-window-filter.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:a5eba4dba960c80980a7b030c3a37942871bd95e0e70572a81ba73af8b3cffa5"
        index_digest: "sha256:a5eba4dba960c80980a7b030c3a37942871bd95e0e70572a81ba73af8b3cffa5"
        worktree_digest: "sha256:a5eba4dba960c80980a7b030c3a37942871bd95e0e70572a81ba73af8b3cffa5"
        untracked_digest: "absent"
      - path: "tests/unit/opencode-muse-spark-min-output.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "unstaged"
        rename_from: null
        rename_to: null
        head_digest: "sha256:96b2d2d8f62006e55ffa4fc29ef3091870f855569a05c852d83d28a009e308e5"
        index_digest: "sha256:96b2d2d8f62006e55ffa4fc29ef3091870f855569a05c852d83d28a009e308e5"
        worktree_digest: "sha256:52a4e611a9a0cf1b1d655080920bcd71ee5f6668f462feed77ce830002ba67d8"
        untracked_digest: "absent"
      - path: "tests/unit/opencode-muse-spark-responses-10867.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:37753b0ed198db1f7e3033af7bb4db43907956efa32911128306cf3f91f88d0e"
        index_digest: "sha256:37753b0ed198db1f7e3033af7bb4db43907956efa32911128306cf3f91f88d0e"
        worktree_digest: "sha256:37753b0ed198db1f7e3033af7bb4db43907956efa32911128306cf3f91f88d0e"
        untracked_digest: "absent"
      - path: "tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:527344425cf26e8eb494989049d691588f8e921afbf18054fb82f2e11da2b72c"
        index_digest: "sha256:527344425cf26e8eb494989049d691588f8e921afbf18054fb82f2e11da2b72c"
        worktree_digest: "sha256:527344425cf26e8eb494989049d691588f8e921afbf18054fb82f2e11da2b72c"
        untracked_digest: "absent"
      - path: "tests/unit/silent-sse-close-responses-no-terminal.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:9d62f24649a49034a58c21bfc5d57d3954f97ca0d3ab8c855ec546abc3561783"
        index_digest: "sha256:9d62f24649a49034a58c21bfc5d57d3954f97ca0d3ab8c855ec546abc3561783"
        worktree_digest: "sha256:9d62f24649a49034a58c21bfc5d57d3954f97ca0d3ab8c855ec546abc3561783"
        untracked_digest: "absent"
      - path: "tests/unit/stream-utils.test.ts"
        object_kind: { head: "regular", index: "regular", worktree: "regular", untracked: "absent" }
        state: "clean"
        rename_from: null
        rename_to: null
        head_digest: "sha256:85cc3f6f0a08356c006807400ef1581be0a7b9012ed5a5b6d142543d941bb43f"
        index_digest: "sha256:85cc3f6f0a08356c006807400ef1581be0a7b9012ed5a5b6d142543d941bb43f"
        worktree_digest: "sha256:85cc3f6f0a08356c006807400ef1581be0a7b9012ed5a5b6d142543d941bb43f"
        untracked_digest: "absent"
  primary_symbols:
    - symbol: "OpencodeExecutor.normalizeMuseSparkResponse"
      file: "open-sse/executors/opencode.ts"
      lines: "352-462"
      role: "Provider-scoped SSE wrapper whose early close currently leaves response.completed unterminated."
    - symbol: "applyMuseSparkMinOutputTokens"
      file: "open-sse/executors/opencode.ts"
      lines: "174-183"
      role: "Provider output-budget guard currently keyed to the wrong protocol field."
    - symbol: "deriveRequestCompatibilityRequirements"
      file: "open-sse/services/combo/comboStructure.ts"
      lines: "500-518"
      role: "Canonical request-shape derivation for combo filtering."
    - symbol: "getTargetCompatibilityFailures"
      file: "open-sse/services/combo/comboStructure.ts"
      lines: "576-619"
      role: "Per-target hard compatibility classifier."
    - symbol: "filterTargetsByRequestCompatibility"
      file: "open-sse/services/combo/comboStructure.ts"
      lines: "709-821"
      role: "Pre-dispatch fail-closed filter for every combo strategy."
    - symbol: "computeCompatRejectedTargets"
      file: "open-sse/services/combo/comboStructure.ts"
      lines: "564-574"
      role: "Builds last-resort targets and must not resurrect explicit semantic mismatches."
  related_symbols:
    - symbol: "OpencodeExecutor.execute"
      relationship: "CALLS normalizeMuseSparkResponse"
      relevance: "Sole direct production caller; budget helper runs before all OpenCode dispatch paths."
    - symbol: "createSSEStream"
      relationship: "Consumes wrapped provider SSE"
      relevance: "Translation hub exercised by tests but intentionally not edited."
    - symbol: "applyContinuityFilters"
      relationship: "CALLS filterTargetsByRequestCompatibility"
      relevance: "Ensures incompatible targets are removed before dispatch."
    - symbol: "describeCapabilityFilterExhaustion"
      relationship: "CALLS getTargetCompatibilityFailures"
      relevance: "Produces the pre-dispatch sanitized 400 when no compatible target remains."
    - symbol: "attemptCompatRejectedFallback"
      relationship: "Consumes computeCompatRejectedTargets output"
      relevance: "Must never receive a target excluded for explicit tool-choice semantics."
  execution_path:
    - "claude-opus-5 combo resolves the Muse contributor-free target first."
    - "Compatibility filtering classifies request budget and tool-choice semantics before dispatch."
    - "chatCore translates Anthropic/OpenAI input to the model's openai-responses target format."
    - "OpencodeExecutor applies a Responses output floor and dispatches to the Zen /responses endpoint."
    - "The Muse wrapper forwards a fully delimited response.completed frame, cancels post-terminal pings, and closes."
    - "createSSEStream translates that terminal to Claude end_turn or passes it once to Responses clients."
    - "Disconnect-aware handling observes a real terminal and does not synthesize failure/max_tokens."
  pdg_constraints:
    - description: "No PDG layer available; source-verified ordering requires blank delimiter before cancel/close."
      affected_statements:
        ["open-sse/executors/opencode.ts:429", "open-sse/executors/opencode.ts:435"]
      implementation_consequence: "Keep provider fix line-streaming and emit the empty delimiter before cancellation."
    - description: "Compatibility classification must be reused by filtering, diagnostics, fail-open, and rejected-tier construction."
      affected_statements:
        [
          "open-sse/services/combo/comboStructure.ts:576",
          "open-sse/services/combo/comboStructure.ts:709",
        ]
      implementation_consequence: "One canonical mode classifier; no separate executor coercion."
  architectural_patterns:
    - pattern: "Provider-scoped model metadata"
      example_location: "open-sse/config/providerModels.ts::getModelTargetFormat"
      usage_guidance: "Resolve provider alias and exact bare model ID; do not use global fuzzy fallback for quirks."
    - pattern: "Fail-closed combo compatibility"
      example_location: "open-sse/services/combo/comboStructure.ts::filterTargetsByRequestCompatibility"
      usage_guidance: "Known semantic mismatches are removed before dispatch and receive sanitized diagnostics."
    - pattern: "Guarded Oracle promotion"
      example_location: "scripts/ops/oracleDeploy.ts::promoteWithRollback"
      usage_guidance: "Immutable image, backups and rollback tag before mutation, local/public gates after cutover."
  files_to_modify:
    - file: "open-sse/config/providers/shared.ts"
      symbols: ["RegistryModel"]
      intended_change: "Add optional canonical supported tool-choice modes."
    - file: "open-sse/config/providerModels.ts"
      symbols: ["getProviderModels", "getModelTargetFormat pattern"]
      intended_change: "Expose exact provider-scoped mode metadata."
    - file: "open-sse/config/providers/registry/opencode/index.ts"
      symbols: ["opencodeProvider"]
      intended_change: "Set verified free context/modes and remove unverified paid context."
    - file: "open-sse/config/providers/registry/opencode/zen/index.ts"
      symbols: ["opencode_zenProvider"]
      intended_change: "Mirror verified contributor-free metadata."
    - file: "open-sse/executors/opencode.ts"
      symbols:
        [
          "MUSE_SPARK_MIN_OUTPUT_TOKENS",
          "applyMuseSparkMinOutputTokens",
          "normalizeMuseSparkResponse",
          "OpencodeExecutor.execute",
        ]
      intended_change: "Use max_output_tokens and forward a complete terminal frame."
    - file: "open-sse/services/combo/comboStructure.ts"
      symbols:
        [
          "RequestCompatibilityRequirements",
          "deriveRequestCompatibilityRequirements",
          "getTargetCompatibilityFailures",
          "filterTargetsByRequestCompatibility",
          "computeCompatRejectedTargets",
        ]
      intended_change: "Add Responses budget parity and explicit non-auto tool-choice incompatibility."
    - file: "tests/unit/opencode-muse-spark-min-output.test.ts"
      symbols: ["Muse executor tests"]
      intended_change: "Replace hallucinated Chat-length cases with real Responses framing/budget/translation regressions."
    - file: "tests/unit/opencode-muse-spark-responses-10867.test.ts"
      symbols: ["registry tests"]
      intended_change: "Assert base free metadata."
    - file: "tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts"
      symbols: ["registry tests"]
      intended_change: "Assert Zen free metadata."
    - file: "tests/unit/combo-context-window-filter.test.ts"
      symbols: ["compatibility tests"]
      intended_change: "Assert max_output_tokens parity."
    - file: "tests/unit/8488-capability-filter-fail-closed.test.ts"
      symbols: ["capability filter tests"]
      intended_change: "Assert mode filtering and non-resurrection."
  tests:
    - file: "tests/unit/opencode-muse-spark-min-output.test.ts"
      scenarios:
        - "Responses budget 64 -> floor 8192 -> no max_tokens."
        - "Completed+ping SSE -> one completed frame -> no ping."
        - "Wrapper output -> Claude translation -> end_turn + real usage."
    - file: "tests/unit/combo-context-window-filter.test.ts"
      scenarios:
        - "max_output_tokens -> output/context requirements -> correct target order/filter."
    - file: "tests/unit/8488-capability-filter-fail-closed.test.ts"
      scenarios:
        - "auto/omitted -> Muse eligible."
        - "none/required/named/Anthropic any/tool -> Muse skipped -> compatible fallback."
        - "fail-open/last-resort -> explicit mismatch not resurrected."
  verification_commands:
    - "node --import tsx/esm --test tests/unit/opencode-muse-spark-min-output.test.ts tests/unit/opencode-muse-spark-responses-10867.test.ts tests/unit/opencode-zen-muse-spark-targetformat-11046.test.ts tests/unit/combo-context-window-filter.test.ts tests/unit/8488-capability-filter-fail-closed.test.ts"
    - "npm run typecheck:core"
    - "npm run check:cycles"
    - "npm run lint"
    - "npm run test:unit"
    - "npm run test:vitest"
    - "npm run build:release"
    - "docker build --target runner-base --build-arg OMNIROUTE_BUILD_SHA=<sha12> --tag omniroute:muse-stream-<sha12> ."
    - "node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --image omniroute:muse-stream-<sha12> --sha <sha12> --model opencode-zen/muse-spark-1.2-contributor-free --model claude-opus-5"
    - "node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --image omniroute:muse-stream-<sha12> --sha <sha12> --model opencode-zen/muse-spark-1.2-contributor-free --model claude-opus-5"
  risks:
    - "SSE delimiter ordering and duplicate terminal emission."
    - "Combo-wide semantic filtering regression."
    - "Tiny-output floor trades output allowance for reasoning headroom near the context boundary."
    - "Dirty overlapping user changes must be reconciled deliberately."
    - "Image/source identity must be committed and exact."
  assumptions:
    - "Before editing, rerun the provenance read/snapshot and confirm overlapping files are still the captured worktree bytes; if not, inspect the delta."
    - "Before build, verify a clean committed candidate with git status --porcelain and compare the image revision label to git rev-parse --short=12 HEAD."
    - "Before qualification, verify ssh oracle-vps, Docker, the remote image ID, OMNIROUTE_SMOKE_API_KEY, and squrvq health."
    - "The later claude-opus-5 combo targets include at least one model compatible with the caller's forced tool semantics; verify through call logs during qualification."
  open_questions:
    - "No implementation-blocking question remains. If the build host cannot fit runner-base, choose another trusted build host or documented webpack fallback without changing runtime scope."
  avoid:
    - "Do not repeat full repository discovery."
    - "Do not replace established patterns without evidence."
    - "Do not edit shared createSSEStream in this provider-specific patch."
    - "Do not coerce none, required, or named tool_choice to auto."
    - "Do not set a context limit for paid muse-spark-1.2 without a direct paid-tier probe."
    - "Do not expose or log credentials from ~/.claude/auth.json or ~/.claude/settings.json."
    - "Do not overwrite AGENTS.md, CLAUDE.md, docs/llms.txt, or unrelated .commandcode content."
    - "Do not build or promote from an uncommitted or provenance-mismatched tree."
```

## 12. Assumptions and Open Questions

### Assumptions

- [assumed] The implementation will reconcile the captured unstaged Muse edits rather than resetting them. Check by comparing the section 11 worktree digests before editing.
- [assumed] A reviewed commit is authorized before immutable image construction. Check with git status --porcelain and git rev-parse HEAD; do not deploy an image whose contents exceed that commit.
- [assumed] The later claude-opus-5 targets can satisfy forced tool semantics. Check the actual selectedModel/call logs during canary/public probes; if no target qualifies, a pre-dispatch 400 is correct.
- [assumed] The build host can complete runner-base. Check available memory; if necessary use the documented webpack build argument on a host with sufficient RAM.
- [assumed] OMNIROUTE_SMOKE_API_KEY can be exported securely from the previously inspected settings without printing or copying it into the plan.

### Open questions

No implementation-blocking question remains.

### Explicitly deferred

- [verified] open-sse/utils/stream.ts translate-mode flush ignores normalizedTailLines after the multiline normalizer drains an unterminated final frame. This is a broader shared-parser hardening task. Defer it unless a non-OpenCode provider reproduces the same malformed EOF; then plan it separately with all five direct callers and 25-symbol CRITICAL blast radius.
- [verified] The paid muse-spark-1.2 tier was not tested. Do not infer its context window, output floor, or tool-choice modes from contributor-free.
- [verified] The Codex disconnect was not reproduced and one matching 499 was a client abort. The framing patch may improve strict SSE clients, but completion requires post-deploy proof rather than claiming that every historical disconnect had this cause.

## 13. Definition of Done

- [ ] The implementation changes only the eleven files in section 10; all stated exclusions remain unchanged.
- [ ] Both OpenCode aliases report contributor-free contextLength 1_048_576 and auto-only tool-choice support; paid Muse has no invented limit.
- [ ] Captured upstream Muse request bodies contain max_output_tokens and never gain max_tokens.
- [ ] Direct and claude-opus-5 Anthropic streams each produce visible content, one end_turn terminal, real non-zero usage, and no synthetic max_tokens.
- [ ] Direct and claude-opus-5 Responses streams each produce exactly one response.completed with completed status and real usage, with no ping or response.failed after it.
- [ ] Auto/omitted tool choice may use Muse; none/required/named choices never dispatch Muse and either use a compatible fallback or return sanitized pre-dispatch capability_mismatch.
- [ ] Focused tests, typecheck:core, check:cycles, lint, test:unit, test:vitest, and build:release pass.
- [ ] The candidate image tag is immutable, its revision label matches the committed source, and local/remote image IDs match.
- [ ] Oracle qualification passes before promotion; promotion records database/config/gateway backups and omniroute:rollback-canary.
- [ ] Public health check, model metadata, both protocol probes, combo selected-target evidence, call-log advancement, container revision/status, and error-log inspection pass after promotion.
- [ ] At least three direct and three combo successes per protocol are observed without terminal loss.
- [ ] If any live gate fails, Rollback to the previous known-good image succeeds and Muse is temporarily removed from the chain pending a new diagnosis.

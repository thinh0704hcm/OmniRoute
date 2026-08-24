---
title: Combo-ready provider and model report
---

# Combo-ready provider and model report

Last consolidated: 2026-08-23. This report is generated directly from the typed evidence ledger and canonical combo manifest.

## Classification policy

Performance uses Haiku, Sonnet, Opus, and Fable only. Pricing is a separate Free, Subscription, Credits, API, or Unknown axis. GPT-5.6 Luna/Terra/Sol names are compatibility and pricing identities, not performance tiers.

Artificial Analysis bands are Haiku ≤30, Sonnet 31–50, Opus 51–60, and Fable ≥61. The anchors are Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.8, and performance strictly above ordinary Opus 4.8. Arena Code uses leaderboard quartiles. Exact model-and-effort conflicts take the lower tier; marked values reduce confidence; official-only assignments cannot exceed Opus.

## Inventory summary

- Managed model routes: 91
- Reviewed evidence rows: 85
- Documented exclusions: 2
- Unreconciled reviewed routes: 0
- Haiku evidence rows: 31
- Sonnet evidence rows: 49
- Opus evidence rows: 5
- Fable evidence rows: 0

## Haiku

### Free

| Routed model                                           | Provider      | Probe    | Quota pool                              | Selection basis                                                            |
| ------------------------------------------------------ | ------------- | -------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `opencode/nemotron-3.5-lightning-free`                 | opencode      | passed   | opencode:nemotron                       | Fast Nemotron economy target                                               |
| `openrouter/nvidia/nemotron-3.5-lightning:free`        | openrouter    | unprobed | openrouter-free-shared                  | Fast 1M-context agentic fallback                                           |
| `openrouter/poolside/laguna-xs-2.1:free`               | openrouter    | unprobed | openrouter-free-shared                  | Fast coding fallback                                                       |
| `openrouter/thinkingmachines/inkling-small:free`       | openrouter    | unprobed | openrouter-free-shared                  | Fast 262K-context reasoning fallback                                       |
| `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`       | openrouter    | unprobed | openrouter-free-shared                  | High-throughput reasoning fallback                                         |
| `nous-research/poolside/laguna-xs-2.1:free`            | nous-research | unprobed | nous-research-quota-topology-unverified | Fast coding fallback                                                       |
| `nous-research/stepfun/step-3.7-flash:free`            | nous-research | unprobed | nous-research-quota-topology-unverified | Fast vision-capable general fallback                                       |
| `gemini/gemini-3.5-flash-lite`                         | gemini        | passed   | gemini:gemini-3.5-flash-lite:7-projects | Recurring high-volume or high-request-count direct Gemini capacity         |
| `gemini/gemini-3.1-flash-lite`                         | gemini        | passed   | gemini:gemini-3.1-flash-lite:7-projects | Recurring high-volume or high-request-count direct Gemini capacity         |
| `gemini/gemma-4-31b-it`                                | gemini        | passed   | gemini:gemma-4-31b-it:7-projects        | Recurring high-volume or high-request-count direct Gemini capacity         |
| `gemini/gemma-4-26b-a4b-it`                            | gemini        | unprobed | gemini:gemma-4-26b-a4b-it:7-projects    | Recurring high-volume or high-request-count direct Gemini capacity         |
| `mistral/labs-leanstral-2603`                          | mistral       | unprobed | mistral-labs                            | Free Lean 4 coding specialist; unsuitable as a general fallback            |
| `groq/openai/gpt-oss-20b`                              | groq          | unprobed | groq:openai/gpt-oss-20b                 | Open-weight economy reasoning and tool-use fallback                        |
| `groq/qwen/qwen3.6-27b`                                | groq          | unprobed | groq:qwen/qwen3.6-27b                   | Parallel-tool-capable economy and coding fallback                          |
| `cloudflare-ai/@cf/qwen/qwen3-30b-a3b-fp8`             | cloudflare-ai | passed   | cloudflare-workers-ai-neurons           | Best observed speed/value balance: 663 ms HAR probe and low neuron cost    |
| `cloudflare-ai/@cf/zai-org/glm-4.7-flash`              | cloudflare-ai | passed   | cloudflare-workers-ai-neurons           | Low-cost reasoning fallback; HAR probe returned usable content             |
| `cloudflare-ai/@cf/google/gemma-4-26b-a4b-it`          | cloudflare-ai | passed   | cloudflare-workers-ai-neurons           | Efficient multimodal-family fallback; 1,973 ms successful HAR probe        |
| `cloudflare-ai/@cf/openai/gpt-oss-20b`                 | cloudflare-ai | passed   | cloudflare-workers-ai-neurons           | Reliable reasoning fallback with moderate neuron cost; HAR probe passed    |
| `nvidia/nvidia/nemotron-3.5-lightning-30b-a3b`         | nvidia        | passed   | nvidia-nim                              | NIMStats leader: score 73, 96.7% success, and 113.6 tokens/s               |
| `nvidia/openai/gpt-oss-20b`                            | nvidia        | passed   | nvidia-nim                              | Reliable economy target: NIMStats score 68 and 100% success over 15 runs   |
| `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | nvidia        | passed   | nvidia-nim                              | Multimodal fallback: NIMStats score 65 and 86.7% success over 15 runs      |
| `opencode-zen/nemotron-3.5-lightning-free`             | opencode-zen  | unprobed | nemotron                                | Fast Nemotron-pool economy target for agentic and long-context work        |
| `llm7/gemini-3.1-flash-lite`                           | llm7          | unprobed | —                                       | Turbo economy target with tools, vision, JSON, streaming, and 256K context |
| `nara/stepfun-3.7-flash`                               | nara          | unprobed | nara-free                               | Vision-capable economy fallback with 262K context                          |
| `af/gpt-oss-20b`                                       | api-airforce  | passed   | —                                       | Economy reasoning/tools fallback; basic exact-output probe passed          |
| `ollama-cloud/nemotron-3-nano:30b`                     | ollama-cloud  | passed   | —                                       | Fast economy reasoning and agentic target                                  |
| `ollama-cloud/gpt-oss:20b`                             | ollama-cloud  | passed   | —                                       | Economy open-weight reasoning and tool target                              |
| `ollama-cloud/gemma4:31b`                              | ollama-cloud  | passed   | —                                       | Multimodal economy target                                                  |

### Subscription

| Routed model                   | Provider    | Probe  | Quota pool         | Selection basis                               |
| ------------------------------ | ----------- | ------ | ------------------ | --------------------------------------------- |
| `antigravity/gemini-2.5-flash` | antigravity | passed | antigravity-gemini | High-volume low-latency subscription backbone |

### Credits

| Routed model                   | Provider | Probe    | Quota pool                    | Selection basis                           |
| ------------------------------ | -------- | -------- | ----------------------------- | ----------------------------------------- |
| `mistral/mistral-small-latest` | mistral  | unprobed | mistral-api-monthly-allowance | Best general-purpose monthly-credit value |
| `mistral/codestral-latest`     | mistral  | unprobed | mistral-api-monthly-allowance | Low-cost coding specialist                |

### Metered API

No reviewed candidates.

### Unknown

No reviewed candidates.

## Sonnet

### Free

| Routed model                                        | Provider      | Probe        | Quota pool                              | Selection basis                                                                           |
| --------------------------------------------------- | ------------- | ------------ | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `opencode/nemotron-3-ultra-free`                    | opencode      | passed       | opencode:nemotron                       | Maximum-quality Nemotron target                                                           |
| `opencode/muse-spark-1.2-contributor-free`          | opencode      | passed       | opencode:non-nemotron                   | Agentic value target                                                                      |
| `opencode/x-preview-f-free`                         | opencode      | passed       | opencode:non-nemotron                   | Operator-identified GLM-5.5 preview                                                       |
| `opencode/mimo-v2.5-free`                           | opencode      | passed       | opencode:non-nemotron                   | Multimodal 1M-context fallback                                                            |
| `opencode/hy3-free`                                 | opencode      | passed       | opencode:non-nemotron                   | Agentic fallback                                                                          |
| `opencode/laguna-s-2.1-free`                        | opencode      | passed       | opencode:non-nemotron                   | Coding specialist                                                                         |
| `command-code/stealth/ox-alpha`                     | command-code  | unprobed     | command-code-free-topology-unverified   | Unscored 1M-context multimodal reasoning candidate                                        |
| `command-code/poolside/laguna-s-2.1-free`           | command-code  | unprobed     | command-code-free-topology-unverified   | Free coding specialist with strong Laguna benchmarks                                      |
| `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` | openrouter    | unprobed     | openrouter-free-shared                  | Highest-quality Nemotron route                                                            |
| `openrouter/thinkingmachines/inkling:free`          | openrouter    | unprobed     | openrouter-free-shared                  | Reliable independent-model fallback                                                       |
| `openrouter/poolside/laguna-s-2.1:free`             | openrouter    | unprobed     | openrouter-free-shared                  | Strong coding specialist                                                                  |
| `openrouter/nvidia/nemotron-3-super-120b-a12b:free` | openrouter    | unprobed     | openrouter-free-shared                  | Efficient agentic quality fallback                                                        |
| `openrouter/z-ai/glm-5.2:free`                      | openrouter    | unprobed     | openrouter-free-shared                  | Long-context agentic coding fallback                                                      |
| `openrouter/cohere/north-mini-code:free`            | openrouter    | unprobed     | openrouter-free-shared                  | Dedicated code-model fallback                                                             |
| `nous-research/poolside/laguna-s-2.1:free`          | nous-research | unprobed     | nous-research-quota-topology-unverified | Coding specialist with SWE-Bench Pro 59.4                                                 |
| `nous-research/tencent/hy3:free`                    | nous-research | unprobed     | nous-research-quota-topology-unverified | Agentic fallback with reported Terminal-Bench 71.7                                        |
| `nous-research/upstage/solar-pro4:free`             | nous-research | unprobed     | nous-research-quota-topology-unverified | High-quality general and coding fallback                                                  |
| `nous-research/meituan/longcat-2.0:free`            | nous-research | unprobed     | nous-research-quota-topology-unverified | Agentic coding and repository-work fallback                                               |
| `gemini/gemini-3.7-flash`                           | gemini        | unprobed     | gemini:gemini-3.7-flash:7-projects      | Scarce newer-generation Flash capacity reserved for higher-value work                     |
| `gemini/gemini-3.6-flash`                           | gemini        | unprobed     | gemini:gemini-3.6-flash:7-projects      | Scarce newer-generation Flash capacity reserved for higher-value work                     |
| `gemini/gemini-3.5-flash`                           | gemini        | unprobed     | gemini:gemini-3.5-flash:7-projects      | Scarce newer-generation Flash capacity reserved for higher-value work                     |
| `gemini/gemini-3-flash`                             | gemini        | unprobed     | gemini:gemini-3-flash:7-projects        | Scarce newer-generation Flash capacity reserved for higher-value work                     |
| `groq/openai/gpt-oss-120b`                          | groq          | unprobed     | groq:openai/gpt-oss-120b                | Strongest direct Groq model: MMLU 90.0, GPQA Diamond 80.1, SWE-Bench 62.4                 |
| `groq/groq/compound`                                | groq          | unprobed     | groq:groq/compound                      | Up to 10 hosted tool calls for complex research and analysis                              |
| `groq/groq/compound-mini`                           | groq          | unprobed     | groq:groq/compound-mini                 | Single hosted tool call with about 3x lower average latency                               |
| `cloudflare-ai/@cf/openai/gpt-oss-120b`             | cloudflare-ai | passed       | cloudflare-workers-ai-neurons           | Best quality-per-neuron large-model candidate among successful HAR probes                 |
| `cloudflare-ai/@cf/nvidia/nemotron-3-120b-a12b`     | cloudflare-ai | passed       | cloudflare-workers-ai-neurons           | Agentic quality fallback; successful 1,758 ms HAR probe despite higher neuron cost        |
| `nvidia/thinkingmachines/inkling`                   | nvidia        | unprobed     | nvidia-nim                              | Most reliable Terra target: NIMStats score 70 and 100% success over 42 runs               |
| `nvidia/nvidia/nemotron-3-ultra-550b-a55b`          | nvidia        | passed       | nvidia-nim                              | Best quality fallback: NIMStats score 70 and 93.3% success over 38 runs                   |
| `nvidia/nvidia/nemotron-3-super-120b-a12b`          | nvidia        | passed       | nvidia-nim                              | Fast quality fallback: NIMStats score 69 and 96.7% success over 26 runs                   |
| `af/mistral-large-latest`                           | api-airforce  | inconclusive | —                                       | Highest-performance operational general-purpose model in the free catalog                 |
| `llm7/DeepSeek-V4-Flash-0731`                       | llm7          | passed       | —                                       | Highest-performance general-purpose turbo model in the accessible catalog                 |
| `nara/qwen-3.8-max-free`                            | nara          | unprobed     | —                                       | Highest-performance general-purpose free model in the researched Nara catalog             |
| `opencode-zen/nemotron-3-ultra-free`                | opencode-zen  | passed       | nemotron                                | Quality leader: 70.7 SWE-bench Verified, 89.0 LiveCodeBench, 87.0 GPQA                    |
| `opencode-zen/mimo-v2.5-free`                       | opencode-zen  | passed       | non-nemotron                            | Best evidenced independent-pool value: 1M context and native multimodal agent model       |
| `opencode-zen/muse-spark-1.2-contributor-free`      | opencode-zen  | passed       | non-nemotron                            | Best non-Nemotron agentic value: Intelligence Index 54 and Terminal-Bench 82.9            |
| `opencode-zen/x-preview-f-free`                     | opencode-zen  | passed       | non-nemotron                            | Operator-identified GLM-5.5 preview; retained below benchmarked models pending disclosure |
| `opencode-zen/hy3-free`                             | opencode-zen  | unprobed     | non-nemotron                            | Agentic fallback with reported Terminal-Bench 71.7 and SWE Multilingual 75.8              |
| `opencode-zen/laguna-s-2.1-free`                    | opencode-zen  | unprobed     | non-nemotron                            | Coding specialist: SWE Multilingual 78.5 and SWE-Bench Pro 59.4                           |
| `nara/laguna-s-2.1`                                 | nara          | unprobed     | nara-free                               | Coding specialist sharing Nara's free pool                                                |
| `ollama-cloud/minimax-m3`                           | ollama-cloud  | passed       | —                                       | Frontier coding and agentic target with 1M context                                        |
| `ollama-cloud/nemotron-3-ultra`                     | ollama-cloud  | passed       | —                                       | Maximum-quality Nemotron target                                                           |
| `ollama-cloud/nemotron-3-super`                     | ollama-cloud  | passed       | —                                       | Efficient multi-agent fallback                                                            |

### Subscription

| Routed model                          | Provider    | Probe  | Quota pool             | Selection basis                                 |
| ------------------------------------- | ----------- | ------ | ---------------------- | ----------------------------------------------- |
| `antigravity/gemini-3.6-flash-medium` | antigravity | passed | antigravity-gemini     | Protocol-capable balanced quality target        |
| `antigravity/claude-sonnet-4-6`       | antigravity | passed | antigravity-non-gemini | Scarce protocol-capable Sonnet quality fallback |

### Credits

| Routed model                    | Provider | Probe    | Quota pool                    | Selection basis                                                           |
| ------------------------------- | -------- | -------- | ----------------------------- | ------------------------------------------------------------------------- |
| `mistral/mistral-medium-latest` | mistral  | unprobed | mistral-api-monthly-allowance | Highest-quality native Mistral target                                     |
| `mistral/mistral-large-latest`  | mistral  | unprobed | mistral-api-monthly-allowance | High-quality open-weight value target                                     |
| `mistral/zai-glm-5-2`           | mistral  | unprobed | mistral-api-monthly-allowance | Long-context agentic coding specialist                                    |
| `longcat/LongCat-2.0`           | longcat  | passed   | longcat-promotion             | Temporary direct-provider capacity reserved for higher-value agentic work |

### Metered API

No reviewed candidates.

### Unknown

No reviewed candidates.

## Opus

### Free

No reviewed candidates.

### Subscription

| Routed model                           | Provider    | Probe  | Quota pool             | Selection basis                           |
| -------------------------------------- | ----------- | ------ | ---------------------- | ----------------------------------------- |
| `antigravity/gemini-3.7-flash-high`    | antigravity | passed | antigravity-gemini     | High-reasoning Gemini subscription target |
| `antigravity/claude-opus-4-6-thinking` | antigravity | passed | antigravity-non-gemini | Scarce highest-quality Claude fallback    |

### Credits

| Routed model                  | Provider    | Probe    | Quota pool                   | Selection basis                                                             |
| ----------------------------- | ----------- | -------- | ---------------------------- | --------------------------------------------------------------------------- |
| `agentrouter/gpt-5.6-sol`     | agentrouter | unprobed | agentrouter-one-time-credits | Reserve finite guaranteed frontier capacity for explicit highest-value work |
| `agentrouter/claude-opus-5`   | agentrouter | unprobed | agentrouter-one-time-credits | Guaranteed Opus-class fallback funded by finite one-time credits            |
| `agentrouter/claude-opus-4-8` | agentrouter | unprobed | agentrouter-one-time-credits | Guaranteed Opus-class fallback funded by finite one-time credits            |

### Metered API

No reviewed candidates.

### Unknown

No reviewed candidates.

## Fable

### Free

No reviewed candidates.

### Subscription

No reviewed candidates.

### Credits

No reviewed candidates.

### Metered API

No reviewed candidates.

### Unknown

No reviewed candidates.

## Fable fallback status

No operational route currently has reviewed Fable evidence. The following leaves keep the Fable entrypoint available using explicitly labeled Opus-class fallbacks:

- `pool-fable-antigravity`: `antigravity/gemini-3.7-flash-high`, `antigravity/claude-opus-4-6-thinking`
- `pool-fable-credits`: `command-code/meta/muse-spark-1.2-contributor`
- `pool-fable-reserve-credits`: `agentrouter/gpt-5.6-sol`, `agentrouter/claude-opus-5`

## Documented exclusions

- `mistral/labs-leanstral-2603`
- `nara/laguna-s-2.1`

## Reconciliation

Every route from the evidence ledger or canonical manifest is classified as managed or listed as a documented exclusion.

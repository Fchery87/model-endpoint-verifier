# Model Endpoint Verifier: MVP PRD

## Problem

AI aggregators can advertise models by name without giving customers a reliable way to confirm that requests are routed to the claimed provider or model. A buyer needs an independent, repeatable assessment of an endpoint’s model catalog and behavior before trusting it with production workloads.

## Product goal

Let a user submit an API-compatible endpoint and credential, select one or more advertised models, and receive an evidence-backed verification report that distinguishes:

- **Behaviorally consistent**: observed behavior is consistent with the claim and no material contradictions were found.
- **Partially consistent**: some capabilities or metadata match, but identity is inconclusive.
- **Inconsistent / suspicious**: the endpoint contradicts its advertised identity or fails expected capabilities.
- **Unable to verify**: the endpoint could not be tested sufficiently.

The report must never claim certainty based only on a model name or a single response.

## Target users

- Developers evaluating an AI subscription or routing provider.
- Teams performing vendor due diligence.
- Model-platform operators checking that aliases and routing rules behave as documented.

## MVP workflow

1. User enters an HTTPS endpoint, API key, API format, and optional organization/project identifier.
2. The verifier validates connectivity and discovers the advertised model list.
3. User selects models to test, or runs all supported models within a configurable budget.
4. The verifier runs a controlled, synthetic test suite.
5. The user receives a report with a verdict, consistency score, raw evidence, test timestamps, and a downloadable JSON export.

## Current implementation status

The current implementation covers catalog discovery with a second fetch for stability, duplicate model-ID detection, three repeated baseline chat probes with transient-error retry (recorded per run), routing stability, usage consistency, response-header provenance, catalog owner metadata, context length and modality capture, a catalog-owner-versus-returned-model cross-check, a known-answer arithmetic probe, structured output, tool calling, and streaming completion. Capability-probe errors are fingerprinted (unsupported parameter, rate limit, quota, auth, timeout) so an inconclusive result states why. Probes that send `temperature` retry once without it when a reasoning model rejects the parameter, so an unsupported sampling option does not produce a false failure. Mixed response-header families are a weak conflict. Missing model IDs or usage metadata make the relevant check inconclusive rather than passing it. Selected models run with bounded concurrency, three at a time, under a per-run model cap (`MAX_MODELS_PER_RUN`, default 5) and token budget (`MAX_PROBE_TOKENS_PER_RUN`, default 20000) that skips expensive probes as `info` when exhausted. An optional `HOSTED_SSRF_GUARD=1` pre-flight rejects endpoints that resolve to private or loopback addresses; it does not fully mitigate DNS rebinding and does not replace hosting authentication. Family detection lives in `lib/families.mjs`, is current for the November 2026 lineups (GPT-6, Claude Fable/Opus/Sonnet/Haiku 5.x, Gemini 4, DeepSeek V4, Qwen 3.8, Kimi K3, GLM-5, MiMo, MiniMax, Grok 4.x), and is replayed nightly against live-recorded fixtures in CI to catch drift when vendors ship new model IDs.

Each check carries a status, dimension, weight, and earned points. The score is the sum of earned points divided by the sum of positive weights, rounded to a percentage. A failed check forces `Inconsistent / suspicious`. A warning prevents `Behaviorally consistent`. The dimensions are identity, capability, and provenance. The score is an evidence summary, not a probability that the model is authentic.

The local-first build runs one orchestrator over the advertised catalog. Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback addresses. For each selected model it runs three identical baseline chat probes, then gates the JSON-mode and tool-call probes on a successful baseline. The report includes checks, a weighted score, and raw routing observations with latency, token usage, system fingerprint, and allowlisted response headers.

Header capture is limited to provider and gateway metadata such as `server`, `x-request-id`, `openai-*`, and `anthropic-*`. Authorization, cookie, and set-cookie values are never captured. The report never includes the submitted API key, including when a provider echoes it in a model ID, owner field, header value, or error message.

## Target test suite

The target suite below covers the full verification scope. The current build implements the subset described above.

### Endpoint and catalog checks

- Validate authentication and response schema.
- Compare `/models` entries with the requested model ID.
- Record provider-reported ownership, capabilities, context limits, and supported modalities where available.
- Detect aliases, duplicate IDs, unexpected model substitutions, and unstable catalog responses.

### Behavioral and capability checks

- Deterministic basic prompt with repeated runs to detect unexpected routing variation.
- Structured-output / JSON adherence.
- Tool-call declaration and execution format.
- Streaming behavior and usage accounting.
- Context-window boundary probes.
- Vision or image-input check when the advertised model claims it.
- Reasoning, logprobs, seed, and other model-specific options when supported.
- Known-answer and instruction-following probes using synthetic, non-sensitive prompts.

### Identity assessment

- Compare observed capabilities and response metadata against a maintained model capability registry.
- Compare response fingerprints against reference samples where legally and technically appropriate.
- Run multiple prompts and repetitions. Do not score from one answer.
- Separate **capability match** from **model identity confidence**.
- Explain every score contribution and contradiction in plain language.

## Report example

```text
Claim: anthropic/claude-sonnet-4
Verdict: Partially consistent
Consistency score: 82/100

Supporting evidence:
  ✓ Model ID was stable across three baseline probes
  ✓ Tool calling format matched the claimed capability
  ✓ Anthropic response headers were observed

Inconclusive evidence:
  ~ No provider-signed identity attestation
  ~ Prompt-token usage was not reported consistently

Contradictions:
  ! Response headers contained signals for multiple provider families

Interpretation: capabilities are broadly consistent, but the test cannot prove
that the underlying model is Claude rather than a compatible substitute.
```

## Security and privacy requirements

- Never persist API keys by default. Keep them encrypted in memory for the test job and discard them when it completes.
- Load the local UI from bundled assets only. A local-first verifier must not contact third parties when the page opens.
- Mask credentials in logs, errors, exports, and telemetry.
- Use synthetic prompts only in the MVP and do not send user data to the tested provider.
- Restrict requests to HTTPS and protect a hosted verifier against SSRF, private-network targets, redirects, abuse, and excessive spend.
- Apply per-job request, token, timeout, and cost limits.
- Let users delete reports and raw responses.

## Explicit non-goals for MVP

- Cryptographic proof of model identity where the provider offers no attestation mechanism.
- Training a universal classifier that can identify every model from text alone.
- Load testing, benchmark ranking, or quality evaluation for general-purpose model selection.
- Automatically publishing accusations about providers.
- Supporting every vendor-specific API on day one.

## Success metrics

- A first-time user can configure and run a verification in under five minutes.
- At least 90% of supported, healthy OpenAI-compatible endpoints produce a readable report.
- Every verdict includes traceable evidence and an explicit uncertainty explanation.
- No API key appears in application logs, persisted reports, or error messages.

## Recommended first technical slice

Build a local-first verifier for OpenAI-compatible chat endpoints before adding a hosted multi-user service:

1. Endpoint configuration form/CLI.
2. Model discovery and chat-completion adapter.
3. Versioned test definitions and raw result storage.
4. Rule-based capability scoring with transparent evidence.
5. HTML/JSON report.

This slice validates the core signal without prematurely building accounts, billing, or a large provider adapter matrix.

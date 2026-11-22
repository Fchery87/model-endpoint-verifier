# Model Endpoint Verifier

A local-first tool for checking whether an AI endpoint behaves consistently with the models it advertises. Enter an OpenAI-compatible base URL and API key, and the verifier will:

- Discover the endpoint's advertised model catalog.
- Send controlled probes to one or more models.
- Run three identical baseline probes and compare routing stability, token usage, response-header provenance, catalog metadata, chat behavior, structured output, and tool calling.
- Produce a transparent evidence report with a consistency score and explicit contradictions.
- Export the full report as JSON.

The key distinction: **a model name is a claim, not proof.** This tool measures consistency and surfaces suspicious behavior. Without provider-signed attestation, it cannot mathematically prove which model is behind an endpoint.

## Requirements

- Node.js 18 or newer
- No npm dependencies

## Run it

```bash
npm start
```

Open <http://127.0.0.1:4173>.

The server binds to localhost by default. API keys are used in memory for the verification request and are not included in reports or logs. The browser UI loads only local assets and system fonts. Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback addresses so local test servers still work. Setting `HOST=0.0.0.0` exposes the key-submission form to your network. Do not do that without adding authentication and TLS in front of it.

Environment variables: `PORT` (default `4173`), `HOST` (default `127.0.0.1`), and `PROBE_TIMEOUT_MS` (default `18000`, applied to each request through the end of its response body).

## Test it

```bash
npm test
```

The smoke test allocates free localhost ports and a unique mock API key, starts a mock OpenAI-compatible provider, and verifies the full flow, including:

- Catalog discovery.
- A stable model with three matching routing observations and Anthropic headers.
- A flaky router that changes provider family across baseline probes, reported as `Inconsistent / suspicious`.
- A model whose prompt-token usage drifts across identical probes, reported as `Partially consistent`.
- A model that omits its model ID and usage metadata, which must downgrade the affected checks instead of passing them.
- A model whose response headers contain signals for multiple provider families.
- A cross-provider substitution whose response headers contradict the claim.
- An unrecognized model alias, which cannot receive a high-confidence identity verdict.
- A provider that echoes the submitted key in a model ID and catalog owner field, which must be fully redacted.
- A catalog response with no usable model IDs, which must fail cleanly instead of returning an empty report.
- A transient 500 on the first baseline probe, which must retry and still reach `Behaviorally consistent`.
- A catalog that changes between discovery requests, reported as unstable.
- A catalog with duplicate model IDs, reported as a warning and deduplicated before probing.
- A streaming response that reaches `[DONE]`, which must pass the streaming check.
- A reasoning model that rejects `temperature`, which must retry without it and still reach `Behaviorally consistent`.
- Current 2026 model families (GPT-6, Claude Opus 5.5, Gemini 4, DeepSeek V4.1), which must map to the right family.
- A default run over five advertised models, which must return all five reports in catalog order.
- A remote plain-HTTP endpoint, which must be rejected before any request is sent.
- A provider that stalls after sending headers, which must time out instead of hanging the run.
- JSON-mode rejection without a chat failure.
- A versioned endpoint path.
- An invalid key, which must be rejected without echoing the key.
- Static asset serving and path-traversal protection.
- No API key, authorization header, cookie, or set-cookie value in report JSON.

## What the report means

| Verdict | Meaning |
| --- | --- |
| `Behaviorally consistent` | The catalog, routing metadata, and capability probes agree with the claim. Identity is still not cryptographically proven. |
| `Partially consistent` | Some signals match, but behavior is inconclusive, an alias was used, or a capability did not match. |
| `Inconsistent / suspicious` | At least one direct contradiction was observed, such as a response identifying itself as a different provider family. |
| `Unable to verify` | Too little evidence was collected to make a useful assessment. |

Each check carries a weight and earned points. The score is the sum of earned points divided by the sum of positive weights, rounded to a percentage. A failed check forces `Inconsistent / suspicious`. A warning prevents `Behaviorally consistent`, so the top verdict requires every weighted check to pass without warnings. The score reflects the evidence that could be assessed. It is not a probability that the model is authentic, and `info` checks mean a signal was unavailable.

## Current probes

- `GET /v1/models` catalog discovery, fetched twice with a short delay so an unstable catalog is detected.
- Duplicate model-ID detection. Duplicates are reported and deduplicated before probing.
- Endpoint validation that rejects remote plain-HTTP targets and survives malformed catalogs.
- Three baseline chat probes with an identical prompt and no `response_format` or tools.
- Transient-error retry with backoff on baseline probes. Timeouts are not retried.
- Exact model-ID echo from chat completions.
- Routing stability across baseline probes. A provider-family change fails the check, a model change within one family warns, and failed or incomplete runs warn.
- Catalog `owned_by` metadata comparison.
- Catalog context length and input/output modalities recorded when the provider exposes them.
- Usage consistency from prompt-token counts on the baseline probes. Partial or missing usage is inconclusive, not a pass.
- Response-header provenance from an allowlist of provider and gateway headers. Mixed provider signals are a weak warning, not a pass.
- Standard chat-completion response shape.
- JSON-object structured output, gated on a successful baseline.
- Tool-call generation, gated on a successful baseline.
- Streaming completion, gated on a successful baseline. The probe checks for streamed text and a `[DONE]` terminator.
- A one-time `temperature`-free fallback when a reasoning model explicitly rejects the parameter, so a valid endpoint is not failed for an unsupported sampling option.
- Run-level latency, usage, system fingerprint, safe headers, and errors in the JSON report.
- Error and timeout handling.
- API-key redaction in returned reports, including provider-controlled model IDs, catalog owner fields, and error text.
- Bounded concurrency across selected models, three at a time.

Family detection is current for the November 2026 lineups, including GPT-6, Claude Fable/Opus/Sonnet/Haiku 5.x, Gemini 4, DeepSeek V4, Qwen 3.8, Kimi K3, GLM-5, MiMo, MiniMax, and Grok 4.x. Provider IDs are self-reported, so family mapping is a claim check, not proof.

## Known limitations

- Model IDs returned by a provider are self-reported and can be spoofed.
- Most endpoints do not expose cryptographic model attestation.
- `owned_by` metadata is self-reported.
- Response headers can be added, stripped, or rewritten by gateways, so header provenance is a weak signal.
- Token usage is provider-reported and can be synthesized.
- Providers can omit model IDs or usage metadata. The verifier degrades the affected checks to inconclusive instead of treating missing evidence as a pass.
- The current probes are intentionally broad. They are not a complete behavioral fingerprint.
- Concurrency is bounded to three models at a time, but there is no hard per-run cost cap. A run over many selected models still spends one request per probe per model.
- Three baseline probes reduce the chance of missing unstable routing, but they do not eliminate it.
- A provider that consistently spoofs model IDs and visible behavior can still pass. The tool is strongest at catching contradictions and instability, not proving identity.
- Provider-specific APIs (Anthropic-native, Gemini-native, Bedrock, Vertex) are not yet adapted.
- The endpoint must expose an OpenAI-compatible `/v1/models` and `/v1/chat/completions`.

## Architecture

```text
public/                  Browser UI (HTML, CSS, vanilla JS)
server.js                Local HTTP server, discovery, probes, scoring
test/mock-provider.mjs   Fake provider with routing, usage, and header fixtures
test/smoke.mjs           End-to-end verification test
docs/PRD.md              Product scope, security requirements, non-goals
```

The next meaningful improvements are provider-native adapters, stronger behavioral fingerprints such as tokenizer comparisons, and a hosted job model with ephemeral encrypted keys.

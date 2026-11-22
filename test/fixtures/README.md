# Live fixtures

Sanitized verification reports recorded against real endpoints. They exist so
CI can detect drift in family detection and capability heuristics when a
vendor ships new model IDs — the offline smoke suite can only prove
consistency against the bundled mock.

## Recording a fixture

```sh
LIVE_ENDPOINT=https://api.example.com/v1 \
LIVE_API_KEY=sk-... \
LIVE_MODEL=gpt-4o \
LIVE_LABEL=example \
node test/record-fixture.mjs
```

The report is redacted server-side, and the recorder refuses to write anything
that still contains the key. Committing a fixture shares everything the
verifier observed about the endpoint: catalog IDs, owners, headers, latencies.
Only record endpoints you are allowed to disclose.

## Checking for drift

```sh
npm run test:fixtures
```

Fails if the current `familyFromModel` output no longer matches the
`claimedFamily` recorded in a fixture.

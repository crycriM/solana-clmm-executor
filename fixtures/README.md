# Wire and replay fixtures

Deterministic offline fixtures for the JSONL bridge: canonical wire envelopes,
recorded read shapes, and the small test-only entrypoints that drive the
compiled production code against them.

## Wire fixtures

`requests.json` supplies the canonical request for each of the seven verbs:
`get_state`, `get_position`, `quote_swap`, `deposit_single_sided`, `withdraw`,
`swap`, and `refresh_bundle`. `responses/<verb>.ok.json` is the matching stub
response with only `data.stub` removed. `responses/<verb>.error.json` records
the first error slice: `bad_request` after removing that verb's required
identifier.

These are synthetic dry-run examples: signatures, slots, amounts, fees, and the
wallet/position identifiers are not evidence of chain execution. The stub does
not simulate transactions or model changing balances. Reads, the `quote_swap`
response, and rejected requests have empty receipt arrays; writes have one
fully populated receipt per signature (non-null fees, aligned signatures,
`confirmed` receipts, withdrawals `finalized`). `refresh_bundle` has multiple
receipts to exercise fee aggregation, and its envelope carries `position_id`
plus `position_ids` (bid before ask) so two-sided PDAs are both tracked.

TypeScript contract tests compare all fourteen envelopes through the compiled
bridge (stub handlers injected explicitly, `tests/contract/protocol.test.ts`).
Python's `tests/test_executor_fixtures.py` in `dlmm-bot` parses the twelve
keeper-verb envelopes (all but `quote_swap`, which the Python side never
sends) through `ExecResult.from_payload`, and its `--executor-subprocess` lane
replays all seven verbs over the built stub CLI against
`responses/<verb>.ok.json`. Further errors and replay through Fake, Replay,
and Gateway bridges belong to the later full spec §11 conformance gate.

## RPC replay fixtures

`rpc/` contains sanitized, deterministic shapes captured from the M2 Solana
RPC/Meteora read surfaces (`pool-state.json`, `position.json`). They
deliberately include raw values above 2^53 and contain no endpoint
credentials, wallet secrets, or signed transactions. The TypeScript read-path
tests (`src/meteora.test.ts`) consume them in place of a live endpoint.
`rpc/dlmm-swap-logs.json` is the M3 event-payload replay fixture: recorded
DLMM `Swap` event-CPI payloads with their signatures, slots, and block times.

## Stream fixture and dump

`swap-stream-dump.mjs` decodes that fixture through the compiled production
`SwapStream` and writes the exact JSONL file consumed by `dlmm-bot`'s
`tests/test_executor_swap_stream.py` integration gate (which tails it with
`JsonlSwapEventSource`). It performs no network access.

## Offline entrypoints

`stub-runner.mjs` is the explicit offline process entrypoint: it wires the
deterministic stub handlers into `dist/bridge.js`'s real transport. The
production `dist/bridge.js` never auto-selects stubs; it always wires the live
M2 reads plus the policy- and signer-bound M4/M5 write paths configured by
the environment.

`keeper-runner.mjs` is a test-only entrypoint that reuses the built real
executor's transport and startup code, but lets a scenario file inject
`get_state` state (active bin, balances, TVL) or an offline read failure.
`dlmm-bot`'s `--executor-subprocess` keeper lanes drive it this way; the
production CLI gains no test verbs or flags.

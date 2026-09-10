# M1 wire fixtures

`requests.json` supplies the canonical request for each of the six verbs.
`responses/<verb>.ok.json` is the matching stub response with only `data.stub`
removed. These are synthetic dry-run examples: signatures, slots, amounts,
fees, and the wallet/position identifiers are not evidence of chain execution.
The stub does not simulate transactions or model changing balances.

`responses/<verb>.error.json` records the first error slice: `bad_request`
after removing that verb's required identifier. Reads and rejected requests
have empty receipt arrays; writes have one fully populated receipt per
signature. Refresh has multiple receipts to exercise fee aggregation.

TypeScript tests compare all twelve envelopes through the bridge. Python's
`tests/test_executor_fixtures.py` in `dlmm-bot` parses these same files through
`ExecResult.from_payload`. Further errors and replay through Fake, Replay,
and Gateway bridges belong to the later full spec §11 conformance gate.

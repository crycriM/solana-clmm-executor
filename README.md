# solana-clmm-executor

Meteora DLMM execution gateway (OPMS) for `dlmm-bot`. The only component in the
monorepo with signing authority on the LP wallet.

- **Interface**: `src/protocol.ts` — the JSON-lines contract with
  `dlmm_bot.exec_bridge.ExecBridge`.
- **Specification**: `project_docs/opms-spec.md` — verbs, receipts, swap
  stream, logging, safety, build order.
- **Test gate**: `project_docs/meteora-functional-test-plan.md` — wallet
  custody (KMS), signing policy, dust lifecycle.

Vendors copies of the reused read paths from `../LP-hedging-strategy/lp-monitor/src`
into `src/vendor/lp-monitor/` (Solana connection, winston logger, position
types, Meteora SDK reads, token mapping) — no dependency or import on that
project; copies carry provenance headers with the upstream git SHA. That
project stays read-only and never gains signing authority.

M0 scaffolding, M1 wire proof, the offline portion of M2, and the M3 swap
stream are implemented.
The production executable requires `DRY_RUN=true`: `get_state` and
`get_position` are live read-only Meteora/RPC calls, while the four write verbs
remain gated until the M4 signing gate. The stream decodes confirmed DLMM
events into `SWAP_STREAM_PATH` and backfills after WebSocket reconnects. No
signer is loaded.

Build and check with Node >=20:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

The CLI is `node dist/bridge.js` (or `npm run dev` for development). It reads
one JSON request per stdin line and writes one JSON response per line, in
order. Supply the environment described in `project_docs/opms-spec.md` §9;
M2 additionally requires `WALLET_PUBKEY`, because wallet balances and position
ownership cannot be read from a signer that is deliberately not loaded yet.
The dry-run signer needs no custody ARN. Startup rejects invalid config
on stderr before accepting requests. Runtime audit failures return an error
and exit with status 1. Executor logs rotate on UTC date changes; only executor
JSONL files older than 24 hours are compressed.

Run the complete local/CI gate from this project after installing `dlmm-bot`
and `mm-core` editable into **dlmm-bot's own** `.venv`:

```bash
npm run check:m3
```

This builds first, runs all offline TS checks, then executes
`../dlmm-bot/.venv/bin/python -m pytest -q --executor-subprocess` from the bot
root. The default Python lane skips the 15 subprocess cases. The opt-in lane
fails if Node or the built bridge is missing. Existing keeper scenarios use
`fixtures/keeper-runner.mjs`, which injects canned read state into the exported
real bridge; offline lifecycle and conformance cases use
`fixtures/stub-runner.mjs`. Production `node dist/bridge.js` always wires live
M2 reads and the M3 stream. Both offline lanes use the same twelve response
fixtures; M3 also runs the recorded-log cross-language fixture.

The live functional suites under `tests/functional/` are excluded unless
`RUN_LIVE=1` is set. M2 live reads stay `DRY_RUN=true` and require
`SOLANA_RPC_URL`, `LIVE_POOL`, `LIVE_POSITION_ID`, and `WALLET_PUBKEY`; write
suites retain their separate `LIVE_WRITE_CONFIRM=yes` guard.

M3 may use `SOLANA_WS_URL` when the HTTP provider does not expose Solana
PubSub at its derived WebSocket URL. HTTP JSON-RPC is CU-rate-limited in the
client; `SOLANA_RPC_MAX_CU_PER_SECOND` defaults to 240 (20% below Alchemy's
300 CU/s free-tier allowance) and is shared by retries and all Connections in
the process.

The swap stream's own cross-language check lives in
`../dlmm-bot/tests/test_executor_swap_stream.py`: it decodes
`fixtures/rpc/dlmm-swap-logs.json` through `fixtures/swap-stream-dump.mjs`
(the same compiled decode path the live subscription uses, with no network),
writes the rows as JSONL, and reads them back through
`dlmm_bot.swap_observer.JsonlSwapEventSource`. It needs no RPC, so it runs in
the default Python lane; only Node and a built `dist/` are required.

See `status.md` for gate evidence and remaining milestones.

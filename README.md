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

M0 scaffolding and M1 wire proof are implemented. The executable currently
requires `DRY_RUN=true` and serves canned data for all six verbs, marked
`data.stub:true` and `data.dry_run:true`. Its receipts and wallet are synthetic;
it performs no RPC calls, simulation, or signing. Live reads start in M2.

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
M1 still requires valid RPC URLs, public-key allowlists, signer kind, and caps,
but the dry-run signer needs no custody ARN. Startup rejects invalid config
on stderr before accepting requests. Runtime audit failures return an error
and exit with status 1. Executor logs rotate on UTC date changes; only executor
JSONL files older than 24 hours are compressed.

Run the complete local/CI gate from this project after installing `dlmm-bot`
and `mm-core` editable into **dlmm-bot's own** `.venv`:

```bash
npm run check:m1
```

This builds first, runs the TS source checks (`test:m1` selects `src/`), then executes
`../dlmm-bot/.venv/bin/python -m pytest -q --executor-subprocess` from the bot
root. The default Python lane skips the 15 subprocess cases. The opt-in lane
fails if Node or the built bridge is missing. Existing keeper scenarios use
`fixtures/keeper-runner.mjs`, which injects canned read state into the exported
real bridge; separate lifecycle and conformance cases launch the unmodified
`node dist/bridge.js` CLI. Both lanes use the same twelve response fixtures.

`npm test` also collects the offline contract/component harness under `tests/`
(currently 54 checks); it is outside the M1 gate command. The live functional
suites under `tests/functional/` are excluded unless `RUN_LIVE=1` is set and
require the separate live-run guards.

See `status.md` for gate evidence and remaining milestones.

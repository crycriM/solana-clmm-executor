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

M0 scaffolding, M1 wire proof, the M2 live reads, and the M3 swap stream are
implemented and gate-passed.
M4's native weighted `deposit_single_sided` and `withdraw` implementations are
wired when `DRY_RUN=false`. They prepare deterministic accounts, bind the
compiled Meteora instructions to policy, simulate before signing, return real
receipts, finalize full closes, and fail ambiguous submissions/readbacks closed.
`swap` and `refresh_bundle` remain disabled pending M5. No custom Rust program
or Solana/Rust toolchain is required: active-bin enforcement is encoded in
Meteora's native `addLiquidityOneSide` instruction.

With `DRY_RUN=true`, the production executable loads no signer: `get_state` and
`get_position` use live Meteora/RPC reads, while write responses remain visibly
marked synthetic stubs. The stream decodes confirmed DLMM events into
`SWAP_STREAM_PATH` and backfills after WebSocket reconnects. M4 is implemented
but has not yet passed the manual on-chain dust gate described below.

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
npm run check:m4
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
`SOLANA_RPC_URL`, `LIVE_POOL`, `LIVE_POSITION_ID`, and `WALLET_PUBKEY`; run
them with `npm run test:live:reads`. Write tests retain their separate
`LIVE_WRITE_CONFIRM=yes` guard.
The M2 read suite defaults to a 30-minute executor-read soak with ten seconds
between samples. `LIVE_READ_SOAK_SECONDS` and `LIVE_READ_INTERVAL_MS` may
shorten a preflight, but an abbreviated run is not soak evidence. This suite
does not run the Python keeper; gate 2 also requires its observation log.

For the actual read-only keeper observation gate, build the executor and run
from this directory with `dlmm-bot` installed in its own `.venv`:

```bash
set -a; source .env.m3; set +a
DRY_RUN=true ../dlmm-bot/.venv/bin/python ../dlmm-bot/tools/live_keeper_soak.py
```

The launcher defaults to 30 minutes at a ten-second cadence. It forces zero
transaction caps and `observation_only=True`, refuses write confirmation or
Solana secret env vars, and passes only allow-listed environment keys to Node.
It derives the observation grid from the owned position's on-chain bin prices;
AS gamma/kappa are deliberately unused and this is not strategy calibration.
It retains the hash-chained keeper log, executor JSONL, swap stream, and a
`summary.json` under `logs/test-artifacts/evidence-keeper-m2-*`. A nonzero exit
means at least one gate check, including `get_state` p95 < 2,000 ms, failed.
To reassess a retained run after a gate change without modifying its original
summary, use `../dlmm-bot/.venv/bin/python ../dlmm-bot/tools/live_keeper_soak.py
--revalidate-existing logs/test-artifacts/evidence-keeper-m2-<run-id>`.

M3 may use `SOLANA_WS_URL` when the HTTP provider does not expose Solana
PubSub at its derived WebSocket URL. HTTP JSON-RPC is CU-rate-limited in the
client; `SOLANA_RPC_MAX_CU_PER_SECOND` defaults to 240 (20% below Alchemy's
300 CU/s free-tier allowance) and is shared by retries and all Connections in
the process.

## Manual M4 dust gate

Use a dedicated, balance-capped wallet and a pool with no active rewards or
Token-2022 transfer hooks. For the local file signer, the key file must be
owned by the executor user, mode `0400` or `0600`, in a parent directory mode
`0700`. Mainnet additionally requires `FILE_SIGNER_ALLOW_MAINNET=true`; leave
it false on localnet/devnet. Cargo and `cargo build-sbf` are not used.

Copy `.env.example` to `.env.test.write` and put the required gateway values in
that private, untracked environment file:
`SOLANA_RPC_URL`, optional write/WS URLs, `WALLET_SIGNER=file`,
`WALLET_KEYPAIR_PATH`, `WALLET_PUBKEY`, pool/mint allow-lists, all policy caps,
log paths, and `DRY_RUN=false`. The first position can conservatively reserve
about 0.22 SOL of policy budget when both bin arrays and a bitmap extension
must be initialized; set caps deliberately and fund no more than the approved
test budget.

The M4 runner also requires `LIVE_POOL`, `LIVE_WRITE_CONFIRM=yes`, a unique
`LIVE_RUN_ID`, explicit `LIVE_DEPOSIT_SIDE=bid|ask`, contiguous offsets from
the freshly read active bin (`LIVE_DEPOSIT_BIN_OFFSETS`, for example `-2,-1`
for a bid), decimal `LIVE_DEPOSIT_AMOUNTS`, and an explicit
`LIVE_MAX_ACTIVE_BIN_SLIPPAGE`. Then run:

```bash
cp .env.example .env.test.write
# Edit every REPLACE_* value and review the dust/cap values before continuing.
npm ci
npm run build
set -a
source .env.test.write
set +a
npm run test:live:m4
```

The command runs only deposit/readback/partial-withdraw/full-close. It does not
collect M5 swap or refresh tests, and it fails during collection if any live
gate value is missing. It derives and checks the position PDA is absent before
writing, then deposits the configured vector twice to prove same-position
addition; budget token funding accordingly. Evidence is written below
`logs/test-artifacts/`.

The swap stream's own cross-language check lives in
`../dlmm-bot/tests/test_executor_swap_stream.py`: it decodes
`fixtures/rpc/dlmm-swap-logs.json` through `fixtures/swap-stream-dump.mjs`
(the same compiled decode path the live subscription uses, with no network),
writes the rows as JSONL, and reads them back through
`dlmm_bot.swap_observer.JsonlSwapEventSource`. It needs no RPC, so it runs in
the default Python lane; only Node and a built `dist/` are required.

See `status.md` for gate evidence and remaining milestones.

# solana-clmm-executor — implementation plan

Status: M0 and M1 locally verified; M2 implemented and offline-verified, with
the 30-minute mainnet evidence run still pending (2026-09-10). Derived from `opms-spec.md` (spec §§ referenced inline;
source of truth for the wire contract is `src/protocol.ts`) and gated by
`meteora-functional-test-plan.md` (test plan §§). Status ledger lives in
`../status.md`.

Reading order: this plan sequences the work; the spec defines *what*; the test
plan defines *who says it passed*. Where this plan and the spec disagree, the
spec (and `protocol.ts`) wins — fix this file.

---

## 0. Ground rules (apply to every milestone)

| Rule | Source |
|---|---|
| stdout is the protocol channel. Nothing but one-response-per-request may ever be written to stdout. | spec §2 |
| Raw u64 amounts are `string` (`RawAmount`). Never `BN.toNumber()`. Decimal = `Number(bn.toString()) / 10**decimals` or `decimal.js`. | spec §5, `protocol.ts` header |
| Never `ok:true` before confirmation at configured commitment (`confirmed` min; `finalized` for withdraw/close). | spec §4 rule 3 |
| Errors are codes from `ErrorCode` in `protocol.ts`, never prose in `error` (prose goes in `data.detail`). No secrets in `error`/`data`. | spec §4 rule 5 |
| Policy rejections fail closed. No "sign anyway" downgrade. | spec §8 |
| Changes to the verb contract update spec + `protocol.ts` + all four `ExecBridge` implementations + shared fixtures in one change. | spec §1.2, §11 |
| lp-monitor code is **vendored by copy, not imported** (plan amendment 2026-09-09, below spec §5): co-maintained by the same authors, but this project must build standalone. Copies live under `src/vendor/lp-monitor/`, carry a provenance header (source path + upstream git SHA), and upstream never imports from here or gains signing authority. | spec §5 (direction), plan amendment (mechanics) |

## 1. Current state

Exists: M0 toolchain, validated config, rotating/redacted logs, vendored read
helpers; M1 `bridge.ts`, six dry-run stub handlers, request validation, shared
fixtures, and a real-subprocess Python keeper lane. See `../status.md` for
verification commands and evidence. M2 live read handlers are implemented;
their mainnet evidence run and the M3 swap stream remain. The bridge does not
load a signer.
dlmm-bot side exists and is the verification harness: `exec_bridge.py`
(`ExecBridge`, `FakeExecBridge`, `ReplayExecBridge`), `keeper.py`,
`swap_observer.py` (`JsonlSwapEventSource`), and `tests/` (12 files,
`test_exec_bridge.py`, `test_keeper.py` are the wire-format consumers).

## 2. Milestones

Five milestones mirroring spec §10 build order. M1–M3 write nothing on-chain
and unblock the whole DLMM logging pipeline; M4–M5 are blocked by the signing
gate (test plan §5) until KMS custody + IAM boundary are stood up.

```
M0 scaffolding ──▶ M1 wire ──▶ M2 reads ──▶ M3 swap stream
                                            │
                              (signing gate: test plan §5)
                                            ▼
                              M4 policy+signer+deposit/withdraw ──▶ M5 swap+refresh_bundle
```

---

## M0 — Project scaffolding

**Goal:** a buildable, lintable, standalone TS project with the reused
lp-monitor code vendored under `src/vendor/lp-monitor/`.
**Depends on:** nothing. **Effort:** S.

**Verified 2026-09-10.** Review corrections: require signer kind; validate
allowlists/URLs/commitment/cap ranges/booleans; exact dev-dependency pins;
structured redaction, stderr transport reinitialization, UTC daily rotation,
compression scoped to executor logs; restored the omitted vendored position
fetch/map helper. Test helpers no longer import other test suites. Startup
metadata is exercised by M1's compiled-CLI test.

### T0.1 Node/TS toolchain

Create in repo root (`solana-clmm-executor/`):

- `package.json` — name `solana-clmm-executor`, `"type": "module"`, engines
  `node >= 20`. Scripts: `build` (`tsc -p .`), `dev` (`tsx src/bridge.ts`),
  `test` (`vitest run`), `lint` (`eslint src/`), `typecheck`.
- `tsconfig.json` — `target: es2022`, `module: nodenext`, `strict: true`,
  `outDir: dist`, `rootDir: src`. No cross-repo path aliases: everything this
  project compiles lives under `src/` (vendored lp-monitor code included, T0.5).
- `eslint` + `prettier` configs (match lp-monitor's if it has them).
- `.gitignore` (`node_modules`, `dist`, `logs/`).

### T0.2 Dependencies

Exact pins, matching lp-monitor's versions so the vendored copies (T0.5) build
against the same SDK surface (spec §5):

- `@meteora-ag/dlmm@1.5.0`, `@solana/web3.js@1.98.2`, `bn.js`
- `winston` + `logform` (vendored logger's deps)
- `axios` (vendored token-mapping + adapter HTTP)
- `decimal.js` (raw→decimal conversions)
- Jito: `@jito-labs/block-engine` or minimal raw HTTP to
  `JITO_BLOCK_ENGINE_URL` (decide in T5.3; do not add before M5)
- dev: `typescript`, `vitest`, `tsx`, `eslint`, `prettier`, `@types/node`
- Deliberately **not** depended on: `lp-monitor` itself (no `file:` dep, no
  path alias), and `csv-writer` — the vendored copies have their CSV
  side-effects stripped (T0.5, spec §5 "must not copy").

**Acceptance:** `npm run build && npm test` (empty suite) green in CI-able
one-liner. No `console.log` anywhere (lint rule: `no-console` with
`console.error` allowed only through the logger).

### T0.3 Config module (`src/config.ts`)

Env parsing + startup validation for spec §9:

```
SOLANA_RPC_URL, SOLANA_RPC_WRITE_URL (default = read), SOLANA_WS_URL (optional;
explicit subscription endpoint), SOLANA_COMMITMENT (confirmed)
SOLANA_RPC_MAX_CU_PER_SECOND (default 240; Alchemy free-tier headroom)
WALLET_SIGNER=kms|keypair, KMS_KEY_ARN | WALLET_SECRET_ARN
POOL_ALLOWLIST, MINT_ALLOWLIST (comma-separated pubkeys)
MAX_SOL_PER_TX, MAX_SOL_PER_RUN, MAX_SLIPPAGE_BPS, MAX_PRIORITY_FEE_LAMPORTS
JITO_ENABLED, JITO_BLOCK_ENGINE_URL, JITO_TIP_LAMPORTS
SWAP_STREAM_PATH, EXECUTOR_LOG_DIR
DRY_RUN
```

- Fail closed at startup if signer, RPC, or either allow-list is missing
  (spec §9). M1–M3 run with `DRY_RUN=true` and a dummy signer shape permitted
  only in dry-run.
- All HTTP retries pass through a shared CU-aware limiter. The 240 CU/s
  default stays below Alchemy's 300 CU/s free-tier throughput and prevents
  reconnect backfills from creating an unmetered retry burst.
- Export `policyHash(): string` — sha256 of the normalized policy-relevant
  config; feeds `executor_started.policy_hash` (spec §7, §9).

**Acceptance:** unit tests: missing-var rejection per required key;
`policyHash` stable under key reordering, changes when any cap changes.

### T0.4 Logging skeleton (`src/log.ts`)

- Import the winston logger from `src/vendor/lp-monitor/logger.ts` (T0.5;
  console transport already moved to **stderr** there — spec §5).
- Executor-internal JSONL writer per spec §7: `logs/executor-{runId}.jsonl`,
  one line per verb with `req_seq`, `method`, `received_at`, `responded_at`,
  `duration_ms`, redacted request, full response envelope, `attempt`,
  `rpc_endpoint`, `blockhash`, `simulation_ok`, `simulation_logs` (on failure),
  `policy_decision`, `signer_id`, `bundle_id`.
- Line types also emitted here: `executor_started`, `executor_stream_gap`,
  `policy_rejected`, `rpc_failover`.
- Redaction filter (hard rule, spec §7): strip private keys, KMS material,
  signed tx bytes, env dumps; wallet pubkey + signatures pass.
- Daily rotation + gzip after 24 h.

**Acceptance:** unit test that a fake request containing a 64-byte base58 secret
in an unexpected field is redacted in the written line; `executor_started`
records node version, DLMM SDK version, git SHA (`git rev-parse HEAD` at
build-time or runtime), RPC endpoints, wallet pubkey, `policy_hash`.

### T0.5 Vendor lp-monitor sources (plan amendment: copy, not import)

lp-monitor is **not** a runtime dependency. Copy the reused code into
`src/vendor/lp-monitor/`, trimmed to what M2–M3 need, so this project builds and
ships standalone. Each vendored file gets a provenance header:

```
// vendored from LP-hedging-strategy/lp-monitor/src/<path> @ git <SHA>
// co-maintained; strip = CSV/signing side-effects removed. Do not edit
// in place without noting the delta here.
```

Copy these, with the named edits:

| Vendored file | From | Edit on copy |
|---|---|---|
| `src/vendor/lp-monitor/solana.ts` | `chains/solana.ts` `getSolanaConnection()` | extend: commitment arg + distinct write endpoint (T2.1) |
| `src/vendor/lp-monitor/logger.ts` | `utils/logger.ts` winston logger | **console transport → stderr** (spec §5); drop any file paths this project overrides |
| `src/vendor/lp-monitor/types.ts` | `services/types.ts` `PositionInfo`, `LiquidityProfileEntry` | add `*_raw: string` fields (spec §3.2) |
| `src/vendor/lp-monitor/meteoraReads.ts` | `dexes/meteoraDlmmAdapter.ts` `fetchMeteoraPositions`, `withRetry`, BN→decimal scaling | **strip `saveMeteoraPositionsToCsv`, `updatePositionTracking`, and the `csv-writer` import** (spec §5 "must not copy"); keep raw BN beside every decimal |
| `src/vendor/lp-monitor/tokenMapping.ts` | `services/tokenMappingService.ts` `getTokenMapping`, `getTokenPrices` | **strip CSV write side-effects**; keep the rate-limit + in-memory cache (the CSV cache becomes a JSON cache under `EXECUTOR_LOG_DIR` or is dropped) |

Hard exclusions carried over from lp-monitor (spec §5 "must not be copied"):
`BN.toNumber()` on u64 (use `BN.toString()`), and all CSV persistence — this
project's persistence is the JSONL log.

**Provenance rule:** because the two projects are co-authored, upstream fixes to
these five functions are pulled in by re-copying and bumping the SHA in the
header — a deliberate, reviewable step, not an automatic import. Add a
`vendor/README.md` listing the five files, their upstream paths, and the pinned
SHA so the drift check is mechanical (`git -C ../LP-hedging-strategy show
<sha>:<path>` vs the copy).

**Acceptance:** `src/vendor/lp-monitor/` compiles under this project's tsconfig
with no `../..` import reaching outside `src/`; no CSV imports or raw-BN
numeric conversions in executable code (provenance/safety comments still name
the excluded patterns); `npm run build` green.

---

## M1 — Wire proof (spec §10 step 1)

**Goal:** dlmm-bot's keeper test suite passes against the real subprocess in
place of `FakeExecBridge`. Proves the JSON-lines contract end to end before any
chain code exists.
**Depends on:** M0. **Effort:** S–M. **Writes on-chain:** no.

**Gate 1 passed locally 2026-09-10.** `npm run check:m1` runs the build, TS
typecheck/lint/tests, then the full Python suite with `--executor-subprocess`.
All twelve existing keeper cases run against both bridges. Three additional
cases exercise all six verbs, child restart, and a receipt-bearing keeper
lifecycle through the built bridge with explicit stub injection. Twelve shared envelopes are checked
on both sides. The first error-fixture slice is malformed requests;
broader error coverage and all-four-bridge replay remain cross-cutting work.

### T1.1 `src/bridge.ts` — stdio loop

- Readline over stdin; per line: parse JSON → dispatch to handler → write one
  response line to stdout, in request order (single-flight: queue requests,
  process sequentially — no id field exists, spec §2).
- Malformed request line → respond `errorResponse('bad_request', ...)`; never
  crash the loop.
- Handler throw → respond `{"ok":false,"error":"internal_error","data":{"detail":...}}`,
  log to stderr + executor JSONL, keep running.
- Unrecoverable state (e.g. log dir unwritable, config invalidated at runtime):
  emit the failure response, then `process.exit(1)` — `ExecBridge.start()`
  restarts on next call (spec §2).
- On startup, before reading stdin, emit `executor_started` to the executor
  JSONL (T0.4).

### T1.2 `src/handlers.ts` — stub implementations

- `ExecHandlers` (protocol.ts) shape; each verb returns canned `data` matching
  the verb's `*Data` type with a `"stub": true` marker field in `data`.
- Canned values must be *type-valid*: `balances_raw` strings, `position_id`
  present on deposit success, receipts with non-null `fee_lamports` — the
  keeper tests assert on these.

### T1.3 Shared conformance fixtures (spec §11, first slice)

- `fixtures/responses/<verb>.ok.json`, `<verb>.error.json` — the exact envelope
  of spec §4 (single canonical spelling only).
- Python-side consumer: add `dlmm-bot/tests/test_executor_fixtures.py` that
  loads every fixture and asserts `ExecResult.from_payload` parses it with all
  receipt fields non-null and `transactions[i].signature == tx_signatures[i]`.
- TS-side: vitest that stub handler output deep-equals the fixture (after
  stripping `stub` marker).
- These fixtures become the shared set replayed through all four ExecBridge
  implementations (spec §11) — put them where the other bridges can reach them
  (`solana-clmm-executor/fixtures/`; dlmm-bot test imports by relative path).

### T1.4 Subprocess keeper run

- New marker/flag in `dlmm-bot/tests/test_keeper.py` (or `conftest.py` fixture
  `real_subprocess_bridge`) that swaps `FakeExecBridge` for
  `ExecBridge(cmd=['node','dist/bridge.js'], cwd='../solana-clmm-executor')`
  against the stub handlers. Skip in the default lane (needs `npm run build`);
  run in CI after build.
- Implemented as marker `executor_subprocess`, flag `--executor-subprocess`,
  and fixture `real_subprocess_bridge`. Existing tests inject read scenarios
  through test-only runners importing the built bridge; the production CLI
  has no test flags or extra verbs. From M2 onward, production always wires
  live reads and offline contract cases use `fixtures/stub-runner.mjs`.
- **Acceptance (gate 1):** keeper suite green through the real subprocess;
  fixture parse test green on the Python side. Record in `status.md`.

---

## M2 — Read verbs (spec §10 step 2)

**Goal:** live `get_state` + `get_position` against mainnet, read-only, keeper
in `dry_run`.
**Depends on:** M1. **Effort:** M. **Writes on-chain:** no.

**Implemented and offline-verified 2026-09-10. Live gate pending.** The pinned
SDK exposes `getPosition`, not the planned `getPositionByAddress`; the executor
first validates the position account's program/discriminator/pool/owner header,
then calls `getPosition` on the cached pool instance. This avoids a full wallet
position scan. Production M2 requires `WALLET_PUBKEY` while signer loading
remains deliberately deferred to M4.

### T2.1 `src/meteora.ts` — connection + pool cache

- `getSolanaConnection()` from `src/vendor/lp-monitor/solana.ts` (T0.5), already
  extended with: read endpoint + distinct write endpoint
  (`SOLANA_RPC_WRITE_URL`), default commitment from config.
- `withRetry` from `src/vendor/lp-monitor/meteoraReads.ts`; on retry across
  endpoints, emit `rpc_failover` line (spec §7).
- Process-lifetime pool metadata cache: `{lBpsPerLamport, bin step, token_x/y
  mints+decimals, ...}` fetched once per pool (spec §3.1: only `activeBin` and
  balances re-fetch per call).
- TVL: `getTokenMapping` + `getTokenPrices` from
  `src/vendor/lp-monitor/tokenMapping.ts` (T0.5; upstream was
  `services/tokenMappingService.ts` — CSV writes stripped, rate-limit kept; do
  not re-add CSV side effects, spec §5 "must not copy"). `tvl_usd: null` on
  price miss (disables rug kill-switch that cycle; keeper handles null).

### T2.2 `get_state` handler

- `DLMM.create(poolAddress, connection)` from cache → `getActiveBin()`,
  `getBalance()` (or `getPositionsOfOwner` filtered) for wallet token accounts.
- Response `data` = `StateData` (protocol.ts): decimal + `_raw` string
  balances, `base_fee_bps` from current pool fee (feeds bin_fill accrual),
  `slot` from RPC response context, `fetched_at` = wall clock seconds (float).
- p95 target < 400 ms (spec §3.1): measure by logging `duration_ms` in the
  executor JSONL; assert in T2.4.

### T2.3 `get_position` handler

- Position read via `dlmm.getPositionByAddress`; map `LiquidityPosition` →
  `PositionBin[]` reusing the BN→decimal scaling from
  `src/vendor/lp-monitor/meteoraReads.ts` (keep raw `BN.toString()` beside every
  decimal field).
- `claimable_fee_x/y` + `_raw`: exact on-chain values only — these feed the
  cash-vs-accrual reconciliation in `dlmm_bot.pnl_explain` (spec §3.2). No
  smoothing, no estimation.
- `unknown_position` error when the PDA doesn't exist or isn't owned by the
  configured wallet.

### T2.4 Verification (gate 2)

- vitest units with RPC mocks (recorded mainnet responses as fixtures —
  `fixtures/rpc/`) for: raw-string correctness on a > 2^53 amount (regression
  for the `BN.toNumber()` hazard), missing-position error, cache hit (second
  call issues no metadata RPC).
- Live: run keeper `dry_run` on mainnet for one pool ≥ 30 min; check
  `state_observation` / `position_observation` events populate with
  `claimable_fee_*_raw` non-null and monotonic-slot sanity; p95 `duration_ms`
  < 400 ms from executor JSONL. Attach the log path to `status.md`.
- Test plan §8.2 (connectivity and live reads) closure.

---

## M3 — Swap stream (spec §10 step 3) — mandatory, not optional

**Goal:** decoded Meteora swaps → `SWAP_STREAM_PATH` JSONL → keeper's
`observed_trade` / `bin_fill` events → `verify_log.py` completeness green.
**Depends on:** M2 (reuses connection + pool cache). **Effort:** M–L.
**Writes on-chain:** no. **Ships before any signing exists** — without it the
keeper has no verified fills and `verify_log.py` fails closed (spec §6).

**Implemented and gate-passed 2026-09-10; offline, cross-language, and
30-minute mainnet live checks passed.** Implementation notes: the DLMM IDL
(v0.9.0) declares `events` without
matching `types` entries or discriminators, so Anchor 0.30's `BorshEventCoder`
cannot be built from it directly — `src/events.ts` constructs one coder per
event from the IDL's own field list with `publicKey` remapped to `pubkey`.
`fee_bps` is derived from `fee / amountIn` because the event's `feeBps` u128
scale is undocumented and unverified. `bins_crossed` is deliberately **not**
emitted: the shipped `Swap` event carries only aggregate in/out and fee, so any
per-bin split would be fabricated, and a wrong split is worse than none for
`verify_log.py` §6.2 — the observer derives the crossed range itself from
`prev`/`new_active_bin`. The replay gate decodes the recorded event fixture
through the compiled TypeScript stream, tails the exact file from Python, emits
`observed_trade` / `bin_fill`, and passes `verify_log.py` completeness against
the fixture swap set. See `status.md` for retained live evidence and the
independent chain-completeness result.

`src/socketTeardown.ts` exists because `removeOnLogsListener` alone does not
release a `Connection`: the client reconnects its socket implicitly and the
resulting timers pin the event loop, so the executor would never exit on stdin
EOF and `ExecBridge` would never see the restart it relies on (spec §2). It
reaches into `Connection`/`ws` internals — a deliberate, contained, fail-open
liability — with `bridge.ts`'s explicit exit as the backstop.

### T3.1 `src/swapStream.ts` — subscription

- One `connection.onLogs(pool, {commitment: config.solanaCommitment})` mentions
  subscription per configured pool (spec §6: runs whether or not we hold a
  position — `crossed_ours` is the observer's call). Current Meteora events are
  event-CPI inner instructions, so this bounds transaction-fetch load instead
  of fetching every DLMM swap globally; decoded events are still validated as
  DLMM instructions and filtered by their `lbPair`.
- Decode swap events from the DLMM program's anchor IDL
  (`@meteora-ag/dlmm` ships the IDL; event discriminator + `swapBaseInput` /
  `swapActiveInAmount`-style fields). Deliverable: `prev_active_bin`,
  `new_active_bin` **from the decoded event**, never a poll diff (spec §6).
- `bins_crossed` per-bin deltas from the event when decodable; omit
  `bin_price` if absent (observer fills from grid).
- Row = `SwapStreamRow` (protocol.ts). `tx_signature` always present, never
  synthesized. `ts` = wall clock at decode; `block_time` from the log's
  `getBlockTime` (async, backfill the field if it lands late — but a row must
  not be emitted with `block_time: null`; hold the line until resolved or
  fetch from the slot's block once).

### T3.2 Append-only JSONL writer

- `fs.createWriteStream(path, {flags:'a'})`, write + flush per line
  (`write()` then await drain, or `appendFile` per row — pick one, benchmark;
  spec §6 forbids buffered batch writes).
- The file must satisfy `JsonlSwapEventSource` (swap_observer.py:237): byte
  offset tracking, truncation tolerance — verify against the Python reader's
  expectations with a cross-language test (T3.4).

### T3.3 Gap handling + backfill

- Track last emitted `(slot, signature)` per pool. On websocket
  disconnect/reconnect: `getSignaturesForAddress(poolLcda, until=last)` →
  fetch and decode missed txs in slot order → replay to file → resume live
  tail (spec §6: overlap free via observer dedupe, gaps fatal).
- Emit `executor_stream_gap` line to the executor JSONL with gap bounds
  (`from_signature`, `to_signature`, slot range) so `verify_log.py` §6.4 can
  distinguish known gaps from silent loss.

### T3.4 Verification (gate 3)

- vitest units with recorded log-notification fixtures: decode → row field
  mapping; reconnect fixture (kill mid-stream, assert backfill emits the
  skipped swaps in slot order + `executor_stream_gap` line).
- Cross-language integration: point `dlmm-bot` `swap_stream_path` at the file
  written by the executor (live tail of a busy pool, or a replay harness that
  pipes recorded logs through `swapStream.ts`); assert `observed_trade` /
  `bin_fill` events appear in the keeper event log and
  `verify_log.py` §6.2/§6.4 pass.
- Test plan §8.2 stream half + spec §11 "stream completeness" closure.
- Record gate 3 in `status.md`; at this point the full read-only logging
  pipeline of `dlmm-bot` is unblocked.

---

## M4 — Signing: policy + signer + deposit/withdraw (spec §10 step 4)

**BLOCKED until the signing gate passes (test plan §5):** KMS Ed25519 signer
provisioned, IAM boundary proven (§5.2), test-wallet-only key (§5.3), and
test plan §10 live-write controls in place. Nothing in M4 runs against a real
wallet before that.

**Depends on:** M1–M3, signing gate. **Effort:** L. **Writes on-chain:** yes
(dust wallet only until §11 acceptance).

### T4.1 `src/signer.ts`

- Interface `signTransaction(tx): Promise<Buffer>` with two impls selected by
  `WALLET_SIGNER`: `kms` (AWS KMS `Sign` with Ed25519 — test plan §5.1) and
  `keypair` (Secrets Manager ARN fallback, §5.4; devnet/local-validator only —
  refuse `keypair` against mainnet unless an explicit override env is set).
- `signer_id` (KMS key ARN / pubkey) into every executor JSONL verb line.
- The private key must never enter the process env or heap in the `kms` path;
  the `keypair` path zeroes the buffer after use.

### T4.2 `src/policy.ts` (spec §8, test plan §6)

Validate every compiled transaction **before** the signing request:

1. program-ID allow-list: Meteora DLMM, Jupiter router (v6), SPL Token +
   Token-2022, System, Compute Budget, Jito tip account;
2. writable-account allow-list derived from (1) + configured pools + owner's
   own token accounts/ATA — reject unknown writable accounts;
3. pool ∈ `POOL_ALLOWLIST`, every mint touched ∈ `MINT_ALLOWLIST`;
4. configured wallet is fee payer and the only signer;
5. ALT contents of versioned txs expanded and re-checked against 1–2;
6. caps: per-tx base amount, quote amount, SOL spend, `max_slippage_bps ≤
   MAX_SLIPPAGE_BPS`, priority fee ≤ `MAX_PRIORITY_FEE_LAMPORTS`, cumulative
   SOL per run ≤ `MAX_SOL_PER_RUN` (run counter in-process, reset on restart
   and say so in `executor_started`);
7. simulate (`simulateTransaction`, sig-verify off) — on failure return
   `simulation_failed` + `simulation_logs` into the executor JSONL, **without
   signing**.
- Any rule miss → `ok:false, error:"policy_rejected", data.rule:"<rule_id>"` +
  `policy_rejected` log line. Fail closed, always.

### T4.3 `deposit_single_sided` (spec §3.3)

- Pre-validate (before building the tx):
  - `bin_ids` contiguous, strictly increasing (else `bad_request`);
  - bids strictly `< active_bin`, asks `>= active_bin` (else
    `bins_cross_active` — reject, never let the SDK auto-correct);
  - side-dependent units: bid amounts are quote, ask amounts are base; check
    `sum(amounts)` ≤ wallet balance for that token (else
    `insufficient_balance`). This check is the guard on "the single most
    expensive bug available in this interface" (spec §11).
- Build via `dlmm.addLiquidityByStrategySingleSide` (or `initializePositionAndAddLiquidityByStrategy`
  for the first deposit); `strategy_type` passthrough.
- Second deposit on a live position must return the **same** `position_id`
  (keeper logs `position_liquidity_added`).
- Success without a resolvable `position_id` → return `ok:false`
  (`internal_error`, detail) — protocol violation per spec §3.3.
- Confirm at `confirmed`, fetch receipt via `getTransaction` → real
  `meta.fee`, slot, block_time (spec §4 rules 1–2).

### T4.4 `withdraw` (spec §3.4)

- `bps` → fraction = `clamp(bps,1,100)/100`; echo `data.fraction`. Fee claim
  always included (`removeLiquiditySingleSide` + claim, or
  `closePosition` when fraction = 1).
- Confirm at **finalized** (spec §4 rule 3).
- Response `WithdrawData`: `fees_claimed` + `amounts_returned` (decimal + raw)
  measured from pre/post token-account deltas of the confirmed txs — the
  cash-basis side of fee reconciliation. `closed` true iff position rent
  account is gone.
- `unknown_position` if PDA missing/not owned.

### T4.5 Verification (gate 4)

- Local validator (solana-test-validator + local DLMM program + local Meteora
  pool — test plan §4 environment): **the spec §11 unit — `side:"bid"` debits
  quote and `side:"ask"` debits base, asserted against wallet balance
  deltas.** This test is the release blocker for M4.
- Policy unit matrix: one test per rule (7 rules × reject/accept).
- Dust lifecycle per test plan §8.3 on devnet + mainnet dust wallet; per-bin
  placement readback §8.4; restart/recovery §8.8 (kill executor mid-run,
  `ExecBridge` restart, keeper reconciles via `get_state`/`get_position`).
- Receipt fidelity: `sum(transactions[].fee_lamports)` equals independently
  fetched on-chain fees.

---

## M5 — `swap` + `refresh_bundle` (spec §10 step 5)

**Depends on:** M4. **Effort:** M–L. Bundle last — it is the only atomicity
risk (spec §10).

### T5.1 `swap` (spec §3.5)

- Reject `in_mint`/`out_mint` of `"base"`/`"quote"` or any mint outside
  `MINT_ALLOWLIST` → `bad_request`. No guessing (history note in spec §3.5).
- `pool == null` → Jupiter quote+swap (`/swap` v0 API or `@jup-ag/api`, decide
  here); `pool` set → direct `dlmm.swapQuote` + `swap`.
- Simulate first; realized-out from simulation must satisfy
  `slippage ≤ max_slippage_bps` else `ok:false, error:"slippage_exceeded"` —
  never submit a partially-acceptable route.
- `SwapData` from the **confirmed** tx's inner-instruction token deltas
  (realized, not modeled): `amount_in/out` + raw, `price_realized`, `route`.

### T5.2 Sequential `refresh_bundle` (spec §3.6)

- withdraw 100 % → optional swap → redeposit both sides, sequentially, each
  confirmed before the next.
- On mid-bundle failure: **no blind retry**. Return `ok:false` with
  `data.stage ∈ withdrew|swapped|deposited`, every receipt collected so far,
  and `data.position_id` of whatever now exists; keeper reconciles from chain
  truth next cycle.
- Success: new `position_id`, `fees_claimed`, `amounts_returned`, one receipt
  per tx in submission order.

### T5.3 Jito bundle path

- `JITO_ENABLED=true`: build the same three txs, tip via `MAX_PRIORITY_FEE`
  budget into the Jito tip account (allow-listed in T4.2 rule 1), submit as
  bundle to `JITO_BLOCK_ENGINE_URL`.
- All-or-nothing by construction; on bundle drop return `ok:false`,
  `data.stage:"bundle_dropped"`, no state change.
- `bundle_id` in the executor JSONL line; receipts still per-transaction from
  confirmed-tx fetches.
- Decide the submission client here (raw HTTP `sendBundle` is ~100 lines and
  avoids a heavy dep; only add an SDK if raw proves painful).

### T5.4 Verification (gate 5)

- Keeper end-to-end verb flow (test plan §8.7) on devnet: full ladder
  deposit → refresh → de-risk → emergency exit.
- Failure injection: kill RPC between withdraw and swap in sequential mode →
  assert `stage:"withdrew"` + receipts + reconcilable `position_id`;
  bundle-drop simulation → assert zero state change.
- Ambiguous submission path (spec §4 rule 4): force timeout after send, assert
  `submission_ambiguous` + `data.pending_signature` + signature present in
  `tx_signatures`.
- Round-trip (spec §11): record a live session, replay through
  `ReplayExecBridge` (`dlmm-bot/tools/replay.py`) with zero decision diffs.
- Test plan §11 acceptance criteria sign-off; update `status.md`.

---

## 3. Cross-cutting work items

| ID | Item | When |
|---|---|---|
| X1 | `verify_log.py` runbook: document the exact command + expected outputs for gates 2–5 in this plan's verification sections | M2 |
| X2 | Shared fixture dir consumed by all four ExecBridge impls (spec §11) — M1 TS/Python parser slice done; wire Fake/Replay/Gateway fixture replay in subsequent conformance work | M1 first slice done, keep current |
| X3 | CI-ready lane: `npm run check:m1` builds and runs TS checks + full bot suite with `--executor-subprocess` (marker `executor_subprocess`); CI checkout must provide sibling projects and the bot venv | M1 command implemented; local execution verified |
| X4 | Retirement PR for `GatewayExecBridge` write verbs + phase-3 PWL adapter closure (spec §1.2) — coordinate with `hb-enhanced-opms` once M4 gate passes | after M4 |
| X5 | `DLMMController` (phase3 Deliverable B) constructed with the TS bridge, not the Gateway bridge (spec §1.2) | after M4 |
| X6 | Log volume check: ~17 k verb lines/day/pool + swap stream; confirm rotation/gzip sizing after M3 live soak | M3 exit |
| X7 | HTTP transport (test plan §8.1) — **explicitly deferred**; only when a second non-subprocess consumer exists (spec §2 `ponytail:`) | not now |

## 4. Effort and sequencing summary

| Milestone | Effort | Chain writes | Gate |
|---|---|---|---|
| M0 scaffolding | S | no | build+lint green |
| M1 wire | S–M | no | keeper suite vs real subprocess (fixture parse + T1.4) |
| M2 reads | M | no | dry-run mainnet observations + p95 < 400 ms |
| M3 swap stream | M–L | no | `observed_trade`/`bin_fill` + `verify_log.py` §6.2/§6.4 |
| M4 signing core | L | dust only | bid-debits-quote unit + dust lifecycle §8.3/§8.4 |
| M5 swap+bundle | M–L | dust only | e2e §8.7 + replay round-trip + receipt fidelity |

Recommended order of execution: M0 → M1 → M2 → M3 (unblocks the entire
dlmm-bot logging pipeline with zero custody risk), stand up the signing gate
(test plan §5) in parallel during M3, then M4 → M5.

## 5. Top risks

1. **Side/units inversion in `deposit_single_sided`** (bid↔quote / ask↔base) —
   mitigated by the balance pre-check (T4.3) and the local-validator delta
   unit (T4.5, spec §11). Treat any regression here as a release blocker.
2. **Swap-stream gap on reconnect** — mitigated by mandatory backfill +
   `executor_stream_gap` bounds (T3.3) and the WS-kill test.
3. **Fee-estimate drift** — `fee_lamports` must come from confirmed receipts
   only; DRY_RUN uses simulation estimates and is visibly marked
   (`data.dry_run`, `dryrun_` signature prefix, spec §9) so it can never be
   confused with live accounting.
 4. **lp-monitor copy drift** — vendored files (T0.5) fall behind upstream
    fixes. Mitigated by the provenance header + `vendor/README.md` SHA pin, so
    the drift check is mechanical (`git show <sha>:<path>` vs the copy) and
    re-copying is a deliberate reviewed step, not a silent import. No build
    coupling: lp-monitor refactors cannot break this project.
5. **Contract drift across four ExecBridge implementations** — mitigated by
   shared fixtures (X2) and the one-change rule (§0).

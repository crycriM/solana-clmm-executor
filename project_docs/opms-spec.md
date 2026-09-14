# solana-clmm-executor — Meteora DLMM OPMS specification

Status: specification (2026-09-03). Companion docs:
`meteora-functional-test-plan.md` (security/test gate),
`implementation-plan.md` (milestones/tasks derived from this spec),
`../../clmm-animation/docs/dlmm-logging-plan.md` (log contract),
`../../AGENTS.md` (monorepo seam).

The machine-readable interface is `src/protocol.ts`. Where this document and
that file disagree, the file wins.

---

## 1. Role

`solana-clmm-executor` is the **body** for the Solana DLMM path: the only
component in the monorepo that holds signing authority for the LP wallet.
`dlmm-bot` (`src/dlmm_bot/keeper.py`) is the **brain**: it decides target state
and emits verbs. The executor converts verbs into Meteora instructions, signs,
submits, confirms, and returns a **receipt-rich** result.

```
dlmm-bot Keeper ──JSON-lines verb──▶ solana-clmm-executor ──▶ Meteora / Jupiter / Jito
      ▲                                      │
      │  ExecResult (+ receipts)             ├─▶ swap-stream JSONL  (§6)
      └──────────────────────────────────────┘   (tailed by JsonlSwapEventSource)
```

Non-goals: strategy, ladder shaping, PnL, risk. Those live in `dlmm-bot` /
`mm-core`. The executor never decides *whether* to act.

### 1.1 Why not Hummingbot Gateway

`../../clmm-animation/gateway-openapi.json` documents HB Gateway's
`/connectors/meteora/clmm/*` surface. It has no per-bin liquidity placement, no
per-bin remaining amounts, and no receipt fields (`slot`, `blockTime`, `fee`),
so it cannot satisfy the logging plan's §3 extension or §5 PnL fold. We keep it
as the naming reference for endpoints and error shapes only.

### 1.2 Relationship to the phase-3 Gateway path — this project supersedes it

`clmm-animation/docs/dlmm-phase3-implementation-plan.md` routed the keeper's
write verbs through `GatewayExecBridge`
(`hb-enhanced-opms/src/opms/gateway/exec_bridge.py`). Live testing against
Gateway 2.15 (phase3 §4.2/§4.6/§9) found the write bodies don't exist in the
real API: `open-position` takes `lowerPrice`/`upperPrice` + canned
`strategyType`, not the per-bin `binIds`/`amounts` arrays the keeper's ladder
requires; the phase-3 workaround was a PWL adapter tiling canned-mode
sub-positions. Gateway also cannot return per-transaction receipts, so §4 of
this spec is unsatisfiable through it.

This executor is the replacement for that write path. Once it is live:

- `GatewayExecBridge`'s **write verbs are retired** from the DLMM path (its
  read-only `get_state` may survive for scripts that don't merit a subprocess).
  The phase-3 PWL-adapter work item is closed as *obsoleted*, not deferred.
- `DLMMController` (phase3 Deliverable B) keeps its schedule/lifecycle role but
  must be constructed with the TS `ExecBridge` (this project), not
  `GatewayExecBridge`.
- The keeper-facing `ExecBridge` interface is unchanged either way — that is
  the whole point of the seam.

Note that this makes **four** implementations of that one interface:
`FakeExecBridge`, `ReplayExecBridge`, `GatewayExecBridge`, and the TS executor.
The monorepo already carries a duplicate-exec-layer hazard
(`dex_executor` vs `hb-enhanced-opms`, AGENTS.md); do not add a fifth variant
— changes to the verb contract go through this spec and §11's shared
conformance fixtures, and every implementation is updated in the same change.

## 2. Transport

**JSON-lines over stdin/stdout**, one request per line, one response per line,
in request order. This is what `dlmm_bot.exec_bridge.ExecBridge` already
speaks — the executor is launched as `node dist/bridge.js` with `cwd` set to
this project.

- Request: `{"method": <verb>, ...params}`; the bot does not send an id, so
  **responses must be strictly ordered** and the process must be single-flight
  per stdin line.
- Response: `{"ok": bool, "data": {...}, "error": string|null, ...receipt}`.
- Anything written to stdout that is not a response corrupts the stream. All
  human logging goes to **stderr** and to the winston file transport (§7).
- A response line must be emitted for every request, including internal
  crashes. On unrecoverable state, emit `{"ok":false,"error":...}` then exit;
  `ExecBridge.start()` restarts the subprocess on next call.

No HTTP server in v1. `ponytail:` stdio only — add an authenticated HTTP
transport (test plan §8.1) when a second, non-subprocess consumer exists. The
verb handlers must therefore be transport-agnostic pure functions
(`handlers.ts`), with `bridge.ts` a thin stdio loop over them.

## 3. Verbs

All six are already called by the keeper. Parameter names are fixed by
`exec_bridge.py` — do not rename.

| Verb | Called from | Purpose |
|---|---|---|
| `get_state` | `_cycle` step 1, every cycle | pool active bin, wallet balances, TVL |
| `get_position` | `_cycle`, every cycle with a live position | per-bin amounts + claimable fees, raw |
| `deposit_single_sided` | `_deposit_ladder` | place one side of the ladder |
| `withdraw` | `_stop_quoting`, `_de_risk`, `_emergency_exit` | remove liquidity + claim fees |
| `swap` | `_de_risk`, `_emergency_exit` | inventory rebalance / exit leg |
| `refresh_bundle` | `_refresh_ladder` | withdraw → optional swap → redeposit |

### 3.1 `get_state`

Request `{method, pool}`. Response `data`:

```jsonc
{
  "active_bin": 8123,                 // int, REQUIRED
  "bin_step_bps": 25,                 // int
  "base_fee_bps": 25,                 // current pool fee, feeds bin_fill accrual
  "balances":     {"base": 12.5, "quote": 4200.0},   // wallet, decimal
  "balances_raw": {"base": "12500000000", "quote": "4200000000"},
  "tvl_usd": 1850000.0,               // null allowed; drives the rug kill-switch
  "token_x": {"mint": "...", "decimals": 9, "symbol": "SOL"},
  "token_y": {"mint": "...", "decimals": 6, "symbol": "USDC"},
  "slot": 301234567,
  "fetched_at": 1756900000.123
}
```

`active_bin` and `balances` are load-bearing: the keeper reads them directly and
`tvl_usd == null` disables rug detection for that cycle. `balances_raw` values
are **strings** (u64 exceeds JS safe-integer range) and are logged verbatim into
`state_observation.balances_raw` for rounding re-audit.

The keeper polls this every `refresh_interval` (5 s default). Cache pool
metadata (mints, decimals, bin step) for the process lifetime; re-fetch only
`activeBin`/balances per call. Target p95 < 2,000 ms.

### 3.2 `get_position`

Request `{method, position_id}`. Response `data`:

```jsonc
{
  "position_id": "...", "pool": "...", "owner": "...",
  "active_bin": 8123, "min_bin_id": 8100, "max_bin_id": 8140,
  "bins": [
    {"bin_id": 8100, "bin_price": 141.2,
     "amount_base": 0.0, "amount_quote": 250.0,
     "amount_base_raw": "0", "amount_quote_raw": "250000000",
     "liquidity_share": 0.0142}
  ],
  "claimable_fee_x": 0.0031, "claimable_fee_y": 1.84,
  "claimable_fee_x_raw": "3100000", "claimable_fee_y_raw": "1840000",
  "total_base": 3.2, "total_quote": 900.0,
  "slot": 301234567
}
```

Every field above is read by name in `keeper._cycle` → `position_observation`,
and the `claimable_fee_*` deltas between consecutive observations are the
**accrual-basis LP fee income** in `dlmm_bot.pnl_explain`. They must be exact
on-chain values, never estimates — a smoothed or interpolated fee breaks the
cash-vs-accrual divergence check (logging plan §5).

`bins` maps 1:1 onto lp-monitor's `LiquidityProfileEntry` (§5); reuse that
shape, adding the `*_raw` strings.

### 3.3 `deposit_single_sided`

Request:

```jsonc
{"method":"deposit_single_sided","pool":"...","side":"bid"|"ask",
 "bin_ids":[8100,8101,...], "amounts":[250.0,...],
 "expected_active_bin":8102,"max_active_bin_slippage":1,
 "strategy_type":"Spot"}
```

- `amounts[i]` pairs with `bin_ids[i]`. **Units are side-dependent**: `side ==
  "bid"` → quote token, `side == "ask"` → base token. This mirrors
  `keeper._bin_payload`, where a bid carries `amount_quote` and an ask carries
  `amount_base`. Getting this backwards silently doubles or destroys inventory —
  validate it against wallet balances before signing and reject on mismatch.
- `bin_ids` must be contiguous and strictly increasing; bids are strictly below
  and asks at/above `expected_active_bin`, and must remain on that same side of
  the current bin at execution. Reject otherwise (`error:
  "bins_cross_active"`) rather than letting the SDK auto-correct — the keeper's
  fill model assumes single-sided bins.
- `expected_active_bin` is the active bin against which the keeper constructed
  the absolute ladder; `max_active_bin_slippage` is a non-negative tolerance in
  **bins**, not basis points. Exceeding it returns
  `active_bin_slippage_exceeded` and must leave tokens and position unchanged.
- Exact `amounts[i]` make `strategy_type` audit metadata only; it does not alter
  the distribution and is not passed to a strategy builder.
- The executor must use Meteora `addLiquidityOneSidePrecise2` (or a
  deployed-IDL-compatible precise successor), whose compressed bin amounts
  reconstruct each requested raw amount exactly. `addLiquidityOneSide` accepts
  `activeId`/`maxActiveBinSlippage` but only a total plus u16 weights, so it is
  not an implementation of this verb. Because the pinned precise ABI does not
  itself carry the active-bin fields, execution additionally requires an
  atomic on-chain active-bin guard in the same transaction; an RPC preflight
  alone is insufficient.
- Response must carry `position_id` (the position NFT/PDA) — the keeper stores
  it as `_current_position_id` and every later verb and `position_observation`
  depends on it. A successful deposit without `position_id` is a protocol
  violation; return `ok:false` instead.
- Second and later deposits on the same live position add liquidity rather than
  opening a new one; return the *same* `position_id` (the keeper logs the
  second call as `position_liquidity_added`).

### 3.4 `withdraw`

`{"method":"withdraw","position_id":"...","bps":100}`. `bps` is **percent-like
basis points as the keeper uses it**: interpret as hundredths of the position,
i.e. `100` = 100 %, and clamp to `[1, 100]`; log the resolved fraction in the
response `data.fraction`. Fee claiming is always included.

Note the current caller: the keeper sends `bps: 100` on every path today
(`_stop_quoting`, `_de_risk`, `_emergency_exit` — keeper.py hardcodes 100).
Fractional withdraw is a reserved surface for future partial de-risking, not
an exercised one — treat it as untested until a keeper path uses it.

Response `data` adds `{"fees_claimed": {"x": 0.003, "y": 1.84, "x_raw": "...",
"y_raw": "..."}, "amounts_returned": {"base": ..., "quote": ..., "..._raw": ...},
"closed": bool}` — the keeper writes these straight into `position_withdrawn`,
and they are the **cash-basis** side of the fee reconciliation.

### 3.5 `swap`

`{"method":"swap","in_mint","out_mint","amount","max_slippage_bps":50,"pool":null}`.
`amount` is decimal in `in_mint` units. **`in_mint`/`out_mint` must be real
mint addresses** — the same strings `get_state` reports as `token_x.mint` /
`token_y.mint`. (History: before 2026-09-09 the keeper sent the symbolic
strings `"base"`/`"quote"` here from `_de_risk`/`_emergency_exit`; that was a
bug — the executor was expected to guess the wallet's tokens. Fixed in
`keeper.py` to send `cfg.base_mint`/`cfg.quote_mint`; the executor must
**reject** `"base"`/`"quote"` or any mint not in `MINT_ALLOWLIST` with
`error:"bad_request"` rather than guess.) `pool == null` → route via Jupiter;
`pool` set → swap directly against that DLMM pool. Response `data` must
include realized `{"amount_in","amount_out","amount_in_raw","amount_out_raw",
"price_realized","route"}` — `pnl_explain` uses realized amounts as the true
rebalance cost, never a modeled impact.

Reject if realized slippage would exceed `max_slippage_bps` (simulate first);
return `ok:false, error:"slippage_exceeded"` rather than a partial fill.

### 3.6 `refresh_bundle`

```jsonc
{"method":"refresh_bundle","withdraw_position_id":"...",
 "swap_spec": null | {"in_mint","out_mint","amount","max_slippage_bps"},
 "deposit_spec":{"pool":"...","expected_active_bin":8102,
                 "max_active_bin_slippage":1,"bid_bins":[...],"ask_bins":[...],
                 "bid_amounts":[...],"ask_amounts":[...]}}
```

The hot path: withdraw 100 % → optional swap → redeposit both sides. Submit as a
**Jito bundle** when configured, else sequentially.

Atomicity is the requirement that matters. Partial execution leaves the keeper
believing it holds a ladder it does not hold. Therefore:

- Bundle path: all-or-nothing; on bundle drop return `ok:false` with
  `data.stage:"bundle_dropped"` and no state change.
- Sequential fallback: on failure after the withdraw landed, **do not retry
  blindly**. Return `ok:false` with `data.stage` ∈
  `withdrew | swapped | deposited`, plus every receipt collected so far and
  `data.position_id` of whatever now exists. The keeper's next `get_state` /
  `get_position` cycle reconciles from chain truth.
- Response on success: `position_id` (new), `fees_claimed`,
  `amounts_returned`, and one receipt per transaction in order.

## 4. Response envelope and receipts

`ExecResult.from_payload` accepts several spellings; **emit exactly this one**
and nothing else:

```jsonc
{
  "ok": true,
  "data": { /* verb-specific, per §3 */ },
  "error": null,
  "tx_signatures": ["sig1", "sig2"],
  "transactions": [
    {"signature":"sig1","slot":301234567,"block_time":1756900001,
     "fee_lamports":5001,"compute_unit_price":12000,
     "status":"finalized","logs_url":null}
  ],
  "position_id": "..."
}
```

Rules, all of them load-bearing for the log:

1. **One receipt per transaction**, in submission order, `transactions[i]`
   matching `tx_signatures[i]`. The keeper sums `fee_lamports` across receipts
   (`ExecResult.total_fee_lamports`) and that sum *replaces* the
   `REFRESH_GAS_LAMPORTS = 50000` placeholder in the `cash_flow` event. A
   missing `fee_lamports` silently reverts gas accounting to the constant and
   is logged as `actual_fee: false` — treat it as a defect, not a soft failure.
2. `fee_lamports` comes from the **confirmed transaction receipt**
   (`getTransaction(...).meta.fee`), not from an estimate.
3. Never return `ok:true` before confirmation at the configured commitment
   (`confirmed` minimum; `finalized` for withdraw/close). An optimistic ok makes
   `verify_log.py` §6.1 fail against chain state.
4. Ambiguous submission (timeout after send): poll the signature to resolution
   before responding. If still unknown after the deadline, return `ok:false`,
   `error:"submission_ambiguous"`, `data.pending_signature`, and the signature
   in `tx_signatures` anyway, so the offline verifier can resolve it later.
5. `error` is a stable snake_case code. The closed set is the union in
   `src/protocol.ts`'s `ErrorCode`: `slippage_exceeded`,
   `active_bin_slippage_exceeded`,
   `insufficient_balance`, `policy_rejected`, `rpc_timeout`,
   `bins_cross_active`, `submission_ambiguous`, `simulation_failed`,
   `unknown_position`, `bad_request`, `internal_error` — optionally
   with `data.detail` for prose. Never put a private key, seed, or full env
   dump in `error` or `data`.

## 5. Reuse from `lp-monitor`

`LP-hedging-strategy/lp-monitor/src/` is a working, read-only Meteora client on
the same SDK versions (`@meteora-ag/dlmm 1.5.0`, `@solana/web3.js 1.98.2`).
Reuse, do not re-derive:

| From | Reuse as | Notes |
|---|---|---|
| `chains/solana.ts` → `getSolanaConnection()` | RPC connection factory | extend with commitment + a write-RPC endpoint distinct from the read endpoint |
| `utils/logger.ts` → `logger` (winston) | the executor's logger | **change the console transport to stderr** — stdout is the protocol channel (§2) |
| `services/types.ts` → `PositionInfo`, `LiquidityProfileEntry` | shape of `get_position.bins` | add `*_raw` string fields |
| `dexes/meteoraDlmmAdapter.ts` → `fetchMeteoraPositions`, `withRetry` | position reads, retry policy | the BN→decimal scaling (`/ 10**decimals`) is the reference implementation; keep the raw BN alongside |
| `services/tokenMappingService.ts` → `getTokenMapping`, `getTokenPrices` | decimals + USD marks for `tvl_usd` | rate-limited; drop the CSV cache on copy (in-memory/JSON only) |

Mechanics: **vendor by copy, do not depend.** `lp-monitor` is not a runtime
dependency of this project (no `file:` dep, no cross-repo path alias) — the
executor must build and ship standalone. Copy the reused code into
`src/vendor/lp-monitor/`, applying the per-file edits in the table above
(stderr console transport, `*_raw` fields, distinct write endpoint) and
stripping the exclusions below. Each vendored file carries a provenance header
with its upstream path and the pinned git SHA; because both projects are
co-maintained, upstream fixes are pulled in by re-copying and bumping the SHA —
a deliberate, reviewable step, never a silent import.

The direction of reuse is one-way. `lp-monitor` stays read-only and never gains
signing authority (test plan §2); nothing in it may import from this project.

Two things must **not** be copied from lp-monitor:

- `BN.toNumber()` on raw u64 amounts — it overflows above 2^53. Use
  `BN.toString()` for `*_raw` and `Number(BN.toString()) / 10**decimals` (or
  `decimal.js`) for the decimal field.
- CSV side-effects (`saveMeteoraPositionsToCsv`, `updatePositionTracking`).
  This project's persistence is the JSONL log, not CSVs.

## 6. Swap stream (logging plan §4) — the piece only this project can build

The keeper polls `active_bin` every 5 s, so any crossing that enters and reverts
inside one interval is invisible; fills, markout, and fee accrual then cannot be
matched on-chain. The logging plan's recommendation, and this spec's
requirement, is that the executor owns the subscription: it already holds the
RPC connection and the pool metadata.

**Mechanism.** `logsSubscribe` on the Meteora DLMM program filtered to the
configured pool. Each decoded swap is appended as one JSON line to
`swap_stream_path` — the file that `dlmm_bot.swap_observer.JsonlSwapEventSource`
backfills and then tails. It is a plain append-only JSONL file; the reader
tracks a byte offset and survives truncation.

Row schema (consumed field-by-field by `SwapObserver.on_swap`):

```jsonc
{"tx_signature":"...","slot":301234567,"block_time":1756900001,
 "ts":1756900001.4,"pool":"...","direction":"up"|"down",
 "prev_active_bin":8123,"new_active_bin":8127,
 "amount_in":12.5,"amount_out":1760.2,
 "amount_in_raw":"12500000000","amount_out_raw":"1760200000",
 "trade_size_usd":1760.2,"fee_bps":25.0,"tvl_usd":1850000.0,
 "bins_crossed":[{"bin_id":8124,"bin_price":141.4,
                  "amount_x":"...","amount_y":"...","fee":"..."}]}
```

Requirements:

- `tx_signature` is the dedupe and join key everywhere downstream — always
  present, never synthesized.
- `direction` may be omitted (the observer derives it from the bin delta), but
  `prev_active_bin` / `new_active_bin` must be the *actual* pre- and post-swap
  bins from the decoded event, not a poll-derived diff. Crossings within a poll
  interval are the entire reason this stream exists.
- `bins_crossed` should carry the per-bin deltas from the swap event when
  decodable; the observer fills `bin_price` from the grid when absent. Per-bin
  amounts are what makes `verify_log.py` §6.2 fill verification possible.
- One line per swap, flushed (`fs.appendFile` / `WriteStream` with autoflush)
  immediately — a buffered write that dies with the process loses fills.
- **Gap handling.** On websocket reconnect, backfill via
  `getSignaturesForAddress` on the pool from the last emitted signature and
  replay the missed swaps in slot order before resuming the live tail. The
  observer dedupes, so overlap is free and gaps are not. Emit an
  `executor_stream_gap` line to the operational log (§7) with the gap bounds so
  `verify_log.py` §6.4 can distinguish a known gap from silent loss.
- The stream runs whether or not we hold a position; `crossed_ours` is the
  observer's call, not the executor's.
- A run without this feed emits `swap_stream_unavailable` and makes
  `verify_log.py` fail closed. Shipping the executor without §6 means no
  verified fills — this is not an optional phase.

## 7. Logging — complementing the event log

Division of responsibility: **the keeper's `EventLog` is the audit record**
(one JSONL per run, gap-free `seq`, `prev_hash` chain). The executor does not
write to it. The executor produces the two things the keeper cannot see, plus
its own operational trail.

| Sink | Content | Consumer |
|---|---|---|
| Response `transactions[]` | receipts: signature, slot, block_time, fee, CU price | `action_result`, `cash_flow`, `position_*` events |
| `swap_stream_path` JSONL | decoded swaps (§6) | `SwapObserver` → `observed_trade`, `bin_fill` |
| `logs/executor-{run}.jsonl` | executor-internal trail (below) | operators, `verify_log.py` gap analysis |
| stderr / winston file | human-readable | on-call |

The executor-internal JSONL carries one line per verb with:
`req_seq` (monotonic per process), `method`, `received_at`, `responded_at`,
`duration_ms`, the **redacted** request, the response envelope, `attempt` count,
`rpc_endpoint`, `blockhash`, `simulation_ok`, `simulation_logs` on failure,
`policy_decision`, `signer_id`, and `bundle_id` for Jito paths. This is the
executor's side of the same story `action_request`/`action_result` tell from the
keeper's side; `req_seq` plus the signature set joins them. It is what answers
"why did that transaction take 9 seconds" — a question the keeper's log cannot
answer because it only sees the verb boundary.

Also emit, as their own line types: `executor_started` (versions of node, the
DLMM SDK, this project's git SHA, RPC endpoints, wallet pubkey, policy hash —
mirroring what `run_started` records on the Python side), `executor_stream_gap`
(§6), `policy_rejected` (§8), and `rpc_failover`.

Redaction is a hard rule: never log the private key, KMS material, full
transaction bytes containing signatures before submission, or any env dump.
Wallet **public** key and signature are fine and necessary.

Rotate daily, gzip after 24 h. Volume is dominated by the swap stream and scales
with pool activity; verb logging is ~17 k lines/day/pool at a 5 s cadence.

## 8. Safety — signing policy

Per the test plan §6, every compiled transaction is validated **before** the
signing request, not after:

- allow-list program IDs (Meteora DLMM, Jupiter, SPL Token, System, Compute
  Budget, Jito tip account); reject unknown programs and unknown writable
  accounts;
- allow-list pool and mint addresses from config;
- confirm the configured wallet is fee payer and the only signer;
- validate lookup-table contents for versioned transactions;
- cap per-transaction base amount, quote amount, SOL spend, slippage bps, and
  **total** priority fee; cap cumulative SOL spend per run. For legacy/v0
  messages, total priority fee is
  `ceil(compute_unit_price_micro_lamports * compute_unit_limit / 1_000_000)`.
  A nonzero CU price requires exactly one explicit CU limit, so a changing SDK
  default cannot inflate a configured fee ceiling;
- simulate; on `simulation_failed` return the error without signing.

A rejection returns `ok:false, error:"policy_rejected"` with the failing rule in
`data.rule`, and writes a `policy_rejected` log line. Rejections fail closed —
never downgrade to "sign anyway". There is no arbitrary-transaction endpoint.

## 9. Configuration

Env-driven, validated at startup, hashed into `executor_started.policy_hash`:

```
SOLANA_RPC_URL, SOLANA_RPC_WRITE_URL, SOLANA_WS_URL (optional explicit
subscription endpoint), SOLANA_COMMITMENT=confirmed
SOLANA_RPC_MAX_CU_PER_SECOND=240
WALLET_SIGNER=kms|keypair|file, KMS_KEY_ARN | WALLET_SECRET_ARN | WALLET_KEYPAIR_PATH
WALLET_PUBKEY (required by the M2 read-only bridge; later also pins/derives from the signer)
FILE_SIGNER_ALLOW_MAINNET=false (Arm B explicit mainnet override only)
POOL_ALLOWLIST, MINT_ALLOWLIST
MAX_SOL_PER_TX, MAX_SOL_PER_RUN, MAX_SLIPPAGE_BPS,
MAX_ACTIVE_BIN_SLIPPAGE_BINS, MAX_PRIORITY_FEE_LAMPORTS
JITO_ENABLED, JITO_BLOCK_ENGINE_URL, JITO_TIP_LAMPORTS
SWAP_STREAM_PATH, EXECUTOR_LOG_DIR
DRY_RUN=true|false
```

The HTTP client prices each JSON-RPC method in Alchemy throughput CUs and
shares one token bucket across read/retry connections. The default reserves
20% headroom below the 300 CU/s free-tier limit; deployments may lower it when
other applications share the same Alchemy account.

`DRY_RUN=true` builds, validates, and simulates every transaction but never
signs; it returns a well-formed envelope with `data.dry_run:true`, synthetic
signatures prefixed `dryrun_`, and `fee_lamports` from the simulation estimate.
The keeper has its own `cfg.dry_run` that short-circuits earlier; both must
exist so the executor can be exercised standalone.

Startup fails closed if the signer, the RPC, or the allow-lists are missing.

`WALLET_SIGNER` selects the deployment arm of test plan §5: `kms` for the cloud
arm, `file` for a local server holding the keypair on disk (test plan §5.5).
Under `file`, startup additionally fails closed if the keyfile is group- or
world-readable, is not owned by the running user, sits in a directory looser
than `0700`, or derives an address other than `WALLET_PUBKEY`. The arm changes
only where the key lives; §8's transaction policy is identical under both.
It additionally checks the RPC genesis hash before reading the keyfile and
refuses mainnet-beta unless `FILE_SIGNER_ALLOW_MAINNET=true` is explicitly set.
That override is not a substitute for the Arm B host and dust-lifecycle gates.

Until M4 wires signer resolution, M2 requires `WALLET_PUBKEY` explicitly so it
can read wallet token balances and reject positions owned by another wallet
without loading any signing material. Once a signer is loaded, deployments may
derive the same public key from it; a configured `WALLET_PUBKEY` remains a pin.

## 10. Layout and build order

```
src/
  protocol.ts     # request/response types — the interface (already written)
  bridge.ts       # stdio JSON-lines loop; stdout = protocol only
  handlers.ts     # verb → implementation, transport-agnostic
  meteora.ts      # SDK calls on the vendored lp-monitor read paths
  policy.ts       # §8 validation
  signer.ts       # KMS | keypair
  swapStream.ts   # §6 logsSubscribe + backfill + JSONL append
  log.ts          # §7 executor JSONL + winston(stderr) from vendor/lp-monitor
  vendor/
    lp-monitor/   # §5 copies with provenance headers; no import from
                  # ../LP-hedging-strategy anywhere in src/
```

Build order, each step verifiable against the Python side that already exists:

1. `protocol.ts` + `bridge.ts` + a stub `handlers.ts` returning canned data →
   run `dlmm-bot`'s keeper tests against the real subprocess in place of
   `FakeExecBridge`. Proves the wire format.
 2. `get_state` + `get_position` (read-only, on the vendored lp-monitor reads)
    → run the keeper in `dry_run` against mainnet. Proves `state_observation`
    and `position_observation` populate, including `claimable_fee_*_raw`.
3. `swapStream.ts` (§6) → point `swap_stream_path` at it and confirm
   `observed_trade` / `bin_fill` events appear and `verify_log.py` completeness
   passes. Read-only, so it can ship before any signing exists.
4. `policy.ts` + `signer.ts` + `deposit_single_sided` / `withdraw` → dust
   lifecycle per test plan §8.3.
5. `swap`, then `refresh_bundle` (bundle last — it is the only atomicity risk).

Steps 1–3 write nothing on-chain and unblock the full logging pipeline; the
signing gate (test plan §5) only blocks 4–5.

## 11. Conformance tests

The contract is already executable on the Python side. Minimum bar:

- **Wire conformance**: every response fixture parses through
  `ExecResult.from_payload` with all receipt fields non-null, and the keeper's
  existing test suite passes against the subprocess. **The fixture set is
  shared across all four `ExecBridge` implementations** (TS executor,
  `FakeExecBridge`, `ReplayExecBridge`, `GatewayExecBridge`): the same
  recorded response fixtures are replayed through each, so no implementation
  can drift from the wire contract (see §1.2).
- **Round-trip**: a recorded executor session replays through
  `ReplayExecBridge` (`tools/replay.py`) with zero decision diffs.
- **Units**: a `deposit_single_sided` with `side:"bid"` debits quote and
  `side:"ask"` debits base — asserted against wallet balance deltas on a local
  validator. This is the single most expensive bug available in this interface.
- **Receipt fidelity**: `sum(transactions[].fee_lamports)` equals the on-chain
  fee sum for the same signatures fetched independently.
- **Stream completeness**: with the websocket killed mid-window, the backfill
  restores every swap the pool saw; `verify_log.py` §6.4 reports zero missing.

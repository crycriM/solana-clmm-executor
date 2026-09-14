# solana-clmm-executor status

**Status date:** 2026-09-14
**Scope:** The Solana DLMM OPMS "body": signing authority for the LP wallet,
verb → Meteora/Jupiter/Jito execution, receipts, swap stream. Companion brain:
`../dlmm-bot` (see its `status.md`). Spec:
`project_docs/opms-spec.md` (source of truth: `src/protocol.ts`).

**Repository note:** `HEAD` is still the initial scaffold commit. The M0–M3
implementation, tests, project docs, and this ledger are currently working-tree
changes and have not been committed. The companion `dlmm-bot` and `mm-core`
repositories also have separate working-tree changes; this audit did not modify
their production code. M2 only updates `dlmm-bot`'s subprocess test launcher to
select the executor's explicit offline stub entrypoint.

Evidence ledger. **M0/M1 are verified locally; M2's keeper observation run is
complete but its live latency gate failed; M3 is green offline, cross-language,
and on a 30-minute mainnet live gate.** The production
bridge requires
`DRY_RUN=true`; its two read verbs use live RPC/Meteora data and its four write
verbs remain gated. Its read-only swap subscription writes decoded events at
the configured commitment to `SWAP_STREAM_PATH`. No simulation or signing is
wired in. M3 has a qualifying mainnet gate run; M2's keeper-read gate remains
pending. A separate mainnet `get_state` smoke read succeeded; the public-RPC
repetition below is explicitly non-gating.

## Bottom line

| Area | Status | What exists | What is still needed |
|---|---|---|---|
| Spec (`opms-spec.md`) | **Complete, reviewed 2026-09-09** | 11 sections: role, transport, 6 verbs, receipt envelope, lp-monitor reuse, swap stream, logging, signing policy, config, build order, conformance. Review fixes applied: §3.4 (bps is always 100 today), §3.5 (real mints + `"base"`/`"quote"` history), §4 (error codes synced to `protocol.ts`), new §1.2 (supersedes the GatewayExecBridge write path + PWL adapter). | Keep in lockstep with `protocol.ts` on every change. |
| Wire types (`src/protocol.ts`) | **Present, reviewed** | Requests, `ExecResponse`, `TxReceipt`, verb `data` shapes, `SwapStreamRow`, handler surface. Matches `dlmm_bot.exec_bridge.ExecResult.from_payload` field-for-field. | Commit the reviewed contract with the rest of the implementation when ready. |
| Runtime (`bridge.ts` … `log.ts`) | **M3 gate complete** | M2 live reads plus finalized DLMM event-CPI decode, append-only swap JSONL, CU-limited RPC, durable cursors, history/slot backfill, and gap audit. | Record M2's keeper-read soak; keep write handlers gated. |
| Signing / policy | **Separate signer work present; M4 remains gated** | `signer.ts` and its unit tests appeared during M1 verification and were preserved. The M1 bridge does not import them. Config validates caps and allowlists; transaction policy is still future work. | Full M4 implementation plus the test plan §5 signing gate before any mainnet write. No signing gate closure is claimed by M1. |
| Swap stream | **Gate passed 2026-09-10** | Spec §6: pool `logsSubscribe` → event-CPI decode → append-only `SWAP_STREAM_PATH` JSONL → `JsonlSwapEventSource` → `observed_trade`/`bin_fill`. CU-limited reads plus slot/history recovery with explicit completeness state. | Operational monitoring only. |
| Live evidence | **M3 recorded; M2 read-latency gate failed.** | M3 retained a 30-minute mainnet capture: 386 unique swaps, 15 owned-position bin fills, structural and independent chain completeness green. M2's 2026-09-14 read-only keeper run logged 168 state/position pairs with zero failed reads or writes; p95 was 1,851 ms. | Diagnose RPC-tail latency and rerun the M2 keeper gate. |

## Gate ledger (build order, spec §10 + test plan)

| Step | Gate | State | Closure condition |
|---|---|---|---|
| 0 | M0 standalone toolchain/config/logging/vendors; wire types match `ExecResult.from_payload` | **Passed locally, 2026-09-10.** | Build/typecheck/lint plus M0 unit tests and twelve shared envelope parse tests. |
| 1 | `bridge.ts` + stub `handlers.ts`; dlmm-bot suite passes against real subprocess in place of `FakeExecBridge` | **Passed locally, reverified 2026-09-10.** | All twelve existing keeper cases run through the built bridge; additional direct-CLI conformance, restart, and lifecycle tests. Commands below. |
| 2 | `get_state` + `get_position` read-only; keeper dry-run on mainnet populates `state_observation` / `position_observation` incl. `claimable_fee_*_raw` | **30-minute keeper observations passed; p95 failed (1,851 ms).** | Repeat the read-only keeper gate with p95 < 400 ms. |
| 3 | `swapStream.ts`; `observed_trade`/`bin_fill` events appear; `verify_log.py` completeness passes | **Passed offline + live, 2026-09-10.** | Read-only 30-minute mainnet tail: 386 unique swaps, 15 owned-position fills, zero missing/extra chain swaps. |
| 4 | `policy.ts` + `signer.ts` + `deposit_single_sided`/`withdraw`; dust lifecycle per test plan §8.3 | **Blocked on signing gate (test plan §5).** | Local-validator + mainnet-dust lifecycle; bid-debits-quote / ask-debits-base unit test (spec §11 — "the single most expensive bug available"). |
| 5 | `swap`, then `refresh_bundle` (Jito bundle + sequential fallback with `data.stage`) | **Not started; last.** | Receipt-fidelity test: `sum(fee_lamports)` equals on-chain fees fetched independently. |

## Relationship ledger

- **Supersedes** `hb-enhanced-opms` `GatewayExecBridge` write verbs and the
  phase-3 PWL adapter (obsoleted, opms-spec §1.2). Its read-only `get_state`
  may survive for standalone scripts.
- **Vendors by copy from** `LP-hedging-strategy/lp-monitor` (read paths, logger,
  token mapping — opms-spec §5): copied into `src/vendor/lp-monitor/` with
  provenance headers, no runtime dependency or import. `lp-monitor` never gains
  signing authority and never imports from here.
- **Four `ExecBridge` implementations** now share one contract (TS executor,
  `FakeExecBridge`, `ReplayExecBridge`, `GatewayExecBridge`): contract changes
  go through the spec and the shared §11 conformance fixtures in one change.

## M0 review and M1 evidence

M0's initial build/lint/tests passed, but review found missing validation,
two non-exact dependency pins, incomplete structured redaction, no daily log
rotation, logger reinitialization defects, and the omitted vendored
`fetchMeteoraPositions` read mapper. Those were corrected. Test helpers were
moved out of `config.test.ts`: importing that suite had inflated the original
test count. Vendor provenance was checked against upstream SHA
`aacfe017291681164a1a23b756f4516768699ad0`; no upstream sources were changed.

M1 proof includes ordered asynchronous handling, malformed request recovery,
handler exception containment, partial-result forwarding, audit failure
response before exit, clean stdout, and startup metadata. Synthetic receipts
have non-null fees, aligned signatures, and finalized withdrawals. A full
keeper lifecycle records position observations and receipt-derived gas fees.
This proves the wire contract, not on-chain behavior or simulated economics.

Reproduce from `solana-clmm-executor/` with Node >=20, installed npm dependencies,
and `dlmm-bot/.venv` containing editable `dlmm-bot`, editable `mm-core`, and pytest:

```bash
npm run check:m1
```

This is the CI-ready gate command; execution evidence here is local, not a
remote CI run. Build, typecheck (including test sources), and lint pass on
Node **v22.23.2**. The `test:m1` TS source suite reports **111 passed** across
five source suites (38 bridge, 38 config, 22 signer, 7 logging, and 6 vendor
checks). The default bot command remains `.venv/bin/python -m pytest -q` from
`dlmm-bot/`: **157 passed, 15 skipped**. Enabling `--executor-subprocess`
gives **172 passed**. The twelve shared response fixture tests run in both
Python lanes; only Node-dependent cases are skipped by default.

The concurrent `tests/` contract/component harness is collected and passes.
After M2, `npm test` reports **173 passed across 13 files**: seven new recorded-RPC
tests cover raw precision above 2^53, cache reuse, price-miss TVL, endpoint
failover/audit metadata, exact fees, and missing/wrong-owner positions. Offline
stdio/keeper lanes inject stubs explicitly; production `dist/bridge.js` wires
live reads. The opt-in live suites were not run against mainnet, devnet, or a
local validator.

The fixture slice covers all six successful responses and six malformed
requests. Full error catalogs and replay through Fake/Replay/Gateway are not
closed by this milestone. The working `protocol.ts` contract and production
Python bridge/keeper were not changed by M1.

## M2 offline evidence

`src/meteora.ts` constructs one SDK reader per pool/endpoint and caches
immutable metadata for process life. Each request refreshes the active bin,
wallet token-account balances, pool reserves, slot, or the requested position.
Position discovery decodes only the SDK's V2 discriminator plus pool/owner
header, validates program and configured-wallet ownership, and then performs
the full SDK read. RPC retries rotate across the distinct configured endpoints
and record `rpc_failover`; verb rows capture the final endpoint and attempt.

Reproduce the complete offline gate with:

```bash
npm run check:m2
```

On 2026-09-10, build, typecheck, lint, and **173 TS tests** passed, followed by
**172 Python tests** through `--executor-subprocess`. No passing live
read/keeper gate is recorded, so gate 2 is intentionally not marked passed.

A non-gating production smoke used the public mainnet RPC and an allow-listed
pool selected from Meteora's pool API. One cold `get_state` completed
successfully and populated active bin, fee, decimal/raw wallet balances, TVL,
token metadata, and slot. A 20-read follow-up was interrupted after 16 successes
because the unauthenticated endpoint repeatedly returned HTTP 429; its p95 was
therefore 20,393 ms and does not meet or meaningfully measure the 400 ms target.
Temporary executor logs are at
`/tmp/solana-clmm-m2-smoke.p053rk/executor-*.jsonl`; they are not retained gate
artifacts.

A read-only mainnet soak using `.env.m3` ran for 30 minutes 52 seconds across
2026-09-12/13. The retained artifact is
`logs/test-artifacts/artifact-liveReads-m3-live-20260910.json` (the run ID came
from `.env.m3`); its evidence directory contains the executor audit and swap
stream. All 164 `get_state` and 164 `get_position` responses succeeded, with
exact raw fee fields present. Each verb's slots were independently monotonic;
twice a position read observed one slot below the immediately preceding state
read. The original test incorrectly required the interleaved sequence to be
monotonic and failed on that assertion; the assertion has since been corrected
to check each verb independently. The audit independently shows `get_state`
p50 229 ms, p95 **2,515 ms**, maximum 5,401 ms, and 22 of 164 calls at or
above 400 ms. All 143 stream recovery gaps were marked complete; 363 swaps
were retained. This is useful failure evidence, **not a gate pass**: p95 exceeds
the 400 ms target and this harness did not drive the Python keeper's
`state_observation`/`position_observation` cycle log.

On 2026-09-14, `get_state` gained per-leg `read_timings_ms` audit fields. A
three-minute diagnostic showed 11 of 12 slow reads had a slow Solana RPC leg,
versus two with a slow CoinGecko price leg. The redundant `getSlot` request was
then removed from `get_state`: its four balance responses already carry context
slots. Offline build/typecheck/lint, 249 TypeScript tests, and 179 Python
subprocess tests passed. A short post-change preflight measured p95 397 ms over
52 reads, but was not qualifying duration evidence.

The actual observation-only Python keeper ran against the production read-only
executor for **1,800.066 seconds**. Its hash-chained log replayed cleanly:
168 `state_observation`, 168 `position_observation`, 168 decisions, one
`run_started`/`run_stopped`, and no missing raw fee fields or action requests.
The executor handled 338 reads with zero failures and zero write verbs. The
retained audit shows 169 `get_state` samples, p50 238 ms, p95 **1,851 ms**,
maximum 5,552 ms, and 37 calls at or above 400 ms. Thirty-five of those 37
had a slow Solana RPC component; nine had a slow price component (overlap is
possible). This identifies the read tail as predominantly RPC-side, without
proving whether the provider or local CU queue is the bottleneck. Evidence:
`logs/test-artifacts/evidence-keeper-m2-20260914T080731Z/summary.json` plus
the retained keeper, executor, and swap JSONL in that directory. **Gate 2
remains open** because p95 exceeds 400 ms; this observation-only mode does not
calibrate or exercise AS strategy decisions.

The subsequent `rpc_cu_wait_ms`/`rpc_http_ms` audit split uses async context so
swap-stream traffic is not charged to a keeper read. A three-minute mainnet
diagnostic retained 49 state reads (p95 465 ms): four were at or above 400 ms,
none waited 100 ms in the client CU limiter, two had slow upstream Solana HTTP
legs, and two had slow price refreshes. This short window does not prove the
full-run cause, but it provides no evidence that raising the CU limit would
fix M2. The 400 ms gate and the current price-freshness policy remain unchanged.
Evidence: `logs/test-artifacts/artifact-liveReads-m2-cu-vs-http-20260914.json`
and its referenced audit directory.

With the observation-only mode, launcher tests, and diagnostic audit fields,
`npm run check:m3` passes again: build, typecheck, lint, **250 TypeScript
tests**, and **187 Python tests** with `--executor-subprocess` (2026-09-14).

## M3 offline and cross-language evidence

`src/swapStream.ts` subscribes to each configured pool's logs, decodes each
DLMM `Swap` event, and appends one row per swap to `SWAP_STREAM_PATH`.
Pool-level mentions subscriptions bound the transaction-fetch load required by
Meteora's current event-CPI delivery instead of tailing every DLMM transaction.
Supporting modules:
`src/events.ts` (borsh event decode) and `src/jsonl.ts` (append-only sink).

Three properties the verifier depends on are covered by tests:

- `prev_active_bin`/`new_active_bin` come from the decoded event's
  `startBinId`/`endBinId`, never a poll diff, so a crossing that enters and
  reverts inside one poll interval is still recorded.
- `tx_signature` is always real, token decimals are loaded before subscribing,
  raw u64s remain strings, and rows with unresolved block times are not emitted.
- Live callbacks and reconnect recovery share one queue. Backfill restores a
  durable per-pool cursor, pages `getSignaturesForAddress`, replays in slot
  order, and emits an `executor_stream_gap` line with its bounds.

Two decoder decisions are deliberate. The shipped `Swap` event exposes only
aggregate amounts, so `bins_crossed` is omitted rather than copying the full
swap total into every bin; `SwapObserver` derives the crossed range and uses
the registered ladder for fill amounts. `fee_bps` is derived from
`fee / amountIn` rather than the event's `feeBps` u128, whose scale is not
documented in the shipped IDL and could not be confirmed against a recorded
mainnet event; hard-coding a scale would report either 2.5e-8 or 2.5e9 bps for
a 25 bps pool and silently corrupt fee accrual. The field is omitted rather
than guessed when it cannot be derived, and the observer falls back to its own
default.

The cross-language gate is `dlmm-bot/tests/test_executor_swap_stream.py`: it
drives the compiled stream over `fixtures/rpc/dlmm-swap-logs.json`, then tails
that exact file with `JsonlSwapEventSource`. It asserts `observed_trade`,
`bin_fill`, byte-offset advancement, overlap dedupe, and `verify_log.py`
completeness against the fixture swap set.

Reproduce with `npm run check:m3`: on 2026-09-10 build, typecheck, lint, and
**249 TS tests across 18 files** passed, followed by **179 Python tests** with
`--executor-subprocess`.

The qualifying live run used Alchemy for HTTP reads, a public Solana WebSocket
because the supplied Alchemy endpoint rejected `logsSubscribe`, finalized
commitment, and the enforced 240 CU/s default (below Alchemy's 300 CU/s free
tier). It ran for 1,800 seconds and retained 386 schema-valid, slot-ordered,
unique swap rows. Eighty-two individual transaction misses fell back to their
finalized blocks; every fallback was marked `recovery_complete=true` and none
was incomplete. An earlier 30-minute attempt without slot recovery was
correctly rejected after an independent block audit found seven missing swaps.

The retained stream then passed through the real Python source/observer with
the owned position's 69 live bins: 386 `observed_trade` and 15 `bin_fill`
events. Structural verification and the rate-limited independent Alchemy chain
comparison both passed with zero missing/extra swaps, no duplicate trades, and
no orphan/crossed-without-fill errors. Evidence:
`logs/test-artifacts/artifact-swapStream-m3-live-slot-recovery-30m-20260910.json`
and its referenced evidence directory.

## From here

1. Reduce the upstream RPC/price tail or use a suitable dedicated read
   endpoint without weakening price freshness or increasing free-tier CU
   pressure on a guess. Rerun the
   ≥30-minute observation-only keeper gate with p95 below 400 ms before
   declaring M2 passed. Calibrate AS gamma/kappa before any strategy shadow
   or write-enabled deployment.
2. Steps 4–5 only after the test plan §5 signing gate is satisfied.

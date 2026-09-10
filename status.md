# solana-clmm-executor status

**Status date:** 2026-09-10
**Scope:** The Solana DLMM OPMS "body": signing authority for the LP wallet,
verb → Meteora/Jupiter/Jito execution, receipts, swap stream. Companion brain:
`../dlmm-bot` (see its `status.md`). Spec:
`project_docs/opms-spec.md` (source of truth: `src/protocol.ts`).

**Repository note:** `HEAD` is still the initial scaffold commit. The M0/M1
implementation, tests, project docs, and this ledger are currently working-tree
changes and have not been committed. The companion `dlmm-bot` and `mm-core`
repositories also have separate working-tree changes; this audit did not modify
them.

Evidence ledger. **M0 scaffolding and M1 wire proof are implemented and
verified locally.** The runnable bridge requires `DRY_RUN=true`; all six
handlers return synthetic responses marked `stub:true`. No chain reads,
simulation, signing, or swap subscription are wired into the bridge. Nothing
has been run against mainnet, devnet, or a local validator for these gates.

## Bottom line

| Area | Status | What exists | What is still needed |
|---|---|---|---|
| Spec (`opms-spec.md`) | **Complete, reviewed 2026-09-09** | 11 sections: role, transport, 6 verbs, receipt envelope, lp-monitor reuse, swap stream, logging, signing policy, config, build order, conformance. Review fixes applied: §3.4 (bps is always 100 today), §3.5 (real mints + `"base"`/`"quote"` history), §4 (error codes synced to `protocol.ts`), new §1.2 (supersedes the GatewayExecBridge write path + PWL adapter). | Keep in lockstep with `protocol.ts` on every change. |
| Wire types (`src/protocol.ts`) | **Present, reviewed** | Requests, `ExecResponse`, `TxReceipt`, verb `data` shapes, `SwapStreamRow`, handler surface. Matches `dlmm_bot.exec_bridge.ExecResult.from_payload` field-for-field. | Commit the reviewed contract with the rest of the implementation when ready. |
| Runtime (`bridge.ts` … `log.ts`) | **M0/M1 done locally** | Ordered stdio loop, runtime request checks, six stub verbs, startup/verb audit records, redaction, rotation, shared fixtures, keeper subprocess lane. | M2 live reads and M3 stream, then gated write handlers. |
| Signing / policy | **Separate signer work present; M4 remains gated** | `signer.ts` and its unit tests appeared during M1 verification and were preserved. The M1 bridge does not import them. Config validates caps and allowlists; transaction policy is still future work. | Full M4 implementation plus the test plan §5 signing gate before any mainnet write. No signing gate closure is claimed by M1. |
| Swap stream | **Not started; mandatory, not optional** | Spec §6: `logsSubscribe` decode → `swap_stream_path` JSONL + reconnect backfill. Without it the keeper has no verified fills and `verify_log.py` fails closed. | Build-order step 3; ships before any signing. |
| Live evidence | **None.** | — | Everything below. |

## Gate ledger (build order, spec §10 + test plan)

| Step | Gate | State | Closure condition |
|---|---|---|---|
| 0 | M0 standalone toolchain/config/logging/vendors; wire types match `ExecResult.from_payload` | **Passed locally, 2026-09-10.** | Build/typecheck/lint plus M0 unit tests and twelve shared envelope parse tests. |
| 1 | `bridge.ts` + stub `handlers.ts`; dlmm-bot suite passes against real subprocess in place of `FakeExecBridge` | **Passed locally, reverified 2026-09-10.** | All twelve existing keeper cases run through the built bridge; additional direct-CLI conformance, restart, and lifecycle tests. Commands below. |
| 2 | `get_state` + `get_position` read-only; keeper dry-run on mainnet populates `state_observation` / `position_observation` incl. `claimable_fee_*_raw` | **Not started.** | Recorded dry-run cycle log; p95 < 400 ms. |
| 3 | `swapStream.ts`; `observed_trade`/`bin_fill` events appear; `verify_log.py` completeness passes | **Not started.** | Read-only; ships before signing. WS-kill backfill test with zero missing swaps (spec §11). |
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

The concurrent `tests/` contract/component harness is now collected and passes:
`npm test` reports **165 passed across 12 files** (111 source tests plus 54
offline contract/component tests). These tests still exercise M1's dry-run stub
handlers; the `tests/functional/` suites remain opt-in and were not run against
mainnet, devnet, or a local validator.

The fixture slice covers all six successful responses and six malformed
requests. Full error catalogs and replay through Fake/Replay/Gateway are not
closed by this milestone. The working `protocol.ts` contract and production
Python bridge/keeper were not changed by M1.

## From here

1. Build-order steps 2–3 (read-only + swap stream) — zero signing risk, and
   they unblock the entire DLMM logging pipeline in `dlmm-bot`.
2. Record each step's gate result in this ledger as it passes.
3. Steps 4–5 only after the test plan §5 signing gate is satisfied.

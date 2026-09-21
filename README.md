# Solana CLMM Executor

A JSON-lines execution gateway for Meteora DLMM liquidity operations. The
executor is the signing boundary for an external keeper or orchestration layer:
it validates requests, applies policy, simulates transactions, signs only
approved mutations, and returns structured receipts.

Some parts are reusable for Raydium or Orca:
- JSONL bridge and handler dispatch
- KMS/file signing
- simulation, submission, confirmation, and receipts
- RPC failover/rate limiting
- Jito bundle orchestration
- logging, budgets, allow-lists, and audit infrastructure

Some parts are venue-specific:
- Pool/position reads
- Liquidity builder
- Withdraw/fee collection
- Direct swaps
- Transaction policy
- Swap stream.

The main difference is the representation of liquidity positions in bins or ticks, which 
will directly affect the modelling of market-making ladders.

> **Security:** This service can control a Solana wallet. Run it only in an
> isolated environment with a dedicated, balance-capped wallet. Never commit
> key material, RPC credentials, live environment files, or execution logs.
> Review every policy limit before enabling writes.

## Scope

The gateway currently supports:

- read-only pool and position state;
- weighted single-sided deposits and withdrawals;
- direct DLMM swaps with bounded slippage;
- read-only pool discovery and swap quotes;
- `refresh_bundle` workflows that close, optionally swap, and redeposit;
- sequential submission and optional Jito bundle submission;
- JSONL requests and responses over standard input/output;
- structured audit logging and explicit ambiguous-submission failures.

The Jupiter aggregator route is intentionally disabled until its instruction
binding has been independently verified. Unsupported or ambiguous operations
fail closed rather than being retried blindly.

## Requirements

- Node.js 20 or newer
- npm
- Access to a Solana RPC endpoint for live reads or writes
- A dedicated Solana wallet only when running write operations

No Rust toolchain or custom on-chain program is required.

## Install and check

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

The compiled CLI is `dist/bridge.js`. It reads one JSON request per stdin line
and writes one JSON response per line, preserving request order. For local
development, use `npm run dev`.

```bash
printf '%s\n' '{"method":"get_state","pool":"..."}' | node dist/bridge.js
```

Use the deterministic fixtures and stub runners for offline integration tests;
they do not perform transactions or represent evidence of on-chain execution.

## Configuration

Start from `.env.example` and keep the resulting file private and untracked.
At minimum, live reads require:

- `SOLANA_RPC_URL`
- `WALLET_PUBKEY`
- the relevant pool and mint allow-lists
- `DRY_RUN=true`

Write mode additionally requires an approved signer, key custody configuration,
policy caps, and an explicit write-test confirmation. Prefer KMS-backed custody
for deployed environments. A local file signer must use a protected key file and
must never point at a personal or treasury wallet.

The complete variable and protocol reference is in
[`project_docs/opms-spec.md`](project_docs/opms-spec.md). Signing and custody
requirements are documented in
[`project_docs/kms-signing-gate.md`](project_docs/kms-signing-gate.md).

## Safety model

Every mutation is subject to configuration policy, including allow-listed pools
and mints, transaction and run budgets, slippage, active-bin movement, priority
fees, and signer mode. The gateway simulates before signing and confirms
submitted transactions before producing a successful receipt. If submission or
readback is ambiguous, the response reports that state and the caller must
reconcile it externally before taking further action.

Keep `DRY_RUN=true` while integrating. Use a separate test wallet and a small
approved budget for any live validation. Live test procedures are intentionally
kept in the internal functional test plan rather than copied into this public
README; see [`project_docs/meteora-functional-test-plan.md`](project_docs/meteora-functional-test-plan.md).

## Project layout

```text
src/              Gateway, protocol, policy, signing, and transaction code
fixtures/         Deterministic request, response, and RPC replay fixtures
tests/             Component, contract, and guarded functional tests
project_docs/     Protocol, custody, and functional-test documentation
tools/            Offline and audit utilities
```

## Status

The read path, JSONL bridge, swap stream, weighted liquidity mutations, direct
DLMM swap path, quote discovery, and refresh workflow are implemented. Mainnet
write use remains deployment-specific and requires an independent operational
review, custody approval, and a successful test-wallet validation.

## License

No license has been declared yet. Confirm the intended license before publishing
or accepting external contributions.

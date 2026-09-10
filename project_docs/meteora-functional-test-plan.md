# Meteora Gateway Functional Test Plan

## 1. Purpose

This document defines the functional test plan for the dedicated TypeScript
Meteora gateway used by `dlmm-bot` and the wider market-making stack.

The gateway will be owned by this project. Hummingbot Gateway is not the test
target because its Meteora surface does not provide the per-bin placement and
receipt data required by the market maker.

The goal is to prove that a keeper verb can travel over the v1 JSON-lines
subprocess protocol, be converted into the intended Meteora instructions, be
signed without exposing wallet private keys, reach the required Solana
commitment, and be reconciled back to the correct wallet and position state.

`src/protocol.ts` is the machine-readable contract and takes precedence over
this plan and `opms-spec.md` wherever they disagree.

## 2. Current architecture and required boundary

The existing Python `dex_executor` is the production OPMS for perpetual DEXs
and will be superseded by `hb-enhanced-opms`. Neither perp execution service is
the home of CLMM execution. The pre-existing `lp-monitor` project is a
read-oriented TypeScript consumer of the Meteora SDK; it remains an independent
observer rather than taking on signing authority.

Meteora should therefore use a dedicated liquidity-execution contract rather
than being forced into `submit_order`, `cancel_order`, and the current
long/short position model.

The intended runtime boundary is:

```text
dlmm-bot
        |
        | ordered JSON-lines verbs over stdin/stdout
        v
Dedicated Meteora Gateway
  +-- verb and parameter validation
  +-- execution and wallet policy enforcement
  +-- Meteora SDK transaction construction
  +-- transaction simulation
  +-- secure wallet signer
  +-- Solana RPC submission and reconciliation
        |
        v
Meteora programs on Solana
```

No component ever receives or stores wallet private key material: under the
§5.1 design the private key exists only inside AWS KMS.

The *capability* to sign is a different question, and the subprocess boundary
does not enforce it. `dlmm_bot.exec_bridge.ExecBridge` spawns the executor with
`subprocess.Popen(...)` and no `env=` argument, so the child inherits the
parent's environment and both processes run under the same AWS task role. Any
process co-located with the executor can call `kms:Sign` directly and bypass
every check in `policy.ts`.

So the accurate statement of the boundary is:

- `solana-clmm-executor` is the only component that *should* request wallet
  signatures, and the only one whose requests are policy-validated. This is a
  code convention enforced by review, not by the runtime.
- The enforced trust boundary is the **task/host**. Everything deployed
  alongside the executor is equally trusted with the signing capability.
- Therefore `dex_executor`, `hb-enhanced-opms`, and `lp-monitor` must not be
  deployed into the executor's task or host. Outside it they hold no grant on
  the wallet key and cannot sign. `dlmm-bot` is inside it by construction, as
  the parent process.
- What the runtime does enforce: the KMS grant is scoped to one key ARN and to
  `ED25519_SHA_512`, so even a co-located process cannot reach a different
  wallet or the prehashed algorithm.

A real per-component boundary needs separate tasks with distinct IAM roles,
which needs the phase-2 authenticated HTTP transport. Until that exists, do not
claim the subprocess seam is a security boundary — it is an interface boundary.

The v1 subprocess exposes exactly the six operations defined in
`src/protocol.ts`:

- `get_state`;
- `get_position`;
- `deposit_single_sided`;
- `withdraw`;
- `swap`;
- `refresh_bundle`.

Position reconciliation is performed using `get_state`, `get_position`, and
the receipt fields returned by mutating verbs. V1 has no owned-position
discovery or transaction-status verb. Those may be introduced later if a
second consumer or stronger restart recovery requires them.

It must not expose a general-purpose "sign arbitrary transaction" endpoint.

## 3. Scope

### In scope

- JSON-lines stdio framing, ordering, lifecycle, and error handling.
- Verb and parameter validation.
- Meteora SDK request construction.
- Exact per-bin single-sided placement and position readback.
- Secure Solana signing.
- Solana RPC submission and confirmation.
- Position, token balance, fee, and transaction reconciliation.
- Restart recovery and ambiguous-submission handling.
- Failure behavior, operational evidence, and cleanup.
- One end-to-end flow from a keeper verb to confirmed/finalized on-chain state.

### Out of scope for the first gate

- Profitability or market-making parameter calibration.
- Large-capital or production-wallet testing.
- Sustained production load testing.
- General support for arbitrary Solana programs or arbitrary transactions.
- Authenticated HTTP transport, network identities, and HTTP replay protection.
- Intent ingestion, intent validation, and intent persistence; the keeper
  decides whether to act and sends execution verbs.
- Meteora limit-order placement/list/cancel/close operations. These require an
  explicit extension to `ExecRequest`, `ExecHandlers`, and the Python
  `ExecBridge` before they can enter a functional gate.
- Selective per-bin removal. V1 `withdraw` removes a percentage of the
  position, not a caller-selected subset of bins.
- Dedicated owned-position discovery and transaction-status query verbs.

## 4. Test environments

Use three progressively riskier tiers.

| Tier | Target | On-chain writes | Execution cadence |
|---|---|---:|---|
| Contract/component | Node subprocess with mocked SDK, RPC, and signer | No | Every pull request |
| Live read-only | Node subprocess connected to the selected mainnet RPC and Meteora pool | No | Nightly and before release |
| Dust lifecycle | Node subprocess with a dedicated, balance-capped mainnet wallet | Yes | Manual release gate |

The tiers are independent of the deployment arm (§5): both arms run all three.
Under arm B the dust-lifecycle tier runs on the same server that will hold the
production key, so its §5.5 host preconditions must be met before that tier,
not after.

Where possible, run instruction-building and error tests against a local Solana
validator or deterministic simulator before using mainnet. Mainnet remains the
functional authority for Meteora deployment compatibility and real transaction
behavior.

## 5. Test wallet and key security

Two deployment arms are supported. They differ only in where the private key
lives and how signing is authorized; the verb contract, the transaction policy
of §6, and every functional case in §8 are identical under both.

| | Arm A — cloud | Arm B — local server |
|---|---|---|
| Key custody | AWS KMS, key never extractable | file on disk, readable by the service user |
| `WALLET_SIGNER` | `kms` | `file` |
| Authorization | IAM role + key grant | filesystem permissions |
| Signing latency | network round trip per signature | in-process, microseconds |
| Independent audit | CloudTrail | none; ship logs off-box |
| Kill switch | disable key / revoke `kms:Sign` | stop service, drain wallet |
| Availability risk | KMS or IAM outage stops trading | none beyond the host itself |

Choose by deployment target, not by preference: a cloud-hosted gateway uses
arm A, a single-tenant server you administer uses arm B. §5.4 (Secrets
Manager) remains a fallback *within* arm A and is not a third arm.

Neither arm partitions signing capability between the keeper and the executor —
see §2. That limitation is a property of the subprocess transport, not of the
signer.

### 5.1 Arm A: AWS KMS Ed25519 signer

New functional-test wallets should be generated as asymmetric AWS KMS keys:

```text
KeySpec:          ECC_NIST_EDWARDS25519
KeyUsage:         SIGN_VERIFY
SigningAlgorithm: ED25519_SHA_512
MessageType:      RAW
```

AWS KMS supports Ed25519 signing keys whose private material does not leave KMS
unencrypted. See the AWS documentation for
[KMS key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html).

Wallet provisioning and signing work as follows:

1. Infrastructure creates an Ed25519 KMS key.
2. The provisioning tool calls `GetPublicKey`.
3. It extracts the raw 32-byte Ed25519 public key and Base58-encodes it to
   obtain the Solana wallet address.
4. The wallet address is funded only with the approved test budget.
5. The provisioning inventory records an operational wallet alias, the derived
   public address, and the KMS key ARN. V1 runtime configuration needs only the
   `KMS_KEY_ARN`; the other values are audit metadata, not protocol fields.
6. The gateway builds and validates the transaction.
7. It simulates the transaction.
8. It serializes the Solana transaction message and calls KMS `Sign`.
9. It inserts the returned signature, verifies it locally, and submits the
   transaction.

KMS gained Ed25519 support on 2025-11-07; the key spec name is
`ECC_NIST_EDWARDS25519`. Note that `ED25519_PH_SHA_512`/`MessageType:DIGEST` is
HashEdDSA, a different algorithm whose signatures Solana rejects — only
`ED25519_SHA_512`/`MessageType:RAW` is correct here.

Provisioning commands, IAM policy JSON, monitoring, the kill switch, and the
spike runner are in `kms-signing-gate.md`.

Before using this signer for Meteora tests, complete a compatibility spike:

- derive the expected Solana address from `GetPublicKey`;
- sign a fixed message and verify the signature locally;
- sign and finalize a dust self-transfer;
- confirm the signature encoding expected by the chosen Solana SDK;
- verify legacy and versioned transaction support;
- measure KMS signing latency at p50, p95, and p99;
- confirm that a KMS timeout or denied request fails closed.

### 5.2 Arm A: IAM boundary

The gateway workload role should have only these actions on the exact wallet
key ARN:

```text
kms:GetPublicKey
kms:Sign
```

It must not have key-administration permissions, wildcard access to other
wallet keys, or access to unrelated secrets. A separate administrative role
owns key creation, policy changes, disabling, import, and deletion.

KMS calls must be recorded in CloudTrail and alerts should cover unexpected
principals, unusual signing volume, and signing outside an approved test
window. The emergency signing kill switch is to disable the KMS key or remove
`kms:Sign` from the gateway workload role.

### 5.3 Existing wallets

If an existing Solana address must be retained, AWS KMS supports importing an
Ed25519 private key in the required PKCS#8 representation. See
[AWS KMS imported-key requirements](https://docs.aws.amazon.com/kms/latest/developerguide/importing-keys-conceptual.html).

An imported wallet has a weaker custody history because its private material
existed outside KMS. Import must be a controlled, one-time operation that does
not place the key in shell arguments, command history, logs, repository files,
CI variables, or persistent temporary files. A newly generated KMS wallet is
preferred for functional testing.

Under arm B (§5.5) this section does not apply: an existing wallet is retained
by placing its keypair file at `WALLET_KEYPAIR_PATH` with the required
ownership and mode. The same custody caveat holds — a key that has existed
elsewhere carries that history with it — and `WALLET_PUBKEY` should pin the
expected address.

### 5.4 Arm A fallback: AWS Secrets Manager

If external KMS signing blocks the first dust test, the temporary fallback is
an exportable Solana keypair in AWS Secrets Manager, protected by a dedicated
customer-managed symmetric KMS key.

- Grant `GetSecretValue` only to the Meteora gateway workload role and only for
  the exact wallet secret ARN.
- Retrieve the key once at startup through the AWS SDK, not through a shell or
  command-line argument.
- Hold it only in gateway process memory.
- Never put it in `.env`, container definitions, logs, exception messages, API
  responses, or consumer-service configuration.
- If a library absolutely requires a file, use container-local `tmpfs` with
  mode `0400`, load the signer immediately, and remove the file.
- Disable core dumps and swap for the signing process.
- Alert on every `GetSecretValue` call.
- Drain the wallet and delete or disable the secret after the test campaign.

Secrets Manager protects values with KMS encryption at rest and TLS in transit,
and IAM controls retrieval. Unlike direct KMS signing, however, the gateway
receives the plaintext private key. See
[AWS Secrets Manager data protection](https://docs.aws.amazon.com/secretsmanager/latest/userguide/data-protection.html)
and [IAM policies for individual secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_iam-policies.html).

This fallback is acceptable for a small, balance-capped test wallet, but direct
KMS Ed25519 signing is the target design.

### 5.5 Arm B: local server with a file-backed keypair

When the gateway and the keeper run on a single-tenant server under your own
administrative control, a Solana keypair file is an appropriate custody model.
The threat model that justifies it excludes the cloud provider and co-tenants,
and admits the host's root user and anyone with physical access. If that is not
your threat model, use arm A.

Arm B is chosen for concrete reasons, not convenience: signing is in-process
rather than a network round trip per signature, which matters when a blockhash
is valid for roughly a minute and placement races bin crossings; and there is
no external dependency whose outage stops trading.

#### Key generation and storage

Generate the key on the machine that will use it. Do not generate it elsewhere
and copy it — a key that has travelled has an unknown custody history.

```bash
sudo install -d -m 0700 -o clmm-executor -g clmm-executor /etc/clmm-executor
sudo -u clmm-executor solana-keygen new \
  --no-bip39-passphrase \
  --outfile /etc/clmm-executor/wallet.json
sudo chmod 0400 /etc/clmm-executor/wallet.json
```

- File format is the standard Solana CLI keypair JSON: a 64-element byte array.
- Owner is a dedicated service account (`clmm-executor`) with `/usr/sbin/nologin`
  as its shell and no password.
- File mode `0400`, containing directory `0700`. Neither is group- or
  world-readable.
- Never in a repository, a shell argument, shell history, a CI variable, an
  environment variable, a container image, or a log line. The path is
  configuration; the contents never leave the file and process memory.

#### Host hardening

The key is only as protected as the host, so these are requirements and not
suggestions:

- **Full-disk encryption**
- **No swap, or encrypted swap.**
- **Core dumps disabled** for the process (`LimitCORE=0`)
- **Excluded from backups**
- Systemd hardening on the unit: `ProtectSystem=strict`, `PrivateTmp=yes`,
  `NoNewPrivileges=yes`, `MemoryDenyWriteExecute=yes`.

#### Loading and pinning

- Read the file once at startup through the filesystem API, never through a
  shell. Hold the secret only in process memory.
- Refuse to start if the file mode is group- or world-readable, if it is not
  owned by the running user, or if the parent directory is not `0700`. A
  permissive keyfile is a configuration error and must fail closed, exactly as
  a missing KMS grant does.
- Pin the expected address. `WALLET_PUBKEY`, when set, must equal the address
  derived from the loaded key or startup fails. This is the guard against
  deploying the wrong keyfile and silently trading from the wrong wallet — the
  §6 fee-payer check cannot catch it, because it validates against whatever key
  was loaded.
- Log the derived public key in `executor_started`; never log the path
  contents, and never include the secret in an error message or crash report.

#### What arm B does not provide

State these plainly so nobody assumes otherwise:

- **No hardware protection.**
- **No independent audit trail.**
- **No remote kill switch.**
- **No capability partition.**

#### Compensating controls

Because custody is weaker than arm A, the funding cap does more of the work:

- Fund the hot wallet with the working balance only. Under arm B the wallet's
  balance is the loss ceiling, and it is the primary control rather than a
  secondary one.
- Keep the reserve in a separate cold wallet whose key has never been on this
  host.
- Monitor for signatures the executor did not record: reconcile on-chain
  transaction history for the wallet against the executor JSONL on a schedule.
  A signature on chain with no matching log line means the key is being used
  outside the gateway, and is the arm B equivalent of a CloudTrail alert on an
  unexpected principal.
- Rotate the wallet on a fixed schedule and after any host compromise,
  suspected or confirmed, or any change of the set of people with root.

## 6. Signing and execution policy

Protecting the key does not prevent a compromised gateway from signing a
malicious message — under arm A by asking KMS for a signature, under arm B by
using the loaded key directly. The gateway must validate the fully compiled
transaction before every signing request.

This policy is signer-independent and identical under both arms. It is the only
control that survives a compromised gateway process in either one, which makes
it more important under arm B, where there is no external audit trail to catch
what it misses.

The policy must:

- allow-list the exact Meteora and Solana program IDs required by supported
  operations;
- reject unknown instructions and program IDs;
- allow-list pool and token mint addresses;
- verify every writable account and required signer;
- validate address lookup-table contents for versioned transactions;
- confirm that the configured wallet is the expected authority and fee payer;
- cap base amount, quote amount, SOL expenditure, slippage, priority fee,
  compute limit, and position rent;
- reject transfers to arbitrary recipients;
- reject opaque, client-supplied serialized transactions;
- simulate before signing and reject simulation errors;
- hash and audit the validated message before signing;
- bind the message hash to the executor `req_seq` and policy decision;
- reconcile ambiguous submissions before allowing a retry.

V1 policy configuration is the surface defined by `opms-spec.md` §9:

```text
POOL_ALLOWLIST
MINT_ALLOWLIST
MAX_SOL_PER_TX
MAX_SOL_PER_RUN
MAX_SLIPPAGE_BPS
MAX_PRIORITY_FEE_LAMPORTS
```

Daily notional caps, validity windows, and wallet/environment identifiers are
not part of v1 configuration and are not gate-1 acceptance criteria. The test
wallet's deliberately limited funding is the external campaign notional cap.
If server-side daily or time-window enforcement becomes required, it must first
be added to the specification and implementation.

## 7. Functional test harness

The primary gateway suite is TypeScript. It drives the same compiled subprocess
used by the keeper rather than assuming an HTTP service:

```text
tests/
  helpers/
    stdioClient.ts
  contract/
    protocol.test.ts
    stdio.test.ts
    receipts.test.ts
  component/
    policy.test.ts
    handlers.test.ts
    swapStream.test.ts
    recovery.test.ts
  functional/
    liveReads.test.ts
    positionLifecycle.test.ts
    swap.test.ts
    refreshBundle.test.ts
```

In addition, run the existing Python `dlmm-bot` keeper suite against
`node dist/bridge.js` using the keeper's `ExecBridge` subprocess pattern. This
is the cross-language wire-conformance gate. The existing
`ReplayExecBridge` round trip, receipt fidelity, decision-log parity, and swap
stream completeness checks remain part of the gate.

Live TypeScript tests must be opt-in and excluded from the ordinary test
command. Write tests must require `DRY_RUN=false` plus a separate, test-runner
confirmation flag so an ordinary production configuration cannot accidentally
activate a test campaign.

The subprocess uses the configuration surface from `opms-spec.md` §9:

```text
SOLANA_RPC_URL
SOLANA_RPC_WRITE_URL
SOLANA_WS_URL
SOLANA_RPC_MAX_CU_PER_SECOND
SOLANA_COMMITMENT
WALLET_SIGNER
KMS_KEY_ARN or WALLET_SECRET_ARN or WALLET_KEYPAIR_PATH
WALLET_PUBKEY
POOL_ALLOWLIST
MINT_ALLOWLIST
MAX_SOL_PER_TX
MAX_SOL_PER_RUN
MAX_SLIPPAGE_BPS
MAX_PRIORITY_FEE_LAMPORTS
JITO_ENABLED
JITO_BLOCK_ENGINE_URL
JITO_TIP_LAMPORTS
SWAP_STREAM_PATH
EXECUTOR_LOG_DIR
DRY_RUN
```

The test runner may additionally require `LIVE_WRITE_CONFIRM=yes` and a test
run ID. These guard the harness only and are not gateway protocol or policy
configuration.

`WALLET_SIGNER` selects the arm: `kms` requires `KMS_KEY_ARN` (§5.1), `keypair`
requires `WALLET_SECRET_ARN` (§5.4), `file` requires `WALLET_KEYPAIR_PATH`
(§5.5). `WALLET_PUBKEY` is optional under arms A and the Secrets Manager
fallback, and expected under arm B, where it pins which keyfile is legitimate.

The private key or seed must never be a test environment variable. Under arm B
the *path* is configuration; the file contents are not, and must never be
inlined into config, a container image, or a test fixture.

Every live run must produce a JSON artifact containing:

- gateway and connector versions;
- network, RPC provider identifier, pool, mints, and public wallet;
- sanitized requests and responses in stdio order;
- executor `req_seq` values and validated transaction-message hashes;
- signatures, slots, confirmation state, fees, and compute usage;
- created position IDs;
- before-and-after wallet, position, and per-bin balances;
- retry and reconciliation decisions;
- cleanup operations and final cleanup status.

## 8. Functional cases

### 8.1 V1 subprocess and signer boundary

V1 has no HTTP authentication surface. Its access boundary is the task/host and
the signer's own authorization — the AWS workload role under arm A, filesystem
ownership under arm B. It is not the subprocess seam, which the keeper shares
by environment inheritance under both arms (§2).

Cases 1–3 and 6–7 apply to both arms. Cases 4–5 are arm A; 9–11 are arm B.

1. Start `node dist/bridge.js` as the configured service user and verify that
   the keeper can exchange one ordered request/response line at a time.
2. Verify malformed JSON, an unknown verb, invalid parameters, and handler
   crashes each produce one protocol response without contaminating stdout.
3. Verify all human and operational logging goes to stderr or the configured
   log file.
4. *(Arm A)* Verify the process role can call `kms:GetPublicKey` and
   `kms:Sign` only on the configured wallet key.
5. *(Arm A)* Verify a different role, a different key ARN, and a disabled key
   fail closed before transaction submission.
6. Confirm no response, stderr line, operational log, or crash report contains
   private-key or secret material.
7. Confirm by deployment review that the executor's task/host runs only the
   keeper and the executor. `dex_executor`, `hb-enhanced-opms`, and
   `lp-monitor` co-located there would inherit the signing capability (§2);
   outside it they hold no grant. This is an inventory assertion, not a
   runtime control, and it is the reason §2 does not claim the subprocess is a
   security boundary.
8. *(Arm A)* Confirm no static AWS credentials reach either process: the task
   role must be the only credential source, verified by asserting
   `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are absent from the
   environment of both.
9. *(Arm B)* Verify the executor refuses to start when the keyfile is group- or
   world-readable, when it is not owned by the running user, or when its parent
   directory is not `0700`. Each must fail closed at startup, before any verb
   is accepted.
10. *(Arm B)* Verify `WALLET_PUBKEY` pinning: a keyfile whose derived address
    differs from the pin fails startup. Confirm the failure names neither the
    path contents nor any key material.
11. *(Arm B)* Verify the key never leaves the process: confirm the keyfile
    contents appear in no response, stderr line, log, or crash report; confirm
    core dumps are disabled for the service; and confirm the host has no
    unencrypted swap.

Under arm B, case 7 carries more weight than under arm A: any co-located
process running as the same user can read the keyfile directly, so the
deployment inventory is the control that keeps the wallet scoped to the
gateway.

Authenticated HTTP transport tests are phase 2. When that transport is added,
test accepted/rejected identities, read-only roles, replay protection, request
IDs, and cross-environment wallet isolation. None of those cases gates v1.

### 8.2 Connectivity and live reads

1. Start the subprocess and confirm its `executor_started` record contains the
   build version, Meteora SDK version, network, policy hash, wallet public key,
   and RPC identity.
2. Read pool state and validate pool address, mints, decimals, active bin, bin
   step, price, fees, and reserves.
3. Repeat at least 20 reads to detect intermittent RPC or serialization errors.
4. Compare active bin, price, and reserves with an independent RPC/API source.
5. Use `lp-monitor` or direct RPC as an independent oracle to discover a known
   test position; owned-position discovery is not a v1 gateway verb.
6. Call `get_position` for that known ID and validate ownership, range, balances, per-bin
   amounts, and claimable fees.
7. Verify normalized errors for invalid pool, invalid position, wrong network,
   and RPC failure.

### 8.3 Dust position lifecycle

Run the following as one recoverable scenario:

1. Record wallet balances and independently discover all owned positions with
   `lp-monitor` or direct RPC.
2. Open a dust-sized single-sided position in the allow-listed pool.
3. Wait for the configured commitment; require finalized status for full
   withdrawal/closure.
4. Independently verify owner, pool, price/bin range, deposited token side,
   token amount, and returned position ID.
5. Add liquidity to the same position.
6. Remove a documented percentage and verify the actual per-token deltas.
7. Read claimable fees with `get_position`, then verify that `withdraw` includes
   fee claiming and reports the realized claimed amounts. V1 has no separate
   quote-fees or collect-fees verb; zero accrued fees are acceptable if the
   response contract remains valid.
8. Close the position.
9. Verify token returns, position state, and rent refund.
10. Assert that no position created by the run remains open.

After the first lifecycle is stable, repeat it separately for base-only and
quote-only deposits.

### 8.4 Per-bin placement and readback

1. Place liquidity into an exact list of bins with known amounts.
2. Query the position and verify each bin and amount independently.
3. Add a second single-sided deposit and verify it returns the same position ID
   and the expected updated bin amounts.
4. Verify bid amounts debit quote and ask amounts debit base.
5. Verify boundary bins and the maximum supported bin span.
6. Reject duplicate bins, non-contiguous or unsorted bins, bins crossing the
   active bin, out-of-range bins,
   amount/bin length mismatches, zero amounts, and excessive amounts.

Selective per-bin removal is deferred because v1 `withdraw` accepts only a
position percentage. It becomes testable only after the protocol adds the
required bin-selection fields or a new verb.

### 8.5 Phase 2: Meteora limit orders

Limit orders are outside the first functional gate. Before enabling these
tests, extend the authoritative TypeScript protocol and Python bridge with
place, list, cancel, and close verbs. Then test:

1. Place a dust-sized bid-side limit order at a selected bin.
2. Place a dust-sized ask-side limit order at a selected bin.
3. List open limit orders and reconcile their IDs, side, bin, and remaining
   amounts.
4. Cancel an unfilled order and verify token recovery.
5. Attempt cancellation twice and verify idempotent behavior.
6. Close an empty or completed limit-order position.
7. Exercise a controlled fill where practical and reconcile received tokens,
   fees, and final status.
8. Reject invalid-side, invalid-bin, wrong-owner, and over-budget requests.

### 8.6 Swap behavior

1. Execute a dust base-to-quote swap.
2. Execute a return quote-to-base swap.
3. Validate signature, finality, input/output balance deltas, minimum output,
   route, and slippage enforcement.
4. Reject zero, negative, excessive, wrong-mint, and insufficient-balance
   requests.

### 8.7 End-to-end keeper verb flow

1. Launch `node dist/bridge.js` through the keeper's Python `ExecBridge`.
2. Send the six contract verbs exercised by their real keeper call sites.
3. Verify JSON-lines framing, strict response order, and
   `ExecResult.from_payload` compatibility.
4. For mutations, verify policy approval, SDK instruction construction, simulation, signing,
   submission, and finality.
5. Reconcile the service state against wallet and on-chain position state.
6. Exercise placement, refresh, stop-quoting, withdrawal, and emergency exit.
7. Confirm that normalized results are returned to the keeper without leaking
   gateway- or signer-specific implementation details.

Intent validation and persistence are not executor responsibilities in v1.
They may be tested with a future HTTP/intent layer, but do not gate the stdio
verb executor.

### 8.8 Restart and recovery

1. Restart the gateway after opening a position.
2. Restart `dlmm-bot` while the position remains open.
3. Retain the known position ID on the keeper side, call `get_position` after
   restart, and reconcile it against chain state. Automatic owned-position
   discovery is not part of the v1 executor contract.
4. Restart immediately after submission but before confirmation.
5. When a signature was durably recorded, reconcile it through the operational
   log, receipt lookup, wallet state, and `get_position`. When no signature is
   available, fail closed and require operator reconciliation rather than
   claiming exactly-once execution.
6. Verify strict single-flight processing and response order across process
   restarts.
7. Verify the executor does not rely on a process-local pool-to-position map;
   the known `position_id` supplied by the keeper remains authoritative.

### 8.9 Receipt and replay conformance

1. Parse every response fixture through the Python
   `ExecResult.from_payload` implementation.
2. Assert the authoritative `TxReceipt` shape from `src/protocol.ts`:
   `signature`, `slot`, `fee_lamports`, and `status` are present;
   `block_time` and `compute_unit_price` are present but may be `null`; and
   `status` is one of `confirmed`, `finalized`, `pending`, or `failed`.
3. Require at least configured commitment for a successful mutation and
   finalized status for full withdrawal/closure. Do not require all successful
   receipts to say `finalized` when the protocol permits `confirmed`.
4. Assert `transactions[i].signature == tx_signatures[i]` and independently
   verify that the sum of `fee_lamports` matches on-chain receipts.
5. Replay a recorded executor session through `ReplayExecBridge` and require
   zero decision differences and complete receipt preservation.
6. Interrupt the swap websocket, backfill the missed interval, and require the
   verifier to report zero missing swaps.

## 9. Failure and recovery cases

Inject failures through mocked dependencies or a controlled proxy:

- gateway validation error;
- Meteora SDK construction error;
- RPC 429 or 5xx response;
- RPC timeout before submission;
- timeout after submission with unknown transaction state;
- blockhash expiry;
- transaction simulation failure;
- finalized on-chain transaction failure;
- slippage breach;
- insufficient token balance;
- insufficient SOL for fees or rent;
- KMS access denied, throttling, timeout, or disabled key;
- gateway restart during signing or submission;
- failure between withdraw, swap, and redeposit;
- cleanup failure.

For every ambiguous mutation, the gateway must reconcile transaction status,
wallet balances, and a known position before deciding whether a retry is safe.
It must never blindly rebuild and sign a second transaction. Because v1 has no
caller request ID or transaction-status verb, exactly-once behavior across all
process-kill windows is not claimed; unresolved cases fail closed for operator
reconciliation.

For the Jito path, a dropped bundle must report `data.stage:"bundle_dropped"`
and no state change. For the sequential fallback, a partial failure must report
the authoritative `data.stage`, every receipt collected so far, and any
resulting `position_id`; it must not be reported as a successful atomic bundle.

## 10. Safety controls for live writes

- Use a dedicated wallet containing no production positions.
- Allow-list one pool for the first campaign.
- Fund only the maximum approved test budget plus known fees and rent.
- Require `DRY_RUN=false` and `LIVE_WRITE_CONFIRM=yes` in the test runner.
- Print the exact operation, pool, bin range, amounts, maximum spend, expected
  rent, and wallet before signing.
- Assign a unique test run ID and preserve the executor `req_seq`, message
  hash, and resulting signature for every mutation.
- Stop immediately if observed state differs from the recorded precondition.
- Never automatically close a position that was not created by the current
  test run.
- Persist created position IDs before proceeding to the next step.
- Provide a separate cleanup command that can resume from the run artifact.
- Drain the wallet and disable signing after the campaign. Under arm A that is
  disabling the KMS key or revoking `kms:Sign`; under arm B it is stopping the
  service and shredding the keyfile (`shred -u`) once the wallet is empty and
  the evidence is archived.

Additional under arm B, because custody is weaker (§5.5):

- Confirm before the campaign that the host's disk is encrypted, swap is
  encrypted or absent, and core dumps are disabled. These are preconditions,
  not cleanup steps.
- Keep the campaign wallet funded at the approved budget and no more; the
  balance is the loss ceiling, not just the spend cap.
- Reconcile the wallet's on-chain transaction history against the executor
  JSONL at the end of every campaign. Any signature without a matching log line
  means the key was used outside the gateway and is a compromise, not a
  discrepancy.

## 11. Acceptance criteria

The connector is ready for controlled rollout when all of the following hold:

- Contract and policy tests pass in CI.
- The signer compatibility spike for the deployed arm passes for all supported
  transaction formats: the KMS spike under arm A, the keyfile load/permission/
  pinning checks and a signed self-transfer under arm B.
- Live pool reads complete 20 out of 20 cycles successfully.
- Every successful mutation returns a signature that reaches the configured
  commitment; full withdrawal/closure reaches finalized status.
- Wallet, position, and per-bin state match the requested operation within
  token precision and known fee tolerances.
- Out-of-policy transactions never reach the signer, under either arm.
- Signer failure paths fail closed: KMS denial and timeout under arm A; missing,
  unreadable, over-permissive, or pin-mismatched keyfile under arm B.
- *(Arm B)* The host preconditions of §5.5 are verified and recorded: disk
  encryption, swap, core dumps, keyfile ownership and mode, off-box log
  shipping.
- Known positions remain queryable after restart and unresolved crash windows
  fail closed for operator reconciliation.
- Bid and ask deposits debit the correct token and retain the returned
  authoritative position ID.
- Failed closes retain enough evidence for reconciliation.
- Multi-step partial failures are visible and recoverable.
- Emergency exit removes all test-created exposure.
- Cleanup leaves no test-created positions open.
- SOL spend remains within `MAX_SOL_PER_TX` and `MAX_SOL_PER_RUN`; token
  exposure remains bounded by the deliberately funded dust wallet.
- Receipt tests follow the `src/protocol.ts` nullability and status union, and
  preserve every field through the Python bridge and replay path.
- The test artifact contains sufficient evidence to reproduce and audit every
  on-chain state change.

## 12. Delivery sequence

1. Treat `src/protocol.ts` as the fixed v1 verb and response contract. Choose
   the deployment arm (§5) before step 2; it is the only branch in this
   sequence, and steps 3–13 are identical under both.
2. Implement the signer for the chosen arm and the transaction-policy
   validator: the KMS spike under arm A, the keyfile loader with its
   permission and pinning checks under arm B.
3. Implement mocked contract, policy, stdio ordering, and failure tests.
4. Bring up the gateway against a local validator/simulator where possible.
5. Run the mainnet read-only gate.
6. Run a signed dust self-transfer with the test wallet, legacy and versioned.
7. Run open/read/close with dust liquidity.
8. Validate per-bin placement/readback and percentage-based withdrawal.
9. Validate swap and Jito/sequential `refresh_bundle` recovery.
10. Validate restart and ambiguous-submission reconciliation within the v1
    evidence available from receipts and executor logs.
11. Run the end-to-end `dlmm-bot` verb flow through the real subprocess.
12. Validate replay, receipt fidelity, and swap-stream completeness.
13. Archive evidence, clean up all test state, drain the wallet, and disable
    signing until the next approved campaign.

Authenticated HTTP transport, intents, stronger server-side campaign windows,
selective per-bin removal, and limit-order verbs are phase-2 specification work
and receive their own functional gates only after the machine-readable protocol
is extended.

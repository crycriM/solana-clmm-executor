# KMS signing gate — runbook

**Scope: deployment arm A (cloud) only.** For arm B — gateway and keeper on a
local server with the keypair in a file — see test plan §5.5, which is
self-contained and does not use anything in this document. Pick the arm before
running any of this; test plan §5 has the comparison.

Closes test plan §5.1 (KMS Ed25519 signer), §5.2 (IAM boundary), and the
delivery-sequence step 2 spike. Until this gate passes, M4 does not start and
nothing in this project signs a mainnet transaction under arm A.

Implementation: `src/signer.ts`. Spike runner: `src/tools/kmsSpike.ts`.

## 0. Platform fact this gate rests on

AWS KMS gained Ed25519 (EdDSA) support on **2025-11-07**
([announcement](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/),
[key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)).
Before that date the §5.1 design was not implementable and the §5.4 Secrets
Manager fallback was the only option. It is implementable now.

| Property | Value |
|---|---|
| `KeySpec` | `ECC_NIST_EDWARDS25519` (**not** `ED25519` or `ECC_ED25519`) |
| `KeyUsage` | `SIGN_VERIFY` |
| `SigningAlgorithm` | `ED25519_SHA_512` |
| `MessageType` | `RAW` |

`ED25519_PH_SHA_512` + `MessageType: DIGEST` is HashEdDSA — a **different
algorithm**. KMS prehashes again on top of the digest you supply, so the
resulting signature will not verify against a Solana transaction message. It is
denied by the IAM policy in §2 so it cannot be reached by accident.

## 1. Provision the wallet key

```bash
KEY_ID=$(aws kms create-key \
  --key-spec ECC_NIST_EDWARDS25519 \
  --key-usage SIGN_VERIFY \
  --description "solana-clmm-executor functional test wallet" \
  --tags TagKey=Project,TagValue=solana-clmm-executor TagKey=Env,TagValue=functest \
  --query 'KeyMetadata.KeyId' --output text)

aws kms create-alias \
  --alias-name alias/clmm-executor-functest-wallet \
  --target-key-id "$KEY_ID"

aws kms describe-key --key-id "$KEY_ID" \
  --query 'KeyMetadata.{Spec:KeySpec,Usage:KeyUsage,Arn:Arn}'
```

The Solana address is derived from `GetPublicKey`, not chosen. Get it by
running the spike (§3) — step `derive_address_from_get_public_key` prints it.
Fund that address with the approved test budget only (test plan §10).

Record in the provisioning inventory: wallet alias, derived public address, KMS
key ARN. Only `KMS_KEY_ARN` is runtime config; the rest is audit metadata.

## 2. IAM boundary (test plan §5.2)

Two roles. The workload role can use the key and nothing else; a separate
administrative role owns its lifecycle.

### Workload role — attach to the gateway task role only

`GetPublicKey` and `Sign` are split because the `kms:SigningAlgorithm`
condition key is absent on `GetPublicKey`; a single conditioned statement would
deny it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadWalletPublicKey",
      "Effect": "Allow",
      "Action": "kms:GetPublicKey",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
    },
    {
      "Sid": "SignPureEdDSAOnly",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID",
      "Condition": {
        "StringEquals": { "kms:SigningAlgorithm": "ED25519_SHA_512" }
      }
    },
    {
      "Sid": "NeverAdministerKeys",
      "Effect": "Deny",
      "Action": [
        "kms:Create*", "kms:Delete*", "kms:Disable*", "kms:Enable*",
        "kms:Import*", "kms:Put*", "kms:Revoke*", "kms:Schedule*",
        "kms:Update*", "kms:TagResource", "kms:UntagResource"
      ],
      "Resource": "*"
    }
  ]
}
```

Hard requirements, all asserted by the spike or by review:

- exact key ARN — no wildcard over other wallet keys;
- no `kms:Decrypt` and no `secretsmanager:GetSecretValue` (that is the §5.4
  fallback path and must not be reachable from the KMS path);
- no key-administration actions.

### Administrative role

Owns `CreateKey`, `ScheduleKeyDeletion`, `DisableKey`, `PutKeyPolicy`,
`ImportKeyMaterial`. Must **not** be assumable by the gateway workload.

### Credential and ARN storage

**AWS credentials are not stored.** `createKmsSigner` constructs
`new KMSClient({})`, which uses the SDK's default credential provider chain.
That is deliberate: there is no credential-handling code in this project to
review or get wrong.

| Environment | Credential source |
|---|---|
| ECS / Fargate | task role, container credentials endpoint |
| EC2 | instance profile via IMDSv2 |
| EKS | Pod Identity or IRSA |
| Developer machine | `aws sso login` — short-lived session credentials |
| CI | GitHub OIDC → `AssumeRoleWithWebIdentity` |

**Never** set static `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — not in
`.env`, not in CI variables, not in a task definition. A long-lived key that
can call `kms:Sign` is a wallet private key with extra steps: it is a bearer
credential, it does not expire, and it reintroduces exactly the custody problem
this design removes. Test plan §8.1 case 8 asserts their absence.

**`KMS_KEY_ARN` is configuration, not a secret.** Holding it grants nothing;
authorization is entirely the caller's IAM identity. It does embed the AWS
account ID, so keep it out of public artifacts, but it needs no secret store:
an ECS task-definition environment entry, a systemd `Environment=`, or an SSM
Parameter Store `String` are all fine. `.gitignore` already excludes `.env*`.

`config.ts` hashes the ARN into `policy_hash` (`hashArn`) rather than embedding
it, so the ARN does not travel wholesale in the startup record.

Open inconsistency: `Signer.signerId` is currently the raw ARN, and `redact()`
does not treat it as sensitive, so the full ARN lands in every executor JSONL
verb line. Plan T4.1 allows "KMS key ARN / pubkey"; the wallet pubkey is the
better value — already public, leaks no account ID, and it is what reconciles
against chain state. Decide before the first live campaign.

### Monitoring and kill switch

CloudTrail records every `Sign`. Alert on:

- any principal other than the gateway workload role calling `Sign` on this key;
- `Sign` volume above the expected campaign rate;
- `Sign` outside the approved test window;
- any `AccessDenied` on this key ARN.

```bash
aws logs put-metric-filter \
  --log-group-name "$CLOUDTRAIL_LOG_GROUP" \
  --filter-name clmm-wallet-kms-sign \
  --filter-pattern '{ ($.eventSource = "kms.amazonaws.com") && ($.eventName = "Sign") && ($.resources[0].ARN = "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID") }' \
  --metric-transformations metricName=ClmmWalletKmsSign,metricNamespace=ClmmExecutor,metricValue=1
```

**Emergency stop** — either is sufficient and both are immediate:

```bash
aws kms disable-key --key-id "$KEY_ID"                    # preferred
aws iam delete-role-policy --role-name GATEWAY_ROLE --policy-name SignWallet
```

Disabling the key is reversible with `enable-key`; scheduling deletion is not,
and is only for end-of-campaign teardown.

## 3. Run the spike

```bash
KMS_KEY_ARN=arn:aws:kms:REGION:ACCOUNT:key/KEY_ID \
SOLANA_RPC_URL=https://... \
npx tsx src/tools/kmsSpike.ts > evidence/kms-spike-$(date +%Y%m%dT%H%M%SZ).json
```

Read-only by default. The two on-chain steps are skipped unless
`LIVE_WRITE_CONFIRM=yes` **and** the wallet holds ≥ 20 000 lamports; they
spend two transaction fees (~10 000 lamports) on 1-lamport self-transfers:

```bash
KMS_KEY_ARN=... SOLANA_RPC_URL=... LIVE_WRITE_CONFIRM=yes \
  npx tsx src/tools/kmsSpike.ts > evidence/kms-spike-live.json
```

Progress goes to stderr; the JSON artifact goes to stdout. Exit code is
non-zero if any step failed. `SPIKE_LATENCY_SAMPLES` defaults to 20.

## 4. Gate checklist

Every test plan §5.1 bullet, and where it is closed:

| §5.1 requirement | Closed by | State |
|---|---|---|
| Derive the expected Solana address from `GetPublicKey` | spike `derive_address_from_get_public_key`; unit `public key derivation` | code ready, **needs a real key** |
| Sign a fixed message and verify locally | spike `sign_and_verify_fixed_message`; `signer.ts` verifies every signature before returning | code ready, **needs a real key** |
| Sign and finalize a dust self-transfer | spike `legacy_transaction_finalized` | code ready, **needs a funded key** |
| Confirm signature encoding for the chosen SDK | `Transaction.serialize()` re-verifies against the message before submission | code ready, **needs a funded key** |
| Verify legacy and versioned transaction support | spike `legacy_transaction_finalized` + `versioned_transaction_finalized` | code ready, **needs a funded key** |
| Measure signing latency p50/p95/p99 | spike `measure_sign_latency` | code ready, **needs a real key** |
| KMS timeout or denied request fails closed | spike `denied_key_fails_closed`; units `fails closed on…`, `propagates a KMS denial` | **unit-proven**; live denial needs a real key |

Non-negotiable properties already proven by `src/signer.test.ts` (22 tests, no
AWS required):

- a non-Ed25519, bare, or truncated public key is rejected rather than
  producing a plausible wrong address;
- a wrong `KeySpec`/`KeyUsage` fails at construction, before any signing;
- `MessageType: RAW` + `ED25519_SHA_512` are the algorithm actually requested;
- a corrupt, wrong-length, or missing signature throws instead of being
  returned;
- a KMS denial propagates rather than degrading to an unsigned result.

## 5. What is deliberately not here

- **The §5.4 Secrets Manager fallback.** KMS Ed25519 exists, so the fallback's
  reason to exist is gone. Add it only if the live spike fails.
- **Transaction-level signing helpers.** M4 (`policy.ts`, `handlers.ts`) builds
  transactions; `Signer.sign(message)` is the whole seam it needs. The spike
  assembles its two transactions inline — three lines each.
- **A KMS retry/timeout wrapper.** The AWS SDK's defaults already retry, and a
  throw out of `sign()` *is* the required fail-closed behaviour.
- **Per-component signing isolation.** The keeper spawns the executor with an
  inherited environment, so every process in the task shares the task role and
  can call `kms:Sign` directly. The task, not the subprocess, is the trust
  boundary — see test plan §2. Real isolation needs separate tasks with
  distinct roles, which needs the phase-2 HTTP transport.

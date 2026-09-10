# Vendored lp-monitor sources

Copied, never imported (implementation-plan T0.5 amendment): this project must
build standalone, upstream never gains signing authority, and neither side
imports from the other. Trimmed to what M2–M3 need.

Pinned upstream SHA: `aacfe017291681164a1a23b756f4516768699ad0`
(`LP-hedging-strategy` repo, `lp-monitor/` directory).

| Vendored file | Upstream path | Strip / delta |
|---|---|---|
| `solana.ts` | `lp-monitor/src/chains/solana.ts` | endpoint from this project's config; commitment arg + distinct write endpoint (`SOLANA_RPC_WRITE_URL`) |
| `logger.ts` | `lp-monitor/src/utils/logger.ts` | console transport → stderr (spec §5); log dir via config injection |
| `types.ts` | `lp-monitor/src/services/types.ts` | Krystal + error-flag types dropped; `*_raw` string fields added (spec §3.2) |
| `meteoraReads.ts` | `lp-monitor/src/dexes/meteoraDlmmAdapter.ts` | Read-only fetch/map + retry retained; CSV writer, tracking, fetchDeposits, file logging stripped; raw BN/string amounts preserved, proportional SDK amounts floored to raw units; decimals from SDK mint reserves, bin IDs corrected; USD enrichment left to M2 |
| `tokenMapping.ts` | `lp-monitor/src/services/tokenMappingService.ts` | CSV persistence stripped → in-memory cache; rate limit + batched price fetch kept |

Drift check (mechanical):

```bash
git -C ../LP-hedging-strategy show aacfe017291681164a1a23b756f4516768699ad0:lp-monitor/src/<upstream path>
```

Run from the executor project root, then diff against the vendored copy. Any intentional delta must be recorded
in the file header. Upstream fixes are pulled by re-copying and bumping the
SHA in the header — a deliberate reviewed step, not an automatic import.

## Hard exclusions never carried over

- `BN.toNumber()` on u64 amounts (`BN.toString()` / decimal.js only)
- All CSV persistence (`csv-writer`) — this project's persistence is JSONL

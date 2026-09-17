# Vendored read adapters

This directory contains isolated, read-only adapters used by the executor. The
copies keep this project standalone and have no signing authority or runtime
import from another repository.

| File | Purpose |
|---|---|
| `solana.ts` | Solana connection and endpoint handling |
| `logger.ts` | STDERR logging and executor log formatting |
| `types.ts` | Meteora position types with exact raw amounts |
| `meteoraReads.ts` | Read-only pool and position access with retries |
| `tokenMapping.ts` | Rate-limited in-memory token metadata cache |

The adapters intentionally omit CSV persistence and preserve large on-chain
amounts as strings alongside decimal-scaled values. Changes should retain those
properties and the read-only boundary.

#!/usr/bin/env node
/** Read-only account/rent preflight. No signer is imported or loaded. */
import fs from 'node:fs';
import { PublicKey, Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { POSITION_FEE } from '@meteora-ag/dlmm';
import { deriveWeightedDepositAddresses } from '../dist/dlmmAccounts.js';
import { RpcCuRateLimiter, rateLimitedFetch } from '../dist/rpcRateLimit.js';

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const pool = new PublicKey(input.pool);
  const wallet = new PublicKey(input.wallet);
  const connectionOptions = {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: rateLimitedFetch(new RpcCuRateLimiter(40)),
  };
  const connection = new Connection(process.env.SOLANA_RPC_URL, connectionOptions);
  // Same mainnet pin as the existing funding campaign, independent of signer mode.
  if (await connection.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
    throw new Error('experiment requires mainnet-beta');
  }
  if (process.env.SOLANA_RPC_WRITE_URL && process.env.SOLANA_RPC_WRITE_URL !== process.env.SOLANA_RPC_URL) {
    const write = new Connection(process.env.SOLANA_RPC_WRITE_URL, connectionOptions);
    if (await write.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
      throw new Error('experiment requires mainnet-beta');
    }
  }
  const derived = input.legs.map((leg) => ({
    side: leg.side,
    ...deriveWeightedDepositAddresses({
      pool, wallet, lowerBinId: leg.bin_ids[0], upperBinId: leg.bin_ids.at(-1),
      tokenMint: new PublicKey(leg.side === 'bid' ? input.quote_mint : input.base_mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      reserve: pool, // reserve is unused: this tool builds no transaction
    }),
  }));
  const keys = derived.flatMap((d) => [d.position, d.lowerBinArray, d.upperBinArray,
    d.userToken, ...(d.bitmapExtension ? [d.bitmapExtension] : [])]);
  const response = await connection.getMultipleAccountsInfoAndContext(keys);
  // A fresh ladder has different PDAs; checking only those two would miss an
  // unfinished earlier run on the same wallet and pool.
  // Alchemy's free-tier endpoint answers point reads but 429s this wallet-wide
  // scan. Use the public mainnet endpoint for this one unsigned safety check.
  const inventoryConnection = new Connection('https://api.mainnet-beta.solana.com', connectionOptions);
  if (await inventoryConnection.getGenesisHash() !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') {
    throw new Error('experiment requires mainnet-beta');
  }
  const existing = await inventoryConnection.getProgramAccounts(derived[0].programId, {
    commitment: 'finalized', dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: 8120 }, // Meteora PositionV2
      { memcmp: { offset: 8, bytes: pool.toBase58() } },
      { memcmp: { offset: 40, bytes: wallet.toBase58() } },
    ],
  });
  let index = 0;
  const positions = derived.map((d) => {
    const [position, lower, upper, ata, bitmap] = response.value.slice(index, index + (d.bitmapExtension ? 5 : 4));
    index += d.bitmapExtension ? 5 : 4;
    for (const account of [position, lower, upper, ...(d.bitmapExtension ? [bitmap] : [])]) {
      if (account && !account.owner.equals(d.programId)) throw new Error('account owner mismatch');
    }
    // Do not finance shared bin arrays or ATAs in a tiny, isolated experiment.
    if (!lower || !upper || !ata || (d.bitmapExtension && !bitmap)) {
      throw new Error('required bin arrays, bitmap or wallet ATA are absent');
    }
    if (!ata.owner.equals(TOKEN_PROGRAM_ID)) throw new Error('wallet ATA program mismatch');
    return { side: d.side, position_id: d.position.toBase58(), exists: position !== null };
  });
  const native = await connection.getBalanceAndContext(wallet);
  console.log(JSON.stringify({
    native_lamports: native.value, slot: Math.max(native.context.slot, response.context.slot),
    rent_lamports: positions.filter((p) => !p.exists).length * Math.ceil(POSITION_FEE * 1e9),
    existing_position_ids: existing.map((p) => p.pubkey.toBase58()),
    positions,
  }));
}

main().catch((error) => {
  // RPC exceptions may embed endpoint credentials. Only emit our fixed errors.
  const message = ['experiment requires mainnet-beta', 'account owner mismatch',
    'required bin arrays, bitmap or wallet ATA are absent', 'wallet ATA program mismatch']
    .includes(error.message) ? error.message : 'read-only account preflight failed';
  console.error(message);
  process.exitCode = 1;
});

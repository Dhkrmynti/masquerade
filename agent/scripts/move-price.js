// Local test helper: move a mock stock price on anvil.
//   node scripts/move-price.js NVDA -3     → NVDA 3% cheaper on router and oracle
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { foundry } from 'viem/chains';

const [sym, pctArg] = process.argv.slice(2);
const pct = Number(pctArg);
if (!sym || Number.isNaN(pct)) { console.error('usage: node scripts/move-price.js SYMBOL PERCENT'); process.exit(1); }

const here = path.dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(fs.readFileSync(path.join(here, '../../deployments/local.json'), 'utf8'));
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil dev account #0
const ABI = [
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [] },
];
const pc = createPublicClient({ chain: foundry, transport: http() });
const wc = createWalletClient({ chain: foundry, transport: http(), account: OWNER });
const S = dep[sym.toUpperCase()], U = dep.USDG;
if (!S) { console.error(`unknown symbol ${sym}`); process.exit(1); }

const f = BigInt(Math.round((100 + pct) * 1e6)); // scaled by 1e8
for (const target of [dep.router, dep.oracle]) {
  const up = await pc.readContract({ address: target, abi: ABI, functionName: 'price', args: [S, U] }); // USDG per share
  const down = await pc.readContract({ address: target, abi: ABI, functionName: 'price', args: [U, S] }); // share per USDG
  for (const [a, b, v] of [[S, U, up * f / 100000000n], [U, S, down * 100000000n / f]]) {
    const hash = await wc.writeContract({ address: target, abi: ABI, functionName: 'setPrice', args: [a, b, v] });
    await pc.waitForTransactionReceipt({ hash });
  }
}
const now = await pc.readContract({ address: dep.oracle, abi: ABI, functionName: 'price', args: [S, U] });
console.log(`${sym.toUpperCase()} moved ${pct}% → $${(Number(now) / 1e18).toFixed(2)}`);

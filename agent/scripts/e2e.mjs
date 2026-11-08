// End-to-end on local anvil: deploy an envoy, start the runner, add rules,
// move prices, and check what the agent did and what the vault refused.
// Needs anvil running with contracts deployed (../dev.sh does both).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { foundry } from 'viem/chains';
import { FACTORY_ABI, VAULT_ABI, ERC20_ABI } from '../../js/abi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(fs.readFileSync(path.join(here, '../../deployments/local.json'), 'utf8'));
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PORT = 5299, API = `http://127.0.0.1:${PORT}`;
const pc = createPublicClient({ chain: foundry, transport: http() });
const wc = createWalletClient({ chain: foundry, transport: http(), account: OWNER });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (t, v) => Number(formatUnits(await pc.readContract({ address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [v] }), 18));
const move = (s, p) => console.log('  ' + execFileSync('node', [path.join(here, 'move-price.js'), s, String(p)]).toString().trim());
const step = (t) => console.log(`\n▶ ${t}`);

// 1. deploy an envoy
step('owner deploys an envoy: purse $300, $75/order, $150/day, 1% slippage, NVDA + SPY');
const now = Number((await pc.getBlock()).timestamp);
const purse = parseUnits('300', 18);
await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: dep.USDG, abi: ERC20_ABI, functionName: 'approve', args: [dep.factory, purse] }) });
const salt = '0x' + Date.now().toString(16).padStart(64, '0');
await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: dep.factory, abi: FACTORY_ABI, functionName: 'createEnvoy', args: [{ agent: AGENT, tokens: [dep.NVDA, dep.SPY], perOrderMax: parseUnits('75', 18), dailyBuyLimit: parseUnits('150', 18), maxSlippageBps: 100, curfew: BigInt(now + 8 * 3600), purse, salt }] }) });
const envoys = await pc.readContract({ address: dep.factory, abi: FACTORY_ABI, functionName: 'envoysOf', args: [OWNER] });
const V = envoys[envoys.length - 1];
console.log('  vault', V);

// 2. start the runner
const stateFile = path.join(os.tmpdir(), `mq-agent-${Date.now()}.json`);
const runner = spawn('node', [path.join(here, '../src/runner.js')], { env: { ...process.env, PORT: String(PORT), TICK_MS: '800', STATE_FILE: stateFile, ALLOW_ORIGIN: '*' }, stdio: ['ignore', 'pipe', 'inherit'] });
runner.stdout.on('data', () => {});
const api = async (method, p, b) => { const r = await fetch(API + p, { method, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };
for (let i = 0; i < 40; i++) { try { if ((await api('GET', '/health')).status === 200) break; } catch {} await sleep(250); }
await sleep(1500); // let it discover the vault

try {
  step('add rules through the API');
  const add = async (text) => { const r = await api('POST', `/envoys/${V}/rules`, { text }); console.log(`  ${r.status} ${text} → ${r.json.rule?.text || r.json.error}`); return r; };
  assert.equal((await add('buy $50 NVDA if it drops 2%')).status, 201);
  assert.equal((await add('buy $500 NVDA if it drops 4%')).status, 201);
  assert.equal((await add('sell half NVDA if it rises 5%')).status, 201);
  assert.equal((await add('beli $25 SPY tiap 1 menit')).status, 201);
  assert.equal((await add('buy $10 TSLA if it drops 1%')).status, 400, 'TSLA is not on the script');
  await sleep(3000);
  assert.ok(await bal(dep.SPY, V) > 0, 'DCA bought SPY right away');

  step('NVDA −3% → dip rule 1 should buy $50');
  move('NVDA', -3); await sleep(3000);
  const nvda1 = await bal(dep.NVDA, V);
  assert.ok(nvda1 > 0, 'bought NVDA on the dip');

  step('NVDA −2% more → dip rule 2 wants $500, agent trims to the vault limits');
  move('NVDA', -2); await sleep(3000);
  assert.ok(await bal(dep.NVDA, V) > nvda1, 'second dip buy happened');
  const usdgAfterBuys = await bal(dep.USDG, V);
  assert.ok(Math.abs(usdgAfterBuys - 150) < 0.01, `exactly $150 bought today (got ${300 - usdgAfterBuys})`);

  step('one minute later the DCA fires again, but today\'s buy room is used up');
  await pc.request({ method: 'evm_increaseTime', params: [61] }); await pc.request({ method: 'evm_mine', params: [] });
  await sleep(3000);
  assert.ok(Math.abs(await bal(dep.USDG, V) - usdgAfterBuys) < 1e-9, 'no buy past the daily limit');

  step('NVDA +12% → take-profit sells half');
  const before = await bal(dep.NVDA, V);
  move('NVDA', 12); await sleep(3000);
  const after = await bal(dep.NVDA, V);
  assert.ok(Math.abs(after - before / 2) / before < 1e-6, `sold half (had ${before}, now ${after})`);

  step('owner recalls; agent pauses');
  await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: V, abi: VAULT_ABI, functionName: 'recall' }) });
  await sleep(2500);

  step('agent log');
  for (const l of (await api('GET', `/envoys/${V}`)).json.log) console.log('  · ' + l.msg);
  console.log('\n✅ e2e passed');
} finally {
  move('NVDA', 0); // leave prices roughly where they are
  runner.kill();
}

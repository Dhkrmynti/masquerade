// Talks to the envoy contracts on a local anvil chain.
// Uses anvil's unlocked dev accounts through eth_sendTransaction, so no
// private key ever lives in this page. Local development only.
import {
  createPublicClient, createWalletClient, http, parseUnits, formatUnits,
  BaseError, ContractFunctionRevertedError,
} from 'https://esm.sh/viem@2.21.0';
import { foundry } from 'https://esm.sh/viem@2.21.0/chains';
import { FACTORY_ABI, VAULT_ABI, ERC20_ABI, TOKEN_ERRORS } from './abi.js';

const RPC = 'http://127.0.0.1:8545';
// anvil default accounts #0 (owner) and #1 (agent): public dev addresses
export const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const SYMS = ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'SPY'];
export const FEE = 3000;

let pc, wc, dep, bySym = {}, symOf = {};

export async function connect() {
  dep = await fetch('deployments/local.json', { cache: 'no-store' }).then((r) => r.json());
  pc = createPublicClient({ chain: foundry, transport: http(RPC) });
  wc = createWalletClient({ chain: foundry, transport: http(RPC) });
  await pc.getChainId(); // throws if anvil is down
  bySym = { USDG: dep.USDG }; SYMS.forEach((s) => (bySym[s] = dep[s]));
  symOf = Object.fromEntries(Object.entries(bySym).map(([s, a]) => [a.toLowerCase(), s]));
  return dep;
}

export const addr = (sym) => bySym[sym];
export const sym = (a) => symOf[a.toLowerCase()] || a.slice(0, 8);
export const fmt = (v, d = 4) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: d });
export const units = (n) => parseUnits(String(n), 18);

export async function chainNow() {
  return Number((await pc.getBlock()).timestamp);
}

export async function usdgBalance(who = OWNER) {
  return pc.readContract({ address: dep.USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });
}

// Simulate first so a refusal comes back as the contract's own error name.
async function send(account, address, abi, functionName, args) {
  try {
    const { request } = await pc.simulateContract({ account, address, abi, functionName, args });
    const hash = await wc.writeContract(request);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    return { ok: true, hash, receipt };
  } catch (e) {
    return { ok: false, error: decode(e) };
  }
}

// Duck-typed: esm.sh can hand out separate copies of viem's error classes.
function decode(e) {
  if (e && typeof e.walk === 'function') {
    const r = e.walk((x) => x?.name === 'ContractFunctionRevertedError');
    if (r) {
      if (r.data?.errorName) return { name: r.data.errorName, args: (r.data.args || []).map(String) };
      if (r.reason) return { name: r.reason, args: [] };
    }
    return { name: e.shortMessage || 'Error', args: [] };
  }
  return { name: String(e?.message || e), args: [] };
}

export async function listEnvoys() {
  const vaults = await pc.readContract({ address: dep.factory, abi: FACTORY_ABI, functionName: 'envoysOf', args: [OWNER] });
  return Promise.all([...vaults].reverse().map(readEnvoy));
}

export async function readEnvoy(v) {
  const r = (fn, args = []) => pc.readContract({ address: v, abi: VAULT_ABI, functionName: fn, args });
  const [agent, perOrderMax, dailyBuyLimit, maxSlippageBps, curfew, recalled, onDuty, room, tokens] = await Promise.all([
    r('agent'), r('perOrderMax'), r('dailyBuyLimit'), r('maxSlippageBps'), r('curfew'), r('recalled'), r('onDuty'), r('buyRoomToday'), r('tokens'),
  ]);
  const bal = (t) => pc.readContract({ address: t, abi: ERC20_ABI, functionName: 'balanceOf', args: [v] });
  const usdg = await bal(dep.USDG);
  const holdings = await Promise.all(tokens.map(async (t) => ({ sym: sym(t), amount: await bal(t) })));
  return { address: v, agent, perOrderMax, dailyBuyLimit, maxSlippageBps, curfew: Number(curfew), recalled, onDuty, room, usdg, holdings, tokens: tokens.map(sym) };
}

export async function createEnvoy({ stocks, purse, perOrder, daily, slipBps, curfew, salt }) {
  const amount = units(purse);
  const a = await send(OWNER, dep.USDG, ERC20_ABI, 'approve', [dep.factory, amount]);
  if (!a.ok) return a;
  const params = {
    agent: AGENT, tokens: stocks.map(addr), perOrderMax: units(perOrder), dailyBuyLimit: units(daily || 0),
    maxSlippageBps: slipBps, curfew: BigInt(curfew), purse: amount, salt,
  };
  const res = await send(OWNER, dep.factory, FACTORY_ABI, 'createEnvoy', [params]);
  if (res.ok) res.envoy = res.receipt.logs.find((l) => l.address.toLowerCase() === dep.factory.toLowerCase())?.topics[2];
  return res;
}

// The agent's own key calls swap(); the vault decides whether it's allowed.
export async function agentSwap(vault, tokenIn, tokenOut, amount) {
  const amountIn = typeof amount === 'bigint' ? amount : units(amount);
  const quote = await pc.readContract({ address: vault, abi: VAULT_ABI, functionName: 'floorOut', args: [addr(tokenIn), addr(tokenOut), FEE, amountIn] }).catch(() => null);
  const before = await pc.readContract({ address: addr(tokenOut), abi: ERC20_ABI, functionName: 'balanceOf', args: [vault] });
  const res = await send(AGENT, vault, [...VAULT_ABI, ...TOKEN_ERRORS], 'swap', [addr(tokenIn), addr(tokenOut), FEE, amountIn, 0n]);
  if (res.ok) {
    const after = await pc.readContract({ address: addr(tokenOut), abi: ERC20_ABI, functionName: 'balanceOf', args: [vault] });
    res.got = after - before;
  }
  if (quote) { res.floor = quote[0]; res.fair = quote[1]; }
  return res;
}

export const recall = (vault) => send(OWNER, vault, VAULT_ABI, 'recall', []);
export const setLimits = (vault, perOrder, daily, slipBps) => send(OWNER, vault, VAULT_ABI, 'setLimits', [units(perOrder), units(daily), slipBps]);

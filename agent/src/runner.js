// Envoy agent runner: watches prices, fires rules, calls EnvoyVault.swap().
//
// The vault is the real guard; this process only tries to be a good agent:
// it sizes orders to the vault's limits before sending (no wasted gas on
// certain reverts), sends one transaction at a time, backs off after a
// failure, and persists rule state so a restart doesn't double-fire.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http as rpc, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { FACTORY_ABI, VAULT_ABI, ERC20_ABI, TOKEN_ERRORS } from '../../js/abi.js';
import { parseRule, evaluate, afterFill, arm, sizeBuy, describe } from './rules.js';
import * as llm from './llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// agent/.env holds secrets such as ANTHROPIC_API_KEY; it is git-ignored.
if (fs.existsSync(path.join(here, '../.env'))) process.loadEnvFile(path.join(here, '../.env'));
const CFG = {
  rpc: process.env.RPC_URL || 'http://127.0.0.1:8545',
  deployments: process.env.DEPLOYMENTS || path.join(here, '../../deployments/local.json'),
  state: process.env.STATE_FILE || path.join(here, '../state.json'),
  port: Number(process.env.PORT || 5199),
  tickMs: Number(process.env.TICK_MS || 5000),
  fee: 3000,
  backoffSec: 60,
  allowOrigin: process.env.ALLOW_ORIGIN || 'http://127.0.0.1:5198',
};
// Local default: anvil dev account #1 through the node's unlocked accounts.
// Anywhere else, AGENT_PRIVATE_KEY must be set and the chain must not be anvil.
const ANVIL_AGENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ORACLE_ABI = [{ type: 'function', name: 'quote', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }];

const dep = JSON.parse(fs.readFileSync(CFG.deployments, 'utf8'));
const pc = createPublicClient({ chain: foundry, transport: rpc(CFG.rpc) });
const account = process.env.AGENT_PRIVATE_KEY ? privateKeyToAccount(process.env.AGENT_PRIVATE_KEY) : ANVIL_AGENT;
const AGENT = typeof account === 'string' ? account : account.address;
const wc = createWalletClient({ chain: foundry, transport: rpc(CFG.rpc), account });

const symOf = Object.fromEntries(Object.entries(dep).filter(([k]) => /^[A-Z]+$/.test(k)).map(([k, a]) => [a.toLowerCase(), k]));
const addrOf = (s) => dep[s];
const toNum = (v) => Number(formatUnits(v, 18));

// ------------------------------------------------------------------ state

let state = { lastBlock: -1, vaults: {} };
try { state = JSON.parse(fs.readFileSync(CFG.state, 'utf8')); } catch { /* fresh start */ }
function save() {
  const tmp = CFG.state + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CFG.state); // atomic, so a crash can't leave half a file
}
const V = (v) => (state.vaults[v.toLowerCase()] ||= { rules: [], log: [] });
function log(v, msg, extra = {}) {
  const entry = { t: Math.floor(Date.now() / 1000), msg, ...extra };
  const s = V(v); s.log.push(entry); if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
  console.log(JSON.stringify({ vault: v, ...entry }));
}

// ------------------------------------------------------------------ chain

const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });

function decode(e) {
  const r = e?.walk?.((x) => x?.name === 'ContractFunctionRevertedError');
  return r?.data?.errorName || r?.reason || e?.shortMessage || String(e);
}

async function discover() {
  const head = await pc.getBlockNumber();
  if (BigInt(state.lastBlock) >= head) return;
  const logs = await pc.getContractEvents({
    address: dep.factory, abi: FACTORY_ABI, eventName: 'EnvoyCreated',
    args: { agent: AGENT }, fromBlock: BigInt(state.lastBlock + 1), toBlock: head,
  });
  for (const l of logs) { V(l.args.envoy); log(l.args.envoy, 'envoy discovered; waiting for rules'); }
  state.lastBlock = Number(head);
  if (logs.length) save();
}

async function snapshot(v) {
  const [onDuty, perOrderMax, room, tokens, agent] = await Promise.all([
    read(v, VAULT_ABI, 'onDuty'), read(v, VAULT_ABI, 'perOrderMax'), read(v, VAULT_ABI, 'buyRoomToday'),
    read(v, VAULT_ABI, 'tokens'), read(v, VAULT_ABI, 'agent'),
  ]);
  const usdg = await read(dep.USDG, ERC20_ABI, 'balanceOf', [v]);
  const syms = tokens.map((t) => symOf[t.toLowerCase()]).filter(Boolean);
  return { onDuty, agent, perOrderMax, room, usdg, syms };
}

const price = async (S) => toNum(await read(dep.oracle, ORACLE_ABI, 'quote', [addrOf(S), dep.USDG, CFG.fee, 10n ** 18n]));

async function swap(v, tokenIn, tokenOut, amountIn) {
  try {
    const { request } = await pc.simulateContract({
      account, address: v, abi: [...VAULT_ABI, ...TOKEN_ERRORS], functionName: 'swap',
      args: [tokenIn, tokenOut, CFG.fee, amountIn, 0n], // the vault enforces the TWAP floor itself
    });
    const hash = await wc.writeContract(request);
    const rc = await pc.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') return { ok: false, error: 'reverted on chain' };
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, error: decode(e) };
  }
}

// ------------------------------------------------------------------ loop

async function runVault(v, now) {
  const s = V(v);
  if (!s.rules.some((r) => !r.done)) return;
  const snap = await snapshot(v);
  if (snap.agent.toLowerCase() !== AGENT.toLowerCase()) return; // key was rotated away from us
  if (!snap.onDuty) {
    if (!s.offDutyLogged) { log(v, 'off duty (curfew or recall); rules paused'); s.offDutyLogged = true; save(); }
    return;
  }
  s.offDutyLogged = false;

  for (let i = 0; i < s.rules.length; i++) {
    let r = s.rules[i];
    if (r.done || (r.cooldownUntil && now < r.cooldownUntil)) continue;
    const p = await price(r.sym);
    if (r.ref === undefined && r.next === undefined) { r = s.rules[i] = { ...r, ...arm(r, p, now) }; save(); }
    const act = evaluate(r, p, now);
    if (!act) continue;

    let res, what;
    if (act.side === 'buy') {
      const sized = sizeBuy(act.amount, { perOrderMax: toNum(snap.perOrderMax), room: toNum(snap.room), usdg: toNum(snap.usdg) });
      if (sized.skip) { log(v, `rule "${describe(r)}" fired at $${p.toFixed(2)} but skipped: ${sized.skip}`); s.rules[i] = { ...r, cooldownUntil: now + CFG.backoffSec }; save(); continue; }
      what = `buy $${sized.amount.toFixed(2)} ${act.sym} at ~$${p.toFixed(2)}${sized.note ? ` (${sized.note})` : ''}`;
      res = await swap(v, dep.USDG, addrOf(act.sym), parseUnits(sized.amount.toFixed(6), 18));
    } else {
      const held = await read(addrOf(act.sym), ERC20_ABI, 'balanceOf', [v]);
      const amt = held * BigInt(Math.round(act.share * 100)) / 10000n;
      if (amt === 0n) { log(v, `rule "${describe(r)}" fired but there's no ${act.sym} to sell`); s.rules[i] = { ...r, cooldownUntil: now + CFG.backoffSec }; save(); continue; }
      what = `sell ${toNum(amt).toFixed(4)} ${act.sym} at ~$${p.toFixed(2)}`;
      res = await swap(v, addrOf(act.sym), dep.USDG, amt);
    }

    if (res.ok) {
      s.rules[i] = afterFill(r, p, now);
      log(v, `filled: ${what}`, { tx: res.hash, rule: r.id });
    } else {
      s.rules[i] = { ...r, cooldownUntil: now + CFG.backoffSec };
      log(v, `vault refused: ${what} → ${res.error}; retrying in ${CFG.backoffSec}s`, { rule: r.id });
    }
    save();
    // refresh limits after any send
    Object.assign(snap, await snapshot(v));
  }
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true; // one pass at a time keeps nonces in order
  try {
    await discover();
    const now = Number((await pc.getBlock()).timestamp);
    for (const v of Object.keys(state.vaults)) {
      try { await runVault(v, now); } catch (e) { log(v, `error: ${e.shortMessage || e.message}`); }
    }
  } catch (e) {
    console.error(JSON.stringify({ error: e.shortMessage || e.message }));
  } finally { ticking = false; }
}

// ------------------------------------------------------------------ API
// LOCAL ONLY: no auth. A production version must require a signature from
// the vault owner before accepting rules.

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': CFG.allowOrigin, 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(body));
}
const body = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const m = req.url.match(/^\/envoys\/(0x[0-9a-fA-F]{40})(?:\/rules(?:\/(\d+))?)?$/);
  try {
    if (req.url === '/health') return send(res, 200, { agent: AGENT, chainId: await pc.getChainId(), vaults: Object.keys(state.vaults).length, claude: llm.enabled() });
    if (!m) return send(res, 404, { error: 'not found' });
    const v = m[1].toLowerCase();
    if (req.method === 'GET') return send(res, 200, { rules: V(v).rules.map((r) => ({ ...r, text: describe(r) })), log: V(v).log.slice(-50) });
    const snap = await snapshot(m[1]);
    if (snap.agent.toLowerCase() !== AGENT.toLowerCase()) return send(res, 403, { error: 'this envoy is not assigned to this agent' });
    if (req.method === 'POST') {
      const { text } = await body(req);
      const t = String(text || '').slice(0, 500);
      let out = parseRule(t, snap.syms), reply;
      // The regex parser is free and exact; Claude only handles what it can't.
      if (out.error && llm.enabled()) {
        const prices = Object.fromEntries(await Promise.all(snap.syms.map(async (S) => [S, await price(S)])));
        const dailyBuyLimit = toNum(await read(m[1], VAULT_ABI, 'dailyBuyLimit'));
        const ai = await llm.interpret(t, { symbols: snap.syms, prices, perOrderMax: toNum(snap.perOrderMax), dailyBuyLimit, usdg: toNum(snap.usdg) });
        if (ai?.action === 'clarify') return send(res, 200, { clarify: true, reply: ai.reply });
        if (ai?.action === 'reject') return send(res, 400, { error: ai.error || ai.reply, reply: ai.reply });
        if (ai?.action === 'rule') { out = { rule: ai.rule }; reply = ai.reply; }
      }
      if (out.error) return send(res, 400, { error: out.error });
      const s = V(v);
      const rule = { id: (s.nextId = (s.nextId || 0) + 1), ...out.rule, ...(reply ? { via: 'claude' } : {}) };
      s.rules.push(rule);
      log(v, `rule added: ${describe(rule)}`, { rule: rule.id });
      save();
      tick(); // arm it right away
      return send(res, 201, { rule: { ...rule, text: describe(rule) }, reply });
    }
    if (req.method === 'DELETE' && m[2]) {
      const s = V(v); const id = Number(m[2]);
      s.rules = s.rules.filter((r) => r.id !== id);
      log(v, `rule ${id} removed`); save();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, 500, { error: e.shortMessage || e.message });
  }
});

const chainId = await pc.getChainId();
// A restarted anvil is a new chain: drop rules for vaults that no longer exist.
const genesis = (await pc.getBlock({ blockNumber: 0n })).hash;
if (state.genesis !== genesis) { state = { genesis, lastBlock: -1, vaults: {} }; save(); }
if (typeof account === 'string' && chainId !== 31337) {
  console.error('Refusing to run with an unlocked dev account on a non-local chain. Set AGENT_PRIVATE_KEY.');
  process.exit(1);
}
server.listen(CFG.port, '127.0.0.1', () => console.log(JSON.stringify({ agent: AGENT, chainId, api: `http://127.0.0.1:${CFG.port}`, tickMs: CFG.tickMs })));
setInterval(tick, CFG.tickMs);
tick();

// Envoys panel on a real (local anvil) chain. If anvil isn't running, the
// page keeps its demo behaviour and this module does nothing.
import * as C from './chain.js';

const $ = (id) => document.getElementById(id);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const store = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const load = (k) => JSON.parse(localStorage.getItem(k) || '{}');

let envs = [], sel = 0, busy = false, pick = ['NVDA'], queue = Promise.resolve();
const names = load('mq-live-names'), logs = load('mq-live-logs');
const AGENT_API = 'http://127.0.0.1:5199';
let agentUp = false, agentClaude = false, agentLog = {};
const RULE_WORDS = /\b(if|when|every|kalau|jika|tiap|setiap)\b/i;

const EXPLAIN = {
  OverOrderCap: (a) => `That's over my per-order cap of $${C.fmt(BigInt(a[1]), 2)}. The vault refused it.`,
  OverDailyLimit: (a) => `That would take today's buys to $${C.fmt(BigInt(a[0]), 2)}, past the $${C.fmt(BigInt(a[1]), 2)} daily limit. The vault refused it.`,
  NotOnScript: () => `That stock isn't on my script, so the vault won't let me touch it.`,
  OffDuty: () => `I'm off duty: the curfew has passed or I've been recalled.`,
  FeeNotAllowed: () => `That pool's fee tier isn't on the allowed list.`,
  slippage: () => `The pool price was worse than the TWAP floor, so the fill was refused.`,
  InsufficientOutput: () => `The router delivered less than the floor, so the vault reverted the swap.`,
  ERC20InsufficientBalance: () => `My purse doesn't hold that much.`,
  'no price': () => `The oracle has no price for that pair, so I won't trade blind.`,
};
const explain = (e) => (EXPLAIN[e.name] ? EXPLAIN[e.name](e.args) : `The transaction failed: ${e.name}.`) + ` <span class="mono" style="opacity:.6">[${e.name}]</span>`;

function log(v, who, text) {
  (logs[v] ||= []).push([who, text, Date.now() / 1000]);
  store('mq-live-logs', logs);
  render();
}

async function refresh() {
  envs = await C.listEnvoys();
  if (sel >= envs.length) sel = 0;
  const bal = await C.usdgBalance();
  $('conn').textContent = `${short(C.OWNER)} · ${C.fmt(bal, 2)} USDG`;
  render();
}

function render() {
  const now = Date.now() / 1000;
  if (!envs.length) {
    $('ecards').innerHTML = `<div class="box" style="padding:22px;color:var(--mute)">No envoys on chain yet. Press <b style="color:var(--ink)">+ New envoy</b> to deploy one.</div>`;
    $('cName').textContent = '—'; $('cSub').textContent = ''; $('msgs').innerHTML = ''; return;
  }
  $('ecards').innerHTML = envs.map((e, i) => {
    const state = e.recalled ? 'RECALLED' : e.onDuty ? 'ON DUTY' : 'OFF DUTY';
    const daily = e.dailyBuyLimit > 0n;
    const pct = daily ? Number(e.room * 1000n / e.dailyBuyLimit) / 10 : 100;
    const hold = e.holdings.filter((h) => h.amount > 0n).map((h) => `${C.fmt(h.amount)} ${h.sym}`).join(' · ') || 'no stock yet';
    const t = new Date(e.curfew * 1000).toTimeString().slice(0, 5);
    return `<div class="box ec ${i === sel ? 'picked' : ''}" data-i="${i}">
      <div class="hd"><div class="who"><div class="av"><svg viewBox="0 0 200 110" width="26"><use href="#mask"/></svg></div>
      <div><b>${names[e.address] || 'Envoy ' + short(e.address)}</b><small>${e.tokens.join(' · ')} · <span class="mono">${short(e.address)}</span></small></div></div>
      <span class="tag ${e.onDuty ? 'a' : 'r'}">${state}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="meta"><span>$${C.fmt(e.usdg, 2)} USDG in purse${daily ? ` · $${C.fmt(e.room, 2)} buy room today` : ''}</span><span>max $${C.fmt(e.perOrderMax, 0)}/order · slip ${e.maxSlippageBps / 100}% · curfew ${t}</span></div>
      <div class="meta" style="margin-top:6px"><span>${hold}</span>${e.recalled ? '' : `<button class="lnk" data-recall="${i}" style="margin:0">Recall</button>`}</div>
    </div>`;
  }).join('');
  $('ecards').querySelectorAll('.ec').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.dataset.recall) return;
    sel = +el.dataset.i; render();
  }));
  $('ecards').querySelectorAll('[data-recall]').forEach((b) => b.addEventListener('click', () => doRecall(envs[+b.dataset.recall])));

  const e = envs[sel];
  $('cName').textContent = names[e.address] || 'Envoy';
  $('cSub').textContent = `vault ${short(e.address)} · agent key ${short(e.agent)} · ${e.tokens.join(', ')}`;
  $('cState').textContent = e.recalled ? 'RECALLED' : e.onDuty ? 'ON DUTY' : 'OFF DUTY';
  const hint = agentUp
    ? 'Agent online. Give it rules: <b>buy $50 NVDA if it drops 2%</b>, <b>sell half NVDA if it rises 5%</b>, <b>buy $25 SPY every 1 hour</b>. Manual: <b>buy $50 NVDA</b>, <b>sell all NVDA</b>, <b>recall</b>.'
    : 'Try: <b>buy $50 NVDA</b>, <b>sell all NVDA</b>, <b>buy $500 NVDA</b> (over cap), or <b>recall</b>. Start the agent (npm start in /agent) for automatic rules.';
  const mine = logs[e.address] || [['sys', hint, 0]];
  const auto = (agentLog[e.address.toLowerCase()] || []).filter((x) => !/^rule added/.test(x.msg)).map((x) => ['a agent', '🤖 ' + x.msg + (x.tx ? ` <span class="mono" style="opacity:.6">tx ${short(x.tx)}</span>` : ''), x.t]);
  const l = [...mine, ...auto].sort((a, b) => (a[2] || 0) - (b[2] || 0));
  $('msgs').innerHTML = l.map(([w, t]) => `<div class="m ${w}">${t}</div>`).join('');
  $('msgs').scrollTop = 1e9;
}

async function doRecall(e) {
  if (busy) return; busy = true;
  log(e.address, 'sys', 'Owner is recalling this envoy…');
  const r = await C.recall(e.address);
  log(e.address, r.ok ? 'a' : 'sys', r.ok ? `Recalled. Everything in my vault went back to your wallet. <span class="mono" style="opacity:.6">tx ${short(r.hash)}</span>` : explain(r.error));
  busy = false; await refresh();
}

function handle(text) {
  queue = queue.then(() => run(text)).catch((err) => console.error(err));
}

async function run(text) {
  const e = envs[sel]; if (!e) return;
  log(e.address, 'u', text);
  let m;
  const manual = /^(buy|sell)\s+(\$?[\d.]+|all)\s+\$?[a-z]*\s*[a-z]+\s*$/i.test(text) || /^(recall|stop|come home)\b/i.test(text);
  if (agentUp && (RULE_WORDS.test(text) || (agentClaude && !manual))) {
    try {
      const r = await fetch(`${AGENT_API}/envoys/${e.address}/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then((x) => x.json());
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      if (r.rule) log(e.address, 'a', `${r.reply ? esc(r.reply) + '<br>' : ''}Rule armed: <b>${r.rule.text}</b>${r.rule.via === 'claude' ? ' <span class="mono" style="opacity:.6">[via Claude]</span>' : ''}. The vault still checks every order.`);
      else if (r.clarify) log(e.address, 'a', esc(r.reply));
      else log(e.address, 'a', `I can't take that rule: ${esc(r.error)}.`);
    } catch { log(e.address, 'sys', 'Agent server is not reachable.'); }
    return;
  }
  if ((m = text.match(/^buy\s+\$?([\d.]+)\s*(?:usdg|usd)?\s*(?:of\s+)?([a-z]+)/i))) {
    const [, amt, s] = m; const S = s.toUpperCase();
    busy = true; log(e.address, 'sys', `agent → swap(${amt} USDG → ${S})`);
    const r = await C.agentSwap(e.address, 'USDG', S, amt);
    log(e.address, r.ok ? 'a' : 'a', r.ok
      ? `Filled: ${C.fmt(r.got)} ${S} for $${amt}. Floor was ${C.fmt(r.floor)} (fair ${C.fmt(r.fair)}). <span class="mono" style="opacity:.6">tx ${short(r.hash)}</span>`
      : explain(r.error));
  } else if ((m = text.match(/^sell\s+(all|[\d.]+)\s+([a-z]+)/i))) {
    const S = m[2].toUpperCase();
    const h = e.holdings.find((x) => x.sym === S);
    const all = m[1].toLowerCase() === 'all';
    const amt = all ? (h ? h.amount : 0n) : m[1];
    const shown = all ? C.fmt(amt) : amt;
    busy = true; log(e.address, 'sys', `agent → swap(${shown} ${S} → USDG)`);
    const r = await C.agentSwap(e.address, S, 'USDG', amt);
    log(e.address, 'a', r.ok ? `Sold ${shown} ${S} for $${C.fmt(r.got, 2)}. <span class="mono" style="opacity:.6">tx ${short(r.hash)}</span>` : explain(r.error));
  } else if (/recall|stop|come home/i.test(text)) {
    await doRecall(e); return;
  } else {
    log(e.address, 'a', 'I understand <b>buy $AMOUNT SYMBOL</b>, <b>sell AMOUNT|all SYMBOL</b> and <b>recall</b>. Every order is checked by my vault on chain, not by me.');
    return;
  }
  busy = false; await refresh();
}

async function create() {
  if (busy) return;
  const purse = +$('ePurse').value, perOrder = +$('eOrder').value, daily = +($('eDaily').value || 0), slip = Math.round(+$('eSlip').value * 100);
  const [hh, mm] = $('eCurfew').value.split(':').map(Number);
  const now = await C.chainNow();
  const d = new Date(now * 1000); d.setHours(hh, mm, 0, 0);
  let curfew = Math.floor(d.getTime() / 1000); if (curfew <= now + 60) curfew += 86400;
  if (!pick.length) return toast('Pick at least one stock');
  busy = true; $('eCreate').textContent = 'Deploying…';
  const salt = '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const r = await C.createEnvoy({ stocks: pick, purse, perOrder, daily, slipBps: slip, curfew, salt });
  busy = false; $('eCreate').textContent = 'Fund & send envoy';
  if (!r.ok) return toast('Refused by the contract: ' + r.error.name);
  await refresh();
  const v = envs[0].address; names[v] = $('eName').value || 'Envoy'; store('mq-live-names', names);
  logs[v] = [['sys', `Deployed vault ${short(v)} with $${purse} USDG. Agent key ${short(C.AGENT)} can only call swap().`]];
  if (!agentUp) logs[v].push(['u', $('eInst').value]);
  store('mq-live-logs', logs); sel = 0; $('envForm').style.display = 'none'; render();
  if (agentUp && RULE_WORDS.test($('eInst').value)) {
    await new Promise((r) => setTimeout(r, 1500)); // let the agent discover the new vault
    handle($('eInst').value);
  }
  toast(`Envoy deployed on local chain · tx ${short(r.hash)}`);
}

function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200); }

async function main() {
  try { await C.connect(); } catch (e) { console.log('[mq] local chain not reachable, staying in demo mode'); return; }
  document.querySelector('.demo').textContent = 'LOCAL ANVIL CHAIN · TEST TOKENS · REAL ENVOY CONTRACTS · ENVOYS TAB IS LIVE';
  document.querySelector('.pill').innerHTML = '<i></i>Local chain · anvil';
  $('conn').onclick = refresh;
  // stock chips: only tokens deployed on the local chain
  $('eStocks').innerHTML = C.SYMS.map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('');
  const paint = () => $('eStocks').querySelectorAll('button').forEach((b) => b.classList.toggle('on', pick.includes(b.dataset.k)));
  $('eStocks').onclick = (ev) => { const k = ev.target.dataset.k; if (!k) return; pick = pick.includes(k) ? pick.filter((x) => x !== k) : [...pick, k]; paint(); };
  paint();
  $('eInst').value = 'buy $50 NVDA if it drops 2%';
  $('eCreate').onclick = create;
  $('cForm').onsubmit = (ev) => { ev.preventDefault(); const t = $('cIn').value.trim(); if (t) { $('cIn').value = ''; handle(t); } };
  try { const h = await fetch(AGENT_API + '/health').then((r) => r.json()); agentUp = h.agent?.toLowerCase() === C.AGENT.toLowerCase(); agentClaude = agentUp && !!h.claude; } catch { agentUp = false; }
  if (agentUp) document.querySelector('.pill').innerHTML = `<i></i>Local chain · agent online${agentClaude ? ' · Claude' : ''}`;
  setInterval(async () => {
    if (!agentUp || !envs[sel]) return;
    const v = envs[sel].address;
    try {
      const j = await fetch(`${AGENT_API}/envoys/${v}`).then((r) => r.json());
      const prev = (agentLog[v.toLowerCase()] || []).length;
      agentLog[v.toLowerCase()] = j.log || [];
      if (agentLog[v.toLowerCase()].length !== prev) await refresh();
    } catch { /* agent restarting */ }
  }, 2500);
  window.renderEnv = render; // the demo script calls this when the tab opens
  await refresh();
  window.mqLive = true;
}
main();

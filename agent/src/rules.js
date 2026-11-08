// Pure rule logic: turn an instruction into a rule, decide when it fires,
// and size an order against the vault's limits. No chain access here, so
// everything is unit-testable.

const UNITS = { m: 60, min: 60, mins: 60, minute: 60, minutes: 60, menit: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, jam: 3600, d: 86400, day: 86400, days: 86400, hari: 86400 };
const FRACTIONS = { all: 100, semua: 100, half: 50, setengah: 50, quarter: 25 };

const num = (s) => Number(String(s).replace(/[$,]/g, ''));

/**
 * Parse one instruction. Understands English and simple Indonesian:
 *   buy $50 NVDA if it drops 2%            (every time → repeat)
 *   sell half NVDA if it rises 5%          (all / half / 30%)
 *   buy $25 SPY every 1 hour               (DCA)
 *   beli $50 NVDA kalau turun 2% | jual setengah NVDA kalau naik 5% | beli $25 SPY tiap 1 jam
 * Returns { rule } or { error }.
 */
export function parseRule(text, symbols) {
  const t = text.trim().replace(/\s+/g, ' ');
  const sym = (s) => {
    const S = s.toUpperCase();
    return symbols.includes(S) ? S : null;
  };
  const repeat = /every time|each time|setiap kali|terus/i.test(t);
  let m;

  // DCA: buy $25 SPY every 1 hour
  if ((m = t.match(/^(?:buy|beli|dca)\s+\$?([\d.,]+)\s*(?:usdg?)?\s*(?:of\s+|into\s+)?([a-z]+)\s+(?:every|tiap|setiap)\s+(\d+)?\s*([a-z]+)/i))) {
    const [, amt, s, n, u] = m;
    const S = sym(s), unit = UNITS[u.toLowerCase()];
    if (!S) return { error: `${s.toUpperCase()} isn't one of this envoy's stocks` };
    if (!unit) return { error: `unknown interval "${u}"` };
    const every = (n ? Number(n) : 1) * unit;
    if (every < 60) return { error: 'interval must be at least one minute' };
    return { rule: { kind: 'dca', sym: S, amount: num(amt), every } };
  }

  // Dip buy: buy $50 NVDA if it drops 2%
  if ((m = t.match(/^(?:buy|beli)\s+\$?([\d.,]+)\s*(?:usdg?)?\s*(?:of\s+)?([a-z]+)\s+(?:if|when|kalau|jika|saat)\s+(?:it\s+)?(?:drops|falls|dips|turun)\s+([\d.]+)\s*%/i))) {
    const [, amt, s, p] = m;
    const S = sym(s);
    if (!S) return { error: `${s.toUpperCase()} isn't one of this envoy's stocks` };
    return { rule: { kind: 'dip', sym: S, amount: num(amt), pct: Number(p), repeat } };
  }

  // Take profit: sell half NVDA if it rises 5%
  if ((m = t.match(/^(?:sell|jual)\s+(all|half|quarter|semua|setengah|[\d.]+\s*%)\s*(?:of\s+)?([a-z]+)\s+(?:if|when|kalau|jika|saat)\s+(?:it\s+)?(?:rises|climbs|goes up|naik)\s+([\d.]+)\s*%/i))) {
    const [, f, s, p] = m;
    const S = sym(s);
    if (!S) return { error: `${s.toUpperCase()} isn't one of this envoy's stocks` };
    const share = FRACTIONS[f.toLowerCase()] ?? Number(f.replace('%', ''));
    if (!(share > 0 && share <= 100)) return { error: 'sell share must be between 1% and 100%' };
    return { rule: { kind: 'rise', sym: S, share, pct: Number(p), repeat } };
  }

  return { error: 'not a rule I understand' };
}

/** Decide whether a rule fires at this price/time. Returns an action or null. */
export function evaluate(rule, price, now) {
  if (rule.done) return null;
  switch (rule.kind) {
    case 'dip':
      return price <= rule.ref * (1 - rule.pct / 100) ? { side: 'buy', sym: rule.sym, amount: rule.amount } : null;
    case 'rise':
      return price >= rule.ref * (1 + rule.pct / 100) ? { side: 'sell', sym: rule.sym, share: rule.share } : null;
    case 'dca':
      return now >= rule.next ? { side: 'buy', sym: rule.sym, amount: rule.amount } : null;
    default:
      return null;
  }
}

/** Rule state after a successful fill. Pure: returns a new object. */
export function afterFill(rule, price, now) {
  if (rule.kind === 'dca') return { ...rule, next: now + rule.every, fills: (rule.fills || 0) + 1 };
  return rule.repeat
    ? { ...rule, ref: price, fills: (rule.fills || 0) + 1 } // ladder from the new price
    : { ...rule, done: true, fills: (rule.fills || 0) + 1 };
}

/** Rule state when it's first armed. */
export function arm(rule, price, now) {
  if (rule.kind === 'dca') return { ...rule, next: now };
  return { ...rule, ref: price };
}

/**
 * Fit a buy to what the vault will accept, so the agent doesn't burn gas on
 * a transaction the contract would refuse. All values in whole USDG units.
 * Returns { amount, note } or { skip }.
 */
export function sizeBuy(amount, { perOrderMax, room, usdg }, minOrder = 1) {
  let a = amount, note = '';
  if (a > perOrderMax) { a = perOrderMax; note = `trimmed to the $${perOrderMax} per-order cap`; }
  if (a > room) { a = room; note = `trimmed to today's $${room} buy room`; }
  if (a > usdg) { a = usdg; note = `trimmed to the $${usdg} left in the purse`; }
  if (a < minOrder) return { skip: room < minOrder ? 'daily buy limit reached' : usdg < minOrder ? 'purse is empty' : 'order too small' };
  return { amount: a, note };
}

export function describe(r) {
  if (r.kind === 'dca') return `buy $${r.amount} ${r.sym} every ${r.every >= 3600 ? r.every / 3600 + 'h' : r.every / 60 + 'm'}`;
  if (r.kind === 'dip') return `buy $${r.amount} ${r.sym} if it drops ${r.pct}%${r.repeat ? ' (every time)' : ''}`;
  return `sell ${r.share}% of ${r.sym} if it rises ${r.pct}%${r.repeat ? ' (every time)' : ''}`;
}

/**
 * Check a rule that came from somewhere other than parseRule (e.g. Claude's
 * structured output) against the same constraints. Returns { rule } or { error }.
 */
export function validateRule(r, symbols) {
  if (!r || typeof r !== 'object') return { error: 'no rule' };
  const S = String(r.sym || '').toUpperCase();
  if (!symbols.includes(S)) return { error: `${S || 'that stock'} isn't one of this envoy's stocks` };
  const finite = (x) => typeof x === 'number' && Number.isFinite(x);
  const repeat = r.repeat === true;
  switch (r.kind) {
    case 'dip':
      if (!finite(r.amount) || r.amount <= 0) return { error: 'buy amount must be positive' };
      if (!finite(r.pct) || r.pct <= 0 || r.pct >= 90) return { error: 'drop must be between 0% and 90%' };
      return { rule: { kind: 'dip', sym: S, amount: r.amount, pct: r.pct, repeat } };
    case 'rise':
      if (!finite(r.share) || r.share <= 0 || r.share > 100) return { error: 'sell share must be between 1% and 100%' };
      if (!finite(r.pct) || r.pct <= 0 || r.pct > 1000) return { error: 'rise must be a positive percentage' };
      return { rule: { kind: 'rise', sym: S, share: r.share, pct: r.pct, repeat } };
    case 'dca':
      if (!finite(r.amount) || r.amount <= 0) return { error: 'buy amount must be positive' };
      if (!finite(r.every) || r.every < 60) return { error: 'interval must be at least one minute' };
      return { rule: { kind: 'dca', sym: S, amount: r.amount, every: Math.round(r.every) } };
    default:
      return { error: `unknown rule kind "${r.kind}"` };
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpret } from '../src/llm.js';

// Fake client: returns whatever parsed_output we hand it, records the request.
const fake = (parsed_output, stop_reason = 'end_turn') => {
  const calls = [];
  return { calls, messages: { parse: async (req) => { calls.push(req); return { stop_reason, parsed_output }; } } };
};
const ctx = (client) => ({ client, symbols: ['NVDA', 'SPY'], prices: { NVDA: 186.4, SPY: 589.4 }, perOrderMax: 75, dailyBuyLimit: 150, usdg: 300 });
const R = (o) => ({ kind: 'dip', sym: 'NVDA', amount: null, pct: null, share: null, every_seconds: null, repeat: false, ...o });

test('valid Claude rule passes validation and keeps the reply', async () => {
  const c = fake({ action: 'rule', rule: R({ amount: 25, pct: 3, repeat: true }), reply: 'Siap, tiap NVDA turun 3% aku beli $25.' });
  const out = await interpret('serok NVDA dikit-dikit kalau anjlok', ctx(c));
  assert.deepEqual(out.rule, { kind: 'dip', sym: 'NVDA', amount: 25, pct: 3, repeat: true });
  assert.match(out.reply, /Siap/);
  const req = c.calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.match(req.messages[0].content, /NVDA 186\.40/);
});

test('Claude output that breaks the rules is rejected by validateRule', async () => {
  const offScript = await interpret('buy tesla dips', ctx(fake({ action: 'rule', rule: R({ sym: 'TSLA', amount: 25, pct: 3 }), reply: 'ok' })));
  assert.equal(offScript.action, 'reject');
  assert.match(offScript.error, /isn't one of/);
  const tooFast = await interpret('dca spy every second', ctx(fake({ action: 'rule', rule: R({ kind: 'dca', sym: 'SPY', amount: 5, every_seconds: 1 }), reply: 'ok' })));
  assert.match(tooFast.error, /minute/);
});

test('clarify, reject and refusal pass through without a rule', async () => {
  assert.deepEqual(await interpret('buy some', ctx(fake({ action: 'clarify', rule: null, reply: 'How much per buy?' }))), { action: 'clarify', reply: 'How much per buy?' });
  assert.equal((await interpret('withdraw to my friend', ctx(fake({ action: 'reject', rule: null, reply: 'No.' })))).action, 'reject');
  assert.equal((await interpret('x', ctx(fake(null, 'refusal')))).action, 'reject');
});

test('API failure returns null so the caller falls back', async () => {
  const broken = { messages: { parse: async () => { throw new Error('network down'); } } };
  assert.equal(await interpret('x', ctx(broken)), null);
});

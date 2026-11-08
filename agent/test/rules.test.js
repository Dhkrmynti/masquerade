import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, evaluate, afterFill, arm, sizeBuy } from '../src/rules.js';

const SYMS = ['NVDA', 'AAPL', 'SPY'];

test('parses dip, take-profit and DCA in English', () => {
  assert.deepEqual(parseRule('buy $50 NVDA if it drops 2%', SYMS).rule, { kind: 'dip', sym: 'NVDA', amount: 50, pct: 2, repeat: false });
  assert.deepEqual(parseRule('Buy 40 nvda when it dips 1.5% every time', SYMS).rule, { kind: 'dip', sym: 'NVDA', amount: 40, pct: 1.5, repeat: true });
  assert.deepEqual(parseRule('sell half NVDA if it rises 5%', SYMS).rule, { kind: 'rise', sym: 'NVDA', share: 50, pct: 5, repeat: false });
  assert.deepEqual(parseRule('sell 30% of AAPL when it climbs 4%', SYMS).rule, { kind: 'rise', sym: 'AAPL', share: 30, pct: 4, repeat: false });
  assert.deepEqual(parseRule('buy $25 SPY every 2 hours', SYMS).rule, { kind: 'dca', sym: 'SPY', amount: 25, every: 7200 });
});

test('parses simple Indonesian', () => {
  assert.equal(parseRule('beli $50 NVDA kalau turun 2%', SYMS).rule.kind, 'dip');
  assert.equal(parseRule('jual setengah NVDA kalau naik 5%', SYMS).rule.share, 50);
  assert.equal(parseRule('beli $25 SPY tiap 1 jam', SYMS).rule.every, 3600);
});

test('rejects stocks off the script and nonsense', () => {
  assert.match(parseRule('buy $50 TSLA if it drops 2%', SYMS).error, /isn't one of/);
  assert.match(parseRule('buy $5 SPY every 10 seconds', SYMS).error, /unknown interval|at least/);
  assert.match(parseRule('make me rich', SYMS).error, /not a rule/);
  assert.match(parseRule('sell 150% NVDA if it rises 5%', SYMS).error, /between/);
});

test('dip fires at the threshold, once unless repeating', () => {
  let r = arm(parseRule('buy $50 NVDA if it drops 2%', SYMS).rule, 100, 0);
  assert.equal(evaluate(r, 98.5, 0), null);
  assert.deepEqual(evaluate(r, 98, 0), { side: 'buy', sym: 'NVDA', amount: 50 });
  r = afterFill(r, 98, 0);
  assert.equal(evaluate(r, 50, 0), null, 'one-shot rule is done');

  let rep = arm(parseRule('buy $50 NVDA if it drops 2% every time', SYMS).rule, 100, 0);
  rep = afterFill(rep, 98, 0);
  assert.equal(rep.ref, 98, 'ladders from the fill price');
  assert.equal(evaluate(rep, 97, 0), null);
  assert.ok(evaluate(rep, 96, 0));
});

test('take-profit and DCA timing', () => {
  const tp = arm(parseRule('sell half NVDA if it rises 5%', SYMS).rule, 100, 0);
  assert.equal(evaluate(tp, 104.9, 0), null);
  assert.deepEqual(evaluate(tp, 105, 0), { side: 'sell', sym: 'NVDA', share: 50 });

  let d = arm(parseRule('buy $25 SPY every 1 hour', SYMS).rule, 500, 1000);
  assert.ok(evaluate(d, 500, 1000), 'first DCA buy is immediate');
  d = afterFill(d, 500, 1000);
  assert.equal(evaluate(d, 500, 4599), null);
  assert.ok(evaluate(d, 500, 4600));
});

test('sizeBuy trims to the tightest vault limit or skips', () => {
  const lim = { perOrderMax: 75, room: 150, usdg: 300 };
  assert.deepEqual(sizeBuy(50, lim), { amount: 50, note: '' });
  assert.equal(sizeBuy(500, lim).amount, 75);
  assert.equal(sizeBuy(60, { ...lim, room: 40 }).amount, 40);
  assert.equal(sizeBuy(60, { ...lim, usdg: 20 }).amount, 20);
  assert.equal(sizeBuy(60, { ...lim, room: 0 }).skip, 'daily buy limit reached');
  assert.equal(sizeBuy(60, { ...lim, usdg: 0.2 }).skip, 'purse is empty');
});

import { validateRule } from '../src/rules.js';

test('validateRule accepts well-formed rules and rejects bad ones', () => {
  assert.deepEqual(validateRule({ kind: 'dip', sym: 'nvda', amount: 25, pct: 3, repeat: true }, SYMS).rule, { kind: 'dip', sym: 'NVDA', amount: 25, pct: 3, repeat: true });
  assert.deepEqual(validateRule({ kind: 'dca', sym: 'SPY', amount: 10, every: 3600 }, SYMS).rule, { kind: 'dca', sym: 'SPY', amount: 10, every: 3600 });
  assert.match(validateRule({ kind: 'dip', sym: 'TSLA', amount: 25, pct: 3 }, SYMS).error, /isn't one of/);
  assert.match(validateRule({ kind: 'dip', sym: 'NVDA', amount: -5, pct: 3 }, SYMS).error, /positive/);
  assert.match(validateRule({ kind: 'rise', sym: 'NVDA', share: 0, pct: 5 }, SYMS).error, /between/);
  assert.match(validateRule({ kind: 'dca', sym: 'SPY', amount: 10, every: 5 }, SYMS).error, /minute/);
  assert.match(validateRule({ kind: 'yolo', sym: 'SPY' }, SYMS).error, /unknown/);
});

# Masquerade envoy agent

Watches prices and fires an envoy's rules by calling `EnvoyVault.swap()`.
The vault is the real guard; the agent only tries to be a good agent.

```
npm start          # runner + API on http://127.0.0.1:5199 (needs anvil + deployed contracts)
npm test           # rule engine unit tests
npm run e2e        # full flow on anvil: deploy envoy, add rules, move prices, check fills/refusals
node scripts/move-price.js NVDA -3   # local helper: move a mock price
```

## Rules it understands (English and simple Indonesian)

| Example | Kind |
|---|---|
| `buy $50 NVDA if it drops 2%` (add `every time` to repeat, laddering from each fill) | dip buy |
| `sell half NVDA if it rises 5%` (`all`, `half`, `30%`) | take profit |
| `buy $25 SPY every 1 hour` | DCA |
| `beli $50 NVDA kalau turun 2%` · `jual setengah NVDA kalau naik 5%` · `beli $25 SPY tiap 1 jam` | same |

## How it behaves

- **Prices** come from the same oracle the vault checks against, so a rule never fires on a price the vault would reject.
- **Sizing**: buys are trimmed to the tightest vault limit (per-order cap, today's buy room, purse) before sending, so no gas is wasted on certain reverts.
- **One transaction at a time.** Each one is simulated first; the contract's own error name is logged on a refusal; the rule then backs off for 60s.
- **State** (rules, refs, next DCA time, log) is written atomically to `state.json`. A new chain (different genesis hash) resets it.
- **Stops by itself** when the vault is off duty (curfew or recall), or when the owner rotates the agent key away from it.

## Not production-ready yet

- The API has **no auth**. Production must require a signature from the vault owner before accepting rules.
- Locally it signs with anvil's unlocked dev account #1. On any other chain it refuses to start unless `AGENT_PRIVATE_KEY` is set.
- The rule parser is regex-based. A Claude-based parser can sit in front of it, but its output should still go through `parseRule`-style validation.

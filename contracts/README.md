# Masquerade envoy contracts

Purse-capped wallets for trading agents on Robinhood Chain.

```
forge test        # 33 tests, incl. 2 fuzz suites (512 runs each)
```

## Contracts

| File | Role |
|---|---|
| `src/EnvoyFactory.sol` | Deploys one `EnvoyVault` clone per envoy and funds it in the same tx. Router, base token (USDG), oracle and allowed fee tiers are fixed per factory. Indexes envoys per owner. |
| `src/EnvoyVault.sol` | The envoy's wallet. The agent key can only `swap`; the owner can `recall`, `sweep`, `setAgent`, `setCurfew` and `setLimits`. |
| `src/oracle/UniswapV3TwapOracle.sol` | Fair price from the TWAP of the same Uniswap V3 pool the envoy trades in. |
| `src/oracle/TickMath.sol` | `getSqrtRatioAtTick`, checked against Uniswap V3's reference values. |

## What bounds the agent

| Limit | Enforced by |
|---|---|
| Can only touch the vault's balance (the purse) | No transfer function exists for the agent; swap output's recipient is hard-coded to the vault |
| Only the owner's stock list + USDG | `onScript` check on both legs |
| Largest single buy | `perOrderMax` |
| Total buys per 24h | `dailyBuyLimit` (0 = off) |
| Worst acceptable fill | `max(agent minOut, TWAP × (1 − maxSlippageBps))`, at most 10% |
| Only liquid pools | fee tier must be on the factory's allow list |
| Time | `curfew`; `recall` stops it for good |
| Lying or misrouting router | Output is measured from the vault's own balance; approval is reset to 0 after each swap |

## Threat model and known limits

- **A compromised agent key** can still churn trades within the limits and lose up to `maxSlippageBps` per trade, capped by the daily buy limit and the purse. It cannot withdraw. The owner should `setAgent` or `recall`.
- **TWAP manipulation.** Moving a 30-minute TWAP takes sustained capital across many blocks. Thin pools are still weaker; keep the fee-tier list to pools with real liquidity.
- **Oracle downtime** (pool missing or too little history) makes swaps revert. This fails closed: the vault won't trade blind.
- **The daily window is fixed, not rolling.** A burst of up to 2× the limit is possible across a window boundary.
- **Router and oracle are trusted per factory.** Deploy a factory only with the canonical Uniswap router and factory addresses for the chain.
- **Not audited. Not deployed.** The Uniswap V3 router and factory addresses on Robinhood Chain still need confirming.

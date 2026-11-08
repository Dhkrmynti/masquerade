// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Fair-value quote used by EnvoyVault to bound slippage.
/// Must revert rather than return a guess when it has no reliable price.
interface IPriceOracle {
    function quote(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        external
        view
        returns (uint256 amountOut);
}

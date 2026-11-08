// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {TickMath} from "./TickMath.sol";

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IUniswapV3Pool {
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @title UniswapV3TwapOracle
/// @notice Time-weighted average price from the same pool the envoy trades in.
/// A single-block price push can't move a TWAP much, so an agent (or an MEV
/// bot sandwiching it) can't drag the fair value toward a bad fill.
/// Reverts if the pool doesn't exist or lacks history for the window.
contract UniswapV3TwapOracle is IPriceOracle {
    IUniswapV3Factory public immutable v3Factory;
    uint32 public immutable window;

    error NoPool();

    constructor(address v3Factory_, uint32 window_) {
        require(v3Factory_ != address(0) && window_ >= 60, "config");
        v3Factory = IUniswapV3Factory(v3Factory_);
        window = window_;
    }

    function quote(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn) external view returns (uint256) {
        address pool = v3Factory.getPool(tokenIn, tokenOut, fee);
        if (pool == address(0)) revert NoPool();
        return quoteAtTick(meanTick(pool), amountIn, tokenIn, tokenOut);
    }

    function meanTick(address pool) public view returns (int24 tick) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cum,) = IUniswapV3Pool(pool).observe(ago); // reverts "OLD" if history is too short
        int56 delta = cum[1] - cum[0];
        int56 w = int56(uint56(window));
        tick = int24(delta / w);
        if (delta < 0 && delta % w != 0) tick--; // round toward negative infinity
    }

    /// @dev OracleLibrary.getQuoteAtTick, using OZ Math.mulDiv for 512-bit precision.
    function quoteAtTick(int24 tick, uint256 amountIn, address tokenIn, address tokenOut)
        public
        pure
        returns (uint256)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            return tokenIn < tokenOut
                ? Math.mulDiv(ratioX192, amountIn, 1 << 192)
                : Math.mulDiv(1 << 192, amountIn, ratioX192);
        }
        uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
        return tokenIn < tokenOut
            ? Math.mulDiv(ratioX128, amountIn, 1 << 128)
            : Math.mulDiv(1 << 128, amountIn, ratioX128);
    }
}

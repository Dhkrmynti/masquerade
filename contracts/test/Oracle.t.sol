// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {UniswapV3TwapOracle} from "../src/oracle/UniswapV3TwapOracle.sol";
import {TickMath} from "../src/oracle/TickMath.sol";
import {MockPool, MockV3Factory} from "./Mocks.sol";

contract TickHarness {
    function at(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtRatioAtTick(t);
    }
}

contract OracleTest is Test {
    TickHarness th;
    MockV3Factory v3;
    MockPool pool;
    UniswapV3TwapOracle oracle;
    address a = address(0x1000); // a < b
    address b = address(0x2000);
    uint32 constant W = 1800;

    function setUp() public {
        th = new TickHarness();
        v3 = new MockV3Factory();
        pool = new MockPool();
        v3.setPool(a, b, 3000, address(pool));
        oracle = new UniswapV3TwapOracle(address(v3), W);
    }

    // Reference values from Uniswap V3's own TickMath tests.
    function test_tickMathKnownValues() public view {
        assertEq(th.at(0), 79228162514264337593543950336);
        assertEq(th.at(-887272), 4295128739);
        assertEq(th.at(887272), 1461446703485210103287273052203988822378723970342);
        assertEq(th.at(1), 79232123823359799118286999568);
        assertEq(th.at(-1), 79224201403219477170569942574);
    }

    function test_tickMathOutOfRangeReverts() public {
        vm.expectRevert(TickMath.TickOutOfRange.selector);
        th.at(887273);
    }

    function test_quoteAtTickZeroIsOneToOne() public view {
        assertEq(oracle.quoteAtTick(0, 1e18, a, b), 1e18);
        assertEq(oracle.quoteAtTick(0, 1e18, b, a), 1e18);
    }

    function test_quoteAtTickMatchesPowerOf1_0001() public view {
        // 1.0001^6932 ~= 2.0000; token1 per token0
        uint256 q = oracle.quoteAtTick(6932, 1e18, a, b);
        assertApproxEqRel(q, 2e18, 1e14); // within 0.01%
        uint256 inv = oracle.quoteAtTick(6932, 1e18, b, a);
        assertApproxEqRel(inv, 5e17, 1e14);
    }

    function test_twapUsesMeanTickAndRoundsDown() public {
        pool.set(0, int56(int256(6932) * int256(uint256(W))));
        assertEq(oracle.meanTick(address(pool)), 6932);
        pool.set(0, -int56(int256(6932) * int256(uint256(W))) - 1); // negative with remainder
        assertEq(oracle.meanTick(address(pool)), -6933);
    }

    function test_quoteThroughPool() public {
        pool.set(100, 100 + int56(int256(6932) * int256(uint256(W))));
        assertApproxEqRel(oracle.quote(a, b, 3000, 1e18), 2e18, 1e14);
    }

    function test_missingPoolOrShortHistoryReverts() public {
        vm.expectRevert(UniswapV3TwapOracle.NoPool.selector);
        oracle.quote(a, b, 500, 1e18);
        pool.setTooYoung(true);
        vm.expectRevert(bytes("OLD"));
        oracle.quote(a, b, 3000, 1e18);
    }

    function testFuzz_quoteIsMonotonicInTick(int24 t) public view {
        t = int24(bound(t, -400_000, 400_000));
        uint256 lo = oracle.quoteAtTick(t, 1e18, a, b);
        uint256 hi = oracle.quoteAtTick(t + 100, 1e18, a, b);
        assertGe(hi, lo);
    }
}

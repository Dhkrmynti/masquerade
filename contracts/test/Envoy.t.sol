// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {EnvoyFactory} from "../src/EnvoyFactory.sol";
import {EnvoyVault} from "../src/EnvoyVault.sol";
import {MockToken, MockRouter, MockOracle} from "./Mocks.sol";

contract EnvoyTest is Test {
    MockToken usdg;
    MockToken nvda;
    MockToken msft;
    MockToken tsla; // not on the script
    MockRouter router;
    MockOracle oracle;
    EnvoyFactory factory;
    EnvoyVault env;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address thief = makeAddr("thief");

    uint256 constant PURSE = 300e18;
    uint128 constant CAP = 75e18;
    uint16 constant SLIP = 100; // 1%

    function setUp() public {
        vm.warp(1_700_000_000);
        usdg = new MockToken("USDG", "USDG");
        nvda = new MockToken("NVDA", "NVDA");
        msft = new MockToken("MSFT", "MSFT");
        tsla = new MockToken("TSLA", "TSLA");
        router = new MockRouter();
        oracle = new MockOracle();
        router.setThief(thief);
        // 1 USDG -> 1/200 NVDA, 1 NVDA -> 200 USDG, 1 USDG -> 1/400 MSFT, 1 NVDA -> 0.5 MSFT
        _price(address(usdg), address(nvda), 5e15);
        _price(address(nvda), address(usdg), 200e18);
        _price(address(usdg), address(msft), 25e14);
        _price(address(nvda), address(msft), 5e17);
        _price(address(usdg), address(tsla), 4e15);

        uint24[] memory fees = new uint24[](3);
        fees[0] = 500;
        fees[1] = 3000;
        fees[2] = 10000;
        factory = new EnvoyFactory(address(router), address(usdg), address(oracle), fees);

        usdg.mint(owner, 1_000e18);
        vm.prank(owner);
        usdg.approve(address(factory), type(uint256).max);
        env = _create(bytes32("contessa"), 0);
    }

    function _price(address a, address b, uint256 p) internal {
        router.setPrice(a, b, p);
        oracle.setPrice(a, b, p);
    }

    function _script() internal view returns (address[] memory t) {
        t = new address[](2);
        t[0] = address(nvda);
        t[1] = address(msft);
    }

    function _params(bytes32 salt, uint128 daily) internal view returns (EnvoyFactory.Params memory p) {
        p = EnvoyFactory.Params({
            agent: agent,
            tokens: _script(),
            perOrderMax: CAP,
            dailyBuyLimit: daily,
            maxSlippageBps: SLIP,
            curfew: uint64(block.timestamp + 8 hours),
            purse: PURSE,
            salt: salt
        });
    }

    function _create(bytes32 salt, uint128 daily) internal returns (EnvoyVault) {
        vm.prank(owner);
        return EnvoyVault(factory.createEnvoy(_params(salt, daily)));
    }

    // ------------------------------------------------------------ creation

    function test_createFundsPurseAndIndexesEnvoy() public view {
        assertEq(usdg.balanceOf(address(env)), PURSE);
        assertEq(address(env), factory.predict(owner, bytes32("contessa")));
        assertEq(factory.envoysOf(owner)[0], address(env));
        assertEq(env.owner(), owner);
        assertEq(env.router(), address(router));
        assertEq(address(env.oracle()), address(oracle));
        assertTrue(env.onDuty());
    }

    function test_implementationIsLockedAndCloneCannotReinit() public {
        EnvoyVault impl = EnvoyVault(factory.implementation());
        vm.expectRevert(EnvoyVault.AlreadyInitialized.selector);
        impl.initialize(owner, agent, _script(), CAP, 0, SLIP, uint64(block.timestamp + 1));
        vm.expectRevert(EnvoyVault.AlreadyInitialized.selector);
        env.initialize(thief, thief, _script(), CAP, 0, SLIP, uint64(block.timestamp + 1));
    }

    function test_badConfigReverts() public {
        EnvoyFactory.Params memory p = _params(bytes32("x1"), 0);
        p.maxSlippageBps = 1_001; // above 10%
        _expectBad(p);
        p = _params(bytes32("x2"), 50e18); // daily limit below one order
        _expectBad(p);
        p = _params(bytes32("x3"), 0);
        p.perOrderMax = 0;
        _expectBad(p);
        p = _params(bytes32("x4"), 0);
        p.agent = owner;
        _expectBad(p);
        p = _params(bytes32("x5"), 0);
        p.curfew = uint64(block.timestamp);
        _expectBad(p);
        p = _params(bytes32("x6"), 0);
        p.tokens = new address[](2);
        p.tokens[0] = address(nvda);
        p.tokens[1] = address(nvda);
        _expectBad(p);
        p = _params(bytes32("x7"), 0);
        p.tokens = new address[](1);
        p.tokens[0] = address(usdg);
        _expectBad(p);
    }

    function _expectBad(EnvoyFactory.Params memory p) internal {
        vm.prank(owner);
        vm.expectRevert(EnvoyVault.BadConfig.selector);
        factory.createEnvoy(p);
    }

    // ------------------------------------------------------------ agent swaps

    function test_agentBuysWithinCap_outputStaysInVault() public {
        vm.prank(agent);
        uint256 got = env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        assertEq(got, 375e15);
        assertEq(nvda.balanceOf(address(env)), 375e15);
        assertEq(usdg.balanceOf(address(env)), PURSE - 75e18);
        assertEq(usdg.allowance(address(env), address(router)), 0, "approval reset");
    }

    function test_agentCanSellAndRotate() public {
        vm.startPrank(agent);
        env.swap(address(usdg), address(nvda), 3000, 50e18, 0);
        env.swap(address(nvda), address(msft), 3000, 1e17, 0);
        env.swap(address(nvda), address(usdg), 3000, 15e16, 0); // sells are not capped
        vm.stopPrank();
        assertEq(nvda.balanceOf(address(env)), 0);
        assertEq(msft.balanceOf(address(env)), 5e16);
    }

    function test_overOrderCapReverts() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.OverOrderCap.selector, 76e18, CAP));
        env.swap(address(usdg), address(nvda), 3000, 76e18, 0);
    }

    function test_cannotSpendMoreThanPurse() public {
        vm.startPrank(agent);
        for (uint256 i; i < 4; ++i) env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        vm.expectRevert();
        env.swap(address(usdg), address(nvda), 3000, 1e18, 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(owner), 1_000e18 - PURSE, "owner wallet untouched");
    }

    function test_offScriptAndSameTokenRevert() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.NotOnScript.selector, address(tsla)));
        env.swap(address(usdg), address(tsla), 3000, 10e18, 0);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.NotOnScript.selector, address(tsla)));
        env.swap(address(tsla), address(usdg), 3000, 10e18, 0);
        vm.expectRevert(EnvoyVault.SameToken.selector);
        env.swap(address(usdg), address(usdg), 3000, 10e18, 0);
        vm.stopPrank();
    }

    function test_onlyAgentCanSwap() public {
        vm.prank(owner);
        vm.expectRevert(EnvoyVault.NotAgent.selector);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
        vm.prank(thief);
        vm.expectRevert(EnvoyVault.NotAgent.selector);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
    }

    function test_curfewStopsAgent_ownerCanExtend() public {
        vm.warp(block.timestamp + 8 hours);
        vm.prank(agent);
        vm.expectRevert(EnvoyVault.OffDuty.selector);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
        vm.prank(owner);
        env.setCurfew(uint64(block.timestamp + 1 hours));
        vm.prank(agent);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
    }

    // ------------------------------------------------------------ new guards

    function test_feeTierMustBeAllowed() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.FeeNotAllowed.selector, uint24(100)));
        env.swap(address(usdg), address(nvda), 100, 10e18, 0);
    }

    /// The agent passes minOut = 0 and the pool is 5% worse than TWAP:
    /// the vault's oracle floor (1%) still refuses the fill.
    function test_oracleFloorBlocksBadFillEvenWithZeroMinOut() public {
        router.setPrice(address(usdg), address(nvda), 475e13); // 5% below fair
        vm.prank(agent);
        vm.expectRevert(bytes("slippage"));
        env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
    }

    function test_fillWithinSlippageIsAccepted() public {
        router.setPrice(address(usdg), address(nvda), 4955e12); // 0.9% below fair
        vm.prank(agent);
        uint256 got = env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        (uint256 floor,) = env.floorOut(address(usdg), address(nvda), 3000, 75e18);
        assertGe(got, floor);
    }

    function test_agentMinOutStricterThanFloorIsUsed() public {
        vm.prank(agent);
        vm.expectRevert(bytes("slippage"));
        env.swap(address(usdg), address(nvda), 3000, 75e18, 376e15); // asks for more than fair
    }

    function test_oracleWithoutPriceBlocksSwap() public {
        oracle.setPrice(address(usdg), address(msft), 0);
        vm.prank(agent);
        vm.expectRevert(bytes("no price"));
        env.swap(address(usdg), address(msft), 3000, 10e18, 0);
    }

    function test_dailyBuyLimitAndReset() public {
        EnvoyVault d = _create(bytes32("daily"), 150e18);
        vm.startPrank(agent);
        d.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        d.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        assertEq(d.buyRoomToday(), 0);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.OverDailyLimit.selector, 151e18, 150e18));
        d.swap(address(usdg), address(nvda), 3000, 1e18, 0);
        // selling is still allowed when the buy budget is used up
        d.swap(address(nvda), address(usdg), 3000, 1e17, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        assertEq(d.buyRoomToday(), 150e18);
        vm.prank(owner);
        d.setCurfew(uint64(block.timestamp + 1 hours));
        vm.prank(agent);
        d.swap(address(usdg), address(nvda), 3000, 75e18, 0);
    }

    function test_ownerCanTightenLimits() public {
        vm.prank(owner);
        env.setLimits(20e18, 40e18, 50);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.OverOrderCap.selector, 21e18, 20e18));
        env.swap(address(usdg), address(nvda), 3000, 21e18, 0);
        vm.prank(owner);
        vm.expectRevert(EnvoyVault.BadConfig.selector);
        env.setLimits(20e18, 0, 2_000);
    }

    // ------------------------------------------------------------ hostile router

    function test_shortChangingRouterIsCaught() public {
        router.setMode(MockRouter.Mode.ShortChange);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.InsufficientOutput.selector, 1875e14, 37125e13));
        env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
    }

    function test_misroutingRouterIsCaught() public {
        router.setMode(MockRouter.Mode.Misroute);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(EnvoyVault.InsufficientOutput.selector, 0, 37125e13));
        env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        assertEq(nvda.balanceOf(thief), 0, "revert undid the theft");
    }

    function test_routerCallbackIntoVaultIsRejected() public {
        router.setMode(MockRouter.Mode.Reenter);
        router.setReenter(address(env), abi.encodeCall(EnvoyVault.recall, ()));
        vm.prank(agent);
        vm.expectRevert(); // router is neither owner nor agent, so its callback reverts
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
    }

    // ------------------------------------------------------------ owner controls

    function test_recallSendsEverythingHomeAndStopsAgent() public {
        vm.prank(agent);
        env.swap(address(usdg), address(nvda), 3000, 75e18, 0);
        vm.prank(owner);
        env.recall();
        assertEq(usdg.balanceOf(owner), 1_000e18 - 75e18);
        assertEq(nvda.balanceOf(owner), 375e15);
        assertFalse(env.onDuty());
        vm.prank(agent);
        vm.expectRevert(EnvoyVault.OffDuty.selector);
        env.swap(address(nvda), address(usdg), 3000, 1, 0);
    }

    function test_onlyOwnerControls() public {
        vm.startPrank(agent);
        vm.expectRevert(EnvoyVault.NotOwner.selector);
        env.recall();
        vm.expectRevert(EnvoyVault.NotOwner.selector);
        env.sweep(address(usdg));
        vm.expectRevert(EnvoyVault.NotOwner.selector);
        env.setAgent(thief);
        vm.expectRevert(EnvoyVault.NotOwner.selector);
        env.setCurfew(type(uint64).max);
        vm.expectRevert(EnvoyVault.NotOwner.selector);
        env.setLimits(1e30, 0, 1_000);
        vm.stopPrank();
    }

    function test_setAgentRotatesKey() public {
        address fresh = makeAddr("fresh");
        vm.prank(owner);
        env.setAgent(fresh);
        vm.prank(agent);
        vm.expectRevert(EnvoyVault.NotAgent.selector);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
        vm.prank(fresh);
        env.swap(address(usdg), address(nvda), 3000, 10e18, 0);
    }

    function test_sweepRecoversStrayTokens() public {
        tsla.mint(address(env), 5e18);
        vm.prank(owner);
        env.sweep(address(tsla));
        assertEq(tsla.balanceOf(owner), 5e18);
    }

    // ------------------------------------------------------------ fuzz

    /// Whatever the agent tries, value only moves vault <-> router, never to a
    /// third party; a buy never exceeds the cap; and any fill that goes
    /// through is at least the oracle floor.
    function testFuzz_agentCannotLeakOverspendOrTakeBadFills(
        uint256 amountIn,
        uint256 minOut,
        uint8 pairSeed,
        uint16 poolSkewBps
    ) public {
        address[3] memory ts = [address(usdg), address(nvda), address(msft)];
        address tIn = ts[pairSeed % 3];
        address tOut = ts[(pairSeed / 3) % 3];
        amountIn = bound(amountIn, 0, 1_000e18);
        poolSkewBps = uint16(bound(poolSkewBps, 0, 3_000));
        // make the pool up to 30% worse than the oracle
        uint256 fairP = oracle.price(tIn, tOut);
        if (fairP != 0) router.setPrice(tIn, tOut, fairP * (10_000 - poolSkewBps) / 10_000);

        uint256 baseBefore = usdg.balanceOf(address(env));
        vm.prank(agent);
        try env.swap(tIn, tOut, 3000, amountIn, minOut) returns (uint256 got) {
            if (tIn == address(usdg)) assertLe(baseBefore - usdg.balanceOf(address(env)), CAP);
            assertGe(got, amountIn * fairP / 1e18 * (10_000 - SLIP) / 10_000, "fill below floor");
        } catch {}

        assertEq(usdg.balanceOf(thief) + nvda.balanceOf(thief) + msft.balanceOf(thief), 0);
        assertEq(usdg.balanceOf(agent) + nvda.balanceOf(agent), 0);
        assertEq(usdg.balanceOf(owner), 1_000e18 - PURSE, "owner wallet never touched by agent");
        assertEq(usdg.allowance(address(env), address(router)), 0);
    }
}

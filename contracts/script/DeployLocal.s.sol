// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {EnvoyFactory} from "../src/EnvoyFactory.sol";
import {MockToken, MockRouter, MockOracle} from "../test/Mocks.sol";

/// Local anvil only: mock USDG + stock tokens, a fixed-price router and an
/// oracle that agrees with it, then the real EnvoyFactory on top.
contract DeployLocal is Script {
    string[5] syms = ["NVDA", "AAPL", "MSFT", "TSLA", "SPY"];
    uint256[5] cents = [18640, 23180, 42260, 24810, 58940];

    function run() external {
        address owner = vm.envAddress("OWNER");
        vm.startBroadcast();
        MockToken usdg = new MockToken("USD Global", "USDG");
        MockRouter router = new MockRouter();
        MockOracle oracle = new MockOracle();
        uint24[] memory fees = new uint24[](3);
        fees[0] = 500;
        fees[1] = 3000;
        fees[2] = 10000;
        EnvoyFactory factory = new EnvoyFactory(address(router), address(usdg), address(oracle), fees);
        usdg.mint(owner, 5_000e18);

        string memory json = "deploy";
        vm.serializeAddress(json, "USDG", address(usdg));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "oracle", address(oracle));
        for (uint256 i; i < syms.length; ++i) {
            MockToken t = new MockToken(syms[i], syms[i]);
            uint256 inP = 1e18 * 100 / cents[i]; // stock per 1 USDG
            uint256 outP = cents[i] * 1e16; // USDG per 1 stock
            router.setPrice(address(usdg), address(t), inP);
            router.setPrice(address(t), address(usdg), outP);
            oracle.setPrice(address(usdg), address(t), inP);
            oracle.setPrice(address(t), address(usdg), outP);
            vm.serializeAddress(json, syms[i], address(t));
        }
        string memory out = vm.serializeAddress(json, "factory", address(factory));
        vm.stopBroadcast();
        vm.writeJson(out, "../deployments/local.json");
        console2.log("factory", address(factory));
    }
}

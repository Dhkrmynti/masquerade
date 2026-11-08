// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EnvoyVault} from "./EnvoyVault.sol";

/// @title EnvoyFactory
/// @notice Deploys EnvoyVault clones, one per envoy, and funds the purse in
/// the same transaction. Router, base token, price oracle and fee tiers are
/// fixed per factory, so an owner can't be tricked into pointing an envoy at
/// a malicious router, a thin junk pool, or a fake price feed.
contract EnvoyFactory {
    using SafeERC20 for IERC20;

    address public immutable implementation;
    address public immutable router;
    address public immutable base;
    address public immutable oracle;

    mapping(uint24 => bool) public feeAllowed;
    mapping(address => address[]) private _envoysOf;

    struct Params {
        address agent;
        address[] tokens;
        uint128 perOrderMax;
        uint128 dailyBuyLimit; // 0 = no daily limit
        uint16 maxSlippageBps;
        uint64 curfew;
        uint256 purse;
        bytes32 salt;
    }

    event EnvoyCreated(address indexed owner, address indexed envoy, address indexed agent, uint256 purse);

    constructor(address router_, address base_, address oracle_, uint24[] memory fees) {
        require(router_ != address(0) && base_ != address(0) && oracle_ != address(0) && fees.length > 0, "config");
        router = router_;
        base = base_;
        oracle = oracle_;
        for (uint256 i; i < fees.length; ++i) feeAllowed[fees[i]] = true;
        implementation = address(new EnvoyVault());
    }

    function createEnvoy(Params calldata p) external returns (address envoy) {
        envoy = Clones.cloneDeterministic(implementation, _salt(msg.sender, p.salt));
        EnvoyVault(envoy).initialize(
            msg.sender, p.agent, p.tokens, p.perOrderMax, p.dailyBuyLimit, p.maxSlippageBps, p.curfew
        );
        _envoysOf[msg.sender].push(envoy);
        if (p.purse > 0) IERC20(base).safeTransferFrom(msg.sender, envoy, p.purse);
        emit EnvoyCreated(msg.sender, envoy, p.agent, p.purse);
    }

    function envoysOf(address owner) external view returns (address[] memory) {
        return _envoysOf[owner];
    }

    function predict(address owner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(owner, salt));
    }

    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}

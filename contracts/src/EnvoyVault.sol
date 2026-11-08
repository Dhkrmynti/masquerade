// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapRouter} from "./ISwapRouter.sol";
import {IPriceOracle} from "./oracle/IPriceOracle.sol";

interface IEnvoyFactoryView {
    function router() external view returns (address);
    function base() external view returns (address);
    function oracle() external view returns (address);
    function feeAllowed(uint24 fee) external view returns (bool);
}

/// @title EnvoyVault
/// @notice A purse-capped wallet for one trading agent ("envoy").
///
/// What the agent can do: swap between the base token and the owner's list of
/// stock tokens, through the factory's router and fee tiers, before the
/// curfew. Every output lands back in this vault.
///
/// What bounds it:
///  - purse: the vault balance is all it can ever touch
///  - perOrderMax: largest single buy, in base units
///  - dailyBuyLimit: total buys per 24h window (0 = no daily limit)
///  - maxSlippageBps: every fill must be within this of the oracle's TWAP
///    price, whatever minOut the agent passes
///  - curfew / recall: owner can stop it and take everything home
///
/// Worst case for the owner is losing what is in the vault, and the oracle
/// floor makes even that slow: a fill can't be worse than TWAP minus slippage.
contract EnvoyVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TOKENS = 20;
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    uint256 private constant BPS = 10_000;
    uint256 private constant WINDOW = 1 days;

    // slot 0
    address public owner;
    uint64 public curfew;
    uint16 public maxSlippageBps;
    bool public recalled;
    bool private _initialized;
    // slot 1
    address public agent;
    uint64 public windowStart;
    // slot 2
    uint128 public perOrderMax;
    uint128 public dailyBuyLimit;
    // slot 3
    uint128 public spentInWindow;
    // slots 4-7
    IEnvoyFactoryView public factory;
    address public router;
    address public base;
    IPriceOracle public oracle;

    mapping(address => bool) public onScript;
    address[] private _tokens;

    event Initialized(address indexed owner, address indexed agent, uint64 curfew);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint24 fee, uint256 amountIn, uint256 amountOut, uint256 fairOut);
    event LimitsChanged(uint256 perOrderMax, uint256 dailyBuyLimit, uint16 maxSlippageBps);
    event AgentChanged(address indexed oldAgent, address indexed newAgent);
    event CurfewChanged(uint64 curfew);
    event Recalled(address indexed to);
    event Swept(address indexed token, uint256 amount);

    error AlreadyInitialized();
    error NotOwner();
    error NotAgent();
    error OffDuty();
    error NotOnScript(address token);
    error SameToken();
    error FeeNotAllowed(uint24 fee);
    error OverOrderCap(uint256 amountIn, uint256 cap);
    error OverDailyLimit(uint256 wouldSpend, uint256 limit);
    error ZeroFloor();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error BadConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    /// @dev Locks the implementation so only clones can be initialized.
    constructor() {
        _initialized = true;
    }

    /// @notice Called once by the factory that cloned this vault.
    function initialize(
        address owner_,
        address agent_,
        address[] calldata tokens_,
        uint128 perOrderMax_,
        uint128 dailyBuyLimit_,
        uint16 maxSlippageBps_,
        uint64 curfew_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        IEnvoyFactoryView f = IEnvoyFactoryView(msg.sender);
        address base_ = f.base();

        if (
            owner_ == address(0) || agent_ == address(0) || agent_ == owner_ || curfew_ <= block.timestamp
                || tokens_.length == 0 || tokens_.length > MAX_TOKENS
        ) revert BadConfig();
        _checkLimits(perOrderMax_, dailyBuyLimit_, maxSlippageBps_);

        for (uint256 i; i < tokens_.length; ++i) {
            address t = tokens_[i];
            if (t == address(0) || t == base_ || onScript[t]) revert BadConfig();
            onScript[t] = true;
            _tokens.push(t);
        }

        owner = owner_;
        agent = agent_;
        curfew = curfew_;
        perOrderMax = perOrderMax_;
        dailyBuyLimit = dailyBuyLimit_;
        maxSlippageBps = maxSlippageBps_;
        factory = f;
        router = f.router();
        base = base_;
        oracle = IPriceOracle(f.oracle());

        emit Initialized(owner_, agent_, curfew_);
        emit LimitsChanged(perOrderMax_, dailyBuyLimit_, maxSlippageBps_);
    }

    // ------------------------------------------------------------------ views

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function onDuty() public view returns (bool) {
        return !recalled && block.timestamp < curfew;
    }

    /// @notice How much the agent may still buy in the current 24h window.
    function buyRoomToday() external view returns (uint256) {
        if (dailyBuyLimit == 0) return type(uint256).max;
        if (block.timestamp >= uint256(windowStart) + WINDOW) return dailyBuyLimit;
        return dailyBuyLimit - spentInWindow;
    }

    /// @notice The worst fill the vault would accept right now for this swap.
    function floorOut(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn)
        public
        view
        returns (uint256 floor, uint256 fair)
    {
        fair = oracle.quote(tokenIn, tokenOut, fee, amountIn);
        floor = fair * (BPS - maxSlippageBps) / BPS;
    }

    // ------------------------------------------------------------------ agent

    /// @notice Swap inside the vault. Output always comes back here.
    /// @param minOut the agent's own limit; the vault also enforces the oracle
    /// floor and uses whichever is stricter.
    function swap(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 minOut)
        external
        onlyAgent
        nonReentrant
        returns (uint256 got)
    {
        if (!onDuty()) revert OffDuty();
        if (tokenIn == tokenOut) revert SameToken();
        if (tokenIn != base && !onScript[tokenIn]) revert NotOnScript(tokenIn);
        if (tokenOut != base && !onScript[tokenOut]) revert NotOnScript(tokenOut);
        if (!factory.feeAllowed(fee)) revert FeeNotAllowed(fee);
        if (tokenIn == base) _spend(amountIn);

        (uint256 floor, uint256 fair) = floorOut(tokenIn, tokenOut, fee, amountIn);
        uint256 minAccept = minOut > floor ? minOut : floor;
        if (minAccept == 0) revert ZeroFloor();

        uint256 before = IERC20(tokenOut).balanceOf(address(this));

        IERC20(tokenIn).forceApprove(router, amountIn);
        ISwapRouter(router).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minAccept,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(router, 0);

        // Trust our own balance, not the router's return value.
        got = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (got < minAccept) revert InsufficientOutput(got, minAccept);

        emit Swapped(tokenIn, tokenOut, fee, amountIn, got, fair);
    }

    function _spend(uint256 amountIn) private {
        if (amountIn > perOrderMax) revert OverOrderCap(amountIn, perOrderMax);
        uint256 limit = dailyBuyLimit;
        if (limit == 0) return;
        if (block.timestamp >= uint256(windowStart) + WINDOW) {
            windowStart = uint64(block.timestamp);
            spentInWindow = 0;
        }
        uint256 spent = uint256(spentInWindow) + amountIn;
        if (spent > limit) revert OverDailyLimit(spent, limit);
        spentInWindow = uint128(spent);
    }

    // ------------------------------------------------------------------ owner

    /// @notice Stop the envoy and send everything on the script home.
    function recall() external onlyOwner nonReentrant {
        recalled = true;
        _sendAll(base);
        for (uint256 i; i < _tokens.length; ++i) {
            _sendAll(_tokens[i]);
        }
        emit Recalled(owner);
    }

    /// @notice Pull out any token, including ones sent here by mistake.
    function sweep(address token) external onlyOwner nonReentrant {
        emit Swept(token, _sendAll(token));
    }

    function setLimits(uint128 perOrderMax_, uint128 dailyBuyLimit_, uint16 maxSlippageBps_) external onlyOwner {
        _checkLimits(perOrderMax_, dailyBuyLimit_, maxSlippageBps_);
        perOrderMax = perOrderMax_;
        dailyBuyLimit = dailyBuyLimit_;
        maxSlippageBps = maxSlippageBps_;
        emit LimitsChanged(perOrderMax_, dailyBuyLimit_, maxSlippageBps_);
    }

    /// @notice Rotate the agent's key, e.g. if the agent server is compromised.
    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0) || newAgent == owner) revert BadConfig();
        emit AgentChanged(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Move the curfew. Setting it in the past stops the envoy.
    function setCurfew(uint64 newCurfew) external onlyOwner {
        curfew = newCurfew;
        emit CurfewChanged(newCurfew);
    }

    function _checkLimits(uint128 perOrderMax_, uint128 dailyBuyLimit_, uint16 maxSlippageBps_) private pure {
        if (perOrderMax_ == 0 || maxSlippageBps_ > MAX_SLIPPAGE_BPS) revert BadConfig();
        if (dailyBuyLimit_ != 0 && dailyBuyLimit_ < perOrderMax_) revert BadConfig();
    }

    function _sendAll(address token) private returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) IERC20(token).safeTransfer(owner, amount);
    }
}

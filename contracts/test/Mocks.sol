// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter} from "../src/ISwapRouter.sol";

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Fixed-price router. price[in][out] = units of out per 1e18 of in.
/// Modes let tests simulate a router that lies or misroutes output.
contract MockRouter is ISwapRouter {
    enum Mode {
        Honest,
        ShortChange, // sends half the promised output, returns the full number
        Misroute, // sends output to a thief, returns the full number
        Reenter // tries to call back into the vault mid-swap
    }

    mapping(address => mapping(address => uint256)) public price;
    Mode public mode;
    address public thief;
    address public reenterTarget;
    bytes public reenterData;

    function setPrice(address a, address b, uint256 p) external {
        price[a][b] = p;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setThief(address t) external {
        thief = t;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        out = p.amountIn * price[p.tokenIn][p.tokenOut] / 1e18;
        if (mode == Mode.Reenter) {
            (bool ok,) = reenterTarget.call(reenterData);
            require(ok, "reenter blocked");
        }
        if (mode == Mode.ShortChange) {
            MockToken(p.tokenOut).mint(p.recipient, out / 2);
        } else if (mode == Mode.Misroute) {
            MockToken(p.tokenOut).mint(thief, out);
        } else {
            require(out >= p.amountOutMinimum, "slippage");
            MockToken(p.tokenOut).mint(p.recipient, out);
        }
    }
}

/// @dev Fair-value oracle with settable prices; reverts for unknown pairs.
contract MockOracle {
    mapping(address => mapping(address => uint256)) public price;

    function setPrice(address a, address b, uint256 p) external {
        price[a][b] = p;
    }

    function quote(address tokenIn, address tokenOut, uint24, uint256 amountIn) external view returns (uint256) {
        uint256 p = price[tokenIn][tokenOut];
        require(p != 0, "no price");
        return amountIn * p / 1e18;
    }
}

/// @dev Pool that reports fixed tick cumulatives for TWAP tests.
contract MockPool {
    int56 public cumAgo;
    int56 public cumNow;
    bool public tooYoung;

    function set(int56 ago, int56 nowCum) external {
        cumAgo = ago;
        cumNow = nowCum;
    }

    function setTooYoung(bool y) external {
        tooYoung = y;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory c, uint160[] memory s) {
        require(!tooYoung, "OLD");
        c = new int56[](2);
        c[0] = cumAgo;
        c[1] = cumNow;
        s = new uint160[](2);
    }
}

contract MockV3Factory {
    mapping(bytes32 => address) public pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a, b, fee))] = pool;
        pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

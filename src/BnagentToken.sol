// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IV2Factory} from "./interfaces/IExternal.sol";

/// @title BNAGENT token
/// @notice Same rules and public interface as the $JAGENT token (BSC 0x8e64…5aE15), with these
///         intended differences only: name BNAGENT, cap 4.44T, and the treasury may move its own
///         tokens into the official pair before trading opens (it adds the opening liquidity itself).
///         Minted only by the mint contract (the contract that deploys it), up to MAX_SUPPLY including
///         the dead address. Before trading opens only mint-contract sends (and treasury -> official
///         pair) move. After that every wallet and plain contract can receive. Only pool-like receivers
///         are refused: other pairs holding this token, the hardcoded V4 PoolManager and Infinity Vault,
///         and pools the mint contract blocks. Buys from the official pair leave 1% with the mint
///         contract. Sells send 1% to dead and leave 1% with the mint contract. Nothing else is taxed and
///         no swap ever runs inside a user's own transfer.
contract BnagentToken is ERC20 {
    uint256 public constant MAX_SUPPLY = 4_440_000_000_000 ether; // 4.44T
    uint256 public constant BUY_TAX_BPS = 100;
    uint256 public constant SELL_BURN_BPS = 100;
    uint256 public constant SELL_KEEP_BPS = 100;
    uint256 private constant PROBE_GAS = 20_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable usdt;
    address public immutable pair;
    address public immutable poolManager;
    address public immutable infinityVault;
    /// @notice The mint contract. It deployed this token and is the only address able to create supply.
    address public immutable minter;
    /// @notice Project treasury: before trading opens it may move its tokens into the official pair only.
    address public immutable treasury;

    bool public tradingEnabled;
    bool public blocksDisabled;
    mapping(address => bool) public blockedPool;

    event TradingEnabled(uint256 at);
    event PoolBlocked(address indexed pool, bool blocked);
    event BlocksDisabled();

    error NotMinter();
    error ZeroAddress();
    error TransfersClosed();
    error PoolRejected();
    error SupplyCap();

    constructor(address usdt_, address factory_, address poolManager_, address infinityVault_, address treasury_)
        ERC20("BNAGENT", "BNAGENT")
    {
        if (usdt_ == address(0) || factory_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdt = usdt_;
        poolManager = poolManager_;
        infinityVault = infinityVault_;
        treasury = treasury_;
        minter = msg.sender;
        pair = IV2Factory(factory_).createPair(address(this), usdt_);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function mint(address to, uint256 amount) external onlyMinter {
        if (totalSupply() + amount > MAX_SUPPLY) revert SupplyCap();
        _mint(to, amount);
    }

    function enableTrading() external onlyMinter {
        if (tradingEnabled) return;
        tradingEnabled = true;
        emit TradingEnabled(block.timestamp);
    }

    /// @notice Moves pool inventory to dead. The mint contract syncs the pair right after.
    function burnFromPair(uint256 amount) external onlyMinter {
        super._update(pair, DEAD, amount);
    }

    function setPoolBlocked(address pool, bool blocked) external onlyMinter {
        blockedPool[pool] = blocked;
        emit PoolBlocked(pool, blocked);
    }

    function disableBlocks() external onlyMinter {
        blocksDisabled = true;
        emit BlocksDisabled();
    }

    function rejects(address to) public view returns (bool) {
        if (to == pair) return false;
        if (to == poolManager || to == infinityVault) return true;
        if (blockedPool[to] && !blocksDisabled) return true;
        return _isOtherPair(to);
    }

    function _isOtherPair(address a) private view returns (bool) {
        uint256 size = a.code.length;
        if (size == 0) return false;
        if (size == 23) {
            bytes memory code = a.code;
            if (code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00) return false;
        }
        address t0 = _probe(a, 0x0dfe1681); // token0()
        if (t0 == address(this)) return _probe(a, 0xd21220a7) != address(0); // token1()
        if (t0 == address(0)) return false;
        return _probe(a, 0xd21220a7) == address(this);
    }

    function _probe(address a, bytes4 selector) private view returns (address out) {
        (bool ok, bytes memory data) = a.staticcall{gas: PROBE_GAS}(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) return address(0);
        uint256 word = abi.decode(data, (uint256));
        if (word >> 160 != 0) return address(0);
        out = address(uint160(word));
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            super._update(from, to, value);
            return;
        }
        address m = minter;
        if (!tradingEnabled) {
            // BNAGENT difference: the treasury may fund the official pair (manual opening liquidity).
            if (from != m && !(from == treasury && to == pair)) revert TransfersClosed();
            super._update(from, to, value);
            return;
        }
        if (rejects(to)) revert PoolRejected();
        if (from == m || to == m) {
            super._update(from, to, value);
            return;
        }
        if (from == pair) {
            uint256 tax = (value * BUY_TAX_BPS) / 10_000;
            super._update(from, m, tax);
            super._update(from, to, value - tax);
        } else if (to == pair) {
            uint256 burnt = (value * SELL_BURN_BPS) / 10_000;
            uint256 kept = (value * SELL_KEEP_BPS) / 10_000;
            super._update(from, DEAD, burnt);
            super._update(from, m, kept);
            super._update(from, to, value - burnt - kept);
        } else {
            super._update(from, to, value);
        }
    }
}

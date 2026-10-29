// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IV2Factory} from "./interfaces/IExternal.sol";

/// @title BNAGENT token
/// @notice BEP-20 created only by its mint contract (the contract that deploys it), never
///         beyond HARD_CAP. Rules, all fixed in code:
///         - Before the official pool opens, nothing moves except tokens leaving the mint contract.
///         - After opening, wallet-to-wallet transfers are free of tax.
///         - Buying from the official BNAGENT/USDT pair: 1% stays with the mint contract.
///         - Selling into the official pair: 1% goes to the dead address and 1% to the mint contract.
///         - Transfers into any other AMM pair that holds BNAGENT, into the PancakeSwap V4
///           PoolManager / Infinity Vault, or into a pool blocked by the admin, are refused.
///         The mint contract later swaps the collected tokens to BNB for the treasury.
contract BnagentToken is ERC20 {
    uint256 public constant HARD_CAP = 4_440_000_000_000 ether; // 4.44T
    uint16 public constant BUY_FEE_BPS = 100;
    uint16 public constant SELL_BURN_BPS = 100;
    uint16 public constant SELL_FEE_BPS = 100;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant PROBE_GAS_LIMIT = 20_000;

    /// @notice The mint contract. It deployed this token and is the only address able to create supply.
    address public immutable minter;
    address public immutable usdt;
    /// @notice The single official PancakeSwap V2 BNAGENT/USDT pair, created at deployment.
    address public immutable pair;
    address public immutable v4PoolManager;
    address public immutable v4Vault;

    bool public tradingOpen;
    bool public blockingRetired;
    mapping(address => bool) public isBlockedPool;

    event TradingOpened(uint256 timestamp);
    event BlockedPoolSet(address indexed pool, bool blocked);
    event BlockingRetired();

    error OnlyMinter();
    error ZeroAddr();
    error TransfersLocked();
    error ReceiverIsPool();
    error CapExceeded();

    constructor(address usdt_, address factory_, address poolManager_, address vault_)
        ERC20("BNAGENT", "BNAGENT")
    {
        if (usdt_ == address(0) || factory_ == address(0)) revert ZeroAddr();
        minter = msg.sender;
        usdt = usdt_;
        v4PoolManager = poolManager_;
        v4Vault = vault_;
        pair = IV2Factory(factory_).createPair(address(this), usdt_);
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert OnlyMinter();
        _;
    }

    // ------------------------------------------------------------------ minter hooks

    function mint(address to, uint256 amount) external onlyMinter {
        if (totalSupply() + amount > HARD_CAP) revert CapExceeded();
        _mint(to, amount);
    }

    function openTrading() external onlyMinter {
        if (tradingOpen) return;
        tradingOpen = true;
        emit TradingOpened(block.timestamp);
    }

    /// @notice Moves `amount` from the official pair's inventory to the dead address.
    ///         The mint contract calls `sync()` on the pair right after.
    function burnPairInventory(uint256 amount) external onlyMinter {
        super._update(pair, DEAD, amount);
    }

    function setBlockedPool(address pool, bool blocked) external onlyMinter {
        isBlockedPool[pool] = blocked;
        emit BlockedPoolSet(pool, blocked);
    }

    function retireBlocking() external onlyMinter {
        blockingRetired = true;
        emit BlockingRetired();
    }

    // ------------------------------------------------------------------ pool detection

    /// @notice True if a transfer into `to` is refused.
    function isRejectedReceiver(address to) public view returns (bool) {
        if (to == pair) return false;
        if (to == v4PoolManager || to == v4Vault) return true;
        if (!blockingRetired && isBlockedPool[to]) return true;
        return _looksLikeOtherPair(to);
    }

    /// @dev A contract whose token0()/token1() includes this token (and is not the official pair).
    ///      EOAs and EIP-7702 delegated accounts (0xef0100 || address) are never treated as pairs.
    function _looksLikeOtherPair(address a) private view returns (bool) {
        uint256 len = a.code.length;
        if (len == 0) return false;
        if (len == 23 && _hasDelegationPrefix(a)) return false;
        address first = _readAddress(a, 0x0dfe1681); // token0()
        if (first == address(this)) return _readAddress(a, 0xd21220a7) != address(0); // token1()
        if (first == address(0)) return false;
        return _readAddress(a, 0xd21220a7) == address(this);
    }

    function _hasDelegationPrefix(address a) private view returns (bool) {
        bytes memory c = a.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _readAddress(address target, bytes4 sel) private view returns (address result) {
        (bool success, bytes memory ret) = target.staticcall{gas: PROBE_GAS_LIMIT}(abi.encodePacked(sel));
        if (!success || ret.length != 32) return address(0);
        uint256 w = abi.decode(ret, (uint256));
        if (w >> 160 != 0) return address(0);
        result = address(uint160(w));
    }

    // ------------------------------------------------------------------ transfer rules

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            super._update(from, to, value);
            return;
        }
        address m = minter;
        if (!tradingOpen) {
            if (from != m) revert TransfersLocked();
            super._update(from, to, value);
            return;
        }
        if (isRejectedReceiver(to)) revert ReceiverIsPool();
        if (from == m || to == m) {
            super._update(from, to, value);
            return;
        }
        address p = pair;
        if (from == p) {
            uint256 fee = (value * BUY_FEE_BPS) / 10_000;
            super._update(from, m, fee);
            super._update(from, to, value - fee);
        } else if (to == p) {
            uint256 burnPart = (value * SELL_BURN_BPS) / 10_000;
            uint256 feePart = (value * SELL_FEE_BPS) / 10_000;
            super._update(from, DEAD, burnPart);
            super._update(from, m, feePart);
            super._update(from, to, value - burnPart - feePart);
        } else {
            super._update(from, to, value);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BnagentMint} from "../src/BnagentMint.sol";

/// @notice BNB Smart Chain mainnet wiring for BNAGENT. Values mirror the reference deployment's
///         external dependencies (same feed, routers, factory, registry, feed bounds).
library BscConfig {
    address internal constant CREATE2_PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address internal constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address internal constant PANCAKE_V2_FACTORY = 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73;
    address internal constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address internal constant PANCAKE_SMART_ROUTER = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;
    address internal constant BINANCE_DEX_ROUTER = 0xb300000b72DEAEb607a12d5f54773D1C19c7028d;
    address internal constant V4_POOL_MANAGER = 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF;
    address internal constant INFINITY_VAULT = 0x238a358808379702088667322f80aC48bAd5e6c4;
    address internal constant AGENT_ID_REGISTRY = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address internal constant CHAINLINK_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;
    /// @notice Treasury / tax receiver / admin = the user's Binance Agentic Wallet.
    address internal constant TREASURY = 0x866396d4aee9467b67194431bdbDdE8E8044d8AE;
    /// @notice Dedicated social-task EIP-712 signer (like Jager's separate quotaSigner). Generated 2026-10-30;
    ///         the key is kept encrypted outside git (secrets/, gitignored). It has no funds and no other power.
    address internal constant SOCIAL_SIGNER = 0x66ECa9C28e4e4807e37C078b917e527DC85aC199;

    uint256 internal constant V2_FEE_BPS = 25;
    uint256 internal constant FEED_MAX_AGE = 3600;
    uint256 internal constant FEED_MIN = 5_000_000_000; // $50 (8 decimals)
    uint256 internal constant FEED_MAX = 5_000_000_000_000; // $50,000

    bytes32 internal constant SALT = keccak256("BNAGENT.mint.v1");

    function params(address socialSigner) internal pure returns (BnagentMint.Params memory p) {
        address[] memory keep = new address[](3);
        keep[0] = PANCAKE_V2_ROUTER;
        keep[1] = PANCAKE_SMART_ROUTER;
        keep[2] = BINANCE_DEX_ROUTER;
        p = BnagentMint.Params({
            usdt: USDT,
            v2Factory: PANCAKE_V2_FACTORY,
            v4PoolManager: V4_POOL_MANAGER,
            v4Vault: INFINITY_VAULT,
            agentRegistry: AGENT_ID_REGISTRY,
            treasury: TREASURY,
            socialSigner: socialSigner,
            bnbUsdFeed: CHAINLINK_BNB_USD,
            wbnb: WBNB,
            v2FeeBps: V2_FEE_BPS,
            feedMaxAge: FEED_MAX_AGE,
            feedMinAnswer: FEED_MIN,
            feedMaxAnswer: FEED_MAX,
            neverBlockable: keep
        });
    }

    function initCode(address socialSigner) internal pure returns (bytes memory) {
        return abi.encodePacked(type(BnagentMint).creationCode, abi.encode(params(socialSigner)));
    }

    function predicted(address socialSigner) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), CREATE2_PROXY, SALT, keccak256(initCode(socialSigner))))
                )
            )
        );
    }
}

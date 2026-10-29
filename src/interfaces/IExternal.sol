// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal PancakeSwap V2 factory surface used by BNAGENT.
interface IV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

/// @dev Minimal PancakeSwap V2 pair surface used by BNAGENT.
interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 lastTs);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function mint(address to) external returns (uint256 liquidity);
    function sync() external;
    function totalSupply() external view returns (uint256);
}

/// @dev Wrapped BNB.
interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

/// @dev SPACE ID ".ai" Agent ID registry on BSC (soulbound ERC-721, tokenId = uint256(keccak256(label))).
interface IAgentIdRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
    function handleOf(address account) external view returns (string memory);
}

/// @dev Chainlink aggregator (BNB / USD).
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

library V2Math {
    /// @dev Constant-product output for `amountIn`, with the pool fee given in basis points.
    function getOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        uint256 net = amountIn * (10_000 - feeBps);
        return (net * reserveOut) / (reserveIn * 10_000 + net);
    }
}

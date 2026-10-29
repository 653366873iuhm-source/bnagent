// BNAGENT site configuration. v2 deployed on BSC mainnet 2026-10-30 (tx 0x89fc3e2ad568a0d080849914e1d2fd2d402c6250ceaa2e2ed0cc37186c268ac6, block 130,542,132).
// The site reads paused/supply live from the mint contract. (v1 mint 0xBd57…9e68a is paused and retired.)
window.BNAGENT_CONFIG = {
  chainId: 56,
  rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.binance.org"],
  mint: "0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0",   // BnagentMint
  token: "0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB",  // BnagentToken
  pair: "0x7d4Fde617a4f5D83fD8A354672558d9B9Cd5aA6f",   // PancakeSwap BNAGENT/USDT pair (mint.pair())
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  agentRegistry: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  treasury: "0x866396d4aee9467b67194431bdbDdE8E8044d8AE",
  explorer: "https://bscscan.com",
  repo: "https://github.com/653366873iuhm-source/bnagent",
  site: "https://bnagent.onrender.com/",
  // Binance Agentic Wallet QR login proxy (server/ in the repo, Render web service). The mint contract address must be added to
  // its ALLOW_TO env var after deployment, otherwise mint previews are refused (USDT approve is always allowed).
  agentApi: "https://bnagent-api.onrender.com/api/agent-wallet",
  // Same API service: /api/social (task vouchers), /api/leaderboard; pinged on page load to wake the free instance.
  api: "https://bnagent-api.onrender.com",
  // Social tasks: handles are placeholders until decided.
  social: {
    x: "bnAgent_", // https://x.com/bnAgent_ (without @)
  },
};

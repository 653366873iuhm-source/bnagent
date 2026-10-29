// BNAGENT site configuration. Deployed on BSC mainnet 2026-10-30 (tx 0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b).
// Minting is LIVE (setPaused(false) sent); the site reads paused/supply live from the mint contract.
window.BNAGENT_CONFIG = {
  chainId: 56,
  rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.binance.org"],
  mint: "0xBd57F860B043924f4F37d35AC16c3aab37068e9a",   // BnagentMint
  token: "0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c",  // BnagentToken
  pair: "0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc",   // PancakeSwap BNAGENT/USDT pair (mint.pair())
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

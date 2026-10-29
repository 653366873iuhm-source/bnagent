// BNAGENT site configuration. Contract addresses stay EMPTY until mainnet deployment is approved
// and executed; the mint card shows "not deployed yet" while they are empty.
window.BNAGENT_CONFIG = {
  chainId: 56,
  rpc: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.binance.org"],
  mint: "",   // BnagentMint address (fill after deploy)
  token: "",  // BnagentToken address (fill after deploy)
  pair: "",   // PancakeSwap BNAGENT/USDT pair (fill after deploy)
  usdt: "0x55d398326f99059fF775485246999027B3197955",
  agentRegistry: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  treasury: "0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE",
  explorer: "https://bscscan.com",
  repo: "https://github.com/653366873iuhm-source/bnagent",
  // Social tasks: handles are placeholders until decided.
  social: {
    x: "",        // e.g. "bnagent" (without @)
    telegram: "", // e.g. "https://t.me/..."
  },
};

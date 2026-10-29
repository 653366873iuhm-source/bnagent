// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {BscConfig} from "./BscConfig.sol";

/// @notice Writes the UNSIGNED deployment plan to deploy/bsc-mainnet-plan.json. Broadcasts nothing.
///         SOCIAL_SIGNER (env, optional) = address whose EIP-712 signatures grant social-task quota.
///         Defaults to the dedicated signer BscConfig.SOCIAL_SIGNER.
contract BuildPlan is Script {
    function run() external {
        address socialSigner = vm.envOr("SOCIAL_SIGNER", BscConfig.SOCIAL_SIGNER);
        bytes memory init = BscConfig.initCode(socialSigner);
        address mintAddr = BscConfig.predicted(socialSigner);
        address tokenAddr = vm.computeCreateAddress(mintAddr, 1);
        bytes memory deployData = abi.encodePacked(BscConfig.SALT, init);
        bytes memory unpauseData = abi.encodeWithSignature("setPaused(bool)", false);

        string memory o = "plan";
        vm.serializeString(o, "network", "BNB Smart Chain mainnet (chainId 56)");
        vm.serializeAddress(o, "from", BscConfig.TREASURY);
        vm.serializeAddress(o, "socialSigner", socialSigner);
        vm.serializeAddress(o, "expectedMint", mintAddr);
        vm.serializeAddress(o, "expectedToken", tokenAddr);
        vm.serializeBytes32(o, "salt", BscConfig.SALT);
        vm.serializeBytes32(o, "initCodeHash", keccak256(init));

        string memory t1 = "tx1";
        vm.serializeString(t1, "description", "Deploy BnagentMint via the CREATE2 deployer proxy (also deploys BnagentToken and creates the official, empty PancakeSwap BNAGENT/USDT pair). Mint starts PAUSED; shares #1-#1,100 are burned (sale starts at #1,101). Jager money model: 20% of each payment to the treasury, 80% held by the mint contract; the tx reaching share 10,000 automatically opens the official pool with everything parked (7,120 USDT + 356B BNAGENT), LP to dead; afterwards 80% of each mint is added to the pool (LP to dead).");
        vm.serializeAddress(t1, "to", BscConfig.CREATE2_PROXY);
        vm.serializeString(t1, "value", "0");
        vm.serializeAddress(t1, "expectedAddress", mintAddr);
        string memory tx1 = vm.serializeBytes(t1, "data", deployData);

        string memory t2 = "tx2";
        vm.serializeString(t2, "description", "Open minting: treasury calls setPaused(false) on the mint contract (only after the website shows the deployed addresses). The first unpause starts the 30-day clock: if share 10,000 is not reached by mintStartTime + 30 days, only the treasury can call withdrawUnfilled() (selector 0xa65c6326), which sends all USDT held to the treasury and closes minting for good.");
        vm.serializeAddress(t2, "to", mintAddr);
        vm.serializeString(t2, "value", "0");
        string memory tx2 = vm.serializeBytes(t2, "data", unpauseData);

        string[] memory txs = new string[](2);
        txs[0] = tx1;
        txs[1] = tx2;
        string memory arr = string.concat("[", txs[0], ",", txs[1], "]");
        string memory json = vm.serializeString(o, "note", "UNSIGNED. Nothing broadcast. Each tx: baw contract-call preview --binanceChainId 56 --from <treasury> --to <to> --value 0 --inputData <data>, then execute only after explicit user approval.");
        // splice the txs array in (forge-std JSON serializer has no array-of-objects helper)
        json = string.concat(_trimLastBrace(json), ",\"txs\":", arr, "}");
        vm.writeFile("deploy/bsc-mainnet-plan.json", json);
        console2.log("mint (CREATE2):", mintAddr);
        console2.log("token (CREATE from mint, nonce 1):", tokenAddr);
        console2.log("initcode bytes:", init.length);
    }

    function _trimLastBrace(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length - 1);
        for (uint256 i; i < out.length; i++) {
            out[i] = b[i];
        }
        return string(out);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BnagentMint} from "../src/BnagentMint.sol";
import {BnagentToken} from "../src/BnagentToken.sol";
import {IV2Pair, IV2Factory, IAgentIdRegistry} from "../src/interfaces/IExternal.sol";
import {BscConfig} from "../script/BscConfig.sol";

interface IRouterV2 {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice BSC mainnet fork tests. Run with BSC_RPC_URL set (an RPC that serves state at FORK_BLOCK).
contract BnagentForkTest is Test {
    BnagentMint mint;
    BnagentToken token;
    IV2Pair pair;
    IERC20 usdt = IERC20(BscConfig.USDT);
    IAgentIdRegistry reg = IAgentIdRegistry(BscConfig.AGENT_ID_REGISTRY);
    address treasury = BscConfig.TREASURY;

    uint256 signerPk = 0xB0A6E17;
    address signer;

    // Real Agent ID holders on BSC (read from the registry at the fork block).
    address constant ALICE = 0x5d2A279e91A4e82bB327f5c98Fb48C72F7Cb39e3; // htetwai.ai
    address constant BOB = 0xd72106AAd68223AfA37CcB7f8a8A14f2F2a353C3; // chmon.ai
    address constant CAROL = 0xaB5129eFcfda039F1C571A8487dEae484AFe7ba0; // gm1117.ai
    address constant NOBODY = address(0xBEEF0001); // no Agent ID

    // One funded address that is given a fresh synthetic Agent ID before each bulk mint, so the
    // fork does not need to fetch storage for thousands of new wallets.
    address bulk = address(0xB01C);
    uint256 bulkNonce;
    uint256 treasuryUsdt0;
    uint256 treasuryBnb0;
    address otherPair;
    uint256 burnsA;
    uint256 burnsB;

    function setUp() public {
        string memory rpc = vm.envString("BSC_RPC_URL");
        uint256 blk = vm.envOr("FORK_BLOCK", uint256(0));
        if (blk == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blk);
        signer = vm.addr(signerPk);

        // Deploy exactly like the plan: the treasury wallet calls the CREATE2 proxy with salt || initCode.
        bytes memory init = BscConfig.initCode(signer);
        vm.prank(treasury);
        (bool ok, bytes memory ret) = BscConfig.CREATE2_PROXY.call(abi.encodePacked(BscConfig.SALT, init));
        require(ok && ret.length == 20, "create2 failed");
        address deployed = address(bytes20(ret));
        assertEq(deployed, BscConfig.predicted(signer), "address prediction");
        mint = BnagentMint(payable(deployed));
        token = mint.token();
        assertEq(address(token), vm.computeCreateAddress(deployed, 1), "token address prediction");
        pair = mint.pair();

        vm.prank(treasury);
        mint.setPaused(false);

        deal(BscConfig.USDT, bulk, 100_000 ether);
        vm.prank(bulk);
        usdt.approve(address(mint), type(uint256).max);
        for (uint256 i; i < 3; i++) {
            address a = i == 0 ? ALICE : i == 1 ? BOB : CAROL;
            deal(BscConfig.USDT, a, 1_000 ether);
            vm.prank(a);
            usdt.approve(address(mint), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _newBulkId() internal returns (uint256 id) {
        string memory handle = string.concat("bulk", vm.toString(++bulkNonce));
        id = uint256(keccak256(bytes(handle)));
        vm.mockCall(address(reg), abi.encodeCall(IAgentIdRegistry.handleOf, (bulk)), abi.encode(handle));
        vm.mockCall(address(reg), abi.encodeCall(IAgentIdRegistry.ownerOf, (id)), abi.encode(bulk));
    }

    /// @dev Mints `total` shares from synthetic Agent IDs, 10 per tx; checks the per-tx price rise.
    function _bulkMint(uint256 total) internal returns (uint256 burns) {
        while (total > 0) {
            uint256 n = total > 10 ? 10 : total;
            _newBulkId();
            uint256 pBefore = _poolPrice();
            vm.prank(bulk);
            mint.mint(n, address(0), type(uint256).max);
            if (pBefore > 0) {
                uint256 pAfter = _poolPrice();
                // +0.8% max per transaction (tiny tolerance for integer rounding)
                assertLe(pAfter, pBefore * 1_008_001 / 1_000_000, "floor burn > 0.8%/tx");
                if (pAfter > pBefore) burns++; // only a floor burn raises the pool price in a mint
                (, uint256 tr) = mint.poolReserves();
                assertGe(tr, mint.POOL_MIN_TOKENS(), "pool min tokens");
            }
            total -= n;
        }
    }

    function _pairTokenBalance() internal view returns (uint256) {
        return token.balanceOf(address(pair));
    }

    /// @dev USDT per token, scaled 1e36.
    function _poolPrice() internal view returns (uint256) {
        if (!mint.isOpen()) return 0;
        (uint256 u, uint256 t) = mint.poolReserves();
        return u * 1e36 / t;
    }

    function _signTask(address user, bytes32 task, bytes32 account, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(mint.SOCIAL_CLAIM_TYPEHASH(), user, task, account, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", mint.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openPool() internal {
        uint256 left = mint.OPEN_AT_SHARE() - mint.totalMinted();
        _bulkMint(left);
        assertTrue(mint.isOpen());
    }

    function _buy(address who, uint256 usdtIn) internal returns (uint256 got) {
        deal(BscConfig.USDT, who, usdtIn);
        address[] memory path = new address[](2);
        path[0] = BscConfig.USDT;
        path[1] = address(token);
        vm.startPrank(who);
        usdt.approve(BscConfig.PANCAKE_V2_ROUTER, usdtIn);
        uint256 b = token.balanceOf(who);
        IRouterV2(BscConfig.PANCAKE_V2_ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            usdtIn, 0, path, who, block.timestamp
        );
        got = token.balanceOf(who) - b;
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ tests

    function test_RealAgentIdsResolve() public view {
        (uint256 id, bool ok) = mint.agentIdOf(ALICE);
        assertTrue(ok);
        assertEq(id, uint256(keccak256("htetwai")));
        (, bool ok2) = mint.agentIdOf(NOBODY);
        assertFalse(ok2);
        (, bool ok3) = mint.agentIdOf(treasury);
        assertTrue(ok3, "treasury wallet holds allin168.ai");
    }

    function test_PriceTable() public view {
        assertEq(mint.sharePriceCents(1), 100);
        assertEq(mint.sharePriceCents(10_000), 100);
        assertEq(mint.sharePriceCents(10_001), 110);
        assertEq(mint.sharePriceCents(11_000), 110);
        assertEq(mint.sharePriceCents(11_001), 120);
        assertEq(mint.sharePriceCents(20_000), 200);
        assertEq(mint.sharePriceCents(20_001), 210);
        assertEq(mint.sharePriceCents(21_001), 212);
        assertEq(mint.sharePriceCents(30_000), 228);
        uint256 sum;
        for (uint256 n = 1; n <= 30_000; n++) {
            sum += mint.sharePriceCents(n);
        }
        assertEq(sum, 4_740_000, "47,400 USDT total");
    }

    function test_PausedAtDeployAndAdmin() public {
        vm.prank(treasury);
        mint.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.MintPaused.selector);
        mint.mint(1, address(0), 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.NotTreasury.selector);
        mint.setPaused(false);
        vm.prank(treasury);
        mint.setPaused(false);
        vm.prank(ALICE);
        mint.mint(1, address(0), 1 ether);
    }

    function test_MintRules() public {
        vm.startPrank(ALICE);
        vm.expectRevert(BnagentMint.InvalidShares.selector);
        mint.mint(0, address(0), 100 ether);
        vm.expectRevert(BnagentMint.InvalidShares.selector);
        mint.mint(11, address(0), 100 ether);
        vm.expectRevert(BnagentMint.CostAboveMax.selector);
        mint.mint(5, address(0), 4.99 ether);
        mint.mint(10, address(0), 10 ether);
        assertEq(token.balanceOf(ALICE), 500_000_000 ether);
        vm.expectRevert(BnagentMint.OverQuota.selector);
        mint.mint(1, address(0), 1 ether);
        vm.stopPrank();

        deal(BscConfig.USDT, NOBODY, 10 ether);
        vm.startPrank(NOBODY);
        usdt.approve(address(mint), 10 ether);
        vm.expectRevert(BnagentMint.NoAgentId.selector);
        mint.mint(1, address(0), 1 ether);
        vm.stopPrank();

        // parked for pool + treasury
        assertEq(mint.parkedUsdt(), 8 ether);
        assertEq(usdt.balanceOf(address(mint)), 8 ether);
        assertEq(token.balanceOf(address(mint)), 400_000_000 ether);
    }

    function test_PlainTransfersDoNotMint() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool ok,) = address(mint).call{value: 0.01 ether}("");
        assertFalse(ok, "plain BNB must revert");
    }

    function test_InviteAndSelfInvite() public {
        // self-invite: nothing
        vm.prank(ALICE);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 10);
        // BOB invited by ALICE: ALICE +1 on BOB's first paid mint only
        vm.prank(BOB);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 11);
        vm.prank(BOB);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 11);
        // non-agent referrer: nothing
        vm.prank(CAROL);
        mint.mint(1, NOBODY, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("gm1117"))), 10);
        // ALICE can now mint 11 in total
        vm.startPrank(ALICE);
        mint.mint(10, address(0), 10 ether);
        vm.expectRevert(BnagentMint.OverQuota.selector);
        mint.mint(1, address(0), 1 ether);
        vm.stopPrank();
    }

    function test_SocialTasks() public {
        bytes32 FOLLOW = mint.TASK_FOLLOW();
        bytes32 TWEET = mint.TASK_TWEET();
        bytes32 TG = mint.TASK_TELEGRAM();
        bytes32 xAcct = keccak256("x:alice_handle");
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _signTask(ALICE, FOLLOW, xAcct, dl);
        vm.prank(ALICE);
        mint.claimTask(FOLLOW, xAcct, dl, sig);
        uint256 aid = uint256(keccak256("htetwai"));
        assertEq(mint.quotaOf(aid), 11);
        // same task twice
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.AlreadyClaimed.selector);
        mint.claimTask(FOLLOW, xAcct, dl, sig);
        // same social account for another Agent ID
        bytes memory sigB = _signTask(BOB, FOLLOW, xAcct, dl);
        vm.prank(BOB);
        vm.expectRevert(BnagentMint.AlreadyClaimed.selector);
        mint.claimTask(FOLLOW, xAcct, dl, sigB);
        // signature for someone else
        bytes memory wrongUser = _signTask(ALICE, TWEET, keccak256("x:bob"), dl);
        vm.prank(BOB);
        vm.expectRevert(BnagentMint.ClaimInvalid.selector);
        mint.claimTask(TWEET, keccak256("x:bob"), dl, wrongUser);
        // expired
        bytes memory late = _signTask(ALICE, TG, keccak256("tg:a"), block.timestamp - 1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.ClaimInvalid.selector);
        mint.claimTask(TG, keccak256("tg:a"), block.timestamp - 1, late);
        // unknown task
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.UnknownTask.selector);
        mint.claimTask(keccak256("OTHER"), xAcct, dl, sig);
        // remaining two tasks -> quota 13
        bytes memory s1 = _signTask(ALICE, TWEET, keccak256("x:alice_handle#tw"), dl);
        bytes memory s2 = _signTask(ALICE, TG, keccak256("tg:alice"), dl);
        vm.startPrank(ALICE);
        mint.claimTask(TWEET, keccak256("x:alice_handle#tw"), dl, s1);
        mint.claimTask(TG, keccak256("tg:alice"), dl, s2);
        vm.stopPrank();
        assertEq(mint.quotaOf(aid), 13);
    }

    function test_TransfersLockedBeforeOpen() public {
        vm.prank(ALICE);
        mint.mint(1, address(0), 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.TransfersLocked.selector);
        token.transfer(BOB, 1 ether);
    }

    function test_BnbMintWithRefund() public {
        uint256 need = mint.bnbQuote(3);
        vm.deal(ALICE, 1 ether);
        uint256 tBefore = usdt.balanceOf(treasury);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.CostAboveMax.selector);
        mint.mintWithBnb{value: need}(3, address(0), need - 1);
        vm.prank(ALICE);
        mint.mintWithBnb{value: need + 0.05 ether}(3, address(0), need + 0.05 ether);
        assertEq(ALICE.balance, 1 ether - need, "excess BNB refunded");
        assertEq(token.balanceOf(ALICE), 150_000_000 ether);
        assertGe(usdt.balanceOf(treasury) - tBefore, 0.6 ether, "treasury 20% + swap surplus");
        assertEq(mint.parkedUsdt(), 2.4 ether);
        uint256 one = mint.bnbQuote(1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.PaymentInvalid.selector);
        mint.mintWithBnb{value: one - 1}(1, address(0), need);
    }

    /// @notice Full flow: phase 1 (USDT + BNB), the opening tx at 10,000, phase-2 pricing, floor burns,
    ///         taxes, pool rejection, admin + renounce, sell-out at 30,000.
    function test_FullFlow() public {
        treasuryUsdt0 = usdt.balanceOf(treasury);
        treasuryBnb0 = treasury.balance;
        _flowPhase1();
        _flowPhase2Start();
        _flowTaxes();
        _flowAdminAndBulk();
        _flowEnd();
    }

    function _flowPhase1() internal {

        // phase 1 with a BNB mint in the middle
        _bulkMint(5_000);
        vm.deal(BOB, 1 ether);
        uint256 q = mint.bnbQuote(10);
        vm.prank(BOB);
        mint.mintWithBnb{value: q}(10, address(0), q);
        _bulkMint(9_980 - mint.totalMinted());
        assertFalse(mint.isOpen());
        assertEq(mint.totalMinted(), 9_980);

        // the crossing tx: 9,981..9,990 then ALICE 9,991..10,000 opens the pool, then CAROL crosses into 10,001+
        _bulkMint(10);
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        assertTrue(mint.isOpen(), "pool opened on share 10,000");
        assertTrue(token.tradingOpen());
        (uint256 u, uint256 t) = mint.poolReserves();
        assertEq(u, 8_000 ether);
        assertEq(t, 400_000_000_000 ether);
        assertGt(IERC20(address(pair)).balanceOf(mint.DEAD()), 0, "LP at dead");
        assertEq(IERC20(address(pair)).balanceOf(address(mint)), 0);
        assertEq(mint.parkedUsdt(), 0);
        assertEq(token.balanceOf(ALICE), 500_000_000 ether);
        // 20% of 10,000 USDT (+ BNB swap surplus) reached the treasury
        assertGe(usdt.balanceOf(treasury) - treasuryUsdt0, 2_000 ether);

    }

    function _flowPhase2Start() internal {
        (uint256 u, uint256 t) = mint.poolReserves();
        // phase 2 first mint: 99% of pool price; floor line already above circ value -> burn
        uint256 p0 = _poolPrice();
        uint256 expectTokens = 1.1 ether * t * 10_000 / (u * 9_900);
        vm.prank(CAROL);
        mint.mint(1, address(0), 1.1 ether);
        assertEq(token.balanceOf(CAROL), expectTokens, "phase-2 tokens at 99% of pool price");
        assertGt(_poolPrice(), p0, "floor burn raised price");
        assertLe(_poolPrice(), p0 * 1_008_001 / 1_000_000);

        // wallet transfers are tax free after open
        vm.prank(ALICE);
        token.transfer(BOB, 1_000 ether);
        assertEq(token.balanceOf(BOB), 1_000 ether + 500_000_000 ether);

        // other pools rejected, official pair allowed
        otherPair = IV2Factory(BscConfig.PANCAKE_V2_FACTORY).createPair(address(token), BscConfig.WBNB);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.ReceiverIsPool.selector);
        token.transfer(otherPair, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.ReceiverIsPool.selector);
        token.transfer(BscConfig.V4_POOL_MANAGER, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.ReceiverIsPool.selector);
        token.transfer(BscConfig.INFINITY_VAULT, 1 ether);

    }

    function _flowTaxes() internal {
        // buy tax 1% to the mint contract
        address trader = address(0x7EADE5);
        uint256 mintBalBefore = token.balanceOf(address(mint));
        uint256 got = _buy(trader, 50 ether);
        uint256 taxIn = token.balanceOf(address(mint)) - mintBalBefore;
        assertApproxEqAbs(taxIn * 99, got, 100, "buy tax = 1%");

        // sell tax: 1% burn + 1% to mint contract
        uint256 sellAmt = got / 2;
        uint256 deadBefore = token.balanceOf(mint.DEAD());
        uint256 mBefore = token.balanceOf(address(mint));
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = BscConfig.USDT;
        vm.startPrank(trader);
        token.approve(BscConfig.PANCAKE_V2_ROUTER, sellAmt);
        IRouterV2(BscConfig.PANCAKE_V2_ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            sellAmt, 0, path, trader, block.timestamp
        );
        vm.stopPrank();
        assertEq(token.balanceOf(mint.DEAD()) - deadBefore, sellAmt / 100, "sell burn 1%");
        assertEq(token.balanceOf(address(mint)) - mBefore, sellAmt / 100, "sell fee 1%");
        assertGt(usdt.balanceOf(trader), 0);

        // tax conversion to BNB for the treasury on the next mint (new block), capped at 0.1% of pool
        vm.roll(block.number + 1);
        uint256 held = token.balanceOf(address(mint));
        (, uint256 tr) = mint.poolReserves();
        _bulkMint(10);
        uint256 converted = held - token.balanceOf(address(mint));
        assertGt(treasury.balance, treasuryBnb0, "treasury received BNB from tax");
        assertLe(converted, tr * 10 / 10_000 + 1, "tax swap cap 0.1% of pool");
        // a second conversion in the same block is refused
        vm.expectRevert(BnagentMint.OneSwapPerBlock.selector);
        mint.convertTax();

    }

    function _flowAdminAndBulk() internal {
        // admin: block a pool-like contract, wallets/routers/pair are not blockable
        vm.startPrank(treasury);
        vm.expectRevert(BnagentMint.CannotBlock.selector);
        mint.setPoolBlocked(ALICE, true);
        vm.expectRevert(BnagentMint.CannotBlock.selector);
        mint.setPoolBlocked(BscConfig.PANCAKE_V2_ROUTER, true);
        vm.expectRevert(BnagentMint.CannotBlock.selector);
        mint.setPoolBlocked(address(pair), true);
        mint.setPoolBlocked(BscConfig.WBNB, true);
        vm.stopPrank();
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.ReceiverIsPool.selector);
        token.transfer(BscConfig.WBNB, 1 ether);

        // phase 2 bulk to 20,000 with BNB mints mixed in
        burnsA = _bulkMint(15_000 - mint.totalMinted());
        vm.deal(CAROL, 1 ether);
        uint256 q = mint.bnbQuote(5);
        vm.prank(CAROL);
        mint.mintWithBnb{value: q}(5, address(0), q);
        burnsA += _bulkMint(20_000 - mint.totalMinted());
        assertEq(mint.sharePriceCents(mint.totalMinted() + 1), 210);

        // renounce: pause + blocking gone forever, minting continues
        vm.prank(treasury);
        mint.renounce();
        assertTrue(mint.renounced());
        assertFalse(mint.paused());
        assertTrue(token.blockingRetired());
        vm.prank(ALICE);
        token.transfer(BscConfig.WBNB, 1 ether); // block no longer applies
        vm.startPrank(treasury);
        vm.expectRevert(BnagentMint.RenouncedAlready.selector);
        mint.setPaused(true);
        vm.expectRevert(BnagentMint.RenouncedAlready.selector);
        mint.setPoolBlocked(otherPair, true);
        vm.stopPrank();
        // hardcoded rejections still hold after renounce
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.ReceiverIsPool.selector);
        token.transfer(otherPair, 1 ether);

    }

    function _flowEnd() internal {
        // to sell-out
        burnsB = _bulkMint(30_000 - mint.totalMinted());
        assertEq(mint.totalMinted(), 30_000);
        assertEq(mint.totalPaid(), 47_400 ether, "total paid = price table");
        _newBulkId();
        vm.prank(bulk);
        vm.expectRevert(BnagentMint.SoldOut.selector);
        mint.mint(1, address(0), 10 ether);
        assertLe(token.totalSupply(), token.HARD_CAP());

        (uint256 u, uint256 t) = mint.poolReserves();
        uint256 circ = mint.circulatingSupply();
        console2.log("mint txs with floor burn, shares 10,001-20,000:", burnsA);
        console2.log("mint txs with floor burn, shares 20,001-30,000:", burnsB);
        console2.log("final pool USDT (wei):", u);
        console2.log("final pool BNAGENT (tokens):", t / 1e18);
        console2.log("final total supply (tokens):", token.totalSupply() / 1e18);
        console2.log("final circulating (tokens):", circ / 1e18);
        console2.log("dead balance (tokens):", token.balanceOf(mint.DEAD()) / 1e18);
        console2.log("circ value at pool price (USDT):", circ * u / t / 1e18);
        console2.log("floor line (USDT):", mint.floorLine() / 1e18);
        console2.log("treasury USDT gained:", (usdt.balanceOf(treasury) - treasuryUsdt0) / 1e18);
        console2.log("treasury BNB gained (wei):", treasury.balance - treasuryBnb0);
    }

    function test_HardCapEnforcedInToken() public {
        uint256 cap = token.HARD_CAP();
        vm.prank(address(mint));
        vm.expectRevert(BnagentToken.CapExceeded.selector);
        token.mint(ALICE, cap + 1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.OnlyMinter.selector);
        token.mint(ALICE, 1);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BnagentMint} from "../src/BnagentMint.sol";
import {BnagentToken} from "../src/BnagentToken.sol";
import {IV2Pair, IV2Factory, IAgentIdRegistry} from "../src/interfaces/IExternal.sol";
import {BscConfig} from "../script/BscConfig.sol";

interface IPairExtra {
    function skim(address to) external;
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IRouterV2 {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
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
    uint256 usdPaidInBnb; // table price of shares paid with BNB
    uint256 usdtFromBnb; // USDT the treasury received from BNB mints (BNB swapped to USDT, all of it to the treasury)
    uint256 startTs; // block time of the first setPaused(false) in setUp

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

        assertEq(mint.mintStartTime(), 0, "clock not started while paused");
        vm.prank(treasury);
        mint.setPaused(false);
        startTs = block.timestamp;

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
                (, uint256 tr) = mint.reserves();
                assertGe(tr, mint.POOL_TOKEN_FLOOR(), "pool min tokens");
            }
            total -= n;
        }
    }

    function _pairTokenBalance() internal view returns (uint256) {
        return token.balanceOf(address(pair));
    }

    /// @dev USDT per token, scaled 1e36.
    function _poolPrice() internal view returns (uint256) {
        if (!mint.opened()) return 0;
        (uint256 u, uint256 t) = mint.reserves();
        return u * 1e36 / t;
    }

    function _signTask(address user, bytes32 task, bytes32 account, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(mint.SOCIAL_TYPEHASH(), user, task, account, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", mint.domainSeparator(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Pre-open invariant (reference): the mint contract holds exactly the parked 80% and 40M tokens per share.
    function _assertParked() internal view {
        uint256 m = mint.totalMinted();
        assertEq(mint.pendingUsdt(), (m - 1_100) * 0.8 ether, "80% parked (burned shares park nothing)");
        assertEq(usdt.balanceOf(address(mint)), mint.pendingUsdt(), "contract USDT = parked USDT");
        assertEq(mint.pendingTokens(), (m - 1_100) * mint.POOL_SHARE(), "40M parked per sold share");
        assertEq(token.balanceOf(address(mint)), mint.pendingTokens());
        assertEq(address(mint).balance, 0, "no BNB held");
    }

    function _lpAtDead() internal view returns (uint256) {
        return IPairExtra(address(pair)).balanceOf(mint.DEAD());
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

    // ------------------------------------------------------------------ Jager-parity tests

    function test_RealAgentIdsResolve() public view {
        (uint256 id, bool ok) = mint.agentOf(ALICE);
        assertTrue(ok);
        assertEq(id, uint256(keccak256("htetwai")));
        (, bool ok2) = mint.agentOf(NOBODY);
        assertFalse(ok2);
        (, bool ok3) = mint.agentOf(treasury);
        assertTrue(ok3, "treasury wallet holds allin168.ai");
    }

    function test_PriceTable() public view {
        assertEq(mint.priceCents(1), 100);
        assertEq(mint.priceCents(10_000), 100);
        assertEq(mint.priceCents(10_001), 110);
        assertEq(mint.priceCents(11_000), 110);
        assertEq(mint.priceCents(11_001), 120);
        assertEq(mint.priceCents(20_000), 200);
        assertEq(mint.priceCents(20_001), 210);
        assertEq(mint.priceCents(21_001), 212);
        assertEq(mint.priceCents(30_000), 228);
        uint256 sum;
        for (uint256 n = 1; n <= 30_000; n++) {
            sum += mint.priceCents(n);
        }
        assertEq(sum, 4_740_000, "47,400 USDT total");
        uint256 sellable;
        for (uint256 n = 1_101; n <= 30_000; n++) {
            sellable += mint.priceCents(n);
        }
        assertEq(sellable, 4_630_000, "46,300 USDT for the 28,900 sellable shares");
        assertEq(mint.LINE_DENOM(), 46_300);
    }

    function test_PausedAtDeployAndAdmin() public {
        vm.prank(treasury);
        mint.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.Paused.selector);
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
        uint256 t0 = usdt.balanceOf(treasury);
        vm.startPrank(ALICE);
        vm.expectRevert(BnagentMint.BadShares.selector);
        mint.mint(0, address(0), 100 ether);
        vm.expectRevert(BnagentMint.BadShares.selector);
        mint.mint(11, address(0), 100 ether);
        vm.expectRevert(BnagentMint.OverMaxCost.selector);
        mint.mint(5, address(0), 4.99 ether);
        mint.mint(10, address(0), 10 ether);
        assertEq(token.balanceOf(ALICE), 500_000_000 ether);
        assertEq(usdt.balanceOf(treasury) - t0, 2 ether, "20% to treasury");
        vm.expectRevert(BnagentMint.Quota.selector);
        mint.mint(1, address(0), 1 ether);
        vm.stopPrank();

        deal(BscConfig.USDT, NOBODY, 10 ether);
        vm.startPrank(NOBODY);
        usdt.approve(address(mint), 10 ether);
        vm.expectRevert(BnagentMint.NoAgent.selector);
        mint.mint(1, address(0), 1 ether);
        vm.stopPrank();

        _assertParked();
        assertEq(usdt.balanceOf(address(mint)), 8 ether, "80% held by the mint contract");
        assertEq(token.totalSupply(), 10 * 90_000_000 ether, "50M buyer + 40M parked per share");
    }

    function test_PlainTransfersDoNotMint() public {
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool ok,) = address(mint).call{value: 0.01 ether}("");
        assertFalse(ok, "plain BNB must revert");
    }

    function test_InviteAndSelfInvite() public {
        vm.prank(ALICE);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 10);
        vm.prank(BOB);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 11);
        vm.prank(BOB);
        mint.mint(1, ALICE, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("htetwai"))), 11);
        vm.prank(CAROL);
        mint.mint(1, NOBODY, 1 ether);
        assertEq(mint.quotaOf(uint256(keccak256("gm1117"))), 10);
        vm.startPrank(ALICE);
        mint.mint(10, address(0), 10 ether);
        vm.expectRevert(BnagentMint.Quota.selector);
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
        mint.claimSocial(FOLLOW, xAcct, dl, sig);
        uint256 aid = uint256(keccak256("htetwai"));
        assertEq(mint.quotaOf(aid), 11);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.AlreadyGranted.selector);
        mint.claimSocial(FOLLOW, xAcct, dl, sig);
        bytes memory sigB = _signTask(BOB, FOLLOW, xAcct, dl);
        vm.prank(BOB);
        vm.expectRevert(BnagentMint.AlreadyGranted.selector);
        mint.claimSocial(FOLLOW, xAcct, dl, sigB);
        bytes memory wrongUser = _signTask(ALICE, TWEET, keccak256("x:bob"), dl);
        vm.prank(BOB);
        vm.expectRevert(BnagentMint.BadSignature.selector);
        mint.claimSocial(TWEET, keccak256("x:bob"), dl, wrongUser);
        bytes memory late = _signTask(ALICE, TG, keccak256("tg:a"), block.timestamp - 1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.BadSignature.selector);
        mint.claimSocial(TG, keccak256("tg:a"), block.timestamp - 1, late);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.BadTask.selector);
        mint.claimSocial(keccak256("OTHER"), xAcct, dl, sig);
        bytes memory s1 = _signTask(ALICE, TWEET, keccak256("x:alice_handle#tw"), dl);
        bytes memory s2 = _signTask(ALICE, TG, keccak256("tg:alice"), dl);
        vm.startPrank(ALICE);
        mint.claimSocial(TWEET, keccak256("x:alice_handle#tw"), dl, s1);
        mint.claimSocial(TG, keccak256("tg:alice"), dl, s2);
        vm.stopPrank();
        assertEq(mint.quotaOf(aid), 13);
    }

    function test_TransfersClosedBeforeOpen() public {
        vm.prank(ALICE);
        mint.mint(1, address(0), 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.TransfersClosed.selector);
        token.transfer(BOB, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.TransfersClosed.selector);
        token.transfer(address(pair), 1 ether); // nobody can fund the pair before the automatic open
    }

    function test_BnbMintWithRefund() public {
        uint256 need = mint.bnbQuote(3);
        vm.deal(ALICE, 1 ether);
        uint256 tBefore = treasury.balance;
        uint256 uBefore = usdt.balanceOf(treasury);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.OverMaxCost.selector);
        mint.mintWithBnb{value: need}(3, address(0), need - 1);
        vm.prank(ALICE);
        mint.mintWithBnb{value: need + 0.05 ether}(3, address(0), need + 0.05 ether);
        assertEq(ALICE.balance, 1 ether - need, "excess BNB refunded");
        assertEq(token.balanceOf(ALICE), 150_000_000 ether);
        // reference: swap to USDT; 80% of the table cost parked, 20% + any surplus to the treasury
        uint256 d = usdt.balanceOf(treasury) - uBefore;
        assertGe(d, 0.6 ether, "20% of cost to treasury");
        assertLe(d, 0.66 ether, "20% + ~1% headroom surplus");
        assertEq(treasury.balance, tBefore, "treasury receives USDT, not BNB");
        _assertParked();
        uint256 one = mint.bnbQuote(1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentMint.BadPayment.selector);
        mint.mintWithBnb{value: one - 1}(1, address(0), need);
    }

    function test_HardCapEnforcedInToken() public {
        uint256 cap = token.MAX_SUPPLY();
        vm.prank(address(mint));
        vm.expectRevert(BnagentToken.SupplyCap.selector);
        token.mint(ALICE, cap + 1);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.NotMinter.selector);
        token.mint(ALICE, 1);
    }

    /// @notice Reference behaviour: one tx may cross 10,000; the pool opens inside it and later shares are pool-priced.
    function test_OpenInsideCrossingTx() public {
        _bulkMint(9_995 - mint.totalMinted());
        _assertParked();
        assertFalse(mint.opened());
        _newBulkId();
        uint256 k0 = token.balanceOf(bulk);
        uint256 tr0 = usdt.balanceOf(treasury);
        vm.prank(bulk);
        mint.mint(10, address(0), 20 ether);
        assertEq(mint.totalMinted(), 10_005);
        assertTrue(mint.opened());
        assertTrue(token.tradingEnabled(), "transfer lock lifted by the automatic open");
        assertGt(mint.openedTime(), 0);
        (uint256 u, uint256 t) = mint.reserves();
        assertEq(u, 7_120 ether + 5 * 0.88 ether, "7,120 + 80% of 5 x 1.10");
        assertLt(t, 356_000_000_000 ether + 5 * 400_000_000 ether);
        assertGt(token.balanceOf(bulk) - k0, 250_000_000 ether, "5 x 50M + 5 pool-priced shares");
        assertEq(usdt.balanceOf(treasury) - tr0, 5 * 0.2 ether + 5 * 0.22 ether, "20% to treasury");
        assertEq(usdt.balanceOf(address(mint)), 0, "nothing left in the mint contract");
        assertEq(mint.pendingUsdt(), 0);
        assertGt(_lpAtDead(), 0, "LP at dead");
        assertEq(IPairExtra(address(pair)).balanceOf(treasury), 0, "no LP for the team");
    }

    /// @notice As in the reference, renounce() has no precondition; the automatic open still happens afterwards.
    function test_RenounceBeforeOpen() public {
        vm.prank(treasury);
        mint.renounce();
        assertTrue(mint.renounced());
        assertFalse(mint.paused());
        assertTrue(token.blocksDisabled());
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.AdminRenounced.selector);
        mint.setPaused(true);
        _bulkMint(10_000 - mint.totalMinted());
        assertTrue(mint.opened());
        vm.prank(CAROL);
        mint.mint(1, address(0), 1.1 ether);
        assertGt(token.balanceOf(CAROL), 0);
    }

    function test_JagerSelectors() public view {
        assertEq(BnagentMint.mint.selector, bytes4(0x836a1040));
        assertEq(BnagentMint.mintWithBnb.selector, bytes4(0xe38fd349));
        assertEq(BnagentMint.bnbQuote.selector, bytes4(0x68bce8cd));
        assertEq(BnagentMint.costOf.selector, bytes4(keccak256("costOf(uint256)")));
        assertEq(BnagentMint.quotaOf.selector, bytes4(keccak256("quotaOf(uint256)")));
        assertEq(BnagentMint.claimSocial.selector, bytes4(keccak256("claimSocial(bytes32,bytes32,uint256,bytes)")));
        assertEq(BnagentMint.withdrawUnfilled.selector, bytes4(0xa65c6326));
        assertEq(BnagentMint.Minted.selector, keccak256("Minted(address,uint256,uint256,uint256,uint256)"));
        assertEq(BnagentMint.QuotaGranted.selector, keccak256("QuotaGranted(address,uint256,uint256,bytes32)"));
        assertEq(BnagentMint.Opened.selector, keccak256("Opened(uint256,uint256,uint256)"));
        assertEq(mint.SOCIAL_TYPEHASH(), keccak256("Social(address user,bytes32 task,bytes32 account,uint256 deadline)"));
    }

    /// @notice The planned deployment (real dedicated social signer) lands at the address in the plan.
    function test_PlannedDeploymentAddress() public {
        bytes memory init = BscConfig.initCode(BscConfig.SOCIAL_SIGNER);
        vm.prank(treasury);
        (bool ok, bytes memory ret) = BscConfig.CREATE2_PROXY.call(abi.encodePacked(BscConfig.SALT, init));
        require(ok && ret.length == 20, "create2 failed");
        BnagentMint m = BnagentMint(payable(address(bytes20(ret))));
        assertEq(address(m), BscConfig.predicted(BscConfig.SOCIAL_SIGNER));
        assertEq(m.quotaSigner(), BscConfig.SOCIAL_SIGNER);
        assertEq(m.treasury(), BscConfig.TREASURY);
        assertTrue(m.paused());
        assertEq(m.mintStartTime(), 0);
        console2.log("planned mint:", address(m));
        console2.log("planned token:", address(m.token()));
        console2.log("planned pair:", address(m.pair()));
    }

    // ------------------------------------------------------------------ full flow (Jager money model)

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
        _bulkMint(5_000);
        vm.deal(BOB, 1 ether);
        uint256 q = mint.bnbQuote(10);
        uint256 tu = usdt.balanceOf(treasury);
        vm.prank(BOB);
        mint.mintWithBnb{value: q}(10, address(0), q);
        uint256 d = usdt.balanceOf(treasury) - tu;
        assertGe(d, 2 ether, "20% + surplus to treasury");
        usdPaidInBnb += 10 ether;
        usdtFromBnb += d + 8 ether; // swap output = parked 8 + treasury part
        _bulkMint(9_990 - mint.totalMinted());
        _assertParked();
        assertEq(mint.pendingUsdt(), 7_112 ether, "8,890 sold x 0.80");
        assertFalse(mint.opened());
        (uint256 u, uint256 t) = mint.reserves();
        assertEq(u + t, 0, "pair empty before 10,000");

        // ALICE's tx covers 9,991..10,000 and opens the pool automatically
        uint256 tr0 = usdt.balanceOf(treasury);
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        assertEq(usdt.balanceOf(treasury) - tr0, 2 ether);
        assertEq(mint.totalMinted(), 10_000);
        assertEq(token.balanceOf(ALICE), 500_000_000 ether);
        assertTrue(mint.opened());
        assertTrue(token.tradingEnabled());
        assertEq(mint.openedTime(), block.timestamp);
        (u, t) = mint.reserves();
        assertEq(u, 7_120 ether, "8,900 sold x 0.80");
        assertEq(t, 356_000_000_000 ether, "7,120 x 50M (pre-pool price)");
        assertEq(mint.pendingUsdt(), 0);
        assertEq(mint.pendingTokens(), 0);
        assertEq(usdt.balanceOf(address(mint)), 0);
        assertEq(token.balanceOf(address(mint)), 0);
        assertEq(token.totalSupply(), 801_000_000_000 ether, "445B users + 356B pool (8,900 sold shares)");
        assertEq(_lpAtDead() + 1_000, IPairExtra(address(pair)).totalSupply(), "all LP at dead (+ MINIMUM_LIQUIDITY)");
        assertEq(usdt.balanceOf(treasury) - treasuryUsdt0, 1_780 ether - 2 ether + (usdtFromBnb - 8 ether), "20% of 8,900");
        // withdrawUnfilled is gone for good once the pool is open (past-deadline case: test_ValveNeverAfterPoolOpens)
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.AlreadyOpen.selector);
        mint.withdrawUnfilled();
        assertFalse(mint.canWithdrawUnfilled());
    }

    function _flowPhase2Start() internal {
        (uint256 u, uint256 t) = mint.reserves();
        uint256 p0 = _poolPrice();
        uint256 lp0 = _lpAtDead();
        uint256 expectTokens = 1.1 ether * t * 10_000 / (u * 9_900);
        uint256 tr0 = usdt.balanceOf(treasury);
        vm.prank(CAROL);
        mint.mint(1, address(0), 1.1 ether);
        assertEq(token.balanceOf(CAROL), expectTokens, "phase-2 tokens at 99% of pool price");
        assertEq(usdt.balanceOf(treasury) - tr0, 0.22 ether, "20% to treasury");
        (uint256 u2,) = mint.reserves();
        assertEq(u2, u + 0.88 ether, "80% into the pool");
        assertGt(_lpAtDead(), lp0, "new LP to dead");
        assertGt(_poolPrice(), p0, "floor burn raised price");
        assertLe(_poolPrice(), p0 * 1_008_001 / 1_000_000);

        vm.prank(ALICE);
        token.transfer(BOB, 1_000 ether);
        assertEq(token.balanceOf(BOB), 1_000 ether + 500_000_000 ether);

        otherPair = IV2Factory(BscConfig.PANCAKE_V2_FACTORY).createPair(address(token), BscConfig.WBNB);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.PoolRejected.selector);
        token.transfer(otherPair, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.PoolRejected.selector);
        token.transfer(BscConfig.V4_POOL_MANAGER, 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.PoolRejected.selector);
        token.transfer(BscConfig.INFINITY_VAULT, 1 ether);
    }

    function _flowTaxes() internal {
        address trader = address(0x7EADE5);
        uint256 mintBalBefore = token.balanceOf(address(mint));
        uint256 got = _buy(trader, 50 ether);
        uint256 taxIn = token.balanceOf(address(mint)) - mintBalBefore;
        assertApproxEqAbs(taxIn * 99, got, 100, "buy tax = 1%");

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

        vm.roll(block.number + 1);
        uint256 held = token.balanceOf(address(mint));
        (, uint256 tr) = mint.reserves();
        _bulkMint(10);
        uint256 converted = held - token.balanceOf(address(mint));
        assertGt(treasury.balance, treasuryBnb0, "treasury received BNB from tax");
        assertLe(converted, tr * 10 / 10_000 + 1, "tax swap cap 0.1% of pool");
        vm.expectRevert(BnagentMint.SwappedThisBlock.selector);
        mint.swapTax();
    }

    function _flowAdminAndBulk() internal {
        vm.startPrank(treasury);
        vm.expectRevert(BnagentMint.NotBlockable.selector);
        mint.setPoolBlocked(ALICE, true);
        vm.expectRevert(BnagentMint.NotBlockable.selector);
        mint.setPoolBlocked(BscConfig.PANCAKE_V2_ROUTER, true);
        vm.expectRevert(BnagentMint.NotBlockable.selector);
        mint.setPoolBlocked(address(pair), true);
        mint.setPoolBlocked(BscConfig.WBNB, true);
        vm.stopPrank();
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.PoolRejected.selector);
        token.transfer(BscConfig.WBNB, 1 ether);

        burnsA = _bulkMint(15_000 - mint.totalMinted());
        vm.deal(CAROL, 1 ether);
        uint256 q = mint.bnbQuote(5);
        uint256 c5 = mint.costOf(5);
        uint256 tu = usdt.balanceOf(treasury);
        vm.prank(CAROL);
        mint.mintWithBnb{value: q}(5, address(0), q);
        uint256 d = usdt.balanceOf(treasury) - tu;
        assertGe(d, c5 * 2 / 10, "20% + surplus");
        usdPaidInBnb += c5;
        usdtFromBnb += d + c5 * 8 / 10;
        burnsA += _bulkMint(20_000 - mint.totalMinted());
        assertEq(mint.priceCents(mint.totalMinted() + 1), 210);

        vm.prank(treasury);
        mint.renounce();
        assertTrue(mint.renounced());
        assertFalse(mint.paused());
        assertTrue(token.blocksDisabled());
        vm.prank(ALICE);
        token.transfer(BscConfig.WBNB, 1 ether);
        vm.startPrank(treasury);
        vm.expectRevert(BnagentMint.AdminRenounced.selector);
        mint.setPaused(true);
        vm.expectRevert(BnagentMint.AdminRenounced.selector);
        mint.setPoolBlocked(otherPair, true);
        vm.stopPrank();
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.PoolRejected.selector);
        token.transfer(otherPair, 1 ether);
    }

    function _flowEnd() internal {
        burnsB = _bulkMint(30_000 - mint.totalMinted());
        assertEq(mint.totalMinted(), 30_000);
        assertEq(mint.totalPaid(), 46_300 ether, "total paid = sellable price table");
        assertEq(mint.soldShares(), 28_900);
        _newBulkId();
        vm.prank(bulk);
        vm.expectRevert(BnagentMint.SoldOut.selector);
        mint.mint(1, address(0), 10 ether);
        assertLe(token.totalSupply(), token.MAX_SUPPLY());
        assertEq(usdt.balanceOf(address(mint)), 0, "mint contract keeps no USDT");
        // treasury USDT = 20% of every share + BNB swap surplus
        uint256 surplus = usdtFromBnb - usdPaidInBnb;
        assertEq(usdt.balanceOf(treasury) - treasuryUsdt0, 9_260 ether + surplus, "20% of 46,300 + BNB surplus");
        assertGt(treasury.balance, treasuryBnb0, "tax BNB to treasury");
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.AlreadyOpen.selector);
        mint.withdrawUnfilled();

        (uint256 u, uint256 t) = mint.reserves();
        uint256 circ = mint.circulating();
        console2.log("mint txs with floor burn, shares 10,001-20,000:", burnsA);
        console2.log("mint txs with floor burn, shares 20,001-30,000:", burnsB);
        console2.log("final pool USDT (wei):", u);
        console2.log("final pool BNAGENT (tokens):", t / 1e18);
        console2.log("final total supply (tokens):", token.totalSupply() / 1e18);
        console2.log("final circulating (tokens):", circ / 1e18);
        console2.log("dead balance (tokens):", token.balanceOf(mint.DEAD()) / 1e18);
        console2.log("circ value at pool price (USDT):", circ * u / t / 1e18);
        console2.log("floor line (USDT):", mint.floorValue() / 1e18);
        console2.log("treasury USDT gained:", (usdt.balanceOf(treasury) - treasuryUsdt0) / 1e18);
        console2.log("treasury BNB gained (wei):", treasury.balance - treasuryBnb0);
    }

    // ------------------------------------------------------------------ griefing on the empty pair

    /// @notice USDT donated to the empty pair + sync() (reserves USDT>0, token=0) cannot brick the automatic open.
    function test_GriefEmptyPairDonateAndSync() public {
        address griefer = address(0x6121EF);
        deal(BscConfig.USDT, griefer, 100_000 ether);
        vm.startPrank(griefer);
        usdt.transfer(address(pair), 1); // dust
        pair.sync();
        vm.expectRevert(); // a USDT-only first mint is impossible (sqrt(x*0) - 1000 underflows)
        pair.mint(griefer);
        vm.stopPrank();
        _bulkMint(5_000);
        // and a large donation + sync mid-way
        vm.startPrank(griefer);
        usdt.transfer(address(pair), 50_000 ether);
        pair.sync();
        vm.stopPrank();
        // minters cannot put BNAGENT into the pair before the open
        vm.prank(ALICE);
        mint.mint(1, address(0), 1 ether);
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.TransfersClosed.selector);
        token.transfer(address(pair), 1 ether);
        assertEq(IPairExtra(address(pair)).totalSupply(), 0, "no LP can exist before the open");

        _bulkMint(10_000 - mint.totalMinted());
        assertTrue(mint.opened(), "opened despite the griefing");
        assertTrue(token.tradingEnabled());
        (uint256 u, uint256 t) = mint.reserves();
        assertEq(u, 7_120 ether + 50_000 ether + 1, "donations absorbed into the pool");
        assertEq(t, 356_000_000_000 ether);
        assertGt(_lpAtDead(), 0);
        // post-open minting keeps working
        vm.prank(CAROL);
        mint.mint(1, address(0), 1.1 ether);
        assertGt(token.balanceOf(CAROL), 0);
    }

    /// @notice USDT donated without sync() cannot brick the automatic open either. skim() reverts before the open
    ///         (it also moves a 0-BNAGENT transfer out of the pair, which the transfer lock refuses), as in the reference.
    function test_GriefEmptyPairDonateNoSyncAndSkim() public {
        address griefer = address(0x6121F0);
        deal(BscConfig.USDT, griefer, 100 ether);
        vm.startPrank(griefer);
        usdt.transfer(address(pair), 7 ether);
        vm.expectRevert(); // Pancake: TRANSFER_FAILED (token transfer out of the pair is locked pre-open)
        IPairExtra(address(pair)).skim(griefer);
        vm.stopPrank();
        _bulkMint(10_000 - mint.totalMinted());
        assertTrue(mint.opened());
        (uint256 u, uint256 t) = mint.reserves();
        assertEq(u, 7_127 ether);
        assertEq(t, 356_000_000_000 ether);
        _assertNoLpOutsideDead();
    }

    function _assertNoLpOutsideDead() internal view {
        assertEq(_lpAtDead() + 1_000, IPairExtra(address(pair)).totalSupply());
    }

    // ------------------------------------------------------------------ 30-day safety valve

    function test_ValveClockStartsOnFirstUnpauseOnly() public {
        assertEq(mint.mintStartTime(), startTs);
        assertEq(mint.mintDeadline(), startTs + 30 days);
        vm.prank(treasury);
        mint.setPaused(true);
        vm.warp(block.timestamp + 5 days);
        vm.prank(treasury);
        mint.setPaused(false);
        assertEq(mint.mintStartTime(), startTs, "re-unpausing does not restart the clock");
    }

    function test_ValveNeverStartedNeverWithdrawable() public {
        vm.prank(treasury);
        BnagentMint m = new BnagentMint(BscConfig.params(signer));
        assertEq(m.mintStartTime(), 0);
        assertEq(m.mintDeadline(), 0);
        vm.warp(block.timestamp + 365 days);
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.DeadlineNotReached.selector);
        m.withdrawUnfilled();
        // renounce() also unpauses, so it starts the clock
        vm.prank(treasury);
        m.renounce();
        assertEq(m.mintStartTime(), block.timestamp);
    }

    function test_ValveBeforeDeadlineReverts() public {
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.DeadlineNotReached.selector);
        mint.withdrawUnfilled();
        vm.warp(startTs + 30 days); // exactly at the deadline: still closed
        assertFalse(mint.canWithdrawUnfilled());
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.DeadlineNotReached.selector);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(address(mint)), 8 ether);
    }

    function test_ValveNonTreasuryReverts() public {
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        vm.warp(startTs + 30 days + 1);
        address[4] memory who = [ALICE, BOB, NOBODY, address(mint)];
        for (uint256 i; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert(BnagentMint.NotTreasury.selector);
            mint.withdrawUnfilled();
        }
        assertEq(usdt.balanceOf(address(mint)), 8 ether);
    }

    function test_ValveAfterDeadlineWithdrawsAndMintingContinues() public {
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        vm.deal(BOB, 1 ether);
        uint256 q = mint.bnbQuote(3);
        vm.prank(BOB);
        mint.mintWithBnb{value: q}(3, address(0), q);
        assertEq(usdt.balanceOf(address(mint)), 10.4 ether);
        vm.warp(startTs + 30 days + 1);
        assertTrue(mint.canWithdrawUnfilled());
        (, uint256 dl, uint256 nW, uint256 held, bool w,, uint256 pU, uint256 pT) = mint.valve();
        assertEq(dl, startTs + 30 days);
        assertEq(nW, 0);
        assertEq(held, 10.4 ether);
        assertEq(pU, 10.4 ether);
        assertEq(pT, 13 * mint.POOL_SHARE());
        assertTrue(w);

        uint256 t0 = usdt.balanceOf(treasury);
        uint256 supply0 = token.totalSupply();
        vm.expectEmit(true, false, false, true, address(mint));
        emit BnagentMint.UnfilledWithdrawn(treasury, 10.4 ether, 13 * 40_000_000 ether, 1_113);
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t0, 10.4 ether, "parked 80% to treasury");
        assertEq(usdt.balanceOf(address(mint)), 0);
        assertEq(mint.pendingUsdt(), 0);
        assertEq(mint.pendingTokens(), 0);
        assertEq(token.balanceOf(address(mint)), 0);
        assertEq(token.balanceOf(mint.DEAD()), 13 * 40_000_000 ether, "parked tokens to dead");
        assertEq(token.totalSupply(), supply0, "dead tokens stay in supply (cap stays conservative)");
        assertEq(mint.unfilledWithdrawals(), 1);
        assertEq(mint.totalUnfilledWithdrawn(), 10.4 ether);
        assertFalse(mint.paused(), "minting continues");
        assertEq(mint.mintableNow(), 30_000 - 1_113);
        assertTrue(mint.canWithdrawUnfilled(), "repeatable");

        // minting continues after the withdraw (USDT; the BNB feed is stale on a warped fork)
        vm.prank(CAROL);
        mint.mint(5, address(0), 5 ether);
        assertEq(mint.totalMinted(), 1_118);
        assertEq(mint.pendingUsdt(), 4 ether);
        assertEq(mint.pendingTokens(), 5 * mint.POOL_SHARE());
        assertEq(token.balanceOf(CAROL), 5 * mint.USER_SHARE());

        // second withdraw takes only what was parked since the first one
        uint256 t1 = usdt.balanceOf(treasury);
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t1, 4 ether);
        assertEq(mint.unfilledWithdrawals(), 2);
        assertEq(mint.totalUnfilledWithdrawn(), 14.4 ether);
        assertEq(token.balanceOf(mint.DEAD()), 18 * 40_000_000 ether);
        // a withdraw with nothing parked is allowed and moves nothing
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(mint.unfilledWithdrawals(), 3);
        assertEq(usdt.balanceOf(treasury) - t1, 4 ether);

        // tokens stay non-transferable until the pool opens; no pool, no tax swap
        vm.prank(ALICE);
        vm.expectRevert(BnagentToken.TransfersClosed.selector);
        token.transfer(BOB, 1 ether);
        assertFalse(token.tradingEnabled());
        vm.expectRevert(BnagentMint.NotOpen.selector);
        mint.swapTax();
    }

    /// @notice Withdraw after day 30, keep minting, withdraw again, then reach share 10,000: the pool opens with
    ///         only the USDT/tokens parked after the last withdraw, at the pre-pool price, LP to dead.
    function test_ValveWithdrawThenPoolOpensWithParkedSinceLastWithdraw() public {
        _bulkMint(5_000 - mint.totalMinted()); // 3,900 sold
        vm.warp(startTs + 30 days + 1);
        uint256 t0 = usdt.balanceOf(treasury);
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t0, 3_120 ether, "3,900 x 0.80");
        _bulkMint(8_000 - mint.totalMinted()); // +3,000
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t0, 3_120 ether + 2_400 ether + 3_000 * 0.2 ether, "second withdraw + 20% cuts");
        _bulkMint(9_990 - mint.totalMinted()); // +1,990 parked since the last withdraw
        assertEq(mint.pendingUsdt(), 1_990 * 0.8 ether);
        _bulkMint(10);
        assertTrue(mint.opened());
        assertTrue(token.tradingEnabled());
        (uint256 u, uint256 t) = mint.reserves();
        assertEq(u, 2_000 * 0.8 ether, "pool USDT = parked since last withdraw (1,600)");
        assertEq(t, 2_000 * 40_000_000 ether, "pool tokens = parked since last withdraw (80B)");
        assertEq(mint.pendingUsdt(), 0);
        assertEq(mint.pendingTokens(), 0);
        assertEq(usdt.balanceOf(address(mint)), 0);
        assertGt(_lpAtDead(), 0);
        _assertNoLpOutsideDead();
        assertEq(token.balanceOf(mint.DEAD()), 6_900 * 40_000_000 ether, "withdrawn shares' pool tokens at dead");
        assertLe(token.totalSupply(), token.MAX_SUPPLY());
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.AlreadyOpen.selector);
        mint.withdrawUnfilled();
        assertFalse(mint.canWithdrawUnfilled());
        // curve minting after the open still works on the smaller pool
        uint256 supplyBefore = token.totalSupply();
        _bulkMint(1_000);
        assertEq(mint.totalMinted(), 11_000);
        assertGt(token.totalSupply(), supplyBefore);
        assertLe(token.totalSupply(), token.MAX_SUPPLY());
        (uint256 u2,) = mint.reserves();
        assertGt(u2, u);
    }

    function test_ValveWorksAfterRenounce() public {
        vm.prank(ALICE);
        mint.mint(5, address(0), 5 ether);
        vm.prank(treasury);
        mint.renounce();
        vm.warp(startTs + 31 days);
        uint256 t0 = usdt.balanceOf(treasury);
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t0, 4 ether);
        assertFalse(mint.paused());
        vm.prank(BOB);
        mint.mint(1, address(0), 1 ether);
        assertEq(mint.pendingUsdt(), 0.8 ether);
        vm.prank(treasury);
        mint.withdrawUnfilled();
        assertEq(usdt.balanceOf(treasury) - t0, 4.8 ether + 0.2 ether);
    }

    /// @notice Past the deadline but not yet withdrawn: a mint that reaches 10,000 opens the pool normally,
    ///         and from then on withdrawUnfilled() can never be called.
    function test_ValveNeverAfterPoolOpens() public {
        _bulkMint(9_990 - mint.totalMinted());
        vm.warp(startTs + 30 days + 1);
        assertTrue(mint.canWithdrawUnfilled());
        _bulkMint(10);
        assertTrue(mint.opened());
        assertFalse(mint.canWithdrawUnfilled());
        vm.prank(treasury);
        vm.expectRevert(BnagentMint.AlreadyOpen.selector);
        mint.withdrawUnfilled();
        (uint256 u,) = mint.reserves();
        assertEq(u, 7_120 ether);
    }

    /// @notice Shares #1-#1,100 are burned at deploy: no tokens, no USDT; selling starts at #1,101 for 1 USDT.
    function test_BurnedShares() public {
        assertEq(mint.BURNED_SHARES(), 1_100);
        assertEq(mint.SELLABLE_SHARES(), 28_900);
        assertEq(mint.totalMinted(), 1_100);
        assertEq(mint.soldShares(), 0);
        assertEq(mint.totalPaid(), 0);
        assertEq(token.totalSupply(), 0, "no tokens for burned shares");
        assertEq(mint.mintableNow(), 28_900);
        assertEq(mint.costOf(1), 1 ether);
        assertEq(mint.costOf(10), 10 ether);
        vm.expectEmit(true, true, false, true, address(mint));
        emit BnagentMint.Minted(ALICE, uint256(keccak256("htetwai")), 1_101, 10, 10 ether);
        vm.prank(ALICE);
        mint.mint(10, address(0), 10 ether);
        assertEq(mint.totalMinted(), 1_110);
        assertEq(mint.soldShares(), 10);
        assertEq(mint.totalPaid(), 10 ether);
    }
}

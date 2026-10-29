// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BnagentToken} from "./BnagentToken.sol";
import {IV2Factory, IV2Pair, IWrappedNative, IAgentIdRegistry, IPriceFeed, V2Math} from "./interfaces/IExternal.sol";

/// @title BNAGENT mint
/// @notice Same mechanism and public interface as the $JAGENT mint (BSC 0x3643…2aB8), with only these
///         intended differences (docs/JAGER-DIFF.md):
///         (a) 30,000 shares; the reference price table truncated at 30,000 (47,400 USDT in total).
///         (b) 4.44T cap; floor line paid x 83,492 / 46,300 (same ~1.8033x ratio); pool floor 116,666,667.
///         (c) name BNAGENT; treasury 0x49E6…9BCE; own social-task signer.
///         (e) shares #1-#1,100 are burned at deploy (never sold, no tokens, no USDT): selling starts at #1,101
///             (table price at that index), 28,900 sellable. The pool still opens on the tx reaching share 10,000,
///             with the USDT actually parked (80% of 8,900 paid shares = 7,120) and the tokens actually parked at
///             the same pre-pool price (40M per 0.80 USDT = 50M per USDT -> 356B).
///         (d) 30-day safety valve: the clock starts when minting is first unpaused. If share 10,000 (the
///             automatic pool opening) has not been reached after MINT_WINDOW, only the treasury may call
///             withdrawUnfilled(): the USDT parked here (the 80%) goes to the treasury, the tokens parked for the
///             pool are sent to dead, and MINTING CONTINUES. It can be called again and again after the deadline
///             until the pool opens; a pool that opens later is seeded only with what was parked after the last
///             withdraw. Never callable before the deadline or once the pool has opened. No other withdraw path.
///         Money flow = reference: shares up to 10,000 pay 1 USDT, give 50M tokens and park 0.80 USDT plus
///         40M tokens for the opening pool (20% to the treasury). Share 10,000 opens the official pair with
///         everything parked (7,120 USDT + 356B tokens) in the same transaction, LP to dead. From share 10,001 the buyer gets
///         tokens at 99% of the pool price, 20% goes to the treasury, 80% is paired into the pool at the pool
///         price (LP to dead), and pool inventory is sent to dead while the circulating value is below the
///         floor line, by at most 0.8% per transaction, never below POOL_TOKEN_FLOOR.
contract BnagentMint is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SHARES = 30_000;
    uint256 public constant MAX_SUPPLY = 4_440_000_000_000 ether;
    uint256 public constant OPEN_AT = 10_000;
    /// @notice BNAGENT: shares #1-#1,100 are burned at deploy (never sold; no tokens, no USDT).
    uint256 public constant BURNED_SHARES = 1_100;
    uint256 public constant SELLABLE_SHARES = TOTAL_SHARES - BURNED_SHARES; // 28,900
    uint256 public constant USER_SHARE = 50_000_000 ether;
    uint256 public constant POOL_SHARE = 40_000_000 ether;
    uint256 public constant TREASURY_BPS = 2_000;
    uint256 public constant MINT_PRICE_BPS = 9_900;
    /// @notice BNAGENT safety valve: time after the first unpause before withdrawUnfilled() may be called.
    uint256 public constant MINT_WINDOW = 30 days;
    /// @dev Reference: 50,000,000 / 27,727,060. LINE_DENOM = price of the 28,900 sellable shares
    ///      (#1,101-#30,000: 47,400 - 1,100 = 46,300); FLOOR_LINE = 46,300 x 50,000,000 / 27,727,060 = 83,492.4
    ///      -> 83,492 (same ~1.8033x ratio).
    uint256 public constant FLOOR_LINE = 83_492;
    uint256 public constant CEIL_LINE = 100_191; // 46,300 x 60,000,000 / 27,727,060 (view only, as in the reference)
    uint256 public constant LINE_DENOM = 46_300;
    uint256 public constant RISE_NUM = 1_008;
    uint256 public constant RISE_DEN = 1_000;
    /// @dev Reference 11,666,666,667 under a 444T cap, scaled by the cap ratio 1/100.
    uint256 public constant POOL_TOKEN_FLOOR = 116_666_667 ether;
    uint256 public constant TAX_SWAP_BPS = 10;
    uint256 public constant BNB_EXTRA_BPS = 100;
    uint256 public constant BASE_PER_ID = 10;
    uint256 public constant MAX_PER_TX = 10;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes32 public constant TASK_FOLLOW = keccak256("FOLLOW");
    bytes32 public constant TASK_TWEET = keccak256("TWEET");
    bytes32 public constant TASK_TELEGRAM = keccak256("TELEGRAM");
    bytes32 public constant REASON_INVITE = keccak256("INVITE");
    bytes32 public constant SOCIAL_TYPEHASH =
        keccak256("Social(address user,bytes32 task,bytes32 account,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    BnagentToken public immutable token;
    IERC20 public immutable usdt;
    IV2Pair public immutable pair;
    IV2Pair public immutable wbnbPair;
    address public immutable wbnb;
    IAgentIdRegistry public immutable registrar;
    IPriceFeed public immutable feed;
    address public immutable treasury;
    address public immutable quotaSigner;
    uint256 public immutable swapFeeBps;
    uint256 public immutable feedHeartbeat;
    uint256 public immutable feedMin;
    uint256 public immutable feedMax;
    bool private immutable _usdtIs0;

    /// @dev Starts at BURNED_SHARES: the first sold share is #1,101.
    uint256 public totalMinted = BURNED_SHARES;
    uint256 public totalPaid;
    bool public paused = true;
    bool public renounced;
    uint256 public pendingUsdt;
    uint256 public pendingTokens;
    uint256 public openedTime;
    /// @notice Set once, by the first setPaused(false) (or renounce(), which also unpauses). 0 = never started.
    uint256 public mintStartTime;
    /// @notice Number of withdrawUnfilled() calls so far (minting is never closed by them).
    uint256 public unfilledWithdrawals;
    /// @notice Total USDT sent to the treasury by withdrawUnfilled() calls.
    uint256 public totalUnfilledWithdrawn;
    uint256 public lastTaxSwapBlock;

    mapping(uint256 => uint256) public mintedCount;
    mapping(uint256 => uint256) public extraQuota;
    mapping(uint256 => bool) public paidOnce;
    mapping(uint256 => mapping(bytes32 => bool)) public socialDone;
    /// @dev An X or Telegram account counts only for the first Agent ID that uses it.
    mapping(bytes32 => uint256) public accountAgent;
    mapping(address => bool) public unblockable;

    event PausedSet(bool paused);
    event Renounced();
    event Minted(address indexed minter, uint256 indexed agentTokenId, uint256 firstSerial, uint256 shares, uint256 paid);
    event QuotaGranted(address indexed user, uint256 indexed agentTokenId, uint256 extra, bytes32 reason);
    event SharesBurned(uint256 firstSerial, uint256 lastSerial);
    event MintStarted(uint256 startTime, uint256 deadline);
    event UnfilledWithdrawn(address indexed treasury, uint256 usdtAmount, uint256 tokensToDead, uint256 totalMinted);
    event Opened(uint256 usdtIn, uint256 tokensIn, uint256 lp);
    event PoolBurned(uint256 atShare, uint256 amount);
    event TaxSwapped(uint256 tokensIn, uint256 bnbOut);
    event TaxSwapFailed(bytes reason);

    error NotTreasury();
    error Paused();
    error AdminRenounced();
    error BadShares();
    error SoldOut();
    error NoAgent();
    error Quota();
    error OverMaxCost();
    error BadPayment();
    error StalePrice();
    error SwapShort();
    error RefundFailed();
    error PayoutFailed();
    error AlreadyGranted();
    error BadTask();
    error BadSignature();
    error NotBlockable();
    error NotOpen();
    error AlreadyOpen();
    error NotSeeded();
    error DeadlineNotReached();
    error NothingToSwap();
    error SwappedThisBlock();
    error OnlySelf();
    error ZeroAddress();

    struct Params {
        address usdt;
        address v2Factory;
        address v4PoolManager;
        address v4Vault;
        address agentRegistry;
        address treasury;
        address socialSigner;
        address bnbUsdFeed;
        address wbnb;
        uint256 v2FeeBps;
        uint256 feedMaxAge;
        uint256 feedMinAnswer;
        uint256 feedMaxAnswer;
        address[] neverBlockable;
    }

    constructor(Params memory c) {
        if (
            c.usdt == address(0) || c.v2Factory == address(0) || c.agentRegistry == address(0)
                || c.treasury == address(0) || c.socialSigner == address(0) || c.bnbUsdFeed == address(0)
                || c.wbnb == address(0)
        ) revert ZeroAddress();
        // The token is created here so this contract is its minter without an initialize() call
        // (the CREATE2 deployer proxy used for deployment cannot make follow-up calls).
        token = new BnagentToken(c.usdt, c.v2Factory, c.v4PoolManager, c.v4Vault);
        usdt = IERC20(c.usdt);
        pair = IV2Pair(token.pair());
        wbnb = c.wbnb;
        wbnbPair = IV2Pair(IV2Factory(c.v2Factory).getPair(c.usdt, c.wbnb));
        if (address(wbnbPair) == address(0)) revert ZeroAddress();
        registrar = IAgentIdRegistry(c.agentRegistry);
        feed = IPriceFeed(c.bnbUsdFeed);
        treasury = c.treasury;
        quotaSigner = c.socialSigner;
        swapFeeBps = c.v2FeeBps;
        feedHeartbeat = c.feedMaxAge;
        feedMin = c.feedMinAnswer;
        feedMax = c.feedMaxAnswer;
        _usdtIs0 = pair.token0() == c.usdt;
        for (uint256 i; i < c.neverBlockable.length; i++) {
            unblockable[c.neverBlockable[i]] = true;
        }
        emit SharesBurned(1, BURNED_SHARES);
    }

    receive() external payable {
        if (msg.sender != wbnb) revert BadPayment();
    }

    // ---------------------------------------------------------------- views

    /// @notice Reference price table, truncated at 30,000 shares (cents).
    function priceCents(uint256 n) public pure returns (uint256) {
        if (n <= 10_000) return 100;
        if (n <= 20_000) return 110 + 10 * ((n - 10_001) / 1_000);
        return 210 + 2 * ((n - 20_001) / 1_000);
    }

    function costOf(uint256 shares) public view returns (uint256 cost) {
        uint256 n = totalMinted;
        for (uint256 i; i < shares; i++) {
            cost += priceCents(n + 1 + i) * 1e16;
        }
    }

    function quotaOf(uint256 id) public view returns (uint256) {
        return BASE_PER_ID + extraQuota[id];
    }

    function opened() public view returns (bool) {
        return totalMinted >= OPEN_AT;
    }

    function reserves() public view returns (uint256 rUsdt, uint256 rToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rUsdt, rToken) = _usdtIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function circulating() public view returns (uint256) {
        return token.totalSupply() - token.balanceOf(address(pair)) - token.balanceOf(DEAD)
            - token.balanceOf(address(this));
    }

    function floorValue() public view returns (uint256) {
        return totalPaid * FLOOR_LINE / LINE_DENOM;
    }

    function ceilValue() public view returns (uint256) {
        return totalPaid * CEIL_LINE / LINE_DENOM;
    }

    /// @notice BNB the next `shares` cost at the Chainlink price plus 1% swap headroom.
    function bnbQuote(uint256 shares) public view returns (uint256) {
        return _bnbFor(costOf(shares));
    }

    // -- extra read-only helpers for the website / agents (not in the reference; no state effect)

    /// @notice End of the 30-day window (0 while minting has never been unpaused).
    function mintDeadline() public view returns (uint256) {
        uint256 start = mintStartTime;
        return start == 0 ? 0 : start + MINT_WINDOW;
    }

    /// @notice True when the treasury's withdrawUnfilled() would succeed now (caller check aside).
    function canWithdrawUnfilled() public view returns (bool) {
        uint256 d = mintDeadline();
        return d != 0 && block.timestamp > d && !opened();
    }

    /// @notice Shares sold so far (excludes the 1,100 burned).
    function soldShares() public view returns (uint256) {
        return totalMinted - BURNED_SHARES;
    }

    /// @notice Shares that can still be minted.
    function mintableNow() public view returns (uint256) {
        return TOTAL_SHARES - totalMinted;
    }

    function agentOf(address account) external view returns (uint256 id, bool ok) {
        return _agent(account);
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("BnagentMint"), keccak256("1"), block.chainid, address(this)));
    }

    function overview()
        external
        view
        returns (
            uint256 minted,
            uint256 paid,
            bool isPaused,
            bool isOpen,
            uint256 nextPriceCents,
            uint256 rUsdt,
            uint256 rToken,
            uint256 supply,
            uint256 circ,
            uint256 floor,
            uint256 mintable
        )
    {
        minted = totalMinted;
        paid = totalPaid;
        isPaused = paused;
        isOpen = opened();
        nextPriceCents = minted < TOTAL_SHARES ? priceCents(minted + 1) : 0;
        if (isOpen) (rUsdt, rToken) = reserves();
        supply = token.totalSupply();
        circ = circulating();
        floor = floorValue();
        mintable = mintableNow();
    }

    /// @notice 30-day safety valve state for the website / agents.
    function valve()
        external
        view
        returns (
            uint256 startTime,
            uint256 deadlineTime,
            uint256 withdrawals,
            uint256 heldUsdt,
            bool withdrawable,
            uint256 withdrawnUsdt,
            uint256 parkedUsdt,
            uint256 parkedTokens
        )
    {
        startTime = mintStartTime;
        deadlineTime = mintDeadline();
        withdrawals = unfilledWithdrawals;
        heldUsdt = usdt.balanceOf(address(this));
        withdrawable = canWithdrawUnfilled();
        withdrawnUsdt = totalUnfilledWithdrawn;
        parkedUsdt = pendingUsdt;
        parkedTokens = pendingTokens;
    }

    function walletStatus(address account)
        external
        view
        returns (bool ok, uint256 id, uint256 minted, uint256 quota, bool paid)
    {
        (id, ok) = _agent(account);
        if (ok) {
            minted = mintedCount[id];
            quota = quotaOf(id);
            paid = paidOnce[id];
        }
    }

    // ---------------------------------------------------------------- treasury

    function _onlyTreasury() private view {
        if (msg.sender != treasury) revert NotTreasury();
        if (renounced) revert AdminRenounced();
    }

    function setPaused(bool next) external {
        _onlyTreasury();
        if (!next) _startClock();
        paused = next;
        emit PausedSet(next);
    }

    function _startClock() private {
        if (mintStartTime != 0) return;
        mintStartTime = block.timestamp;
        emit MintStarted(block.timestamp, block.timestamp + MINT_WINDOW);
    }

    function setPoolBlocked(address pool, bool blocked) external {
        _onlyTreasury();
        if (
            pool == address(pair) || pool == address(this) || pool == treasury || pool == address(token)
                || pool == DEAD || unblockable[pool] || pool.code.length == 0 || _is7702(pool)
        ) revert NotBlockable();
        token.setPoolBlocked(pool, blocked);
    }

    /// @notice Gives up pause and pool blocking for good. Minting stays running.
    function renounce() external {
        _onlyTreasury();
        _startClock();
        renounced = true;
        paused = false;
        token.disableBlocks();
        emit Renounced();
    }

    /// @notice BNAGENT safety valve. Only the treasury address (immutable; not an admin power, so it keeps
    ///         working after renounce()) and only after the 30-day deadline, while share 10,000 has not been
    ///         reached. Sends every USDT this contract holds (the parked 80% of payments, plus any stray USDT
    ///         sent here) to the treasury and resets the parked USDT to 0. The tokens parked for the pool
    ///         (40M per share) are sent to the dead address and the parked token counter is reset, so a pool
    ///         that opens later still opens at the pre-pool price (50M per USDT) with only what was parked after
    ///         this call. Dead tokens stay counted in totalSupply, so the 4.44T cap can never be exceeded.
    ///         MINTING CONTINUES. Repeatable any number of times until the pool opens; never after.
    function withdrawUnfilled() external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        if (opened()) revert AlreadyOpen();
        uint256 d = mintDeadline();
        if (d == 0 || block.timestamp <= d) revert DeadlineNotReached();
        uint256 tokensOut = pendingTokens;
        pendingUsdt = 0;
        pendingTokens = 0;
        unfilledWithdrawals += 1;
        if (tokensOut > 0) IERC20(address(token)).safeTransfer(DEAD, tokensOut);
        uint256 amount = usdt.balanceOf(address(this));
        totalUnfilledWithdrawn += amount;
        if (amount > 0) usdt.safeTransfer(treasury, amount);
        emit UnfilledWithdrawn(treasury, amount, tokensOut, totalMinted);
    }

    function _is7702(address a) private view returns (bool) {
        if (a.code.length != 23) return false;
        bytes memory code = a.code;
        return code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    // ---------------------------------------------------------------- quota

    function claimSocial(bytes32 task, bytes32 account, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert BadSignature();
        if (task != TASK_FOLLOW && task != TASK_TWEET && task != TASK_TELEGRAM) revert BadTask();
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(SOCIAL_TYPEHASH, msg.sender, task, account, deadline))
            )
        );
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || got != quotaSigner) revert BadSignature();
        (uint256 id, bool ok) = _agent(msg.sender);
        if (!ok) revert NoAgent();
        if (socialDone[id][task]) revert AlreadyGranted();
        uint256 bound = accountAgent[account];
        if (bound != 0 && bound != id) revert AlreadyGranted();
        socialDone[id][task] = true;
        accountAgent[account] = id;
        extraQuota[id] += 1;
        emit QuotaGranted(msg.sender, id, 1, task);
    }

    function _agent(address from) internal view returns (uint256 id, bool ok) {
        try registrar.handleOf(from) returns (string memory handle) {
            if (bytes(handle).length == 0) return (0, false);
            id = uint256(keccak256(bytes(handle)));
            try registrar.ownerOf(id) returns (address owner) {
                ok = owner == from;
            } catch {
                ok = false;
            }
        } catch {
            ok = false;
        }
    }

    function _creditInvite(address from, uint256 id, address referrer) private {
        if (referrer == address(0) || referrer == from) return;
        (uint256 rid, bool rok) = _agent(referrer);
        if (!rok || rid == id) return;
        extraQuota[rid] += 1;
        emit QuotaGranted(referrer, rid, 1, REASON_INVITE);
    }

    // ---------------------------------------------------------------- mint

    function mint(uint256 shares, address referrer, uint256 maxCost) external nonReentrant {
        uint256 id = _check(shares);
        uint256 cost = costOf(shares);
        if (cost > maxCost) revert OverMaxCost();
        usdt.safeTransferFrom(msg.sender, address(this), cost);
        _mintShares(id, shares, cost, 0, referrer);
    }

    /// @notice `maxCost` is in BNB wei. Shares are priced in USDT, converted at the Chainlink BNB/USD
    ///         price plus 1%, swapped to USDT, and any USDT above the price table goes to the treasury.
    ///         BNB above the quote is refunded.
    function mintWithBnb(uint256 shares, address referrer, uint256 maxCost) external payable nonReentrant {
        uint256 id = _check(shares);
        uint256 cost = costOf(shares);
        uint256 need = _bnbFor(cost);
        if (need > maxCost) revert OverMaxCost();
        if (msg.value < need) revert BadPayment();
        uint256 got = _swapBnbForUsdt(need);
        if (got < cost) revert SwapShort();
        _mintShares(id, shares, cost, got - cost, referrer);
        uint256 refund = msg.value - need;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _check(uint256 shares) private view returns (uint256 id) {
        if (paused) revert Paused();
        if (shares == 0 || shares > MAX_PER_TX) revert BadShares();
        if (totalMinted + shares > TOTAL_SHARES) revert SoldOut();
        bool ok;
        (id, ok) = _agent(msg.sender);
        if (!ok) revert NoAgent();
        if (mintedCount[id] + shares > quotaOf(id)) revert Quota();
    }

    struct Pool {
        uint256 u;
        uint256 t;
        uint256 startU;
        uint256 startT;
        uint256 circ;
        uint256 supply;
        uint256 addU;
        uint256 addT;
        uint256 burnT;
        uint256 userT;
    }

    function _mintShares(uint256 id, uint256 shares, uint256 cost, uint256 extraUsdt, address referrer) private {
        mintedCount[id] += shares;
        if (!paidOnce[id]) {
            paidOnce[id] = true;
            _creditInvite(msg.sender, id, referrer);
        }
        uint256 first = totalMinted + 1;
        uint256 toTreasury = extraUsdt;
        Pool memory p;
        bool live = opened();
        if (live) _loadPool(p);

        for (uint256 n = first; n < first + shares; n++) {
            uint256 pay = priceCents(n) * 1e16;
            uint256 cut = pay * TREASURY_BPS / 10_000;
            toTreasury += cut;
            totalPaid += pay;
            if (n <= OPEN_AT) {
                p.userT += USER_SHARE;
                pendingUsdt += pay - cut;
                pendingTokens += POOL_SHARE;
                token.mint(address(this), POOL_SHARE);
                if (n == OPEN_AT) {
                    token.mint(msg.sender, p.userT);
                    p.userT = 0;
                    _open();
                    live = true;
                    _loadPool(p);
                }
            } else {
                _curveShare(p, n, pay - cut);
            }
        }
        totalMinted = first + shares - 1;

        if (p.userT > 0) token.mint(msg.sender, p.userT);
        if (live && p.addU > 0) _settle(p);
        if (toTreasury > 0) usdt.safeTransfer(treasury, toTreasury);
        emit Minted(msg.sender, id, first, shares, cost);

        if (live && lastTaxSwapBlock != block.number && token.balanceOf(address(this)) > 0) {
            try this.swapTaxSelf() {}
            catch (bytes memory why) {
                emit TaxSwapFailed(why);
            }
        }
    }

    function _loadPool(Pool memory p) private view {
        (p.u, p.t) = reserves();
        p.startU = p.u;
        p.startT = p.t;
        p.circ = circulating();
        p.supply = token.totalSupply();
    }

    /// @dev Works on the pool as it will be after this share. All shares of the
    ///      transaction are settled into the pair together at the end, which leaves
    ///      the same reserves as adding and burning share by share.
    function _curveShare(Pool memory p, uint256 n, uint256 lpUsdt) private {
        uint256 pay = priceCents(n) * 1e16;
        uint256 userT = pay * p.t * 10_000 / (p.u * MINT_PRICE_BPS);
        uint256 lpT = (lpUsdt * p.t + p.u - 1) / p.u;
        p.supply += userT + lpT;
        if (p.supply > MAX_SUPPLY) revert SoldOut();
        p.userT += userT;
        p.circ += userT;
        p.u += lpUsdt;
        p.t += lpT;
        p.addU += lpUsdt;
        p.addT += lpT;

        uint256 line = totalPaid * FLOOR_LINE / LINE_DENOM;
        if (p.circ * p.u / p.t >= line) return;
        uint256 byTarget = (p.u * p.circ + line - 1) / line;
        uint256 byRise = (p.u * p.startT * RISE_DEN + p.startU * RISE_NUM - 1) / (p.startU * RISE_NUM);
        uint256 next = byTarget > byRise ? byTarget : byRise;
        if (next < POOL_TOKEN_FLOOR) next = POOL_TOKEN_FLOOR;
        if (next >= p.t) return;
        uint256 burn = p.t - next;
        p.t = next;
        p.burnT += burn;
        emit PoolBurned(n, burn);
    }

    function _settle(Pool memory p) private {
        usdt.safeTransfer(address(pair), p.addU);
        token.mint(address(pair), p.addT);
        pair.mint(DEAD);
        if (p.burnT > 0) {
            token.burnFromPair(p.burnT);
        }
        pair.sync();
    }

    /// @dev Reference _open, with the amounts taken from what is actually parked instead of the reference's
    ///      hard-coded 8,000 USDT / 400B: with 1,100 burned shares that is 8,900 x 0.80 = 7,120 USDT and
    ///      8,900 x 40M = 356B tokens (the pre-pool price, 50M per USDT). The parked counters (not the raw
    ///      USDT balance) are used so USDT donated to this contract cannot change the opening amounts or push
    ///      the token mint over the cap; such a donation stays here.
    ///      Griefing: before this tx nobody can put BNAGENT into the pair (transfers are locked to mint-contract
    ///      sends, and skim() reverts), so the pair can never have LP supply before opening. USDT donated to the
    ///      empty pair (with or without sync()) is simply absorbed: pair.mint() credits balance - reserve, i.e.
    ///      exactly what is sent here, and the donation stays in the pool. Fork-tested in test_GriefEmptyPair*.
    function _open() private {
        uint256 usdtIn = pendingUsdt;
        uint256 tokensIn = pendingTokens;
        if (usdtIn == 0 || tokensIn == 0) revert NotSeeded();
        pendingUsdt = 0;
        pendingTokens = 0;
        usdt.safeTransfer(address(pair), usdtIn);
        IERC20(address(token)).safeTransfer(address(pair), tokensIn);
        uint256 lp = pair.mint(DEAD);
        token.enableTrading();
        pair.sync();
        openedTime = block.timestamp;
        emit Opened(usdtIn, tokensIn, lp);
    }

    // ---------------------------------------------------------------- bnb

    function _bnbFor(uint256 usdAmount) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || block.timestamp > updatedAt + feedHeartbeat) revert StalePrice();
        uint256 px = uint256(answer);
        if (px < feedMin || px > feedMax) revert StalePrice();
        uint256 withExtra = usdAmount * (10_000 + BNB_EXTRA_BPS) / 10_000;
        return (withExtra * 10 ** feed.decimals() + px - 1) / px;
    }

    function _swapBnbForUsdt(uint256 bnbIn) private returns (uint256 usdtOut) {
        IWrappedNative(wbnb).deposit{value: bnbIn}();
        IERC20(wbnb).safeTransfer(address(wbnbPair), bnbIn);
        uint256 before = usdt.balanceOf(address(this));
        _swapOn(wbnbPair, wbnb, address(this));
        usdtOut = usdt.balanceOf(address(this)) - before;
    }

    function _swapOn(IV2Pair lp, address tokenIn, address to) private {
        (uint112 r0, uint112 r1,) = lp.getReserves();
        bool inIs0 = lp.token0() == tokenIn;
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 actualIn = IERC20(tokenIn).balanceOf(address(lp)) - rIn;
        uint256 out = V2Math.getOut(actualIn, rIn, rOut, swapFeeBps);
        (uint256 out0, uint256 out1) = inIs0 ? (uint256(0), out) : (out, uint256(0));
        lp.swap(out0, out1, to, "");
    }

    // ---------------------------------------------------------------- tax

    /// @notice Anyone may swap held tax tokens to BNB for the treasury, once per block,
    ///         at most 0.1% of the pool's token reserve each time.
    function swapTax() external nonReentrant {
        if (!opened()) revert NotOpen();
        if (lastTaxSwapBlock == block.number) revert SwappedThisBlock();
        _swapTax();
    }

    function swapTaxSelf() external {
        if (msg.sender != address(this)) revert OnlySelf();
        _swapTax();
    }

    function _swapTax() private {
        (, uint256 rToken) = reserves();
        uint256 amount = token.balanceOf(address(this));
        uint256 cap = rToken * TAX_SWAP_BPS / 10_000;
        if (amount > cap) amount = cap;
        if (amount == 0) revert NothingToSwap();
        lastTaxSwapBlock = block.number;
        IERC20(address(token)).safeTransfer(address(pair), amount);
        _swapOn(pair, address(token), address(wbnbPair));
        uint256 before = IERC20(wbnb).balanceOf(address(this));
        _swapOn(wbnbPair, address(usdt), address(this));
        uint256 bnbOut = IERC20(wbnb).balanceOf(address(this)) - before;
        IWrappedNative(wbnb).withdraw(bnbOut);
        (bool ok,) = treasury.call{value: bnbOut}("");
        if (!ok) revert PayoutFailed();
        emit TaxSwapped(amount, bnbOut);
    }
}

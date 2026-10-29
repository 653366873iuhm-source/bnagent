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
///         (a) 100% of every payment goes to the treasury in the same transaction (USDT is pulled
///             buyer -> treasury; BNB is swapped to USDT exactly like the reference and all of it is sent
///             to the treasury). Nothing is parked for the pool. Share 10,000 mints OPEN_TOKENS (400B) to
///             the treasury, which adds the opening liquidity itself and then calls the one-time
///             openTrading(). Shares after 10,000 can only be minted once trading is open.
///         (b) 30,000 shares; the reference price table truncated at 30,000.
///         (c) 4.44T cap; floor line paid x 85,477 / 47,400 (same ~1.8033x ratio); pool floor 116,666,667.
///         (d) name BNAGENT.
///         Shares up to 10,000 pay 1 USDT and give 50M tokens. After trading opens the buyer gets
///         tokens at 99% of the pool price, and pool inventory is sent to dead while the circulating
///         value is below the floor line, by at most 0.8% per transaction, never below POOL_TOKEN_FLOOR.
contract BnagentMint is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SHARES = 30_000;
    uint256 public constant MAX_SUPPLY = 4_440_000_000_000 ether;
    uint256 public constant OPEN_AT = 10_000;
    uint256 public constant USER_SHARE = 50_000_000 ether;
    /// @notice Minted to the treasury with share 10,000 for the opening liquidity it adds itself.
    uint256 public constant OPEN_TOKENS = 400_000_000_000 ether;
    uint256 public constant MINT_PRICE_BPS = 9_900;
    /// @dev Reference: 50,000,000 / 27,727,060. LINE_DENOM = price of all 30,000 shares (47,400);
    ///      FLOOR_LINE = 47,400 x 50,000,000 / 27,727,060 = 85,476.6 -> 85,477 (same ~1.8033x ratio).
    uint256 public constant FLOOR_LINE = 85_477;
    uint256 public constant CEIL_LINE = 102_572; // 47,400 x 60,000,000 / 27,727,060 (view only, as in the reference)
    uint256 public constant LINE_DENOM = 47_400;
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

    uint256 public totalMinted;
    uint256 public totalPaid;
    bool public paused = true;
    bool public renounced;
    uint256 public openedTime;
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
    event OpenTokensMinted(address indexed treasury, uint256 amount);
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
    error NoLiquidity();
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
        token = new BnagentToken(c.usdt, c.v2Factory, c.v4PoolManager, c.v4Vault, c.treasury);
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

    /// @notice True once the treasury has called openTrading() (the reference opens at share 10,000).
    function opened() public view returns (bool) {
        return token.tradingEnabled();
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

    /// @notice True when openTrading() would succeed now (caller check aside).
    function canOpenTrading() public view returns (bool) {
        if (opened() || totalMinted < OPEN_AT) return false;
        (uint256 u, uint256 t) = reserves();
        return u > 0 && t > 0 && pair.totalSupply() > 0;
    }

    /// @notice Shares that can be minted right now in total (before trading opens, minting stops at 10,000).
    function mintableNow() public view returns (uint256) {
        uint256 cap = opened() ? TOTAL_SHARES : OPEN_AT;
        return totalMinted >= cap ? 0 : cap - totalMinted;
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
        paused = next;
        emit PausedSet(next);
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
        renounced = true;
        paused = false;
        token.disableBlocks();
        emit Renounced();
    }

    /// @notice BNAGENT difference: one-time, treasury-only switch replacing the reference's automatic
    ///         open at share 10,000. Needs share 10,000 sold and liquidity in the official pair. Not an
    ///         admin power (works after renounce), cannot be undone.
    function openTrading() external {
        if (msg.sender != treasury) revert NotTreasury();
        if (opened()) revert AlreadyOpen();
        if (totalMinted < OPEN_AT) revert NotOpen();
        (uint256 u, uint256 t) = reserves();
        uint256 lp = pair.totalSupply();
        if (u == 0 || t == 0 || lp == 0) revert NoLiquidity();
        token.enableTrading();
        openedTime = block.timestamp;
        emit Opened(u, t, lp);
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
        usdt.safeTransferFrom(msg.sender, treasury, cost);
        _mintShares(id, shares, cost, referrer);
    }

    /// @notice `maxCost` is in BNB wei. Shares are priced in USDT, converted at the Chainlink BNB/USD
    ///         price plus 1%, swapped to USDT, and all of that USDT goes to the treasury. BNB above the
    ///         quote is refunded.
    function mintWithBnb(uint256 shares, address referrer, uint256 maxCost) external payable nonReentrant {
        uint256 id = _check(shares);
        uint256 cost = costOf(shares);
        uint256 need = _bnbFor(cost);
        if (need > maxCost) revert OverMaxCost();
        if (msg.value < need) revert BadPayment();
        uint256 got = _swapBnbForUsdt(need);
        if (got < cost) revert SwapShort();
        usdt.safeTransfer(treasury, got);
        _mintShares(id, shares, cost, referrer);
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
        // BNAGENT: the reference opens the pool inside share 10,000; here shares after 10,000 wait for openTrading().
        if (totalMinted + shares > OPEN_AT && !opened()) revert NotOpen();
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
        uint256 burnT;
        uint256 userT;
    }

    function _mintShares(uint256 id, uint256 shares, uint256 cost, address referrer) private {
        mintedCount[id] += shares;
        if (!paidOnce[id]) {
            paidOnce[id] = true;
            _creditInvite(msg.sender, id, referrer);
        }
        uint256 first = totalMinted + 1;
        Pool memory p;
        bool live = opened();
        if (live) _loadPool(p);

        for (uint256 n = first; n < first + shares; n++) {
            uint256 pay = priceCents(n) * 1e16;
            totalPaid += pay;
            if (n <= OPEN_AT) {
                p.userT += USER_SHARE;
                if (n == OPEN_AT) {
                    token.mint(treasury, OPEN_TOKENS);
                    emit OpenTokensMinted(treasury, OPEN_TOKENS);
                }
            } else {
                _curveShare(p, n, pay);
            }
        }
        totalMinted = first + shares - 1;

        if (p.userT > 0) token.mint(msg.sender, p.userT);
        if (p.burnT > 0) {
            token.burnFromPair(p.burnT);
            pair.sync();
        }
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

    /// @dev Reference _curveShare with the 80% LP add removed (100% of the payment goes to the treasury).
    function _curveShare(Pool memory p, uint256 n, uint256 pay) private {
        uint256 userT = pay * p.t * 10_000 / (p.u * MINT_PRICE_BPS);
        p.supply += userT;
        if (p.supply > MAX_SUPPLY) revert SoldOut();
        p.userT += userT;
        p.circ += userT;

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

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BnagentToken} from "./BnagentToken.sol";
import {
    IV2Factory, IV2Pair, IWrappedNative, IAgentIdRegistry, IPriceFeed, V2Math
} from "./interfaces/IExternal.sol";

/// @title BNAGENT fair mint
/// @notice Shares are sold to Binance Agentic Wallets that hold a `.ai` Agent ID.
///
///  Payments: 100% of every payment goes straight to the treasury in the same transaction
///  (USDT via transferFrom buyer -> treasury; BNB is forwarded as BNB). This contract never
///  holds mint proceeds and never adds, locks or burns liquidity.
///
///  Shares 1 .. 10,000 (1 USDT each), and any later share sold before trading opens: the buyer
///  receives 50,000,000 BNAGENT per share.
///
///  Share 10,000: the transaction that mints it also mints LP_TOKENS (400,000,000,000 BNAGENT) to
///  the treasury, which pairs them with USDT on the official PancakeSwap BNAGENT/USDT pair itself
///  (the pair is created at deployment; it is the only pool the token accepts).
///
///  openTrading(): one-time treasury call, possible only after share 10,000 and once the official
///  pair holds liquidity. It unlocks transfers (buy 1%, sell 1% burn + 1% fee, wallets 0%).
///
///  After trading opens: buyers receive BNAGENT at 99% of the pool price. While the pool value of
///  circulating BNAGENT is below the floor line (totalPaid * FLOOR_NUM / FLOOR_DEN, about 1.80x the
///  USDT paid in), pool inventory is burned (pair.sync), raising the pool price by at most 0.8% per
///  transaction and never leaving fewer than POOL_MIN_TOKENS in the pool.
///
///  The treasury can pause/unpause minting and block/unblock pool contracts until it calls
///  renounce() (allowed only after trading opens), which removes both powers forever.
contract BnagentMint is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ parameters
    uint256 public constant TOTAL_SHARES = 30_000;
    uint256 public constant OPEN_AT_SHARE = 10_000;
    uint256 public constant TOKENS_PER_SHARE = 50_000_000 ether; // to the buyer, phase 1
    /// @notice Minted to the treasury with share 10,000 for the liquidity it adds itself (400B).
    uint256 public constant LP_TOKENS = 400_000_000_000 ether;
    uint256 public constant BUY_AT_BPS = 9_900; // phase-2 buyers pay 99% of the pool price
    /// @dev Floor line = totalPaid * FLOOR_NUM / FLOOR_DEN. FLOOR_DEN is the USDT price of all
    ///      30,000 shares (47,400). FLOOR_NUM keeps the reference ratio 50,000,000 / 27,727,060
    ///      (= 1.80330...): 47,400 * 1.80330 = 85,476.6 -> 85,477 (ratio 1.80331).
    uint256 public constant FLOOR_NUM = 85_477;
    uint256 public constant CEIL_NUM = 102_572; // 47,400 * 60,000,000 / 27,727,060, informational only
    uint256 public constant FLOOR_DEN = 47_400;
    uint256 public constant MAX_RISE_NUM = 1_008; // +0.8% pool price per transaction at most
    uint256 public constant MAX_RISE_DEN = 1_000;
    /// @dev Reference 11,666,666,667 tokens under a 444T cap; scaled by the cap ratio (4.44T / 444T = 1/100).
    uint256 public constant POOL_MIN_TOKENS = 116_666_667 ether;
    /// @dev Tax swap size cap: 0.10% of the pool's BNAGENT reserve per swap (relative, so unchanged).
    uint256 public constant TAX_SWAP_BPS = 10;
    uint256 public constant BNB_PREMIUM_BPS = 100; // Chainlink price + 1%
    uint256 public constant BASE_QUOTA = 10;
    uint256 public constant MAX_SHARES_PER_TX = 10;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    bytes32 public constant TASK_FOLLOW = keccak256("FOLLOW");
    bytes32 public constant TASK_TWEET = keccak256("TWEET");
    bytes32 public constant TASK_TELEGRAM = keccak256("TELEGRAM");
    bytes32 public constant REASON_INVITE = keccak256("INVITE");
    bytes32 public constant SOCIAL_CLAIM_TYPEHASH =
        keccak256("SocialClaim(address user,bytes32 task,bytes32 account,uint256 deadline)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ------------------------------------------------------------------ wiring
    BnagentToken public immutable token;
    IERC20 public immutable usdt;
    IV2Pair public immutable pair;
    IV2Pair public immutable bnbUsdtPair;
    address public immutable wbnb;
    IAgentIdRegistry public immutable agentRegistry;
    IPriceFeed public immutable bnbUsdFeed;
    address public immutable treasury;
    address public immutable socialSigner;
    uint256 public immutable v2FeeBps;
    uint256 public immutable feedMaxAge;
    uint256 public immutable feedMinAnswer;
    uint256 public immutable feedMaxAnswer;
    bool private immutable _usdtIsToken0;

    // ------------------------------------------------------------------ state
    uint256 public totalMinted;
    uint256 public totalPaid;
    bool public paused = true;
    bool public renounced;
    bool public lpTokensMinted;
    uint256 public openedAt; // timestamp of openTrading()
    uint256 public lastTaxSwapBlock;

    mapping(uint256 => uint256) public sharesMintedBy; // agent id => shares
    mapping(uint256 => uint256) public bonusQuota; // agent id => extra shares
    mapping(uint256 => bool) public hasPaid; // agent id => made a paid mint
    mapping(uint256 => mapping(bytes32 => bool)) public taskDone; // agent id => task => done
    mapping(bytes32 => uint256) public socialAccountOwner; // hashed X/TG account => agent id
    mapping(address => bool) public neverBlockable;

    event PauseChanged(bool paused);
    event AdminRenounced();
    event SharesMinted(
        address indexed buyer, uint256 indexed agentId, uint256 firstShare, uint256 shares, uint256 paidUsdt
    );
    event QuotaAdded(address indexed account, uint256 indexed agentId, uint256 amount, bytes32 reason);
    event LpTokensMinted(address indexed to, uint256 amount);
    event TradingOpened(uint256 usdtReserve, uint256 tokenReserve);
    event Payment(address indexed payer, address indexed treasury, uint256 usdtAmount, uint256 bnbAmount);
    event FloorBurn(uint256 atShare, uint256 tokens);
    event TaxConverted(uint256 tokensIn, uint256 bnbOut);
    event TaxConvertFailed(bytes reason);

    error ZeroAddr();
    error NotTreasury();
    error RenouncedAlready();
    error MintPaused();
    error InvalidShares();
    error SoldOut();
    error NoAgentId();
    error OverQuota();
    error CostAboveMax();
    error PaymentInvalid();
    error FeedInvalid();
    error RefundFailed();
    error PayoutFailed();
    error UnknownTask();
    error ClaimInvalid();
    error AlreadyClaimed();
    error CannotBlock();
    error PoolNotOpen();
    error NothingToConvert();
    error OneSwapPerBlock();
    error SelfOnly();
    error TradingNotReady();
    error TradingAlreadyOpen();
    error TradingNotOpen();

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

    constructor(Params memory p) {
        if (
            p.usdt == address(0) || p.v2Factory == address(0) || p.agentRegistry == address(0)
                || p.treasury == address(0) || p.socialSigner == address(0) || p.bnbUsdFeed == address(0)
                || p.wbnb == address(0)
        ) revert ZeroAddr();
        // The token is created here so that this contract is its minter without an initialize step
        // (the CREATE2 deployer proxy could not call one).
        token = new BnagentToken(p.usdt, p.v2Factory, p.v4PoolManager, p.v4Vault, p.treasury);
        usdt = IERC20(p.usdt);
        pair = IV2Pair(token.pair());
        wbnb = p.wbnb;
        bnbUsdtPair = IV2Pair(IV2Factory(p.v2Factory).getPair(p.usdt, p.wbnb));
        if (address(bnbUsdtPair) == address(0)) revert ZeroAddr();
        agentRegistry = IAgentIdRegistry(p.agentRegistry);
        bnbUsdFeed = IPriceFeed(p.bnbUsdFeed);
        treasury = p.treasury;
        socialSigner = p.socialSigner;
        v2FeeBps = p.v2FeeBps;
        feedMaxAge = p.feedMaxAge;
        feedMinAnswer = p.feedMinAnswer;
        feedMaxAnswer = p.feedMaxAnswer;
        _usdtIsToken0 = pair.token0() == p.usdt;
        for (uint256 i; i < p.neverBlockable.length; i++) {
            neverBlockable[p.neverBlockable[i]] = true;
        }
    }

    /// @dev Only WBNB unwrapping may send BNB here; a plain BNB transfer does not mint.
    receive() external payable {
        if (msg.sender != wbnb) revert PaymentInvalid();
    }

    // ------------------------------------------------------------------ views

    /// @notice Price of share number `n` (1-based), in USD cents.
    function sharePriceCents(uint256 n) public pure returns (uint256) {
        if (n <= 10_000) return 100;
        if (n <= 20_000) return 110 + 10 * ((n - 10_001) / 1_000);
        return 210 + 2 * ((n - 20_001) / 1_000);
    }

    /// @notice USDT (18 decimals) for the next `shares` shares.
    function quote(uint256 shares) public view returns (uint256 cost) {
        uint256 n = totalMinted;
        for (uint256 i = 1; i <= shares; i++) {
            cost += sharePriceCents(n + i) * 1e16;
        }
    }

    /// @notice BNB needed for the next `shares` shares at Chainlink BNB/USD plus 1%.
    function bnbQuote(uint256 shares) public view returns (uint256) {
        return _usdToBnb(quote(shares));
    }

    function quotaOf(uint256 agentId) public view returns (uint256) {
        return BASE_QUOTA + bonusQuota[agentId];
    }

    /// @notice True once the treasury has called openTrading() (transfers live, pool pricing).
    function isOpen() public view returns (bool) {
        return token.tradingOpen();
    }

    /// @notice True when openTrading() would succeed now (ignoring the caller check).
    function canOpenTrading() public view returns (bool) {
        if (isOpen() || totalMinted < OPEN_AT_SHARE) return false;
        (uint256 u, uint256 t) = poolReserves();
        return u > 0 && t > 0 && pair.totalSupply() > 0;
    }

    function poolReserves() public view returns (uint256 usdtReserve, uint256 tokenReserve) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (usdtReserve, tokenReserve) = _usdtIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// @notice Supply outside the pair, the dead address and this contract.
    function circulatingSupply() public view returns (uint256) {
        return token.totalSupply() - token.balanceOf(address(pair)) - token.balanceOf(DEAD)
            - token.balanceOf(address(this));
    }

    function floorLine() public view returns (uint256) {
        return totalPaid * FLOOR_NUM / FLOOR_DEN;
    }

    function ceilLine() public view returns (uint256) {
        return totalPaid * CEIL_NUM / FLOOR_DEN;
    }

    /// @notice Resolves the Agent ID held by `account`: id = uint256(keccak256(handle)).
    function agentIdOf(address account) public view returns (uint256 id, bool valid) {
        return _resolveAgent(account);
    }

    /// @notice One-call snapshot for front ends.
    function overview()
        external
        view
        returns (
            uint256 minted,
            uint256 paid,
            bool isPaused,
            bool open,
            uint256 nextSharePriceCents,
            uint256 usdtReserve,
            uint256 tokenReserve,
            uint256 supply,
            uint256 circulating,
            uint256 line
        )
    {
        minted = totalMinted;
        paid = totalPaid;
        isPaused = paused;
        open = isOpen();
        nextSharePriceCents = minted < TOTAL_SHARES ? sharePriceCents(minted + 1) : 0;
        if (open) (usdtReserve, tokenReserve) = poolReserves();
        supply = token.totalSupply();
        circulating = circulatingSupply();
        line = floorLine();
    }

    /// @notice Per-wallet mint status for front ends and agents.
    function walletStatus(address account)
        external
        view
        returns (bool eligible, uint256 agentId, uint256 minted, uint256 quota, bool paidBefore)
    {
        (agentId, eligible) = _resolveAgent(account);
        if (eligible) {
            minted = sharesMintedBy[agentId];
            quota = quotaOf(agentId);
            paidBefore = hasPaid[agentId];
        }
    }

    // ------------------------------------------------------------------ admin (until renounce)

    function _requireAdmin() private view {
        if (msg.sender != treasury) revert NotTreasury();
        if (renounced) revert RenouncedAlready();
    }

    function setPaused(bool value) external {
        _requireAdmin();
        paused = value;
        emit PauseChanged(value);
    }

    /// @notice Block or unblock a contract acting as a BNAGENT trading pool. Wallets, EIP-7702
    ///         accounts, routers in `neverBlockable`, the official pair and core addresses cannot be blocked.
    function setPoolBlocked(address pool, bool blocked) external {
        _requireAdmin();
        if (
            pool == address(pair) || pool == address(this) || pool == treasury || pool == address(token)
                || pool == DEAD || neverBlockable[pool] || pool.code.length == 0 || _isDelegatedEoa(pool)
        ) revert CannotBlock();
        token.setBlockedPool(pool, blocked);
    }

    /// @notice One-time switch that unlocks BNAGENT transfers. Treasury only; requires share 10,000
    ///         to be sold and the official pair to hold liquidity (both reserves > 0, LP minted).
    ///         Cannot be undone. Not affected by renounce() (which itself requires trading open).
    function openTrading() external {
        if (msg.sender != treasury) revert NotTreasury();
        if (isOpen()) revert TradingAlreadyOpen();
        if (totalMinted < OPEN_AT_SHARE) revert TradingNotReady();
        (uint256 u, uint256 t) = poolReserves();
        if (u == 0 || t == 0 || pair.totalSupply() == 0) revert TradingNotReady();
        token.openTrading();
        openedAt = block.timestamp;
        emit TradingOpened(u, t);
    }

    /// @notice Permanently gives up pausing and pool blocking. Minting is left running.
    ///         Only possible after openTrading(), so the treasury keeps its controls until then.
    function renounce() external {
        _requireAdmin();
        if (!isOpen()) revert TradingNotOpen();
        renounced = true;
        paused = false;
        token.retireBlocking();
        emit AdminRenounced();
    }

    function _isDelegatedEoa(address a) private view returns (bool) {
        if (a.code.length != 23) return false;
        bytes memory c = a.code;
        return c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    // ------------------------------------------------------------------ quota

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("BnagentMint"), keccak256("1"), block.chainid, address(this))
        );
    }

    /// @notice +1 share of quota for a social task, proven by an EIP-712 signature from `socialSigner`.
    ///         `account` is a hash of the X / Telegram account; it can count for one Agent ID only.
    function claimTask(bytes32 task, bytes32 account, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert ClaimInvalid();
        if (task != TASK_FOLLOW && task != TASK_TWEET && task != TASK_TELEGRAM) revert UnknownTask();
        bytes32 structHash = keccak256(abi.encode(SOCIAL_CLAIM_TYPEHASH, msg.sender, task, account, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
        (address signer, ECDSA.RecoverError rerr,) = ECDSA.tryRecover(digest, signature);
        if (rerr != ECDSA.RecoverError.NoError || signer != socialSigner) revert ClaimInvalid();
        (uint256 id, bool valid) = _resolveAgent(msg.sender);
        if (!valid) revert NoAgentId();
        if (taskDone[id][task]) revert AlreadyClaimed();
        uint256 owner = socialAccountOwner[account];
        if (owner != 0 && owner != id) revert AlreadyClaimed();
        taskDone[id][task] = true;
        socialAccountOwner[account] = id;
        bonusQuota[id] += 1;
        emit QuotaAdded(msg.sender, id, 1, task);
    }

    function _resolveAgent(address account) internal view returns (uint256 id, bool valid) {
        try agentRegistry.handleOf(account) returns (string memory handle) {
            if (bytes(handle).length == 0) return (0, false);
            id = uint256(keccak256(bytes(handle)));
            try agentRegistry.ownerOf(id) returns (address holder) {
                valid = holder == account;
            } catch {
                valid = false;
            }
        } catch {
            valid = false;
        }
    }

    function _rewardInviter(address buyer, uint256 buyerId, address inviter) private {
        if (inviter == address(0) || inviter == buyer) return;
        (uint256 inviterId, bool valid) = _resolveAgent(inviter);
        if (!valid || inviterId == buyerId) return;
        bonusQuota[inviterId] += 1;
        emit QuotaAdded(inviter, inviterId, 1, REASON_INVITE);
    }

    // ------------------------------------------------------------------ mint

    /// @notice Pay in USDT (approve first). Reverts if the exact cost exceeds `maxCost`.
    function mint(uint256 shares, address referrer, uint256 maxCost) external nonReentrant {
        uint256 id = _preflight(shares);
        uint256 cost = quote(shares);
        if (cost > maxCost) revert CostAboveMax();
        usdt.safeTransferFrom(msg.sender, treasury, cost);
        emit Payment(msg.sender, treasury, cost, 0);
        _issue(id, shares, cost, referrer);
    }

    /// @notice Pay in BNB. `maxCost` is in BNB wei. The quoted BNB (Chainlink price + 1%) is forwarded
    ///         to the treasury as BNB (no swap); BNB above the quote is refunded to the sender.
    function mintWithBnb(uint256 shares, address referrer, uint256 maxCost) external payable nonReentrant {
        uint256 id = _preflight(shares);
        uint256 cost = quote(shares);
        uint256 bnbNeeded = _usdToBnb(cost);
        if (bnbNeeded > maxCost) revert CostAboveMax();
        if (msg.value < bnbNeeded) revert PaymentInvalid();
        (bool paidOk,) = treasury.call{value: bnbNeeded}("");
        if (!paidOk) revert PayoutFailed();
        emit Payment(msg.sender, treasury, 0, bnbNeeded);
        _issue(id, shares, cost, referrer);
        uint256 change = msg.value - bnbNeeded;
        if (change > 0) {
            (bool ok,) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _preflight(uint256 shares) private view returns (uint256 id) {
        if (paused) revert MintPaused();
        if (shares == 0 || shares > MAX_SHARES_PER_TX) revert InvalidShares();
        if (totalMinted + shares > TOTAL_SHARES) revert SoldOut();
        bool valid;
        (id, valid) = _resolveAgent(msg.sender);
        if (!valid) revert NoAgentId();
        if (sharesMintedBy[id] + shares > quotaOf(id)) revert OverQuota();
    }

    /// @dev Working copy of the pool for one transaction (used only after trading opens).
    struct Book {
        uint256 u; // USDT reserve (no USDT is added by mints)
        uint256 t; // token reserve after floor burns so far in this tx
        uint256 u0; // reserves at the start of this tx
        uint256 t0;
        uint256 circ;
        uint256 supply;
        uint256 burnTokens;
        uint256 buyerTokens;
    }

    function _issue(uint256 id, uint256 shares, uint256 cost, address referrer) private {
        sharesMintedBy[id] += shares;
        if (!hasPaid[id]) {
            hasPaid[id] = true;
            _rewardInviter(msg.sender, id, referrer);
        }
        uint256 firstShare = totalMinted + 1;
        uint256 lastShare = totalMinted + shares;
        Book memory b;
        bool live = isOpen(); // cannot change inside this loop
        if (live) _loadBook(b);

        for (uint256 n = firstShare; n <= lastShare; n++) {
            uint256 price = sharePriceCents(n) * 1e16;
            totalPaid += price;
            if (live) {
                _liveShare(b, n, price);
            } else {
                b.buyerTokens += TOKENS_PER_SHARE;
                if (n == OPEN_AT_SHARE) _mintLpTokens();
            }
        }
        totalMinted = lastShare;

        if (b.buyerTokens > 0) token.mint(msg.sender, b.buyerTokens);
        if (b.burnTokens > 0) {
            token.burnPairInventory(b.burnTokens);
            pair.sync();
        }
        emit SharesMinted(msg.sender, id, firstShare, shares, cost);

        if (live && lastTaxSwapBlock != block.number && token.balanceOf(address(this)) > 0) {
            try this.convertTaxInternal() {}
            catch (bytes memory reason) {
                emit TaxConvertFailed(reason);
            }
        }
    }

    function _mintLpTokens() private {
        lpTokensMinted = true;
        token.mint(treasury, LP_TOKENS);
        emit LpTokensMinted(treasury, LP_TOKENS);
    }

    function _loadBook(Book memory b) private view {
        (b.u, b.t) = poolReserves();
        b.u0 = b.u;
        b.t0 = b.t;
        b.circ = circulatingSupply();
        b.supply = token.totalSupply();
    }

    /// @dev One share after trading opened: tokens at 99% of the pool price, then the floor-line burn.
    ///      Mints add no liquidity, so only the token reserve changes (burns), written once per tx.
    function _liveShare(Book memory b, uint256 n, uint256 price) private {
        uint256 buyerAmt = price * b.t * 10_000 / (b.u * BUY_AT_BPS);
        b.supply += buyerAmt;
        if (b.supply > token.HARD_CAP()) revert SoldOut();
        b.buyerTokens += buyerAmt;
        b.circ += buyerAmt;

        uint256 line = totalPaid * FLOOR_NUM / FLOOR_DEN;
        if (b.circ * b.u / b.t >= line) return;
        // Token reserve that would put circulating value on the line ...
        uint256 targetT = (b.u * b.circ + line - 1) / line;
        // ... but the price may rise at most 0.8% over the start of this transaction.
        uint256 riseLimitT = (b.u * b.t0 * MAX_RISE_DEN + b.u0 * MAX_RISE_NUM - 1) / (b.u0 * MAX_RISE_NUM);
        uint256 newT = targetT > riseLimitT ? targetT : riseLimitT;
        if (newT < POOL_MIN_TOKENS) newT = POOL_MIN_TOKENS;
        if (newT >= b.t) return;
        uint256 burnAmt = b.t - newT;
        b.t = newT;
        b.burnTokens += burnAmt;
        emit FloorBurn(n, burnAmt);
    }

    // ------------------------------------------------------------------ BNB payment

    function _usdToBnb(uint256 usdAmount) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = bnbUsdFeed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || block.timestamp > updatedAt + feedMaxAge) revert FeedInvalid();
        uint256 px = uint256(answer);
        if (px < feedMinAnswer || px > feedMaxAnswer) revert FeedInvalid();
        uint256 padded = usdAmount * (10_000 + BNB_PREMIUM_BPS) / 10_000;
        return (padded * 10 ** bnbUsdFeed.decimals() + px - 1) / px;
    }

    /// @dev Swaps whatever `tokenIn` balance the pair holds above its reserve.
    function _swapExact(IV2Pair lp, address tokenIn, address to) private {
        (uint112 r0, uint112 r1,) = lp.getReserves();
        bool inIs0 = lp.token0() == tokenIn;
        (uint256 rIn, uint256 rOut) = inIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 amountIn = IERC20(tokenIn).balanceOf(address(lp)) - rIn;
        uint256 amountOut = V2Math.getOut(amountIn, rIn, rOut, v2FeeBps);
        (uint256 o0, uint256 o1) = inIs0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        lp.swap(o0, o1, to, "");
    }

    // ------------------------------------------------------------------ tax conversion

    /// @notice Anyone may convert collected tax tokens to BNB for the treasury: once per block,
    ///         at most TAX_SWAP_BPS of the pool's BNAGENT reserve each time.
    function convertTax() external nonReentrant {
        if (!isOpen()) revert PoolNotOpen();
        if (lastTaxSwapBlock == block.number) revert OneSwapPerBlock();
        _convertTax();
    }

    /// @dev Called by this contract inside a mint so a failed conversion never blocks minting.
    function convertTaxInternal() external {
        if (msg.sender != address(this)) revert SelfOnly();
        _convertTax();
    }

    function _convertTax() private {
        (, uint256 tokenReserve) = poolReserves();
        uint256 amount = token.balanceOf(address(this));
        uint256 cap = tokenReserve * TAX_SWAP_BPS / 10_000;
        if (amount > cap) amount = cap;
        if (amount == 0) revert NothingToConvert();
        lastTaxSwapBlock = block.number;
        IERC20(address(token)).safeTransfer(address(pair), amount);
        _swapExact(pair, address(token), address(bnbUsdtPair));
        uint256 before = IERC20(wbnb).balanceOf(address(this));
        _swapExact(bnbUsdtPair, address(usdt), address(this));
        uint256 bnbOut = IERC20(wbnb).balanceOf(address(this)) - before;
        IWrappedNative(wbnb).withdraw(bnbOut);
        (bool ok,) = treasury.call{value: bnbOut}("");
        if (!ok) revert PayoutFailed();
        emit TaxConverted(amount, bnbOut);
    }
}

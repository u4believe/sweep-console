// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../src/SubscriptionManager.sol";
import "../src/interfaces/ISubscriptionManager.sol";

// ─── Minimal ERC-20 mock ──────────────────────────────────────────────────────
contract MockUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    // ── EIP-2612 permit (mirrors USDC's implementation) ──
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(block.timestamp <= deadline, "ERC20Permit: expired");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline))
            )
        );
        require(ecrecover(digest, v, r, s) == owner, "ERC20Permit: invalid signature");
        allowance[owner][spender] = value;
    }
}

// ─── Test suite ───────────────────────────────────────────────────────────────
contract SubscriptionManagerTest is Test {
    SubscriptionManager internal manager;
    MockUSDC internal usdc;

    address internal platform   = address(1);  // owner / arbiter / billing engine
    address internal treasury   = address(2);
    address internal merchant   = address(3);  // verified payout address
    address internal subscriber = address(4);
    address internal stranger   = address(5);

    uint256 internal constant PLAN_AMOUNT       = 9_000_000;  // $9.00 USDC
    uint256 internal constant INTERVAL          = 30 days;
    uint256 internal constant YEARLY_ALLOWANCE  = PLAN_AMOUNT * 12;
    uint256 internal constant FEE_BPS           = 100;        // 1%
    uint256 internal constant SETTLEMENT_WINDOW = 24 hours;

    bytes32 internal constant SUB_ID  = keccak256("test-subscription-1");
    bytes32 internal constant PLAN_ID = keccak256("plan_pro_monthly");

    uint256 internal EXPECTED_FEE      = (PLAN_AMOUNT * FEE_BPS) / 10_000; // 90_000
    uint256 internal EXPECTED_MERCHANT = PLAN_AMOUNT - EXPECTED_FEE;       // 8_910_000

    // ─── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(platform);

        usdc = new MockUSDC();
        manager = new SubscriptionManager(address(usdc), treasury, FEE_BPS);

        vm.stopPrank();

        // Fund subscriber with plenty of USDC
        usdc.mint(subscriber, 1_000_000_000); // $1,000
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// First checkout = exactly two subscriber signatures: approve then subscribe.
    function _approveAndSubscribe(uint256 trialDuration) internal {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        manager.subscribe(
            SUB_ID, merchant, PLAN_ID, PLAN_AMOUNT, INTERVAL, trialDuration, SETTLEMENT_WINDOW
        );
        vm.stopPrank();
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_setsState() public view {
        assertEq(address(manager.usdc()), address(usdc));
        assertEq(manager.platformTreasury(), treasury);
        assertEq(manager.platformFeeBps(), FEE_BPS);
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.startPrank(platform);
        vm.expectRevert(ISubscriptionManager.InvalidAddress.selector);
        new SubscriptionManager(address(0), treasury, FEE_BPS);

        vm.expectRevert(ISubscriptionManager.InvalidAddress.selector);
        new SubscriptionManager(address(usdc), address(0), FEE_BPS);
        vm.stopPrank();
    }

    function test_constructor_revertsIfFeeTooHigh() public {
        vm.startPrank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.FeeTooHigh.selector, 1001));
        new SubscriptionManager(address(usdc), treasury, 1001);
        vm.stopPrank();
    }

    // ─── subscribe() — first payment into escrow ──────────────────────────────

    function test_subscribe_pullsFirstPaymentIntoEscrow() public {
        uint256 balanceBefore = usdc.balanceOf(subscriber);
        _approveAndSubscribe(0);

        assertEq(usdc.balanceOf(subscriber), balanceBefore - PLAN_AMOUNT);
        assertEq(usdc.balanceOf(address(manager)), PLAN_AMOUNT);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.escrowBalance, PLAN_AMOUNT);
        assertEq(sub.settlementDeadline, block.timestamp + SETTLEMENT_WINDOW);
    }

    function test_subscribe_doesNotPushToMerchantBeforeWindow() public {
        _approveAndSubscribe(0);

        // Nothing pushed yet — funds sit in escrow until the window closes
        assertEq(usdc.balanceOf(merchant), 0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_subscribe_setsSubscriptionState() public {
        _approveAndSubscribe(0);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.subscriber, subscriber);
        assertEq(sub.merchantPayout, merchant);
        assertEq(sub.planId, PLAN_ID);
        assertEq(sub.amount, PLAN_AMOUNT);
        assertEq(sub.interval, INTERVAL);
        assertEq(sub.nextBillingDate, block.timestamp + INTERVAL);
        assertEq(sub.trialEnd, 0);
        assertEq(sub.retryCount, 0);
        assertTrue(sub.status == ISubscriptionManager.Status.Active);
    }

    function test_subscribe_emitsEvent() public {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);

        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.SubscriptionCreated(SUB_ID, subscriber, merchant, PLAN_ID);
        manager.subscribe(SUB_ID, merchant, PLAN_ID, PLAN_AMOUNT, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();
    }

    function test_subscribe_revertsOnDuplicate() public {
        _approveAndSubscribe(0);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.SubscriptionAlreadyExists.selector, SUB_ID));
        manager.subscribe(SUB_ID, merchant, PLAN_ID, PLAN_AMOUNT, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();
    }

    function test_subscribe_revertsOnZeroAmount() public {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        vm.expectRevert(ISubscriptionManager.InvalidAmount.selector);
        manager.subscribe(SUB_ID, merchant, PLAN_ID, 0, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();
    }

    function test_subscribe_revertsOnInsufficientAllowance() public {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), PLAN_AMOUNT - 1); // one short
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.InsufficientAllowance.selector,
                subscriber, PLAN_AMOUNT, PLAN_AMOUNT - 1
            )
        );
        manager.subscribe(SUB_ID, merchant, PLAN_ID, PLAN_AMOUNT, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();
    }

    // ─── subscribe() — with trial ─────────────────────────────────────────────

    function test_subscribe_withTrial_noImmediatePayment() public {
        uint256 balanceBefore = usdc.balanceOf(subscriber);
        _approveAndSubscribe(7 days);

        assertEq(usdc.balanceOf(subscriber), balanceBefore); // no charge yet

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.escrowBalance, 0);
        assertTrue(sub.status == ISubscriptionManager.Status.Trialing);
        assertEq(sub.trialEnd, block.timestamp + 7 days);
        assertEq(sub.nextBillingDate, block.timestamp + 7 days);
    }

    // ─── settlePeriod() — push settlement ─────────────────────────────────────

    function test_settlePeriod_pushesMerchantShareAndFee() public {
        _approveAndSubscribe(0);

        vm.warp(block.timestamp + SETTLEMENT_WINDOW);

        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        // Single tx pushed both legs — merchant never claims
        assertEq(usdc.balanceOf(merchant), EXPECTED_MERCHANT);
        assertEq(usdc.balanceOf(treasury), EXPECTED_FEE);
        assertEq(usdc.balanceOf(address(manager)), 0);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.escrowBalance, 0);
        assertEq(sub.settlementDeadline, 0);
    }

    function test_settlePeriod_emitsEvent() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + SETTLEMENT_WINDOW);

        vm.prank(platform);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.PeriodSettled(SUB_ID, EXPECTED_MERCHANT, EXPECTED_FEE);
        manager.settlePeriod(SUB_ID);
    }

    function test_settlePeriod_revertsBeforeDeadline() public {
        _approveAndSubscribe(0);

        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.SettlementNotDue.selector,
                SUB_ID,
                block.timestamp + SETTLEMENT_WINDOW,
                block.timestamp
            )
        );
        manager.settlePeriod(SUB_ID);
    }

    function test_settlePeriod_revertsIfNothingInEscrow() public {
        _approveAndSubscribe(7 days); // trial — escrow empty

        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.NothingInEscrow.selector, SUB_ID));
        manager.settlePeriod(SUB_ID);
    }

    function test_settlePeriod_revertsForStranger() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + SETTLEMENT_WINDOW);

        vm.prank(stranger);
        vm.expectRevert();
        manager.settlePeriod(SUB_ID);
    }

    // ─── renewFromAllowance() — happy path ────────────────────────────────────

    function test_renewFromAllowance_pushesImmediately() public {
        _approveAndSubscribe(0);

        // settle the first period so balances start clean
        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        vm.warp(block.timestamp + INTERVAL);

        uint256 merchantBefore = usdc.balanceOf(merchant);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(platform);
        bool ok = manager.renewFromAllowance(SUB_ID);
        assertTrue(ok);

        // Renewal is pushed in the same tx — nothing held in escrow
        assertEq(usdc.balanceOf(merchant), merchantBefore + EXPECTED_MERCHANT);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + EXPECTED_FEE);
        assertEq(manager.getSubscription(SUB_ID).escrowBalance, 0);
    }

    function test_renewFromAllowance_advancesNextBillingDate() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(platform);
        manager.renewFromAllowance(SUB_ID);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.nextBillingDate, block.timestamp + INTERVAL);
    }

    function test_renewFromAllowance_emitsSubscriptionRenewed() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(platform);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.SubscriptionRenewed(SUB_ID, PLAN_AMOUNT, block.timestamp + INTERVAL);
        manager.renewFromAllowance(SUB_ID);
    }

    function test_renewFromAllowance_revertsIfTooEarly() public {
        _approveAndSubscribe(0);

        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.BillingTooEarly.selector,
                SUB_ID,
                block.timestamp + INTERVAL,
                block.timestamp
            )
        );
        manager.renewFromAllowance(SUB_ID);
    }

    function test_renewFromAllowance_revertsIfNotPlatform() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(stranger);
        vm.expectRevert();
        manager.renewFromAllowance(SUB_ID);
    }

    // ─── renewFromAllowance() — insufficient allowance / retry cycle ──────────

    function test_renewFromAllowance_paymentFailedOnInsufficientAllowance() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        // Subscriber revokes allowance (cancels from the wallet side)
        vm.prank(subscriber);
        usdc.approve(address(manager), 0);

        vm.prank(platform);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.PaymentFailed(SUB_ID, 1, "Insufficient USDC allowance");
        bool ok = manager.renewFromAllowance(SUB_ID);

        assertFalse(ok);
        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertTrue(sub.status == ISubscriptionManager.Status.PastDue);
        assertEq(sub.retryCount, 1);
    }

    function test_renewFromAllowance_retryCountIncrementsAndCapsAtMax() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(subscriber);
        usdc.approve(address(manager), 0);

        for (uint256 i = 0; i < 9; i++) {
            vm.prank(platform);
            manager.renewFromAllowance(SUB_ID);
        }

        assertEq(manager.getSubscription(SUB_ID).retryCount, 7); // capped at MAX_RETRIES
    }

    function test_renewFromAllowance_recoversFromPastDue() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(subscriber);
        usdc.approve(address(manager), 0);
        vm.prank(platform);
        manager.renewFromAllowance(SUB_ID); // fails → PastDue

        vm.prank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE); // subscriber re-approves
        vm.prank(platform);
        bool ok = manager.renewFromAllowance(SUB_ID);

        assertTrue(ok);
        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertTrue(sub.status == ISubscriptionManager.Status.Active);
        assertEq(sub.retryCount, 0);
    }

    // ─── renewFromAllowance() — trial conversion goes through escrow ──────────

    function test_trialConversion_escrowsFirstPayment() public {
        _approveAndSubscribe(7 days);
        vm.warp(block.timestamp + 7 days);

        vm.prank(platform);
        bool ok = manager.renewFromAllowance(SUB_ID);
        assertTrue(ok);

        // Trial conversion is a FIRST payment — escrowed, not pushed
        assertEq(usdc.balanceOf(merchant), 0);
        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.escrowBalance, PLAN_AMOUNT);
        assertEq(sub.settlementDeadline, block.timestamp + SETTLEMENT_WINDOW);
        assertTrue(sub.status == ISubscriptionManager.Status.Active);
    }

    function test_trialConversion_thenSettles() public {
        _approveAndSubscribe(7 days);
        vm.warp(block.timestamp + 7 days);

        vm.prank(platform);
        manager.renewFromAllowance(SUB_ID);

        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        assertEq(usdc.balanceOf(merchant), EXPECTED_MERCHANT);
        assertEq(usdc.balanceOf(treasury), EXPECTED_FEE);
    }

    // ─── refund() — pro-rated, escrow only ────────────────────────────────────

    function test_refund_fullEscrow() public {
        _approveAndSubscribe(0);

        uint256 subscriberBefore = usdc.balanceOf(subscriber);

        vm.prank(platform);
        manager.refund(SUB_ID, 100);

        assertEq(usdc.balanceOf(subscriber), subscriberBefore + PLAN_AMOUNT);
        assertEq(manager.getSubscription(SUB_ID).escrowBalance, 0);
    }

    function test_refund_proRated50Pct() public {
        _approveAndSubscribe(0);

        uint256 subscriberBefore = usdc.balanceOf(subscriber);
        uint256 half = PLAN_AMOUNT / 2;

        vm.prank(platform);
        manager.refund(SUB_ID, 50);

        assertEq(usdc.balanceOf(subscriber), subscriberBefore + half);
        assertEq(manager.getSubscription(SUB_ID).escrowBalance, PLAN_AMOUNT - half);
    }

    function test_refund_emitsEvent() public {
        _approveAndSubscribe(0);

        vm.prank(platform);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.Refunded(SUB_ID, PLAN_AMOUNT / 2, 50);
        manager.refund(SUB_ID, 50);
    }

    function test_refund_cannotTouchPushedFunds() public {
        _approveAndSubscribe(0);

        // Window closes and funds are pushed to the merchant
        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        // Escrow is empty — refund is impossible after the push
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.NothingInEscrow.selector, SUB_ID));
        manager.refund(SUB_ID, 100);

        assertEq(usdc.balanceOf(merchant), EXPECTED_MERCHANT); // merchant funds untouched
    }

    function test_refund_revertsOnInvalidPct() public {
        _approveAndSubscribe(0);

        vm.startPrank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.InvalidPercentage.selector, 0));
        manager.refund(SUB_ID, 0);

        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.InvalidPercentage.selector, 101));
        manager.refund(SUB_ID, 101);
        vm.stopPrank();
    }

    function test_refund_revertsForStranger() public {
        _approveAndSubscribe(0);

        vm.prank(stranger);
        vm.expectRevert();
        manager.refund(SUB_ID, 100);
    }

    // ─── cancelSubscription() — returns remaining escrow ──────────────────────

    function test_cancel_returnsEscrowToSubscriber() public {
        uint256 balanceBefore = usdc.balanceOf(subscriber);
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        manager.cancelSubscription(SUB_ID);

        // Escrow returned in the same tx — subscriber made whole
        assertEq(usdc.balanceOf(subscriber), balanceBefore);
        assertFalse(manager.isSubscriptionActive(SUB_ID));
        assertEq(manager.getSubscription(SUB_ID).escrowBalance, 0);
    }

    function test_cancel_afterSettlement_noEscrowToReturn() public {
        _approveAndSubscribe(0);

        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        uint256 balanceBefore = usdc.balanceOf(subscriber);

        vm.prank(subscriber);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.SubscriptionCancelled(SUB_ID, 0);
        manager.cancelSubscription(SUB_ID);

        assertEq(usdc.balanceOf(subscriber), balanceBefore); // nothing refundable
    }

    function test_cancel_byPlatform() public {
        _approveAndSubscribe(0);

        vm.prank(platform);
        manager.cancelSubscription(SUB_ID);

        assertFalse(manager.isSubscriptionActive(SUB_ID));
    }

    function test_cancel_revertsForStranger() public {
        _approveAndSubscribe(0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.UnauthorizedCaller.selector, stranger));
        manager.cancelSubscription(SUB_ID);
    }

    function test_cancel_revertsIfAlreadyCancelled() public {
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        manager.cancelSubscription(SUB_ID);

        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.SubscriptionNotActive.selector, SUB_ID));
        manager.cancelSubscription(SUB_ID);
    }

    function test_renewFromAllowance_revertsIfCancelled() public {
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        manager.cancelSubscription(SUB_ID);

        vm.warp(block.timestamp + INTERVAL);
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.SubscriptionNotActive.selector, SUB_ID));
        manager.renewFromAllowance(SUB_ID);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function test_isDueBilling_falseBeforeInterval() public {
        _approveAndSubscribe(0);
        assertFalse(manager.isDueBilling(SUB_ID));
    }

    function test_isDueBilling_trueAfterInterval() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);
        assertTrue(manager.isDueBilling(SUB_ID));
    }

    function test_isDueBilling_falseIfCancelled() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(subscriber);
        manager.cancelSubscription(SUB_ID);

        assertFalse(manager.isDueBilling(SUB_ID));
    }

    function test_isDueSettlement_lifecycle() public {
        _approveAndSubscribe(0);
        assertFalse(manager.isDueSettlement(SUB_ID)); // window still open

        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        assertTrue(manager.isDueSettlement(SUB_ID));

        vm.prank(platform);
        manager.settlePeriod(SUB_ID);
        assertFalse(manager.isDueSettlement(SUB_ID)); // escrow empty
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function test_updatePlatformFee_byOwner() public {
        vm.prank(platform);
        manager.updatePlatformFee(200); // 2%
        assertEq(manager.platformFeeBps(), 200);
    }

    function test_updatePlatformFee_revertsIfTooHigh() public {
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.FeeTooHigh.selector, 1001));
        manager.updatePlatformFee(1001);
    }

    function test_updatePlatformFee_revertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert();
        manager.updatePlatformFee(200);
    }

    function test_pause_blocksSubscribe() public {
        vm.prank(platform);
        manager.pause();

        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        vm.expectRevert();
        manager.subscribe(SUB_ID, merchant, PLAN_ID, PLAN_AMOUNT, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();
    }

    function test_unpause_restoresFunctionality() public {
        vm.prank(platform);
        manager.pause();

        vm.prank(platform);
        manager.unpause();

        _approveAndSubscribe(0);
        assertTrue(manager.isSubscriptionActive(SUB_ID));
    }

    // ─── Activation test helpers (signed EIP-2612 permit) ────────────────────
    // The subscriber whose off-chain permit the platform submits via subscribeWithPermit().
    uint256 internal constant GW_SUBSCRIBER_KEY = 0xBEEF;

    function _signPermit(address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.PERMIT_TYPEHASH(), owner, address(manager), value, usdc.nonces(owner), deadline
                    )
                )
            )
        );
        (v, r, s) = vm.sign(GW_SUBSCRIBER_KEY, digest);
    }

    function _gatewayActivation(
        address gwSubscriber,
        uint256 trialDuration,
        uint256 permitValue
    ) internal view returns (ISubscriptionManager.SubscriptionActivation memory act) {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(gwSubscriber, permitValue, deadline);
        act = ISubscriptionManager.SubscriptionActivation({
            subId: SUB_ID,
            subscriber: gwSubscriber,
            merchantPayout: merchant,
            planId: PLAN_ID,
            amount: PLAN_AMOUNT,
            interval: INTERVAL,
            trialDuration: trialDuration,
            settlementWindow: SETTLEMENT_WINDOW,
            permitValue: permitValue,
            permitDeadline: deadline,
            permitV: v,
            permitR: r,
            permitS: s
        });
    }


    // ─── Gasless Same-Chain Activation (subscribeWithPermit) ──────────────────
    // The subscriber signs only an EIP-2612 permit (one signature, no gas); the
    // platform submits and pays Arc gas. No Gateway mint — funds come from the
    // subscriber's existing Arc USDC balance.

    function _fundedPermitSubscriber() internal returns (address gwSubscriber) {
        gwSubscriber = vm.addr(GW_SUBSCRIBER_KEY);
        usdc.mint(gwSubscriber, 1_000_000_000); // $1,000 already on Arc
    }

    function test_subscribeWithPermit_gaslessActivation() public {
        address gwSubscriber = _fundedPermitSubscriber();
        uint256 balanceBefore = usdc.balanceOf(gwSubscriber);
        ISubscriptionManager.SubscriptionActivation memory act =
            _gatewayActivation(gwSubscriber, 0, YEARLY_ALLOWANCE);

        // Platform submits — subscriber never sends a transaction
        vm.prank(platform);
        manager.subscribeWithPermit(act);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.subscriber, gwSubscriber);
        assertEq(sub.escrowBalance, PLAN_AMOUNT);
        assertEq(uint8(sub.status), uint8(ISubscriptionManager.Status.Active));
        // First period pulled into escrow; permit granted the year allowance
        assertEq(usdc.balanceOf(gwSubscriber), balanceBefore - PLAN_AMOUNT);
        assertEq(usdc.allowance(gwSubscriber, address(manager)), YEARLY_ALLOWANCE - PLAN_AMOUNT);
    }

    function test_subscribeWithPermit_withTrial_noImmediatePayment() public {
        address gwSubscriber = _fundedPermitSubscriber();
        uint256 balanceBefore = usdc.balanceOf(gwSubscriber);
        ISubscriptionManager.SubscriptionActivation memory act =
            _gatewayActivation(gwSubscriber, 7 days, YEARLY_ALLOWANCE);

        vm.prank(platform);
        manager.subscribeWithPermit(act);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(uint8(sub.status), uint8(ISubscriptionManager.Status.Trialing));
        assertEq(sub.escrowBalance, 0);
        assertEq(usdc.balanceOf(gwSubscriber), balanceBefore); // nothing charged
        assertEq(usdc.allowance(gwSubscriber, address(manager)), YEARLY_ALLOWANCE);
    }

    function test_subscribeWithPermit_renewalFromGrantedAllowance() public {
        address gwSubscriber = _fundedPermitSubscriber();
        ISubscriptionManager.SubscriptionActivation memory act =
            _gatewayActivation(gwSubscriber, 0, YEARLY_ALLOWANCE);

        vm.prank(platform);
        manager.subscribeWithPermit(act);

        // Renewal draws from the permit allowance — zero subscriber signatures
        vm.warp(block.timestamp + INTERVAL);
        vm.prank(platform);
        assertTrue(manager.renewFromAllowance(SUB_ID));
    }

    function test_subscribeWithPermit_revertsForNonOwner() public {
        address gwSubscriber = _fundedPermitSubscriber();
        ISubscriptionManager.SubscriptionActivation memory act =
            _gatewayActivation(gwSubscriber, 0, YEARLY_ALLOWANCE);

        vm.prank(stranger);
        vm.expectRevert();
        manager.subscribeWithPermit(act);
    }

    function test_subscribeWithPermit_revertsWithoutAllowanceOrPermit() public {
        address gwSubscriber = _fundedPermitSubscriber();
        ISubscriptionManager.SubscriptionActivation memory act = _gatewayActivation(gwSubscriber, 0, 0);

        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.InsufficientAllowance.selector, gwSubscriber, PLAN_AMOUNT, 0
            )
        );
        manager.subscribeWithPermit(act);
    }

    function test_subscribeWithPermit_revertsOnInsufficientBalance() public {
        address gwSubscriber = vm.addr(GW_SUBSCRIBER_KEY); // funded with nothing
        ISubscriptionManager.SubscriptionActivation memory act =
            _gatewayActivation(gwSubscriber, 0, YEARLY_ALLOWANCE);

        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.InsufficientBalance.selector, gwSubscriber, PLAN_AMOUNT, 0
            )
        );
        manager.subscribeWithPermit(act);
    }

    // ─── Fuzz Tests ───────────────────────────────────────────────────────────

    function testFuzz_settlePeriod_feeSplit(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000_000); // $1M max
        usdc.mint(subscriber, amount);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), amount);
        manager.subscribe(SUB_ID, merchant, PLAN_ID, amount, INTERVAL, 0, SETTLEMENT_WINDOW);
        vm.stopPrank();

        vm.warp(block.timestamp + SETTLEMENT_WINDOW);
        vm.prank(platform);
        manager.settlePeriod(SUB_ID);

        uint256 fee = (amount * FEE_BPS) / 10_000;

        assertEq(usdc.balanceOf(merchant), amount - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(merchant) + usdc.balanceOf(treasury), amount);
    }

    function testFuzz_refund_pctNeverExceedsEscrow(uint8 pct) public {
        pct = uint8(bound(pct, 1, 100));
        _approveAndSubscribe(0);

        uint256 subscriberBefore = usdc.balanceOf(subscriber);

        vm.prank(platform);
        manager.refund(SUB_ID, pct);

        uint256 refunded = usdc.balanceOf(subscriber) - subscriberBefore;
        assertEq(refunded, (PLAN_AMOUNT * pct) / 100);
        assertEq(manager.getSubscription(SUB_ID).escrowBalance, PLAN_AMOUNT - refunded);
    }
}

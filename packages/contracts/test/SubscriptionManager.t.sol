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
}

// ─── Test suite ───────────────────────────────────────────────────────────────
contract SubscriptionManagerTest is Test {
    SubscriptionManager internal manager;
    MockUSDC internal usdc;

    address internal platform   = address(1);  // owner / billing engine
    address internal treasury   = address(2);
    address internal merchant   = address(3);
    address internal subscriber = address(4);
    address internal stranger   = address(5);

    uint256 internal constant PLAN_AMOUNT   = 9_000_000;  // $9.00 USDC
    uint256 internal constant INTERVAL      = 30 days;
    uint256 internal constant YEARLY_ALLOWANCE = PLAN_AMOUNT * 12;
    uint256 internal constant FEE_BPS       = 100;        // 1%

    bytes32 internal constant SUB_ID = keccak256("test-subscription-1");

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

    function _approveAndSubscribe(uint256 trialDuration) internal {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        manager.subscribe(SUB_ID, merchant, PLAN_AMOUNT, INTERVAL, trialDuration);
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

    // ─── subscribe() — no trial ───────────────────────────────────────────────

    function test_subscribe_collectsFirstPayment() public {
        uint256 balanceBefore = usdc.balanceOf(subscriber);
        _approveAndSubscribe(0);

        assertEq(usdc.balanceOf(subscriber), balanceBefore - PLAN_AMOUNT);
        assertEq(usdc.balanceOf(address(manager)), PLAN_AMOUNT);
    }

    function test_subscribe_creditsMerchantAndTreasury() public {
        _approveAndSubscribe(0);

        uint256 expectedFee = (PLAN_AMOUNT * FEE_BPS) / 10_000; // 90_000
        uint256 expectedMerchant = PLAN_AMOUNT - expectedFee;   // 8_910_000

        assertEq(manager.getMerchantBalance(merchant), expectedMerchant);
        assertEq(manager.getMerchantBalance(treasury), expectedFee);
    }

    function test_subscribe_setsSubscriptionState() public {
        _approveAndSubscribe(0);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.subscriber, subscriber);
        assertEq(sub.merchant, merchant);
        assertEq(sub.amount, PLAN_AMOUNT);
        assertEq(sub.interval, INTERVAL);
        assertTrue(sub.active);
        assertFalse(sub.trialing);
        assertEq(sub.trialEndAt, 0);
    }

    function test_subscribe_emitsEvent() public {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);

        vm.expectEmit(true, true, true, true);
        emit ISubscriptionManager.SubscriptionCreated(
            SUB_ID, subscriber, merchant, PLAN_AMOUNT, INTERVAL, false
        );
        manager.subscribe(SUB_ID, merchant, PLAN_AMOUNT, INTERVAL, 0);
        vm.stopPrank();
    }

    function test_subscribe_revertsOnDuplicate() public {
        _approveAndSubscribe(0);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.SubscriptionAlreadyExists.selector, SUB_ID));
        manager.subscribe(SUB_ID, merchant, PLAN_AMOUNT, INTERVAL, 0);
        vm.stopPrank();
    }

    function test_subscribe_revertsOnZeroAmount() public {
        vm.startPrank(subscriber);
        usdc.approve(address(manager), YEARLY_ALLOWANCE);
        vm.expectRevert(ISubscriptionManager.InvalidAmount.selector);
        manager.subscribe(SUB_ID, merchant, 0, INTERVAL, 0);
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
        manager.subscribe(SUB_ID, merchant, PLAN_AMOUNT, INTERVAL, 0);
        vm.stopPrank();
    }

    // ─── subscribe() — with trial ─────────────────────────────────────────────

    function test_subscribe_withTrial_noImmediatePayment() public {
        uint256 balanceBefore = usdc.balanceOf(subscriber);
        _approveAndSubscribe(7 days);

        assertEq(usdc.balanceOf(subscriber), balanceBefore); // no charge yet
    }

    function test_subscribe_withTrial_setsTrialingState() public {
        _approveAndSubscribe(7 days);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertTrue(sub.trialing);
        assertEq(sub.trialEndAt, block.timestamp + 7 days);
    }

    // ─── renew() ──────────────────────────────────────────────────────────────

    function test_renew_chargesAfterInterval() public {
        _approveAndSubscribe(0);

        vm.warp(block.timestamp + INTERVAL);

        uint256 merchantBefore = manager.getMerchantBalance(merchant);

        vm.prank(platform);
        manager.renew(SUB_ID);

        uint256 expectedFee = (PLAN_AMOUNT * FEE_BPS) / 10_000;
        assertEq(manager.getMerchantBalance(merchant), merchantBefore + PLAN_AMOUNT - expectedFee);
    }

    function test_renew_updatesNextBillingAt() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(platform);
        manager.renew(SUB_ID);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertEq(sub.nextBillingAt, block.timestamp + INTERVAL);
    }

    function test_renew_revertsIfTooEarly() public {
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
        manager.renew(SUB_ID);
    }

    function test_renew_revertsIfNotPlatform() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        vm.prank(stranger);
        vm.expectRevert();
        manager.renew(SUB_ID);
    }

    function test_renew_emitsPaymentFailedOnInsufficientAllowance() public {
        _approveAndSubscribe(0);
        vm.warp(block.timestamp + INTERVAL);

        // Subscriber revokes allowance (simulates cancellation from wallet side)
        vm.prank(subscriber);
        usdc.approve(address(manager), 0);

        vm.prank(platform);
        vm.expectEmit(true, true, false, true);
        emit ISubscriptionManager.PaymentFailed(SUB_ID, subscriber, "Insufficient USDC allowance");
        manager.renew(SUB_ID);
    }

    function test_renew_convertsTrialOnFirstBilling() public {
        _approveAndSubscribe(7 days);

        vm.warp(block.timestamp + 7 days);

        vm.prank(platform);
        vm.expectEmit(true, true, false, false);
        emit ISubscriptionManager.TrialConverted(SUB_ID, subscriber);
        manager.renew(SUB_ID);

        ISubscriptionManager.Subscription memory sub = manager.getSubscription(SUB_ID);
        assertFalse(sub.trialing);
    }

    function test_renew_revertsIfStillTrialing() public {
        _approveAndSubscribe(7 days);

        // Try to renew before trial ends
        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.StillTrialing.selector,
                SUB_ID,
                block.timestamp + 7 days
            )
        );
        manager.renew(SUB_ID);
    }

    // ─── cancel() ─────────────────────────────────────────────────────────────

    function test_cancel_bySubscriber() public {
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        manager.cancel(SUB_ID);

        assertFalse(manager.isSubscriptionActive(SUB_ID));
    }

    function test_cancel_byPlatform() public {
        _approveAndSubscribe(0);

        vm.prank(platform);
        manager.cancel(SUB_ID);

        assertFalse(manager.isSubscriptionActive(SUB_ID));
    }

    function test_cancel_revertsForStranger() public {
        _approveAndSubscribe(0);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.UnauthorizedCaller.selector, stranger));
        manager.cancel(SUB_ID);
    }

    function test_cancel_emitsEvent() public {
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        vm.expectEmit(true, true, true, false);
        emit ISubscriptionManager.SubscriptionCancelled(SUB_ID, subscriber, merchant);
        manager.cancel(SUB_ID);
    }

    function test_cancel_revertsIfAlreadyCancelled() public {
        _approveAndSubscribe(0);

        vm.prank(subscriber);
        manager.cancel(SUB_ID);

        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(ISubscriptionManager.SubscriptionNotActive.selector, SUB_ID));
        manager.cancel(SUB_ID);
    }

    // ─── claimFunds() ─────────────────────────────────────────────────────────

    function test_claimFunds_transfersToMerchant() public {
        _approveAndSubscribe(0);

        uint256 expectedMerchantShare = PLAN_AMOUNT - (PLAN_AMOUNT * FEE_BPS / 10_000);

        vm.prank(merchant);
        manager.claimFunds();

        assertEq(usdc.balanceOf(merchant), expectedMerchantShare);
        assertEq(manager.getMerchantBalance(merchant), 0);
    }

    function test_claimFunds_emitsEvent() public {
        _approveAndSubscribe(0);

        uint256 balance = manager.getMerchantBalance(merchant);

        vm.prank(merchant);
        vm.expectEmit(true, false, false, true);
        emit ISubscriptionManager.FundsClaimed(merchant, balance);
        manager.claimFunds();
    }

    function test_claimFunds_noopOnZeroBalance() public {
        vm.prank(stranger);
        manager.claimFunds(); // should not revert
    }

    // ─── refund() ─────────────────────────────────────────────────────────────

    function test_refund_deductsMerchantAndPaySubscriber() public {
        _approveAndSubscribe(0);

        uint256 refundAmount = 4_500_000; // $4.50 (half period)
        uint256 merchantBalanceBefore = manager.getMerchantBalance(merchant);
        uint256 subscriberBalanceBefore = usdc.balanceOf(subscriber);

        vm.prank(platform);
        manager.refund(SUB_ID, refundAmount);

        assertEq(manager.getMerchantBalance(merchant), merchantBalanceBefore - refundAmount);
        assertEq(usdc.balanceOf(subscriber), subscriberBalanceBefore + refundAmount);
    }

    function test_refund_revertsIfInsufficientMerchantBalance() public {
        _approveAndSubscribe(0);

        uint256 tooMuch = PLAN_AMOUNT * 2;
        vm.prank(platform);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISubscriptionManager.InsufficientMerchantBalance.selector,
                merchant,
                tooMuch,
                PLAN_AMOUNT - (PLAN_AMOUNT * FEE_BPS / 10_000)
            )
        );
        manager.refund(SUB_ID, tooMuch);
    }

    function test_refund_revertsForStranger() public {
        _approveAndSubscribe(0);

        vm.prank(stranger);
        vm.expectRevert();
        manager.refund(SUB_ID, 1_000_000);
    }

    // ─── isDueBilling() ───────────────────────────────────────────────────────

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
        manager.cancel(SUB_ID);

        assertFalse(manager.isDueBilling(SUB_ID));
    }

    function test_isDueBilling_falseIfTrialing() public {
        _approveAndSubscribe(7 days);
        vm.warp(block.timestamp + 7 days);
        assertFalse(manager.isDueBilling(SUB_ID)); // still trialing until renew() converts it
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
        manager.subscribe(SUB_ID, merchant, PLAN_AMOUNT, INTERVAL, 0);
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

    // ─── Fuzz Tests ───────────────────────────────────────────────────────────

    function testFuzz_subscribe_feeSplit(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000_000); // $1M max
        usdc.mint(subscriber, amount);

        vm.startPrank(subscriber);
        usdc.approve(address(manager), amount);
        manager.subscribe(SUB_ID, merchant, amount, INTERVAL, 0);
        vm.stopPrank();

        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 expectedMerchant = amount - fee;

        assertEq(manager.getMerchantBalance(merchant), expectedMerchant);
        assertEq(manager.getMerchantBalance(treasury), fee);
        assertEq(
            manager.getMerchantBalance(merchant) + manager.getMerchantBalance(treasury),
            amount
        );
    }
}

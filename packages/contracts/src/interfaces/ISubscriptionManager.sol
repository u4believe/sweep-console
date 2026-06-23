// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISubscriptionManager
/// @notice Interface for the SweepConsole subscription billing contract on Arc.
///         Hybrid model: settlement-window escrow for first payments / trial
///         conversions + allowance-based recurring renewals, with push
///         settlement to non-custodial merchant payout wallets.
interface ISubscriptionManager {
    // ─── Types ────────────────────────────────────────────────────────────────

    enum Status {
        None,      // unset slot
        Trialing,
        Active,
        PastDue,
        Cancelled
    }

    struct Subscription {
        address subscriber;         // payer wallet
        address merchantPayout;     // verified payout address (Circle user-controlled or external)
        bytes32 planId;
        uint256 amount;             // per-period, USDC 6 decimals
        uint256 interval;           // seconds between billings
        uint256 nextBillingDate;    // unix timestamp
        uint256 trialEnd;           // 0 if no trial
        uint256 escrowBalance;      // first payment held until window closes
        uint256 settlementDeadline; // escrow auto-release timestamp
        uint256 settlementWindow;   // seconds escrow is held (per-plan configurable)
        uint8 retryCount;           // 0–7
        Status status;
    }

    /// @notice Activation payload for subscribeWithPermit(): the subscriber signs
    ///         only an EIP-2612 permit off-chain (gasless); the platform submits
    ///         the tx and pays Arc gas. The permit grants this contract the
    ///         recurring allowance. Cross-chain checkouts mint to the subscriber
    ///         via CCTP off-chain, then activate through this same path.
    struct SubscriptionActivation {
        bytes32 subId;
        address subscriber;
        address merchantPayout;
        bytes32 planId;
        uint256 amount;            // per-period, USDC 6 decimals
        uint256 interval;          // seconds between billings
        uint256 trialDuration;     // 0 if no trial
        uint256 settlementWindow;  // escrow hold in seconds
        uint256 permitValue;       // allowance granted via permit (0 = skip permit)
        uint256 permitDeadline;    // unix expiry of the permit signature
        uint8 permitV;
        bytes32 permitR;
        bytes32 permitS;
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event SubscriptionCreated(bytes32 indexed subId, address subscriber, address merchant, bytes32 planId);
    event SubscriptionRenewed(bytes32 indexed subId, uint256 amount, uint256 nextBillingDate);
    event PeriodSettled(bytes32 indexed subId, uint256 merchantShare, uint256 platformFee);
    event PaymentFailed(bytes32 indexed subId, uint8 retryCount, string reason);
    event SubscriptionCancelled(bytes32 indexed subId, uint256 refundedEscrow);
    event Refunded(bytes32 indexed subId, uint256 amount, uint8 pct);
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error SubscriptionAlreadyExists(bytes32 subId);
    error SubscriptionNotFound(bytes32 subId);
    error SubscriptionNotActive(bytes32 subId);
    error UnauthorizedCaller(address caller);
    error InsufficientAllowance(address subscriber, uint256 required, uint256 available);
    error InsufficientBalance(address subscriber, uint256 required, uint256 available);
    error BillingTooEarly(bytes32 subId, uint256 nextBillingDate, uint256 currentTime);
    error SettlementNotDue(bytes32 subId, uint256 settlementDeadline, uint256 currentTime);
    error NothingInEscrow(bytes32 subId);
    error InvalidAmount();
    error InvalidInterval();
    error InvalidAddress();
    error InvalidPercentage(uint8 pct);
    error FeeTooHigh(uint256 feeBps);

    // ─── Functions ────────────────────────────────────────────────────────────

    function subscribe(
        bytes32 subId,
        address merchantPayout,
        bytes32 planId,
        uint256 amount,
        uint256 interval,
        uint256 trialDuration,
        uint256 settlementWindow
    ) external;

    function subscribeWithPermit(SubscriptionActivation calldata activation) external;

    function settlePeriod(bytes32 subId) external;

    function renewFromAllowance(bytes32 subId) external returns (bool);

    function refund(bytes32 subId, uint8 refundPct) external;

    function cancelSubscription(bytes32 subId) external;

    function updatePlatformFee(uint256 newFeeBps) external;

    function updatePlatformTreasury(address newTreasury) external;

    function getSubscription(bytes32 subId) external view returns (Subscription memory);

    function isSubscriptionActive(bytes32 subId) external view returns (bool);

    function isDueBilling(bytes32 subId) external view returns (bool);

    function isDueSettlement(bytes32 subId) external view returns (bool);
}

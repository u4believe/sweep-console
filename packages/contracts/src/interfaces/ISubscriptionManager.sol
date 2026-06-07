// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISubscriptionManager
/// @notice Interface for the SweepConsole subscription billing contract on Arc
interface ISubscriptionManager {
    // ─── Structs ──────────────────────────────────────────────────────────────

    struct Subscription {
        address subscriber;
        address merchant;
        uint256 amount;        // USDC per billing period (6 decimals)
        uint256 interval;      // seconds between charges
        uint256 nextBillingAt; // unix timestamp of next charge
        bool active;
        bool trialing;
        uint256 trialEndAt;    // 0 if no trial
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    event SubscriptionCreated(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed merchant,
        uint256 amount,
        uint256 interval,
        bool trialing
    );

    event SubscriptionRenewed(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed merchant,
        uint256 amount
    );

    event SubscriptionCancelled(
        bytes32 indexed subscriptionId,
        address indexed subscriber,
        address indexed merchant
    );

    event TrialStarted(bytes32 indexed subscriptionId, address indexed subscriber, uint256 trialEndAt);
    event TrialConverted(bytes32 indexed subscriptionId, address indexed subscriber);
    event PaymentFailed(bytes32 indexed subscriptionId, address indexed subscriber, string reason);
    event FundsClaimed(address indexed merchant, uint256 amount);
    event Refunded(bytes32 indexed subscriptionId, address indexed subscriber, uint256 amount);
    event PlatformFeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event PlatformTreasuryUpdated(address oldTreasury, address newTreasury);

    // ─── Errors ───────────────────────────────────────────────────────────────

    error SubscriptionAlreadyExists(bytes32 subscriptionId);
    error SubscriptionNotFound(bytes32 subscriptionId);
    error SubscriptionNotActive(bytes32 subscriptionId);
    error UnauthorizedCaller(address caller);
    error InsufficientAllowance(address subscriber, uint256 required, uint256 available);
    error InsufficientBalance(address subscriber, uint256 required, uint256 available);
    error BillingTooEarly(bytes32 subscriptionId, uint256 nextBillingAt, uint256 currentTime);
    error InvalidAmount();
    error InvalidInterval();
    error InvalidAddress();
    error FeeTooHigh(uint256 feeBps);
    error InsufficientMerchantBalance(address merchant, uint256 required, uint256 available);
    error StillTrialing(bytes32 subscriptionId, uint256 trialEndAt);

    // ─── Functions ────────────────────────────────────────────────────────────

    function subscribe(
        bytes32 subscriptionId,
        address merchant,
        uint256 amount,
        uint256 interval,
        uint256 trialDuration
    ) external;

    function renew(bytes32 subscriptionId) external;

    function cancel(bytes32 subscriptionId) external;

    function claimFunds() external;

    function refund(bytes32 subscriptionId, uint256 amount) external;

    function updatePlatformFee(uint256 newFeeBps) external;

    function updatePlatformTreasury(address newTreasury) external;

    function getSubscription(bytes32 subscriptionId) external view returns (Subscription memory);

    function getMerchantBalance(address merchant) external view returns (uint256);

    function isSubscriptionActive(bytes32 subscriptionId) external view returns (bool);

    function isDueBilling(bytes32 subscriptionId) external view returns (bool);
}

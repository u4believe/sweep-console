// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/SubscriptionManager.sol";

/// @notice Deployment script for SubscriptionManager on Arc.
///
/// Usage (testnet):
///   forge script script/Deploy.s.sol \
///     --rpc-url arcTestnet \
///     --broadcast \
///     --verify \
///     -vvvv
///
/// Required env vars (see .env.example):
///   PRIVATE_KEY, USDC_ADDRESS, PLATFORM_TREASURY, PLATFORM_FEE_BPS
contract DeploySubscriptionManager is Script {
    function run() external returns (SubscriptionManager manager) {
        address usdc         = vm.envAddress("USDC_ADDRESS");
        address treasury     = vm.envAddress("PLATFORM_TREASURY");
        uint256 feeBps       = vm.envUint("PLATFORM_FEE_BPS");
        uint256 deployerKey  = vm.envUint("PRIVATE_KEY");

        console.log("Deploying SubscriptionManager...");
        console.log("  USDC address  :", usdc);
        console.log("  Treasury      :", treasury);
        console.log("  Platform fee  :", feeBps, "bps");

        vm.startBroadcast(deployerKey);
        manager = new SubscriptionManager(usdc, treasury, feeBps);
        vm.stopBroadcast();

        console.log("SubscriptionManager deployed at:", address(manager));
        console.log("Owner (billing engine wallet)  :", manager.owner());
    }
}

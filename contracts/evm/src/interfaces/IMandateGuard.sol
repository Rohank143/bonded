// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "./IPriceOracle.sol";
import {MandateBase} from "../MandateBase.sol";

/// @title IMandateGuard
/// @notice What CoverManager and ClaimsEngine read from a protected account's guard: a
///         MandateVault, or a MandateModule on a smart account. Both expose the same functions.
interface IMandateGuard {
    function guardian() external view returns (address);

    function agentId() external view returns (uint256);

    function mandateHash() external view returns (bytes32);

    function freezeOnBreach() external view returns (bool);

    /// @notice Base asset: premiums are paid and payouts are made in it.
    function asset() external view returns (address);

    function oracle() external view returns (IPriceOracle);

    function getBreach(uint256 breachId) external view returns (MandateBase.Breach memory);

    /// @notice ClaimsEngine only.
    function markBreachClaimed(uint256 breachId) external;

    /// @notice CoverManager only.
    function payPremium(uint256 amount) external;
}

/// @title IMandateModule
/// @notice A guard that protects funds held elsewhere: payouts go to `account`, not the guard.
interface IMandateModule is IMandateGuard {
    /// @notice The smart account whose funds the module guards.
    function account() external view returns (address);
}

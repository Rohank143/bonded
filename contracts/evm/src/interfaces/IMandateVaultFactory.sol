// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMandateVaultFactory
/// @notice What a MandateVault needs from the factory that deployed it.
interface IMandateVaultFactory {
    /// @notice Contract allowed to pull premiums from vaults (CoverManager).
    function coverManager() external view returns (address);

    /// @notice Contract allowed to mark breaches as claimed (ClaimsEngine).
    function claimsEngine() external view returns (address);

    /// @notice True for vaults deployed by this factory.
    function isVault(address vault) external view returns (bool);
}

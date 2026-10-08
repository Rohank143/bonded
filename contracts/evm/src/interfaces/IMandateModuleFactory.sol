// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMandateModuleFactory
/// @notice What a MandateModule and CoverManager need from the factory that deployed it.
interface IMandateModuleFactory {
    /// @notice Contract allowed to pull premiums (CoverManager), as set on the vault factory.
    function coverManager() external view returns (address);

    /// @notice Contract allowed to mark breaches as claimed (ClaimsEngine), as set on the vault factory.
    function claimsEngine() external view returns (address);

    /// @notice True for modules deployed by this factory.
    function isModule(address module) external view returns (bool);

    /// @notice The module an account created last: the only one it may install.
    function moduleOf(address account) external view returns (address);

    /// @notice The MandateVaultFactory this factory reads the oracle and protocol addresses from.
    function vaultFactory() external view returns (address);
}

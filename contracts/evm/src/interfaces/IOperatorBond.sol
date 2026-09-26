// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOperatorBond
/// @notice What CoverManager and ClaimsEngine need from the operator bond.
interface IOperatorBond {
    /// @notice Bonded amount for an agent (base-asset units).
    function bondOf(uint256 agentId) external view returns (uint256);

    /// @notice Slashes up to `amount` of an agent's bond to `to`. ClaimsEngine only.
    /// @return slashed The amount actually slashed (capped by the bond).
    function slash(uint256 agentId, uint256 amount, address to) external returns (uint256 slashed);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICoverPool
/// @notice What CoverManager and ClaimsEngine need from the underwriting pool.
interface ICoverPool {
    /// @notice The pool's base asset.
    function asset() external view returns (address);

    /// @notice Pool assets in base-asset units (ERC-4626 totalAssets).
    function totalAssets() external view returns (uint256);

    /// @notice Pays up to `amount` to `to`. ClaimsEngine only.
    /// @return paid The amount actually paid (less than `amount` if the pool is short).
    function payClaim(address to, uint256 amount) external returns (uint256 paid);
}

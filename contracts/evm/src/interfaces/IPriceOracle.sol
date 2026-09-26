// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPriceOracle
/// @notice Values token amounts in US dollars with 6 decimals.
/// @dev Implementations must revert when a price is missing or stale rather than return a
///      guess: the vault uses these values to measure losses and compute NAV.
interface IPriceOracle {
    /// @param asset ERC-20 token address.
    /// @param amount Amount in the token's smallest unit.
    /// @return usd6 Value of `amount` in USD with 6 decimals.
    function valueInUsd6(address asset, uint256 amount) external view returns (uint256 usd6);
}

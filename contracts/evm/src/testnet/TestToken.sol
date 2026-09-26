// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Testnet-only ERC-20 with a public faucet (demo stablecoins and Stock Tokens).
///         Never deploy on mainnet.
contract TestToken is ERC20 {
    uint8 private immutable _decimals;
    /// @notice Largest amount one faucet call can mint, in whole tokens.
    uint256 public immutable faucetCapWhole;

    error FaucetCapExceeded(uint256 cap);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 faucetCapWhole_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        faucetCapWhole = faucetCapWhole_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mints up to `faucetCapWhole` tokens to the caller.
    function faucet(uint256 amount) external {
        uint256 cap = faucetCapWhole * 10 ** _decimals;
        if (amount > cap) revert FaucetCapExceeded(cap);
        _mint(msg.sender, amount);
    }

    /// @notice Unlimited mint for deployment scripts seeding liquidity. Testnet only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

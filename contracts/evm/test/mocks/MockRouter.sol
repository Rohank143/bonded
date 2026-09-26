// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Swap router with fixed rates. `drain` simulates a malicious or compromised router
///         that abuses an allowance outside the vault's `execute`.
contract MockRouter {
    /// @dev amountOut = amountIn * rate / 1e18
    mapping(address tokenIn => mapping(address tokenOut => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external {
        rate[tokenIn][tokenOut] = rate_;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = amountIn * rate[tokenIn][tokenOut] / 1e18;
        IERC20(tokenOut).transfer(recipient, amountOut);
    }

    /// @notice Not in any mandate's allowed selectors.
    function sweep(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }

    /// @notice Anyone can call: pulls tokens from an address that approved this router.
    function drain(address token, address from, address to, uint256 amount) external {
        IERC20(token).transferFrom(from, to, amount);
    }
}

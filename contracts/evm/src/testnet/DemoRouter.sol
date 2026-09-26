// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title DemoRouter
/// @notice Testnet-only swap venue that trades at oracle prices minus a fee, from its own
///         inventory. Gives the demo and the Arena a predictable market on any chain.
/// @dev `swap(address,address,uint256,address)` is the selector demo mandates allow.
contract DemoRouter {
    using SafeERC20 for IERC20;

    IPriceOracle public immutable oracle;
    uint16 public immutable feeBps;

    event Swapped(
        address indexed sender,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error FeeTooHigh();

    constructor(IPriceOracle oracle_, uint16 feeBps_) {
        if (feeBps_ > 1000) revert FeeTooHigh();
        oracle = oracle_;
        feeBps = feeBps_;
    }

    /// @notice Output for `amountIn` of `tokenIn`, at oracle prices minus the fee.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        uint256 valueUsd6 = oracle.valueInUsd6(tokenIn, amountIn);
        uint256 oneOut = 10 ** IERC20Metadata(tokenOut).decimals();
        uint256 gross = Math.mulDiv(valueUsd6, oneOut, oracle.valueInUsd6(tokenOut, oneOut));
        return gross * (10_000 - feeBps) / 10_000;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
    }
}

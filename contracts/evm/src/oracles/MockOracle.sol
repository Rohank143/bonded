// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @title MockOracle
/// @notice Owner-set prices for testnets and demos. Never use on mainnet.
contract MockOracle is IPriceOracle, Ownable {
    /// @notice USD price of one whole token, with 6 decimals (1_000_000 = $1).
    mapping(address asset => uint256 priceUsd6) public priceUsd6;

    event PriceSet(address indexed asset, uint256 priceUsd6);

    error PriceNotSet(address asset);

    constructor(address owner_) Ownable(owner_) {}

    function setPrice(address asset, uint256 newPriceUsd6) external onlyOwner {
        priceUsd6[asset] = newPriceUsd6;
        emit PriceSet(asset, newPriceUsd6);
    }

    /// @inheritdoc IPriceOracle
    function valueInUsd6(address asset, uint256 amount) external view returns (uint256) {
        uint256 price = priceUsd6[asset];
        if (price == 0) revert PriceNotSet(asset);
        return Math.mulDiv(amount, price, 10 ** IERC20Metadata(asset).decimals());
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @notice A contract the mandate does not allow.
contract MockTarget {
    uint256 public pings;

    function ping() external {
        pings++;
    }
}

/// @notice Tries to deposit into the vault while the vault is executing a call to it.
contract ReentrantTarget {
    function poke(address vault, uint256 amount) external {
        IERC4626(vault).deposit(amount, address(this));
    }
}

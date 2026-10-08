// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateModuleFactory} from "../../src/MandateModuleFactory.sol";

/// @notice Not a real ERC-7579 account: it reports every execution as done without doing it,
///         unless switched to `honest`, when it really makes single calls. Used to check that a
///         premium only counts once the money arrives.
contract FakeAccount {
    bool public honest;

    function setHonest(bool h) external {
        honest = h;
    }

    /// @dev Creates its module and "installs" it (calls onInstall as the account).
    function create(
        MandateModuleFactory f,
        BondedTypes.MandateParams memory p,
        address agent,
        address guardian,
        uint256 id
    ) external returns (MandateModule m) {
        m = MandateModule(f.createModule(p, agent, guardian, id));
        m.onInstall("");
    }

    function executeFromExecutor(bytes32, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory results)
    {
        results = new bytes[](1);
        if (honest) {
            address target = address(bytes20(executionCalldata[:20]));
            (bool ok, bytes memory result) = target.call(executionCalldata[52:]);
            require(ok, "call failed");
            results[0] = result;
        } else {
            results[0] = abi.encode(true);
        }
    }
}

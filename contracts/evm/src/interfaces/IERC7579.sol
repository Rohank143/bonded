// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The parts of ERC-7579 (https://eips.ethereum.org/EIPS/eip-7579) that MandateModule uses,
// vendored so the protocol contracts have no dependency beyond OpenZeppelin. `ModeCode` is a
// user-defined bytes32 in the reference code; it is plain bytes32 here (same ABI).

uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_HOOK = 4;

/// @dev Mode for one call that reverts on failure: call type 0x00 (single), exec type 0x00
///      (default), no selector or payload.
bytes32 constant MODE_SINGLE_DEFAULT = bytes32(0);

/// @notice What every ERC-7579 module implements.
interface IERC7579Module {
    /// @notice Called by the account when the module is installed (once per module type).
    function onInstall(bytes calldata data) external;

    /// @notice Called by the account when the module is uninstalled (once per module type).
    function onUninstall(bytes calldata data) external;

    function isModuleType(uint256 moduleTypeId) external view returns (bool);

    function isInitialized(address smartAccount) external view returns (bool);
}

/// @notice An ERC-7579 hook: the account calls it before and after each execution.
interface IERC7579Hook is IERC7579Module {
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);

    function postCheck(bytes calldata hookData) external;
}

/// @notice The account functions an executor module calls.
interface IERC7579Account {
    /// @param executionCalldata For a single call: abi.encodePacked(target, value, callData).
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

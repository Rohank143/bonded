// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BondedTypes} from "../libraries/BondedTypes.sol";

/// @title IBondedRegistry
/// @notice What the rest of the protocol reads from BondedRegistry.
interface IBondedRegistry {
    /// @notice True if `signer` is an active Arena attester.
    function isAttester(address signer) external view returns (bool);

    /// @notice Current owner (operator) of an agent, or address(0) if it doesn't exist.
    function agentOwner(uint256 agentId) external view returns (address);

    /// @notice Latest score attestation for an agent (all zero if none).
    function scoreOf(uint256 agentId) external view returns (BondedTypes.Attestation memory);

    /// @notice True if the agent has a posted score that hasn't expired.
    function hasValidScore(uint256 agentId) external view returns (bool);
}

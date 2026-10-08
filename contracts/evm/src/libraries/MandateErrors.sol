// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BondedTypes} from "./BondedTypes.sol";

/// @title MandateErrors
/// @notice Errors raised by the mandate checks in MandateBase, shared by MandateVault and
///         MandateModule. MandateVault also declares them in its own scope (same signatures, so
///         the same selectors) so `MandateVault.NotAgent.selector` and the like keep working.
library MandateErrors {
    error ZeroAddress();
    error InvalidParams(string reason);
    error NotAgent();
    error NotGuardian();
    error NotCoverManager();
    error NotClaimsEngine();
    error AgentFrozen();
    error OnlySelf();
    error UnknownBreach(uint256 breachId);
    error BreachAlreadyClaimed(uint256 breachId);
    /// @dev Internal signal from `measuredCall` in Enforce mode; never escapes `execute`.
    error BreachDetected(BondedTypes.BreachType breachType, uint256 lossUsd6);
    /// @dev Internal wrapper for a failed target call; `execute` re-throws the inner revert data.
    error CallFailed(bytes revertData);
}

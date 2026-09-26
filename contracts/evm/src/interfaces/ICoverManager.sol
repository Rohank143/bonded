// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICoverManager
/// @notice What CoverPool, OperatorBond and ClaimsEngine need from CoverManager.
interface ICoverManager {
    enum Status {
        None,
        Active,
        Cancelled, // guardian ended it
        Expired, // term ran out
        Lapsed, // premium couldn't be paid
        Exhausted // claims used up the full cover
    }

    struct Policy {
        uint256 agentId;
        address vault;
        uint256 coverAmount; // base-asset units
        uint256 remainingCover; // coverAmount minus claims paid
        uint32 premiumRateBps; // annual, of coverAmount
        uint16 score;
        uint8 modelFamily;
        Status status;
        uint64 startedAt;
        uint64 coveredFrom; // startedAt + waiting period: breaches before this aren't covered
        uint64 endsAt;
        uint64 paidUntil; // premiums are paid up to this time
        uint64 closedAt;
    }

    /// @notice Sum of remaining cover across active policies (base-asset units).
    function totalActiveCover() external view returns (uint256);

    /// @notice Largest total cover as a multiple of pool assets, in basis points (20_000 = 2x).
    function maxLeverageBps() external view returns (uint32);

    /// @notice Remaining cover across an agent's active policies.
    function activeCoverOfAgent(uint256 agentId) external view returns (uint256);

    function getPolicy(uint256 policyId) external view returns (Policy memory);

    /// @notice Time range in which a breach is covered: [coveredFrom, coveredUntil].
    function coverageWindow(uint256 policyId)
        external
        view
        returns (uint64 coveredFrom, uint64 coveredUntil);

    /// @notice Brings premiums up to date; may expire or lapse the policy. Anyone can call.
    function accrue(uint256 policyId) external;

    /// @notice Reduces remaining cover after a payout. ClaimsEngine only.
    function recordClaim(uint256 policyId, uint256 amount) external;
}

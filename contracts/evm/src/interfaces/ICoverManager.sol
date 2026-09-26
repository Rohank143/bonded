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
        Lapsed, // premium stayed unpaid past the grace period
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
        uint64 pastDueSince; // first failed premium collection since the last success; 0 if current
        uint256 premiumDebt; // unpaid premium frozen when a policy closes owing money
    }

    /// @notice Sum of remaining cover across active policies (base-asset units).
    function totalActiveCover() external view returns (uint256);

    /// @notice Largest total cover as a multiple of pool assets, in basis points (20_000 = 2x).
    function maxLeverageBps() external view returns (uint32);

    /// @notice Remaining cover across an agent's active policies.
    function activeCoverOfAgent(uint256 agentId) external view returns (uint256);

    /// @notice Latest time any of an agent's closed policies stopped covering (0 if none closed).
    function coverEndOf(uint256 agentId) external view returns (uint64);

    function getPolicy(uint256 policyId) external view returns (Policy memory);

    /// @notice Time range in which a breach is covered: [coveredFrom, coveredUntil].
    function coverageWindow(uint256 policyId)
        external
        view
        returns (uint64 coveredFrom, uint64 coveredUntil);

    /// @notice Unpaid premium for the covered period so far. ClaimsEngine nets it from payouts.
    function premiumDebt(uint256 policyId) external view returns (uint256);

    /// @notice Brings premiums up to date; may expire or lapse the policy. Anyone can call.
    function accrue(uint256 policyId) external;

    /// @notice Records a payout: `paid` went to the vault and `premiumNetted` settled unpaid
    ///         premium. Both reduce remaining cover. ClaimsEngine only.
    function recordClaim(uint256 policyId, uint256 paid, uint256 premiumNetted) external;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";

/// @notice The part of ClaimsEngine DisputeModule calls.
interface IDisputePayer {
    function payDispute(uint256 policyId, uint256 lossBase) external returns (uint256 paid);
}

/// @title DisputeModule
/// @notice Optimistic resolution for grey-area (T4) claims the vault can't prove on its own,
///         such as a drawdown blamed on agent misbehaviour. See docs/PLAN.md Section 11 and ADR-004.
/// @dev 1. Anyone proposes a claim with evidence (e.g. the AI adjudicator's report hash) and a bond.
///      2. If nobody challenges within the challenge period, anyone can finalize: ClaimsEngine
///         pays it and the proposer's bond is returned.
///      3. A challenger posts the same bond; the council (owner-appointed, a multisig in
///         production) decides. The winner takes both bonds.
///      The council can also reject an unchallenged proposal that can't be paid (e.g. its claim
///      window closed), returning the proposer's bond.
contract DisputeModule is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Proposed,
        Challenged,
        Paid,
        Rejected
    }

    struct Dispute {
        uint256 policyId;
        uint256 lossBase;
        address proposer;
        address challenger;
        uint256 bond;
        uint64 challengeDeadline;
        Status status;
        bytes32 evidenceHash;
    }

    IERC20 public immutable asset;
    ICoverManager public immutable coverManager;
    IDisputePayer public immutable claimsEngine;

    address public council;
    uint256 public proposalBond;
    uint64 public challengePeriod = 2 days;

    uint256 public nextDisputeId = 1;
    mapping(uint256 disputeId => Dispute) private _disputes;

    event DisputeProposed(
        uint256 indexed disputeId,
        uint256 indexed policyId,
        address indexed proposer,
        uint256 lossBase,
        bytes32 evidenceHash,
        string evidenceURI,
        uint64 challengeDeadline
    );
    event DisputeChallenged(uint256 indexed disputeId, address indexed challenger);
    event DisputePaid(uint256 indexed disputeId, uint256 paid);
    event DisputeRejected(uint256 indexed disputeId);
    event CouncilSet(address council);
    event ParamsSet(uint256 proposalBond, uint64 challengePeriod);

    error ZeroAddress();
    error InvalidParams(string reason);
    error NotCouncil();
    error UnknownDispute(uint256 disputeId);
    error WrongStatus(Status status);
    error ChallengePeriodOver();
    error ChallengePeriodActive();

    constructor(
        address owner_,
        IERC20 asset_,
        ICoverManager coverManager_,
        IDisputePayer claimsEngine_,
        address council_,
        uint256 proposalBond_
    ) Ownable(owner_) {
        if (
            address(asset_) == address(0) || address(coverManager_) == address(0)
                || address(claimsEngine_) == address(0) || council_ == address(0)
        ) revert ZeroAddress();
        asset = asset_;
        coverManager = coverManager_;
        claimsEngine = claimsEngine_;
        council = council_;
        proposalBond = proposalBond_;
    }

    // ----- Lifecycle ---------------------------------------------------------------------

    /// @notice Proposes a grey-area claim for a policy. Pulls `proposalBond` from the caller.
    function propose(
        uint256 policyId,
        uint256 lossBase,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) external nonReentrant returns (uint256 disputeId) {
        if (lossBase == 0) revert InvalidParams("lossBase");
        coverManager.getPolicy(policyId); // reverts for unknown policies

        disputeId = nextDisputeId++;
        uint64 deadline = uint64(block.timestamp) + challengePeriod;
        _disputes[disputeId] = Dispute({
            policyId: policyId,
            lossBase: lossBase,
            proposer: msg.sender,
            challenger: address(0),
            bond: proposalBond,
            challengeDeadline: deadline,
            status: Status.Proposed,
            evidenceHash: evidenceHash
        });
        if (proposalBond > 0) asset.safeTransferFrom(msg.sender, address(this), proposalBond);
        emit DisputeProposed(
            disputeId, policyId, msg.sender, lossBase, evidenceHash, evidenceURI, deadline
        );
    }

    /// @notice Challenges a proposal before its deadline, posting the same bond.
    function challenge(uint256 disputeId) external nonReentrant {
        Dispute storage d = _existing(disputeId);
        if (d.status != Status.Proposed) revert WrongStatus(d.status);
        if (block.timestamp >= d.challengeDeadline) revert ChallengePeriodOver();
        d.status = Status.Challenged;
        d.challenger = msg.sender;
        if (d.bond > 0) asset.safeTransferFrom(msg.sender, address(this), d.bond);
        emit DisputeChallenged(disputeId, msg.sender);
    }

    /// @notice Pays an unchallenged proposal after its deadline. Anyone can call.
    function finalize(uint256 disputeId) external nonReentrant returns (uint256 paid) {
        Dispute storage d = _existing(disputeId);
        if (d.status != Status.Proposed) revert WrongStatus(d.status);
        if (block.timestamp < d.challengeDeadline) revert ChallengePeriodActive();
        d.status = Status.Paid;
        paid = claimsEngine.payDispute(d.policyId, d.lossBase);
        if (d.bond > 0) asset.safeTransfer(d.proposer, d.bond);
        emit DisputePaid(disputeId, paid);
    }

    /// @notice Council decision. For a challenged dispute the winner takes both bonds. For an
    ///         unchallenged one, rejecting returns the proposer's bond (used for unpayable claims).
    function resolve(uint256 disputeId, bool approve) external nonReentrant returns (uint256 paid) {
        if (msg.sender != council) revert NotCouncil();
        Dispute storage d = _existing(disputeId);
        if (d.status == Status.Challenged) {
            if (approve) {
                d.status = Status.Paid;
                paid = claimsEngine.payDispute(d.policyId, d.lossBase);
                if (d.bond > 0) asset.safeTransfer(d.proposer, d.bond * 2);
                emit DisputePaid(disputeId, paid);
            } else {
                d.status = Status.Rejected;
                if (d.bond > 0) asset.safeTransfer(d.challenger, d.bond * 2);
                emit DisputeRejected(disputeId);
            }
        } else if (d.status == Status.Proposed && !approve) {
            d.status = Status.Rejected;
            if (d.bond > 0) asset.safeTransfer(d.proposer, d.bond);
            emit DisputeRejected(disputeId);
        } else {
            revert WrongStatus(d.status);
        }
    }

    // ----- Views and admin ---------------------------------------------------------------

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _existing(disputeId);
    }

    function setCouncil(address council_) external onlyOwner {
        if (council_ == address(0)) revert ZeroAddress();
        council = council_;
        emit CouncilSet(council_);
    }

    /// @dev Applies to new proposals only; each dispute stores its own bond and deadline.
    function setParams(uint256 proposalBond_, uint64 challengePeriod_) external onlyOwner {
        if (challengePeriod_ < 5 minutes || challengePeriod_ > 14 days) {
            revert InvalidParams("challengePeriod");
        }
        proposalBond = proposalBond_;
        challengePeriod = challengePeriod_;
        emit ParamsSet(proposalBond_, challengePeriod_);
    }

    function _existing(uint256 disputeId) internal view returns (Dispute storage d) {
        d = _disputes[disputeId];
        if (d.status == Status.None) revert UnknownDispute(disputeId);
    }
}

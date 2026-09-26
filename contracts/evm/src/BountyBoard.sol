// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBondedRegistry} from "./interfaces/IBondedRegistry.sol";

/// @title BountyBoard
/// @notice Community attack bounties, funded by 5% of premiums (CoverManager's bounty pool).
///         See docs/PLAN.md Section 13.1 and ADR-004.
/// @dev 1. A hunter commits keccak256(abi.encode(hunter, specURI, salt)). The commitment
///         timestamps priority without revealing the attack, and binds it to the hunter.
///      2. The hunter reveals the spec URI and salt; the Arena runs the attack in its sandbox.
///      3. An attester accepts (paying a reward from the board) or rejects it.
contract BountyBoard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Committed,
        Revealed,
        Accepted,
        Rejected
    }

    struct Submission {
        address hunter;
        bytes32 commitment;
        uint64 committedAt;
        Status status;
        uint256 reward;
        string specURI;
    }

    IERC20 public immutable asset;
    IBondedRegistry public immutable registry;
    uint256 public nextSubmissionId = 1;
    mapping(uint256 id => Submission) private _submissions;

    event Committed(uint256 indexed id, address indexed hunter, bytes32 commitment);
    event Revealed(uint256 indexed id, string specURI);
    event Accepted(
        uint256 indexed id, address indexed hunter, uint256 reward, address indexed attester
    );
    event Rejected(uint256 indexed id, bytes32 reasonHash, address indexed attester);

    error ZeroAddress();
    error UnknownSubmission(uint256 id);
    error NotHunter();
    error NotAttester();
    error WrongStatus(Status status);
    error BadReveal();
    error InsufficientFunds(uint256 reward, uint256 balance);

    constructor(IERC20 asset_, IBondedRegistry registry_) {
        if (address(asset_) == address(0) || address(registry_) == address(0)) {
            revert ZeroAddress();
        }
        asset = asset_;
        registry = registry_;
    }

    /// @notice The commitment a hunter should submit for a spec.
    function commitmentFor(address hunter, string calldata specURI, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(hunter, specURI, salt));
    }

    function commit(bytes32 commitment) external returns (uint256 id) {
        id = nextSubmissionId++;
        Submission storage s = _submissions[id];
        s.hunter = msg.sender;
        s.commitment = commitment;
        s.committedAt = uint64(block.timestamp);
        s.status = Status.Committed;
        emit Committed(id, msg.sender, commitment);
    }

    function reveal(uint256 id, string calldata specURI, bytes32 salt) external {
        Submission storage s = _existing(id);
        if (msg.sender != s.hunter) revert NotHunter();
        if (s.status != Status.Committed) revert WrongStatus(s.status);
        if (commitmentFor(msg.sender, specURI, salt) != s.commitment) revert BadReveal();
        s.status = Status.Revealed;
        s.specURI = specURI;
        emit Revealed(id, specURI);
    }

    /// @notice Accepts a revealed attack and pays the hunter. Attesters only.
    function accept(uint256 id, uint256 reward) external nonReentrant {
        if (!registry.isAttester(msg.sender)) revert NotAttester();
        Submission storage s = _existing(id);
        if (s.status != Status.Revealed) revert WrongStatus(s.status);
        uint256 balance = asset.balanceOf(address(this));
        if (reward > balance) revert InsufficientFunds(reward, balance);
        s.status = Status.Accepted;
        s.reward = reward;
        if (reward > 0) asset.safeTransfer(s.hunter, reward);
        emit Accepted(id, s.hunter, reward, msg.sender);
    }

    /// @notice Rejects a submission (duplicate, not reproducible, out of scope). Attesters only.
    function reject(uint256 id, bytes32 reasonHash) external {
        if (!registry.isAttester(msg.sender)) revert NotAttester();
        Submission storage s = _existing(id);
        if (s.status != Status.Committed && s.status != Status.Revealed) {
            revert WrongStatus(s.status);
        }
        s.status = Status.Rejected;
        emit Rejected(id, reasonHash, msg.sender);
    }

    function getSubmission(uint256 id) external view returns (Submission memory) {
        return _existing(id);
    }

    function _existing(uint256 id) internal view returns (Submission storage s) {
        s = _submissions[id];
        if (s.status == Status.None) revert UnknownSubmission(id);
    }
}

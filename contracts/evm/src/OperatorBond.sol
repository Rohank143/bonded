// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {IOperatorBond} from "./interfaces/IOperatorBond.sol";
import {IBondedRegistry} from "./interfaces/IBondedRegistry.sol";

/// @notice The part of ClaimsEngine OperatorBond reads.
interface IClaimWindow {
    function claimWindow() external view returns (uint64);
}

/// @title OperatorBond
/// @notice The agent operator's first-loss stake. When a covered agent breaches its mandate,
///         the bond is slashed before the pool pays anything. See docs/PLAN.md Section 6.2.
/// @dev The operator is whoever owns the agent in BondedRegistry. Anyone can add to a bond;
///      only the operator can withdraw, and withdrawals go to the operator.
contract OperatorBond is IOperatorBond, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Bond {
        uint256 amount;
        uint256 pendingWithdrawal;
        uint64 unlockAt;
    }

    uint256 public constant MAX_COOLDOWN = 30 days;

    IERC20 public immutable asset;
    IBondedRegistry public immutable registry;
    uint256 public cooldown;
    ICoverManager public coverManager;
    address public claimsEngine;
    mapping(uint256 agentId => Bond) private _bonds;

    event Staked(uint256 indexed agentId, address indexed operator, uint256 amount);
    event WithdrawRequested(uint256 indexed agentId, uint256 amount, uint64 unlockAt);
    event Withdrawn(uint256 indexed agentId, address indexed operator, uint256 amount);
    event Slashed(uint256 indexed agentId, address indexed to, uint256 amount);
    event CooldownSet(uint256 cooldown);
    event CoverManagerSet(address coverManager);
    event ClaimsEngineSet(address claimsEngine);

    error ZeroAddress();
    error ZeroAmount();
    error AlreadySet();
    error NotOperator();
    error NotClaimsEngine();
    error CooldownTooLong();
    error ExceedsBond();
    error NoPendingWithdrawal();
    error StillCoolingDown();
    error ActiveCover();
    error UnknownAgent(uint256 agentId);
    error ClaimWindowOpen(uint256 until);

    constructor(IERC20 asset_, IBondedRegistry registry_, address owner_, uint256 cooldown_)
        Ownable(owner_)
    {
        if (address(asset_) == address(0) || address(registry_) == address(0)) {
            revert ZeroAddress();
        }
        asset = asset_;
        registry = registry_;
        _setCooldown(cooldown_);
    }

    // ----- Admin -------------------------------------------------------------------------

    function setCoverManager(ICoverManager coverManager_) external onlyOwner {
        if (address(coverManager_) == address(0)) revert ZeroAddress();
        if (address(coverManager) != address(0)) revert AlreadySet();
        coverManager = coverManager_;
        emit CoverManagerSet(address(coverManager_));
    }

    function setClaimsEngine(address claimsEngine_) external onlyOwner {
        if (claimsEngine_ == address(0)) revert ZeroAddress();
        if (claimsEngine != address(0)) revert AlreadySet();
        claimsEngine = claimsEngine_;
        emit ClaimsEngineSet(claimsEngine_);
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        _setCooldown(cooldown_);
    }

    // ----- Operators ---------------------------------------------------------------------

    /// @notice Adds to a registered agent's bond. Anyone can add; only the operator can withdraw.
    function stake(uint256 agentId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (registry.agentOwner(agentId) == address(0)) revert UnknownAgent(agentId);
        _bonds[agentId].amount += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(agentId, msg.sender, amount);
    }

    /// @notice Starts the cooldown for withdrawing `amount`. Replaces any earlier request.
    function requestWithdraw(uint256 agentId, uint256 amount) external {
        Bond storage bond = _bonds[agentId];
        if (msg.sender != registry.agentOwner(agentId)) revert NotOperator();
        if (amount == 0) revert ZeroAmount();
        if (amount > bond.amount) revert ExceedsBond();
        bond.pendingWithdrawal = amount;
        // casting to 'uint64' is safe: timestamps fit and cooldown is capped at 30 days
        // forge-lint: disable-next-line(unsafe-typecast)
        bond.unlockAt = uint64(block.timestamp + cooldown);
        emit WithdrawRequested(agentId, amount, bond.unlockAt);
    }

    /// @notice Withdraws a matured request. Blocked while the agent has active cover, and until
    ///         the claim window after its last policy ended has passed.
    function withdraw(uint256 agentId) external nonReentrant {
        Bond storage bond = _bonds[agentId];
        if (msg.sender != registry.agentOwner(agentId)) revert NotOperator();
        if (bond.pendingWithdrawal == 0) revert NoPendingWithdrawal();
        if (block.timestamp < bond.unlockAt) revert StillCoolingDown();
        _checkNoOpenClaims(agentId);
        uint256 amount = Math.min(bond.pendingWithdrawal, bond.amount);
        bond.amount -= amount;
        bond.pendingWithdrawal = 0;
        asset.safeTransfer(msg.sender, amount);
        emit Withdrawn(agentId, msg.sender, amount);
    }

    // ----- Claims ------------------------------------------------------------------------

    /// @inheritdoc IOperatorBond
    function slash(uint256 agentId, uint256 amount, address to)
        external
        nonReentrant
        returns (uint256 slashed)
    {
        if (msg.sender != claimsEngine || claimsEngine == address(0)) {
            revert NotClaimsEngine();
        }
        Bond storage bond = _bonds[agentId];
        slashed = Math.min(amount, bond.amount);
        if (slashed == 0) return 0;
        bond.amount -= slashed;
        if (bond.pendingWithdrawal > bond.amount) bond.pendingWithdrawal = bond.amount;
        asset.safeTransfer(to, slashed);
        emit Slashed(agentId, to, slashed);
    }

    // ----- Views -------------------------------------------------------------------------

    /// @inheritdoc IOperatorBond
    function bondOf(uint256 agentId) external view returns (uint256) {
        return _bonds[agentId].amount;
    }

    /// @notice The agent's operator (its owner in BondedRegistry).
    function operatorOf(uint256 agentId) external view returns (address) {
        return registry.agentOwner(agentId);
    }

    function getBond(uint256 agentId) external view returns (Bond memory) {
        return _bonds[agentId];
    }

    /// @dev A breach near the end of a term can be claimed during the claim window; the bond must
    ///      still be there to pay first.
    function _checkNoOpenClaims(uint256 agentId) internal view {
        if (address(coverManager) == address(0)) return;
        if (coverManager.activeCoverOfAgent(agentId) > 0) revert ActiveCover();
        uint64 coverEnd = coverManager.coverEndOf(agentId);
        if (coverEnd == 0 || claimsEngine == address(0)) return;
        uint256 until = uint256(coverEnd) + IClaimWindow(claimsEngine).claimWindow();
        if (block.timestamp <= until) revert ClaimWindowOpen(until);
    }

    function _setCooldown(uint256 cooldown_) internal {
        if (cooldown_ > MAX_COOLDOWN) revert CooldownTooLong();
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }
}

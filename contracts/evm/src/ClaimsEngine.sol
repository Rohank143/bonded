// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IOperatorBond} from "./interfaces/IOperatorBond.sol";
import {IMandateVaultFactory} from "./interfaces/IMandateVaultFactory.sol";
import {MandateVault} from "./MandateVault.sol";

/// @title ClaimsEngine
/// @notice Pays parametric claims automatically. Anyone can file (the keeper does it within
///         seconds of a breach). See docs/SPECIFICATION.md Section 11 and ADR-003.
/// @dev For each claim:
///      1. bring premiums up to date (this may lapse or expire the policy, ending coverage);
///      2. check each breach was recorded by the covered vault, unclaimed, not blocked, and
///         inside the coverage window; mark it claimed on the vault;
///      3. payout = min(remaining cover, loss x (1 - deductible));
///      4. unpaid premium for the covered period is netted from the payout (so a breach that
///         drained the vault's premium money is still paid, and cover is never free);
///      5. waterfall: slash the operator bond first, then the pool pays the rest;
///      6. both pay into the vault, restoring the share price for every depositor.
///      A claim the pool can't pay in full reverts, leaving its breaches claimable for later.
contract ClaimsEngine is Ownable2Step, ReentrancyGuard {
    ICoverManager public immutable coverManager;
    ICoverPool public immutable pool;
    IOperatorBond public immutable bond;
    IMandateVaultFactory public immutable factory;

    uint16 public deductibleBps = 1000; // 10%
    /// @notice After a policy ends, breaches from its coverage window can be claimed for this long.
    uint64 public claimWindow = 7 days;
    /// @notice DisputeModule, allowed to pay approved grey-area (T4) claims. Set once.
    address public disputeModule;

    event ClaimPaid(
        uint256 indexed policyId,
        address indexed vault,
        uint256 lossBase,
        uint256 payout,
        uint256 premiumNetted,
        uint256 fromBond,
        uint256 fromPool,
        uint256[] breachIds
    );
    event DeductibleSet(uint16 deductibleBps);
    event ClaimWindowSet(uint64 claimWindow);
    event DisputeModuleSet(address disputeModule);

    error ZeroAddress();
    error InvalidParams(string reason);
    error NoBreaches();
    error ClaimWindowClosed();
    error BreachAlreadyClaimed(uint256 breachId);
    error BreachBlocked(uint256 breachId);
    error BreachOutsideCoverage(uint256 breachId, uint64 timestamp);
    error NothingToPay();
    error PoolShortfall(uint256 needed, uint256 paid);
    error NotDisputeModule();
    error AlreadySet();

    constructor(
        address owner_,
        ICoverManager coverManager_,
        ICoverPool pool_,
        IOperatorBond bond_,
        IMandateVaultFactory factory_
    ) Ownable(owner_) {
        if (
            address(coverManager_) == address(0) || address(pool_) == address(0)
                || address(bond_) == address(0) || address(factory_) == address(0)
        ) revert ZeroAddress();
        coverManager = coverManager_;
        pool = pool_;
        bond = bond_;
        factory = factory_;
    }

    /// @notice Files and pays a claim for `breachIds` recorded by the policy's vault.
    /// @return paid Total paid into the vault (bond + pool).
    function fileClaim(uint256 policyId, uint256[] calldata breachIds)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (breachIds.length == 0) revert NoBreaches();

        coverManager.accrue(policyId);
        ICoverManager.Policy memory policy = coverManager.getPolicy(policyId);
        (uint64 coveredFrom, uint64 coveredUntil) = coverManager.coverageWindow(policyId);
        if (
            policy.status != ICoverManager.Status.Active
                && block.timestamp > coveredUntil + claimWindow
        ) {
            revert ClaimWindowClosed();
        }

        uint256 lossUsd6 =
            _collectLoss(MandateVault(policy.vault), breachIds, coveredFrom, coveredUntil);
        if (lossUsd6 == 0) revert NothingToPay();
        paid = _pay(policyId, policy, _usd6ToBase(MandateVault(policy.vault), lossUsd6), breachIds);
    }

    /// @notice Pays a grey-area (T4) claim that DisputeModule approved. Same deductible, premium
    ///         netting and waterfall as parametric claims; no breach records are involved.
    /// @param lossBase The approved loss in base-asset units.
    function payDispute(uint256 policyId, uint256 lossBase)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (msg.sender != disputeModule || disputeModule == address(0)) {
            revert NotDisputeModule();
        }
        coverManager.accrue(policyId);
        ICoverManager.Policy memory policy = coverManager.getPolicy(policyId);
        (, uint64 coveredUntil) = coverManager.coverageWindow(policyId);
        if (
            policy.status != ICoverManager.Status.Active
                && block.timestamp > coveredUntil + claimWindow
        ) {
            revert ClaimWindowClosed();
        }
        paid = _pay(policyId, policy, lossBase, new uint256[](0));
    }

    // ----- Admin -------------------------------------------------------------------------

    function setDisputeModule(address disputeModule_) external onlyOwner {
        if (disputeModule_ == address(0)) revert ZeroAddress();
        if (disputeModule != address(0)) revert AlreadySet();
        disputeModule = disputeModule_;
        emit DisputeModuleSet(disputeModule_);
    }

    function setDeductible(uint16 deductibleBps_) external onlyOwner {
        if (deductibleBps_ > 5000) revert InvalidParams("deductibleBps");
        deductibleBps = deductibleBps_;
        emit DeductibleSet(deductibleBps_);
    }

    function setClaimWindow(uint64 claimWindow_) external onlyOwner {
        if (claimWindow_ < 1 hours || claimWindow_ > 90 days) revert InvalidParams("claimWindow");
        claimWindow = claimWindow_;
        emit ClaimWindowSet(claimWindow_);
    }

    // ----- Internals ---------------------------------------------------------------------

    struct Payout {
        uint256 lossBase;
        uint256 gross; // min(remaining cover, loss minus deductible)
        uint256 netted; // unpaid premium settled out of the gross payout
        uint256 fromBond;
        uint256 fromPool;
    }

    /// @dev Computes the payout, nets unpaid premium, and runs the waterfall: bond, then pool.
    function _pay(
        uint256 policyId,
        ICoverManager.Policy memory policy,
        uint256 lossBase,
        uint256[] memory breachIds
    ) internal returns (uint256 paid) {
        Payout memory p;
        p.lossBase = lossBase;
        p.gross = Math.min(
            policy.remainingCover,
            Math.mulDiv(p.lossBase, BondedTypes.BPS - deductibleBps, BondedTypes.BPS)
        );
        if (p.gross == 0) revert NothingToPay();

        p.netted = Math.min(coverManager.premiumDebt(policyId), p.gross);
        uint256 toVault = p.gross - p.netted;
        if (toVault > 0) p.fromBond = bond.slash(policy.agentId, toVault, policy.vault);
        if (toVault > p.fromBond) {
            uint256 needed = toVault - p.fromBond;
            p.fromPool = pool.payClaim(policy.vault, needed);
            // Never finalize a partly paid claim: revert so the breaches stay claimable until the
            // pool can pay in full.
            if (p.fromPool < needed) revert PoolShortfall(needed, p.fromPool);
        }
        paid = p.fromBond + p.fromPool;

        coverManager.recordClaim(policyId, paid, p.netted);
        emit ClaimPaid(
            policyId, policy.vault, p.lossBase, p.gross, p.netted, p.fromBond, p.fromPool, breachIds
        );
    }

    /// @dev Validates each breach, marks it claimed on the vault and sums the losses.
    function _collectLoss(
        MandateVault vault,
        uint256[] calldata breachIds,
        uint64 coveredFrom,
        uint64 coveredUntil
    ) internal returns (uint256 lossUsd6) {
        for (uint256 i; i < breachIds.length; ++i) {
            uint256 breachId = breachIds[i];
            MandateVault.Breach memory breach = vault.getBreach(breachId);
            if (breach.claimed) revert BreachAlreadyClaimed(breachId);
            if (breach.blocked) revert BreachBlocked(breachId);
            if (breach.timestamp < coveredFrom || breach.timestamp > coveredUntil) {
                revert BreachOutsideCoverage(breachId, breach.timestamp);
            }
            vault.markBreachClaimed(breachId);
            lossUsd6 += breach.lossUsd6;
        }
    }

    /// @dev Converts a USD amount (6 decimals) into base-asset units using the vault's oracle.
    function _usd6ToBase(MandateVault vault, uint256 usd6) internal view returns (uint256) {
        address base = vault.asset();
        uint256 oneBase = 10 ** IERC20Metadata(base).decimals();
        return Math.mulDiv(usd6, oneBase, vault.oracle().valueInUsd6(base, oneBase));
    }
}

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
///         seconds of a breach). See docs/PLAN.md Section 11 and ADR-003.
/// @dev For each claim:
///      1. bring premiums up to date (this may lapse or expire the policy, ending coverage);
///      2. check each breach was recorded by the covered vault, unclaimed, not blocked, and
///         inside the coverage window; mark it claimed on the vault;
///      3. payout = min(remaining cover, loss x (1 - deductible));
///      4. waterfall: slash the operator bond first, then the pool pays the rest;
///      5. both pay into the vault, restoring the share price for every depositor.
contract ClaimsEngine is Ownable2Step, ReentrancyGuard {
    ICoverManager public immutable coverManager;
    ICoverPool public immutable pool;
    IOperatorBond public immutable bond;
    IMandateVaultFactory public immutable factory;

    uint16 public deductibleBps = 1000; // 10%
    /// @notice After a policy ends, breaches from its coverage window can be claimed for this long.
    uint64 public claimWindow = 7 days;

    event ClaimPaid(
        uint256 indexed policyId,
        address indexed vault,
        uint256 lossBase,
        uint256 payout,
        uint256 fromBond,
        uint256 fromPool,
        uint256[] breachIds
    );
    event DeductibleSet(uint16 deductibleBps);
    event ClaimWindowSet(uint64 claimWindow);

    error ZeroAddress();
    error InvalidParams(string reason);
    error NoBreaches();
    error ClaimWindowClosed();
    error BreachAlreadyClaimed(uint256 breachId);
    error BreachBlocked(uint256 breachId);
    error BreachOutsideCoverage(uint256 breachId, uint64 timestamp);
    error NothingToPay();

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
        paid = _pay(policyId, policy, lossUsd6, breachIds);
    }

    // ----- Admin -------------------------------------------------------------------------

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

    /// @dev Computes the payout and runs the waterfall: bond first, then the pool.
    function _pay(
        uint256 policyId,
        ICoverManager.Policy memory policy,
        uint256 lossUsd6,
        uint256[] calldata breachIds
    ) internal returns (uint256 paid) {
        MandateVault vault = MandateVault(policy.vault);
        uint256 lossBase = _usd6ToBase(vault, lossUsd6);
        uint256 payout = Math.min(
            policy.remainingCover,
            Math.mulDiv(lossBase, BondedTypes.BPS - deductibleBps, BondedTypes.BPS)
        );
        if (payout == 0) revert NothingToPay();

        uint256 fromBond = bond.slash(policy.agentId, payout, address(vault));
        uint256 fromPool = payout > fromBond ? pool.payClaim(address(vault), payout - fromBond) : 0;
        paid = fromBond + fromPool;
        coverManager.recordClaim(policyId, paid);
        emit ClaimPaid(policyId, address(vault), lossBase, payout, fromBond, fromPool, breachIds);
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

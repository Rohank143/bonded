// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {ClaimsEngine} from "../src/ClaimsEngine.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

/// @notice End-to-end: bind cover, breach, claim, bond slashed, pool pays, vault restored.
contract ClaimsEngineTest is ProtocolBase {
    uint256 internal policyId;

    function setUp() public override {
        super.setUp();
        policyId = _bindDefault();
        vm.warp(block.timestamp + 1 days); // past the waiting period
    }

    function _steal(uint256 amount) internal {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
    }

    // ----- The demo loop -----------------------------------------------------------------

    function test_FullLoop_BondPaysTheWholeClaim() public {
        _steal(5000e6);
        assertTrue(vault.frozen());
        uint256 vaultBefore = usdg.balanceOf(address(vault));

        uint256 paid = claims.fileClaim(policyId, _ids(0));

        assertEq(paid, 4500e6); // 5,000 loss minus the 10% deductible
        assertEq(bond.bondOf(agentId), BOND - 4500e6); // the operator pays first
        // The claim first settles one day of premium, then pays 4,500 into the vault.
        uint256 premium = _expectedPremium(COVER, RATE_BPS, 1 days);
        assertEq(usdg.balanceOf(address(vault)), vaultBefore - premium + 4500e6);
        assertTrue(vault.getBreach(0).claimed);
        assertEq(_policy(policyId).remainingCover, COVER - 4500e6);
        assertEq(manager.totalActiveCover(), COVER - 4500e6);
    }

    function test_FullLoop_BondThenPool() public {
        // A second agent whose operator bonded only the 10% minimum.
        MandateVault vault43 = _vaultFor(agentId2);
        _stake(agentId2, 2000e6);
        uint256 p43 = _buy(vault43, _quote(vault43, COVER, RATE_BPS, SCORE));
        vm.warp(block.timestamp + 1 days);
        _exec(vault43, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));

        uint256 poolBefore = usdg.balanceOf(address(pool));
        vm.expectEmit(true, true, false, false);
        emit ClaimsEngine.ClaimPaid(p43, address(vault43), 0, 0, 0, 0, 0, new uint256[](0));
        uint256 paid = claims.fileClaim(p43, _ids(0));

        assertEq(paid, 4500e6);
        assertEq(bond.bondOf(agentId2), 0); // 2,000 slashed
        assertEq(poolBefore - usdg.balanceOf(address(pool)), 2500e6 - _premiumToPool(p43)); // pool paid 2,500
    }

    function test_FullDrainIsStillPaid() public {
        // The breach takes every unit of base asset, so the premium can't be collected at claim time.
        uint256 everything = usdg.balanceOf(address(vault));
        _steal(everything);
        assertEq(usdg.balanceOf(address(vault)), 0);

        uint256 paid = claims.fileClaim(policyId, _ids(0));

        // Payout is capped at the 20,000 cover; one day of unpaid premium is netted from it.
        uint256 premium = _expectedPremium(COVER, RATE_BPS, 1 days);
        assertEq(paid, COVER - premium);
        assertEq(usdg.balanceOf(address(vault)), COVER - premium);
        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Exhausted));
        assertEq(p.remainingCover, 0);
        assertEq(manager.totalActiveCover(), 0);
    }

    function test_BreachDuringTheGracePeriodIsPaidWithDebtNetted() public {
        // The vault's base asset runs out, so a premium is missed and the grace period starts...
        uint256 shares = vault.maxRedeem(depositor);
        vm.prank(depositor);
        vault.redeem(shares, depositor, depositor);
        manager.accrue(policyId);
        assertGt(_policy(policyId).pastDueSince, 0);

        // ...then new deposits arrive and are stolen during the grace period.
        usdg.mint(address(vault), 3000e6);
        vm.warp(block.timestamp + 1 days);
        _steal(3000e6);

        vm.warp(block.timestamp + 1 days);
        uint256 paid = claims.fileClaim(policyId, _ids(0));

        uint256 debt = _expectedPremium(COVER, RATE_BPS, 3 days); // unpaid since binding
        assertEq(paid, 2700e6 - debt);
        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Active));
        assertEq(p.pastDueSince, 0); // the netted premium brought it current
        assertEq(p.paidUntil, block.timestamp);
        assertEq(p.remainingCover, COVER - 2700e6);
    }

    function test_AClaimThePoolCannotFullyPayRevertsAndStaysClaimable() public {
        // The operator bonded only the minimum, and the pool has almost nothing left.
        MandateVault vault43 = _vaultFor(agentId2);
        _stake(agentId2, 2000e6);
        uint256 p43 = _buy(vault43, _quote(vault43, COVER, RATE_BPS, SCORE));
        vm.warp(block.timestamp + 1 days);
        _exec(vault43, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        uint256 poolBalance = usdg.balanceOf(address(pool));
        vm.prank(address(claims));
        pool.payClaim(treasury, poolBalance - 100e6); // simulate earlier claims draining the pool

        vm.expectPartialRevert(ClaimsEngine.PoolShortfall.selector);
        claims.fileClaim(p43, _ids(0));
        assertFalse(vault43.getBreach(0).claimed); // still claimable

        _depositToPool(underwriter, 10_000e6); // liquidity returns
        assertEq(claims.fileClaim(p43, _ids(0)), 4500e6);
    }

    function test_DeferredLossIsClaimable() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)));
        vm.prank(attacker);
        assertTrue(usdg.transferFrom(address(vault), attacker, 3000e6));
        vault.reconcile();

        uint256 paid = claims.fileClaim(policyId, _ids(0, 1)); // approval (loss 0) + deferred (3,000)
        assertEq(paid, 2700e6);
    }

    // ----- What isn't paid ---------------------------------------------------------------

    function test_CannotClaimTheSameBreachTwice() public {
        _steal(1000e6);
        claims.fileClaim(policyId, _ids(0));
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachAlreadyClaimed.selector, 0));
        claims.fileClaim(policyId, _ids(0));
    }

    function test_DuplicateIdsInOneClaimAreRejected() public {
        _steal(1000e6);
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachAlreadyClaimed.selector, 0));
        claims.fileClaim(policyId, _ids(0, 0));
    }

    function test_BreachDuringTheWaitingPeriodIsNotCovered() public {
        MandateVault vault43 = _vaultFor(agentId2);
        _stake(agentId2, 2000e6);
        uint256 p43 = _buy(vault43, _quote(vault43, COVER, RATE_BPS, SCORE));
        _exec(vault43, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1000e6))); // same block as binding

        vm.expectPartialRevert(ClaimsEngine.BreachOutsideCoverage.selector);
        claims.fileClaim(p43, _ids(0));
    }

    function test_BreachAfterThePolicyEndsIsNotCovered() public {
        vm.warp(block.timestamp + 30 days); // policy expired
        _steal(1000e6);
        vm.expectPartialRevert(ClaimsEngine.BreachOutsideCoverage.selector);
        claims.fileClaim(policyId, _ids(0));
    }

    function test_ClaimsAfterExpiryMustComeWithinTheWindow() public {
        _steal(1000e6); // day 1: covered
        vm.warp(block.timestamp + 29 days + 7 days + 1); // expired 7 days + 1s ago
        vm.expectRevert(ClaimsEngine.ClaimWindowClosed.selector);
        claims.fileClaim(policyId, _ids(0));
    }

    function test_ClaimAfterExpiryWithinTheWindowIsPaid() public {
        _steal(1000e6);
        vm.warp(block.timestamp + 29 days + 3 days);
        assertEq(claims.fileClaim(policyId, _ids(0)), 900e6);
        assertEq(uint8(_policy(policyId).status), uint8(ICoverManager.Status.Expired));
    }

    function test_BlockedBreachesAreNotClaimable() public {
        BondedTypes.MandateParams memory params = _params(BondedTypes.MandateMode.Enforce);
        MandateVault strict =
            MandateVault(factory.createVault(params, agent, guardian, agentId2, "v", "v"));
        usdg.mint(address(strict), 10_000e6); // funding without shares is enough for this test
        _stake(agentId2, 2000e6);
        uint256 p43 = _buy(strict, _quote(strict, COVER, RATE_BPS, SCORE));
        vm.warp(block.timestamp + 1 days);
        _exec(strict, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1000e6)));

        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachBlocked.selector, 0));
        claims.fileClaim(p43, _ids(0));
    }

    function test_ZeroLossBreachesPayNothing() public {
        _exec(vault, address(stranger), abi.encodeWithSignature("ping()"));
        vm.expectRevert(ClaimsEngine.NothingToPay.selector);
        claims.fileClaim(policyId, _ids(0));
    }

    function test_EmptyClaimsAreRejected() public {
        vm.expectRevert(ClaimsEngine.NoBreaches.selector);
        claims.fileClaim(policyId, new uint256[](0));
    }

    // ----- Limits ------------------------------------------------------------------------

    function test_PayoutIsCappedByRemainingCoverAndExhaustsThePolicy() public {
        MandateVault vault43 = _vaultFor(agentId2);
        _stake(agentId2, 1000e6);
        uint256 p43 = _buy(vault43, _quote(vault43, 2000e6, RATE_BPS, SCORE));
        vm.warp(block.timestamp + 1 days);
        _exec(vault43, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));

        assertEq(claims.fileClaim(p43, _ids(0)), 2000e6);
        ICoverManager.Policy memory p = _policy(p43);
        assertEq(p.remainingCover, 0);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Exhausted));
        assertEq(manager.activeCoverOfAgent(agentId2), 0);
    }

    function testFuzz_PayoutFollowsTheWaterfall(uint256 loss, uint256 bonded) public {
        loss = bound(loss, 1e6, 20_000e6);
        bonded = bound(bonded, 2000e6, 20_000e6);
        MandateVault vault43 = _vaultFor(agentId2);
        _stake(agentId2, bonded);
        uint256 p43 = _buy(vault43, _quote(vault43, COVER, RATE_BPS, SCORE));
        vm.warp(block.timestamp + 1 days);
        _exec(vault43, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, loss)));

        uint256 expected = loss * 9000 / 10_000;
        uint256 paid = claims.fileClaim(p43, _ids(0));
        assertEq(paid, expected);
        uint256 fromBond = expected < bonded ? expected : bonded;
        assertEq(bond.bondOf(agentId2), bonded - fromBond);
    }

    // ----- Admin -------------------------------------------------------------------------

    function test_AdminParamsAreBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimsEngine.InvalidParams.selector, "deductibleBps")
        );
        claims.setDeductible(5001);
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.InvalidParams.selector, "claimWindow"));
        claims.setClaimWindow(1);
        claims.setDeductible(0);
        vm.stopPrank();

        _steal(1000e6);
        assertEq(claims.fileClaim(policyId, _ids(0)), 1000e6);
    }

    // ----- Helpers -----------------------------------------------------------------------

    function _vaultFor(uint256 id) internal returns (MandateVault v) {
        v = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, id, "v", "v"
            )
        );
        usdg.mint(depositor, DEPOSIT);
        vm.startPrank(depositor);
        usdg.approve(address(v), DEPOSIT);
        v.deposit(DEPOSIT, depositor);
        vm.stopPrank();
    }

    /// @dev Pool's share of the premium paid when the claim accrued the policy.
    function _premiumToPool(uint256 id) internal view returns (uint256) {
        ICoverManager.Policy memory p = _policy(id);
        uint256 owed = _expectedPremium(p.coverAmount, p.premiumRateBps, p.paidUntil - p.startedAt);
        return owed - owed * 1500 / 10_000 - owed * 500 / 10_000;
    }
}

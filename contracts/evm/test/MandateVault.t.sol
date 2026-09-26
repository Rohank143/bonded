// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultBase} from "./MandateVaultBase.t.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockTarget, ReentrantTarget} from "./mocks/MockTargets.sol";

/// @notice Monitor mode: breaches execute, are recorded with their loss, and freeze the agent.
contract MandateVaultMonitorTest is MandateVaultBase {
    MandateVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _createVault(BondedTypes.MandateMode.Monitor);
        _approveRouter(vault);
    }

    // ----- Allowed actions -----------------------------------------------------------------

    function test_AllowedSwapRecordsNoBreach() public {
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 1000e6, address(vault))
        );

        assertEq(vault.breachCount(), 0);
        assertFalse(vault.frozen());
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT - 1000e6);
        assertEq(tsla.balanceOf(address(vault)), 3.992e18); // 4 TSLA minus 0.2%
        assertEq(vault.currentWindowNotionalUsd6(), 1000e6);
    }

    function test_ApprovingAnAllowedSpenderIsAllowed() public view {
        assertEq(vault.breachCount(), 0); // setUp approved the router
        assertEq(usdg.allowance(address(vault), address(router)), type(uint256).max);
    }

    function test_RevokingAnyApprovalIsAllowed() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.approve, (attacker, 0)));
        assertEq(vault.breachCount(), 0);
    }

    function test_TransferToAllowedDestinationIsNotALeak() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (treasury, 1000e6)));
        assertEq(vault.breachCount(), 0);
        assertEq(usdg.balanceOf(treasury), 1000e6);
        assertEq(vault.currentWindowNotionalUsd6(), 1000e6); // still counts toward limits
    }

    function test_TransferToAllowedDestinationStillRespectsLimits() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (treasury, 6000e6)));
        assertEq(uint8(_lastBreach(vault).breachType), uint8(BondedTypes.BreachType.Limit));
    }

    // ----- T1 ----------------------------------------------------------------------------

    function test_UnauthorizedTransferRecordsFullLoss() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));

        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertEq(breach.lossUsd6, 5000e6);
        assertFalse(breach.blocked);
        assertFalse(breach.claimed);
        assertEq(breach.target, address(usdg));
        assertEq(breach.selector, IERC20.transfer.selector);
        assertTrue(vault.frozen());
        assertEq(usdg.balanceOf(attacker), 5000e6);
    }

    function test_TransferFromToUnauthorizedRecipientIsT1() public {
        // A third party approved the vault; moving its tokens to the attacker still breaks the mandate.
        address victim = makeAddr("victim");
        usdg.mint(victim, 1e6);
        vm.prank(victim);
        usdg.approve(address(vault), 1e6);

        _exec(vault, address(usdg), abi.encodeCall(IERC20.transferFrom, (victim, attacker, 1e6)));
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertEq(breach.lossUsd6, 0); // the vault itself lost nothing
    }

    function test_CallToUnknownContractIsUnauthorizedTarget() public {
        _exec(vault, address(stranger), abi.encodeCall(MockTarget.ping, ()));

        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTarget));
        assertEq(breach.lossUsd6, 0);
        assertEq(stranger.pings(), 1); // Monitor mode lets it run
        assertTrue(vault.frozen());
    }

    function test_DisallowedSelectorOnAllowedTargetIsUnauthorizedTarget() public {
        _exec(vault, address(router), abi.encodeCall(MockRouter.sweep, (address(usdg), attacker)));
        assertEq(
            uint8(_lastBreach(vault).breachType), uint8(BondedTypes.BreachType.UnauthorizedTarget)
        );
    }

    function test_UnauthorizedApprovalThenDeferredLoss() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)));
        MandateVault.Breach memory approval = _lastBreach(vault);
        assertEq(uint8(approval.breachType), uint8(BondedTypes.BreachType.UnauthorizedApproval));
        assertEq(approval.lossUsd6, 0);
        assertTrue(vault.frozen());

        // The attacker pulls funds later, outside execute.
        vm.prank(attacker);
        assertTrue(usdg.transferFrom(address(vault), attacker, 3000e6));
        vault.reconcile();

        MandateVault.Breach memory deferred = _lastBreach(vault);
        assertEq(uint8(deferred.breachType), uint8(BondedTypes.BreachType.Deferred));
        assertEq(deferred.lossUsd6, 3000e6);
        assertEq(vault.breachCount(), 2);
    }

    function test_DeferredLossIsRecordedBeforeADepositCanHideIt() public {
        // A compromised allowed router abuses its allowance outside execute...
        router.drain(address(usdg), address(vault), attacker, 2000e6);
        // ...then someone deposits. The deposit must not paper over the missing funds.
        usdg.mint(address(this), 500e6);
        usdg.approve(address(vault), 500e6);
        vault.deposit(500e6, address(this));

        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Deferred));
        assertEq(breach.lossUsd6, 2000e6);
    }

    function test_ReconcileWithNoDropRecordsNothing() public {
        usdg.mint(address(vault), 1e6); // incoming funds are not a breach
        vault.reconcile();
        assertEq(vault.breachCount(), 0);
    }

    // ----- T2 ----------------------------------------------------------------------------

    function test_ActionAboveTxLimitIsLimitBreach() public {
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 6000e6, address(vault))
        );

        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Limit));
        assertEq(breach.lossUsd6, 12e6); // only the 0.2% slippage was lost
    }

    function test_DailyLimitAccumulatesAndResets() public {
        for (uint256 i; i < 5; ++i) {
            _exec(
                vault,
                address(router),
                _swapData(address(usdg), address(tsla), 5000e6, address(vault))
            );
        }
        assertEq(vault.breachCount(), 0);
        assertEq(vault.currentWindowNotionalUsd6(), 25_000e6);

        _exec(vault, address(router), _swapData(address(usdg), address(tsla), 1e6, address(vault)));
        assertEq(uint8(_lastBreach(vault).breachType), uint8(BondedTypes.BreachType.Limit));
    }

    function test_WindowResetsAfterADay() public {
        for (uint256 i; i < 5; ++i) {
            _exec(
                vault,
                address(router),
                _swapData(address(usdg), address(tsla), 5000e6, address(vault))
            );
        }
        vm.warp(block.timestamp + 1 days);
        assertEq(vault.currentWindowNotionalUsd6(), 0);
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 5000e6, address(vault))
        );
        assertEq(vault.breachCount(), 0);
    }

    // ----- T3 ----------------------------------------------------------------------------

    function test_SwapIntoLookalikeTokenIsAssetBreach() public {
        _exec(
            vault,
            address(router),
            _swapData(address(usdg), address(honeypot), 2000e6, address(vault))
        );

        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Asset));
        assertEq(breach.lossUsd6, 2000e6); // the lookalike is worth nothing to the vault
        assertTrue(vault.frozen());
    }

    function test_SwapWithAttackerAsRecipientIsAssetBreach() public {
        _exec(vault, address(router), _swapData(address(usdg), address(tsla), 1000e6, attacker));
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Asset));
        assertEq(breach.lossUsd6, 1000e6);
    }

    function test_AssetBreachTakesPrecedenceOverLimit() public {
        _exec(
            vault,
            address(router),
            _swapData(address(usdg), address(honeypot), 6000e6, address(vault))
        );
        assertEq(vault.breachCount(), 1);
        assertEq(uint8(_lastBreach(vault).breachType), uint8(BondedTypes.BreachType.Asset));
    }

    // ----- One breach per action ----------------------------------------------------------

    function test_T1TakesPrecedenceAndLossIsCountedOnce() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 6000e6))); // T1 and above limit
        assertEq(vault.breachCount(), 1);
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertEq(breach.lossUsd6, 6000e6);
    }

    // ----- Freeze and guardian ------------------------------------------------------------

    function test_FrozenAgentCannotExecute() public {
        _exec(vault, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        vm.prank(agent);
        vm.expectRevert(MandateVault.AgentFrozen.selector);
        vault.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, address(vault)));
    }

    function test_GuardianRotatesAndUnfreezes() public {
        _exec(vault, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        address newAgent = makeAddr("newAgent");

        vm.startPrank(guardian);
        vault.rotateAgent(newAgent);
        vault.unfreeze();
        vm.stopPrank();

        assertEq(vault.agent(), newAgent);
        assertFalse(vault.frozen());
        vm.prank(newAgent);
        vault.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, address(vault)));

        vm.prank(agent);
        vm.expectRevert(MandateVault.NotAgent.selector);
        vault.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, address(vault)));
    }

    function test_OnlyGuardianManagesTheAgent() public {
        vm.startPrank(attacker);
        vm.expectRevert(MandateVault.NotGuardian.selector);
        vault.freeze();
        vm.expectRevert(MandateVault.NotGuardian.selector);
        vault.unfreeze();
        vm.expectRevert(MandateVault.NotGuardian.selector);
        vault.rotateAgent(attacker);
        vm.stopPrank();

        vm.prank(guardian);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        vault.rotateAgent(address(0));
    }

    function test_GuardianCanFreezeAnytime() public {
        vm.prank(guardian);
        vault.freeze();
        assertTrue(vault.frozen());
    }

    function test_DepositorsCanWithdrawWhileFrozen() public {
        _exec(vault, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        uint256 shares = vault.balanceOf(depositor);
        vm.prank(depositor);
        vault.redeem(shares, depositor, depositor);
        assertEq(usdg.balanceOf(depositor), DEPOSIT);
    }

    // ----- Access and safety --------------------------------------------------------------

    function test_OnlyAgentCanExecute() public {
        vm.prank(attacker);
        vm.expectRevert(MandateVault.NotAgent.selector);
        vault.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, attacker));
    }

    function test_AgentCannotCallTheVaultItself() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.CannotCallVault.selector);
        vault.execute(address(vault), abi.encodeCall(MandateVault.unfreeze, ()));
    }

    function test_MeasuredCallIsOnlyCallableByTheVault() public {
        vm.prank(agent);
        vm.expectRevert(MandateVault.OnlySelf.selector);
        vault.measuredCall(
            address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1)), false, true
        );
    }

    function test_FailedTargetCallBubblesItsRevertAndRecordsNothing() public {
        uint256 tooMuch = DEPOSIT + 1;
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, address(vault), DEPOSIT, tooMuch
            )
        );
        vault.execute(
            address(router), _swapData(address(usdg), address(tsla), tooMuch, address(vault))
        );
        assertEq(vault.breachCount(), 0);
    }

    function test_TargetCannotReenterTheVault() public {
        vm.prank(agent);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.execute(
            address(reentrant), abi.encodeCall(ReentrantTarget.poke, (address(vault), 1e6))
        );
    }

    // ----- Protocol modules ---------------------------------------------------------------

    function test_OnlyClaimsEngineMarksBreachesClaimed() public {
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1000e6)));

        vm.expectRevert(MandateVault.NotClaimsEngine.selector);
        vault.markBreachClaimed(0); // not set yet

        vm.prank(owner);
        factory.setClaimsEngine(claimsEngine);

        vm.prank(attacker);
        vm.expectRevert(MandateVault.NotClaimsEngine.selector);
        vault.markBreachClaimed(0);

        vm.startPrank(claimsEngine);
        vault.markBreachClaimed(0);
        assertTrue(vault.getBreach(0).claimed);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.BreachAlreadyClaimed.selector, 0));
        vault.markBreachClaimed(0);
        vm.expectRevert(abi.encodeWithSelector(MandateVault.UnknownBreach.selector, 7));
        vault.markBreachClaimed(7);
        vm.stopPrank();
    }

    function test_OnlyCoverManagerPullsPremiumAndItIsNotABreach() public {
        vm.expectRevert(MandateVault.NotCoverManager.selector);
        vault.payPremium(1e6);

        vm.prank(owner);
        factory.setCoverManager(coverManager);

        vm.prank(coverManager);
        vault.payPremium(100e6);
        assertEq(usdg.balanceOf(coverManager), 100e6);

        vault.reconcile();
        assertEq(vault.breachCount(), 0);
    }

    // ----- NAV ----------------------------------------------------------------------------

    function test_TotalAssetsValuesEveryAllowedAsset() public {
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 1000e6, address(vault))
        );
        // 39,000 USDG + 3.992 TSLA at $250 = 39,998 USDG
        assertEq(vault.totalAssets(), 39_998e6);
    }

    function test_WithdrawalsAreCappedByTheBaseBalance() public {
        for (uint256 i; i < 5; ++i) {
            _exec(
                vault,
                address(router),
                _swapData(address(usdg), address(tsla), 5000e6, address(vault))
            );
        }
        // Capped by the 15,000 USDG base balance; rounding down may cost at most 1 unit.
        assertLe(vault.maxWithdraw(depositor), 15_000e6);
        assertApproxEqAbs(vault.maxWithdraw(depositor), 15_000e6, 1);
        assertLe(vault.convertToAssets(vault.maxRedeem(depositor)), 15_000e6);
    }

    // ----- Fuzz ---------------------------------------------------------------------------

    function testFuzz_DepositRedeemRoundTrip(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000e6);
        address alice = makeAddr("alice");
        usdg.mint(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, alice);
        uint256 out = vault.redeem(shares, alice, alice);
        vm.stopPrank();
        assertLe(out, amount);
        assertGe(out + 1, amount);
        assertEq(vault.breachCount(), 0);
    }

    function testFuzz_UnauthorizedTransferLossEqualsAmount(uint256 amount) public {
        amount = bound(amount, 1, DEPOSIT);
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
        assertEq(_lastBreach(vault).lossUsd6, amount);
    }

    function testFuzz_SwapWithinSlippageAndLimitsIsClean(uint256 amount) public {
        amount = bound(amount, 1e6, 5000e6);
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), amount, address(vault))
        );
        assertEq(vault.breachCount(), 0);
    }
}

/// @notice Enforce mode: breaches have no effect, the attempt is recorded and the agent frozen.
contract MandateVaultEnforceTest is MandateVaultBase {
    MandateVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _createVault(BondedTypes.MandateMode.Enforce);
        _approveRouter(vault);
    }

    function test_AllowedSwapWorks() public {
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 1000e6, address(vault))
        );
        assertEq(vault.breachCount(), 0);
        assertEq(tsla.balanceOf(address(vault)), 3.992e18);
    }

    function test_UnauthorizedTransferIsBlocked() public {
        bytes memory result =
            _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));

        assertEq(result.length, 0);
        assertEq(usdg.balanceOf(attacker), 0);
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT);
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertTrue(breach.blocked);
        assertEq(breach.lossUsd6, 0);
        assertTrue(vault.frozen());
    }

    function test_UnauthorizedTargetIsNotCalled() public {
        _exec(vault, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        assertEq(stranger.pings(), 0);
        assertTrue(_lastBreach(vault).blocked);
    }

    function test_LimitBreachIsRolledBack() public {
        _exec(
            vault, address(router), _swapData(address(usdg), address(tsla), 6000e6, address(vault))
        );

        assertEq(usdg.balanceOf(address(vault)), DEPOSIT);
        assertEq(tsla.balanceOf(address(vault)), 0);
        assertEq(vault.currentWindowNotionalUsd6(), 0);
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Limit));
        assertTrue(breach.blocked);
        assertTrue(vault.frozen());
    }

    function test_LookalikeSwapIsRolledBack() public {
        _exec(
            vault,
            address(router),
            _swapData(address(usdg), address(honeypot), 2000e6, address(vault))
        );

        assertEq(usdg.balanceOf(address(vault)), DEPOSIT);
        assertEq(honeypot.balanceOf(address(vault)), 0);
        MandateVault.Breach memory breach = _lastBreach(vault);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Asset));
        assertTrue(breach.blocked);
    }

    function test_FailedTargetCallStillBubbles() public {
        vm.prank(agent);
        vm.expectRevert();
        vault.execute(
            address(router), _swapData(address(usdg), address(tsla), DEPOSIT + 1, address(vault))
        );
        assertEq(vault.breachCount(), 0);
    }

    function testFuzz_UnauthorizedTransferNeverMovesFunds(uint256 amount) public {
        amount = bound(amount, 1, DEPOSIT);
        _exec(vault, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
        assertEq(usdg.balanceOf(address(vault)), DEPOSIT);
        assertTrue(_lastBreach(vault).blocked);
    }
}

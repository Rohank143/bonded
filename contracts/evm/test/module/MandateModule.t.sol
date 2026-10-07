// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateErrors} from "../../src/libraries/MandateErrors.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateBase} from "../../src/MandateBase.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockTarget} from "../mocks/MockTargets.sol";
import {ModuleTestBase, ITestAccount} from "./ModuleTestBase.sol";

/// @notice A target that tries to reach back into the module while the agent's call runs.
contract ModuleReentrantTarget {
    function poke(address module) external {
        MandateModule(module).reconcile();
    }
}

/// @notice An executor the owner installed for something else. If it acts on the account while
///         the agent's call is running, the module's hook must refuse.
contract SideExecutor {
    function onInstall(bytes calldata) external {}

    function onUninstall(bytes calldata) external {}

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 2;
    }

    function isInitialized(address) external pure returns (bool) {
        return true;
    }

    function pull(address account, address token, address to, uint256 amount) external {
        bytes memory call = abi.encodeCall(IERC20.transfer, (to, amount));
        IExecutorTarget(account)
            .executeFromExecutor(bytes32(0), abi.encodePacked(token, uint256(0), call));
    }
}

interface IExecutorTarget {
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory);
}

/// @notice Monitor mode on an ERC-7579 account: the same verdicts as MandateVault, measured on
///         the account's balances, plus the module's own rules (installation, hook, owner).
abstract contract MandateModuleMonitorTests is ModuleTestBase {
    address internal account;
    MandateModule internal module;

    function kind() internal pure virtual returns (Kind);

    function setUp() public override {
        super.setUp();
        (account, module) = _protectedAccount(kind(), BondedTypes.MandateMode.Monitor);
    }

    // ----- Installation ------------------------------------------------------------------

    function test_InstalledAsExecutorAndHook() public view {
        assertEq(module.installs(), 2);
        assertTrue(module.isInitialized(account));
        assertFalse(module.isInitialized(address(this)));
        assertTrue(module.isModuleType(2));
        assertTrue(module.isModuleType(4));
        assertFalse(module.isModuleType(1));
        assertFalse(module.isModuleType(3));
        assertTrue(ITestAccount(account).isModuleInstalled(2, address(module), ""));
        assertEq(module.account(), account);
        assertEq(module.asset(), address(usdg));
    }

    // ----- Verdicts, measured on the account ---------------------------------------------

    function test_AllowedSwapRecordsNoBreach() public {
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1000e6, account));

        assertEq(module.breachCount(), 0);
        assertFalse(module.frozen());
        assertEq(usdg.balanceOf(account), DEPOSIT - 1000e6);
        assertEq(tsla.balanceOf(account), 3.992e18);
        assertEq(module.currentWindowNotionalUsd6(), 1000e6);
        assertEq(usdg.balanceOf(address(module)), 0); // the module never holds funds
    }

    function test_TransferToTheAccountItselfIsAllowed() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (account, 1000e6)));
        assertEq(module.breachCount(), 0);
    }

    function test_SwapIntoTheModuleIsAnAssetBreach() public {
        // Output paid to the module (not the account) leaves the protected balance.
        _mexec(
            module,
            address(router),
            _swapData(address(usdg), address(tsla), 1000e6, address(module))
        );
        assertEq(uint8(_lastModuleBreach(module).breachType), uint8(BondedTypes.BreachType.Asset));
    }

    function test_UnauthorizedTransferRecordsFullLoss() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));

        MandateModule.Breach memory breach = _lastModuleBreach(module);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertEq(breach.lossUsd6, 5000e6);
        assertFalse(breach.blocked);
        assertEq(breach.target, address(usdg));
        assertEq(breach.selector, IERC20.transfer.selector);
        assertTrue(module.frozen());
        assertEq(usdg.balanceOf(attacker), 5000e6);
    }

    function test_CallToUnknownContractIsUnauthorizedTarget() public {
        _mexec(module, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        assertEq(
            uint8(_lastModuleBreach(module).breachType),
            uint8(BondedTypes.BreachType.UnauthorizedTarget)
        );
        assertEq(stranger.pings(), 1); // Monitor mode lets it run
    }

    function test_LimitAndAssetBreaches() public {
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 6000e6, account));
        MandateModule.Breach memory limit = _lastModuleBreach(module);
        assertEq(uint8(limit.breachType), uint8(BondedTypes.BreachType.Limit));
        assertEq(limit.lossUsd6, 12e6);

        vm.prank(guardian);
        module.unfreeze();
        _mexec(
            module, address(router), _swapData(address(usdg), address(honeypot), 2000e6, account)
        );
        MandateModule.Breach memory asset = _lastModuleBreach(module);
        assertEq(uint8(asset.breachType), uint8(BondedTypes.BreachType.Asset));
        assertEq(asset.lossUsd6, 2000e6);
    }

    function test_UnauthorizedApprovalThenDeferredLoss() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)));
        assertEq(
            uint8(_lastModuleBreach(module).breachType),
            uint8(BondedTypes.BreachType.UnauthorizedApproval)
        );

        vm.prank(attacker);
        assertTrue(usdg.transferFrom(account, attacker, 3000e6));
        module.reconcile();

        MandateModule.Breach memory deferred = _lastModuleBreach(module);
        assertEq(uint8(deferred.breachType), uint8(BondedTypes.BreachType.Deferred));
        assertEq(deferred.lossUsd6, 3000e6);
        assertEq(deferred.target, address(0));
    }

    // ----- What the agent can and can't reach --------------------------------------------

    function test_AgentCannotCallTheAccountOrTheModule() public {
        vm.startPrank(agent);
        vm.expectRevert(MandateModule.CannotCallAccount.selector);
        module.execute(
            account, abi.encodeCall(ITestAccount.installModule, (2, attacker, bytes("")))
        );
        vm.expectRevert(MandateModule.CannotCallModule.selector);
        module.execute(address(module), abi.encodeCall(MandateBase.unfreeze, ()));
        vm.stopPrank();
        assertEq(module.breachCount(), 0);
    }

    function test_OnlyTheAgentExecutes() public {
        vm.prank(attacker);
        vm.expectRevert(MandateErrors.NotAgent.selector);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, attacker));

        // The owner can't use the module as the agent either; it acts on the account directly.
        vm.prank(account);
        vm.expectRevert(MandateErrors.NotAgent.selector);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, attacker));
    }

    function test_FrozenAgentCannotExecuteAndGuardianRecovers() public {
        _mexec(module, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        vm.prank(agent);
        vm.expectRevert(MandateErrors.AgentFrozen.selector);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, account));

        address newAgent = makeAddr("newAgent");
        vm.startPrank(guardian);
        module.rotateAgent(newAgent);
        module.unfreeze();
        vm.stopPrank();
        vm.prank(newAgent);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, account));
        assertEq(module.breachCount(), 1);
    }

    function test_OnlyGuardianManagesTheAgent() public {
        vm.startPrank(attacker);
        vm.expectRevert(MandateErrors.NotGuardian.selector);
        module.freeze();
        vm.expectRevert(MandateErrors.NotGuardian.selector);
        module.unfreeze();
        vm.expectRevert(MandateErrors.NotGuardian.selector);
        module.rotateAgent(attacker);
        vm.stopPrank();
    }

    function test_MeasuredCallIsOnlyCallableByTheModule() public {
        vm.prank(agent);
        vm.expectRevert(MandateErrors.OnlySelf.selector);
        module.measuredCall(
            address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1)), false, true
        );
    }

    function test_FailedTargetCallRevertsAndRecordsNothing() public {
        vm.prank(agent);
        if (kind() == Kind.Msa) {
            // The reference account bubbles the target's revert, so the module does too.
            vm.expectRevert(
                abi.encodeWithSelector(
                    IERC20Errors.ERC20InsufficientBalance.selector, account, DEPOSIT, DEPOSIT + 1
                )
            );
        } else {
            vm.expectRevert(); // Safe7579 replaces it with its own ExecutionFailed()
        }
        module.execute(
            address(router), _swapData(address(usdg), address(tsla), DEPOSIT + 1, account)
        );
        assertEq(module.breachCount(), 0);
    }

    function test_TargetCannotReenterTheModule() public {
        ModuleReentrantTarget target = new ModuleReentrantTarget();
        vm.prank(agent);
        if (kind() == Kind.Msa) {
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        } else {
            vm.expectRevert();
        }
        module.execute(
            address(target), abi.encodeCall(ModuleReentrantTarget.poke, (address(module)))
        );
    }

    function test_NoOtherExecutorCanActInTheMiddleOfTheAgentsCall() public {
        SideExecutor side = new SideExecutor();
        _install(account, address(side), EXECUTOR);
        vm.prank(agent);
        vm.expectRevert(); // the hook refuses; the account reports the failure its own way
        module.execute(
            address(side),
            abi.encodeCall(SideExecutor.pull, (account, address(usdg), attacker, 1000e6))
        );
        assertEq(usdg.balanceOf(attacker), 0);

        // Outside the agent's call the same executor is the owner's business: no breach.
        side.pull(account, address(usdg), safeOwner, 1000e6);
        assertEq(usdg.balanceOf(safeOwner), 1000e6);
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1e6, account));
        assertEq(module.breachCount(), 0);
    }

    // ----- The owner keeps control -------------------------------------------------------

    function test_OwnerWithdrawalThroughTheAccountIsNotABreach() public {
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 10_000e6)));
        assertEq(module.recordedBalance(address(usdg)), DEPOSIT - 10_000e6);

        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1000e6, account));
        module.reconcile();
        assertEq(module.breachCount(), 0);
        assertFalse(module.frozen());
    }

    function test_OwnerActsWhileFrozen() public {
        _mexec(module, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        assertTrue(module.frozen());
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1e6)));
        assertEq(usdg.balanceOf(safeOwner), 1e6);
    }

    function test_SpenderPullIsRecordedWhenTheOwnerActsNext() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.approve, (attacker, 5000e6)));
        vm.prank(attacker);
        assertTrue(usdg.transferFrom(account, attacker, 5000e6));

        // The hook records the drop before the owner's own action is accepted.
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1000e6)));
        MandateModule.Breach memory deferred = _lastModuleBreach(module);
        assertEq(uint8(deferred.breachType), uint8(BondedTypes.BreachType.Deferred));
        assertEq(deferred.lossUsd6, 5000e6);
        assertEq(module.recordedBalance(address(usdg)), DEPOSIT - 6000e6);
    }

    function test_BrokenOracleDoesNotBlockTheOwner() public {
        // A drop the hook will try, and fail, to price.
        _mexec(module, address(usdg), abi.encodeCall(IERC20.approve, (attacker, 1000e6)));
        vm.prank(attacker);
        assertTrue(usdg.transferFrom(account, attacker, 1000e6));
        vm.prank(owner);
        oracle.setPrice(address(usdg), 0); // valueInUsd6 now reverts

        uint256 recorded = module.recordedBalance(address(usdg));
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1e6)));
        assertEq(usdg.balanceOf(safeOwner), 1e6); // the owner's action went through
        assertEq(module.recordedBalance(address(usdg)), recorded); // nothing was papered over
    }

    function test_WithoutTheHookTheOwnerSyncs() public {
        _uninstall(account, address(module), HOOK);
        assertEq(module.installs(), 1);

        // Without the hook and without sync, a withdrawal looks like a breach...
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1000e6)));
        module.reconcile();
        assertEq(
            uint8(_lastModuleBreach(module).breachType), uint8(BondedTypes.BreachType.Deferred)
        );

        // ...so the owner calls sync after moving funds.
        vm.prank(guardian);
        module.unfreeze();
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1000e6)));
        _ownerExec(account, address(module), abi.encodeCall(MandateModule.sync, ()));
        module.reconcile();
        assertEq(module.breachCount(), 1);
    }

    function test_OnlyTheAccountCallsAccountFunctions() public {
        vm.startPrank(attacker);
        vm.expectRevert(MandateModule.NotAccount.selector);
        module.sync();
        vm.expectRevert(MandateModule.NotAccount.selector);
        module.onInstall("");
        vm.expectRevert(MandateModule.NotAccount.selector);
        module.onUninstall("");
        vm.expectRevert(MandateModule.NotAccount.selector);
        module.preCheck(attacker, 0, "");
        vm.expectRevert(MandateModule.NotAccount.selector);
        module.postCheck(abi.encode(true));
        vm.stopPrank();
    }

    function test_UninstalledModuleCannotActOrBeReconciled() public {
        _uninstall(account, address(module), HOOK);
        _uninstall(account, address(module), EXECUTOR);
        assertEq(module.installs(), 0);
        assertFalse(module.isInitialized(account));

        vm.prank(agent);
        vm.expectRevert(MandateModule.NotInstalled.selector);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, account));
        vm.expectRevert(MandateModule.NotInstalled.selector);
        module.reconcile();

        // The owner moves funds freely; reinstalling takes the new balances as the start.
        _ownerExec(account, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 5000e6)));
        _install(account, address(module), EXECUTOR);
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1e6, account));
        assertEq(module.breachCount(), 0);
    }

    // ----- Protocol modules --------------------------------------------------------------

    function test_PremiumIsPaidFromTheAccountAndIsNotABreach() public {
        vm.expectRevert(MandateErrors.NotCoverManager.selector);
        module.payPremium(1e6);

        vm.prank(owner);
        factory.setCoverManager(coverManager);
        assertEq(moduleFactory.coverManager(), coverManager);

        vm.prank(coverManager);
        module.payPremium(100e6);
        assertEq(usdg.balanceOf(coverManager), 100e6);
        assertEq(usdg.balanceOf(account), DEPOSIT - 100e6);
        module.reconcile();
        assertEq(module.breachCount(), 0);
    }

    function test_PremiumFailsOnceTheExecutorIsRemoved() public {
        vm.prank(owner);
        factory.setCoverManager(coverManager);
        _uninstall(account, address(module), EXECUTOR);
        vm.prank(coverManager);
        vm.expectRevert();
        module.payPremium(1e6);
    }

    function test_OnlyClaimsEngineMarksBreachesClaimed() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 1000e6)));
        vm.expectRevert(MandateErrors.NotClaimsEngine.selector);
        module.markBreachClaimed(0);

        vm.prank(owner);
        factory.setClaimsEngine(claimsEngine);
        vm.startPrank(claimsEngine);
        module.markBreachClaimed(0);
        assertTrue(module.getBreach(0).claimed);
        vm.expectRevert(abi.encodeWithSelector(MandateErrors.BreachAlreadyClaimed.selector, 0));
        module.markBreachClaimed(0);
        vm.expectRevert(abi.encodeWithSelector(MandateErrors.UnknownBreach.selector, 9));
        module.markBreachClaimed(9);
        vm.stopPrank();
    }

    // ----- Fuzz --------------------------------------------------------------------------

    function testFuzz_UnauthorizedTransferLossEqualsAmount(uint256 amount) public {
        amount = bound(amount, 1, DEPOSIT);
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
        assertEq(_lastModuleBreach(module).lossUsd6, amount);
    }

    function testFuzz_SwapWithinSlippageAndLimitsIsClean(uint256 amount) public {
        amount = bound(amount, 1e6, 5000e6);
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), amount, account));
        assertEq(module.breachCount(), 0);
    }
}

/// @notice Enforce mode on an ERC-7579 account: breaches have no effect on the account.
abstract contract MandateModuleEnforceTests is ModuleTestBase {
    address internal account;
    MandateModule internal module;

    function kind() internal pure virtual returns (Kind);

    function setUp() public override {
        super.setUp();
        (account, module) = _protectedAccount(kind(), BondedTypes.MandateMode.Enforce);
    }

    function test_AllowedSwapWorks() public {
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1000e6, account));
        assertEq(module.breachCount(), 0);
        assertEq(tsla.balanceOf(account), 3.992e18);
    }

    function test_UnauthorizedTransferIsBlocked() public {
        bytes memory result =
            _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        assertEq(result.length, 0);
        assertEq(usdg.balanceOf(account), DEPOSIT);
        MandateModule.Breach memory breach = _lastModuleBreach(module);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.UnauthorizedTransfer));
        assertTrue(breach.blocked);
        assertTrue(module.frozen());
    }

    function test_UnauthorizedTargetIsNotCalled() public {
        _mexec(module, address(stranger), abi.encodeCall(MockTarget.ping, ()));
        assertEq(stranger.pings(), 0);
        assertTrue(_lastModuleBreach(module).blocked);
    }

    function test_LimitBreachIsRolledBackOnTheAccount() public {
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 6000e6, account));
        assertEq(usdg.balanceOf(account), DEPOSIT);
        assertEq(tsla.balanceOf(account), 0);
        assertEq(module.currentWindowNotionalUsd6(), 0);
        MandateModule.Breach memory breach = _lastModuleBreach(module);
        assertEq(uint8(breach.breachType), uint8(BondedTypes.BreachType.Limit));
        assertTrue(breach.blocked);
    }

    function test_LookalikeSwapIsRolledBackOnTheAccount() public {
        _mexec(
            module, address(router), _swapData(address(usdg), address(honeypot), 2000e6, account)
        );
        assertEq(usdg.balanceOf(account), DEPOSIT);
        assertEq(honeypot.balanceOf(account), 0);
        assertTrue(_lastModuleBreach(module).blocked);
    }

    function test_DisallowedSelectorIsBlocked() public {
        _mexec(module, address(router), abi.encodeCall(MockRouter.sweep, (address(usdg), attacker)));
        assertEq(
            uint8(_lastModuleBreach(module).breachType),
            uint8(BondedTypes.BreachType.UnauthorizedTarget)
        );
        assertTrue(_lastModuleBreach(module).blocked);
    }

    function testFuzz_UnauthorizedTransferNeverMovesFunds(uint256 amount) public {
        amount = bound(amount, 1, DEPOSIT);
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
        assertEq(usdg.balanceOf(account), DEPOSIT);
        assertTrue(_lastModuleBreach(module).blocked);
    }
}

contract MandateModuleMonitorMsaTest is MandateModuleMonitorTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Msa;
    }
}

contract MandateModuleMonitorSafeTest is MandateModuleMonitorTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Safe;
    }
}

contract MandateModuleEnforceMsaTest is MandateModuleEnforceTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Msa;
    }
}

contract MandateModuleEnforceSafeTest is MandateModuleEnforceTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Safe;
    }
}

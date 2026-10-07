// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HookType} from "safe7579/DataTypes.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateModuleFactory} from "../../src/MandateModuleFactory.sol";
import {MockOracle} from "../../src/oracles/MockOracle.sol";
import {ModuleTestBase, ITestAccount} from "./ModuleTestBase.sol";

/// @notice The Safe path end to end, using only the Safe owner's own transactions (what the
///         Safe web app sends): create the module, install it through Safe7579, let the agent
///         trade, and move funds as the owner. The other module tests also run on this Safe
///         setup (the `*SafeTest` contracts) through Safe7579's ERC-7579 entry points.
contract ModuleSafe7579Test is ModuleTestBase {
    address internal safe;
    MandateModule internal module;

    function setUp() public override {
        super.setUp();
        safe = _newAccount(Kind.Safe);
        BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Enforce);
        address predicted = moduleFactory.predictModule(safe, p, agent, guardian, agentId);

        _safeOwnerCall(
            safe,
            address(moduleFactory),
            abi.encodeCall(MandateModuleFactory.createModule, (p, agent, guardian, agentId))
        );
        _safeOwnerCall(
            safe, safe, abi.encodeCall(ITestAccount.installModule, (EXECUTOR, predicted, ""))
        );
        _safeOwnerCall(
            safe,
            safe,
            abi.encodeCall(
                ITestAccount.installModule,
                (HOOK, predicted, abi.encode(HookType.GLOBAL, bytes4(0), bytes("")))
            )
        );
        module = MandateModule(predicted);
        usdg.mint(safe, DEPOSIT);
        _mexec(
            module,
            address(usdg),
            abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
        );
    }

    function test_InstalledThroughSafeOwnerTransactions() public view {
        assertEq(moduleFactory.moduleOf(safe), address(module));
        assertEq(module.installs(), 2);
        assertTrue(ITestAccount(safe).isModuleInstalled(EXECUTOR, address(module), ""));
    }

    function test_AgentTradesFromTheSafe() public {
        _mexec(module, address(router), _swapData(address(usdg), address(tsla), 1000e6, safe));
        assertEq(tsla.balanceOf(safe), 3.992e18);
        assertEq(module.breachCount(), 0);
    }

    function test_AgentBreachIsBlockedAndTheSafeKeepsItsFunds() public {
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        assertEq(usdg.balanceOf(safe), DEPOSIT);
        assertTrue(module.getBreach(0).blocked);
        assertTrue(module.frozen());
    }

    function test_SafeOwnerTransactionSkipsTheHookSoTheOwnerSyncs() public {
        // execTransaction doesn't pass through Safe7579, so the hook can't see this withdrawal...
        _safeOwnerCall(safe, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1000e6)));
        // ...and the owner tells the module with sync (in practice, batched in the same Safe tx).
        _safeOwnerCall(safe, address(module), abi.encodeCall(MandateModule.sync, ()));
        module.reconcile();
        assertEq(module.breachCount(), 0);

        // Forgetting to sync looks like an unexplained drop: recorded, agent frozen, not paid.
        _safeOwnerCall(safe, address(usdg), abi.encodeCall(IERC20.transfer, (safeOwner, 1000e6)));
        module.reconcile();
        assertEq(uint8(module.getBreach(0).breachType), uint8(BondedTypes.BreachType.Deferred));
        assertTrue(module.frozen());
    }

    /// @dev From the review: if the oracle changes between predicting and creating, the batch's
    ///      install of the predicted (now empty) address fails, so nothing half-installs.
    function test_InstallingAStalePredictionFails() public {
        address other = _newAccount(Kind.Safe);
        BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Enforce);
        address predicted = moduleFactory.predictModule(other, p, agent, guardian, agentId);
        MockOracle newOracle = new MockOracle(owner);
        vm.prank(owner);
        factory.setOracle(newOracle);
        vm.prank(other);
        assertTrue(moduleFactory.createModule(p, agent, guardian, agentId) != predicted);
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        ITestAccount(other).installModule(EXECUTOR, predicted, "");
    }

    function test_SafeOwnerCanRemoveTheModule() public {
        _safeOwnerCall(
            safe,
            safe,
            abi.encodeCall(
                ITestAccount.uninstallModule,
                (HOOK, address(module), abi.encode(HookType.GLOBAL, bytes4(0), bytes("")))
            )
        );
        _safeOwnerCall(
            safe,
            safe,
            abi.encodeCall(
                ITestAccount.uninstallModule,
                (EXECUTOR, address(module), abi.encode(SENTINEL, bytes("")))
            )
        );
        assertEq(module.installs(), 0);
        vm.prank(agent);
        vm.expectRevert(MandateModule.NotInstalled.selector);
        module.execute(address(router), _swapData(address(usdg), address(tsla), 1e6, safe));
    }
}

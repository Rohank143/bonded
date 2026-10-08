// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {DisputeModule, IDisputePayer} from "../../src/DisputeModule.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "../ProtocolBase.t.sol";
import {ModuleTestBase} from "../module/ModuleTestBase.sol";
import {ProtocolHandler} from "./ProtocolHandler.sol";
import {ModuleHandler} from "./ModuleHandler.sol";
import {FakeAccount} from "../mocks/MockAccounts.sol";

/// @notice The protocol invariants again, now with smart accounts guarded by MandateModules
///         alongside two vaults, plus the module's own properties: payouts land in the account,
///         Deferred breaches on modules are never paid, Monitor-mode modules are never insured,
///         premiums can't stall, an account never has two modules, module disputes need the
///         council, a module never holds funds, a frozen agent never gets anything through, and
///         an owner withdrawal through the account is never a breach.
contract ModuleInvariants is StdInvariant, ProtocolBase, ModuleTestBase {
    ProtocolHandler internal vaults;
    ModuleHandler internal handler;
    uint256[] internal moduleAgentIds;

    function setUp() public override(ProtocolBase, ModuleTestBase) {
        super.setUp();
        vm.prank(owner);
        manager.setModuleFactory(address(moduleFactory));

        MandateVault[] memory vs = new MandateVault[](2);
        vs[0] = vault;
        vs[1] = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, agentId2, "v2", "v2"
            )
        );
        address[] memory underwriters = new address[](3);
        underwriters[0] = underwriter;
        underwriters[1] = makeAddr("underwriter2");
        underwriters[2] = makeAddr("underwriter3");
        vaults = new ProtocolHandler(
            usdg,
            pool,
            bond,
            manager,
            claims,
            attesterKey,
            guardian,
            agent,
            attacker,
            vs,
            underwriters
        );
        vaults.recordStake(agentId, BOND);

        // Three insured (Enforce-mode) modules: a reference account (which also has an older,
        // never-installed module), a Safe with Safe7579, and an account that reports executions
        // without doing them. Plus a Monitor-mode module, which must never get cover.
        MandateModule stale;
        MandateModule[] memory modules = new MandateModule[](3);
        for (uint256 i; i < modules.length; ++i) {
            vm.prank(guardian);
            uint256 id = registry.register("ipfs://bonded/agents/module.json");
            BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Enforce);
            if (i == 2) {
                FakeAccount fake = new FakeAccount();
                modules[i] = fake.create(moduleFactory, p, agent, guardian, id);
                usdg.mint(address(fake), DEPOSIT);
            } else {
                address account = _newAccount(i == 0 ? Kind.Msa : Kind.Safe);
                vm.startPrank(account);
                if (i == 0) {
                    stale = MandateModule(moduleFactory.createModule(p, agent, guardian, id));
                }
                modules[i] = MandateModule(moduleFactory.createModule(p, agent, guardian, id));
                vm.stopPrank();
                _install(account, address(modules[i]), EXECUTOR);
                _install(account, address(modules[i]), HOOK);
                usdg.mint(account, DEPOSIT);
                _mexec(
                    modules[i],
                    address(usdg),
                    abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
                );
            }
            _stake(id, BOND);
            moduleAgentIds.push(id);
        }
        address monitorAccount = _newAccount(Kind.Msa);
        vm.prank(monitorAccount);
        MandateModule monitorModule = MandateModule(
            moduleFactory.createModule(
                _moduleParams(BondedTypes.MandateMode.Monitor), agent, guardian, moduleAgentIds[0]
            )
        );
        _install(monitorAccount, address(monitorModule), EXECUTOR);

        // Disputes: no proposal bond, so the handler can propose freely; a council decides.
        address council = makeAddr("council");
        DisputeModule disputes = new DisputeModule(
            owner, IERC20(address(usdg)), manager, IDisputePayer(address(claims)), council, 0
        );
        vm.prank(owner);
        claims.setDisputeModule(address(disputes));

        handler = new ModuleHandler(
            ModuleHandler.Setup({
                usdg: usdg,
                pool: pool,
                bond: bond,
                manager: manager,
                claims: claims,
                attesterKey: attesterKey,
                guardian: guardian,
                agent: agent,
                attacker: attacker,
                owner: safeOwner,
                router: router,
                tsla: address(tsla),
                disputes: disputes,
                council: council,
                monitorModule: monitorModule,
                staleModule: stale
            }),
            modules
        );

        bytes4[] memory moduleSteps = new bytes4[](22);
        moduleSteps[0] = ModuleHandler.bindCover.selector;
        moduleSteps[1] = ModuleHandler.bindCover.selector;
        moduleSteps[2] = ModuleHandler.bindMonitorCover.selector;
        moduleSteps[3] = ModuleHandler.unfreeze.selector;
        moduleSteps[4] = ModuleHandler.fund.selector;
        moduleSteps[5] = ModuleHandler.ownerWithdraw.selector;
        moduleSteps[6] = ModuleHandler.breach.selector;
        moduleSteps[7] = ModuleHandler.breach.selector;
        moduleSteps[8] = ModuleHandler.routerDrain.selector;
        moduleSteps[9] = ModuleHandler.routerDrain.selector;
        moduleSteps[10] = ModuleHandler.frozenAgentTries.selector;
        moduleSteps[11] = ModuleHandler.installStale.selector;
        moduleSteps[12] = ModuleHandler.accrue.selector;
        moduleSteps[13] = ModuleHandler.accrue.selector;
        moduleSteps[14] = ModuleHandler.fileClaim.selector;
        moduleSteps[15] = ModuleHandler.fileClaim.selector;
        moduleSteps[16] = ModuleHandler.proposeDispute.selector;
        moduleSteps[17] = ModuleHandler.proposeDispute.selector;
        moduleSteps[18] = ModuleHandler.finalizeDispute.selector;
        moduleSteps[19] = ModuleHandler.councilApproves.selector;
        moduleSteps[20] = ModuleHandler.councilApproves.selector;
        moduleSteps[21] = ModuleHandler.councilApproves.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: moduleSteps}));
        targetContract(address(handler));

        // The vault side and time keep moving alongside (ProtocolInvariants covers the rest).
        bytes4[] memory vaultSteps = new bytes4[](4);
        vaultSteps[0] = ProtocolHandler.bindCover.selector;
        vaultSteps[1] = ProtocolHandler.breach.selector;
        vaultSteps[2] = ProtocolHandler.fileClaim.selector;
        vaultSteps[3] = ProtocolHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(vaults), selectors: vaultSteps}));
        targetContract(address(vaults));
    }

    // ----- Fixes from the review ---------------------------------------------------------

    /// @notice A Monitor-mode module never gets cover: its account's owner could ask the agent
    ///         for a breach and collect the payout.
    function invariant_MonitorModulesAreUninsured() public view {
        assertFalse(handler.monitorModuleInsured());
        assertEq(manager.activePolicyOf(address(handler.monitorModule())), 0);
    }

    /// @notice Premium collection never gets stuck, even for an account that only claims to pay.
    function invariant_PremiumAccrualNeverStalls() public view {
        assertFalse(handler.accrualReverted());
    }

    /// @notice An account never has two modules installed.
    function invariant_OneModulePerAccount() public view {
        assertFalse(handler.twoModulesInstalled());
        assertEq(handler.staleModule().installs(), 0);
    }

    /// @notice A dispute on a module's policy is only ever paid by the council's decision.
    function invariant_ModuleDisputesNeedTheCouncil() public view {
        assertFalse(handler.moduleDisputeAutoPaid());
    }

    // ----- Module properties -------------------------------------------------------------

    /// @notice Every payout on a module policy arrives in the account the module guards.
    function invariant_ModulePayoutsReachTheAccount() public view {
        assertFalse(handler.payoutMissedTheAccount());
    }

    /// @notice A Deferred breach on a module is never paid (the owner can move funds outside it).
    function invariant_DeferredNeverPaidOnModules() public view {
        assertFalse(handler.deferredPaid());
        MandateModule[] memory ms = handler.modules();
        for (uint256 i; i < ms.length; ++i) {
            for (uint256 b; b < ms[i].breachCount(); ++b) {
                MandateModule.Breach memory breach = ms[i].getBreach(b);
                if (breach.breachType == BondedTypes.BreachType.Deferred) {
                    assertFalse(breach.claimed);
                }
            }
        }
    }

    /// @notice Funds stay in the account: the module itself never holds any.
    function invariant_ModulesNeverHoldFunds() public view {
        MandateModule[] memory ms = handler.modules();
        for (uint256 i; i < ms.length; ++i) {
            assertEq(usdg.balanceOf(address(ms[i])), 0);
            assertEq(tsla.balanceOf(address(ms[i])), 0);
        }
    }

    /// @notice A frozen agent never moves anything, and the owner's own withdrawals through the
    ///         account are never recorded as breaches.
    function invariant_FrozenAgentBlockedAndOwnerFree() public view {
        assertFalse(handler.frozenAgentActed());
        assertFalse(handler.ownerWithdrawalWasABreach());
    }

    // ----- Protocol properties, with modules in the mix ----------------------------------

    function invariant_WaterfallAndDeductibleHold() public view {
        assertFalse(handler.poolPaidBeforeBondWasEmpty());
        assertFalse(handler.payoutAboveLossMinusDeductible());
        assertFalse(handler.waterfallDoesNotAddUp());
        assertFalse(vaults.poolPaidBeforeBondWasEmpty());
        assertFalse(vaults.payoutAboveLossMinusDeductible());
        assertFalse(vaults.waterfallDoesNotAddUp());
    }

    /// @notice Each breach is paid at most once, and the vault's or module's record agrees.
    function invariant_EachBreachPaidOnceAcrossVaultsAndModules() public view {
        assertFalse(handler.breachPaidTwice());
        assertFalse(vaults.breachPaidTwice());
        MandateVault[] memory vs = vaults.vaults();
        for (uint256 i; i < vs.length; ++i) {
            for (uint256 b; b < vs[i].breachCount(); ++b) {
                assertEq(vs[i].getBreach(b).claimed, vaults.ghostBreachPaid(address(vs[i]), b));
            }
        }
        MandateModule[] memory ms = handler.modules();
        for (uint256 i; i < ms.length; ++i) {
            for (uint256 b; b < ms[i].breachCount(); ++b) {
                assertEq(ms[i].getBreach(b).claimed, handler.ghostBreachPaid(address(ms[i]), b));
            }
        }
    }

    /// @notice Exposure totals match the active policies, vault and module policies alike.
    function invariant_ActiveCoverMatchesPolicies() public view {
        uint256[] memory a = vaults.policies();
        uint256[] memory b = handler.policies();
        uint256 total;
        for (uint256 i; i < a.length + b.length; ++i) {
            ICoverManager.Policy memory p = manager.getPolicy(i < a.length ? a[i] : b[i - a.length]);
            if (p.status == ICoverManager.Status.Active) total += p.remainingCover;
        }
        assertEq(manager.totalActiveCover(), total);
        for (uint256 m; m < moduleAgentIds.length; ++m) {
            uint256 ofAgent;
            for (uint256 i; i < b.length; ++i) {
                ICoverManager.Policy memory p = manager.getPolicy(b[i]);
                if (p.status == ICoverManager.Status.Active && p.agentId == moduleAgentIds[m]) {
                    ofAgent += p.remainingCover;
                }
            }
            assertEq(manager.activeCoverOfAgent(moduleAgentIds[m]), ofAgent);
        }
    }

    /// @notice Bonds are stakes minus withdrawals and slashes, for vault and module agents, and
    ///         the bond contract holds exactly their sum.
    function invariant_BondAccounting() public view {
        uint256 sum;
        uint256[2] memory vaultAgents = [agentId, agentId2];
        for (uint256 i; i < vaultAgents.length; ++i) {
            uint256 id = vaultAgents[i];
            assertEq(
                bond.bondOf(id),
                vaults.ghostStaked(id) - vaults.ghostWithdrawn(id) - vaults.ghostSlashed(id)
            );
            sum += bond.bondOf(id);
        }
        for (uint256 i; i < moduleAgentIds.length; ++i) {
            uint256 id = moduleAgentIds[i];
            assertLe(handler.ghostSlashed(id), BOND);
            assertEq(bond.bondOf(id), BOND - handler.ghostSlashed(id));
            sum += bond.bondOf(id);
        }
        assertEq(usdg.balanceOf(address(bond)), sum);
    }

    /// @notice Pool assets are exactly its token balance.
    function invariant_PoolAssetsAreItsBalance() public view {
        assertEq(pool.totalAssets(), usdg.balanceOf(address(pool)));
    }
}

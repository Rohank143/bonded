// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "../ProtocolBase.t.sol";
import {ModuleTestBase} from "../module/ModuleTestBase.sol";
import {ProtocolHandler} from "./ProtocolHandler.sol";
import {ModuleHandler} from "./ModuleHandler.sol";

/// @notice The protocol invariants again, now with two smart accounts guarded by MandateModules
///         alongside the two vaults, plus the module's own properties: payouts land in the
///         account, Deferred breaches on modules are never paid, a module never holds funds, a
///         frozen agent never gets through, and an owner withdrawal through the account is never
///         a breach.
contract ModuleInvariants is StdInvariant, ProtocolBase, ModuleTestBase {
    ModuleHandler internal handler;
    uint256[] internal agentIds;

    function setUp() public override(ProtocolBase, ModuleTestBase) {
        super.setUp();
        vm.prank(owner);
        manager.setModuleFactory(address(moduleFactory));

        MandateVault[] memory vaults = new MandateVault[](2);
        vaults[0] = vault;
        vaults[1] = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, agentId2, "v2", "v2"
            )
        );

        MandateModule[] memory modules = new MandateModule[](2);
        for (uint256 i; i < modules.length; ++i) {
            vm.prank(guardian);
            uint256 id = registry.register("ipfs://bonded/agents/module.json");
            address account = _newAccount(i == 0 ? Kind.Msa : Kind.Safe);
            vm.prank(account);
            modules[i] = MandateModule(
                moduleFactory.createModule(
                    _moduleParams(BondedTypes.MandateMode.Monitor), agent, guardian, id
                )
            );
            _install(account, address(modules[i]), EXECUTOR);
            _install(account, address(modules[i]), HOOK);
            usdg.mint(account, DEPOSIT);
            _stake(id, BOND);
            agentIds.push(id);
        }
        agentIds.push(agentId);
        agentIds.push(agentId2);

        address[] memory underwriters = new address[](3);
        underwriters[0] = underwriter;
        underwriters[1] = makeAddr("underwriter2");
        underwriters[2] = makeAddr("underwriter3");

        handler = new ModuleHandler(
            usdg,
            pool,
            bond,
            manager,
            claims,
            attesterKey,
            guardian,
            agent,
            attacker,
            vaults,
            underwriters
        );
        handler.setModules(modules, safeOwner);
        handler.recordStake(agentId, BOND);
        handler.recordStake(agentIds[0], BOND);
        handler.recordStake(agentIds[1], BOND);

        bytes4[] memory selectors = new bytes4[](22);
        selectors[0] = ModuleHandler.moduleStake.selector;
        selectors[1] = ModuleHandler.moduleBindCover.selector;
        selectors[2] = ModuleHandler.moduleBindCover.selector;
        selectors[3] = ModuleHandler.moduleUnfreeze.selector;
        selectors[4] = ModuleHandler.moduleFund.selector;
        selectors[5] = ModuleHandler.moduleOwnerWithdraw.selector;
        selectors[6] = ModuleHandler.moduleBreach.selector;
        selectors[7] = ModuleHandler.moduleBreach.selector;
        selectors[8] = ModuleHandler.moduleSpenderPull.selector;
        selectors[9] = ModuleHandler.moduleSpenderPull.selector;
        selectors[10] = ModuleHandler.moduleFrozenAgentTries.selector;
        selectors[11] = ModuleHandler.moduleFileClaim.selector;
        selectors[12] = ModuleHandler.moduleFileClaim.selector;
        selectors[13] = ModuleHandler.moduleFileClaim.selector;
        selectors[14] = ModuleHandler.moduleFileClaim.selector; // the keeper files often
        // The vault side and the shared steps keep running alongside.
        selectors[15] = ProtocolHandler.poolDeposit.selector;
        selectors[16] = ProtocolHandler.poolExit.selector;
        selectors[17] = ProtocolHandler.bindCover.selector;
        selectors[18] = ProtocolHandler.breach.selector;
        selectors[19] = ProtocolHandler.fileClaim.selector;
        selectors[20] = ProtocolHandler.accrue.selector;
        selectors[21] = ProtocolHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ----- Module properties -------------------------------------------------------------

    /// @notice Every payout on a module policy arrives in the account the module guards.
    function invariant_ModulePayoutsReachTheAccount() public view {
        assertFalse(handler.payoutMissedTheAccount());
    }

    /// @notice A Deferred breach on a module is never paid (the owner can move funds outside it).
    function invariant_DeferredNeverPaidOnModules() public view {
        assertFalse(handler.ghostDeferredPaid());
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

    /// @notice A frozen agent never gets an action through, and the owner's own withdrawals
    ///         through the account are never recorded as breaches.
    function invariant_FrozenAgentBlockedAndOwnerFree() public view {
        assertFalse(handler.frozenAgentActed());
        assertFalse(handler.ownerWithdrawalWasABreach());
    }

    // ----- Protocol properties, with modules in the mix ----------------------------------

    function invariant_WaterfallAndDeductibleHold() public view {
        assertFalse(handler.poolPaidBeforeBondWasEmpty());
        assertFalse(handler.payoutAboveLossMinusDeductible());
        assertFalse(handler.waterfallDoesNotAddUp());
    }

    /// @notice Each breach is paid at most once, and the vault's or module's record agrees.
    function invariant_EachBreachPaidOnceAcrossVaultsAndModules() public view {
        assertFalse(handler.breachPaidTwice());
        MandateVault[] memory vs = handler.vaults();
        for (uint256 i; i < vs.length; ++i) {
            for (uint256 b; b < vs[i].breachCount(); ++b) {
                assertEq(vs[i].getBreach(b).claimed, handler.ghostBreachPaid(address(vs[i]), b));
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
        uint256[] memory ids = handler.policies();
        uint256 total;
        for (uint256 i; i < ids.length; ++i) {
            ICoverManager.Policy memory p = manager.getPolicy(ids[i]);
            if (p.status == ICoverManager.Status.Active) total += p.remainingCover;
        }
        assertEq(manager.totalActiveCover(), total);
        for (uint256 a; a < agentIds.length; ++a) {
            uint256 ofAgent;
            for (uint256 i; i < ids.length; ++i) {
                ICoverManager.Policy memory p = manager.getPolicy(ids[i]);
                if (p.status == ICoverManager.Status.Active && p.agentId == agentIds[a]) {
                    ofAgent += p.remainingCover;
                }
            }
            assertEq(manager.activeCoverOfAgent(agentIds[a]), ofAgent);
        }
    }

    /// @notice Bonds are stakes minus withdrawals and slashes, for vault and module agents.
    function invariant_BondAccounting() public view {
        uint256 sum;
        for (uint256 a; a < agentIds.length; ++a) {
            uint256 id = agentIds[a];
            uint256 slashed = handler.ghostSlashed(id);
            assertLe(slashed, handler.ghostStaked(id));
            assertEq(
                bond.bondOf(id), handler.ghostStaked(id) - handler.ghostWithdrawn(id) - slashed
            );
            sum += bond.bondOf(id);
        }
        assertEq(usdg.balanceOf(address(bond)), sum);
    }

    /// @notice Pool assets are exactly its token balance.
    function invariant_PoolAssetsAreItsBalance() public view {
        assertEq(pool.totalAssets(), usdg.balanceOf(address(pool)));
    }
}

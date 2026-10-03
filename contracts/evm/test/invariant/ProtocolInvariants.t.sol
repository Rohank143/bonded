// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "../ProtocolBase.t.sol";
import {ProtocolHandler} from "./ProtocolHandler.sol";

/// @notice Invariants for CoverPool, OperatorBond and ClaimsEngine, run against random sequences
///         of deposits, cover purchases, breaches, claims, withdrawals and time passing.
contract ProtocolInvariants is StdInvariant, ProtocolBase {
    ProtocolHandler internal handler;

    function setUp() public override {
        super.setUp();

        MandateVault[] memory vaults = new MandateVault[](2);
        vaults[0] = vault;
        vaults[1] = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, agentId2, "v2", "v2"
            )
        );
        address[] memory underwriters = new address[](3);
        underwriters[0] = underwriter;
        underwriters[1] = makeAddr("underwriter2");
        underwriters[2] = makeAddr("underwriter3");

        handler = new ProtocolHandler(
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
        // ProtocolBase staked BOND for the first agent before the handler existed.
        handler.recordStake(agentId, BOND);

        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = ProtocolHandler.poolDeposit.selector;
        selectors[1] = ProtocolHandler.poolRequestRedeem.selector;
        selectors[2] = ProtocolHandler.poolRedeem.selector;
        selectors[3] = ProtocolHandler.poolWithdraw.selector;
        selectors[4] = ProtocolHandler.stake.selector;
        selectors[5] = ProtocolHandler.bondRequestWithdraw.selector;
        selectors[6] = ProtocolHandler.bondWithdraw.selector;
        selectors[7] = ProtocolHandler.bindCover.selector;
        selectors[8] = ProtocolHandler.unfreeze.selector;
        selectors[9] = ProtocolHandler.vaultDeposit.selector;
        selectors[10] = ProtocolHandler.breach.selector;
        selectors[11] = ProtocolHandler.accrue.selector;
        selectors[12] = ProtocolHandler.warp.selector;
        selectors[13] = ProtocolHandler.fileClaim.selector;
        selectors[14] = ProtocolHandler.fileClaim.selector; // claims twice as often
        selectors[15] = ProtocolHandler.poolExit.selector;
        selectors[16] = ProtocolHandler.poolExit.selector; // exits often, so the lock binds
        selectors[17] = ProtocolHandler.poolExit.selector;
        selectors[18] = ProtocolHandler.setLeverage.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ----- CoverPool ---------------------------------------------------------------------

    /// @notice Every pool share belongs to an underwriter; none appear from nowhere.
    function invariant_PoolSharesAreAllHeldByUnderwriters() public view {
        address[] memory who = handler.underwriters();
        uint256 sum;
        for (uint256 i; i < who.length; ++i) {
            sum += pool.balanceOf(who[i]);
        }
        assertEq(pool.totalSupply(), sum);
    }

    /// @notice Pool assets are exactly its token balance (no internal bookkeeping to drift).
    function invariant_PoolAssetsAreItsBalance() public view {
        assertEq(pool.totalAssets(), usdg.balanceOf(address(pool)));
    }

    /// @notice Locked capital backs active cover at the leverage limit; free is the rest.
    function invariant_FreeCapitalIsAssetsMinusLocked() public view {
        uint256 locked = Math.mulDiv(
            manager.totalActiveCover(),
            BondedTypes.BPS,
            manager.maxLeverageBps(),
            Math.Rounding.Ceil
        );
        assertEq(pool.requiredCapital(), locked);
        uint256 assets = pool.totalAssets();
        assertEq(pool.freeCapital(), assets > locked ? assets - locked : 0);
        assertLe(pool.freeCapital(), assets);
    }

    /// @notice No underwriter withdrawal ever took more than the free capital at that moment.
    function invariant_WithdrawalsNeverTouchLockedCapital() public view {
        assertFalse(handler.redeemedLockedCapital());
    }

    /// @notice CoverManager's exposure totals match the active policies one by one.
    function invariant_ActiveCoverMatchesPolicies() public view {
        uint256[] memory ids = handler.policies();
        uint256 total;
        uint256 agent1;
        uint256 agent2;
        for (uint256 i; i < ids.length; ++i) {
            ICoverManager.Policy memory p = manager.getPolicy(ids[i]);
            if (p.status != ICoverManager.Status.Active) continue;
            total += p.remainingCover;
            if (p.agentId == agentId) agent1 += p.remainingCover;
            else agent2 += p.remainingCover;
        }
        assertEq(manager.totalActiveCover(), total);
        assertEq(manager.activeCoverOfAgent(agentId), agent1);
        assertEq(manager.activeCoverOfAgent(agentId2), agent2);
        assertEq(manager.activeCoverOfFamily(CLAUDE), total);
    }

    // ----- ClaimsEngine ------------------------------------------------------------------

    /// @notice The waterfall: the pool pays only once the operator's bond is used up.
    function invariant_BondPaysBeforePool() public view {
        assertFalse(handler.poolPaidBeforeBondWasEmpty());
    }

    /// @notice A payout never exceeds the loss minus the deductible.
    function invariant_PayoutWithinLossMinusDeductible() public view {
        assertFalse(handler.payoutAboveLossMinusDeductible());
        assertFalse(handler.waterfallDoesNotAddUp());
    }

    /// @notice Each breach is paid at most once, and the vault's record agrees.
    function invariant_EachBreachPaidOnce() public view {
        assertFalse(handler.breachPaidTwice());
        MandateVault[] memory vs = handler.vaults();
        for (uint256 i; i < vs.length; ++i) {
            uint256 count = vs[i].breachCount();
            for (uint256 b; b < count; ++b) {
                assertEq(vs[i].getBreach(b).claimed, handler.ghostBreachPaid(address(vs[i]), b));
            }
        }
    }

    // ----- OperatorBond ------------------------------------------------------------------

    /// @notice A bond is what was staked, minus withdrawals and slashes; slashes never exceed stakes.
    function invariant_BondAccounting() public view {
        MandateVault[] memory vs = handler.vaults();
        uint256 sum;
        for (uint256 i; i < vs.length; ++i) {
            uint256 id = vs[i].agentId();
            uint256 staked = handler.ghostStaked(id);
            uint256 slashed = handler.ghostSlashed(id);
            assertLe(slashed, staked);
            assertEq(bond.bondOf(id), staked - handler.ghostWithdrawn(id) - slashed);
            sum += bond.bondOf(id);
        }
        assertEq(usdg.balanceOf(address(bond)), sum);
    }
}

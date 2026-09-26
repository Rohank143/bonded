// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OperatorBond} from "../src/OperatorBond.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

contract OperatorBondTest is ProtocolBase {
    function test_TheOperatorIsTheAgentsRegistryOwner() public {
        assertEq(bond.operatorOf(agentId), guardian);
        assertEq(bond.bondOf(agentId), BOND);

        // Anyone can add to a bond...
        usdg.mint(attacker, 1e6);
        vm.startPrank(attacker);
        usdg.approve(address(bond), 1e6);
        bond.stake(agentId, 1e6);
        // ...but only the operator can take it out.
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.requestWithdraw(agentId, 1e6);
        vm.stopPrank();
        assertEq(bond.bondOf(agentId), BOND + 1e6);
    }

    function test_CannotBondAnUnregisteredAgent() public {
        usdg.mint(guardian, 1e6);
        vm.startPrank(guardian);
        usdg.approve(address(bond), 1e6);
        vm.expectRevert(abi.encodeWithSelector(OperatorBond.UnknownAgent.selector, 999));
        bond.stake(999, 1e6);
        vm.stopPrank();
    }

    function test_TransferringTheAgentTransfersControlOfTheBond() public {
        address newOperator = makeAddr("newOperator");
        vm.prank(guardian);
        registry.transferFrom(guardian, newOperator, agentId);

        vm.prank(guardian);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.requestWithdraw(agentId, 1e6);

        vm.prank(newOperator);
        bond.requestWithdraw(agentId, 1e6);
        vm.warp(block.timestamp + 7 days);
        vm.prank(newOperator);
        bond.withdraw(agentId);
        assertEq(usdg.balanceOf(newOperator), 1e6);
    }

    function test_WithdrawalNeedsACooldownAndNoActiveCover() public {
        uint256 policyId = _bindDefault();
        vm.startPrank(guardian);
        bond.requestWithdraw(agentId, 4000e6);

        vm.expectRevert(OperatorBond.StillCoolingDown.selector);
        bond.withdraw(agentId);

        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(OperatorBond.ActiveCover.selector);
        bond.withdraw(agentId);

        manager.cancel(policyId);
        // Claims for breaches during the policy stay open for 7 days, so the bond stays too.
        uint256 until = block.timestamp + 7 days;
        vm.expectRevert(abi.encodeWithSelector(OperatorBond.ClaimWindowOpen.selector, until));
        bond.withdraw(agentId);

        vm.warp(until + 1);
        uint256 before = usdg.balanceOf(guardian);
        bond.withdraw(agentId);
        vm.stopPrank();

        assertEq(usdg.balanceOf(guardian) - before, 4000e6);
        assertEq(bond.bondOf(agentId), BOND - 4000e6);
    }

    function test_OnlyTheOperatorManagesTheBond() public {
        vm.startPrank(attacker);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.requestWithdraw(agentId, 1);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.withdraw(agentId);
        vm.stopPrank();

        vm.startPrank(guardian);
        vm.expectRevert(OperatorBond.ExceedsBond.selector);
        bond.requestWithdraw(agentId, BOND + 1);
        vm.expectRevert(OperatorBond.ZeroAmount.selector);
        bond.requestWithdraw(agentId, 0);
        vm.expectRevert(OperatorBond.NoPendingWithdrawal.selector);
        bond.withdraw(agentId);
        vm.stopPrank();
    }

    function test_SlashIsClaimsEngineOnlyAndCappedByTheBond() public {
        vm.expectRevert(OperatorBond.NotClaimsEngine.selector);
        bond.slash(agentId, 1, attacker);

        vm.prank(guardian);
        bond.requestWithdraw(agentId, BOND);

        vm.prank(address(claims));
        uint256 slashed = bond.slash(agentId, BOND * 3, address(vault));
        assertEq(slashed, BOND);
        assertEq(bond.bondOf(agentId), 0);
        assertEq(bond.getBond(agentId).pendingWithdrawal, 0); // can't withdraw what was slashed

        vm.prank(address(claims));
        assertEq(bond.slash(agentId, 1, address(vault)), 0);
    }
}

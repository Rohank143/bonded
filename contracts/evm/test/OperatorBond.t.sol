// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OperatorBond} from "../src/OperatorBond.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

contract OperatorBondTest is ProtocolBase {
    function test_FirstStakerBecomesTheOperator() public {
        assertEq(bond.getBond(42).operator, guardian);
        assertEq(bond.bondOf(42), BOND);

        usdg.mint(attacker, 1e6);
        vm.startPrank(attacker);
        usdg.approve(address(bond), 1e6);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.stake(42, 1e6);
        vm.stopPrank();
    }

    function test_WithdrawalNeedsACooldownAndNoActiveCover() public {
        uint256 policyId = _bindDefault();
        vm.startPrank(guardian);
        bond.requestWithdraw(42, 4000e6);

        vm.expectRevert(OperatorBond.StillCoolingDown.selector);
        bond.withdraw(42);

        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(OperatorBond.ActiveCover.selector);
        bond.withdraw(42);

        manager.cancel(policyId);
        uint256 before = usdg.balanceOf(guardian);
        bond.withdraw(42);
        vm.stopPrank();

        assertEq(usdg.balanceOf(guardian) - before, 4000e6);
        assertEq(bond.bondOf(42), BOND - 4000e6);
    }

    function test_OnlyTheOperatorManagesTheBond() public {
        vm.startPrank(attacker);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.requestWithdraw(42, 1);
        vm.expectRevert(OperatorBond.NotOperator.selector);
        bond.withdraw(42);
        vm.stopPrank();

        vm.startPrank(guardian);
        vm.expectRevert(OperatorBond.ExceedsBond.selector);
        bond.requestWithdraw(42, BOND + 1);
        vm.expectRevert(OperatorBond.ZeroAmount.selector);
        bond.requestWithdraw(42, 0);
        vm.expectRevert(OperatorBond.NoPendingWithdrawal.selector);
        bond.withdraw(42);
        vm.stopPrank();
    }

    function test_SlashIsClaimsEngineOnlyAndCappedByTheBond() public {
        vm.expectRevert(OperatorBond.NotClaimsEngine.selector);
        bond.slash(42, 1, attacker);

        vm.prank(guardian);
        bond.requestWithdraw(42, BOND);

        vm.prank(address(claims));
        uint256 slashed = bond.slash(42, BOND * 3, address(vault));
        assertEq(slashed, BOND);
        assertEq(bond.bondOf(42), 0);
        assertEq(bond.getBond(42).pendingWithdrawal, 0); // can't withdraw what was slashed

        vm.prank(address(claims));
        assertEq(bond.slash(42, 1, address(vault)), 0);
    }
}

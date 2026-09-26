// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

contract CoverPoolTest is ProtocolBase {
    function test_RedeemNeedsARequestAndACooldown() public {
        uint256 shares = pool.balanceOf(underwriter);

        vm.prank(underwriter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC4626.ERC4626ExceededMaxRedeem.selector, underwriter, shares, 0
            )
        );
        pool.redeem(shares, underwriter, underwriter);

        vm.prank(underwriter);
        pool.requestRedeem(shares);
        vm.warp(block.timestamp + 7 days - 1);
        assertEq(pool.maxRedeem(underwriter), 0);

        vm.warp(block.timestamp + 1);
        vm.prank(underwriter);
        uint256 assets = pool.redeem(shares, underwriter, underwriter);
        assertApproxEqAbs(assets, POOL_DEPOSIT, 1);
        (uint256 remaining,) = pool.withdrawRequests(underwriter);
        assertEq(remaining, 0);
    }

    function test_RequestsExpireIfNotUsed() public {
        uint256 shares = pool.balanceOf(underwriter);
        vm.prank(underwriter);
        pool.requestRedeem(shares);
        vm.warp(block.timestamp + 7 days + 2 days + 1);
        assertEq(pool.maxRedeem(underwriter), 0);
    }

    function test_CannotRequestMoreThanYouHold() public {
        uint256 shares = pool.balanceOf(underwriter);
        vm.prank(underwriter);
        vm.expectRevert(CoverPool.InsufficientShares.selector);
        pool.requestRedeem(shares + 1);
    }

    function test_ActiveCoverLocksCapital() public {
        _bindDefault(); // 20,000 cover at 2x leverage locks 10,000
        assertEq(pool.requiredCapital(), 10_000e6);
        assertEq(pool.freeCapital(), POOL_DEPOSIT - 10_000e6);

        uint256 shares = pool.balanceOf(underwriter);
        vm.prank(underwriter);
        pool.requestRedeem(shares);
        vm.warp(block.timestamp + 7 days);
        uint256 max = pool.maxWithdraw(underwriter);
        assertLe(max, pool.freeCapital());
        assertGt(max, pool.freeCapital() - 2); // only rounding dust apart
    }

    function test_PremiumsRaiseTheSharePrice() public {
        uint256 shares = pool.balanceOf(underwriter);
        uint256 before = pool.convertToAssets(shares);
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + 30 days);
        manager.accrue(policyId);
        assertGt(pool.convertToAssets(shares), before);
    }

    function test_OnlyClaimsEnginePaysClaimsAndPaymentIsCapped() public {
        vm.expectRevert(CoverPool.NotClaimsEngine.selector);
        pool.payClaim(attacker, 1);

        vm.prank(address(claims));
        uint256 paid = pool.payClaim(address(vault), POOL_DEPOSIT * 2);
        assertEq(paid, POOL_DEPOSIT);
        assertEq(usdg.balanceOf(address(pool)), 0);
    }

    function test_ModulesAreSetOnceAndCooldownIsBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(CoverPool.AlreadySet.selector);
        pool.setCoverManager(ICoverManager(address(1)));
        vm.expectRevert(CoverPool.AlreadySet.selector);
        pool.setClaimsEngine(address(1));
        vm.expectRevert(CoverPool.CooldownTooLong.selector);
        pool.setCooldown(31 days);
        pool.setCooldown(1 hours);
        vm.stopPrank();
        assertEq(pool.cooldown(), 1 hours);

        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        pool.setCooldown(0);
    }
}

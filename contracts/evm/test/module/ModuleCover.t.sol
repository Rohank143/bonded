// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {ClaimsEngine} from "../../src/ClaimsEngine.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "../ProtocolBase.t.sol";
import {ModuleTestBase} from "./ModuleTestBase.sol";

/// @notice Cover and claims for module-protected accounts: premiums come from the account,
///         payouts go back into it, and the waterfall is the vault's (bond first, then pool).
abstract contract ModuleCoverTests is ProtocolBase, ModuleTestBase {
    address internal account;
    MandateModule internal module;

    function kind() internal pure virtual returns (Kind);

    function setUp() public override(ProtocolBase, ModuleTestBase) {
        super.setUp();
        vm.prank(owner);
        manager.setModuleFactory(address(moduleFactory));
        (account, module) = _protectedAccountFor(agentId2, BondedTypes.MandateMode.Monitor);
        _stake(agentId2, BOND);
    }

    // ----- Helpers -----------------------------------------------------------------------

    function _protectedAccountFor(uint256 id, BondedTypes.MandateMode mode)
        internal
        returns (address a, MandateModule m)
    {
        a = _newAccount(kind());
        vm.prank(a);
        m = MandateModule(moduleFactory.createModule(_moduleParams(mode), agent, guardian, id));
        _install(a, address(m), EXECUTOR);
        _install(a, address(m), HOOK);
        usdg.mint(a, DEPOSIT);
        _mexec(
            m, address(usdg), abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
        );
    }

    function _moduleQuote(MandateModule m, uint256 cover)
        internal
        returns (BondedTypes.Quote memory q)
    {
        q = BondedTypes.Quote({
            agentId: m.agentId(),
            vault: address(m),
            coverAmount: cover,
            premiumRateBps: RATE_BPS,
            score: SCORE,
            modelFamily: CLAUDE,
            mandateHash: m.mandateHash(),
            reportHash: keccak256("arena report"),
            minBond: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: ++quoteNonce
        });
    }

    function _bindModule() internal returns (uint256 policyId) {
        BondedTypes.Quote memory q = _moduleQuote(module, COVER);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        policyId = manager.buyCover(q, signature);
        vm.warp(block.timestamp + manager.waitingPeriod());
    }

    // ----- Binding and premiums ----------------------------------------------------------

    function test_ModuleHoldsCoverAndPremiumComesFromTheAccount() public {
        uint256 policyId = _bindModule();
        ICoverManager.Policy memory policy = manager.getPolicy(policyId);
        assertEq(policy.vault, address(module));
        assertEq(manager.ownerOf(policyId), address(module)); // the receipt sits with the guard
        assertEq(manager.activePolicyOf(address(module)), policyId);

        uint256 before = usdg.balanceOf(account);
        vm.warp(block.timestamp + 10 days);
        manager.accrue(policyId);
        uint256 premium = before - usdg.balanceOf(account);
        assertEq(premium, _expectedPremium(COVER, RATE_BPS, 10 days + manager.waitingPeriod()));
        module.reconcile();
        assertEq(module.breachCount(), 0); // a premium is not a breach
    }

    function test_QuoteMustCarryTheModulesCommitment() public {
        BondedTypes.Quote memory q = _moduleQuote(module, COVER);
        q.mandateHash = keccak256("demo mandate"); // the JSON hash a vault would use
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.QuoteMismatch.selector, "mandateHash"));
        manager.buyCover(q, signature);
    }

    function test_OnlyFactoryModulesHoldCover() public {
        // Deployed outside the factory: same code, but not admitted.
        MandateModule rogue = new MandateModule(
            _moduleParams(BondedTypes.MandateMode.Monitor),
            account,
            agent,
            guardian,
            agentId2,
            oracle
        );
        BondedTypes.Quote memory q = _moduleQuote(rogue, COVER);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.NotAVault.selector, address(rogue)));
        manager.buyCover(q, signature);
    }

    function test_ModuleFactoryIsSetOnceByTheOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        manager.setModuleFactory(attacker);
        vm.prank(owner);
        vm.expectRevert(CoverManager.AlreadySet.selector);
        manager.setModuleFactory(attacker);
        assertEq(address(manager.moduleFactory()), address(moduleFactory));
    }

    function test_GuardianCancelsTheModulesPolicy() public {
        uint256 policyId = _bindModule();
        vm.prank(attacker);
        vm.expectRevert(CoverManager.NotGuardian.selector);
        manager.cancel(policyId);
        vm.prank(guardian);
        manager.cancel(policyId);
        assertEq(uint8(manager.getPolicy(policyId).status), uint8(ICoverManager.Status.Cancelled));
    }

    function test_PolicyLapsesOnceTheExecutorIsRemoved() public {
        uint256 policyId = _bindModule();
        _uninstall(account, address(module), HOOK);
        _uninstall(account, address(module), EXECUTOR);
        vm.warp(block.timestamp + 1 days);
        manager.accrue(policyId); // payPremium fails: past due
        assertEq(uint8(manager.getPolicy(policyId).status), uint8(ICoverManager.Status.Active));
        vm.warp(block.timestamp + manager.gracePeriod());
        manager.accrue(policyId);
        assertEq(uint8(manager.getPolicy(policyId).status), uint8(ICoverManager.Status.Lapsed));
    }

    // ----- Claims ------------------------------------------------------------------------

    function test_ClaimPaysTheAccountFromTheBond() public {
        uint256 policyId = _bindModule();
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        assertTrue(module.frozen());

        manager.accrue(policyId); // premiums up to date, so nothing is netted from the payout
        uint256 before = usdg.balanceOf(account);
        uint256 paid = claims.fileClaim(policyId, _ids(0));

        assertEq(paid, 5000e6 * 9000 / 10_000); // 10% deductible
        assertEq(usdg.balanceOf(account), before + paid); // into the account, not the module
        assertEq(usdg.balanceOf(address(module)), 0);
        assertEq(bond.bondOf(agentId2), BOND - paid);
        assertTrue(module.getBreach(0).claimed);

        // The payout is inflow, not a breach, and a breach can't be paid twice.
        module.reconcile();
        assertEq(module.breachCount(), 1);
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachAlreadyClaimed.selector, 0));
        claims.fileClaim(policyId, _ids(0));
    }

    function test_PoolPaysWhatTheBondCannot() public {
        uint256 policyId = _bindModule();
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 20_000e6)));

        manager.accrue(policyId);
        uint256 before = usdg.balanceOf(account);
        uint256 poolBefore = usdg.balanceOf(address(pool));
        uint256 paid = claims.fileClaim(policyId, _ids(0));

        assertEq(bond.bondOf(agentId2), 0); // bond used up first...
        assertEq(poolBefore - usdg.balanceOf(address(pool)), paid - BOND); // ...then the pool
        assertEq(usdg.balanceOf(account), before + paid);
    }

    function test_DeferredBreachIsRecordedButNotPaid() public {
        uint256 policyId = _bindModule();
        _mexec(module, address(usdg), abi.encodeCall(IERC20.approve, (attacker, 3000e6)));
        vm.prank(attacker);
        assertTrue(usdg.transferFrom(account, attacker, 3000e6));
        module.reconcile();
        assertEq(uint8(module.getBreach(1).breachType), uint8(BondedTypes.BreachType.Deferred));

        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachNotCovered.selector, 1));
        claims.fileClaim(policyId, _ids(1));
        vm.expectRevert(ClaimsEngine.NothingToPay.selector); // the approval itself lost nothing
        claims.fileClaim(policyId, _ids(0));
    }

    function test_VaultDeferredBreachesAreStillPaid() public {
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + manager.waitingPeriod());
        router.drain(address(usdg), address(vault), attacker, 2000e6); // allowed spender abuses it
        vault.reconcile();
        uint256 breachId = vault.breachCount() - 1;
        assertEq(
            uint8(vault.getBreach(breachId).breachType), uint8(BondedTypes.BreachType.Deferred)
        );
        manager.accrue(policyId);
        uint256 before = usdg.balanceOf(address(vault));
        uint256 paid = claims.fileClaim(policyId, _ids(breachId));
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(address(vault)), before + paid);
    }

    function test_EnforceModeBlockedBreachIsNotPaid() public {
        (, MandateModule m) = _protectedAccountFor(agentId2, BondedTypes.MandateMode.Enforce);
        BondedTypes.Quote memory q = _moduleQuote(m, COVER);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        uint256 policyId = manager.buyCover(q, signature);
        vm.warp(block.timestamp + manager.waitingPeriod());
        _mexec(m, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachBlocked.selector, 0));
        claims.fileClaim(policyId, _ids(0));
    }

    function test_ApprovedDisputePaysTheAccount() public {
        uint256 policyId = _bindModule();
        address disputes = makeAddr("disputes");
        vm.prank(owner);
        claims.setDisputeModule(disputes);
        manager.accrue(policyId);
        uint256 before = usdg.balanceOf(account);
        vm.prank(disputes);
        uint256 paid = claims.payDispute(policyId, 1000e6);
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(account), before + paid);
    }
}

contract ModuleCoverMsaTest is ModuleCoverTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Msa;
    }
}

contract ModuleCoverSafeTest is ModuleCoverTests {
    function kind() internal pure override returns (Kind) {
        return Kind.Safe;
    }
}

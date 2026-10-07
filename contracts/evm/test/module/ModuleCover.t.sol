// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateModuleFactory} from "../../src/MandateModuleFactory.sol";
import {MandateVaultFactory} from "../../src/MandateVaultFactory.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {ClaimsEngine} from "../../src/ClaimsEngine.sol";
import {DisputeModule, IDisputePayer} from "../../src/DisputeModule.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "../ProtocolBase.t.sol";
import {ModuleTestBase} from "./ModuleTestBase.sol";
import {FakeAccount} from "../mocks/MockAccounts.sol";

/// @notice Cover and claims for module-protected accounts. Only Enforce-mode modules can hold
///         cover (a Monitor-mode breach would pay the account's owner for a transfer they could
///         have asked for). Premiums come from the account and must really arrive; payouts go
///         back into it with the vault's waterfall (bond first, then pool). In Enforce mode every
///         breach through `execute` is blocked, and Deferred breaches aren't paid on modules, so
///         money reaches a module's account through council-approved disputes.
abstract contract ModuleCoverTests is ProtocolBase, ModuleTestBase {
    uint256 internal constant PROPOSAL_BOND = 250e6;

    address internal account;
    MandateModule internal module;
    DisputeModule internal disputes;
    address internal council = makeAddr("council");
    address internal proposer = makeAddr("proposer");

    function kind() internal pure virtual returns (Kind);

    function setUp() public override(ProtocolBase, ModuleTestBase) {
        super.setUp();
        vm.prank(owner);
        manager.setModuleFactory(address(moduleFactory));
        disputes = new DisputeModule(
            owner,
            IERC20(address(usdg)),
            manager,
            IDisputePayer(address(claims)),
            council,
            PROPOSAL_BOND
        );
        vm.prank(owner);
        claims.setDisputeModule(address(disputes));
        usdg.mint(proposer, 10_000e6);
        vm.prank(proposer);
        usdg.approve(address(disputes), type(uint256).max);

        (account, module) = _protectedAccountFor(agentId2, BondedTypes.MandateMode.Enforce);
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

    function _bindModule(MandateModule m) internal returns (uint256 policyId) {
        BondedTypes.Quote memory q = _moduleQuote(m, COVER);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        policyId = manager.buyCover(q, signature);
        vm.warp(block.timestamp + manager.waitingPeriod());
    }

    function _propose(uint256 policyId, uint256 lossBase) internal returns (uint256 id) {
        vm.prank(proposer);
        id = disputes.propose(policyId, lossBase, keccak256("adjudicator report"), "ipfs://r");
    }

    // ----- Binding and premiums ----------------------------------------------------------

    function test_ModuleHoldsCoverAndPremiumComesFromTheAccount() public {
        uint256 policyId = _bindModule(module);
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

    /// @dev Regression for the review's owner-induced claim: in Monitor mode the agent's
    ///      transfer to the owner's wallet would go through and the claim would pay the owner.
    function test_MonitorModulesCantHoldCover() public {
        (, MandateModule monitor) = _protectedAccountFor(agentId2, BondedTypes.MandateMode.Monitor);
        BondedTypes.Quote memory q = _moduleQuote(monitor, COVER);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(CoverManager.ModuleMustEnforce.selector);
        manager.buyCover(q, signature);
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
            _moduleParams(BondedTypes.MandateMode.Enforce),
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

    function test_ModuleFactoryIsSetOnceByTheOwnerAndMustMatch() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        manager.setModuleFactory(attacker);
        vm.prank(owner);
        vm.expectRevert(CoverManager.AlreadySet.selector);
        manager.setModuleFactory(attacker);
        assertEq(address(manager.moduleFactory()), address(moduleFactory));

        // A fresh CoverManager refuses a module factory built on another vault factory.
        CoverManager other =
            new CoverManager(owner, registry, factory, pool, bond, protocolTreasury, bountyPool);
        MandateModuleFactory elsewhere =
            new MandateModuleFactory(new MandateVaultFactory(owner, oracle));
        vm.prank(owner);
        vm.expectRevert(CoverManager.WrongVaultFactory.selector);
        other.setModuleFactory(address(elsewhere));
    }

    function test_GuardianCancelsTheModulesPolicy() public {
        uint256 policyId = _bindModule(module);
        vm.prank(attacker);
        vm.expectRevert(CoverManager.NotGuardian.selector);
        manager.cancel(policyId);
        vm.prank(guardian);
        manager.cancel(policyId);
        assertEq(uint8(manager.getPolicy(policyId).status), uint8(ICoverManager.Status.Cancelled));
    }

    function test_PolicyLapsesOnceTheExecutorIsRemoved() public {
        uint256 policyId = _bindModule(module);
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

    function test_BlockedBreachIsNotPaid() public {
        uint256 policyId = _bindModule(module);
        _mexec(module, address(usdg), abi.encodeCall(IERC20.transfer, (attacker, 5000e6)));
        assertEq(usdg.balanceOf(account), DEPOSIT); // Enforce: nothing moved
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachBlocked.selector, 0));
        claims.fileClaim(policyId, _ids(0));
    }

    /// @dev Regression for the review's F-12 note: Deferred losses happen in Enforce mode too
    ///      (an allowed spender pulling later). Recorded, freezes the agent, not paid on a module.
    function test_DeferredBreachIsRecordedButNotPaid() public {
        uint256 policyId = _bindModule(module);
        router.drain(address(usdg), account, attacker, 2000e6); // compromised allowed router
        module.reconcile();
        assertEq(uint8(module.getBreach(0).breachType), uint8(BondedTypes.BreachType.Deferred));
        assertFalse(module.getBreach(0).blocked);
        assertTrue(module.frozen());
        vm.expectRevert(abi.encodeWithSelector(ClaimsEngine.BreachNotCovered.selector, 0));
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

    /// @dev Regression for the review: the proposer of a module dispute may be the account's
    ///      owner, who gets the payout, so an unchallenged proposal never pays by itself.
    function test_ModuleDisputePaysTheAccountOnlyWithTheCouncil() public {
        uint256 policyId = _bindModule(module);
        uint256 id = _propose(policyId, 3000e6);
        vm.warp(block.timestamp + disputes.challengePeriod());
        vm.expectRevert(DisputeModule.CouncilDecisionRequired.selector);
        disputes.finalize(id);
        vm.prank(attacker);
        vm.expectRevert(DisputeModule.NotCouncil.selector);
        disputes.resolve(id, true);

        manager.accrue(policyId);
        uint256 before = usdg.balanceOf(account);
        vm.prank(council);
        uint256 paid = disputes.resolve(id, true);
        assertEq(paid, 2700e6); // 3,000 minus the 10% deductible
        assertEq(usdg.balanceOf(account), before + paid); // into the account, not the module
        assertEq(usdg.balanceOf(address(module)), 0);
        assertEq(bond.bondOf(agentId2), BOND - paid); // bond first
        assertEq(usdg.balanceOf(proposer), 10_000e6); // proposal bond returned
    }

    function test_CouncilWaitsForTheChallengePeriod() public {
        uint256 id = _propose(_bindModule(module), 3000e6);
        vm.prank(council);
        vm.expectRevert(DisputeModule.ChallengePeriodActive.selector);
        disputes.resolve(id, true);
        vm.prank(council);
        disputes.resolve(id, false); // rejecting early is still allowed
        assertEq(uint8(disputes.getDispute(id).status), uint8(DisputeModule.Status.Rejected));
    }

    function test_PoolPaysWhatTheBondCannot() public {
        uint256 policyId = _bindModule(module);
        uint256 id = _propose(policyId, 20_000e6);
        vm.warp(block.timestamp + disputes.challengePeriod());
        manager.accrue(policyId);
        uint256 before = usdg.balanceOf(account);
        uint256 poolBefore = usdg.balanceOf(address(pool));
        vm.prank(council);
        uint256 paid = disputes.resolve(id, true);
        assertEq(bond.bondOf(agentId2), 0); // bond used up first...
        assertEq(poolBefore - usdg.balanceOf(address(pool)), paid - BOND); // ...then the pool
        assertEq(usdg.balanceOf(account), before + paid);
    }

    // ----- Premiums must really arrive ---------------------------------------------------

    /// @dev Regression for the review's fake account: it reports every execution as done but
    ///      pays nothing. That is now a missed premium, so the policy lapses after the grace
    ///      period and stops counting against the pool's caps.
    function test_PremiumThatNeverArrivesIsMissed() public {
        FakeAccount fake = new FakeAccount();
        MandateModule m = fake.create(
            moduleFactory, _moduleParams(BondedTypes.MandateMode.Enforce), agent, guardian, agentId2
        );
        usdg.mint(address(fake), DEPOSIT);
        uint256 policyId = _bindModule(m);

        vm.warp(block.timestamp + 10 days);
        manager.accrue(policyId);
        ICoverManager.Policy memory p = manager.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Active)); // in its grace period
        assertEq(p.pastDueSince, uint64(block.timestamp));
        assertEq(usdg.balanceOf(address(manager)), 0);

        vm.warp(block.timestamp + manager.gracePeriod());
        manager.accrue(policyId);
        assertEq(uint8(manager.getPolicy(policyId).status), uint8(ICoverManager.Status.Lapsed));
        assertEq(manager.totalActiveCover(), 0);
        assertEq(manager.activeCoverOfAgent(agentId2), 0);
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {CoverManager} from "../src/CoverManager.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

contract CoverManagerTest is ProtocolBase {
    // ----- Binding -----------------------------------------------------------------------

    function test_BindsCoverFromASignedQuote() public {
        uint256 policyId = _bindDefault();

        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(policyId, 1);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Active));
        assertEq(p.agentId, 42);
        assertEq(p.vault, address(vault));
        assertEq(p.coverAmount, COVER);
        assertEq(p.remainingCover, COVER);
        assertEq(p.premiumRateBps, RATE_BPS);
        assertEq(p.score, SCORE);
        assertEq(p.coveredFrom, block.timestamp + 1 days);
        assertEq(p.endsAt, block.timestamp + 30 days);
        assertEq(manager.ownerOf(policyId), address(vault));
        assertEq(manager.activePolicyOf(address(vault)), policyId);
        assertEq(manager.totalActiveCover(), COVER);
        assertEq(manager.activeCoverOfAgent(42), COVER);
        assertEq(manager.activeCoverOfFamily(CLAUDE), COVER);
    }

    function test_RejectsQuotesNotSignedByAnAttester() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory signature = _sign(q, strangerKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.NotAttester.selector, stranger));
        manager.buyCover(q, signature);
    }

    function test_RejectsAQuoteSignedForAnotherContract() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);
        q.coverAmount = COVER * 2; // tampered after signing
        vm.prank(guardian);
        vm.expectPartialRevert(CoverManager.NotAttester.selector);
        manager.buyCover(q, signature);
    }

    function test_RejectsExpiredAndReusedQuotes() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);

        vm.warp(q.expiresAt + 1);
        vm.prank(guardian);
        vm.expectRevert(CoverManager.QuoteExpired.selector);
        manager.buyCover(q, signature);

        q = _quote(vault, COVER, RATE_BPS, SCORE);
        signature = _sign(q, attesterKey);
        vm.prank(guardian);
        uint256 policyId = manager.buyCover(q, signature);
        vm.prank(guardian);
        manager.cancel(policyId);
        vm.prank(guardian);
        vm.expectRevert(CoverManager.QuoteAlreadyUsed.selector);
        manager.buyCover(q, signature);
    }

    function test_OnlyTheVaultGuardianCanBind() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(attacker);
        vm.expectRevert(CoverManager.NotGuardian.selector);
        manager.buyCover(q, signature);
    }

    function test_RejectsNonFactoryVaults() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        q.vault = address(stranger);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.NotAVault.selector, address(stranger)));
        manager.buyCover(q, signature);
    }

    function test_RejectsQuotesThatDoNotMatchTheVault() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        q.mandateHash = keccak256("another mandate");
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.QuoteMismatch.selector, "mandateHash"));
        manager.buyCover(q, signature);

        q = _quote(vault, COVER, RATE_BPS, SCORE);
        q.agentId = 7;
        signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.QuoteMismatch.selector, "agentId"));
        manager.buyCover(q, signature);
    }

    function test_RequiresFreezeOnBreach() public {
        BondedTypes.MandateParams memory params = _params(BondedTypes.MandateMode.Monitor);
        params.freezeOnBreach = false;
        MandateVault loose =
            MandateVault(factory.createVault(params, agent, guardian, 42, "v", "v"));
        BondedTypes.Quote memory q = _quote(loose, COVER, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(CoverManager.VaultMustFreezeOnBreach.selector);
        manager.buyCover(q, signature);
    }

    function test_OneActivePolicyPerVault() public {
        uint256 first = _bindDefault();
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.ActivePolicyExists.selector, first));
        manager.buyCover(q, signature);
    }

    function test_AnExpiredPolicyMakesRoomForANewOne() public {
        uint256 first = _bindDefault();
        vm.warp(block.timestamp + 31 days);
        uint256 second = _buy(vault, _quote(vault, COVER, RATE_BPS, SCORE));
        assertEq(uint8(_policy(first).status), uint8(ICoverManager.Status.Expired));
        assertEq(manager.activePolicyOf(address(vault)), second);
        assertEq(manager.totalActiveCover(), COVER);
    }

    // ----- Underwriting rules ------------------------------------------------------------

    function test_RejectsUninsurableScores() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, 24);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.Uninsurable.selector, 24));
        manager.buyCover(q, signature);

        q = _quote(vault, COVER, RATE_BPS, 101);
        signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.InvalidParams.selector, "score"));
        manager.buyCover(q, signature);
    }

    function test_RequiresTheTierBondAndTheQuotedMinimum() public {
        // Tier B needs a 30% bond: 6,000 on 20,000 cover. The operator has 10,000, so ask for more cover.
        BondedTypes.Quote memory q = _quote(vault, 19_000e6, 900, 41);
        _depositToPool(underwriter, POOL_DEPOSIT); // keep the tier-B 2% cap out of the way
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        manager.buyCover(q, signature); // 30% of 19,000 = 5,700 <= 10,000

        vm.warp(block.timestamp + 31 days);
        q = _quote(vault, COVER, RATE_BPS, SCORE);
        q.minBond = 15_000e6;
        signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(CoverManager.InsufficientBond.selector, 15_000e6, BOND)
        );
        manager.buyCover(q, signature);
    }

    function test_TierBCoverIsCappedAtTwoPercentOfPool() public {
        BondedTypes.Quote memory q = _quote(vault, 20_001e6, 900, 41); // 2% of 1M = 20,000
        _stake(42, 10_000e6);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.CapacityExceeded.selector, "agent"));
        manager.buyCover(q, signature);
    }

    function test_EnforcesTheLeverageCap() public {
        vm.prank(owner);
        manager.setRiskParams(1000, 10_000, 10_000); // total cover <= 10% of pool
        BondedTypes.Quote memory q = _quote(vault, 100_001e6, RATE_BPS, SCORE);
        _stake(42, 10_001e6);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.CapacityExceeded.selector, "leverage"));
        manager.buyCover(q, signature);
    }

    function test_EnforcesTheModelFamilyCap() public {
        vm.prank(owner);
        manager.setRiskParams(20_000, 1000, 10); // one family <= 0.1% of pool = 1,000
        BondedTypes.Quote memory q = _quote(vault, 1001e6, RATE_BPS, SCORE);
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(CoverManager.CapacityExceeded.selector, "modelFamily")
        );
        manager.buyCover(q, signature);
    }

    // ----- Premiums ----------------------------------------------------------------------

    function test_PremiumAccruesAndIsSplit() public {
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + 10 days);
        uint256 owed = manager.premiumOwed(policyId);
        assertEq(owed, _expectedPremium(COVER, RATE_BPS, 10 days));

        uint256 poolBefore = usdg.balanceOf(address(pool));
        manager.accrue(policyId);

        uint256 toTreasury = owed * 1500 / 10_000;
        uint256 toBounty = owed * 500 / 10_000;
        assertEq(usdg.balanceOf(protocolTreasury), toTreasury);
        assertEq(usdg.balanceOf(bountyPool), toBounty);
        assertEq(usdg.balanceOf(address(pool)) - poolBefore, owed - toTreasury - toBounty);
        assertEq(_policy(policyId).paidUntil, block.timestamp);
        assertEq(vault.breachCount(), 0); // paying premium is not a breach
    }

    function test_PolicyExpiresAtTheEndOfItsTerm() public {
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + 45 days);
        manager.accrue(policyId);

        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Expired));
        assertEq(p.closedAt, p.endsAt);
        assertEq(p.paidUntil, p.endsAt); // charged for 30 days, not 45
        assertEq(manager.totalActiveCover(), 0);
        assertEq(manager.activePolicyOf(address(vault)), 0);
    }

    function test_FrequentAccrualCannotMakeCoverFree() public {
        uint256 policyId = _bindDefault();
        uint256 start = usdg.balanceOf(address(vault));
        for (uint256 i; i < 50; ++i) {
            vm.warp(block.timestamp + 1);
            manager.accrue(policyId);
        }
        uint256 paid = start - usdg.balanceOf(address(vault));
        assertGe(paid, _expectedPremium(COVER, RATE_BPS, 50));
    }

    function test_LapsesWhenTheVaultCannotPay() public {
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + 5 days);
        manager.accrue(policyId);
        uint64 paidUntil = _policy(policyId).paidUntil;

        uint256 shares = vault.maxRedeem(depositor);
        vm.prank(depositor);
        vault.redeem(shares, depositor, depositor); // empties the vault's base balance

        vm.warp(block.timestamp + 5 days);
        manager.accrue(policyId);
        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Lapsed));
        assertEq(p.closedAt, paidUntil);
        assertEq(manager.totalActiveCover(), 0);
    }

    function test_GuardianCancelsAfterSettlingPremium() public {
        uint256 policyId = _bindDefault();
        vm.warp(block.timestamp + 3 days);

        vm.prank(attacker);
        vm.expectRevert(CoverManager.NotGuardian.selector);
        manager.cancel(policyId);

        vm.prank(guardian);
        manager.cancel(policyId);
        ICoverManager.Policy memory p = _policy(policyId);
        assertEq(uint8(p.status), uint8(ICoverManager.Status.Cancelled));
        assertEq(p.paidUntil, block.timestamp);
        assertEq(manager.totalActiveCover(), 0);
    }

    // ----- Policy NFT, views, admin ------------------------------------------------------

    function test_PolicyNftCannotBeTransferred() public {
        uint256 policyId = _bindDefault();
        vm.prank(address(vault));
        vm.expectRevert(CoverManager.PolicyNotTransferable.selector);
        manager.transferFrom(address(vault), attacker, policyId);
    }

    function test_UnknownPolicyReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CoverManager.UnknownPolicy.selector, 99));
        manager.getPolicy(99);
    }

    function test_OnlyClaimsEngineRecordsClaims() public {
        uint256 policyId = _bindDefault();
        vm.expectRevert(CoverManager.NotClaimsEngine.selector);
        manager.recordClaim(policyId, 1);
    }

    function test_AdminSettersAreOwnerOnlyAndBounded() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        manager.setAttester(address(1), true);

        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CoverManager.InvalidParams.selector, "fees above 50%")
        );
        manager.setFees(4000, 1001);
        vm.expectRevert(
            abi.encodeWithSelector(CoverManager.InvalidParams.selector, "maxLeverageBps")
        );
        manager.setRiskParams(50_001, 1000, 4000);
        vm.expectRevert(
            abi.encodeWithSelector(CoverManager.InvalidParams.selector, "waitingPeriod")
        );
        manager.setTerms(1 days, 1 days);
        vm.expectRevert(CoverManager.AlreadySet.selector);
        manager.setClaimsEngine(address(1));

        manager.setTerms(7 days, 5 minutes);
        assertEq(manager.policyTerm(), 7 days);
        assertEq(manager.waitingPeriod(), 5 minutes);
        vm.stopPrank();
    }

    function test_QuoteDigestMatchesTypeScript() public {
        address at = 0x0000000000000000000000000000000000001234;
        deployCodeTo(
            "CoverManager.sol:CoverManager",
            abi.encode(owner, factory, pool, bond, protocolTreasury, bountyPool),
            at
        );
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: 42,
            vault: 0x6666666666666666666666666666666666666666,
            coverAmount: 100_000_000_000,
            premiumRateBps: 120,
            score: 96,
            modelFamily: 1,
            mandateHash: bytes32(uint256(2)),
            reportHash: bytes32(uint256(1)),
            minBond: 10_000_000_000,
            expiresAt: 1_790_086_400,
            nonce: 1
        });
        // Produced by viem in packages/shared/test/attestation.test.ts for chain 31337 and this address.
        assertEq(
            CoverManager(at).quoteDigest(q),
            0x01be0f221106d2450c0f8547deae4a5c5f116de1d04f81e2863e7bc06ce72177
        );
    }

    function test_RejectsMalformedSignatures() public {
        BondedTypes.Quote memory q = _quote(vault, COVER, RATE_BPS, SCORE);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 3));
        manager.buyCover(q, hex"010203");
    }

    function test_PoolAssetMustMatchTheVault() public view {
        assertEq(address(manager.baseAsset()), vault.asset());
        assertEq(address(manager.baseAsset()), address(IERC20(address(usdg))));
    }
}

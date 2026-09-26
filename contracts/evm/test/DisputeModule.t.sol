// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DisputeModule, IDisputePayer} from "../src/DisputeModule.sol";
import {ClaimsEngine} from "../src/ClaimsEngine.sol";
import {CoverManager} from "../src/CoverManager.sol";
import {ProtocolBase} from "./ProtocolBase.t.sol";

contract DisputeModuleTest is ProtocolBase {
    uint256 internal constant PROPOSAL_BOND = 250e6;
    DisputeModule internal disputes;
    address internal council = makeAddr("council");
    address internal proposer = makeAddr("proposer");
    address internal challenger = makeAddr("challenger");
    uint256 internal policyId;

    function setUp() public override {
        super.setUp();
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
        policyId = _bindDefault();
        vm.warp(block.timestamp + 1 days);

        for (uint256 i; i < 2; ++i) {
            address who = i == 0 ? proposer : challenger;
            usdg.mint(who, 10_000e6);
            vm.prank(who);
            usdg.approve(address(disputes), type(uint256).max);
        }
    }

    function _propose(uint256 lossBase) internal returns (uint256 id) {
        vm.prank(proposer);
        id = disputes.propose(policyId, lossBase, keccak256("adjudicator report"), "ipfs://report");
    }

    function test_UnchallengedProposalPaysAfterTheDeadline() public {
        uint256 id = _propose(3000e6);
        assertEq(usdg.balanceOf(address(disputes)), PROPOSAL_BOND);

        vm.expectRevert(DisputeModule.ChallengePeriodActive.selector);
        disputes.finalize(id);

        vm.warp(block.timestamp + 2 days);
        uint256 vaultBefore = usdg.balanceOf(address(vault));
        uint256 paid = disputes.finalize(id);

        assertEq(paid, 2700e6); // 3,000 minus the 10% deductible, from the bond
        assertEq(bond.bondOf(agentId), BOND - 2700e6);
        assertGt(usdg.balanceOf(address(vault)), vaultBefore);
        assertEq(usdg.balanceOf(proposer), 10_000e6); // bond returned
        assertEq(uint8(disputes.getDispute(id).status), uint8(DisputeModule.Status.Paid));
    }

    function test_ChallengedAndApprovedPaysAndRewardsTheProposer() public {
        uint256 id = _propose(3000e6);
        vm.prank(challenger);
        disputes.challenge(id);

        vm.prank(council);
        uint256 paid = disputes.resolve(id, true);
        assertEq(paid, 2700e6);
        assertEq(usdg.balanceOf(proposer), 10_000e6 + PROPOSAL_BOND);
        assertEq(usdg.balanceOf(challenger), 10_000e6 - PROPOSAL_BOND);
    }

    function test_ChallengedAndRejectedRewardsTheChallenger() public {
        uint256 id = _propose(3000e6);
        vm.prank(challenger);
        disputes.challenge(id);

        vm.prank(council);
        disputes.resolve(id, false);
        assertEq(usdg.balanceOf(challenger), 10_000e6 + PROPOSAL_BOND);
        assertEq(bond.bondOf(agentId), BOND); // nothing paid
        assertEq(uint8(disputes.getDispute(id).status), uint8(DisputeModule.Status.Rejected));
    }

    function test_CouncilCanRejectAnUnchallengedProposalAndRefund() public {
        uint256 id = _propose(3000e6);
        vm.prank(council);
        vm.expectRevert(
            abi.encodeWithSelector(
                DisputeModule.WrongStatus.selector, DisputeModule.Status.Proposed
            )
        );
        disputes.resolve(id, true); // unchallenged proposals pay through finalize, not the council

        vm.prank(council);
        disputes.resolve(id, false);
        assertEq(usdg.balanceOf(proposer), 10_000e6);
    }

    function test_TimingAndAccessRules() public {
        uint256 id = _propose(3000e6);
        vm.expectRevert(DisputeModule.NotCouncil.selector);
        disputes.resolve(id, true);

        vm.warp(block.timestamp + 2 days);
        vm.prank(challenger);
        vm.expectRevert(DisputeModule.ChallengePeriodOver.selector);
        disputes.challenge(id);

        disputes.finalize(id);
        vm.expectRevert(
            abi.encodeWithSelector(DisputeModule.WrongStatus.selector, DisputeModule.Status.Paid)
        );
        disputes.finalize(id);
    }

    function test_RejectsBadProposals() public {
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(DisputeModule.InvalidParams.selector, "lossBase"));
        disputes.propose(policyId, 0, bytes32(0), "");

        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(CoverManager.UnknownPolicy.selector, 99));
        disputes.propose(99, 1e6, bytes32(0), "");

        vm.expectRevert(abi.encodeWithSelector(DisputeModule.UnknownDispute.selector, 5));
        disputes.getDispute(5);
    }

    function test_OnlyTheDisputeModuleCanPayDisputes() public {
        vm.expectRevert(ClaimsEngine.NotDisputeModule.selector);
        claims.payDispute(policyId, 1e6);

        vm.prank(owner);
        vm.expectRevert(ClaimsEngine.AlreadySet.selector);
        claims.setDisputeModule(address(1));
    }

    function test_ParamsAreBoundedAndOwnerOnly() public {
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(DisputeModule.InvalidParams.selector, "challengePeriod")
        );
        disputes.setParams(1, 1 minutes);
        disputes.setParams(100e6, 10 minutes);
        disputes.setCouncil(challenger);
        vm.stopPrank();
        assertEq(disputes.proposalBond(), 100e6);
        assertEq(disputes.council(), challenger);
    }
}

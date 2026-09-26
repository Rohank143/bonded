// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedRegistry} from "../src/BondedRegistry.sol";
import {BountyBoard} from "../src/BountyBoard.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract BountyBoardTest is Test {
    MockERC20 internal usdg;
    BondedRegistry internal registry;
    BountyBoard internal board;
    address internal owner = makeAddr("owner");
    address internal attester = makeAddr("attester");
    address internal hunter = makeAddr("hunter");
    string internal constant SPEC = "ipfs://attacks/A1-unicode-ticker-001.yaml";
    bytes32 internal constant SALT = keccak256("salt");

    function setUp() public {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        registry = new BondedRegistry(owner);
        vm.prank(owner);
        registry.setAttester(attester, true);
        board = new BountyBoard(IERC20(address(usdg)), registry);
        usdg.mint(address(board), 10_000e6); // premiums' 5% share lands here
    }

    function _commitAndReveal() internal returns (uint256 id) {
        vm.startPrank(hunter);
        id = board.commit(board.commitmentFor(hunter, SPEC, SALT));
        board.reveal(id, SPEC, SALT);
        vm.stopPrank();
    }

    function test_AcceptedAttacksPayTheHunter() public {
        uint256 id = _commitAndReveal();
        vm.prank(attester);
        board.accept(id, 1500e6);

        assertEq(usdg.balanceOf(hunter), 1500e6);
        BountyBoard.Submission memory s = board.getSubmission(id);
        assertEq(uint8(s.status), uint8(BountyBoard.Status.Accepted));
        assertEq(s.reward, 1500e6);
        assertEq(s.specURI, SPEC);
    }

    function test_RevealMustMatchTheCommitmentAndTheHunter() public {
        bytes32 commitment = board.commitmentFor(hunter, SPEC, SALT);
        vm.prank(hunter);
        uint256 id = board.commit(commitment);

        vm.prank(hunter);
        vm.expectRevert(BountyBoard.BadReveal.selector);
        board.reveal(id, SPEC, keccak256("wrong salt"));

        // Someone who saw the commitment can't claim it.
        vm.prank(makeAddr("copycat"));
        vm.expectRevert(BountyBoard.NotHunter.selector);
        board.reveal(id, SPEC, SALT);
    }

    function test_OnlyAttestersJudge() public {
        uint256 id = _commitAndReveal();
        vm.expectRevert(BountyBoard.NotAttester.selector);
        board.accept(id, 1);
        vm.expectRevert(BountyBoard.NotAttester.selector);
        board.reject(id, bytes32(0));
    }

    function test_CannotAcceptBeforeRevealOrTwice() public {
        vm.prank(hunter);
        uint256 id = board.commit(keccak256("anything"));
        vm.prank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(BountyBoard.WrongStatus.selector, BountyBoard.Status.Committed)
        );
        board.accept(id, 1);

        uint256 revealed = _commitAndReveal();
        vm.startPrank(attester);
        board.accept(revealed, 1);
        vm.expectRevert(
            abi.encodeWithSelector(BountyBoard.WrongStatus.selector, BountyBoard.Status.Accepted)
        );
        board.accept(revealed, 1);
        vm.stopPrank();
    }

    function test_RejectionsAndFundLimits() public {
        uint256 id = _commitAndReveal();
        vm.startPrank(attester);
        vm.expectRevert(
            abi.encodeWithSelector(BountyBoard.InsufficientFunds.selector, 20_000e6, 10_000e6)
        );
        board.accept(id, 20_000e6);
        board.reject(id, keccak256("duplicate of #1"));
        vm.stopPrank();
        assertEq(uint8(board.getSubmission(id).status), uint8(BountyBoard.Status.Rejected));

        vm.expectRevert(abi.encodeWithSelector(BountyBoard.UnknownSubmission.selector, 9));
        board.getSubmission(9);
    }
}

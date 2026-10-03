// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BountyBoard} from "../../src/BountyBoard.sol";
import {BondedRegistry} from "../../src/BondedRegistry.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Hunters commit and reveal, an attester accepts or rejects, outsiders try to judge,
///         and the pool is topped up, in random order.
contract BountyHandler is CommonBase, StdCheats, StdUtils {
    BountyBoard internal immutable board;
    MockERC20 internal immutable usdg;
    address internal immutable attester;
    address[] internal _hunters;

    uint256[] internal _ids;
    mapping(uint256 id => bytes32) internal _salt;
    mapping(uint256 id => BountyBoard.Status) internal _lastStatus;

    uint256 public ghostFunded;
    uint256 public ghostPaid;
    /// @dev Set when a step breaks a property; the invariant test asserts they stay false.
    bool public statusWentBackwards;
    bool public outsiderJudged;
    bool public paidWrongHunter;

    constructor(BountyBoard board_, MockERC20 usdg_, address attester_, address[] memory hunters_) {
        board = board_;
        usdg = usdg_;
        attester = attester_;
        _hunters = hunters_;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 1, 10_000e6);
        usdg.mint(address(board), amount);
        ghostFunded += amount;
    }

    function commit(uint256 hunterSeed, bytes32 salt) external {
        address hunter = _hunters[bound(hunterSeed, 0, _hunters.length - 1)];
        vm.prank(hunter);
        uint256 id = board.commit(board.commitmentFor(hunter, _spec(salt), salt));
        _ids.push(id);
        _salt[id] = salt;
        _checkStatuses();
    }

    /// @param wrongSalt reveals with a different salt, which must fail.
    function reveal(uint256 idSeed, bool wrongSalt) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[bound(idSeed, 0, _ids.length - 1)];
        BountyBoard.Submission memory s = board.getSubmission(id);
        bytes32 salt = wrongSalt ? ~_salt[id] : _salt[id];
        vm.prank(s.hunter);
        try board.reveal(id, _spec(_salt[id]), salt) {} catch {}
        _checkStatuses();
    }

    function accept(uint256 idSeed, uint256 reward) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[bound(idSeed, 0, _ids.length - 1)];
        reward = bound(reward, 0, usdg.balanceOf(address(board)) + 1000e6);
        address hunter = board.getSubmission(id).hunter;
        uint256 before = usdg.balanceOf(hunter);
        vm.prank(attester);
        try board.accept(id, reward) {
            ghostPaid += reward;
            if (usdg.balanceOf(hunter) - before != reward) paidWrongHunter = true;
        } catch {}
        _checkStatuses();
    }

    function reject(uint256 idSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[bound(idSeed, 0, _ids.length - 1)];
        vm.prank(attester);
        try board.reject(id, keccak256("duplicate")) {} catch {}
        _checkStatuses();
    }

    /// @dev A hunter (not an attester) tries to accept or reject: must always fail.
    function outsiderJudges(uint256 idSeed, uint256 hunterSeed, bool acceptIt) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[bound(idSeed, 0, _ids.length - 1)];
        address hunter = _hunters[bound(hunterSeed, 0, _hunters.length - 1)];
        vm.prank(hunter);
        if (acceptIt) {
            try board.accept(id, 0) {
                outsiderJudged = true;
            } catch {}
        } else {
            try board.reject(id, bytes32(0)) {
                outsiderJudged = true;
            } catch {}
        }
        _checkStatuses();
    }

    function hunters() external view returns (address[] memory) {
        return _hunters;
    }

    function ids() external view returns (uint256[] memory) {
        return _ids;
    }

    /// @dev Allowed moves: Committed -> Revealed | Rejected, Revealed -> Accepted | Rejected.
    ///      Accepted and Rejected are final.
    function _checkStatuses() internal {
        for (uint256 i; i < _ids.length; ++i) {
            uint256 id = _ids[i];
            BountyBoard.Status last = _lastStatus[id];
            BountyBoard.Status next = board.getSubmission(id).status;
            if (next != last && !_allowed(last, next)) statusWentBackwards = true;
            _lastStatus[id] = next;
        }
    }

    function _allowed(BountyBoard.Status from, BountyBoard.Status to) internal pure returns (bool) {
        if (from == BountyBoard.Status.None) return to == BountyBoard.Status.Committed;
        if (from == BountyBoard.Status.Committed) {
            return to == BountyBoard.Status.Revealed || to == BountyBoard.Status.Rejected;
        }
        if (from == BountyBoard.Status.Revealed) {
            return to == BountyBoard.Status.Accepted || to == BountyBoard.Status.Rejected;
        }
        return false;
    }

    function _spec(bytes32 salt) internal pure returns (string memory) {
        return string.concat("ipfs://attack/", vm.toString(salt));
    }
}

/// @notice BountyBoard invariants: rewards never exceed funding, and a submission's status only
///         moves forward.
contract BountyInvariants is Test {
    BountyBoard internal board;
    MockERC20 internal usdg;
    BountyHandler internal handler;

    function setUp() public {
        address owner = makeAddr("owner");
        address attester = makeAddr("attester");
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        BondedRegistry registry = new BondedRegistry(owner);
        vm.prank(owner);
        registry.setAttester(attester, true);
        board = new BountyBoard(IERC20(address(usdg)), registry);

        address[] memory hunters = new address[](3);
        hunters[0] = makeAddr("hunter1");
        hunters[1] = makeAddr("hunter2");
        hunters[2] = makeAddr("hunter3");
        handler = new BountyHandler(board, usdg, attester, hunters);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = BountyHandler.fund.selector;
        selectors[1] = BountyHandler.commit.selector;
        selectors[2] = BountyHandler.reveal.selector;
        selectors[3] = BountyHandler.accept.selector;
        selectors[4] = BountyHandler.reject.selector;
        selectors[5] = BountyHandler.outsiderJudges.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Paid out never exceeds what was funded, and the balance is the difference.
    function invariant_PaidNeverExceedsFunded() public view {
        assertLe(handler.ghostPaid(), handler.ghostFunded());
        assertEq(usdg.balanceOf(address(board)), handler.ghostFunded() - handler.ghostPaid());
        address[] memory hunters = handler.hunters();
        uint256 received;
        for (uint256 i; i < hunters.length; ++i) {
            received += usdg.balanceOf(hunters[i]);
        }
        assertEq(received, handler.ghostPaid());
        assertFalse(handler.paidWrongHunter());
    }

    /// @notice A submission's status only moves forward, and only attesters decide.
    function invariant_StatusOnlyMovesForward() public view {
        assertFalse(handler.statusWentBackwards());
        assertFalse(handler.outsiderJudged());
    }

    /// @notice An accepted submission records the reward it was paid; others record none.
    function invariant_RewardOnlyOnAccepted() public view {
        uint256[] memory ids = handler.ids();
        uint256 sum;
        for (uint256 i; i < ids.length; ++i) {
            BountyBoard.Submission memory s = board.getSubmission(ids[i]);
            if (s.status != BountyBoard.Status.Accepted) assertEq(s.reward, 0);
            sum += s.reward;
        }
        assertEq(sum, handler.ghostPaid());
    }
}

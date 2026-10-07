// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {ClaimsEngine} from "../../src/ClaimsEngine.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

interface IOwnerExecute {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

/// @notice Drives smart accounts guarded by MandateModules against the wired protocol: cover
///         bound to the modules, agent breaches through the module, owner withdrawals through
///         the account, spenders pulling outside the module, and the keeper's claims. It runs
///         beside ProtocolHandler (which keeps driving the vaults, the pool and the bonds), and
///         records what each step did so the invariant test can check it afterwards.
contract ModuleHandler is CommonBase, StdCheats, StdUtils {
    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    struct Setup {
        MockERC20 usdg;
        CoverPool pool;
        OperatorBond bond;
        CoverManager manager;
        ClaimsEngine claims;
        uint256 attesterKey;
        address guardian;
        address agent;
        address attacker;
        address owner;
    }

    Setup internal s;
    MandateModule[] internal _modules;
    uint256[] internal _policies;
    uint256 internal _quoteNonce = 1_000_000; // apart from ProtocolHandler's quote nonces

    // ----- Ghost state -------------------------------------------------------------------

    mapping(uint256 agentId => uint256) public ghostSlashed;
    mapping(address module => mapping(uint256 breachId => bool)) public ghostBreachPaid;
    uint256 public ghostModuleClaims;
    uint256 public ghostDeferredRefused;

    /// @dev Set when a step breaks a property; the invariant test asserts they stay false.
    bool public payoutMissedTheAccount;
    bool public deferredPaid;
    bool public frozenAgentActed;
    bool public ownerWithdrawalWasABreach;
    bool public breachPaidTwice;
    bool public poolPaidBeforeBondWasEmpty;
    bool public payoutAboveLossMinusDeductible;
    bool public waterfallDoesNotAddUp;

    constructor(Setup memory setup, MandateModule[] memory modules_) {
        s = setup;
        _modules = modules_;
    }

    // ----- Operators ---------------------------------------------------------------------

    function bindCover(uint256 moduleSeed, uint256 cover, uint256 score, uint256 rateBps) external {
        MandateModule m = _module(moduleSeed);
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: m.agentId(),
            vault: address(m),
            coverAmount: bound(cover, 1000e6, 1000e6 + s.pool.totalAssets() / 10),
            // forge-lint: disable-next-line(unsafe-typecast)
            premiumRateBps: uint32(bound(rateBps, 50, 2000)),
            // forge-lint: disable-next-line(unsafe-typecast)
            score: uint16(bound(score, 45, 100)),
            modelFamily: 1,
            mandateHash: m.mandateHash(),
            reportHash: keccak256("arena report"),
            minBond: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: ++_quoteNonce
        });
        (uint8 sv, bytes32 r, bytes32 ss) = vm.sign(s.attesterKey, s.manager.quoteDigest(q));
        vm.prank(s.guardian);
        try s.manager.buyCover(q, abi.encodePacked(r, ss, sv)) returns (uint256 policyId) {
            _policies.push(policyId);
            vm.warp(block.timestamp + s.manager.waitingPeriod());
        } catch {}
    }

    function unfreeze(uint256 moduleSeed) external {
        vm.prank(s.guardian);
        _module(moduleSeed).unfreeze();
    }

    // ----- Account owners, agents and spenders -------------------------------------------

    /// @dev Money arriving in the account (the module equivalent of a vault deposit).
    function fund(uint256 moduleSeed, uint256 amount) external {
        s.usdg.mint(_module(moduleSeed).account(), bound(amount, 1e6, 100_000e6));
    }

    /// @dev The owner withdraws through the account's ERC-7579 execute; the hook accepts it.
    function ownerWithdraw(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        address account = m.account();
        uint256 balance = s.usdg.balanceOf(account);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        // Anything already missing is recorded first; only then is the withdrawal checked.
        m.reconcile();
        uint256 breaches = m.breachCount();
        bytes memory transfer = abi.encodeCall(IERC20.transfer, (s.owner, amount));
        vm.prank(ENTRY_POINT);
        IOwnerExecute(account)
            .execute(bytes32(0), abi.encodePacked(address(s.usdg), uint256(0), transfer));
        m.reconcile();
        if (m.breachCount() != breaches) ownerWithdrawalWasABreach = true;
    }

    /// @dev The agent sends funds to an address outside the mandate: a T1 breach (Monitor mode).
    function breach(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _unfrozen(moduleSeed);
        uint256 balance = s.usdg.balanceOf(m.account());
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(s.agent);
        m.execute(address(s.usdg), abi.encodeCall(IERC20.transfer, (s.attacker, amount)));
    }

    /// @dev The agent approves the attacker (T1), the attacker pulls outside the module, and
    ///      anyone reconciles: a Deferred breach that ClaimsEngine must refuse to pay.
    function spenderPull(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _unfrozen(moduleSeed);
        address account = m.account();
        uint256 balance = s.usdg.balanceOf(account);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(s.agent);
        m.execute(address(s.usdg), abi.encodeCall(IERC20.approve, (s.attacker, amount)));
        vm.prank(s.attacker);
        require(s.usdg.transferFrom(account, s.attacker, amount), "pull failed");
        m.reconcile();
    }

    /// @dev A frozen agent must not move anything.
    function frozenAgentTries(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        if (!m.frozen()) return;
        uint256 before = s.usdg.balanceOf(s.attacker);
        bytes memory transfer =
            abi.encodeCall(IERC20.transfer, (s.attacker, bound(amount, 1, 1_000_000e6)));
        vm.prank(s.agent);
        try m.execute(address(s.usdg), transfer) {} catch {}
        if (s.usdg.balanceOf(s.attacker) != before) frozenAgentActed = true;
    }

    function accrue(uint256 policySeed) external {
        if (_policies.length == 0) return;
        s.manager.accrue(_policies[bound(policySeed, 0, _policies.length - 1)]);
    }

    // ----- Keeper ------------------------------------------------------------------------

    /// @dev Files a claim for a module policy and checks the money lands in the account.
    function fileClaim(uint256 policySeed, uint256 breachSeed) external {
        if (_policies.length == 0) return;
        uint256 policyId = _policies[bound(policySeed, 0, _policies.length - 1)];
        ICoverManager.Policy memory policy = s.manager.getPolicy(policyId);
        MandateModule m = MandateModule(policy.vault);
        uint256 count = m.breachCount();
        if (count == 0) return;
        uint256 breachId = breachSeed % 2 == 0 ? count - 1 : bound(breachSeed, 0, count - 1);
        bool isDeferred = m.getBreach(breachId).breachType == BondedTypes.BreachType.Deferred;

        address account = m.account();
        // Bring premiums up to date first, so the claim's own accrual moves nothing.
        try s.manager.accrue(policyId) {} catch {}
        uint256 accountBefore = s.usdg.balanceOf(account);
        uint256 bondBefore = s.bond.bondOf(policy.agentId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = breachId;
        vm.recordLogs();
        try s.claims.fileClaim(policyId, ids) returns (uint256 paid) {
            if (ghostBreachPaid[address(m)][breachId]) breachPaidTwice = true;
            ghostBreachPaid[address(m)][breachId] = true;
            _checkPayout(policy.agentId, bondBefore, paid, vm.getRecordedLogs());
            if (s.usdg.balanceOf(account) != accountBefore + paid) payoutMissedTheAccount = true;
            if (isDeferred) deferredPaid = true;
            ++ghostModuleClaims;
        } catch {
            if (isDeferred) ++ghostDeferredRefused;
        }
    }

    // ----- Views for the invariant test --------------------------------------------------

    function modules() external view returns (MandateModule[] memory) {
        return _modules;
    }

    function policies() external view returns (uint256[] memory) {
        return _policies;
    }

    // ----- Internals ---------------------------------------------------------------------

    /// @dev Same checks as ProtocolHandler._checkPayout, for module claims.
    function _checkPayout(uint256 agentId, uint256 bondBefore, uint256 paid, Vm.Log[] memory logs)
        internal
    {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(s.claims)
                    || logs[i].topics[0] != ClaimsEngine.ClaimPaid.selector
            ) continue;
            (uint256 lossBase, uint256 gross, uint256 netted, uint256 fromBond, uint256 fromPool,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256[]));
            uint256 cap = lossBase * (BondedTypes.BPS - s.claims.deductibleBps()) / BondedTypes.BPS;
            if (gross > cap) payoutAboveLossMinusDeductible = true;
            if (fromBond + fromPool + netted != gross || fromBond + fromPool != paid) {
                waterfallDoesNotAddUp = true;
            }
            if (fromBond > bondBefore) waterfallDoesNotAddUp = true;
            if (fromPool > 0 && s.bond.bondOf(agentId) != 0) poolPaidBeforeBondWasEmpty = true;
            ghostSlashed[agentId] += fromBond;
        }
    }

    function _unfrozen(uint256 seed) internal returns (MandateModule m) {
        m = _module(seed);
        if (m.frozen()) {
            vm.prank(s.guardian);
            m.unfreeze();
        }
    }

    function _module(uint256 seed) internal view returns (MandateModule) {
        return _modules[bound(seed, 0, _modules.length - 1)];
    }
}

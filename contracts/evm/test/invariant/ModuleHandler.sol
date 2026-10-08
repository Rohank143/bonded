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
import {DisputeModule} from "../../src/DisputeModule.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

interface IOwnerExecute {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        payable;
}

/// @notice Drives smart accounts guarded by MandateModules against the wired protocol: cover
///         bound to the (Enforce-mode) modules and refused for a Monitor-mode one, agent breaches
///         through the module, owner withdrawals through the account, an allowed spender pulling
///         outside the module, premiums from an account that never really pays, an attempt to
///         install a second module, disputes, and the keeper's claims. It runs
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
        MockRouter router;
        address tsla;
        DisputeModule disputes;
        address council;
        /// @dev Monitor-mode module: may exist, may never hold cover.
        MandateModule monitorModule;
        /// @dev An older module of the first account, created before its current one.
        MandateModule staleModule;
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
    bool public monitorModuleInsured;
    bool public accrualReverted;
    bool public twoModulesInstalled;
    bool public moduleDisputeAutoPaid;
    uint256 public ghostDisputesPaid;
    uint256[] internal _disputes;

    constructor(Setup memory setup, MandateModule[] memory modules_) {
        s = setup;
        _modules = modules_;
    }

    // ----- Operators ---------------------------------------------------------------------

    function bindCover(uint256 moduleSeed, uint256 cover, uint256 score, uint256 rateBps) external {
        if (_bind(_module(moduleSeed), cover, score, rateBps)) {
            vm.warp(block.timestamp + s.manager.waitingPeriod());
        }
    }

    /// @dev A Monitor-mode module must never get cover.
    function bindMonitorCover(uint256 cover, uint256 score, uint256 rateBps) external {
        if (_bind(s.monitorModule, cover, score, rateBps)) monitorModuleInsured = true;
    }

    /// @dev Installing the account's older module next to its current one must fail.
    function installStale() external {
        address account = s.staleModule.account();
        vm.prank(ENTRY_POINT);
        try IOwnerExecute(account).installModule(2, address(s.staleModule), "") {
            twoModulesInstalled = true;
        } catch {}
    }

    function _bind(MandateModule m, uint256 cover, uint256 score, uint256 rateBps)
        internal
        returns (bool ok)
    {
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
            ok = true;
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

    /// @dev The allowed router abuses the account's allowance outside the module, and anyone
    ///      reconciles: a Deferred breach that ClaimsEngine must refuse to pay.
    function routerDrain(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        address account = m.account();
        uint256 balance = s.usdg.balanceOf(account);
        uint256 allowed = s.usdg.allowance(account, address(s.router));
        if (balance == 0 || allowed == 0) return;
        amount = bound(amount, 1, balance < allowed ? balance : allowed);
        s.router.drain(address(s.usdg), account, s.attacker, amount);
        m.reconcile();
        // The keeper tries to claim it straight away; it must be refused.
        uint256 policyId = s.manager.activePolicyOf(address(m));
        if (policyId != 0) _fileClaim(policyId, m.breachCount() - 1);
    }

    /// @dev A frozen agent must not move anything.
    function frozenAgentTries(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        if (!m.frozen()) return;
        address account = m.account();
        uint256 before = s.usdg.balanceOf(account);
        // An action the mandate allows (a small swap into the account): only the freeze stops it.
        bytes memory swap = abi.encodeCall(
            MockRouter.swap, (address(s.usdg), s.tsla, bound(amount, 1e6, 1000e6), account)
        );
        vm.prank(s.agent);
        try m.execute(address(s.router), swap) {} catch {}
        if (s.usdg.balanceOf(account) != before) frozenAgentActed = true;
    }

    /// @dev Premium collection must never get stuck, whatever the account does.
    function accrue(uint256 policySeed) external {
        if (_policies.length == 0) return;
        try s.manager.accrue(_policies[bound(policySeed, 0, _policies.length - 1)]) {}
        catch {
            accrualReverted = true;
        }
    }

    // ----- Disputes ----------------------------------------------------------------------

    function proposeDispute(uint256 policySeed, uint256 loss) external {
        if (_policies.length == 0) return;
        uint256 policyId = _policies[bound(policySeed, 0, _policies.length - 1)];
        _disputes.push(s.disputes.propose(policyId, bound(loss, 1e6, 20_000e6), bytes32(0), ""));
    }

    /// @dev Nobody may finalize an unchallenged dispute on a module's policy.
    function finalizeDispute(uint256 disputeSeed) external {
        if (_disputes.length == 0) return;
        uint256 id = _disputes[bound(disputeSeed, 0, _disputes.length - 1)];
        vm.warp(block.timestamp + s.disputes.challengePeriod());
        try s.disputes.finalize(id) {
            moduleDisputeAutoPaid = true;
        } catch {}
    }

    /// @dev The council approves a dispute; the payout must land in the account.
    function councilApproves(uint256 disputeSeed) external {
        if (_disputes.length == 0) return;
        uint256 id = _disputes[bound(disputeSeed, 0, _disputes.length - 1)];
        DisputeModule.Dispute memory d = s.disputes.getDispute(id);
        ICoverManager.Policy memory policy = s.manager.getPolicy(d.policyId);
        address account = MandateModule(policy.vault).account();
        vm.warp(block.timestamp + s.disputes.challengePeriod());
        try s.manager.accrue(d.policyId) {} catch {}
        uint256 accountBefore = s.usdg.balanceOf(account);
        uint256 bondBefore = s.bond.bondOf(policy.agentId);
        vm.recordLogs();
        vm.prank(s.council);
        try s.disputes.resolve(id, true) returns (uint256 paid) {
            _checkPayout(policy.agentId, bondBefore, paid, vm.getRecordedLogs());
            if (s.usdg.balanceOf(account) != accountBefore + paid) payoutMissedTheAccount = true;
            ++ghostDisputesPaid;
        } catch {}
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
        _fileClaim(policyId, breachSeed % 2 == 0 ? count - 1 : bound(breachSeed, 0, count - 1));
    }

    /// @dev The keeper's claim for one breach; checks the money lands in the account.
    function _fileClaim(uint256 policyId, uint256 breachId) internal {
        ICoverManager.Policy memory policy = s.manager.getPolicy(policyId);
        MandateModule m = MandateModule(policy.vault);
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

    function monitorModule() external view returns (MandateModule) {
        return s.monitorModule;
    }

    function staleModule() external view returns (MandateModule) {
        return s.staleModule;
    }

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

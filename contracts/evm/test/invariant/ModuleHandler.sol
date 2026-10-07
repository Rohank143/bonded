// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {ClaimsEngine} from "../../src/ClaimsEngine.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {ProtocolHandler} from "./ProtocolHandler.sol";

interface IOwnerExecute {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
}

/// @notice ProtocolHandler plus smart accounts guarded by MandateModules: cover bound to the
///         modules, agent breaches through the module, owner withdrawals through the account,
///         spenders pulling outside the module, and claims. The vault actions keep running, and
///         module policies join the same policy list, so the inherited accrual and claim steps
///         also act on them.
contract ModuleHandler is ProtocolHandler {
    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    MandateModule[] internal _modules;
    uint256[] internal _modulePolicies;
    address internal owner;

    /// @dev Set when a step breaks a property; the invariant test asserts they stay false.
    bool public payoutMissedTheAccount;
    bool public frozenAgentActed;
    bool public ownerWithdrawalWasABreach;
    /// @dev Set if a Deferred breach on a module was ever paid.
    bool public ghostDeferredPaid;
    uint256 public ghostModuleClaims;
    uint256 public ghostDeferredRefused;

    constructor(
        MockERC20 usdg_,
        CoverPool pool_,
        OperatorBond bond_,
        CoverManager manager_,
        ClaimsEngine claims_,
        uint256 attesterKey_,
        address guardian_,
        address agent_,
        address attacker_,
        MandateVault[] memory vaults_,
        address[] memory underwriters_
    )
        ProtocolHandler(
            usdg_,
            pool_,
            bond_,
            manager_,
            claims_,
            attesterKey_,
            guardian_,
            agent_,
            attacker_,
            vaults_,
            underwriters_
        )
    {}

    /// @notice Setup only (not a fuzzed action): the modules and their accounts' owner.
    function setModules(MandateModule[] memory modules_, address owner_) external {
        require(_modules.length == 0, "modules already set");
        _modules = modules_;
        owner = owner_;
    }

    // ----- Operators ---------------------------------------------------------------------

    function moduleStake(uint256 moduleSeed, uint256 amount) external {
        uint256 id = _module(moduleSeed).agentId();
        amount = bound(amount, 1e6, 10_000e6);
        usdg.mint(guardian, amount);
        vm.startPrank(guardian);
        usdg.approve(address(bond), amount);
        bond.stake(id, amount);
        vm.stopPrank();
        ghostStaked[id] += amount;
    }

    function moduleBindCover(uint256 moduleSeed, uint256 cover, uint256 score, uint256 rateBps)
        external
    {
        MandateModule m = _module(moduleSeed);
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: m.agentId(),
            vault: address(m),
            coverAmount: bound(cover, 1000e6, 1000e6 + pool.totalAssets() / 10),
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
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(attesterKey, manager.quoteDigest(q));
        vm.prank(guardian);
        try manager.buyCover(q, abi.encodePacked(r, s, sv)) returns (uint256 policyId) {
            _policies.push(policyId);
            _modulePolicies.push(policyId);
            vm.warp(block.timestamp + manager.waitingPeriod());
        } catch {}
    }

    function moduleUnfreeze(uint256 moduleSeed) external {
        vm.prank(guardian);
        _module(moduleSeed).unfreeze();
    }

    // ----- Account owners, agents and spenders -------------------------------------------

    /// @dev Money arriving in the account (the module equivalent of a vault deposit).
    function moduleFund(uint256 moduleSeed, uint256 amount) external {
        usdg.mint(_module(moduleSeed).account(), bound(amount, 1e6, 100_000e6));
    }

    /// @dev The owner withdraws through the account's ERC-7579 execute; the hook accepts it.
    function moduleOwnerWithdraw(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        address account = m.account();
        uint256 balance = usdg.balanceOf(account);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        // Anything already missing is recorded first; only then is the withdrawal checked.
        m.reconcile();
        uint256 breaches = m.breachCount();
        vm.prank(ENTRY_POINT);
        IOwnerExecute(account)
            .execute(
                bytes32(0),
                abi.encodePacked(
                    address(usdg), uint256(0), abi.encodeCall(IERC20.transfer, (owner, amount))
                )
            );
        m.reconcile();
        if (m.breachCount() != breaches) ownerWithdrawalWasABreach = true;
    }

    /// @dev The agent sends funds to an address outside the mandate: a T1 breach (Monitor mode).
    function moduleBreach(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        if (m.frozen()) {
            vm.prank(guardian);
            m.unfreeze();
        }
        uint256 balance = usdg.balanceOf(m.account());
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(agent);
        m.execute(address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
    }

    /// @dev The agent approves the attacker (T1), the attacker pulls outside the module, and
    ///      anyone reconciles: a Deferred breach that ClaimsEngine must refuse to pay.
    function moduleSpenderPull(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        address account = m.account();
        uint256 balance = usdg.balanceOf(account);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        if (m.frozen()) {
            vm.prank(guardian);
            m.unfreeze();
        }
        vm.prank(agent);
        m.execute(address(usdg), abi.encodeCall(IERC20.approve, (attacker, amount)));
        vm.prank(attacker);
        require(usdg.transferFrom(account, attacker, amount), "pull failed");
        m.reconcile();
    }

    /// @dev A frozen agent must not get anything through.
    function moduleFrozenAgentTries(uint256 moduleSeed, uint256 amount) external {
        MandateModule m = _module(moduleSeed);
        if (!m.frozen()) return;
        amount = bound(amount, 1, 1_000_000e6);
        uint256 before = usdg.balanceOf(attacker);
        vm.prank(agent);
        try m.execute(address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount))) {}
            catch {}
        if (usdg.balanceOf(attacker) != before) frozenAgentActed = true;
    }

    // ----- Keeper ------------------------------------------------------------------------

    /// @dev Files a claim for a module policy and checks the money lands in the account.
    function moduleFileClaim(uint256 policySeed, uint256 breachSeed) external {
        if (_modulePolicies.length == 0) return;
        uint256 policyId = _modulePolicies[bound(policySeed, 0, _modulePolicies.length - 1)];
        ICoverManager.Policy memory policy = manager.getPolicy(policyId);
        MandateModule m = MandateModule(policy.vault);
        uint256 count = m.breachCount();
        if (count == 0) return;
        uint256 breachId = breachSeed % 2 == 0 ? count - 1 : bound(breachSeed, 0, count - 1);
        BondedTypes.BreachType breachType = m.getBreach(breachId).breachType;

        address account = m.account();
        uint256 accountBefore = usdg.balanceOf(account);
        uint256 bondBefore = bond.bondOf(policy.agentId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = breachId;
        vm.recordLogs();
        try claims.fileClaim(policyId, ids) returns (uint256 paid) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (ghostBreachPaid[address(m)][breachId]) breachPaidTwice = true;
            ghostBreachPaid[address(m)][breachId] = true;
            _checkPayout(policy.agentId, bondBefore, paid, logs);
            // Premium collected during the claim's accrual left the account; the payout came in.
            uint256 premium = _premiumPaid(logs, policyId);
            if (usdg.balanceOf(account) + premium != accountBefore + paid) {
                payoutMissedTheAccount = true;
            }
            if (breachType == BondedTypes.BreachType.Deferred) ghostDeferredPaid = true;
            ++ghostModuleClaims;
        } catch {
            if (breachType == BondedTypes.BreachType.Deferred) ++ghostDeferredRefused;
        }
    }

    // ----- Views for the invariant test --------------------------------------------------

    function modules() external view returns (MandateModule[] memory) {
        return _modules;
    }

    // ----- Internals ---------------------------------------------------------------------

    function _premiumPaid(Vm.Log[] memory logs, uint256 policyId)
        internal
        view
        returns (uint256 amount)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(manager)
                    && logs[i].topics[0] == CoverManager.PremiumPaid.selector
                    && uint256(logs[i].topics[1]) == policyId
            ) {
                (uint256 paid,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                amount += paid;
            }
        }
    }

    function _module(uint256 seed) internal view returns (MandateModule) {
        return _modules[bound(seed, 0, _modules.length - 1)];
    }
}

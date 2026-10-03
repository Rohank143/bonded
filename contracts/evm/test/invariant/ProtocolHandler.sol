// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {CoverPool} from "../../src/CoverPool.sol";
import {OperatorBond} from "../../src/OperatorBond.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {ClaimsEngine} from "../../src/ClaimsEngine.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Drives underwriters, operators, agents and the keeper against the wired protocol, and
///         records what each step did so the invariant test can check it afterwards.
/// @dev Every action is bounded to inputs the protocol could see in practice; actions the protocol
///      rejects are skipped (try/catch), so the run keeps going.
contract ProtocolHandler is CommonBase, StdCheats, StdUtils {
    MockERC20 internal immutable usdg;
    CoverPool internal immutable pool;
    OperatorBond internal immutable bond;
    CoverManager internal immutable manager;
    ClaimsEngine internal immutable claims;
    uint256 internal immutable attesterKey;
    address internal immutable guardian;
    address internal immutable agent;
    address internal immutable attacker;

    MandateVault[] internal _vaults;
    address[] internal _underwriters;
    uint256[] internal _policies;
    uint256 internal _quoteNonce;

    // ----- Ghost state -------------------------------------------------------------------

    mapping(uint256 agentId => uint256) public ghostStaked;
    mapping(uint256 agentId => uint256) public ghostWithdrawn;
    mapping(uint256 agentId => uint256) public ghostSlashed;
    mapping(address vault => mapping(uint256 breachId => bool)) public ghostBreachPaid;
    uint256 public ghostPoolPaid;
    uint256 public ghostClaims;
    uint256 public ghostRedeems;
    uint256 public ghostExitsLimitedByLock;

    /// @dev Set when a step breaks a property; the invariant test asserts they stay false.
    bool public redeemedLockedCapital;
    bool public poolPaidBeforeBondWasEmpty;
    bool public payoutAboveLossMinusDeductible;
    bool public waterfallDoesNotAddUp;
    bool public breachPaidTwice;

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
    ) {
        usdg = usdg_;
        pool = pool_;
        bond = bond_;
        manager = manager_;
        claims = claims_;
        attesterKey = attesterKey_;
        guardian = guardian_;
        agent = agent_;
        attacker = attacker_;
        _vaults = vaults_;
        _underwriters = underwriters_;
    }

    /// @notice Records a stake made during setup. Not a fuzzed action.
    function recordStake(uint256 agentId, uint256 amount) external {
        ghostStaked[agentId] += amount;
    }

    // ----- Underwriters ------------------------------------------------------------------

    function poolDeposit(uint256 actorSeed, uint256 amount) external {
        address who = _underwriter(actorSeed);
        amount = bound(amount, 1e6, 200_000e6);
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        pool.deposit(amount, who);
        vm.stopPrank();
    }

    function poolRequestRedeem(uint256 actorSeed, uint256 shares) external {
        address who = _underwriter(actorSeed);
        uint256 balance = pool.balanceOf(who);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        vm.prank(who);
        pool.requestRedeem(shares);
    }

    function poolRedeem(uint256 actorSeed, uint256 shares) external {
        address who = _underwriter(actorSeed);
        uint256 max = pool.maxRedeem(who);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        uint256 free = pool.freeCapital();
        vm.prank(who);
        uint256 assets = pool.redeem(shares, who, who);
        if (assets > free) redeemedLockedCapital = true;
        ++ghostRedeems;
    }

    /// @dev Request, wait out the cooldown, then redeem: the full exit path in one step.
    function poolExit(uint256 actorSeed, uint256 shares) external {
        address who = _underwriter(actorSeed);
        uint256 balance = pool.balanceOf(who);
        if (balance == 0) return;
        shares = bound(shares, 1, balance);
        vm.prank(who);
        pool.requestRedeem(shares);
        vm.warp(block.timestamp + pool.cooldown());
        uint256 max = pool.maxRedeem(who);
        if (max < shares) ++ghostExitsLimitedByLock;
        if (max == 0) return;
        uint256 free = pool.freeCapital();
        vm.prank(who);
        uint256 assets = pool.redeem(max, who, who);
        if (assets > free) redeemedLockedCapital = true;
        ++ghostRedeems;
    }

    function poolWithdraw(uint256 actorSeed, uint256 assets) external {
        address who = _underwriter(actorSeed);
        uint256 max = pool.maxWithdraw(who);
        if (max == 0) return;
        assets = bound(assets, 1, max);
        uint256 free = pool.freeCapital();
        vm.prank(who);
        pool.withdraw(assets, who, who);
        if (assets > free) redeemedLockedCapital = true;
        ++ghostRedeems;
    }

    // ----- Operators ---------------------------------------------------------------------

    function stake(uint256 vaultSeed, uint256 amount) external {
        uint256 id = _vault(vaultSeed).agentId();
        amount = bound(amount, 1e6, 10_000e6);
        usdg.mint(guardian, amount);
        vm.startPrank(guardian);
        usdg.approve(address(bond), amount);
        bond.stake(id, amount);
        vm.stopPrank();
        ghostStaked[id] += amount;
    }

    function bondRequestWithdraw(uint256 vaultSeed, uint256 amount) external {
        uint256 id = _vault(vaultSeed).agentId();
        uint256 bonded = bond.bondOf(id);
        if (bonded == 0) return;
        amount = bound(amount, 1, bonded);
        vm.prank(guardian);
        bond.requestWithdraw(id, amount);
    }

    function bondWithdraw(uint256 vaultSeed) external {
        uint256 id = _vault(vaultSeed).agentId();
        uint256 before = usdg.balanceOf(guardian);
        vm.prank(guardian);
        try bond.withdraw(id) {
            ghostWithdrawn[id] += usdg.balanceOf(guardian) - before;
        } catch {}
    }

    function bindCover(uint256 vaultSeed, uint256 cover, uint256 score, uint256 rateBps) external {
        MandateVault v = _vault(vaultSeed);
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: v.agentId(),
            vault: address(v),
            coverAmount: bound(cover, 1000e6, 1000e6 + pool.totalAssets() / 10),
            // forge-lint: disable-next-line(unsafe-typecast)
            premiumRateBps: uint32(bound(rateBps, 50, 2000)),
            // forge-lint: disable-next-line(unsafe-typecast)
            score: uint16(bound(score, 45, 100)),
            modelFamily: 1,
            mandateHash: v.mandateHash(),
            reportHash: keccak256("arena report"),
            minBond: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: ++_quoteNonce
        });
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(attesterKey, manager.quoteDigest(q));
        vm.prank(guardian);
        try manager.buyCover(q, abi.encodePacked(r, s, sv)) returns (uint256 policyId) {
            _policies.push(policyId);
            vm.warp(block.timestamp + manager.waitingPeriod()); // coverage starts
        } catch {}
    }

    function unfreeze(uint256 vaultSeed) external {
        vm.prank(guardian);
        _vault(vaultSeed).unfreeze();
    }

    // ----- Depositors, agents and the keeper ---------------------------------------------

    function vaultDeposit(uint256 vaultSeed, uint256 amount) external {
        MandateVault v = _vault(vaultSeed);
        amount = bound(amount, 1e6, 100_000e6);
        address depositor = address(0xD0);
        usdg.mint(depositor, amount);
        vm.startPrank(depositor);
        usdg.approve(address(v), amount);
        v.deposit(amount, depositor);
        vm.stopPrank();
    }

    /// @dev The agent sends funds to an address outside the mandate: a T1 breach (Monitor mode).
    function breach(uint256 vaultSeed, uint256 amount) external {
        MandateVault v = _vault(vaultSeed);
        if (v.frozen()) {
            vm.prank(guardian);
            v.unfreeze();
        }
        uint256 balance = usdg.balanceOf(address(v));
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(agent);
        v.execute(address(usdg), abi.encodeCall(IERC20.transfer, (attacker, amount)));
    }

    function accrue(uint256 policySeed) external {
        if (_policies.length == 0) return;
        manager.accrue(_policies[bound(policySeed, 0, _policies.length - 1)]);
    }

    /// @dev Governance moves the leverage limit; a low limit locks most of the pool.
    function setLeverage(uint256 leverageBps) external {
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 leverage = uint32(bound(leverageBps, 1000, 50_000));
        uint16 agentCap = manager.maxAgentCoverBps();
        uint16 familyCap = manager.modelFamilyCapBps();
        vm.prank(manager.owner());
        manager.setRiskParams(leverage, agentCap, familyCap);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 10 days));
    }

    function fileClaim(uint256 policySeed, uint256 breachSeed, bool twice) external {
        if (_policies.length == 0) return;
        uint256 policyId = _policies[bound(policySeed, 0, _policies.length - 1)];
        ICoverManager.Policy memory policy = manager.getPolicy(policyId);
        MandateVault v = MandateVault(policy.vault);
        uint256 count = v.breachCount();
        if (count == 0) return;
        // Mostly the newest breach (what the keeper files); otherwise any, to retry paid ones.
        uint256 breachId = breachSeed % 2 == 0 ? count - 1 : bound(breachSeed, 0, count - 1);
        // `twice` lists the same breach twice in one claim, which must never pay double.
        uint256[] memory ids = new uint256[](twice ? 2 : 1);
        ids[0] = breachId;
        if (twice) ids[1] = breachId;

        uint256 bondBefore = bond.bondOf(policy.agentId);
        vm.recordLogs();
        try claims.fileClaim(policyId, ids) returns (uint256 paid) {
            if (ghostBreachPaid[address(v)][breachId] || twice) breachPaidTwice = true;
            ghostBreachPaid[address(v)][breachId] = true;
            _checkPayout(policy.agentId, bondBefore, paid, vm.getRecordedLogs());
            ++ghostClaims;
        } catch {}
    }

    // ----- Views for the invariant test --------------------------------------------------

    function vaults() external view returns (MandateVault[] memory) {
        return _vaults;
    }

    function underwriters() external view returns (address[] memory) {
        return _underwriters;
    }

    function policies() external view returns (uint256[] memory) {
        return _policies;
    }

    // ----- Internals ---------------------------------------------------------------------

    function _checkPayout(uint256 agentId, uint256 bondBefore, uint256 paid, Vm.Log[] memory logs)
        internal
    {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(claims)
                    || logs[i].topics[0] != ClaimsEngine.ClaimPaid.selector
            ) continue;
            (uint256 lossBase, uint256 gross, uint256 netted, uint256 fromBond, uint256 fromPool,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256[]));

            uint256 cap = lossBase * (BondedTypes.BPS - claims.deductibleBps()) / BondedTypes.BPS;
            if (gross > cap) payoutAboveLossMinusDeductible = true;
            if (fromBond + fromPool + netted != gross || fromBond + fromPool != paid) {
                waterfallDoesNotAddUp = true;
            }
            if (fromBond > bondBefore) waterfallDoesNotAddUp = true;
            // The pool only pays what the bond couldn't: the bond must be empty afterwards.
            if (fromPool > 0 && bond.bondOf(agentId) != 0) poolPaidBeforeBondWasEmpty = true;
            ghostSlashed[agentId] += fromBond;
            ghostPoolPaid += fromPool;
        }
    }

    function _vault(uint256 seed) internal view returns (MandateVault) {
        return _vaults[bound(seed, 0, _vaults.length - 1)];
    }

    function _underwriter(uint256 seed) internal view returns (address) {
        return _underwriters[bound(seed, 0, _underwriters.length - 1)];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMandateVaultFactory} from "./interfaces/IMandateVaultFactory.sol";

/// @title MandateVault
/// @notice Holds an AI agent's funds and checks every action against the agent's mandate.
///         Depositors hold ERC-4626 shares. The agent acts only through `execute`.
/// @dev See docs/PLAN.md Section 6.3 and docs/decisions/002-mandate-vault.md.
///
///      Breach detection:
///      - T1 (before the call): target, selector, approval spender and transfer recipient are
///        checked against the mandate.
///      - T3 and T2 (after the call): balances of all allowed assets are compared before and
///        after, priced by the oracle. A net loss above `maxSlippageBps` of the outflow is T3.
///        An outflow above the per-action or 24h limit is T2.
///      - Deferred T1: `reconcile` catches balance drops that happened outside `execute`
///        (e.g. a spender pulling funds through an unauthorized approval).
///      Each action records at most one breach (precedence T1 > T3 > T2), so a loss is never
///      counted twice.
///
///      Monitor mode executes the action and records the breach. Enforce mode stops the action:
///      pre-call breaches skip the call, post-call breaches are rolled back by running the call
///      in a self-call that reverts. Either way the attempt is recorded and the agent frozen.
contract MandateVault is ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev Result of checking an action against the mandate before it runs.
    struct Verdict {
        bool allowed;
        bool leakCheck; // false for transfers to allowed destinations: value leaving is expected
        BondedTypes.BreachType breachType; // meaningful only when !allowed
        bytes4 selector;
    }

    struct Breach {
        BondedTypes.BreachType breachType;
        bool blocked; // Enforce mode stopped the action; nothing was lost
        bool claimed; // set by ClaimsEngine once paid
        address target;
        bytes4 selector;
        uint64 timestamp;
        uint256 lossUsd6;
    }

    uint256 public constant MAX_ASSETS = 16;
    uint256 public constant MAX_TARGETS = 32;
    uint256 public constant WINDOW = 1 days;

    bytes4 private constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant INCREASE_ALLOWANCE = 0x39509351; // increaseAllowance(address,uint256)
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465; // setApprovalForAll(address,bool)
    bytes4 private constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 private constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    IMandateVaultFactory public immutable factory;
    IPriceOracle public immutable oracle;
    uint256 public immutable agentId;
    bytes32 public immutable mandateHash;
    BondedTypes.MandateMode public immutable mode;
    bool public immutable freezeOnBreach;
    uint256 public immutable maxTxNotionalUsd6;
    uint256 public immutable maxDailyNotionalUsd6;
    uint16 public immutable maxDrawdownBps;
    uint16 public immutable maxSlippageBps;
    /// @notice Can freeze, unfreeze and rotate the agent key. Cannot move funds.
    address public immutable guardian;

    /// @notice The agent's session key: the only address allowed to call `execute`.
    address public agent;
    bool public frozen;

    address[] private _assets;
    mapping(address token => bool) public isAsset;
    mapping(address target => bool) public isTarget;
    mapping(address target => bool) private _anySelector;
    mapping(address target => mapping(bytes4 selector => bool)) private _selectorAllowed;
    mapping(address recipient => bool) public isDestination;

    /// @notice Balances as of the vault's last accounted action; drops beyond these are breaches.
    mapping(address token => uint256) public recordedBalance;

    /// @notice Start of the current 24h notional window and the outflow counted in it.
    uint256 public windowStart;
    uint256 public windowNotionalUsd6;

    Breach[] private _breaches;

    event Executed(
        address indexed target, bytes4 indexed selector, uint256 outflowUsd6, uint256 inflowUsd6
    );
    event BreachRecorded(
        uint256 indexed breachId,
        BondedTypes.BreachType indexed breachType,
        address indexed target,
        bytes4 selector,
        uint256 lossUsd6,
        bool blocked
    );
    event BreachClaimed(uint256 indexed breachId);
    event Frozen(address indexed by);
    event Unfrozen(address indexed by);
    event AgentRotated(address indexed previousAgent, address indexed newAgent);

    error ZeroAddress();
    error InvalidParams(string reason);
    error NotAgent();
    error NotGuardian();
    error NotCoverManager();
    error NotClaimsEngine();
    error AgentFrozen();
    error CannotCallVault();
    error OnlySelf();
    error UnknownBreach(uint256 breachId);
    error BreachAlreadyClaimed(uint256 breachId);
    /// @dev Internal signal from `measuredCall` in Enforce mode; never escapes `execute`.
    error BreachDetected(BondedTypes.BreachType breachType, uint256 lossUsd6);
    /// @dev Internal wrapper for a failed target call; `execute` re-throws the inner revert data.
    error CallFailed(bytes revertData);

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    /// @param p Mandate parameters (see BondedTypes.MandateParams).
    /// @param agent_ The agent's session key.
    /// @param guardian_ Operator address allowed to freeze, unfreeze and rotate the agent.
    /// @param agentId_ The agent's id in BondedRegistry.
    /// @param oracle_ Price oracle for NAV and loss measurement.
    constructor(
        BondedTypes.MandateParams memory p,
        address agent_,
        address guardian_,
        uint256 agentId_,
        IPriceOracle oracle_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20(p.baseAsset)) {
        if (agent_ == address(0) || guardian_ == address(0) || address(oracle_) == address(0)) {
            revert ZeroAddress();
        }
        _validateLimits(p);

        factory = IMandateVaultFactory(msg.sender);
        oracle = oracle_;
        agentId = agentId_;
        mandateHash = p.mandateHash;
        mode = p.mode;
        freezeOnBreach = p.freezeOnBreach;
        maxTxNotionalUsd6 = p.maxTxNotionalUsd6;
        maxDailyNotionalUsd6 = p.maxDailyNotionalUsd6;
        maxDrawdownBps = p.maxDrawdownBps;
        maxSlippageBps = p.maxSlippageBps;
        guardian = guardian_;
        agent = agent_;

        _setAssets(p.baseAsset, p.assets);
        _setTargets(p.targets, p.selectors);
        _setDestinations(p.destinations);
        windowStart = block.timestamp;
    }

    // ---------------------------------------------------------------------------------------
    // Agent actions
    // ---------------------------------------------------------------------------------------

    /// @notice Runs one action for the agent and checks it against the mandate.
    /// @dev ERC-20 only: native value is not supported. Returns empty bytes when Enforce mode
    ///      blocks the action.
    function execute(address target, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory)
    {
        if (msg.sender != agent) revert NotAgent();
        if (frozen) revert AgentFrozen();
        if (target == address(this)) revert CannotCallVault();

        // A drop found here is an earlier breach; if it froze the agent, stop before acting.
        _reconcile();
        if (frozen) return "";

        Verdict memory verdict = _classify(target, data);

        if (!verdict.allowed && mode == BondedTypes.MandateMode.Enforce) {
            _recordBreach(verdict.breachType, true, target, verdict.selector, 0);
            return "";
        }

        bool enforceAfter = verdict.allowed && mode == BondedTypes.MandateMode.Enforce;
        try this.measuredCall(target, data, enforceAfter, verdict.leakCheck) returns (
            bytes memory result, uint256 outflowUsd6, uint256 inflowUsd6
        ) {
            _afterCall(verdict, target, outflowUsd6, inflowUsd6);
            return result;
        } catch (bytes memory reason) {
            // measuredCall wraps target failures in CallFailed, so a target can't fake BreachDetected.
            // truncating to the first 4 bytes is intended: that's the error selector
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes4 errorSelector = reason.length >= 4 ? bytes4(reason) : bytes4(0);
            if (errorSelector == BreachDetected.selector) {
                (BondedTypes.BreachType breachType,) = _decodeBreachDetected(reason);
                _recordBreach(breachType, true, target, verdict.selector, 0);
                return "";
            }
            if (errorSelector == CallFailed.selector) {
                // The target call itself failed: bubble up its original revert, record nothing.
                assembly ("memory-safe") {
                    let inner := add(add(reason, 0x24), mload(add(reason, 0x24)))
                    revert(add(inner, 0x20), mload(inner))
                }
            }
            // Anything else (e.g. an oracle revert while measuring): bubble up as is.
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }

    /// @notice Performs the call and measures its value flows. Callable only by the vault itself.
    /// @dev Runs inside a self-call so Enforce mode can roll back a breaching call by reverting.
    function measuredCall(address target, bytes calldata data, bool enforceAfter, bool leakCheck)
        external
        returns (bytes memory result, uint256 outflowUsd6, uint256 inflowUsd6)
    {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256[] memory before = _balances();
        bool success;
        (success, result) = target.call(data);
        // Same rule as OpenZeppelin's Address.functionCall: a call to a codeless address is a failure.
        if (!success || (result.length == 0 && target.code.length == 0)) revert CallFailed(result);
        (outflowUsd6, inflowUsd6) = _valueDelta(before, _balances());
        if (enforceAfter) {
            (bool breached, BondedTypes.BreachType breachType, uint256 lossUsd6) =
                _postCheck(outflowUsd6, inflowUsd6, leakCheck);
            if (breached) revert BreachDetected(breachType, lossUsd6);
        }
    }

    /// @notice Records any balance drop that happened outside `execute`. Anyone can call.
    function reconcile() external nonReentrant {
        _reconcile();
    }

    // ---------------------------------------------------------------------------------------
    // Guardian
    // ---------------------------------------------------------------------------------------

    function freeze() external onlyGuardian {
        frozen = true;
        emit Frozen(msg.sender);
    }

    function unfreeze() external onlyGuardian {
        frozen = false;
        emit Unfrozen(msg.sender);
    }

    function rotateAgent(address newAgent) external onlyGuardian {
        if (newAgent == address(0)) revert ZeroAddress();
        emit AgentRotated(agent, newAgent);
        agent = newAgent;
    }

    // ---------------------------------------------------------------------------------------
    // Protocol modules
    // ---------------------------------------------------------------------------------------

    /// @notice Pays `amount` of the base asset to CoverManager as premium.
    function payPremium(uint256 amount) external nonReentrant {
        address coverManager = factory.coverManager();
        if (msg.sender != coverManager || coverManager == address(0)) revert NotCoverManager();
        _reconcile();
        IERC20(asset()).safeTransfer(coverManager, amount);
        _snapshotBalances();
    }

    /// @notice Marks a breach as paid so it can't be claimed twice.
    function markBreachClaimed(uint256 breachId) external {
        address claimsEngine = factory.claimsEngine();
        if (msg.sender != claimsEngine || claimsEngine == address(0)) revert NotClaimsEngine();
        if (breachId >= _breaches.length) revert UnknownBreach(breachId);
        Breach storage breach = _breaches[breachId];
        if (breach.claimed) revert BreachAlreadyClaimed(breachId);
        breach.claimed = true;
        emit BreachClaimed(breachId);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function breachCount() external view returns (uint256) {
        return _breaches.length;
    }

    function getBreach(uint256 breachId) external view returns (Breach memory) {
        if (breachId >= _breaches.length) revert UnknownBreach(breachId);
        return _breaches[breachId];
    }

    function getAssets() external view returns (address[] memory) {
        return _assets;
    }

    /// @notice True if the mandate allows calling `selector` on `target` (ignoring token-call rules).
    function isCallAllowed(address target, bytes4 selector) external view returns (bool) {
        return isTarget[target] && (_anySelector[target] || _selectorAllowed[target][selector]);
    }

    /// @notice Outflow already counted in the current 24h window.
    function currentWindowNotionalUsd6() public view returns (uint256) {
        return block.timestamp >= windowStart + WINDOW ? 0 : windowNotionalUsd6;
    }

    /// @notice NAV in base-asset units: base balance plus other allowed assets valued by the oracle.
    function totalAssets() public view override returns (uint256) {
        address base = asset();
        uint256 otherUsd6;
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            if (token == base) continue;
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) otherUsd6 += oracle.valueInUsd6(token, balance);
        }
        uint256 baseBalance = IERC20(base).balanceOf(address(this));
        if (otherUsd6 == 0) return baseBalance;
        uint256 oneBase = 10 ** IERC20Metadata(base).decimals();
        return baseBalance + Math.mulDiv(otherUsd6, oneBase, oracle.valueInUsd6(base, oneBase));
    }

    /// @dev Withdrawals are paid in the base asset, so they are capped by the base balance.
    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), IERC20(asset()).balanceOf(address(this)));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return
            Math.min(
                super.maxRedeem(owner), convertToShares(IERC20(asset()).balanceOf(address(this)))
            );
    }

    // ---------------------------------------------------------------------------------------
    // ERC-4626 entry points: guarded so they can't run in the middle of `execute`
    // ---------------------------------------------------------------------------------------

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.redeem(shares, receiver, owner);
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
    {
        _reconcile();
        super._deposit(caller, receiver, assets, shares);
        _snapshotBalances();
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        _reconcile();
        super._withdraw(caller, receiver, owner, assets, shares);
        _snapshotBalances();
    }

    /// @dev Virtual share offset against the ERC-4626 inflation attack.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    // ---------------------------------------------------------------------------------------
    // Internals: classification and measurement
    // ---------------------------------------------------------------------------------------

    function _classify(address target, bytes calldata data)
        internal
        view
        returns (Verdict memory v)
    {
        bytes4 selector = _selectorOf(data);
        v.selector = selector;
        v.leakCheck = true;

        if (
            selector == APPROVE || selector == INCREASE_ALLOWANCE
                || selector == SET_APPROVAL_FOR_ALL
        ) {
            v.breachType = BondedTypes.BreachType.UnauthorizedApproval;
            if (data.length < 68) return v;
            // Revoking is always allowed.
            bool revoking =
                (selector == APPROVE || selector == SET_APPROVAL_FOR_ALL) && _uintArg(data, 1) == 0;
            v.allowed = revoking || isTarget[_addressArg(data, 0)];
            return v;
        }
        if (selector == TRANSFER || selector == TRANSFER_FROM) {
            v.breachType = BondedTypes.BreachType.UnauthorizedTransfer;
            uint256 recipientArg = selector == TRANSFER ? 0 : 1;
            if (data.length < 4 + 32 * (recipientArg + 2)) return v;
            v.allowed = _isAllowedRecipient(_addressArg(data, recipientArg));
            v.leakCheck = !v.allowed; // an allowed payout is expected to leave without a return
            return v;
        }
        v.breachType = BondedTypes.BreachType.UnauthorizedTarget;
        v.allowed = isTarget[target] && (_anySelector[target] || _selectorAllowed[target][selector]);
    }

    /// @dev Records at most one breach for a completed call, then updates the window and balances.
    function _afterCall(
        Verdict memory verdict,
        address target,
        uint256 outflowUsd6,
        uint256 inflowUsd6
    ) internal {
        if (!verdict.allowed) {
            uint256 lossUsd6 = outflowUsd6 > inflowUsd6 ? outflowUsd6 - inflowUsd6 : 0;
            _recordBreach(verdict.breachType, false, target, verdict.selector, lossUsd6);
        } else {
            (bool breached, BondedTypes.BreachType postBreach, uint256 lossUsd6) =
                _postCheck(outflowUsd6, inflowUsd6, verdict.leakCheck);
            if (breached) _recordBreach(postBreach, false, target, verdict.selector, lossUsd6);
        }
        _addToWindow(outflowUsd6);
        _snapshotBalances();
        emit Executed(target, verdict.selector, outflowUsd6, inflowUsd6);
    }

    /// @dev Post-call checks, precedence T3 > T2. Uses the window before this action's outflow.
    function _postCheck(uint256 outflowUsd6, uint256 inflowUsd6, bool leakCheck)
        internal
        view
        returns (bool breached, BondedTypes.BreachType breachType, uint256 lossUsd6)
    {
        lossUsd6 = outflowUsd6 > inflowUsd6 ? outflowUsd6 - inflowUsd6 : 0;
        if (
            leakCheck && outflowUsd6 > 0
                && lossUsd6 * BondedTypes.BPS > outflowUsd6 * maxSlippageBps
        ) {
            return (true, BondedTypes.BreachType.Asset, lossUsd6);
        }
        if (
            outflowUsd6 > maxTxNotionalUsd6
                || currentWindowNotionalUsd6() + outflowUsd6 > maxDailyNotionalUsd6
        ) {
            return (true, BondedTypes.BreachType.Limit, lossUsd6);
        }
        return (false, breachType, lossUsd6);
    }

    function _reconcile() internal {
        uint256 lossUsd6;
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            uint256 recorded = recordedBalance[token];
            if (balance < recorded) lossUsd6 += oracle.valueInUsd6(token, recorded - balance);
            recordedBalance[token] = balance;
        }
        if (lossUsd6 > 0) {
            _recordBreach(BondedTypes.BreachType.Deferred, false, address(0), bytes4(0), lossUsd6);
        }
    }

    function _snapshotBalances() internal {
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            recordedBalance[token] = IERC20(token).balanceOf(address(this));
        }
    }

    function _balances() internal view returns (uint256[] memory balances) {
        balances = new uint256[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            balances[i] = IERC20(_assets[i]).balanceOf(address(this));
        }
    }

    function _valueDelta(uint256[] memory before, uint256[] memory afterwards)
        internal
        view
        returns (uint256 outflowUsd6, uint256 inflowUsd6)
    {
        for (uint256 i; i < _assets.length; ++i) {
            if (afterwards[i] < before[i]) {
                outflowUsd6 += oracle.valueInUsd6(_assets[i], before[i] - afterwards[i]);
            } else if (afterwards[i] > before[i]) {
                inflowUsd6 += oracle.valueInUsd6(_assets[i], afterwards[i] - before[i]);
            }
        }
    }

    function _addToWindow(uint256 outflowUsd6) internal {
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            windowNotionalUsd6 = 0;
        }
        windowNotionalUsd6 += outflowUsd6;
    }

    function _recordBreach(
        BondedTypes.BreachType breachType,
        bool blocked,
        address target,
        bytes4 selector,
        uint256 lossUsd6
    ) internal {
        uint256 breachId = _breaches.length;
        _breaches.push(
            Breach({
                breachType: breachType,
                blocked: blocked,
                claimed: false,
                target: target,
                selector: selector,
                timestamp: uint64(block.timestamp),
                lossUsd6: lossUsd6
            })
        );
        emit BreachRecorded(breachId, breachType, target, selector, lossUsd6, blocked);
        if (freezeOnBreach && !frozen) {
            frozen = true;
            emit Frozen(address(this));
        }
    }

    function _isAllowedRecipient(address recipient) internal view returns (bool) {
        return recipient == address(this) || isDestination[recipient];
    }

    function _selectorOf(bytes calldata data) internal pure returns (bytes4) {
        return data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
    }

    /// @dev Reads the `index`-th 32-byte argument as an address (upper bits ignored).
    function _addressArg(bytes calldata data, uint256 index) internal pure returns (address) {
        return address(uint160(_uintArg(data, index)));
    }

    function _uintArg(bytes calldata data, uint256 index) internal pure returns (uint256 value) {
        uint256 offset = 4 + index * 32;
        value = uint256(bytes32(data[offset:offset + 32]));
    }

    function _decodeBreachDetected(bytes memory reason)
        internal
        pure
        returns (BondedTypes.BreachType breachType, uint256 lossUsd6)
    {
        uint256 rawType;
        assembly ("memory-safe") {
            rawType := mload(add(reason, 0x24))
            lossUsd6 := mload(add(reason, 0x44))
        }
        breachType = BondedTypes.BreachType(rawType);
    }

    // ---------------------------------------------------------------------------------------
    // Internals: setup
    // ---------------------------------------------------------------------------------------

    function _validateLimits(BondedTypes.MandateParams memory p) internal pure {
        if (p.maxTxNotionalUsd6 == 0) revert InvalidParams("maxTxNotionalUsd6 is zero");
        if (p.maxDailyNotionalUsd6 < p.maxTxNotionalUsd6) {
            revert InvalidParams("daily limit below tx limit");
        }
        if (p.maxDrawdownBps == 0 || p.maxDrawdownBps > BondedTypes.BPS) {
            revert InvalidParams("maxDrawdownBps");
        }
        if (p.maxSlippageBps > BondedTypes.BPS) revert InvalidParams("maxSlippageBps");
    }

    function _setAssets(address base, address[] memory assets_) internal {
        if (assets_.length == 0 || assets_.length > MAX_ASSETS) {
            revert InvalidParams("asset count");
        }
        bool hasBase;
        for (uint256 i; i < assets_.length; ++i) {
            address token = assets_[i];
            if (token == address(0)) revert ZeroAddress();
            if (isAsset[token]) revert InvalidParams("duplicate asset");
            isAsset[token] = true;
            _assets.push(token);
            if (token == base) hasBase = true;
        }
        if (!hasBase) revert InvalidParams("base asset not in assets");
    }

    function _setTargets(address[] memory targets_, bytes4[][] memory selectors_) internal {
        if (targets_.length > MAX_TARGETS) revert InvalidParams("target count");
        if (targets_.length != selectors_.length) revert InvalidParams("selectors length");
        for (uint256 i; i < targets_.length; ++i) {
            address target = targets_[i];
            if (target == address(0)) revert ZeroAddress();
            if (target == address(this)) revert InvalidParams("vault as target");
            if (isTarget[target]) revert InvalidParams("duplicate target");
            isTarget[target] = true;
            if (selectors_[i].length == 0) {
                _anySelector[target] = true;
            } else {
                for (uint256 j; j < selectors_[i].length; ++j) {
                    _selectorAllowed[target][selectors_[i][j]] = true;
                }
            }
        }
    }

    function _setDestinations(address[] memory destinations_) internal {
        for (uint256 i; i < destinations_.length; ++i) {
            if (destinations_[i] == address(0)) revert ZeroAddress();
            isDestination[destinations_[i]] = true;
        }
    }
}

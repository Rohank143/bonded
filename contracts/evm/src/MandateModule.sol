// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMandateModuleFactory} from "./interfaces/IMandateModuleFactory.sol";
import {
    IERC7579Account,
    IERC7579Hook,
    MODE_SINGLE_DEFAULT,
    MODULE_TYPE_EXECUTOR,
    MODULE_TYPE_HOOK
} from "./interfaces/IERC7579.sol";
import {MandateBase} from "./MandateBase.sol";

/// @title MandateModule
/// @notice Puts an AI agent's mandate on a smart account the operator already uses (Safe through
///         Safe7579, or any ERC-7579 account). The agent's session key can act only through
///         `execute`, which runs the same checks as MandateVault (MandateBase) and makes the call
///         from the account. The account's owner keeps full control.
/// @dev One module instance guards one account (set at deployment by MandateModuleFactory), so
///      its address plays the role a vault's address plays elsewhere: it holds the breach log,
///      emits the same events, and is what CoverManager policies and ClaimsEngine claims point
///      at. Payouts go to the account.
///
///      Install it as both module types:
///      - Executor (type 2), required: `execute` calls `executeFromExecutor` on the account.
///      - Hook (type 4), recommended: before each of the owner's executions it records any
///        unexplained drop (as `reconcile` does) and afterwards it accepts the new balances, so
///        an owner withdrawal isn't mistaken for a breach. Without it, the owner can call `sync`
///        after moving funds. A Safe owner's own `execTransaction` bypasses ERC-7579 hooks, so on
///        a Safe the owner calls `sync` (or moves funds through Safe7579's `execute`).
///      Because the owner can move funds outside the module, an unexplained drop (Deferred) on a
///      module-protected account is recorded and freezes the agent but is not paid by
///      ClaimsEngine.
contract MandateModule is MandateBase, IERC7579Hook {
    IMandateModuleFactory public immutable factory;
    address private immutable _baseAsset;

    /// @notice How many module types the account currently has this module installed as.
    uint256 public installs;

    error NotAccount();
    error NotInstalled();
    error CannotCallAccount();
    error CannotCallModule();
    error PremiumTransferFailed();
    error NotCurrentModule();

    modifier onlyAccount() {
        if (msg.sender != _account) revert NotAccount();
        _;
    }

    /// @param p Mandate parameters (see BondedTypes.MandateParams).
    /// @param account_ The smart account this module guards.
    /// @param agent_ The agent's session key.
    /// @param guardian_ Operator address allowed to freeze, unfreeze and rotate the agent.
    /// @param agentId_ The agent's id in BondedRegistry.
    /// @param oracle_ Price oracle for loss measurement.
    constructor(
        BondedTypes.MandateParams memory p,
        address account_,
        address agent_,
        address guardian_,
        uint256 agentId_,
        IPriceOracle oracle_
    ) MandateBase(p, agent_, guardian_, agentId_, oracle_, account_) {
        factory = IMandateModuleFactory(msg.sender);
        _baseAsset = p.baseAsset;
    }

    // ---------------------------------------------------------------------------------------
    // Account owner
    // ---------------------------------------------------------------------------------------

    /// @notice Accepts the account's current balances as the new starting point, without
    ///         recording a breach. Account only: the owner calls it after moving funds in a way
    ///         the hook can't see (for example a Safe owner's own `execTransaction`), usually in
    ///         the same transaction. Otherwise the next `execute` or `reconcile` records the
    ///         owner's withdrawal as a Deferred breach and freezes the agent.
    function sync() external onlyAccount nonReentrant {
        _snapshotBalances();
    }

    /// @inheritdoc MandateBase
    /// @dev Only while installed: once uninstalled the owner may move funds freely.
    function reconcile() external override nonReentrant {
        if (installs == 0) revert NotInstalled();
        _reconcile();
    }

    // ---------------------------------------------------------------------------------------
    // ERC-7579
    // ---------------------------------------------------------------------------------------

    /// @dev Called once per installed type. The first install takes the balances as the
    ///      starting point (what happened before isn't the agent's doing).
    ///      Only the account's current module (the last one it created) can be installed, so an
    ///      account never has two modules recording the same outflow.
    function onInstall(bytes calldata) external onlyAccount {
        if (factory.moduleOf(_account) != address(this)) revert NotCurrentModule();
        if (installs++ == 0) _snapshotBalances();
    }

    /// @dev Makes no external calls, so nothing (a stale oracle, say) can stop the owner
    ///      uninstalling.
    function onUninstall(bytes calldata) external onlyAccount {
        if (installs > 0) --installs;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR || moduleTypeId == MODULE_TYPE_HOOK;
    }

    function isInitialized(address smartAccount) external view returns (bool) {
        return smartAccount == _account && installs > 0;
    }

    /// @notice Hook: runs before every execution on the account.
    /// @dev The module's own calls (the agent's action, a premium) are measured by `execute` and
    ///      `payPremium`, so they pass through. Anything else may not run in the middle of the
    ///      agent's action. Otherwise it records drops so far; if that fails (e.g. a stale
    ///      oracle) the owner's action still goes ahead and the balances are left as they were.
    function preCheck(address msgSender, uint256, bytes calldata)
        external
        onlyAccount
        returns (bytes memory hookData)
    {
        if (msgSender == address(this)) return "";
        if (_reentrancyGuardEntered()) revert ReentrancyGuardReentrantCall();
        try this.reconcile() {
            hookData = abi.encode(true);
        } catch {}
    }

    /// @notice Hook: runs after every execution on the account. Accepts the owner's changes.
    function postCheck(bytes calldata hookData) external onlyAccount {
        if (hookData.length != 0) _snapshotBalances();
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    /// @notice The smart account this module guards; payouts go here.
    function account() external view returns (address) {
        return _account;
    }

    /// @notice Base asset: premiums are paid and payouts made in it.
    function asset() external view returns (address) {
        return _baseAsset;
    }

    // ---------------------------------------------------------------------------------------
    // MandateBase hooks
    // ---------------------------------------------------------------------------------------

    /// @dev A token call (approve, increaseAllowance, setApprovalForAll, transfer, transferFrom) on
    ///      a token outside the mandate's asset list is T1 UnauthorizedTarget. A smart account may
    ///      hold other tokens the module doesn't measure; without this an allowed spender or
    ///      recipient could be used to move them. (The vault keeps MandateBase's rule unchanged,
    ///      so its behaviour and published scores stay as they are.)
    function _classify(address target, bytes calldata data)
        internal
        view
        override
        returns (Verdict memory v)
    {
        v = super._classify(target, data);
        bytes4 s = v.selector;
        bool tokenCall = s == APPROVE || s == INCREASE_ALLOWANCE || s == SET_APPROVAL_FOR_ALL
            || s == TRANSFER || s == TRANSFER_FROM;
        if (tokenCall && !isAsset[target]) {
            v.allowed = false;
            v.leakCheck = true;
            v.breachType = BondedTypes.BreachType.UnauthorizedTarget;
        }
    }

    /// @dev Calls into the account or this module could change the account's setup, so they are
    ///      refused in both modes, like a vault refusing calls to itself.
    function _checkTarget(address target) internal view override {
        if (installs == 0) revert NotInstalled();
        if (target == _account) revert CannotCallAccount();
        if (target == address(this)) revert CannotCallModule();
    }

    function _call(address target, bytes calldata data)
        internal
        override
        returns (bool success, bytes memory result)
    {
        try IERC7579Account(_account)
            .executeFromExecutor(
                MODE_SINGLE_DEFAULT, abi.encodePacked(target, uint256(0), data)
            ) returns (
            bytes[] memory results
        ) {
            return (true, results.length > 0 ? results[0] : bytes(""));
        } catch (bytes memory reason) {
            return (false, reason);
        }
    }

    function _payOut(address to, uint256 amount) internal override {
        bytes[] memory results = IERC7579Account(_account)
            .executeFromExecutor(
                MODE_SINGLE_DEFAULT,
                abi.encodePacked(
                    _baseAsset, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount))
                )
            );
        // Same acceptance rule as SafeERC20: no return data, or `true`.
        bytes memory returned = results.length > 0 ? results[0] : bytes("");
        if (returned.length != 0 && !abi.decode(returned, (bool))) {
            revert PremiumTransferFailed();
        }
    }

    function _coverManager() internal view override returns (address) {
        return factory.coverManager();
    }

    function _claimsEngine() internal view override returns (address) {
        return factory.claimsEngine();
    }
}

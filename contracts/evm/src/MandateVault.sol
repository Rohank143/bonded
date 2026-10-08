// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMandateVaultFactory} from "./interfaces/IMandateVaultFactory.sol";
import {MandateBase} from "./MandateBase.sol";

/// @title MandateVault
/// @notice Holds an AI agent's funds and checks every action against the agent's mandate.
///         Depositors hold ERC-4626 shares. The agent acts only through `execute`.
/// @dev See docs/SPECIFICATION.md Section 6.3 and docs/decisions/002-mandate-vault.md.
///      The mandate checks (classification, limits, precedence, breach log, freezing and the
///      guardian) live in MandateBase and are shared with MandateModule. This contract adds the
///      ERC-4626 share accounting and makes the agent's calls from the vault itself.
contract MandateVault is ERC4626, MandateBase {
    using SafeERC20 for IERC20;

    IMandateVaultFactory public immutable factory;

    error CannotCallVault();
    // The mandate checks revert with MandateErrors; these declarations have the same
    // signatures (so the same selectors) and keep `MandateVault.NotAgent.selector` working.
    error ZeroAddress();
    error InvalidParams(string reason);
    error NotAgent();
    error NotGuardian();
    error NotCoverManager();
    error NotClaimsEngine();
    error AgentFrozen();
    error OnlySelf();
    error UnknownBreach(uint256 breachId);
    error BreachAlreadyClaimed(uint256 breachId);
    error BreachDetected(BondedTypes.BreachType breachType, uint256 lossUsd6);
    error CallFailed(bytes revertData);

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
    )
        ERC20(name_, symbol_)
        ERC4626(IERC20(p.baseAsset))
        MandateBase(p, agent_, guardian_, agentId_, oracle_, address(this))
    {
        factory = IMandateVaultFactory(msg.sender);
    }

    // ---------------------------------------------------------------------------------------
    // Guardian
    // ---------------------------------------------------------------------------------------

    /// @dev Same as MandateBase.unfreeze; restated so `MandateVault.unfreeze` resolves when
    ///      callers encode it by contract name (Solidity only resolves members declared here).
    function unfreeze() external override onlyGuardian {
        _unfreeze();
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

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
    // MandateBase hooks
    // ---------------------------------------------------------------------------------------

    function _checkTarget(address target) internal view override {
        if (target == address(this)) revert CannotCallVault();
    }

    function _call(address target, bytes calldata data)
        internal
        override
        returns (bool success, bytes memory result)
    {
        (success, result) = target.call(data);
    }

    function _payOut(address to, uint256 amount) internal override {
        IERC20(asset()).safeTransfer(to, amount);
    }

    function _coverManager() internal view override returns (address) {
        return factory.coverManager();
    }

    function _claimsEngine() internal view override returns (address) {
        return factory.claimsEngine();
    }
}

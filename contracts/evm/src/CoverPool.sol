// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";

/// @title CoverPool
/// @notice Underwriters' capital. Depositors earn premiums (share price rises) and bear the
///         losses the operator bond doesn't cover. See docs/PLAN.md Section 6.2 and ADR-003.
/// @dev Withdrawals need a request, a cooldown, and free (unlocked) capital, so underwriters
///      can't run ahead of a claim they see coming.
contract CoverPool is ICoverPool, ERC4626, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct WithdrawRequest {
        uint256 shares;
        uint64 unlockAt;
    }

    uint256 public constant MAX_COOLDOWN = 30 days;
    /// @notice A matured request can be used for this long, then it must be renewed.
    uint256 public constant REQUEST_VALIDITY = 2 days;

    uint256 public cooldown;
    ICoverManager public coverManager;
    address public claimsEngine;
    mapping(address owner => WithdrawRequest) public withdrawRequests;

    event WithdrawRequested(address indexed owner, uint256 shares, uint64 unlockAt);
    event ClaimPaid(address indexed to, uint256 requested, uint256 paid);
    event CooldownSet(uint256 cooldown);
    event CoverManagerSet(address coverManager);
    event ClaimsEngineSet(address claimsEngine);

    error ZeroAddress();
    error AlreadySet();
    error NotClaimsEngine();
    error CooldownTooLong();
    error InsufficientShares();

    constructor(
        IERC20 asset_,
        address owner_,
        uint256 cooldown_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(asset_) Ownable(owner_) {
        _setCooldown(cooldown_);
    }

    // ----- Admin (set-once modules) -------------------------------------------------------

    function setCoverManager(ICoverManager coverManager_) external onlyOwner {
        if (address(coverManager_) == address(0)) revert ZeroAddress();
        if (address(coverManager) != address(0)) revert AlreadySet();
        coverManager = coverManager_;
        emit CoverManagerSet(address(coverManager_));
    }

    function setClaimsEngine(address claimsEngine_) external onlyOwner {
        if (claimsEngine_ == address(0)) revert ZeroAddress();
        if (claimsEngine != address(0)) revert AlreadySet();
        claimsEngine = claimsEngine_;
        emit ClaimsEngineSet(claimsEngine_);
    }

    function setCooldown(uint256 cooldown_) external onlyOwner {
        _setCooldown(cooldown_);
    }

    // ----- Underwriters ------------------------------------------------------------------

    /// @notice Starts the cooldown for redeeming `shares`. Replaces any earlier request.
    function requestRedeem(uint256 shares) external {
        if (shares == 0 || shares > balanceOf(msg.sender)) revert InsufficientShares();
        // casting to 'uint64' is safe: timestamps fit and cooldown is capped at 30 days
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 unlockAt = uint64(block.timestamp + cooldown);
        withdrawRequests[msg.sender] = WithdrawRequest({shares: shares, unlockAt: unlockAt});
        emit WithdrawRequested(msg.sender, shares, unlockAt);
    }

    /// @notice Capital needed to back active cover at the allowed leverage (rounded up).
    function requiredCapital() public view returns (uint256) {
        if (address(coverManager) == address(0)) return 0;
        return Math.mulDiv(
            coverManager.totalActiveCover(),
            BondedTypes.BPS,
            coverManager.maxLeverageBps(),
            Math.Rounding.Ceil
        );
    }

    /// @notice Assets that can leave without breaking the leverage limit.
    function freeCapital() public view returns (uint256) {
        uint256 total = totalAssets();
        uint256 required = requiredCapital();
        return total > required ? total - required : 0;
    }

    /// @dev Only matured, unexpired requests can be redeemed, and only from free capital.
    function maxRedeem(address owner) public view override returns (uint256) {
        WithdrawRequest memory request = withdrawRequests[owner];
        if (
            block.timestamp < request.unlockAt
                || block.timestamp > request.unlockAt + REQUEST_VALIDITY
        ) {
            return 0;
        }
        uint256 shares = Math.min(request.shares, balanceOf(owner));
        return Math.min(shares, convertToShares(freeCapital()));
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return convertToAssets(maxRedeem(owner));
    }

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

    // ----- Claims ------------------------------------------------------------------------

    /// @inheritdoc ICoverPool
    function payClaim(address to, uint256 amount) external nonReentrant returns (uint256 paid) {
        if (msg.sender != claimsEngine || claimsEngine == address(0)) revert NotClaimsEngine();
        IERC20 base = IERC20(asset());
        paid = Math.min(amount, base.balanceOf(address(this)));
        if (paid > 0) base.safeTransfer(to, paid);
        emit ClaimPaid(to, amount, paid);
    }

    // ----- Views to satisfy both parents -------------------------------------------------

    function asset() public view override(ERC4626, ICoverPool) returns (address) {
        return super.asset();
    }

    function totalAssets() public view override(ERC4626, ICoverPool) returns (uint256) {
        return super.totalAssets();
    }

    // ----- Internals ---------------------------------------------------------------------

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        WithdrawRequest storage request = withdrawRequests[owner];
        request.shares = shares >= request.shares ? 0 : request.shares - shares;
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function _setCooldown(uint256 cooldown_) internal {
        if (cooldown_ > MAX_COOLDOWN) revert CooldownTooLong();
        cooldown = cooldown_;
        emit CooldownSet(cooldown_);
    }
}

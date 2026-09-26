// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {ICoverPool} from "./interfaces/ICoverPool.sol";
import {IOperatorBond} from "./interfaces/IOperatorBond.sol";
import {IMandateVaultFactory} from "./interfaces/IMandateVaultFactory.sol";
import {MandateVault} from "./MandateVault.sol";

/// @title CoverManager
/// @notice Binds cover for Mandate Vaults from quotes signed by the Arena attester, issues a
///         non-transferable policy NFT to the vault, streams premiums from the vault, and
///         enforces the pool's risk caps. See docs/PLAN.md Sections 6.2, 6.4, 9.4 and ADR-003.
/// @dev Risk caps checked at binding: total cover <= maxLeverage x pool assets; one agent's
///      cover <= its tier cap and maxAgentCoverBps of pool assets; one model family's cover
///      <= modelFamilyCapBps of pool assets (a new jailbreak can hit every agent on a model).
contract CoverManager is ICoverManager, ERC721, EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant YEAR = 365 days;

    IMandateVaultFactory public immutable factory;
    ICoverPool public immutable pool;
    IOperatorBond public immutable bond;
    IERC20 public immutable baseAsset;

    address public treasury;
    address public bountyPool;
    address public claimsEngine;

    uint16 public protocolFeeBps = 1500; // 15% of premiums
    uint16 public bountyFeeBps = 500; // 5% of premiums
    /// @inheritdoc ICoverManager
    uint32 public maxLeverageBps = 20_000; // total cover <= 2x pool assets
    uint16 public maxAgentCoverBps = 1000; // one agent <= 10% of pool assets
    uint16 public modelFamilyCapBps = 4000; // one model family <= 40% of pool assets
    uint64 public policyTerm = 30 days;
    uint64 public waitingPeriod = 1 days;
    /// @notice How long a premium can stay unpaid before the policy lapses. Coverage continues
    ///         meanwhile, and ClaimsEngine nets the unpaid premium from any payout.
    uint64 public gracePeriod = 3 days;

    mapping(address signer => bool) public isAttester;
    mapping(bytes32 digest => bool) public quoteUsed;

    uint256 public nextPolicyId = 1;
    mapping(uint256 policyId => Policy) private _policies;
    mapping(address vault => uint256 policyId) public activePolicyOf;

    /// @inheritdoc ICoverManager
    uint256 public totalActiveCover;
    /// @inheritdoc ICoverManager
    mapping(uint256 agentId => uint256) public activeCoverOfAgent;
    mapping(uint8 modelFamily => uint256) public activeCoverOfFamily;

    event CoverBound(
        uint256 indexed policyId,
        address indexed vault,
        uint256 indexed agentId,
        uint256 coverAmount,
        uint32 premiumRateBps,
        uint16 score,
        uint64 coveredFrom,
        uint64 endsAt
    );
    event PremiumPaid(
        uint256 indexed policyId,
        uint256 amount,
        uint256 toPool,
        uint256 toTreasury,
        uint256 toBounty
    );
    event PolicyClosed(uint256 indexed policyId, Status status, uint64 closedAt);
    event ClaimRecorded(
        uint256 indexed policyId, uint256 paid, uint256 premiumNetted, uint256 remainingCover
    );
    event AttesterSet(address indexed attester, bool allowed);
    event TreasurySet(address treasury);
    event BountyPoolSet(address bountyPool);
    event ClaimsEngineSet(address claimsEngine);
    event FeesSet(uint16 protocolFeeBps, uint16 bountyFeeBps);
    event RiskParamsSet(uint32 maxLeverageBps, uint16 maxAgentCoverBps, uint16 modelFamilyCapBps);
    event TermsSet(uint64 policyTerm, uint64 waitingPeriod);
    event GracePeriodSet(uint64 gracePeriod);
    event PremiumPastDue(uint256 indexed policyId, uint256 owed, uint64 pastDueSince);

    error ZeroAddress();
    error AlreadySet();
    error InvalidParams(string reason);
    error NotAttester(address signer);
    error QuoteExpired();
    error QuoteAlreadyUsed();
    error NotAVault(address vault);
    error NotGuardian();
    error QuoteMismatch(string field);
    error VaultMustFreezeOnBreach();
    error ActivePolicyExists(uint256 policyId);
    error Uninsurable(uint16 score);
    error InsufficientBond(uint256 required, uint256 actual);
    error CapacityExceeded(string cap);
    error UnknownPolicy(uint256 policyId);
    error NotClaimsEngine();
    error ClaimExceedsCover();
    error PolicyNotTransferable();

    constructor(
        address owner_,
        IMandateVaultFactory factory_,
        ICoverPool pool_,
        IOperatorBond bond_,
        address treasury_,
        address bountyPool_
    )
        ERC721("Bonded Cover", "BCOVER")
        EIP712(BondedTypes.EIP712_NAME, BondedTypes.EIP712_VERSION)
        Ownable(owner_)
    {
        if (
            address(factory_) == address(0) || address(pool_) == address(0)
                || address(bond_) == address(0) || treasury_ == address(0)
                || bountyPool_ == address(0)
        ) revert ZeroAddress();
        factory = factory_;
        pool = pool_;
        bond = bond_;
        baseAsset = IERC20(pool_.asset());
        treasury = treasury_;
        bountyPool = bountyPool_;
    }

    // ---------------------------------------------------------------------------------------
    // Binding cover
    // ---------------------------------------------------------------------------------------

    /// @notice Binds cover for a vault from an attester-signed quote. Caller must be the vault's guardian.
    function buyCover(BondedTypes.Quote calldata quote, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 policyId)
    {
        _checkQuote(quote, signature);
        MandateVault vault = MandateVault(quote.vault);
        _checkVault(vault, quote);
        _checkRisk(quote);

        policyId = _createPolicy(quote);
    }

    /// @notice EIP-712 digest of a quote for this contract (what the attester signs).
    function quoteDigest(BondedTypes.Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(BondedTypes.hashQuote(quote));
    }

    // ---------------------------------------------------------------------------------------
    // Premiums and lifecycle
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc ICoverManager
    function accrue(uint256 policyId) public nonReentrant {
        _accrue(policyId);
    }

    /// @notice Premium owed now for a policy (rounded up).
    /// @inheritdoc ICoverManager
    function premiumDebt(uint256 policyId) external view returns (uint256) {
        Policy storage policy = _existing(policyId);
        return policy.status == Status.Active ? premiumOwed(policyId) : policy.premiumDebt;
    }

    function premiumOwed(uint256 policyId) public view returns (uint256) {
        Policy storage policy = _policies[policyId];
        if (policy.status != Status.Active) return 0;
        uint64 until = SafeCast.toUint64(Math.min(block.timestamp, policy.endsAt));
        if (until <= policy.paidUntil) return 0;
        return _premiumFor(policy, until - policy.paidUntil);
    }

    /// @notice Ends a policy early. Premiums are settled first. Guardian only.
    function cancel(uint256 policyId) external nonReentrant {
        Policy storage policy = _existing(policyId);
        if (msg.sender != MandateVault(policy.vault).guardian()) revert NotGuardian();
        _accrue(policyId);
        if (policy.status == Status.Active) {
            _close(policyId, Status.Cancelled, SafeCast.toUint64(block.timestamp));
        }
    }

    // ---------------------------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc ICoverManager
    function recordClaim(uint256 policyId, uint256 paid, uint256 premiumNetted) external {
        if (msg.sender != claimsEngine || claimsEngine == address(0)) revert NotClaimsEngine();
        Policy storage policy = _existing(policyId);
        uint256 used = paid + premiumNetted;
        if (used > policy.remainingCover) revert ClaimExceedsCover();

        if (premiumNetted > 0) {
            // The netted amount settles the premium owed up to now.
            if (policy.status == Status.Active) {
                policy.paidUntil = SafeCast.toUint64(Math.min(block.timestamp, policy.endsAt));
                policy.pastDueSince = 0;
            } else {
                policy.premiumDebt = 0;
            }
        }

        policy.remainingCover -= used;
        if (policy.status == Status.Active) {
            _reduceExposure(policy, used);
            if (policy.remainingCover == 0) {
                _close(policyId, Status.Exhausted, SafeCast.toUint64(block.timestamp));
            }
        }
        emit ClaimRecorded(policyId, paid, premiumNetted, policy.remainingCover);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    /// @inheritdoc ICoverManager
    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return _existing(policyId);
    }

    /// @inheritdoc ICoverManager
    function coverageWindow(uint256 policyId)
        external
        view
        returns (uint64 coveredFrom, uint64 coveredUntil)
    {
        Policy storage policy = _existing(policyId);
        coveredFrom = policy.coveredFrom;
        coveredUntil = policy.status == Status.Active
            ? SafeCast.toUint64(Math.min(block.timestamp, policy.endsAt))
            : policy.closedAt;
    }

    // ---------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------

    function setAttester(address attester, bool allowed) external onlyOwner {
        if (attester == address(0)) revert ZeroAddress();
        isAttester[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setBountyPool(address bountyPool_) external onlyOwner {
        if (bountyPool_ == address(0)) revert ZeroAddress();
        bountyPool = bountyPool_;
        emit BountyPoolSet(bountyPool_);
    }

    /// @notice Sets ClaimsEngine once, so the owner can't later redirect claim accounting.
    function setClaimsEngine(address claimsEngine_) external onlyOwner {
        if (claimsEngine_ == address(0)) revert ZeroAddress();
        if (claimsEngine != address(0)) revert AlreadySet();
        claimsEngine = claimsEngine_;
        emit ClaimsEngineSet(claimsEngine_);
    }

    function setFees(uint16 protocolFeeBps_, uint16 bountyFeeBps_) external onlyOwner {
        if (uint256(protocolFeeBps_) + bountyFeeBps_ > 5000) {
            revert InvalidParams("fees above 50%");
        }
        protocolFeeBps = protocolFeeBps_;
        bountyFeeBps = bountyFeeBps_;
        emit FeesSet(protocolFeeBps_, bountyFeeBps_);
    }

    /// @dev Caps apply at binding; existing policies are not unwound.
    function setRiskParams(
        uint32 maxLeverageBps_,
        uint16 maxAgentCoverBps_,
        uint16 modelFamilyCapBps_
    ) external onlyOwner {
        if (maxLeverageBps_ < 1000 || maxLeverageBps_ > 50_000) {
            revert InvalidParams("maxLeverageBps");
        }
        if (maxAgentCoverBps_ == 0 || maxAgentCoverBps_ > BondedTypes.BPS) {
            revert InvalidParams("maxAgentCoverBps");
        }
        if (modelFamilyCapBps_ == 0 || modelFamilyCapBps_ > BondedTypes.BPS) {
            revert InvalidParams("modelFamilyCapBps");
        }
        maxLeverageBps = maxLeverageBps_;
        maxAgentCoverBps = maxAgentCoverBps_;
        modelFamilyCapBps = modelFamilyCapBps_;
        emit RiskParamsSet(maxLeverageBps_, maxAgentCoverBps_, modelFamilyCapBps_);
    }

    /// @dev Applies to new policies only; each policy stores its own term and waiting period.
    function setGracePeriod(uint64 gracePeriod_) external onlyOwner {
        if (gracePeriod_ > 14 days) revert InvalidParams("gracePeriod");
        gracePeriod = gracePeriod_;
        emit GracePeriodSet(gracePeriod_);
    }

    function setTerms(uint64 policyTerm_, uint64 waitingPeriod_) external onlyOwner {
        if (policyTerm_ < 1 hours || policyTerm_ > YEAR) revert InvalidParams("policyTerm");
        if (waitingPeriod_ > 7 days || waitingPeriod_ >= policyTerm_) {
            revert InvalidParams("waitingPeriod");
        }
        policyTerm = policyTerm_;
        waitingPeriod = waitingPeriod_;
        emit TermsSet(policyTerm_, waitingPeriod_);
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _createPolicy(BondedTypes.Quote calldata quote) internal returns (uint256 policyId) {
        policyId = nextPolicyId++;
        uint64 startedAt = SafeCast.toUint64(block.timestamp);
        Policy storage policy = _policies[policyId];
        policy.agentId = quote.agentId;
        policy.vault = quote.vault;
        policy.coverAmount = quote.coverAmount;
        policy.remainingCover = quote.coverAmount;
        policy.premiumRateBps = quote.premiumRateBps;
        policy.score = quote.score;
        policy.modelFamily = quote.modelFamily;
        policy.status = Status.Active;
        policy.startedAt = startedAt;
        policy.coveredFrom = startedAt + waitingPeriod;
        policy.endsAt = startedAt + policyTerm;
        policy.paidUntil = startedAt;

        activePolicyOf[quote.vault] = policyId;
        totalActiveCover += quote.coverAmount;
        activeCoverOfAgent[quote.agentId] += quote.coverAmount;
        activeCoverOfFamily[quote.modelFamily] += quote.coverAmount;

        _mint(quote.vault, policyId);
        emit CoverBound(
            policyId,
            quote.vault,
            quote.agentId,
            quote.coverAmount,
            quote.premiumRateBps,
            quote.score,
            policy.coveredFrom,
            policy.endsAt
        );
    }

    function _checkQuote(BondedTypes.Quote calldata quote, bytes calldata signature) internal {
        bytes32 digest = quoteDigest(quote);
        address signer = ECDSA.recover(digest, signature);
        if (!isAttester[signer]) revert NotAttester(signer);
        if (block.timestamp > quote.expiresAt) revert QuoteExpired();
        if (quoteUsed[digest]) revert QuoteAlreadyUsed();
        quoteUsed[digest] = true;
    }

    function _checkVault(MandateVault vault, BondedTypes.Quote calldata quote) internal {
        if (!factory.isVault(address(vault))) revert NotAVault(address(vault));
        if (msg.sender != vault.guardian()) revert NotGuardian();
        if (vault.agentId() != quote.agentId) revert QuoteMismatch("agentId");
        if (vault.mandateHash() != quote.mandateHash) revert QuoteMismatch("mandateHash");
        if (vault.asset() != address(baseAsset)) revert QuoteMismatch("asset");
        if (!vault.freezeOnBreach()) revert VaultMustFreezeOnBreach();

        uint256 existing = activePolicyOf[address(vault)];
        if (existing != 0) {
            _accrue(existing); // expires or lapses it if its time is up
            if (_policies[existing].status == Status.Active) revert ActivePolicyExists(existing);
        }
    }

    function _checkRisk(BondedTypes.Quote calldata quote) internal view {
        if (quote.coverAmount == 0) revert InvalidParams("coverAmount");
        if (quote.score > 100) revert InvalidParams("score");
        (bool insurable, uint16 minBondBps, uint16 tierCapBps) = BondedTypes.tierRule(quote.score);
        if (!insurable) revert Uninsurable(quote.score);

        uint256 requiredBond = Math.max(
            quote.minBond,
            Math.mulDiv(quote.coverAmount, minBondBps, BondedTypes.BPS, Math.Rounding.Ceil)
        );
        uint256 bonded = bond.bondOf(quote.agentId);
        if (bonded < requiredBond) revert InsufficientBond(requiredBond, bonded);

        uint256 poolAssets = pool.totalAssets();
        if (totalActiveCover + quote.coverAmount > poolAssets * maxLeverageBps / BondedTypes.BPS) {
            revert CapacityExceeded("leverage");
        }
        uint256 agentCapBps = Math.min(maxAgentCoverBps, tierCapBps);
        if (
            activeCoverOfAgent[quote.agentId] + quote.coverAmount
                > poolAssets * agentCapBps / BondedTypes.BPS
        ) {
            revert CapacityExceeded("agent");
        }
        if (
            activeCoverOfFamily[quote.modelFamily] + quote.coverAmount
                > poolAssets * modelFamilyCapBps / BondedTypes.BPS
        ) revert CapacityExceeded("modelFamily");
    }

    /// @dev Pulls the premium owed from the vault. A failed collection starts (or continues) a
    ///      grace period during which coverage continues; after it the policy lapses at the end of
    ///      the grace period, keeping the unpaid premium as debt. Past `endsAt` the policy expires.
    ///      Coverage never ends before a failed collection is first seen, so a breach that drains
    ///      the vault's base asset stays claimable (the unpaid premium is netted from the payout).
    function _accrue(uint256 policyId) internal {
        Policy storage policy = _existing(policyId);
        if (policy.status != Status.Active) return;

        uint64 until = SafeCast.toUint64(Math.min(block.timestamp, policy.endsAt));
        if (until > policy.paidUntil) {
            uint256 owed = _premiumFor(policy, until - policy.paidUntil);
            try MandateVault(policy.vault).payPremium(owed) {
                policy.paidUntil = until;
                policy.pastDueSince = 0;
                _distribute(policyId, owed);
            } catch {
                _handleMissedPremium(policyId, policy, owed);
                return;
            }
        }
        if (block.timestamp >= policy.endsAt) _close(policyId, Status.Expired, policy.endsAt);
    }

    function _handleMissedPremium(uint256 policyId, Policy storage policy, uint256 owed) internal {
        uint64 nowTs = SafeCast.toUint64(block.timestamp);
        if (policy.pastDueSince == 0) {
            policy.pastDueSince = nowTs;
            emit PremiumPastDue(policyId, owed, nowTs);
        }
        if (block.timestamp >= policy.endsAt) {
            policy.premiumDebt = owed;
            _close(policyId, Status.Expired, policy.endsAt);
            return;
        }
        uint64 lapseAt = policy.pastDueSince + gracePeriod;
        if (block.timestamp >= lapseAt) {
            uint64 closedAt = lapseAt < policy.endsAt ? lapseAt : policy.endsAt;
            policy.premiumDebt = _premiumFor(policy, closedAt - policy.paidUntil);
            _close(policyId, Status.Lapsed, closedAt);
        }
    }

    /// @dev Rounded up so frequent accruals can't round premiums down to zero.
    function _premiumFor(Policy storage policy, uint256 elapsed) internal view returns (uint256) {
        return Math.mulDiv(
            policy.coverAmount,
            uint256(policy.premiumRateBps) * elapsed,
            BondedTypes.BPS * YEAR,
            Math.Rounding.Ceil
        );
    }

    function _distribute(uint256 policyId, uint256 amount) internal {
        uint256 toTreasury = amount * protocolFeeBps / BondedTypes.BPS;
        uint256 toBounty = amount * bountyFeeBps / BondedTypes.BPS;
        uint256 toPool = amount - toTreasury - toBounty;
        if (toTreasury > 0) baseAsset.safeTransfer(treasury, toTreasury);
        if (toBounty > 0) baseAsset.safeTransfer(bountyPool, toBounty);
        if (toPool > 0) baseAsset.safeTransfer(address(pool), toPool);
        emit PremiumPaid(policyId, amount, toPool, toTreasury, toBounty);
    }

    function _close(uint256 policyId, Status status, uint64 closedAt) internal {
        Policy storage policy = _policies[policyId];
        policy.status = status;
        policy.closedAt = closedAt;
        _reduceExposure(policy, policy.remainingCover);
        if (activePolicyOf[policy.vault] == policyId) activePolicyOf[policy.vault] = 0;
        emit PolicyClosed(policyId, status, closedAt);
    }

    function _reduceExposure(Policy storage policy, uint256 amount) internal {
        totalActiveCover -= amount;
        activeCoverOfAgent[policy.agentId] -= amount;
        activeCoverOfFamily[policy.modelFamily] -= amount;
    }

    function _existing(uint256 policyId) internal view returns (Policy storage policy) {
        policy = _policies[policyId];
        if (policy.status == Status.None) revert UnknownPolicy(policyId);
    }

    /// @dev Policy NFTs are receipts held by the insured vault; they can't be transferred.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert PolicyNotTransferable();
        return super._update(to, tokenId, auth);
    }
}

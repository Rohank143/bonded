// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BondedTypes
/// @notice Shared enums, structs and EIP-712 typehashes for the Bonded protocol.
/// @dev Codes and type strings must match packages/shared (TypeScript). The cross-language
///      tests in test/BondedTypes.t.sol and packages/shared/test/attestation.test.ts pin them.
library BondedTypes {
    /// @notice How a Mandate Vault treats a breach. See docs/PLAN.md Section 6.
    enum MandateMode {
        Monitor, // breach executes, is recorded, agent is frozen
        Enforce // breach is blocked (no effect), the attempt is recorded, agent is frozen
    }

    /// @notice Breach types recorded by a Mandate Vault. See docs/PLAN.md Sections 6.3 and 11.1.
    enum BreachType {
        UnauthorizedTarget, // T1: call to a contract or function outside the mandate
        UnauthorizedApproval, // T1: approval to a spender outside the mandate
        UnauthorizedTransfer, // T1: transfer to a recipient outside the mandate
        Deferred, // T1: unexplained outflow found by reconcile()
        Limit, // T2: per-transaction or daily notional limit exceeded
        Asset // T3: value left without equivalent allowed assets coming back (e.g. honeypot or lookalike token)
    }

    /// @notice Enforcement parameters of a mandate, passed to MandateVaultFactory.createVault.
    /// @dev Field order and meaning match `EvmMandateParams` in packages/shared.
    struct MandateParams {
        bytes32 mandateHash; // keccak256 of the canonical mandate JSON
        MandateMode mode;
        address baseAsset; // vault denomination; must be in `assets`
        address[] assets; // tokens the vault may hold
        address[] targets; // contracts the agent may call
        bytes4[][] selectors; // selectors[i] = allowed functions on targets[i]; empty = any
        address[] destinations; // allowed transfer recipients (the vault itself is always allowed)
        uint256 maxTxNotionalUsd6; // per-action outflow limit, USD with 6 decimals
        uint256 maxDailyNotionalUsd6; // outflow limit per 24h window, USD with 6 decimals
        uint16 maxDrawdownBps; // informational for T4 disputes; not enforced by the vault
        uint16 maxSlippageBps; // largest allowed net loss per action, as a share of its outflow
        bool freezeOnBreach;
    }

    /// @notice Score attestation signed by the Arena attester and posted to BondedRegistry.
    struct Attestation {
        uint256 agentId;
        uint16 score;
        uint32 expectedLossBps;
        bytes32 reportHash;
        bytes32 mandateHash;
        bytes32 codeHash;
        bytes32 teeMeasurement;
        uint8 modelFamily;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    /// @notice Signed premium quote accepted by CoverManager.buyCover.
    struct Quote {
        uint256 agentId;
        address vault;
        uint256 coverAmount;
        uint32 premiumRateBps;
        uint16 score;
        uint8 modelFamily;
        bytes32 mandateHash;
        bytes32 reportHash;
        uint256 minBond;
        uint64 expiresAt;
        uint256 nonce;
    }

    bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 agentId,uint16 score,uint32 expectedLossBps,bytes32 reportHash,bytes32 mandateHash,bytes32 codeHash,bytes32 teeMeasurement,uint8 modelFamily,uint64 issuedAt,uint64 expiresAt)"
    );

    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 agentId,address vault,uint256 coverAmount,uint32 premiumRateBps,uint16 score,uint8 modelFamily,bytes32 mandateHash,bytes32 reportHash,uint256 minBond,uint64 expiresAt,uint256 nonce)"
    );

    /// @notice EIP-712 domain name and version. Match EIP712_DOMAIN_NAME / _VERSION in packages/shared.
    string internal constant EIP712_NAME = "Bonded";
    string internal constant EIP712_VERSION = "1";

    /// @notice Basis-point denominator (10_000 = 100%).
    uint256 internal constant BPS = 10_000;

    /// @notice USD amounts on-chain use 6 decimals, matching USDC.
    uint256 internal constant USD_DECIMALS = 6;

    /// @notice Underwriting rules for a Bonded Score. Mirrors TIER_RULES in packages/shared/src/tiers.ts.
    /// @return insurable False for CCC (score below 25).
    /// @return minBondBps Minimum operator bond as a share of cover.
    /// @return maxCoverBpsOfPool Largest cover for one agent as a share of pool assets.
    function tierRule(uint16 score)
        internal
        pure
        returns (bool insurable, uint16 minBondBps, uint16 maxCoverBpsOfPool)
    {
        if (score >= 60) return (true, 1000, 1000); // AAA, AA, A, BBB
        if (score >= 45) return (true, 2000, 1000); // BB
        if (score >= 25) return (true, 3000, 200); // B
        return (false, 0, 0); // CCC
    }

    function hashAttestation(Attestation memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                a.agentId,
                a.score,
                a.expectedLossBps,
                a.reportHash,
                a.mandateHash,
                a.codeHash,
                a.teeMeasurement,
                a.modelFamily,
                a.issuedAt,
                a.expiresAt
            )
        );
    }

    function hashQuote(Quote memory q) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                q.agentId,
                q.vault,
                q.coverAmount,
                q.premiumRateBps,
                q.score,
                q.modelFamily,
                q.mandateHash,
                q.reportHash,
                q.minBond,
                q.expiresAt,
                q.nonce
            )
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMandateVaultFactory} from "./interfaces/IMandateVaultFactory.sol";
import {MandateVault} from "./MandateVault.sol";

/// @title MandateVaultFactory
/// @notice Deploys Mandate Vaults and is the source of truth for "is this a real vault?".
///         ClaimsEngine only pays breaches recorded by vaults this factory deployed.
/// @dev Vaults are full deployments rather than clones; see docs/decisions/002-mandate-vault.md.
contract MandateVaultFactory is IMandateVaultFactory, Ownable2Step {
    /// @notice Oracle given to newly created vaults.
    IPriceOracle public oracle;
    /// @inheritdoc IMandateVaultFactory
    address public coverManager;
    /// @inheritdoc IMandateVaultFactory
    address public claimsEngine;
    /// @inheritdoc IMandateVaultFactory
    mapping(address vault => bool) public isVault;

    address[] private _vaults;

    event VaultCreated(
        address indexed vault,
        uint256 indexed agentId,
        address indexed guardian,
        address agent,
        bytes32 mandateHash
    );
    event OracleSet(address oracle);
    event CoverManagerSet(address coverManager);
    event ClaimsEngineSet(address claimsEngine);

    error ZeroAddress();
    error AlreadySet();

    constructor(address owner_, IPriceOracle oracle_) Ownable(owner_) {
        _setOracle(oracle_);
    }

    /// @notice Deploys a vault for an agent. The caller chooses the guardian.
    function createVault(
        BondedTypes.MandateParams calldata params,
        address agent,
        address guardian,
        uint256 agentId,
        string calldata name,
        string calldata symbol
    ) external returns (address vault) {
        vault = address(new MandateVault(params, agent, guardian, agentId, oracle, name, symbol));
        isVault[vault] = true;
        _vaults.push(vault);
        emit VaultCreated(vault, agentId, guardian, agent, params.mandateHash);
    }

    /// @notice Changes the oracle for vaults created from now on. Existing vaults keep theirs.
    function setOracle(IPriceOracle oracle_) external onlyOwner {
        _setOracle(oracle_);
    }

    /// @notice Sets CoverManager once. Set-once so the owner can't redirect premium pulls later.
    function setCoverManager(address coverManager_) external onlyOwner {
        if (coverManager_ == address(0)) revert ZeroAddress();
        if (coverManager != address(0)) revert AlreadySet();
        coverManager = coverManager_;
        emit CoverManagerSet(coverManager_);
    }

    /// @notice Sets ClaimsEngine once, for the same reason.
    function setClaimsEngine(address claimsEngine_) external onlyOwner {
        if (claimsEngine_ == address(0)) revert ZeroAddress();
        if (claimsEngine != address(0)) revert AlreadySet();
        claimsEngine = claimsEngine_;
        emit ClaimsEngineSet(claimsEngine_);
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return _vaults[index];
    }

    function _setOracle(IPriceOracle oracle_) internal {
        if (address(oracle_) == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }
}

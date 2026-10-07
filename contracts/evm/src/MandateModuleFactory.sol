// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IMandateModuleFactory} from "./interfaces/IMandateModuleFactory.sol";
import {MandateVaultFactory} from "./MandateVaultFactory.sol";
import {MandateModule} from "./MandateModule.sol";

/// @title MandateModuleFactory
/// @notice Deploys MandateModules for smart accounts and is the source of truth for "is this a
///         real module?". CoverManager only binds cover for modules this factory deployed.
/// @dev An account creates its own module (msg.sender is the account), so nobody can claim
///      another account's slot. One module is in use per account at a time: a new one can be
///      created only once the previous one is uninstalled (mandates are immutable, so changing
///      the rules means a new module). Modules are deployed with CREATE2 so an account can
///      create and install one in a single batch (see `predictModule`).
///
///      Unlike MandateVaultFactory, the mandate hash is checked on chain: it must equal
///      BondedTypes.mandateCommitment(params), the hash of the rules the module enforces.
///
///      The oracle, CoverManager and ClaimsEngine come from the vault factory, so there is one
///      place to set them and this factory has no owner.
contract MandateModuleFactory is IMandateModuleFactory {
    MandateVaultFactory public immutable vaultFactory;

    /// @inheritdoc IMandateModuleFactory
    mapping(address module => bool) public isModule;
    /// @notice The latest module created for an account.
    mapping(address account => address module) public moduleOf;
    /// @notice Modules created per account so far (part of the CREATE2 salt).
    mapping(address account => uint256) public modulesCreated;

    address[] private _modules;

    event ModuleCreated(
        address indexed module,
        address indexed account,
        uint256 indexed agentId,
        address guardian,
        address agent,
        bytes32 mandateHash
    );

    error ZeroAddress();
    error MandateHashMismatch(bytes32 expected, bytes32 given);
    error ModuleStillInstalled(address module);

    constructor(MandateVaultFactory vaultFactory_) {
        if (address(vaultFactory_) == address(0)) revert ZeroAddress();
        vaultFactory = vaultFactory_;
    }

    /// @notice Deploys a module guarding the caller (the smart account). The caller chooses the
    ///         guardian and the agent's session key.
    /// @param params Mandate parameters; `params.mandateHash` must be their commitment.
    function createModule(
        BondedTypes.MandateParams calldata params,
        address agent,
        address guardian,
        uint256 agentId
    ) external returns (address module) {
        address account = msg.sender;
        bytes32 commitment = BondedTypes.mandateCommitment(params);
        if (params.mandateHash != commitment) {
            revert MandateHashMismatch(commitment, params.mandateHash);
        }
        address previous = moduleOf[account];
        if (previous != address(0) && MandateModule(previous).installs() > 0) {
            revert ModuleStillInstalled(previous);
        }

        bytes32 salt = _salt(account, modulesCreated[account]++);
        module = address(
            new MandateModule{salt: salt}(params, account, agent, guardian, agentId, oracle())
        );
        isModule[module] = true;
        moduleOf[account] = module;
        _modules.push(module);
        emit ModuleCreated(module, account, agentId, guardian, agent, params.mandateHash);
    }

    /// @notice Address `createModule` will deploy to if `account` calls it next with these
    ///         arguments (and the vault factory's oracle doesn't change in between).
    function predictModule(
        address account,
        BondedTypes.MandateParams calldata params,
        address agent,
        address guardian,
        uint256 agentId
    ) external view returns (address) {
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(MandateModule).creationCode,
                abi.encode(params, account, agent, guardian, agentId, oracle())
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), _salt(account, modulesCreated[account]), initCodeHash
            )
        );
        return address(uint160(uint256(digest)));
    }

    /// @notice Oracle given to new modules: the vault factory's current oracle.
    function oracle() public view returns (IPriceOracle) {
        return vaultFactory.oracle();
    }

    /// @inheritdoc IMandateModuleFactory
    function coverManager() external view returns (address) {
        return vaultFactory.coverManager();
    }

    /// @inheritdoc IMandateModuleFactory
    function claimsEngine() external view returns (address) {
        return vaultFactory.claimsEngine();
    }

    function moduleCount() external view returns (uint256) {
        return _modules.length;
    }

    function moduleAt(uint256 index) external view returns (address) {
        return _modules[index];
    }

    function _salt(address account, uint256 index) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, index));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Proxy} from "@openzeppelin/contracts/proxy/Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {MSAAdvanced} from "erc7579/MSAAdvanced.sol";
import {Bootstrap, BootstrapConfig} from "erc7579/utils/Bootstrap.sol";
import {Initializable} from "erc7579/lib/Initializable.sol";
import {Safe7579} from "safe7579/Safe7579.sol";
import {ISafe7579} from "safe7579/ISafe7579.sol";
import {ModuleInit, RegistryInit, HookType} from "safe7579/DataTypes.sol";
import {IERC7484} from "safe7579/interfaces/IERC7484.sol";
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";
import {ModuleManager} from "@safe-global/safe-contracts/contracts/base/ModuleManager.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateModuleFactory} from "../../src/MandateModuleFactory.sol";
import {MandateVaultBase} from "../MandateVaultBase.t.sol";

/// @notice The ERC-7579 account calls the tests make as the account's owner.
interface ITestAccount {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        payable;
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        payable;
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata context)
        external
        view
        returns (bool);
}

/// @notice Deploys the ERC-7579 reference account (MSAAdvanced) behind a proxy, the way the
///         reference MSAProxy does.
contract TestMSAProxy is Proxy {
    constructor(address implementation, bytes memory data) payable {
        Initializable.setInitializable();
        ERC1967Utils.upgradeToAndCall(implementation, data);
    }

    function _implementation() internal view override returns (address) {
        return ERC1967Utils.getImplementation();
    }
}

/// @notice Shared setup for MandateModule tests: the MandateVaultBase world (tokens, oracle,
///         router, vault factory), a module factory, and real ERC-7579 accounts. `Kind.Msa` is the
///         ERC-7579 reference account; `Kind.Safe` is a Safe 1.4.1 with the Safe7579 adapter.
abstract contract ModuleTestBase is MandateVaultBase {
    enum Kind {
        Msa,
        Safe
    }

    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant SENTINEL = address(1);
    uint256 internal constant EXECUTOR = 2;
    uint256 internal constant HOOK = 4;

    MandateModuleFactory internal moduleFactory;
    MSAAdvanced internal msaImplementation;
    Bootstrap internal bootstrap;
    Safe internal safeSingleton;
    SafeProxyFactory internal safeProxyFactory;
    Safe7579 internal safe7579;
    address internal safeOwner = makeAddr("safeOwner");
    uint256 internal accountSalt;

    mapping(address account => Kind) internal kindOf;

    function setUp() public virtual override {
        super.setUp();
        moduleFactory = new MandateModuleFactory(factory);
        msaImplementation = new MSAAdvanced();
        bootstrap = new Bootstrap();
        safeSingleton = new Safe();
        safeProxyFactory = new SafeProxyFactory();
        safe7579 = new Safe7579();
    }

    // ----- Accounts ----------------------------------------------------------------------

    function _newAccount(Kind kind) internal returns (address account) {
        account = kind == Kind.Msa ? _newMsa() : _newSafe();
        kindOf[account] = kind;
    }

    function _newMsa() internal returns (address) {
        BootstrapConfig[] memory none = new BootstrapConfig[](0);
        bytes memory init = abi.encode(
            address(bootstrap),
            abi.encodeCall(
                Bootstrap.initMSA,
                (none, none, BootstrapConfig({module: address(0), data: ""}), none)
            )
        );
        return address(
            new TestMSAProxy(
                address(msaImplementation), abi.encodeCall(MSAAdvanced.initializeAccount, (init))
            )
        );
    }

    /// @dev A 1-of-1 Safe with Safe7579 enabled as module and fallback handler, then initialised
    ///      (the setup an existing Safe goes through to become an ERC-7579 account).
    function _newSafe() internal returns (address safe) {
        address[] memory owners = new address[](1);
        owners[0] = safeOwner;
        bytes memory setup = abi.encodeCall(
            Safe.setup,
            (owners, 1, address(0), "", address(safe7579), address(0), 0, payable(address(0)))
        );
        safe = address(
            safeProxyFactory.createProxyWithNonce(address(safeSingleton), setup, ++accountSalt)
        );
        ModuleInit[] memory none = new ModuleInit[](0);
        _safeOwnerCall(safe, safe, abi.encodeCall(ModuleManager.enableModule, (address(safe7579))));
        _safeOwnerCall(
            safe,
            safe,
            abi.encodeCall(
                ISafe7579.initializeAccount,
                (
                    none,
                    none,
                    none,
                    none,
                    RegistryInit({
                        registry: IERC7484(address(0)), attesters: new address[](0), threshold: 0
                    })
                )
            )
        );
    }

    /// @dev The Safe owner's own transaction (Safe.execTransaction), signed by being the sender.
    ///      This path doesn't go through Safe7579, so ERC-7579 hooks don't run.
    function _safeOwnerCall(address safe, address to, bytes memory data) internal {
        bytes memory signature = abi.encodePacked(uint256(uint160(safeOwner)), bytes32(0), uint8(1));
        vm.prank(safeOwner);
        bool ok = Safe(payable(safe))
            .execTransaction(
                to,
                0,
                data,
                Enum.Operation.Call,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                signature
            );
        require(ok, "safe transaction failed");
    }

    /// @dev The owner acting through the account's ERC-7579 `execute` (as a validated user
    ///      operation would, via the EntryPoint). Hooks run.
    function _ownerExec(address account, address target, bytes memory data) internal {
        vm.prank(ENTRY_POINT);
        ITestAccount(account).execute(bytes32(0), abi.encodePacked(target, uint256(0), data));
    }

    function _install(address account, address module, uint256 moduleType) internal {
        bytes memory data = "";
        if (moduleType == HOOK && kindOf[account] == Kind.Safe) {
            data = abi.encode(HookType.GLOBAL, bytes4(0), bytes(""));
        }
        vm.prank(ENTRY_POINT);
        ITestAccount(account).installModule(moduleType, module, data);
    }

    function _uninstall(address account, address module, uint256 moduleType) internal {
        bytes memory data;
        if (moduleType == EXECUTOR) {
            data = abi.encode(SENTINEL, bytes("")); // the module is the newest executor
        } else if (kindOf[account] == Kind.Safe) {
            data = abi.encode(HookType.GLOBAL, bytes4(0), bytes(""));
        }
        vm.prank(ENTRY_POINT);
        ITestAccount(account).uninstallModule(moduleType, module, data);
    }

    // ----- Modules -----------------------------------------------------------------------

    /// @dev Same rules as MandateVaultBase._params, with the on-chain mandate commitment.
    function _moduleParams(BondedTypes.MandateMode mode)
        internal
        view
        returns (BondedTypes.MandateParams memory p)
    {
        p = _params(mode);
        p.mandateHash = BondedTypes.mandateCommitment(p);
    }

    function _createModule(address account, BondedTypes.MandateMode mode)
        internal
        returns (MandateModule module)
    {
        vm.prank(account);
        module = MandateModule(
            moduleFactory.createModule(_moduleParams(mode), agent, guardian, agentId)
        );
    }

    /// @dev A new account of `kind` holding DEPOSIT USDG, guarded by a module installed as
    ///      executor and hook, with the router approved (like `_createVault` + `_approveRouter`).
    function _protectedAccount(Kind kind, BondedTypes.MandateMode mode)
        internal
        returns (address account, MandateModule module)
    {
        account = _newAccount(kind);
        module = _createModule(account, mode);
        _install(account, address(module), EXECUTOR);
        _install(account, address(module), HOOK);
        usdg.mint(account, DEPOSIT);
        _mexec(
            module,
            address(usdg),
            abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
        );
    }

    function _mexec(MandateModule module, address target, bytes memory data)
        internal
        returns (bytes memory)
    {
        vm.prank(agent);
        return module.execute(target, data);
    }

    function _lastModuleBreach(MandateModule module)
        internal
        view
        returns (MandateModule.Breach memory)
    {
        return module.getBreach(module.breachCount() - 1);
    }
}

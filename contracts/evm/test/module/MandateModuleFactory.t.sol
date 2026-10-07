// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateErrors} from "../../src/libraries/MandateErrors.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MandateModuleFactory} from "../../src/MandateModuleFactory.sol";
import {MandateVaultFactory} from "../../src/MandateVaultFactory.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {ModuleTestBase, ITestAccount} from "./ModuleTestBase.sol";

contract MandateModuleFactoryTest is ModuleTestBase {
    function test_CreatesAndRegistersModules() public {
        address account = _newAccount(Kind.Msa);
        BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Enforce);

        vm.expectEmit(false, true, true, true);
        emit MandateModuleFactory.ModuleCreated(
            address(0), account, agentId, guardian, agent, p.mandateHash
        );
        vm.prank(account);
        MandateModule module =
            MandateModule(moduleFactory.createModule(p, agent, guardian, agentId));

        assertTrue(moduleFactory.isModule(address(module)));
        assertEq(moduleFactory.moduleOf(account), address(module));
        assertEq(moduleFactory.moduleCount(), 1);
        assertEq(moduleFactory.moduleAt(0), address(module));
        assertFalse(factory.isVault(address(module))); // vaults and modules are told apart

        assertEq(address(module.factory()), address(moduleFactory));
        assertEq(module.account(), account);
        assertEq(module.asset(), address(usdg));
        assertEq(address(module.oracle()), address(oracle));
        assertEq(module.agent(), agent);
        assertEq(module.guardian(), guardian);
        assertEq(module.agentId(), agentId);
        assertEq(module.mandateHash(), BondedTypes.mandateCommitment(p));
        assertEq(uint8(module.mode()), uint8(BondedTypes.MandateMode.Enforce));
        assertTrue(module.freezeOnBreach());
        assertEq(module.getAssets().length, 3);
        assertTrue(module.isCallAllowed(address(router), MockRouter.swap.selector));
        assertTrue(module.isDestination(treasury));
        assertEq(module.installs(), 0); // created, not yet installed
    }

    function test_MandateHashMustBeTheCommitmentToTheParams() public {
        address account = _newAccount(Kind.Msa);
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Enforce);
        bytes32 commitment = BondedTypes.mandateCommitment(p);

        // The descriptive JSON hash a vault would carry is refused...
        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateModuleFactory.MandateHashMismatch.selector, commitment, p.mandateHash
            )
        );
        moduleFactory.createModule(p, agent, guardian, agentId);

        // ...and so is the commitment of different rules (a looser tx limit here).
        p.mandateHash = commitment;
        p.maxTxNotionalUsd6 *= 2;
        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateModuleFactory.MandateHashMismatch.selector,
                BondedTypes.mandateCommitment(p),
                commitment
            )
        );
        moduleFactory.createModule(p, agent, guardian, agentId);
    }

    function test_CommitmentLeavesTheParamsUnchanged() public view {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        bytes32 declared = p.mandateHash;
        BondedTypes.mandateCommitment(p);
        assertEq(p.mandateHash, declared);
    }

    /// @dev Pinned in packages/shared/test/mandate-commitment.test.ts too: both languages must
    ///      produce the same commitment for the same params.
    function test_CommitmentMatchesTheSharedVector() public pure {
        address[] memory assets = new address[](2);
        assets[0] = address(0x1111111111111111111111111111111111111111);
        assets[1] = address(0x2222222222222222222222222222222222222222);
        address[] memory targets = new address[](2);
        targets[0] = address(0x3333333333333333333333333333333333333333);
        targets[1] = address(0x4444444444444444444444444444444444444444);
        bytes4[][] memory selectors = new bytes4[][](2);
        selectors[0] = new bytes4[](2);
        selectors[0][0] = 0x095ea7b3;
        selectors[0][1] = 0x38ed1739;
        selectors[1] = new bytes4[](0);
        address[] memory destinations = new address[](1);
        destinations[0] = address(0x5555555555555555555555555555555555555555);
        BondedTypes.MandateParams memory p = BondedTypes.MandateParams({
            mandateHash: keccak256("ignored"),
            mode: BondedTypes.MandateMode.Enforce,
            baseAsset: assets[0],
            assets: assets,
            targets: targets,
            selectors: selectors,
            destinations: destinations,
            maxTxNotionalUsd6: 5000e6,
            maxDailyNotionalUsd6: 25_000e6,
            maxDrawdownBps: 1500,
            maxSlippageBps: 300,
            freezeOnBreach: true
        });
        assertEq(
            BondedTypes.mandateCommitment(p),
            0xf35ce1ba75a11d5bc3c77a75643f77300ebd03cdb6b1698fdc676901d52b8b46
        );
    }

    function test_AccountCreatesItsOwnModule() public {
        address account = _newAccount(Kind.Msa);
        MandateModule module = _createModule(account, BondedTypes.MandateMode.Enforce);
        // Someone else calling creates a module for *their* address, never for `account`.
        vm.prank(attacker);
        MandateModule other = MandateModule(
            moduleFactory.createModule(
                _moduleParams(BondedTypes.MandateMode.Monitor), attacker, attacker, 7
            )
        );
        assertEq(other.account(), attacker);
        assertEq(moduleFactory.moduleOf(account), address(module));
    }

    function test_OneModuleInUsePerAccount() public {
        address account = _newAccount(Kind.Msa);
        MandateModule first = _createModule(account, BondedTypes.MandateMode.Enforce);

        // Not installed yet: the account may still replace it.
        MandateModule second = _createModule(account, BondedTypes.MandateMode.Enforce);
        assertTrue(address(second) != address(first));
        _install(account, address(second), EXECUTOR);

        BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Monitor);
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateModuleFactory.ModuleStillInstalled.selector, address(second)
            )
        );
        vm.prank(account);
        moduleFactory.createModule(p, agent, guardian, agentId);

        _uninstall(account, address(second), EXECUTOR);
        MandateModule third = _createModule(account, BondedTypes.MandateMode.Monitor);
        assertEq(moduleFactory.moduleOf(account), address(third));
        assertTrue(moduleFactory.isModule(address(second))); // old modules keep their record
        assertEq(moduleFactory.modulesCreated(account), 3);
    }

    function test_PredictsTheAddressSoOneBatchCreatesAndInstalls() public {
        address account = _newAccount(Kind.Msa);
        BondedTypes.MandateParams memory p = _moduleParams(BondedTypes.MandateMode.Enforce);
        address predicted = moduleFactory.predictModule(account, p, agent, guardian, agentId);

        Execution[] memory batch = new Execution[](3);
        batch[0] = Execution({
            target: address(moduleFactory),
            value: 0,
            callData: abi.encodeCall(
                MandateModuleFactory.createModule, (p, agent, guardian, agentId)
            )
        });
        batch[1] = Execution({
            target: account,
            value: 0,
            callData: abi.encodeCall(ITestAccount.installModule, (EXECUTOR, predicted, ""))
        });
        batch[2] = Execution({
            target: account,
            value: 0,
            callData: abi.encodeCall(ITestAccount.installModule, (HOOK, predicted, ""))
        });
        vm.prank(ENTRY_POINT);
        ITestAccount(account).execute(bytes32(uint256(1) << 248), abi.encode(batch)); // batch mode

        assertEq(moduleFactory.moduleOf(account), predicted);
        assertEq(MandateModule(predicted).installs(), 2);
    }

    function test_ModuleParamsAreValidatedLikeAVault() public {
        address account = _newAccount(Kind.Msa);
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Enforce);
        p.targets[1] = account;
        p.mandateHash = BondedTypes.mandateCommitment(p);
        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(MandateErrors.InvalidParams.selector, "account as target")
        );
        moduleFactory.createModule(p, agent, guardian, agentId);

        // The module's own address can't be a target either (deployed directly here, since
        // through the factory the address depends on the params).
        p = _params(BondedTypes.MandateMode.Enforce);
        p.targets[1] = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(
            abi.encodeWithSelector(MandateErrors.InvalidParams.selector, "module as target")
        );
        new MandateModule(p, account, agent, guardian, agentId, oracle);

        p = _params(BondedTypes.MandateMode.Enforce);
        p.maxDailyNotionalUsd6 = p.maxTxNotionalUsd6 - 1;
        p.mandateHash = BondedTypes.mandateCommitment(p);
        vm.prank(account);
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateErrors.InvalidParams.selector, "daily limit below tx limit"
            )
        );
        moduleFactory.createModule(p, agent, guardian, agentId);

        p = _moduleParams(BondedTypes.MandateMode.Enforce);
        vm.prank(account);
        vm.expectRevert(MandateErrors.ZeroAddress.selector);
        moduleFactory.createModule(p, address(0), guardian, agentId);
    }

    function test_ProtocolAddressesComeFromTheVaultFactory() public {
        assertEq(moduleFactory.coverManager(), address(0));
        vm.startPrank(owner);
        factory.setCoverManager(coverManager);
        factory.setClaimsEngine(claimsEngine);
        vm.stopPrank();
        assertEq(moduleFactory.coverManager(), coverManager);
        assertEq(moduleFactory.claimsEngine(), claimsEngine);
        assertEq(address(moduleFactory.oracle()), address(oracle));
        assertEq(address(moduleFactory.vaultFactory()), address(factory));

        vm.expectRevert(MandateModuleFactory.ZeroAddress.selector);
        new MandateModuleFactory(MandateVaultFactory(address(0)));
    }
}

struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

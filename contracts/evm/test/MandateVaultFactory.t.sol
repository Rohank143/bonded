// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {MandateVaultBase} from "./MandateVaultBase.t.sol";

contract MandateVaultFactoryTest is MandateVaultBase {
    function test_CreatesAndRegistersVaults() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        vm.expectEmit(false, true, true, true);
        emit MandateVaultFactory.VaultCreated(address(0), 42, guardian, agent, p.mandateHash);
        address vaultAddress =
            factory.createVault(p, agent, guardian, 42, "Bonded Vault 42", "bv42");

        MandateVault vault = MandateVault(vaultAddress);
        assertTrue(factory.isVault(vaultAddress));
        assertEq(factory.vaultCount(), 1);
        assertEq(factory.vaultAt(0), vaultAddress);
        assertEq(address(vault.factory()), address(factory));
        assertEq(address(vault.oracle()), address(oracle));
        assertEq(vault.agent(), agent);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.agentId(), 42);
        assertEq(vault.mandateHash(), p.mandateHash);
        assertEq(vault.asset(), address(usdg));
        assertEq(vault.getAssets().length, 3);
        assertTrue(
            vault.isCallAllowed(
                address(router), bytes4(keccak256("swap(address,address,uint256,address)"))
            )
        );
        assertFalse(
            vault.isCallAllowed(address(router), bytes4(keccak256("sweep(address,address)")))
        );
        assertTrue(vault.isCallAllowed(address(reentrant), bytes4(0xdeadbeef))); // any selector
        assertTrue(vault.isDestination(treasury));
        assertFalse(factory.isVault(address(this)));
    }

    function test_CoverManagerAndClaimsEngineAreSetOnceByOwner() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        factory.setCoverManager(coverManager);

        vm.startPrank(owner);
        vm.expectRevert(MandateVaultFactory.ZeroAddress.selector);
        factory.setCoverManager(address(0));
        factory.setCoverManager(coverManager);
        vm.expectRevert(MandateVaultFactory.AlreadySet.selector);
        factory.setCoverManager(attacker);

        factory.setClaimsEngine(claimsEngine);
        vm.expectRevert(MandateVaultFactory.AlreadySet.selector);
        factory.setClaimsEngine(attacker);
        vm.stopPrank();

        assertEq(factory.coverManager(), coverManager);
        assertEq(factory.claimsEngine(), claimsEngine);
    }

    function test_NewOracleAppliesOnlyToNewVaults() public {
        MandateVault first = _createVault(BondedTypes.MandateMode.Monitor);
        MockOracle other = new MockOracle(owner);
        vm.prank(owner);
        factory.setOracle(other);
        MandateVault second = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, 43, "v", "v"
            )
        );
        assertEq(address(first.oracle()), address(oracle));
        assertEq(address(second.oracle()), address(other));
    }

    function test_OwnershipTransferTakesTwoSteps() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        factory.transferOwnership(newOwner);
        assertEq(factory.owner(), owner);
        vm.prank(newOwner);
        factory.acceptOwnership();
        assertEq(factory.owner(), newOwner);
    }

    // ----- Parameter validation -----------------------------------------------------------

    function test_RejectsBaseAssetMissingFromAssets() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        p.baseAsset = address(honeypot);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "base asset not in assets")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");
    }

    function test_RejectsDuplicateAssetsAndTargets() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        p.assets[2] = address(usdg);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "duplicate asset")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");

        p = _params(BondedTypes.MandateMode.Monitor);
        p.targets[1] = address(router);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "duplicate target")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");
    }

    function test_RejectsBadLimits() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        p.maxTxNotionalUsd6 = 0;
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "maxTxNotionalUsd6 is zero")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");

        p = _params(BondedTypes.MandateMode.Monitor);
        p.maxDailyNotionalUsd6 = p.maxTxNotionalUsd6 - 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                MandateVault.InvalidParams.selector, "daily limit below tx limit"
            )
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");

        p = _params(BondedTypes.MandateMode.Monitor);
        p.maxDrawdownBps = 0;
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "maxDrawdownBps")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");

        p = _params(BondedTypes.MandateMode.Monitor);
        p.maxSlippageBps = 10_001;
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "maxSlippageBps")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");
    }

    function test_RejectsMismatchedSelectorsAndTooManyAssets() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        p.selectors = new bytes4[][](1);
        vm.expectRevert(
            abi.encodeWithSelector(MandateVault.InvalidParams.selector, "selectors length")
        );
        factory.createVault(p, agent, guardian, 1, "v", "v");

        p = _params(BondedTypes.MandateMode.Monitor);
        address[] memory many = new address[](17);
        for (uint256 i; i < many.length; ++i) {
            many[i] = address(uint160(0x1000 + i));
        }
        many[0] = address(usdg);
        p.assets = many;
        vm.expectRevert(abi.encodeWithSelector(MandateVault.InvalidParams.selector, "asset count"));
        factory.createVault(p, agent, guardian, 1, "v", "v");
    }

    function test_RejectsZeroAddresses() public {
        BondedTypes.MandateParams memory p = _params(BondedTypes.MandateMode.Monitor);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        factory.createVault(p, address(0), guardian, 1, "v", "v");
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        factory.createVault(p, agent, address(0), 1, "v", "v");

        p.destinations[0] = address(0);
        vm.expectRevert(MandateVault.ZeroAddress.selector);
        factory.createVault(p, agent, guardian, 1, "v", "v");
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateBase} from "../../src/MandateBase.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MandateModule} from "../../src/MandateModule.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockTarget} from "../mocks/MockTargets.sol";
import {ModuleTestBase} from "./ModuleTestBase.sol";

/// @notice Differential tests: the same random sequence of agent actions, outside pulls, price
///         moves, guardian actions and time passing goes to a MandateVault and to a
///         MandateModule on an ERC-7579 account with the same mandate and the same funds. After
///         every step both must agree exactly: call outcome (result or revert data), breach log
///         (every field), freeze state, the 24h window, recorded and actual balances, and the
///         BreachRecorded and Executed events.
abstract contract ModuleDifferentialTests is ModuleTestBase {
    uint256 internal constant STEPS = 16;
    /// @dev Stands for the holder's own address (the vault, or the account) in calldata and
    ///      revert data, so the two runs can be compared word for word.
    address internal constant SELF = address(0x5E1F);

    MandateVault internal vault;
    address internal account;
    MandateModule internal module;

    function mode() internal pure virtual returns (BondedTypes.MandateMode);

    function kind() internal pure virtual returns (Kind);

    function setUp() public override {
        super.setUp();
        vault = _createVault(mode());
        _approveRouter(vault);
        (account, module) = _protectedAccount(kind(), mode());
        _assertSame("setup");
    }

    function testFuzz_SameActionsSameVerdicts(uint256 seed) public {
        for (uint256 i; i < STEPS; ++i) {
            _step(uint256(keccak256(abi.encode(seed, i))));
            _assertSame("step");
        }
    }

    /// @dev A fixed sequence that hits every breach type in both modes, so the comparison
    ///      covers them all whatever the fuzzer picks.
    function test_EveryBreachTypeAgrees() public {
        uint256[2][17] memory steps = [
            [uint256(0), 1000e6], // allowed swap
            [uint256(0), 6000e6], // over the tx limit: Limit
            [uint256(11), 0], // guardian unfreezes
            [uint256(1), 2000e6], // lookalike token: Asset
            [uint256(11), 0],
            [uint256(3), 1000e6], // transfer to the attacker: UnauthorizedTransfer
            [uint256(11), 0],
            [uint256(6), 0], // unknown contract: UnauthorizedTarget
            [uint256(11), 0],
            [uint256(5), 3000e6], // approval to the attacker: UnauthorizedApproval
            [uint256(11), 0],
            [uint256(8), 1000e6], // the attacker pulls (Monitor only): Deferred
            [uint256(9), 500e6], // the router abuses its allowance: Deferred
            [uint256(11), 0],
            [uint256(13), 0], // a failing call: nothing recorded
            [uint256(10), 1 days],
            [uint256(0), 1000e6]
        ];
        for (uint256 i; i < steps.length; ++i) {
            _do(steps[i][0], steps[i][1]);
            _assertSame("fixed");
        }
        bool[6] memory seen;
        for (uint256 i; i < vault.breachCount(); ++i) {
            seen[uint8(vault.getBreach(i).breachType)] = true;
        }
        for (uint256 t; t < seen.length; ++t) {
            assertTrue(seen[t], "every breach type recorded");
        }
    }

    // ----- Steps -------------------------------------------------------------------------

    function _step(uint256 r) internal {
        _do(r % 17, r >> 8);
    }

    function _do(uint256 op, uint256 x) internal {
        if (op == 0) {
            _both(
                address(router),
                abi.encodeCall(
                    MockRouter.swap, (address(usdg), address(tsla), bound(x, 1e6, 8000e6), _self())
                )
            );
        } else if (op == 1) {
            _both(
                address(router),
                abi.encodeCall(
                    MockRouter.swap,
                    (address(usdg), address(honeypot), bound(x, 1e6, 3000e6), _self())
                )
            );
        } else if (op == 2) {
            _both(
                address(router),
                abi.encodeCall(
                    MockRouter.swap, (address(usdg), address(tsla), bound(x, 1e6, 3000e6), attacker)
                )
            );
        } else if (op == 3) {
            _both(address(usdg), abi.encodeCall(IERC20.transfer, (attacker, bound(x, 1, 6000e6))));
        } else if (op == 4) {
            _both(address(usdg), abi.encodeCall(IERC20.transfer, (treasury, bound(x, 1, 6000e6))));
        } else if (op == 5) {
            _both(address(usdg), abi.encodeCall(IERC20.approve, (attacker, bound(x, 1, 10_000e6))));
        } else if (op == 6) {
            _both(address(stranger), abi.encodeCall(MockTarget.ping, ()));
        } else if (op == 7) {
            _both(address(router), abi.encodeCall(MockRouter.sweep, (address(usdg), attacker)));
        } else if (op == 8) {
            // A spender pulls outside execute; anyone reconciles.
            uint256 pulled =
                Math.min(usdg.allowance(address(vault), attacker), usdg.balanceOf(address(vault)));
            pulled = Math.min(pulled, bound(x, 1, 4000e6));
            if (pulled == 0) return;
            vm.startPrank(attacker);
            assertTrue(usdg.transferFrom(address(vault), attacker, pulled));
            assertTrue(usdg.transferFrom(account, attacker, pulled));
            vm.stopPrank();
            _reconcileBoth();
        } else if (op == 9) {
            // The allowed router abuses its allowance outside execute.
            uint256 drained = Math.min(bound(x, 1, 2000e6), usdg.balanceOf(address(vault)));
            if (drained == 0) return;
            router.drain(address(usdg), address(vault), attacker, drained);
            router.drain(address(usdg), account, attacker, drained);
            _reconcileBoth();
        } else if (op == 10) {
            vm.warp(block.timestamp + bound(x, 1 hours, 2 days));
        } else if (op == 11) {
            vm.startPrank(guardian);
            vault.unfreeze();
            module.unfreeze();
            vm.stopPrank();
        } else if (op == 12) {
            uint256 held = tsla.balanceOf(address(vault));
            if (held == 0) return;
            _both(
                address(router),
                abi.encodeCall(
                    MockRouter.swap, (address(tsla), address(usdg), bound(x, 1, held), _self())
                )
            );
        } else if (op == 13) {
            // More than the holder has: the call fails in both, nothing is recorded.
            _both(
                address(router),
                abi.encodeCall(
                    MockRouter.swap,
                    (
                        address(usdg),
                        address(tsla),
                        usdg.balanceOf(address(vault)) + 1 + x % 1e6,
                        _self()
                    )
                )
            );
        } else if (op == 14) {
            _both(address(usdg), abi.encodeCall(IERC20.approve, (attacker, 0)));
        } else if (op == 15) {
            _both(address(usdg), abi.encodeCall(IERC20.transfer, (_self(), bound(x, 1, 1000e6))));
        } else {
            vm.prank(owner);
            oracle.setPrice(address(tsla), bound(x, 100e6, 400e6));
        }
    }

    function _self() internal pure returns (address) {
        return SELF;
    }

    function _both(address target, bytes memory data) internal {
        bytes memory vaultData = _swapWord(data, SELF, address(vault));
        bytes memory moduleData = _swapWord(data, SELF, account);

        vm.recordLogs();
        vm.prank(agent);
        (bool vaultOk, bytes memory vaultOut) =
            address(vault).call(abi.encodeCall(MandateBase.execute, (target, vaultData)));
        Vm.Log[] memory vaultLogs = vm.getRecordedLogs();

        vm.recordLogs();
        vm.prank(agent);
        (bool moduleOk, bytes memory moduleOut) =
            address(module).call(abi.encodeCall(MandateBase.execute, (target, moduleData)));
        Vm.Log[] memory moduleLogs = vm.getRecordedLogs();

        assertEq(vaultOk, moduleOk, "same outcome");
        // A Safe reports a failed target call as its own ExecutionFailed(); otherwise the bytes
        // (return data, or revert data) must match.
        if (vaultOk || kind() == Kind.Msa) {
            assertEq(
                _swapWord(vaultOut, address(vault), SELF),
                _swapWord(moduleOut, account, SELF),
                "same output"
            );
        }
        _assertSameEvents(vaultLogs, moduleLogs);
    }

    function _reconcileBoth() internal {
        vm.recordLogs();
        vault.reconcile();
        Vm.Log[] memory vaultLogs = vm.getRecordedLogs();
        vm.recordLogs();
        module.reconcile();
        _assertSameEvents(vaultLogs, vm.getRecordedLogs());
    }

    /// @dev Copy of `data` with every 32-byte argument word equal to `from` set to `to`.
    function _swapWord(bytes memory data, address from, address to)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(data.length);
        for (uint256 i; i < data.length; ++i) {
            out[i] = data[i];
        }
        for (uint256 offset = 4; offset + 32 <= out.length; offset += 32) {
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(out, 0x20), offset))
            }
            if (word == bytes32(uint256(uint160(from)))) {
                bytes32 replacement = bytes32(uint256(uint160(to)));
                assembly ("memory-safe") {
                    mstore(add(add(out, 0x20), offset), replacement)
                }
            }
        }
    }

    // ----- Comparisons -------------------------------------------------------------------

    function _assertSameEvents(Vm.Log[] memory a, Vm.Log[] memory b) internal view {
        (bytes32[] memory topicsA, bytes[] memory dataA, uint256 frozenA) =
            _verdictEvents(a, address(vault));
        (bytes32[] memory topicsB, bytes[] memory dataB, uint256 frozenB) =
            _verdictEvents(b, address(module));
        assertEq(topicsA.length, topicsB.length, "same number of verdict events");
        for (uint256 i; i < topicsA.length; ++i) {
            assertEq(topicsA[i], topicsB[i], "same event topics");
            assertEq(dataA[i], dataB[i], "same event data");
        }
        assertEq(frozenA, frozenB, "same Frozen events");
    }

    /// @dev BreachRecorded and Executed events emitted by `emitter` (topics hashed together).
    function _verdictEvents(Vm.Log[] memory logs, address emitter)
        internal
        pure
        returns (bytes32[] memory topics, bytes[] memory data, uint256 frozen)
    {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != emitter) continue;
            bytes32 sig = logs[i].topics[0];
            if (sig == MandateBase.BreachRecorded.selector || sig == MandateBase.Executed.selector) ++n;
            if (sig == MandateBase.Frozen.selector) ++frozen;
        }
        topics = new bytes32[](n);
        data = new bytes[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != emitter) continue;
            bytes32 sig = logs[i].topics[0];
            if (sig != MandateBase.BreachRecorded.selector && sig != MandateBase.Executed.selector) continue;
            topics[n] = keccak256(abi.encode(logs[i].topics));
            data[n++] = logs[i].data;
        }
    }

    function _assertSame(string memory where) internal view {
        assertEq(vault.breachCount(), module.breachCount(), where);
        for (uint256 i; i < vault.breachCount(); ++i) {
            MandateBase.Breach memory a = vault.getBreach(i);
            MandateBase.Breach memory b = module.getBreach(i);
            assertEq(uint8(a.breachType), uint8(b.breachType), "breach type");
            assertEq(a.blocked, b.blocked, "blocked");
            assertEq(a.claimed, b.claimed, "claimed");
            assertEq(a.target, b.target, "target");
            assertEq(a.selector, b.selector, "selector");
            assertEq(a.timestamp, b.timestamp, "timestamp");
            assertEq(a.lossUsd6, b.lossUsd6, "loss");
        }
        assertEq(vault.frozen(), module.frozen(), "frozen");
        assertEq(vault.agent(), module.agent(), "agent");
        assertEq(vault.windowStart(), module.windowStart(), "window start");
        assertEq(vault.windowNotionalUsd6(), module.windowNotionalUsd6(), "window notional");
        address[] memory assets = vault.getAssets();
        for (uint256 i; i < assets.length; ++i) {
            assertEq(
                vault.recordedBalance(assets[i]), module.recordedBalance(assets[i]), "recorded"
            );
            assertEq(
                IERC20(assets[i]).balanceOf(address(vault)),
                IERC20(assets[i]).balanceOf(account),
                "balance"
            );
        }
        assertEq(honeypot.balanceOf(address(vault)), honeypot.balanceOf(account), "honeypot");
    }
}

contract ModuleDifferentialMonitorMsaTest is ModuleDifferentialTests {
    function mode() internal pure override returns (BondedTypes.MandateMode) {
        return BondedTypes.MandateMode.Monitor;
    }

    function kind() internal pure override returns (Kind) {
        return Kind.Msa;
    }
}

contract ModuleDifferentialEnforceMsaTest is ModuleDifferentialTests {
    function mode() internal pure override returns (BondedTypes.MandateMode) {
        return BondedTypes.MandateMode.Enforce;
    }

    function kind() internal pure override returns (Kind) {
        return Kind.Msa;
    }
}

contract ModuleDifferentialMonitorSafeTest is ModuleDifferentialTests {
    function mode() internal pure override returns (BondedTypes.MandateMode) {
        return BondedTypes.MandateMode.Monitor;
    }

    function kind() internal pure override returns (Kind) {
        return Kind.Safe;
    }
}

contract ModuleDifferentialEnforceSafeTest is ModuleDifferentialTests {
    function mode() internal pure override returns (BondedTypes.MandateMode) {
        return BondedTypes.MandateMode.Enforce;
    }

    function kind() internal pure override returns (Kind) {
        return Kind.Safe;
    }
}

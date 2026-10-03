#!/usr/bin/env python3
"""Plants one known bug at a time in the contracts and checks the matching invariant catches it.

Each mutation edits one line of src/, runs the named test with the CI profile, and puts the file
back. A mutation "passes" when the test FAILS (the bug was caught). Run from contracts/evm:

    python3 test/invariant/mutations.py
"""

import os
import pathlib
import subprocess
import sys

# (name, file, original, mutated, test to run)
MUTATIONS = [
    (
        "Pool withdrawals ignore locked capital",
        "src/CoverPool.sol",
        "return Math.min(shares, convertToShares(freeCapital()));",
        "return Math.min(shares, convertToShares(totalAssets()));",
        "invariant_WithdrawalsNeverTouchLockedCapital",
    ),
    (
        "Free capital ignores locked capital",
        "src/CoverPool.sol",
        "return total > required ? total - required : 0;",
        "return total;",
        "invariant_FreeCapitalIsAssetsMinusLocked",
    ),
    (
        "Waterfall: pool pays before the bond is used up",
        "src/ClaimsEngine.sol",
        "if (toVault > 0) p.fromBond = bond.slash(policy.agentId, toVault, policy.vault);",
        "if (toVault > 0) p.fromBond = bond.slash(policy.agentId, toVault / 2, policy.vault);",
        "invariant_BondPaysBeforePool",
    ),
    (
        "Deductible not applied",
        "src/ClaimsEngine.sol",
        "Math.mulDiv(p.lossBase, BondedTypes.BPS - deductibleBps, BondedTypes.BPS)",
        "Math.mulDiv(p.lossBase, BondedTypes.BPS, BondedTypes.BPS)",
        "invariant_PayoutWithinLossMinusDeductible",
    ),
    (
        "A breach can be paid twice (both checks removed)",
        "src/ClaimsEngine.sol",
        "if (breach.claimed) revert BreachAlreadyClaimed(breachId);",
        "",
        "invariant_EachBreachPaidOnce",
        ("src/MandateVault.sol", "if (breach.claimed) revert BreachAlreadyClaimed(breachId);", ""),
    ),
    (
        "Closing a policy leaves model-family exposure behind",
        "src/CoverManager.sol",
        "activeCoverOfFamily[policy.modelFamily] -= amount;",
        "",
        "invariant_ActiveCoverMatchesPolicies",
    ),
    (
        "Slash pays out without reducing the bond",
        "src/OperatorBond.sol",
        "bond.amount -= slashed;",
        "",
        "invariant_BondAccounting",
    ),
    (
        "Vault rounds deposits up for the caller",
        "src/MandateVault.sol",
        "    /// @dev Virtual share offset against the ERC-4626 inflation attack.",
        "    function _convertToShares(uint256 a, Math.Rounding) internal view override returns (uint256) {"
        " return Math.mulDiv(a, totalSupply() + 1e6, totalAssets() + 1, Math.Rounding.Ceil); }\n"
        "    /// @dev Virtual share offset against the ERC-4626 inflation attack.",
        "invariant_RoundingFavoursTheVault",
    ),
    (
        "Vault has no virtual share offset",
        "src/MandateVault.sol",
        "        return 6;",
        "        return 0;",
        "testFuzz_InflationAttackDoesNotPay",
    ),
    (
        "Bounty accepted twice (status check removed)",
        "src/BountyBoard.sol",
        "if (s.status != Status.Revealed) revert WrongStatus(s.status);",
        "if (s.status == Status.None) revert WrongStatus(s.status);",
        "invariant_StatusOnlyMovesForward",
    ),
    (
        "Anyone can judge a bounty",
        "src/BountyBoard.sol",
        "    function reject(uint256 id, bytes32 reasonHash) external {\n"
        "        if (!registry.isAttester(msg.sender)) revert NotAttester();",
        "    function reject(uint256 id, bytes32 reasonHash) external {",
        "invariant_StatusOnlyMovesForward",
    ),
]


def run(test: str) -> bool:
    """True if the test passed. Stops the script if the mutant doesn't compile or the test is
    missing, so a broken mutation can never count as caught."""
    env = dict(os.environ, FOUNDRY_PROFILE="ci")
    result = subprocess.run(
        ["forge", "test", "--match-test", test],
        capture_output=True,
        text=True,
        env=env,
    )
    out = result.stdout + result.stderr
    if "Compiler run failed" in out or "No tests" in out:
        raise SystemExit(f"mutant for {test} did not compile or matched no test:\n{out[-2000:]}")
    if result.returncode != 0 and f"[FAIL" not in out:
        raise SystemExit(f"forge failed without a failing test for {test}:\n{out[-2000:]}")
    return result.returncode == 0


def main() -> int:
    caught = 0
    for name, path, original, mutated, test, *extra in MUTATIONS:
        edits = [(path, original, mutated)] + list(extra)
        saved = {}
        try:
            for file, before, after in edits:
                p = pathlib.Path(file)
                saved.setdefault(p, p.read_text())
                text = p.read_text()
                if text.count(before) < 1:
                    raise SystemExit(f"mutation target not found in {file}: {before!r}")
                p.write_text(text.replace(before, after, 1))
            passed = run(test)
        finally:
            for p, text in saved.items():
                p.write_text(text)
        status = "missed" if passed else "caught"
        caught += not passed
        print(f"{status:7} {name}  ({test})")
    print(f"{caught} of {len(MUTATIONS)} planted bugs caught")
    return 0 if caught == len(MUTATIONS) else 1


if __name__ == "__main__":
    sys.exit(main())

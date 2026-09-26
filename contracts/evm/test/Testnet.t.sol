// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DemoRouter} from "../src/testnet/DemoRouter.sol";

contract TestnetContractsTest is Test {
    TestToken internal usdg;
    TestToken internal tsla;
    MockOracle internal oracle;
    DemoRouter internal router;

    function setUp() public {
        usdg = new TestToken("Test USDG", "tUSDG", 6, 100_000);
        tsla = new TestToken("Test Tesla", "tTSLA", 18, 1000);
        oracle = new MockOracle(address(this));
        oracle.setPrice(address(usdg), 1e6);
        oracle.setPrice(address(tsla), 250e6);
        router = new DemoRouter(oracle, 20);
        usdg.mint(address(router), 1_000_000e6);
        tsla.mint(address(router), 10_000e18);
    }

    function test_FaucetIsCapped() public {
        usdg.faucet(100_000e6);
        assertEq(usdg.balanceOf(address(this)), 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(TestToken.FaucetCapExceeded.selector, 100_000e6));
        usdg.faucet(100_000e6 + 1);
    }

    function test_SwapsAtOraclePriceMinusFee() public {
        usdg.faucet(1000e6);
        usdg.approve(address(router), 1000e6);
        uint256 out = router.swap(address(usdg), address(tsla), 1000e6, address(this));
        assertEq(out, 3.992e18); // 4 TSLA minus 0.2%
        assertEq(tsla.balanceOf(address(this)), out);
        assertEq(router.quote(address(tsla), address(usdg), 1e18), 249.5e6);
    }

    function test_RejectsExcessiveFees() public {
        vm.expectRevert(DemoRouter.FeeTooHigh.selector);
        new DemoRouter(oracle, 1001);
    }
}

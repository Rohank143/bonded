// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {AggregatorV3Interface, ChainlinkOracle} from "../src/oracles/ChainlinkOracle.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

contract MockOracleTest is Test {
    address internal owner = makeAddr("owner");
    MockOracle internal oracle;
    MockERC20 internal usdg;
    MockERC20 internal tsla;

    function setUp() public {
        oracle = new MockOracle(owner);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla Stock Token", "TSLA", 18);
    }

    function test_ValuesTokensWithTheirDecimals() public {
        vm.startPrank(owner);
        oracle.setPrice(address(usdg), 1e6);
        oracle.setPrice(address(tsla), 250e6);
        vm.stopPrank();

        assertEq(oracle.valueInUsd6(address(usdg), 1.5e6), 1.5e6);
        assertEq(oracle.valueInUsd6(address(tsla), 2e18), 500e6);
    }

    function test_RevertsWithoutAPrice() public {
        vm.expectRevert(abi.encodeWithSelector(MockOracle.PriceNotSet.selector, address(tsla)));
        oracle.valueInUsd6(address(tsla), 1e18);
    }

    function test_OnlyOwnerSetsPrices() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        oracle.setPrice(address(tsla), 1);
    }
}

contract ChainlinkOracleTest is Test {
    address internal owner = makeAddr("owner");
    MockERC20 internal tsla;
    MockAggregator internal feed;
    MockAggregator internal sequencer;
    ChainlinkOracle internal oracle;

    function setUp() public {
        vm.warp(1_790_000_000);
        tsla = new MockERC20("Tesla Stock Token", "TSLA", 18);
        feed = new MockAggregator(8);
        feed.set(250e8, block.timestamp, block.timestamp); // $250
        sequencer = new MockAggregator(0);
        sequencer.set(0, block.timestamp - 2 hours, block.timestamp); // up for 2 hours

        oracle = new ChainlinkOracle(owner, AggregatorV3Interface(address(sequencer)));
        vm.prank(owner);
        oracle.setFeed(address(tsla), AggregatorV3Interface(address(feed)), 1 hours);
    }

    function test_ValuesWithFeedAndTokenDecimals() public view {
        assertEq(oracle.valueInUsd6(address(tsla), 1e18), 250e6);
        assertEq(oracle.valueInUsd6(address(tsla), 0.5e18), 125e6);
    }

    function test_RevertsWhenFeedMissing() public {
        vm.expectRevert(abi.encodeWithSelector(ChainlinkOracle.FeedNotSet.selector, address(1)));
        oracle.valueInUsd6(address(1), 1);
    }

    function test_RevertsOnStalePrice() public {
        uint256 updatedAt = block.timestamp;
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracle.StalePrice.selector, address(tsla), updatedAt)
        );
        oracle.valueInUsd6(address(tsla), 1e18);
    }

    function test_RevertsOnNonPositivePrice() public {
        feed.set(0, block.timestamp, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracle.InvalidPrice.selector, address(tsla), int256(0))
        );
        oracle.valueInUsd6(address(tsla), 1e18);

        feed.set(-1, block.timestamp, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(ChainlinkOracle.InvalidPrice.selector, address(tsla), int256(-1))
        );
        oracle.valueInUsd6(address(tsla), 1e18);
    }

    function test_RevertsWhenSequencerIsDown() public {
        sequencer.set(1, block.timestamp - 2 hours, block.timestamp);
        vm.expectRevert(ChainlinkOracle.SequencerDown.selector);
        oracle.valueInUsd6(address(tsla), 1e18);
    }

    function test_RevertsDuringSequencerGracePeriod() public {
        sequencer.set(0, block.timestamp - 30 minutes, block.timestamp);
        vm.expectRevert(ChainlinkOracle.SequencerGracePeriod.selector);
        oracle.valueInUsd6(address(tsla), 1e18);
    }

    function test_SkipsSequencerCheckWhenNotConfigured() public {
        ChainlinkOracle l1Oracle = new ChainlinkOracle(owner, AggregatorV3Interface(address(0)));
        vm.prank(owner);
        l1Oracle.setFeed(address(tsla), AggregatorV3Interface(address(feed)), 1 hours);
        assertEq(l1Oracle.valueInUsd6(address(tsla), 1e18), 250e6);
    }

    function test_OnlyOwnerSetsFeeds() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        oracle.setFeed(address(tsla), AggregatorV3Interface(address(feed)), 1);
    }
}

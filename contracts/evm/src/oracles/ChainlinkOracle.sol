// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

/// @notice Minimal Chainlink aggregator interface.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @title ChainlinkOracle
/// @notice Values tokens with Chainlink USD feeds, with staleness and L2 sequencer checks.
/// @dev On Robinhood Chain, Stock Token feeds report total return value (price x multiplier).
contract ChainlinkOracle is IPriceOracle, Ownable {
    struct FeedConfig {
        AggregatorV3Interface feed;
        uint32 heartbeat; // max seconds since the last update
    }

    /// @notice Grace period after the L2 sequencer comes back up before prices are trusted.
    uint256 public constant SEQUENCER_GRACE_PERIOD = 1 hours;

    /// @notice Chainlink L2 sequencer uptime feed, or address(0) to skip the check.
    AggregatorV3Interface public immutable sequencerUptimeFeed;

    mapping(address asset => FeedConfig) public feeds;

    event FeedSet(address indexed asset, address feed, uint32 heartbeat);

    error FeedNotSet(address asset);
    error InvalidPrice(address asset, int256 answer);
    error StalePrice(address asset, uint256 updatedAt);
    error SequencerDown();
    error SequencerGracePeriod();

    constructor(address owner_, AggregatorV3Interface sequencerUptimeFeed_) Ownable(owner_) {
        sequencerUptimeFeed = sequencerUptimeFeed_;
    }

    function setFeed(address asset, AggregatorV3Interface feed, uint32 heartbeat)
        external
        onlyOwner
    {
        feeds[asset] = FeedConfig({feed: feed, heartbeat: heartbeat});
        emit FeedSet(asset, address(feed), heartbeat);
    }

    /// @inheritdoc IPriceOracle
    function valueInUsd6(address asset, uint256 amount) external view returns (uint256) {
        _checkSequencer();
        FeedConfig memory config = feeds[asset];
        if (address(config.feed) == address(0)) revert FeedNotSet(asset);

        (, int256 answer,, uint256 updatedAt,) = config.feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice(asset, answer);
        if (block.timestamp - updatedAt > config.heartbeat) revert StalePrice(asset, updatedAt);

        uint256 scale = 10 ** (uint256(config.feed.decimals()) + IERC20Metadata(asset).decimals());
        // casting to 'uint256' is safe because answer > 0 was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return Math.mulDiv(amount, uint256(answer) * 1e6, scale);
    }

    function _checkSequencer() internal view {
        if (address(sequencerUptimeFeed) == address(0)) return;
        (, int256 status, uint256 startedAt,,) = sequencerUptimeFeed.latestRoundData();
        if (status != 0) revert SequencerDown();
        if (block.timestamp - startedAt <= SEQUENCER_GRACE_PERIOD) revert SequencerGracePeriod();
    }
}

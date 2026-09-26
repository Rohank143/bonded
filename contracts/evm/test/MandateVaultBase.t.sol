// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {MockOracle} from "../src/oracles/MockOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockTarget, ReentrantTarget} from "./mocks/MockTargets.sol";

/// @notice Shared setup: a Robinhood-Chain-like world with USDG, two Stock Tokens and a router.
abstract contract MandateVaultBase is Test {
    uint256 internal constant USDG_PRICE = 1e6; // $1
    uint256 internal constant TSLA_PRICE = 250e6; // $250
    uint256 internal constant AMZN_PRICE = 200e6; // $200
    uint256 internal constant DEPOSIT = 40_000e6; // 40,000 USDG
    uint16 internal constant FAIR_SLIPPAGE_BPS = 20; // router keeps 0.2%

    MockERC20 internal usdg;
    MockERC20 internal tsla;
    MockERC20 internal amzn;
    MockERC20 internal honeypot;
    MockOracle internal oracle;
    MockRouter internal router;
    MockTarget internal stranger;
    ReentrantTarget internal reentrant;
    MandateVaultFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal guardian = makeAddr("guardian");
    address internal depositor = makeAddr("depositor");
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");
    address internal coverManager = makeAddr("coverManager");
    address internal claimsEngine = makeAddr("claimsEngine");

    function setUp() public virtual {
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        tsla = new MockERC20("Tesla Stock Token", "TSLA", 18);
        amzn = new MockERC20("Amazon Stock Token", "AMZN", 18);
        honeypot = new MockERC20("Tesla Stock Token", "TSLA", 18); // lookalike, not in any mandate

        oracle = new MockOracle(owner);
        vm.startPrank(owner);
        oracle.setPrice(address(usdg), USDG_PRICE);
        oracle.setPrice(address(tsla), TSLA_PRICE);
        oracle.setPrice(address(amzn), AMZN_PRICE);
        vm.stopPrank();

        router = new MockRouter();
        _setFairRate(usdg, USDG_PRICE, tsla, TSLA_PRICE);
        _setFairRate(tsla, TSLA_PRICE, usdg, USDG_PRICE);
        _setFairRate(usdg, USDG_PRICE, amzn, AMZN_PRICE);
        router.setRate(address(usdg), address(honeypot), 4e27);
        usdg.mint(address(router), 1_000_000e6);
        tsla.mint(address(router), 1000e18);
        amzn.mint(address(router), 1000e18);
        honeypot.mint(address(router), 1_000_000e18);

        stranger = new MockTarget();
        reentrant = new ReentrantTarget();
        factory = new MandateVaultFactory(owner, oracle);
    }

    function _params(BondedTypes.MandateMode mode)
        internal
        view
        returns (BondedTypes.MandateParams memory p)
    {
        address[] memory assets = new address[](3);
        assets[0] = address(usdg);
        assets[1] = address(tsla);
        assets[2] = address(amzn);

        address[] memory targets = new address[](2);
        targets[0] = address(router);
        targets[1] = address(reentrant);
        bytes4[][] memory selectors = new bytes4[][](2);
        selectors[0] = new bytes4[](1);
        selectors[0][0] = MockRouter.swap.selector;
        selectors[1] = new bytes4[](0); // any function

        address[] memory destinations = new address[](1);
        destinations[0] = treasury;

        p = BondedTypes.MandateParams({
            mandateHash: keccak256("demo mandate"),
            mode: mode,
            baseAsset: address(usdg),
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
    }

    function _createVault(BondedTypes.MandateMode mode) internal returns (MandateVault vault) {
        vault = MandateVault(
            factory.createVault(_params(mode), agent, guardian, 42, "Bonded Vault 42", "bv42")
        );
        usdg.mint(depositor, DEPOSIT);
        vm.startPrank(depositor);
        usdg.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, depositor);
        vm.stopPrank();
    }

    function _exec(MandateVault vault, address target, bytes memory data)
        internal
        returns (bytes memory)
    {
        vm.prank(agent);
        return vault.execute(target, data);
    }

    function _approveRouter(MandateVault vault) internal {
        _exec(
            vault,
            address(usdg),
            abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
        );
    }

    function _swapData(address tokenIn, address tokenOut, uint256 amountIn, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(MockRouter.swap, (tokenIn, tokenOut, amountIn, recipient));
    }

    /// @dev Router rate that matches oracle prices minus FAIR_SLIPPAGE_BPS.
    function _setFairRate(MockERC20 tokenIn, uint256 priceIn, MockERC20 tokenOut, uint256 priceOut)
        internal
    {
        uint256 rate =
            priceIn * 10 ** tokenOut.decimals() * 1e18 / (priceOut * 10 ** tokenIn.decimals());
        router.setRate(
            address(tokenIn), address(tokenOut), rate * (10_000 - FAIR_SLIPPAGE_BPS) / 10_000
        );
    }

    function _lastBreach(MandateVault vault) internal view returns (MandateVault.Breach memory) {
        return vault.getBreach(vault.breachCount() - 1);
    }
}

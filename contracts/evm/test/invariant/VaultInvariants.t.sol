// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../../src/libraries/BondedTypes.sol";
import {MandateVault} from "../../src/MandateVault.sol";
import {MockOracle} from "../../src/oracles/MockOracle.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MandateVaultBase} from "../MandateVaultBase.t.sol";

/// @notice Depositors, an agent trading inside its mandate, donations and price moves, against
///         one MandateVault. Records any step where ERC-4626 rounding favoured the caller.
contract VaultHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant OFFSET = 1e6; // 10 ** MandateVault._decimalsOffset()

    MandateVault internal immutable vault;
    MockERC20 internal immutable usdg;
    MockERC20 internal immutable tsla;
    MockOracle internal immutable oracle;
    MockRouter internal immutable router;
    address internal immutable agent;
    address internal immutable guardian;
    address[] internal _actors;

    /// @dev Set when a step breaks a property; the invariant test asserts they stay false.
    bool public roundedForCaller;
    bool public roundTripProfit;
    uint256 public ghostRoundTrips;

    constructor(
        MandateVault vault_,
        MockERC20 usdg_,
        MockERC20 tsla_,
        MockOracle oracle_,
        MockRouter router_,
        address agent_,
        address guardian_,
        address[] memory actors_
    ) {
        vault = vault_;
        usdg = usdg_;
        tsla = tsla_;
        oracle = oracle_;
        router = router_;
        agent = agent_;
        guardian = guardian_;
        _actors = actors_;
    }

    // ----- Depositors --------------------------------------------------------------------

    function deposit(uint256 actorSeed, uint256 assets) external {
        address who = _actor(actorSeed);
        assets = bound(assets, 1, 100_000e6);
        uint256 maxShares =
            Math.mulDiv(assets, vault.totalSupply() + OFFSET, vault.totalAssets() + 1);
        uint256 shares = _deposit(who, assets);
        if (shares > maxShares) roundedForCaller = true;
    }

    function mint(uint256 actorSeed, uint256 shares) external {
        address who = _actor(actorSeed);
        shares = bound(shares, 1, 100_000e12);
        uint256 minAssets = Math.mulDiv(
            shares, vault.totalAssets() + 1, vault.totalSupply() + OFFSET, Math.Rounding.Ceil
        );
        uint256 assets = vault.previewMint(shares);
        usdg.mint(who, assets);
        vm.startPrank(who);
        usdg.approve(address(vault), assets);
        uint256 paid = vault.mint(shares, who);
        vm.stopPrank();
        if (paid < minAssets) roundedForCaller = true;
    }

    function withdraw(uint256 actorSeed, uint256 assets) external {
        address who = _actor(actorSeed);
        uint256 max = vault.maxWithdraw(who);
        if (max == 0) return;
        assets = bound(assets, 1, max);
        uint256 minShares = Math.mulDiv(
            assets, vault.totalSupply() + OFFSET, vault.totalAssets() + 1, Math.Rounding.Ceil
        );
        vm.prank(who);
        uint256 burned = vault.withdraw(assets, who, who);
        if (burned < minShares) roundedForCaller = true;
    }

    function redeem(uint256 actorSeed, uint256 shares) external {
        address who = _actor(actorSeed);
        uint256 max = vault.maxRedeem(who);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        uint256 maxAssets =
            Math.mulDiv(shares, vault.totalAssets() + 1, vault.totalSupply() + OFFSET);
        vm.prank(who);
        uint256 assets = vault.redeem(shares, who, who);
        if (assets > maxAssets) roundedForCaller = true;
    }

    /// @dev Deposit and immediately redeem: must never return more than went in.
    function roundTrip(uint256 actorSeed, uint256 assets) external {
        address who = _actor(actorSeed);
        assets = bound(assets, 1, 100_000e6);
        uint256 shares = _deposit(who, assets);
        if (shares == 0 || vault.maxRedeem(who) < shares) return;
        vm.prank(who);
        uint256 out = vault.redeem(shares, who, who);
        if (out > assets) roundTripProfit = true;
        ++ghostRoundTrips;
    }

    /// @dev Someone sends base asset straight to the vault (the inflation-attack move).
    function donate(uint256 assets) external {
        usdg.mint(address(vault), bound(assets, 1, 50_000e6));
    }

    // ----- The agent and the market ------------------------------------------------------

    function buyTsla(uint256 amount) external {
        uint256 balance = usdg.balanceOf(address(vault));
        if (balance < 2) return;
        _agentSwap(address(usdg), address(tsla), bound(amount, 1, Math.min(balance, 4000e6)));
    }

    function sellTsla(uint256 amount) external {
        uint256 balance = tsla.balanceOf(address(vault));
        if (balance == 0) return;
        _agentSwap(address(tsla), address(usdg), bound(amount, 1, Math.min(balance, 15e18)));
    }

    function movePrice(uint256 priceUsd6) external {
        vm.prank(oracle.owner());
        oracle.setPrice(address(tsla), bound(priceUsd6, 200e6, 300e6));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 2 days));
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    // ----- Internals ---------------------------------------------------------------------

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        usdg.mint(who, assets);
        vm.startPrank(who);
        usdg.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }

    function _agentSwap(address tokenIn, address tokenOut, uint256 amountIn) internal {
        if (vault.frozen()) {
            vm.prank(guardian);
            vault.unfreeze();
        }
        vm.prank(agent);
        vault.execute(
            address(router),
            abi.encodeCall(MockRouter.swap, (tokenIn, tokenOut, amountIn, address(vault)))
        );
    }

    function _actor(uint256 seed) internal view returns (address) {
        return _actors[bound(seed, 0, _actors.length - 1)];
    }
}

/// @notice ERC-4626 invariants for MandateVault: share accounting, rounding direction and
///         resistance to the first-depositor inflation attack.
contract VaultInvariants is StdInvariant, MandateVaultBase {
    MandateVault internal vault;
    VaultHandler internal handler;

    function setUp() public override {
        super.setUp();
        vault = _createVault(BondedTypes.MandateMode.Monitor);
        _approveRouter(vault);
        _exec(
            vault,
            address(tsla),
            abi.encodeCall(IERC20.approve, (address(router), type(uint256).max))
        );
        _setFairRate(tsla, TSLA_PRICE, usdg, USDG_PRICE);

        address[] memory actors = new address[](3);
        actors[0] = depositor;
        actors[1] = makeAddr("depositor2");
        actors[2] = makeAddr("depositor3");
        handler = new VaultHandler(vault, usdg, tsla, oracle, router, agent, guardian, actors);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.mint.selector;
        selectors[2] = VaultHandler.withdraw.selector;
        selectors[3] = VaultHandler.redeem.selector;
        selectors[4] = VaultHandler.roundTrip.selector;
        selectors[5] = VaultHandler.donate.selector;
        selectors[6] = VaultHandler.buyTsla.selector;
        selectors[7] = VaultHandler.sellTsla.selector;
        selectors[8] = VaultHandler.movePrice.selector;
        selectors[9] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Every share belongs to a depositor.
    function invariant_SharesAreAllHeldByDepositors() public view {
        address[] memory who = handler.actors();
        uint256 sum;
        for (uint256 i; i < who.length; ++i) {
            sum += vault.balanceOf(who[i]);
        }
        assertEq(vault.totalSupply(), sum);
    }

    /// @notice Holders can never claim more than the vault's NAV.
    function invariant_SharesNeverPromiseMoreThanNav() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
    }

    /// @notice Deposits, mints, withdrawals and redemptions all round in the vault's favour.
    function invariant_RoundingFavoursTheVault() public view {
        assertFalse(handler.roundedForCaller());
        assertFalse(handler.roundTripProfit());
    }

    /// @notice Withdrawals are paid in the base asset, so no one is promised more base than exists.
    function invariant_MaxWithdrawWithinBaseBalance() public view {
        address[] memory who = handler.actors();
        uint256 base = usdg.balanceOf(address(vault));
        for (uint256 i; i < who.length; ++i) {
            assertLe(vault.maxWithdraw(who[i]), base);
        }
    }

    // ----- Inflation attack (fuzz) -------------------------------------------------------

    /// @notice A first depositor who donates to the empty vault can't profit from the next
    ///         depositor, whatever the sizes, and griefing costs the attacker at least what it
    ///         costs the victim. (A deposit tiny next to the donation can round to 0 shares:
    ///         see docs/AUDIT.md.)
    function testFuzz_InflationAttackDoesNotPay(uint256 seed, uint256 donation, uint256 victimIn)
        public
    {
        MandateVault fresh = MandateVault(
            factory.createVault(
                _params(BondedTypes.MandateMode.Monitor), agent, guardian, agentId, "f", "f"
            )
        );
        seed = bound(seed, 1, 1000e6);
        donation = bound(donation, 1, 10_000_000e6);
        victimIn = bound(victimIn, 1e6, 1_000_000e6);
        address victim = makeAddr("victim");

        usdg.mint(attacker, seed + donation);
        vm.startPrank(attacker);
        usdg.approve(address(fresh), seed);
        fresh.deposit(seed, attacker);
        assertTrue(usdg.transfer(address(fresh), donation));
        vm.stopPrank();

        usdg.mint(victim, victimIn);
        vm.startPrank(victim);
        usdg.approve(address(fresh), victimIn);
        uint256 victimShares = fresh.deposit(victimIn, victim);
        vm.stopPrank();

        vm.startPrank(attacker);
        uint256 out = fresh.redeem(fresh.balanceOf(attacker), attacker, attacker);
        vm.stopPrank();
        assertLe(out, seed + donation); // the attack never pays

        uint256 victimOut = fresh.previewRedeem(victimShares);
        uint256 victimLoss = victimIn > victimOut ? victimIn - victimOut : 0;
        // Griefing costs the attacker more (plus the 1 unit any deposit can lose to rounding).
        assertGe(seed + donation - out + 1, victimLoss);
    }
}

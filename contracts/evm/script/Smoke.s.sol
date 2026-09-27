// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {BondedRegistry} from "../src/BondedRegistry.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {MandateVaultFactory} from "../src/MandateVaultFactory.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {CoverManager} from "../src/CoverManager.sol";
import {ClaimsEngine} from "../src/ClaimsEngine.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DemoRouter} from "../src/testnet/DemoRouter.sol";

/// @notice Runs the demo loop against a deployment: register, vault, bond, fund, quote, bind
///         cover, allowed swap, breach, claim. Reads deployments/<chainId>.json.
/// @dev Keys come from OPERATOR_KEY, AGENT_KEY, USER_KEY and ATTESTER_KEY. On a local anvil
///      chain (31337) they default to anvil's well-known test accounts. The deployment must use
///      WAITING_PERIOD=0, since the script can't advance chain time between steps.
///      On other chains each key falls back to DEPLOYER_PRIVATE_KEY, so a single funded deployer
///      (which is also the attester by default) can play every role.
contract Smoke is Script {
    uint256 internal constant ANVIL_0 =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant ANVIL_1 =
        0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant ANVIL_2 =
        0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 internal constant ANVIL_3 =
        0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;

    struct Env {
        TestToken usdg;
        address tsla;
        address amzn;
        DemoRouter router;
        BondedRegistry registry;
        MandateVaultFactory factory;
        CoverPool pool;
        OperatorBond bond;
        CoverManager manager;
        ClaimsEngine claims;
    }

    struct Keys {
        uint256 operator;
        uint256 agent;
        uint256 user;
        uint256 attester;
    }

    function run() external {
        Env memory e = _load();
        Keys memory k = _keys();
        (uint256 agentId, MandateVault vault) = _registerAndFund(e, k);
        uint256 policyId = _bindCover(e, k, agentId, vault);
        uint256 breachId = _breach(e, k, vault);
        _claim(e, k, agentId, vault, policyId, breachId);
    }

    /// @dev Steps 1-2: register the agent, create its vault, stake the bond, fund pool and vault.
    function _registerAndFund(Env memory e, Keys memory k)
        internal
        returns (uint256 agentId, MandateVault vault)
    {
        address operator = vm.addr(k.operator);
        vm.startBroadcast(k.operator);
        agentId = e.registry.register("ipfs://bonded/agents/smoke.json");
        vault = MandateVault(
            e.factory
                .createVault(
                    _mandate(e), vm.addr(k.agent), operator, agentId, "Bonded Smoke Vault", "bSMOKE"
                )
        );
        e.usdg.faucet(10_000e6);
        e.usdg.approve(address(e.bond), 10_000e6);
        e.bond.stake(agentId, 10_000e6);
        vm.stopBroadcast();

        address user = vm.addr(k.user);
        vm.startBroadcast(k.user);
        e.usdg.faucet(1_000_000e6);
        e.usdg.approve(address(e.pool), 500_000e6);
        e.pool.deposit(500_000e6, user);
        e.usdg.approve(address(vault), 40_000e6);
        vault.deposit(40_000e6, user);
        vm.stopBroadcast();
    }

    /// @dev Step 3: the attester signs a quote and the operator binds cover.
    function _bindCover(Env memory e, Keys memory k, uint256 agentId, MandateVault vault)
        internal
        returns (uint256 policyId)
    {
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: agentId,
            vault: address(vault),
            coverAmount: 20_000e6,
            premiumRateBps: 120,
            score: 96,
            modelFamily: 1,
            mandateHash: vault.mandateHash(),
            reportHash: keccak256("smoke arena report"),
            minBond: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: uint256(keccak256(abi.encode(address(vault), block.timestamp)))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(k.attester, e.manager.quoteDigest(q));
        vm.startBroadcast(k.operator);
        policyId = e.manager.buyCover(q, abi.encodePacked(r, s, v));
        vm.stopBroadcast();
    }

    /// @dev Step 4: an allowed swap, then the agent is tricked into paying an attacker.
    function _breach(Env memory e, Keys memory k, MandateVault vault)
        internal
        returns (uint256 breachId)
    {
        vm.startBroadcast(k.agent);
        vault.execute(
            address(e.usdg), abi.encodeCall(IERC20.approve, (address(e.router), type(uint256).max))
        );
        vault.execute(
            address(e.router),
            abi.encodeCall(DemoRouter.swap, (address(e.usdg), e.tsla, 1000e6, address(vault)))
        );
        vault.execute(address(e.usdg), abi.encodeCall(IERC20.transfer, (address(0xBAD), 5000e6)));
        vm.stopBroadcast();
        require(vault.frozen(), "agent should be frozen after the breach");
        breachId = vault.breachCount() - 1;
    }

    /// @dev Step 5: anyone files the claim; the bond pays first and the vault is refilled.
    function _claim(
        Env memory e,
        Keys memory k,
        uint256 agentId,
        MandateVault vault,
        uint256 policyId,
        uint256 breachId
    ) internal {
        uint256 vaultBefore = e.usdg.balanceOf(address(vault));
        uint256[] memory ids = new uint256[](1);
        ids[0] = breachId;
        vm.startBroadcast(k.user);
        uint256 paid = e.claims.fileClaim(policyId, ids);
        vm.stopBroadcast();

        require(paid == 4500e6, "expected 4,500 payout");
        require(e.usdg.balanceOf(address(vault)) > vaultBefore, "vault should be refilled");
        console2.log("Agent id        ", agentId);
        console2.log("Vault           ", address(vault));
        console2.log("Policy id       ", policyId);
        console2.log("Breach loss usd6", vault.getBreach(breachId).lossUsd6);
        console2.log("Claim paid      ", paid);
        console2.log("Bond remaining  ", e.bond.bondOf(agentId));
        console2.log("Smoke run passed");
    }

    function _mandate(Env memory e) internal pure returns (BondedTypes.MandateParams memory p) {
        address[] memory assets = new address[](3);
        assets[0] = address(e.usdg);
        assets[1] = e.tsla;
        assets[2] = e.amzn;
        address[] memory targets = new address[](1);
        targets[0] = address(e.router);
        bytes4[][] memory selectors = new bytes4[][](1);
        selectors[0] = new bytes4[](1);
        selectors[0][0] = DemoRouter.swap.selector;
        p = BondedTypes.MandateParams({
            mandateHash: keccak256("smoke mandate"),
            mode: BondedTypes.MandateMode.Monitor,
            baseAsset: address(e.usdg),
            assets: assets,
            targets: targets,
            selectors: selectors,
            destinations: new address[](0),
            maxTxNotionalUsd6: 5000e6,
            maxDailyNotionalUsd6: 25_000e6,
            maxDrawdownBps: 1500,
            maxSlippageBps: 300,
            freezeOnBreach: true
        });
    }

    function _load() internal view returns (Env memory e) {
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        // reading our own deployment file is the point of this script
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory json = vm.readFile(path);
        e.usdg = TestToken(vm.parseJsonAddress(json, ".usdg"));
        e.tsla = vm.parseJsonAddress(json, ".tsla");
        e.amzn = vm.parseJsonAddress(json, ".amzn");
        e.router = DemoRouter(vm.parseJsonAddress(json, ".router"));
        e.registry = BondedRegistry(vm.parseJsonAddress(json, ".registry"));
        e.factory = MandateVaultFactory(vm.parseJsonAddress(json, ".factory"));
        e.pool = CoverPool(vm.parseJsonAddress(json, ".pool"));
        e.bond = OperatorBond(vm.parseJsonAddress(json, ".bond"));
        e.manager = CoverManager(vm.parseJsonAddress(json, ".coverManager"));
        e.claims = ClaimsEngine(vm.parseJsonAddress(json, ".claimsEngine"));
    }

    function _keys() internal view returns (Keys memory k) {
        bool local = block.chainid == 31_337;
        uint256 deployer = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        k.attester = vm.envOr("ATTESTER_KEY", local ? ANVIL_0 : deployer);
        k.operator = vm.envOr("OPERATOR_KEY", local ? ANVIL_1 : deployer);
        k.agent = vm.envOr("AGENT_KEY", local ? ANVIL_2 : deployer);
        k.user = vm.envOr("USER_KEY", local ? ANVIL_3 : deployer);
        require(
            k.attester != 0 && k.operator != 0 && k.agent != 0 && k.user != 0, "set the smoke keys"
        );
    }
}

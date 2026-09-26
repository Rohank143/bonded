// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {MandateVault} from "../src/MandateVault.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {OperatorBond} from "../src/OperatorBond.sol";
import {CoverManager} from "../src/CoverManager.sol";
import {ClaimsEngine} from "../src/ClaimsEngine.sol";
import {BondedRegistry} from "../src/BondedRegistry.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {MandateVaultBase} from "./MandateVaultBase.t.sol";

/// @notice The full protocol wired together, with a funded pool, a bonded operator and a vault.
abstract contract ProtocolBase is MandateVaultBase {
    uint256 internal constant POOL_DEPOSIT = 1_000_000e6; // 1M USDG from underwriters
    uint256 internal constant BOND = 10_000e6;
    uint256 internal constant COVER = 20_000e6;
    uint32 internal constant RATE_BPS = 120; // 1.2% a year
    uint16 internal constant SCORE = 96;
    uint8 internal constant CLAUDE = 1; // model family code

    BondedRegistry internal registry;
    CoverPool internal pool;
    OperatorBond internal bond;
    CoverManager internal manager;
    ClaimsEngine internal claims;
    MandateVault internal vault;
    /// @dev A second registered agent owned by the same guardian.
    uint256 internal agentId2;

    address internal attester;
    uint256 internal attesterKey;
    address internal underwriter = makeAddr("underwriter");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal bountyPool = makeAddr("bountyPool");
    uint256 internal quoteNonce;

    function setUp() public virtual override {
        super.setUp();
        (attester, attesterKey) = makeAddrAndKey("attester");

        registry = new BondedRegistry(owner);
        pool = new CoverPool(
            IERC20(address(usdg)), owner, 7 days, "Bonded Underwriting USDG", "bdUSDG"
        );
        bond = new OperatorBond(IERC20(address(usdg)), registry, owner, 7 days);
        manager =
            new CoverManager(owner, registry, factory, pool, bond, protocolTreasury, bountyPool);
        claims = new ClaimsEngine(owner, manager, pool, bond, factory);

        vm.startPrank(owner);
        factory.setCoverManager(address(manager));
        factory.setClaimsEngine(address(claims));
        pool.setCoverManager(manager);
        pool.setClaimsEngine(address(claims));
        bond.setCoverManager(manager);
        bond.setClaimsEngine(address(claims));
        manager.setClaimsEngine(address(claims));
        registry.setAttester(attester, true);
        vm.stopPrank();

        vm.startPrank(guardian);
        agentId = registry.register("ipfs://bonded/agents/1.json");
        agentId2 = registry.register("ipfs://bonded/agents/2.json");
        vm.stopPrank();

        _depositToPool(underwriter, POOL_DEPOSIT);
        vault = _createVault(BondedTypes.MandateMode.Monitor);
        _approveRouter(vault);
        _stake(agentId, BOND);
    }

    // ----- Helpers -----------------------------------------------------------------------

    function _depositToPool(address who, uint256 amount) internal {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _stake(uint256 id, uint256 amount) internal {
        usdg.mint(guardian, amount);
        vm.startPrank(guardian);
        usdg.approve(address(bond), amount);
        bond.stake(id, amount);
        vm.stopPrank();
    }

    function _quote(MandateVault v, uint256 cover, uint32 rateBps, uint16 score)
        internal
        returns (BondedTypes.Quote memory q)
    {
        q = BondedTypes.Quote({
            agentId: v.agentId(),
            vault: address(v),
            coverAmount: cover,
            premiumRateBps: rateBps,
            score: score,
            modelFamily: CLAUDE,
            mandateHash: v.mandateHash(),
            reportHash: keccak256("arena report"),
            minBond: 0,
            expiresAt: uint64(block.timestamp + 1 hours),
            nonce: ++quoteNonce
        });
    }

    function _sign(BondedTypes.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, manager.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _buy(MandateVault v, BondedTypes.Quote memory q) internal returns (uint256 policyId) {
        bytes memory signature = _sign(q, attesterKey);
        vm.prank(v.guardian());
        policyId = manager.buyCover(q, signature);
    }

    function _bindDefault() internal returns (uint256) {
        return _buy(vault, _quote(vault, COVER, RATE_BPS, SCORE));
    }

    function _policy(uint256 policyId) internal view returns (ICoverManager.Policy memory) {
        return manager.getPolicy(policyId);
    }

    function _expectedPremium(uint256 cover, uint32 rateBps, uint256 elapsed)
        internal
        pure
        returns (uint256)
    {
        uint256 numerator = cover * rateBps * elapsed;
        uint256 denominator = 10_000 * 365 days;
        return (numerator + denominator - 1) / denominator; // rounded up, like the contract
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
    }
}

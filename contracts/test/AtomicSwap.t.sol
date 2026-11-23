// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";

import {AtomicSwap} from "../src/AtomicSwap.sol";
import {KycRegistry} from "../src/KycRegistry.sol";
import {LedgerForwarder} from "../src/LedgerForwarder.sol";
import {LedgerToken} from "../src/LedgerToken.sol";
import {TravelRuleCompliance} from "../src/TravelRuleCompliance.sol";
import {IAtomicSwap, Quote} from "../src/interfaces/IAtomicSwap.sol";
import {AccountKind, IKycRegistry} from "../src/interfaces/IKycRegistry.sol";

contract SwapVectorToken is ERC20 {
    constructor() ERC20("Vector Token", "VEC") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract AtomicSwapTest is Test {
    bytes32 private constant REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant MAKER_KEY = 4;
    uint256 private constant TAKER_KEY = 3;
    address private constant VASP_A_ADMIN = address(0xA1);
    address private constant VASP_B_ADMIN = address(0xB1);

    KycRegistry private registry;
    LedgerForwarder private forwarder;
    AtomicSwap private swap;
    LedgerToken private yen;
    LedgerToken private dollars;
    address private maker;
    address private taker;

    function setUp() public {
        vm.warp(1000);
        maker = vm.addr(MAKER_KEY);
        taker = vm.addr(TAKER_KEY);

        KycRegistry implementation = new KycRegistry();
        registry = KycRegistry(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IKycRegistry.initialize, (address(this)))))
        );
        registry.registerVasp(1, VASP_A_ADMIN, VASP_A_ADMIN, "VASP A", "");
        registry.registerVasp(2, VASP_B_ADMIN, VASP_B_ADMIN, "VASP B", "");
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(taker, AccountKind.CUSTOMER, 0);
        vm.prank(VASP_B_ADMIN);
        registry.registerAccount(maker, AccountKind.VASP_TREASURY, 0);

        forwarder = new LedgerForwarder(address(registry));
        TravelRuleCompliance compliance = new TravelRuleCompliance(address(registry), address(this));
        yen = new LedgerToken(
            "Test Yen", "tJPY", address(registry), address(compliance), address(forwarder), address(this)
        );
        dollars = new LedgerToken(
            "Test Dollar", "tUSD", address(registry), address(compliance), address(forwarder), address(this)
        );
        swap = new AtomicSwap(address(forwarder), address(this));
        swap.setSupportedToken(address(yen), true);
        swap.setSupportedToken(address(dollars), true);
        yen.addAgent(address(this));
        dollars.addAgent(address(this));
        yen.mint(taker, 1_000);
        dollars.mint(maker, 20);
        vm.prank(maker);
        dollars.approve(address(swap), type(uint256).max);
    }

    function testFillsBothLegsAndConsumesNonce() public {
        Quote memory quote = _quote();
        _approve(quote.takerAmount);
        bytes memory signature = _sign(quote);
        bytes32 digest = swap.hashQuote(quote);
        vm.expectEmit(true, true, true, true, address(swap));
        emit IAtomicSwap.Filled(digest, maker, taker, address(dollars), 15, address(yen), 100);
        vm.prank(taker);
        swap.fill(quote, signature);
        _assertFilled();
        assertTrue(swap.isNonceUsed(maker, quote.nonce));

        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.QuoteNonceUsed.selector, maker, quote.nonce));
        vm.prank(taker);
        swap.fill(quote, signature);
    }

    function testRejectsOtherCallerTamperingExpiryAndUnsupportedTokens() public {
        Quote memory quote = _quote();
        bytes memory signature = _sign(quote);
        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.NotTaker.selector, address(this)));
        swap.fill(quote, signature);

        quote.makerAmount += 1;
        vm.expectRevert(IAtomicSwap.InvalidMakerSignature.selector);
        vm.prank(taker);
        swap.fill(quote, signature);
        assertFalse(swap.isNonceUsed(maker, quote.nonce));

        quote = _quote();
        swap.setSupportedToken(address(dollars), false);
        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.UnsupportedToken.selector, address(dollars)));
        vm.prank(taker);
        swap.fill(quote, signature);

        swap.setSupportedToken(address(dollars), true);
        quote.makerToken = address(yen);
        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.IdenticalTokens.selector, address(yen)));
        vm.prank(taker);
        swap.fill(quote, signature);

        quote = _quote();
        vm.warp(quote.expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.QuoteExpired.selector, quote.expiry));
        vm.prank(taker);
        swap.fill(quote, signature);
    }

    function testCancelOnlyChangesTheCallersNonce() public {
        Quote memory quote = _quote();
        bytes memory signature = _sign(quote);
        vm.prank(taker);
        swap.cancel(quote.nonce);
        assertFalse(swap.isNonceUsed(maker, quote.nonce));

        vm.prank(maker);
        swap.cancel(quote.nonce);
        vm.expectRevert(abi.encodeWithSelector(IAtomicSwap.QuoteNonceUsed.selector, maker, quote.nonce));
        vm.prank(taker);
        swap.fill(quote, signature);
    }

    function testMakerShortfallRollsBackFirstLegAllowanceAndNonce() public {
        Quote memory quote = _quote();
        quote.makerAmount = 21;
        _approve(quote.takerAmount);
        bytes memory signature = _sign(quote);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.InsufficientUnfrozenBalance.selector, maker, 20, 21));
        vm.prank(taker);
        swap.fill(quote, signature);

        _assertUnfilled();
        assertEq(yen.allowance(taker, address(swap)), quote.takerAmount);
        assertFalse(swap.isNonceUsed(maker, quote.nonce));
    }

    function testForwarderBatchesApproveAndFill() public {
        Quote memory quote = _quote();
        forwarder.executeAll(_batch(quote, _sign(quote)));
        _assertFilled();
        assertEq(yen.allowance(taker, address(swap)), 0);
        assertEq(forwarder.nonces(taker), 2);
    }

    function testBlockedTakerCannotApproveOrSwap() public {
        Quote memory quote = _quote();
        bytes memory signature = _sign(quote);
        ERC2771Forwarder.ForwardRequestData[] memory requests = _batch(quote, signature);
        registry.blockAccount(taker, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(LedgerForwarder.SignerNotAllowed.selector, taker));
        forwarder.executeAll(requests);
        assertEq(yen.allowance(taker, address(swap)), 0);
        assertEq(forwarder.nonces(taker), 0);
        assertFalse(swap.isNonceUsed(maker, quote.nonce));

        _approve(quote.takerAmount);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountNotEligible.selector, taker));
        vm.prank(taker);
        swap.fill(quote, signature);
        _assertUnfilled();
    }

    function testAcceptsTypeScriptQuoteVector() public {
        string memory json = vm.readFile("../packages/shared/test/vectors/quote.json");
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        address verifier = vm.parseJsonAddress(json, ".domain.verifyingContract");
        vm.etch(verifier, address(swap).code);
        AtomicSwap vectorSwap = AtomicSwap(verifier);
        // Etching the fixed verifier copies code without the constructor's owner storage.
        vm.prank(address(0));
        vectorSwap.transferOwnership(address(this));
        Quote memory quote = Quote({
            maker: vm.parseJsonAddress(json, ".message.maker"),
            taker: vm.parseJsonAddress(json, ".message.taker"),
            makerToken: vm.parseJsonAddress(json, ".message.makerToken"),
            takerToken: vm.parseJsonAddress(json, ".message.takerToken"),
            makerAmount: vm.parseUint(vm.parseJsonString(json, ".message.makerAmount")),
            takerAmount: vm.parseUint(vm.parseJsonString(json, ".message.takerAmount")),
            expiry: uint64(vm.parseUint(vm.parseJsonString(json, ".message.expiry"))),
            nonce: vm.parseUint(vm.parseJsonString(json, ".message.nonce"))
        });
        bytes memory tokenCode = address(new SwapVectorToken()).code;
        vm.etch(quote.makerToken, tokenCode);
        vm.etch(quote.takerToken, tokenCode);
        vectorSwap.setSupportedToken(quote.makerToken, true);
        vectorSwap.setSupportedToken(quote.takerToken, true);
        SwapVectorToken(quote.makerToken).mint(quote.maker, quote.makerAmount);
        SwapVectorToken(quote.takerToken).mint(quote.taker, quote.takerAmount);
        vm.prank(quote.maker);
        IERC20(quote.makerToken).approve(verifier, quote.makerAmount);
        vm.prank(quote.taker);
        IERC20(quote.takerToken).approve(verifier, quote.takerAmount);

        assertEq(vectorSwap.hashQuote(quote), vm.parseJsonBytes32(json, ".hash"));
        bytes memory signature = vm.parseJsonBytes(json, ".signature");
        vm.prank(quote.taker);
        vectorSwap.fill(quote, signature);
        assertEq(IERC20(quote.makerToken).balanceOf(quote.taker), quote.makerAmount);
        assertEq(IERC20(quote.takerToken).balanceOf(quote.maker), quote.takerAmount);
    }

    function _approve(uint256 amount) private {
        vm.prank(taker);
        yen.approve(address(swap), amount);
    }

    function _quote() private view returns (Quote memory) {
        return Quote({
            maker: maker,
            taker: taker,
            makerToken: address(dollars),
            takerToken: address(yen),
            makerAmount: 15,
            takerAmount: 100,
            expiry: 2_000,
            nonce: 1
        });
    }

    function _sign(Quote memory quote) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, swap.hashQuote(quote));
        return abi.encodePacked(r, s, v);
    }

    function _batch(Quote memory quote, bytes memory signature)
        private
        view
        returns (ERC2771Forwarder.ForwardRequestData[] memory requests)
    {
        requests = new ERC2771Forwarder.ForwardRequestData[](2);
        requests[0] = _request(address(yen), abi.encodeCall(IERC20.approve, (address(swap), quote.takerAmount)), 0);
        requests[1] = _request(address(swap), abi.encodeCall(IAtomicSwap.fill, (quote, signature)), 1);
    }

    function _request(address target, bytes memory data, uint256 nonce)
        private
        view
        returns (ERC2771Forwarder.ForwardRequestData memory request)
    {
        uint48 deadline = 2_000;
        uint256 gasLimit = 600_000;
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("ledgerA Forwarder"), keccak256("1"), block.chainid, address(forwarder)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(REQUEST_TYPEHASH, taker, target, 0, gasLimit, nonce, deadline, keccak256(data)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(TAKER_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        request = ERC2771Forwarder.ForwardRequestData({
            from: taker,
            to: target,
            value: 0,
            gas: gasLimit,
            deadline: deadline,
            data: data,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _assertFilled() private view {
        assertEq(yen.balanceOf(taker), 900);
        assertEq(yen.balanceOf(maker), 100);
        assertEq(dollars.balanceOf(taker), 15);
        assertEq(dollars.balanceOf(maker), 5);
        assertEq(yen.balanceOf(address(swap)), 0);
        assertEq(dollars.balanceOf(address(swap)), 0);
    }

    function _assertUnfilled() private view {
        assertEq(yen.balanceOf(taker), 1_000);
        assertEq(yen.balanceOf(maker), 0);
        assertEq(dollars.balanceOf(taker), 0);
        assertEq(dollars.balanceOf(maker), 20);
    }
}

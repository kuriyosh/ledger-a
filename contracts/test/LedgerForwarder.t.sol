// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";

import {KycRegistry} from "../src/KycRegistry.sol";
import {LedgerForwarder} from "../src/LedgerForwarder.sol";
import {AccountKind, IKycRegistry, VaspStatus} from "../src/interfaces/IKycRegistry.sol";

contract ForwardedToken is ERC20, ERC2771Context {
    address public lastSender;

    error TargetRejected(uint256 code);

    constructor(address forwarder) ERC20("Forwarded Token", "FWD") ERC2771Context(forwarder) {}

    function record() external {
        lastSender = _msgSender();
    }

    function fail() external pure {
        revert TargetRejected(42);
    }

    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}

contract LedgerForwarderTest is Test {
    bytes32 private constant REQUEST_TYPE_HASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );
    bytes32 private constant DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant SIGNER_KEY = 3;
    address private constant VASP_ADMIN = address(0xA1);
    address private constant SPENDER = address(0xB2);

    KycRegistry private registry;
    LedgerForwarder private forwarder;
    ForwardedToken private token;
    address private signer;

    function setUp() public {
        vm.warp(1000);
        signer = vm.addr(SIGNER_KEY);
        KycRegistry implementation = new KycRegistry();
        registry = KycRegistry(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IKycRegistry.initialize, (address(this)))))
        );
        registry.registerVasp(1, VASP_ADMIN, VASP_ADMIN, "VASP A", "");
        vm.prank(VASP_ADMIN);
        registry.registerAccount(signer, AccountKind.CUSTOMER, 0);
        forwarder = new LedgerForwarder(address(registry));
        token = new ForwardedToken(address(forwarder));
    }

    function testUsesTheSignerAsSenderAndIncrementsNonce() public {
        ERC2771Forwarder.ForwardRequestData memory request =
            _request(SIGNER_KEY, abi.encodeCall(ForwardedToken.record, ()), 0, uint48(block.timestamp));
        assertTrue(forwarder.verify(request));
        forwarder.execute(request);
        assertEq(token.lastSender(), signer);
        assertEq(forwarder.nonces(signer), 1);
        assertFalse(forwarder.verify(request));
    }

    function testReportsTargetRevertAndRetainsNonce() public {
        ERC2771Forwarder.ForwardRequestData memory request =
            _request(SIGNER_KEY, abi.encodeCall(ForwardedToken.fail, ()), 0, uint48(block.timestamp + 100));
        vm.expectRevert(abi.encodeWithSelector(ForwardedToken.TargetRejected.selector, 42));
        forwarder.execute(request);
        assertEq(forwarder.nonces(signer), 0);
    }

    function testExecuteAllRevertsEarlierWritesAndNonces() public {
        uint48 deadline = uint48(block.timestamp + 100);
        ERC2771Forwarder.ForwardRequestData[] memory requests = new ERC2771Forwarder.ForwardRequestData[](2);
        requests[0] = _request(SIGNER_KEY, abi.encodeCall(ERC20.approve, (SPENDER, 10)), 0, deadline);
        requests[1] = _request(SIGNER_KEY, abi.encodeCall(ForwardedToken.fail, ()), 1, deadline);

        vm.expectRevert(abi.encodeWithSelector(ForwardedToken.TargetRejected.selector, 42));
        forwarder.executeAll(requests);
        assertEq(token.allowance(signer, SPENDER), 0);
        assertEq(forwarder.nonces(signer), 0);
    }

    function testRejectsTamperingWrongNonceAndExpiry() public {
        bytes memory data = abi.encodeCall(ForwardedToken.record, ());
        uint48 deadline = uint48(block.timestamp + 100);
        ERC2771Forwarder.ForwardRequestData memory mismatched = _request(SIGNER_KEY, data, 1, deadline);
        vm.expectPartialRevert(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector);
        forwarder.execute(mismatched);

        ERC2771Forwarder.ForwardRequestData memory valid = _request(SIGNER_KEY, data, 0, deadline);
        bytes memory original = valid.data;
        valid.data = abi.encodeCall(ERC20.approve, (SPENDER, 1));
        vm.expectPartialRevert(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector);
        forwarder.execute(valid);

        valid.data = original;
        valid.to = address(registry);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC2771Forwarder.ERC2771UntrustfulTarget.selector, address(registry), address(forwarder)
            )
        );
        forwarder.execute(valid);

        valid.to = address(token);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(ERC2771Forwarder.ERC2771ForwarderExpiredRequest.selector, deadline));
        forwarder.execute(valid);
        assertEq(forwarder.nonces(signer), 0);
    }

    function testFuzzKycGuardAppliesToAllExecutionEntries(uint8 rawCondition) public {
        uint256 condition = bound(rawCondition, 0, 4);
        uint256 key = SIGNER_KEY;
        if (condition == 0) {
            key = 4;
        } else if (condition == 1) {
            vm.prank(VASP_ADMIN);
            registry.suspendAccount(signer, bytes32(0));
        } else if (condition == 2) {
            registry.blockAccount(signer, bytes32(0));
        } else if (condition == 3) {
            uint64 expiry = uint64(block.timestamp);
            vm.prank(VASP_ADMIN);
            registry.renewAccount(signer, expiry);
            vm.warp(expiry + 1);
        } else {
            registry.setVaspStatus(1, VaspStatus.SUSPENDED);
        }

        ERC2771Forwarder.ForwardRequestData memory request =
            _request(key, abi.encodeCall(ERC20.approve, (SPENDER, 10)), 0, uint48(block.timestamp + 100));
        ERC2771Forwarder.ForwardRequestData[] memory requests = new ERC2771Forwarder.ForwardRequestData[](1);
        requests[0] = request;
        bytes memory expected = abi.encodeWithSelector(LedgerForwarder.SignerNotAllowed.selector, request.from);
        assertFalse(forwarder.verify(request));
        vm.expectRevert(expected);
        forwarder.execute(request);
        vm.expectRevert(expected);
        forwarder.executeAll(requests);
        vm.expectRevert(expected);
        forwarder.executeBatch(requests, payable(address(0)));
        assertEq(forwarder.nonces(request.from), 0);
        assertEq(token.allowance(request.from, SPENDER), 0);
    }

    function testUnblockingAllowsTheOriginalApproval() public {
        ERC2771Forwarder.ForwardRequestData memory approval =
            _request(SIGNER_KEY, abi.encodeCall(ERC20.approve, (SPENDER, 15)), 0, uint48(block.timestamp + 100));
        registry.blockAccount(signer, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(LedgerForwarder.SignerNotAllowed.selector, signer));
        forwarder.execute(approval);
        assertEq(forwarder.nonces(signer), 0);

        registry.unblockAccount(signer);
        forwarder.execute(approval);
        assertEq(token.allowance(signer, SPENDER), 15);
        assertEq(forwarder.nonces(signer), 1);
    }

    function testRejectsNonzeroRequestValue() public {
        ERC2771Forwarder.ForwardRequestData memory request =
            _request(SIGNER_KEY, abi.encodeCall(ForwardedToken.record, ()), 0, uint48(block.timestamp + 100));
        request.value = 1;
        bytes memory expected = abi.encodeWithSelector(ERC2771Forwarder.ERC2771ForwarderMismatchedValue.selector, 1, 0);
        vm.expectRevert(expected);
        forwarder.execute(request);

        ERC2771Forwarder.ForwardRequestData[] memory requests = new ERC2771Forwarder.ForwardRequestData[](1);
        requests[0] = request;
        vm.expectRevert(expected);
        forwarder.executeBatch(requests, payable(address(0)));
    }

    function testAcceptsTypeScriptVector() public {
        string memory json = vm.readFile("../packages/shared/test/vectors/forward-request.json");
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        address verifier = vm.parseJsonAddress(json, ".domain.verifyingContract");
        vm.etch(verifier, address(forwarder).code);
        forwarder = LedgerForwarder(verifier);

        address target = vm.parseJsonAddress(json, ".message.to");
        vm.etch(target, address(new ForwardedToken(verifier)).code);
        ERC2771Forwarder.ForwardRequestData memory request = ERC2771Forwarder.ForwardRequestData({
            from: vm.parseJsonAddress(json, ".message.from"),
            to: target,
            value: vm.parseUint(vm.parseJsonString(json, ".message.value")),
            gas: vm.parseUint(vm.parseJsonString(json, ".message.gas")),
            deadline: uint48(vm.parseJsonUint(json, ".message.deadline")),
            data: vm.parseJsonBytes(json, ".message.data"),
            signature: vm.parseJsonBytes(json, ".signature")
        });
        assertEq(forwarder.nonces(request.from), vm.parseUint(vm.parseJsonString(json, ".message.nonce")));
        assertEq(_digest(request, 0), vm.parseJsonBytes32(json, ".hash"));
        assertTrue(forwarder.verify(request));
        forwarder.execute(request);
        assertEq(ForwardedToken(target).lastSender(), request.from);
    }

    function _request(uint256 key, bytes memory data, uint256 nonce, uint48 deadline)
        private
        view
        returns (ERC2771Forwarder.ForwardRequestData memory)
    {
        ERC2771Forwarder.ForwardRequestData memory request = ERC2771Forwarder.ForwardRequestData({
            from: vm.addr(key),
            to: address(token),
            value: 0,
            gas: 100_000,
            deadline: deadline,
            data: data,
            signature: ""
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(request, nonce));
        request.signature = abi.encodePacked(r, s, v);
        return request;
    }

    function _digest(ERC2771Forwarder.ForwardRequestData memory request, uint256 nonce) private view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPE_HASH, keccak256("ledgerA Forwarder"), keccak256("1"), block.chainid, address(forwarder)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                REQUEST_TYPE_HASH,
                request.from,
                request.to,
                request.value,
                request.gas,
                nonce,
                request.deadline,
                keccak256(request.data)
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }
}

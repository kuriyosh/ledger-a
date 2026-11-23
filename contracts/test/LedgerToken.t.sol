// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Test} from "forge-std/Test.sol";

import {KycRegistry} from "../src/KycRegistry.sol";
import {LedgerForwarder} from "../src/LedgerForwarder.sol";
import {LedgerToken} from "../src/LedgerToken.sol";
import {TravelRuleCompliance} from "../src/TravelRuleCompliance.sol";
import {AccountKind, IKycRegistry, VaspStatus} from "../src/interfaces/IKycRegistry.sol";
import {ITravelRuleCompliance, TravelRuleAttestation} from "../src/interfaces/ITravelRuleCompliance.sol";

contract LedgerTokenTest is Test {
    bytes32 private constant REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant ALICE_KEY = 1;
    uint256 private constant VASP_B_SIGNER_KEY = 2;
    address private constant VASP_A_ADMIN = address(0xA1);
    address private constant VASP_B_ADMIN = address(0xB1);
    address private constant ISSUER = address(0x101);
    address private constant BOB = address(0x102);
    address private constant CAROL = address(0x103);
    address private constant TREASURY = address(0x104);
    address private constant OUTSIDER = address(0x105);

    KycRegistry private registry;
    LedgerForwarder private forwarder;
    TravelRuleCompliance private compliance;
    LedgerToken private token;
    address private alice;

    function setUp() public {
        vm.warp(1000);
        alice = vm.addr(ALICE_KEY);
        KycRegistry implementation = new KycRegistry();
        registry = KycRegistry(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IKycRegistry.initialize, (address(this)))))
        );
        registry.registerVasp(0, address(this), address(this), "ledgerA Network", "");
        registry.registerVasp(1, VASP_A_ADMIN, VASP_A_ADMIN, "VASP A", "");
        registry.registerVasp(2, VASP_B_ADMIN, vm.addr(VASP_B_SIGNER_KEY), "VASP B", "");
        registry.registerOperatorAccount(ISSUER, 0, AccountKind.OPERATOR);
        vm.startPrank(VASP_A_ADMIN);
        registry.registerAccount(alice, AccountKind.CUSTOMER, 0);
        registry.registerAccount(CAROL, AccountKind.CUSTOMER, 0);
        vm.stopPrank();
        vm.startPrank(VASP_B_ADMIN);
        registry.registerAccount(BOB, AccountKind.CUSTOMER, 0);
        registry.registerAccount(TREASURY, AccountKind.VASP_TREASURY, 0);
        vm.stopPrank();

        forwarder = new LedgerForwarder(address(registry));
        compliance = new TravelRuleCompliance(address(registry), address(this));
        token = new LedgerToken(
            "Test Yen", "tJPY", address(registry), address(compliance), address(forwarder), address(this)
        );
        compliance.bindToken(address(token));
        token.addAgent(ISSUER);
        vm.prank(ISSUER);
        token.mint(alice, 1_000);
    }

    function testTokenMetadataAndUnregisteredRecipient() public {
        assertEq(token.decimals(), 6);
        assertEq(token.identityRegistry(), address(registry));
        assertEq(token.compliance(), address(compliance));
        assertEq(token.onchainID(), address(0));
        assertEq(token.balanceOf(alice), 1_000);

        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountNotEligible.selector, OUTSIDER));
        vm.prank(alice);
        token.transfer(OUTSIDER, 1);
    }

    function testFuzzInactiveSenderCannotMoveFunds(uint8 rawCondition) public {
        uint256 condition = bound(rawCondition, 0, 3);
        if (condition == 0) {
            vm.prank(VASP_A_ADMIN);
            registry.suspendAccount(alice, bytes32(0));
        } else if (condition == 1) {
            registry.blockAccount(alice, bytes32(0));
        } else if (condition == 2) {
            uint64 expiry = uint64(block.timestamp);
            vm.prank(VASP_A_ADMIN);
            registry.renewAccount(alice, expiry);
            vm.warp(expiry + 1);
        } else {
            registry.setVaspStatus(1, VaspStatus.SUSPENDED);
        }

        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountNotEligible.selector, alice));
        vm.prank(alice);
        token.transfer(CAROL, 1);
        assertEq(token.balanceOf(alice), 1_000);
        assertEq(token.balanceOf(CAROL), 0);
    }

    function testCrossVaspTransferRequiresOneFreshApproval() public {
        _expectTravelRuleRequired();
        vm.prank(alice);
        token.transfer(BOB, 100);

        TravelRuleAttestation memory attestation = _attestation(100);
        bytes memory signature = _signAttestation(attestation);
        vm.expectEmit(true, true, true, true, address(token));
        emit LedgerToken.TravelRuleTransfer(attestation.refId, alice, BOB, 100);
        vm.prank(alice);
        token.transferWithTravelRule(BOB, 100, attestation, signature);
        assertEq(token.balanceOf(BOB), 100);
        assertEq(token.balanceOf(alice), 900);
        assertTrue(compliance.isUsed(attestation.refId));

        vm.expectRevert(
            abi.encodeWithSelector(ITravelRuleCompliance.AttestationAlreadyUsed.selector, attestation.refId)
        );
        vm.prank(alice);
        token.transferWithTravelRule(BOB, 100, attestation, signature);
        _expectTravelRuleRequired();
        vm.prank(alice);
        token.transfer(BOB, 1);
    }

    function testRejectedTransferRollsBackAttestationConsumption() public {
        TravelRuleAttestation memory attestation = _attestation(100);
        bytes memory signature = _signAttestation(attestation);
        vm.prank(ISSUER);
        token.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        token.transferWithTravelRule(BOB, 100, attestation, signature);
        assertFalse(compliance.isUsed(attestation.refId));
        assertEq(token.balanceOf(BOB), 0);

        vm.prank(ISSUER);
        token.unpause();
        vm.prank(alice);
        token.transferWithTravelRule(BOB, 100, attestation, signature);
        assertTrue(compliance.isUsed(attestation.refId));
    }

    function testTreasuryTransfersAndUnregisteredSpender() public {
        vm.startPrank(alice);
        token.transfer(TREASURY, 100);
        token.approve(OUTSIDER, 50);
        vm.stopPrank();
        vm.prank(TREASURY);
        token.transfer(alice, 40);

        _expectTravelRuleRequired();
        vm.prank(OUTSIDER);
        token.transferFrom(alice, BOB, 1);

        vm.prank(OUTSIDER);
        token.transferFrom(alice, CAROL, 50);
        assertEq(token.balanceOf(alice), 890);
        assertEq(token.balanceOf(TREASURY), 60);
        assertEq(token.balanceOf(CAROL), 50);
        assertEq(token.allowance(alice, OUTSIDER), 0);
    }

    function testPartialAndFullFreezes() public {
        vm.prank(ISSUER);
        token.freezePartialTokens(alice, 800);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.InsufficientUnfrozenBalance.selector, alice, 200, 201));
        vm.prank(alice);
        token.transfer(CAROL, 201);

        vm.startPrank(ISSUER);
        token.unfreezePartialTokens(alice, 1);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.InsufficientFrozenBalance.selector, alice, 799, 800));
        token.unfreezePartialTokens(alice, 800);
        token.setAddressFrozen(CAROL, true);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountFrozen.selector, CAROL));
        vm.prank(alice);
        token.transfer(CAROL, 1);

        vm.startPrank(ISSUER);
        token.setAddressFrozen(CAROL, false);
        token.setAddressFrozen(alice, true);
        vm.stopPrank();
        assertTrue(token.isFrozen(alice));
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountFrozen.selector, alice));
        vm.prank(alice);
        token.transfer(CAROL, 1);
    }

    function testForcedTransferAndBurnReleaseFrozenShortfall() public {
        registry.blockAccount(alice, bytes32(0));
        vm.startPrank(ISSUER);
        token.freezePartialTokens(alice, 900);
        token.setAddressFrozen(alice, true);
        token.setAddressFrozen(BOB, true);
        token.pause();

        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountNotEligible.selector, OUTSIDER));
        token.forcedTransfer(alice, OUTSIDER, 1);
        token.forcedTransfer(alice, BOB, 250);
        assertEq(token.balanceOf(alice), 750);
        assertEq(token.getFrozenTokens(alice), 750);
        assertEq(token.balanceOf(BOB), 250);
        token.burn(alice, 250);
        assertEq(token.balanceOf(alice), 500);
        assertEq(token.getFrozenTokens(alice), 500);

        token.unpause();
        token.setAddressFrozen(alice, false);
        token.setAddressFrozen(BOB, false);
        token.unfreezePartialTokens(alice, 500);
        vm.stopPrank();
        registry.unblockAccount(alice);
        _expectTravelRuleRequired();
        vm.prank(alice);
        token.transfer(BOB, 1);
    }

    function testAgentAndMintPermissions() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OUTSIDER));
        vm.prank(OUTSIDER);
        token.addAgent(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.NotAgent.selector, address(this)));
        token.mint(BOB, 1);

        vm.startPrank(ISSUER);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountNotEligible.selector, OUTSIDER));
        token.mint(OUTSIDER, 1);
        token.setAddressFrozen(BOB, true);
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.AccountFrozen.selector, BOB));
        token.mint(BOB, 1);
        token.setAddressFrozen(BOB, false);
        token.pause();
        token.mint(BOB, 2);
        vm.stopPrank();

        assertEq(token.balanceOf(BOB), 2);
        token.removeAgent(ISSUER);
        assertFalse(token.isAgent(ISSUER));
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.NotAgent.selector, ISSUER));
        vm.prank(ISSUER);
        token.unpause();
    }

    function testForwarderHonorsSignerAndRefusesBlockedApprovalsAndTransfers() public {
        ERC2771Forwarder.ForwardRequestData memory transfer = _signRequest(abi.encodeCall(IERC20.transfer, (CAROL, 10)));
        ERC2771Forwarder.ForwardRequestData memory approval = _signRequest(abi.encodeCall(IERC20.approve, (CAROL, 20)));
        registry.blockAccount(alice, bytes32(0));

        bytes memory notAllowed = abi.encodeWithSelector(LedgerForwarder.SignerNotAllowed.selector, alice);
        vm.expectRevert(notAllowed);
        forwarder.execute(transfer);
        vm.expectRevert(notAllowed);
        forwarder.execute(approval);

        assertEq(token.balanceOf(alice), 1_000);
        assertEq(token.balanceOf(CAROL), 0);
        assertEq(token.allowance(alice, CAROL), 0);
        assertEq(forwarder.nonces(alice), 0);

        registry.unblockAccount(alice);
        forwarder.execute(transfer);
        assertEq(token.balanceOf(alice), 990);
        assertEq(token.balanceOf(CAROL), 10);
    }

    function _expectTravelRuleRequired() private {
        vm.expectRevert(abi.encodeWithSelector(LedgerToken.TravelRuleRequired.selector, alice, BOB));
    }

    function _attestation(uint256 amount) private view returns (TravelRuleAttestation memory) {
        return TravelRuleAttestation({
            refId: bytes32(uint256(7)),
            originator: alice,
            beneficiary: BOB,
            token: address(token),
            amount: amount,
            originatorVaspId: 1,
            beneficiaryVaspId: 2,
            expiry: 2_000
        });
    }

    function _signAttestation(TravelRuleAttestation memory attestation) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VASP_B_SIGNER_KEY, compliance.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }

    function _signRequest(bytes memory data) private view returns (ERC2771Forwarder.ForwardRequestData memory request) {
        uint48 deadline = 2_000;
        uint256 gasLimit = 200_000;
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("ledgerA Forwarder"), keccak256("1"), block.chainid, address(forwarder)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                REQUEST_TYPEHASH, alice, address(token), 0, gasLimit, forwarder.nonces(alice), deadline, keccak256(data)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE_KEY, keccak256(abi.encodePacked(hex"1901", domain, structHash)));
        request = ERC2771Forwarder.ForwardRequestData({
            from: alice,
            to: address(token),
            value: 0,
            gas: gasLimit,
            deadline: deadline,
            data: data,
            signature: abi.encodePacked(r, s, v)
        });
    }
}

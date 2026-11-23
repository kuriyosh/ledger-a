// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Test} from "forge-std/Test.sol";
import {KycRegistry} from "../src/KycRegistry.sol";
import {TravelRuleCompliance} from "../src/TravelRuleCompliance.sol";
import {AccountKind, IKycRegistry} from "../src/interfaces/IKycRegistry.sol";
import {ITravelRuleCompliance, TravelRuleAttestation} from "../src/interfaces/ITravelRuleCompliance.sol";

contract TravelRuleComplianceTest is Test {
    address private constant ORIGINATOR = address(0x1101);
    address private constant BENEFICIARY = address(0x1102);
    address private constant TOKEN = address(0x1103);
    address private constant TREASURY = address(0x1104);
    address private constant VASP_A_ADMIN = address(0xA1);
    address private constant VASP_B_ADMIN = address(0xB1);

    KycRegistry private registry;
    TravelRuleCompliance private compliance;

    function setUp() public {
        KycRegistry implementation = new KycRegistry();
        registry = KycRegistry(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IKycRegistry.initialize, (address(this)))))
        );
        registry.registerVasp(1, VASP_A_ADMIN, vm.addr(1), "VASP A", "");
        registry.registerVasp(2, VASP_B_ADMIN, vm.addr(2), "VASP B", "");
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(ORIGINATOR, AccountKind.CUSTOMER, 0);
        vm.startPrank(VASP_B_ADMIN);
        registry.registerAccount(BENEFICIARY, AccountKind.CUSTOMER, 0);
        registry.registerAccount(TREASURY, AccountKind.VASP_TREASURY, 0);
        vm.stopPrank();

        compliance = new TravelRuleCompliance(address(registry), address(this));
        vm.etch(TOKEN, hex"00");
        compliance.bindToken(TOKEN);
    }

    function testOnlyCrossVaspCustomerTransfersRequireApproval() public view {
        assertTrue(compliance.requiresTravelRule(ORIGINATOR, BENEFICIARY));
        assertFalse(compliance.canTransfer(ORIGINATOR, BENEFICIARY, 1));
        assertFalse(compliance.requiresTravelRule(ORIGINATOR, ORIGINATOR));
        assertFalse(compliance.requiresTravelRule(ORIGINATOR, TREASURY));
        assertFalse(compliance.requiresTravelRule(TREASURY, ORIGINATOR));
        assertTrue(compliance.canTransfer(ORIGINATOR, TREASURY, 1));
    }

    function testRejectsCallerThatIsNotBound() public {
        vm.expectRevert(abi.encodeWithSelector(ITravelRuleCompliance.NotBoundToken.selector, address(this)));
        compliance.consume(_attestation(), "", ORIGINATOR, BENEFICIARY, 50);
        vm.expectRevert(abi.encodeWithSelector(ITravelRuleCompliance.InvalidToken.selector, ORIGINATOR));
        compliance.bindToken(ORIGINATOR);
    }

    function testRejectsTransactionFieldMismatches() public {
        TravelRuleAttestation memory attestation = _attestation();
        attestation.token = address(this);
        _expectMismatch(attestation);
        attestation = _attestation();
        attestation.originator = address(0x2121);
        _expectMismatch(attestation);
        attestation = _attestation();
        attestation.beneficiary = address(0x2121);
        _expectMismatch(attestation);
        attestation = _attestation();
        attestation.amount += 1;
        _expectMismatch(attestation);
        attestation = _attestation();
        attestation.originatorVaspId += 1;
        _expectMismatch(attestation);
        attestation = _attestation();
        attestation.beneficiaryVaspId += 1;
        _expectMismatch(attestation);
    }

    function testRejectsExpiredWrongSignerAndMalformedApproval() public {
        TravelRuleAttestation memory attestation = _attestation();
        bytes memory wrongSignature = _sign(attestation, 1);
        vm.expectRevert(
            abi.encodeWithSelector(ITravelRuleCompliance.InvalidAttestationSigner.selector, vm.addr(1), vm.addr(2))
        );
        vm.prank(TOKEN);
        compliance.consume(attestation, wrongSignature, ORIGINATOR, BENEFICIARY, 50);
        vm.expectRevert(
            abi.encodeWithSelector(ITravelRuleCompliance.InvalidAttestationSigner.selector, address(0), vm.addr(2))
        );
        vm.prank(TOKEN);
        compliance.consume(attestation, "", ORIGINATOR, BENEFICIARY, 50);

        bytes memory signature = _sign(attestation, 2);
        vm.warp(attestation.expiry + 1);
        vm.expectRevert(abi.encodeWithSelector(ITravelRuleCompliance.AttestationExpired.selector, attestation.expiry));
        vm.prank(TOKEN);
        compliance.consume(attestation, signature, ORIGINATOR, BENEFICIARY, 50);
        assertFalse(compliance.isUsed(attestation.refId));
    }

    function testConsumesOnlyOnceAtTheExpiryBoundary() public {
        TravelRuleAttestation memory attestation = _attestation();
        bytes memory signature = _sign(attestation, 2);
        vm.warp(attestation.expiry);
        vm.expectEmit(true, true, true, true, address(compliance));
        emit ITravelRuleCompliance.TravelRuleAttestationConsumed(
            attestation.refId, 1, 2, TOKEN, ORIGINATOR, BENEFICIARY, attestation.amount
        );
        vm.prank(TOKEN);
        compliance.consume(attestation, signature, ORIGINATOR, BENEFICIARY, attestation.amount);
        assertTrue(compliance.isUsed(attestation.refId));

        vm.expectRevert(
            abi.encodeWithSelector(ITravelRuleCompliance.AttestationAlreadyUsed.selector, attestation.refId)
        );
        vm.prank(TOKEN);
        compliance.consume(attestation, signature, ORIGINATOR, BENEFICIARY, attestation.amount);
    }

    function testAcceptsTypeScriptVector() public {
        string memory json = vm.readFile("../packages/shared/test/vectors/attestation.json");
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        address verifier = vm.parseJsonAddress(json, ".domain.verifyingContract");
        // The fixture fixes the EIP-712 verifier independently of test deployment order.
        vm.etch(verifier, address(compliance).code);
        compliance = TravelRuleCompliance(verifier);
        vm.prank(address(0));
        compliance.transferOwnership(address(this));
        compliance.bindToken(TOKEN);

        TravelRuleAttestation memory attestation = TravelRuleAttestation({
            refId: vm.parseJsonBytes32(json, ".message.refId"),
            originator: vm.parseJsonAddress(json, ".message.originator"),
            beneficiary: vm.parseJsonAddress(json, ".message.beneficiary"),
            token: vm.parseJsonAddress(json, ".message.token"),
            amount: vm.parseUint(vm.parseJsonString(json, ".message.amount")),
            originatorVaspId: uint32(vm.parseJsonUint(json, ".message.originatorVaspId")),
            beneficiaryVaspId: uint32(vm.parseJsonUint(json, ".message.beneficiaryVaspId")),
            expiry: uint64(vm.parseUint(vm.parseJsonString(json, ".message.expiry")))
        });
        assertEq(registry.travelRuleSignerOf(attestation.beneficiaryVaspId), vm.parseJsonAddress(json, ".signer"));
        assertEq(compliance.hashAttestation(attestation), vm.parseJsonBytes32(json, ".hash"));

        bytes memory signature = vm.parseJsonBytes(json, ".signature");
        vm.prank(attestation.token);
        compliance.consume(attestation, signature, attestation.originator, attestation.beneficiary, attestation.amount);
        assertTrue(compliance.isUsed(attestation.refId));
    }

    function _attestation() private view returns (TravelRuleAttestation memory) {
        return TravelRuleAttestation({
            refId: bytes32(uint256(101)),
            originator: ORIGINATOR,
            beneficiary: BENEFICIARY,
            token: TOKEN,
            amount: 50,
            originatorVaspId: 1,
            beneficiaryVaspId: 2,
            expiry: uint64(block.timestamp + 100)
        });
    }

    function _expectMismatch(TravelRuleAttestation memory attestation) private {
        vm.expectRevert(ITravelRuleCompliance.AttestationMismatch.selector);
        vm.prank(TOKEN);
        compliance.consume(attestation, "", ORIGINATOR, BENEFICIARY, 50);
    }

    function _sign(TravelRuleAttestation memory attestation, uint256 key) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, compliance.hashAttestation(attestation));
        return abi.encodePacked(r, s, v);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Test} from "forge-std/Test.sol";

import {KycRegistry} from "../src/KycRegistry.sol";
import {
    AccountKind,
    AccountStatus,
    AccountView,
    IKycRegistry,
    VaspStatus,
    VaspView
} from "../src/interfaces/IKycRegistry.sol";

contract KycRegistryTest is Test {
    address private constant VASP_A_ADMIN = address(0xA1);
    address private constant VASP_B_ADMIN = address(0xB2);
    address private constant CUSTOMER = 0x1111111111111111111111111111111111111111;
    address private constant OTHER = address(0xF0);

    KycRegistry private registry;

    function setUp() public {
        vm.warp(1000);
        KycRegistry implementation = new KycRegistry();
        registry = KycRegistry(
            address(new ERC1967Proxy(address(implementation), abi.encodeCall(IKycRegistry.initialize, (address(this)))))
        );
        registry.registerVasp(0, address(this), address(this), "ledgerA Network", "");
        registry.registerVasp(1, VASP_A_ADMIN, address(0xA3), "VASP A", "https://a.example");
        registry.registerVasp(2, VASP_B_ADMIN, address(0xB3), "VASP B", "https://b.example");
    }

    function testStorageLayoutMatchesExecutionClientVectors() public {
        uint64 validUntil = 1200;
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, validUntil);

        bytes32 accountSlot = 0x0af8647d1a0890445823b07eb9e2efa4337166e6e4bd9cee280b017e0ec9696e;
        bytes32 vaspSlot = 0x5ef4ef46b66bf28de20f56d7769e17bd4003ba8f75d884139649b0c9bc4ca857;
        bytes32 flagsSlot = 0x8fe41602647df745ca7420aedc6edbf55eb356a7ee29e0fe07118b9b158f2e02;
        uint256 accountWord = 1 | (1 << 8) | (1 << 16) | (uint256(validUntil) << 48) | (1000 << 112);
        uint256 vaspWord = 1 | (uint256(uint160(VASP_A_ADMIN)) << 8) | (1000 << 168);

        assertEq(uint256(vm.load(address(registry), accountSlot)), accountWord);
        assertEq(uint256(vm.load(address(registry), vaspSlot)), vaspWord);
        assertEq(uint256(vm.load(address(registry), flagsSlot)), 0);

        registry.enableEnforcement();
        assertEq(uint256(vm.load(address(registry), flagsSlot)), 1);
    }

    function testInitializationAndConsortiumTransfer() public {
        assertEq(registry.consortium(), address(this));
        vm.expectRevert(IKycRegistry.AlreadyInitialized.selector);
        registry.initialize(OTHER);

        vm.expectRevert(IKycRegistry.ZeroAddress.selector);
        registry.transferConsortium(address(0));

        uint64 previousVersion = registry.version();
        registry.transferConsortium(OTHER);
        assertEq(registry.version(), previousVersion + 1);
        assertEq(registry.consortium(), OTHER);

        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.NotConsortium.selector, address(this)));
        registry.enableEnforcement();
        vm.prank(OTHER);
        registry.enableEnforcement();
    }

    function testVaspAndHolderEligibilityAtExpiryAndSuspension() public {
        uint64 validUntil = 1100;
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, validUntil);
        registry.registerOperatorAccount(OTHER, 1, AccountKind.RELAYER);

        assertFalse(registry.enforcementEnabled());
        assertTrue(registry.isActive(CUSTOMER));
        assertTrue(registry.isVerified(CUSTOMER));
        assertTrue(registry.isActive(VASP_A_ADMIN));
        assertTrue(registry.isActive(OTHER));
        assertFalse(registry.isHolder(VASP_A_ADMIN));
        assertFalse(registry.isHolder(OTHER));

        vm.warp(validUntil);
        assertTrue(registry.isActive(CUSTOMER));
        vm.warp(validUntil + 1);
        assertFalse(registry.isActive(CUSTOMER));

        vm.prank(VASP_A_ADMIN);
        registry.renewAccount(CUSTOMER, 0);
        assertTrue(registry.isHolder(CUSTOMER));

        registry.setVaspStatus(1, VaspStatus.SUSPENDED);
        assertFalse(registry.isActive(CUSTOMER));
        assertFalse(registry.isActive(OTHER));
        assertFalse(registry.isVerified(CUSTOMER));

        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.VaspNotActive.selector, uint32(1)));
        vm.prank(VASP_A_ADMIN);
        registry.setVaspEndpoint("https://new.example");
        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.VaspNotActive.selector, uint32(1)));
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(address(0xA5), AccountKind.CUSTOMER, 0);

        registry.setVaspStatus(1, VaspStatus.ACTIVE);
        assertTrue(registry.isHolder(CUSTOMER));
    }

    function testNetworkVaspCannotBeSuspended() public {
        vm.expectRevert(IKycRegistry.SystemVaspCannotBeSuspended.selector);
        registry.setVaspStatus(0, VaspStatus.SUSPENDED);
        (bool found, uint32 id) = registry.vaspIdOfAdmin(address(this));
        assertTrue(found);
        assertEq(id, 0);
    }

    function testRegistryRoles() public {
        bytes memory notConsortium = abi.encodeWithSelector(IKycRegistry.NotConsortium.selector, VASP_A_ADMIN);
        vm.startPrank(VASP_A_ADMIN);
        vm.expectRevert(notConsortium);
        registry.registerVasp(3, OTHER, OTHER, "", "");
        vm.expectRevert(notConsortium);
        registry.setVaspStatus(1, VaspStatus.SUSPENDED);
        vm.expectRevert(notConsortium);
        registry.setVaspKeys(1, VASP_A_ADMIN, OTHER);
        vm.expectRevert(notConsortium);
        registry.registerOperatorAccount(CUSTOMER, 1, AccountKind.OPERATOR);
        vm.expectRevert(notConsortium);
        registry.blockAccount(CUSTOMER, bytes32(0));
        vm.expectRevert(notConsortium);
        registry.unblockAccount(CUSTOMER);
        vm.expectRevert(notConsortium);
        registry.enableEnforcement();
        vm.expectRevert(notConsortium);
        registry.transferConsortium(OTHER);
        vm.stopPrank();

        bytes memory notAdmin = abi.encodeWithSelector(IKycRegistry.NotVaspAdmin.selector, OTHER);
        vm.startPrank(OTHER);
        vm.expectRevert(notAdmin);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, 0);
        vm.expectRevert(notAdmin);
        registry.suspendAccount(CUSTOMER, bytes32(0));
        vm.expectRevert(notAdmin);
        registry.reinstateAccount(CUSTOMER);
        vm.expectRevert(notAdmin);
        registry.revokeAccount(CUSTOMER);
        vm.expectRevert(notAdmin);
        registry.renewAccount(CUSTOMER, 1200);
        vm.expectRevert(notAdmin);
        registry.setVaspEndpoint("https://new.example");
        vm.stopPrank();
    }

    function testAccountLifecycleAndTransferToAnotherVasp() public {
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, 1440);
        assertEq(registry.vaspOf(CUSTOMER), 1);

        vm.prank(VASP_B_ADMIN);
        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.AccountOfOtherVasp.selector, CUSTOMER, uint32(1)));
        registry.suspendAccount(CUSTOMER, bytes32(0));

        bytes32 reason = bytes32(uint256(9));
        uint64 nextVersion = registry.version() + 1;
        vm.expectEmit(true, true, true, true, address(registry));
        emit IKycRegistry.AccountUpdated(
            CUSTOMER, 1, AccountKind.CUSTOMER, AccountStatus.SUSPENDED, 1440, nextVersion, VASP_A_ADMIN, reason
        );
        vm.prank(VASP_A_ADMIN);
        registry.suspendAccount(CUSTOMER, reason);
        assertFalse(registry.isActive(CUSTOMER));

        vm.prank(VASP_A_ADMIN);
        registry.reinstateAccount(CUSTOMER);
        assertTrue(registry.isActive(CUSTOMER));

        registry.blockAccount(CUSTOMER, reason);
        _expectTransition(AccountStatus.BLOCKED, AccountStatus.ACTIVE);
        vm.prank(VASP_A_ADMIN);
        registry.renewAccount(CUSTOMER, 0);
        _expectTransition(AccountStatus.BLOCKED, AccountStatus.REVOKED);
        vm.prank(VASP_A_ADMIN);
        registry.revokeAccount(CUSTOMER);

        registry.unblockAccount(CUSTOMER);
        vm.prank(VASP_A_ADMIN);
        registry.revokeAccount(CUSTOMER);
        assertFalse(registry.isHolder(CUSTOMER));

        vm.prank(VASP_B_ADMIN);
        registry.registerAccount(CUSTOMER, AccountKind.VASP_TREASURY, 0);
        assertEq(registry.vaspOf(CUSTOMER), 2);
        assertEq(uint8(registry.kindOf(CUSTOMER)), uint8(AccountKind.VASP_TREASURY));
        assertTrue(registry.isHolder(CUSTOMER));
    }

    function testFuzzInvalidAccountTransitions(uint8 rawStatus) public {
        AccountStatus status = AccountStatus(bound(rawStatus, 0, uint8(AccountStatus.REVOKED)));
        _createAccountWithStatus(status);
        if (status != AccountStatus.ACTIVE) {
            _expectTransition(status, AccountStatus.SUSPENDED);
            vm.prank(VASP_A_ADMIN);
            registry.suspendAccount(CUSTOMER, bytes32(0));
            _expectTransition(status, AccountStatus.ACTIVE);
            vm.prank(VASP_A_ADMIN);
            registry.renewAccount(CUSTOMER, 1200);
        }
        if (status != AccountStatus.SUSPENDED) {
            _expectTransition(status, AccountStatus.ACTIVE);
            vm.prank(VASP_A_ADMIN);
            registry.reinstateAccount(CUSTOMER);
        }
        if (status != AccountStatus.ACTIVE && status != AccountStatus.SUSPENDED) {
            _expectTransition(status, AccountStatus.REVOKED);
            vm.prank(VASP_A_ADMIN);
            registry.revokeAccount(CUSTOMER);
            _expectTransition(status, AccountStatus.BLOCKED);
            registry.blockAccount(CUSTOMER, bytes32(0));
        }
        if (status != AccountStatus.BLOCKED) {
            _expectTransition(status, AccountStatus.ACTIVE);
            registry.unblockAccount(CUSTOMER);
        }
        if (status != AccountStatus.NONE && status != AccountStatus.REVOKED) {
            _expectTransition(status, AccountStatus.ACTIVE);
            vm.prank(VASP_A_ADMIN);
            registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, 0);
        }
        if (status != AccountStatus.NONE) {
            _expectTransition(status, AccountStatus.ACTIVE);
            registry.registerOperatorAccount(CUSTOMER, 1, AccountKind.OPERATOR);
        }
    }

    function testKeyRotationPreservesBlockedStateAndReplacesAdminRights() public {
        registry.blockAccount(VASP_A_ADMIN, bytes32(0));
        registry.setVaspKeys(1, VASP_A_ADMIN, address(0xA4));
        assertEq(uint8(registry.getAccount(VASP_A_ADMIN).status), uint8(AccountStatus.BLOCKED));

        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.AccountOfOtherVasp.selector, VASP_B_ADMIN, uint32(2)));
        registry.setVaspKeys(1, VASP_B_ADMIN, address(0xA4));
        registry.setVaspKeys(1, OTHER, address(0xA5));
        assertTrue(registry.isActive(OTHER));
        assertFalse(registry.isHolder(OTHER));
        assertEq(registry.travelRuleSignerOf(1), address(0xA5));

        vm.prank(VASP_A_ADMIN);
        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.NotVaspAdmin.selector, VASP_A_ADMIN));
        registry.setVaspEndpoint("https://stale.example");

        vm.warp(1010);
        vm.prank(OTHER);
        registry.setVaspEndpoint("https://new.example");
        VaspView memory vasp = registry.getVasp(1);
        assertEq(vasp.admin, OTHER);
        assertEq(vasp.endpoint, "https://new.example");
        assertEq(vasp.updatedAt, 1010);
    }

    function testMaximumVaspIdAndRotation() public {
        uint32 id = type(uint32).max;
        registry.registerVasp(id, OTHER, OTHER, "Last", "");
        (bool found, uint32 returned) = registry.vaspIdOfAdmin(OTHER);
        assertTrue(found);
        assertEq(returned, id);
        vm.prank(OTHER);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, 0);
        assertEq(registry.vaspOf(CUSTOMER), id);
        assertTrue(registry.isHolder(CUSTOMER));

        address replacement = address(0xF1);
        registry.setVaspKeys(id, replacement, replacement);
        (found,) = registry.vaspIdOfAdmin(OTHER);
        assertFalse(found);
        (found, returned) = registry.vaspIdOfAdmin(replacement);
        assertTrue(found);
        assertEq(returned, id);
    }

    function testEnforcementCanOnlyBeEnabledOnce() public {
        uint64 previousVersion = registry.version();
        registry.enableEnforcement();
        assertTrue(registry.enforcementEnabled());
        assertEq(registry.version(), previousVersion + 1);
        vm.expectRevert(IKycRegistry.EnforcementAlreadyEnabled.selector);
        registry.enableEnforcement();
        assertEq(registry.version(), previousVersion + 1);
    }

    function _expectTransition(AccountStatus from, AccountStatus to) private {
        vm.expectRevert(abi.encodeWithSelector(IKycRegistry.InvalidTransition.selector, CUSTOMER, from, to));
    }

    function _createAccountWithStatus(AccountStatus status) private {
        if (status == AccountStatus.NONE) return;
        vm.prank(VASP_A_ADMIN);
        registry.registerAccount(CUSTOMER, AccountKind.CUSTOMER, 0);
        if (status == AccountStatus.SUSPENDED) {
            vm.prank(VASP_A_ADMIN);
            registry.suspendAccount(CUSTOMER, bytes32(0));
        } else if (status == AccountStatus.BLOCKED) {
            registry.blockAccount(CUSTOMER, bytes32(0));
        } else if (status == AccountStatus.REVOKED) {
            vm.prank(VASP_A_ADMIN);
            registry.revokeAccount(CUSTOMER);
        }
    }
}

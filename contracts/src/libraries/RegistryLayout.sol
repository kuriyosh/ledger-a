// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccountKind, AccountStatus, AccountView, VaspStatus} from "../interfaces/IKycRegistry.sol";

library RegistryLayout {
    // The execution client reads these same slots and bit offsets directly.
    bytes32 internal constant SLOT = 0x8fe41602647df745ca7420aedc6edbf55eb356a7ee29e0fe07118b9b158f2e00;
    uint256 internal constant ENFORCEMENT_ENABLED = 1;

    /// @custom:storage-location erc7201:ledgera.storage.KycRegistry
    struct Layout {
        mapping(address => uint256) accounts;
        mapping(uint32 => uint256) vasps;
        uint256 flags;
        uint64 version;
        address consortium;
        bool initialized;
        mapping(uint32 => address) travelRuleSigner;
        mapping(uint32 => string) vaspName;
        mapping(uint32 => string) vaspEndpoint;
        mapping(address => uint32) adminVaspIdPlus1;
    }

    function get() internal pure returns (Layout storage layout) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            layout.slot := slot
        }
    }

    function packAccount(AccountView memory account) internal pure returns (uint256) {
        return uint256(account.status) | (uint256(account.kind) << 8) | (uint256(account.vaspId) << 16)
            | (uint256(account.validUntil) << 48) | (uint256(account.updatedAt) << 112);
    }

    function unpackAccount(uint256 word) internal pure returns (AccountView memory) {
        return AccountView({
            status: AccountStatus(uint8(word)),
            kind: AccountKind(uint8(word >> 8)),
            vaspId: uint32(word >> 16),
            validUntil: uint64(word >> 48),
            updatedAt: uint64(word >> 112)
        });
    }

    function packVasp(VaspStatus status, address admin, uint64 updatedAt) internal pure returns (uint256) {
        return uint256(status) | (uint256(uint160(admin)) << 8) | (uint256(updatedAt) << 168);
    }

    function unpackVasp(uint256 word) internal pure returns (VaspStatus, address, uint64) {
        return (VaspStatus(uint8(word)), address(uint160(word >> 8)), uint64(word >> 168));
    }
}

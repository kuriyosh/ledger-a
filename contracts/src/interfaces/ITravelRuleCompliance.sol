// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct TravelRuleAttestation {
    bytes32 refId;
    address originator;
    address beneficiary;
    address token;
    uint256 amount;
    uint32 originatorVaspId;
    uint32 beneficiaryVaspId;
    uint64 expiry;
}

interface ITravelRuleCompliance {
    error NotBoundToken(address caller);
    error InvalidToken(address token);
    error AttestationMismatch();
    error AttestationExpired(uint64 expiry);
    error AttestationAlreadyUsed(bytes32 refId);
    error InvalidAttestationSigner(address recovered, address expected);

    event TravelRuleAttestationConsumed(
        bytes32 indexed refId,
        uint32 indexed originatorVaspId,
        uint32 indexed beneficiaryVaspId,
        address token,
        address originator,
        address beneficiary,
        uint256 amount
    );

    function requiresTravelRule(address from, address to) external view returns (bool);
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
    function consume(
        TravelRuleAttestation calldata attestation,
        bytes calldata signature,
        address from,
        address to,
        uint256 amount
    ) external;
    function isUsed(bytes32 refId) external view returns (bool);
    function hashAttestation(TravelRuleAttestation calldata attestation) external view returns (bytes32);
    function bindToken(address token) external;
    function isBoundToken(address token) external view returns (bool);
}

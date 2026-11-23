// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {AccountKind, AccountView, IKycRegistry} from "./interfaces/IKycRegistry.sol";
import {ITravelRuleCompliance, TravelRuleAttestation} from "./interfaces/ITravelRuleCompliance.sol";

contract TravelRuleCompliance is EIP712, Ownable, ITravelRuleCompliance {
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "TravelRuleAttestation(bytes32 refId,address originator,address beneficiary,address token,uint256 amount,uint32 originatorVaspId,uint32 beneficiaryVaspId,uint64 expiry)"
    );

    IKycRegistry private immutable _registry;
    mapping(bytes32 refId => bool used) public isUsed;
    mapping(address token => bool bound) public isBoundToken;

    constructor(address registry_, address owner_) EIP712("ledgerA TravelRule", "1") Ownable(owner_) {
        _registry = IKycRegistry(registry_);
    }

    function requiresTravelRule(address from, address to) public view returns (bool) {
        AccountView memory originator = _registry.getAccount(from);
        AccountView memory beneficiary = _registry.getAccount(to);
        return originator.kind == AccountKind.CUSTOMER && beneficiary.kind == AccountKind.CUSTOMER
            && originator.vaspId != beneficiary.vaspId;
    }

    function canTransfer(address from, address to, uint256) external view returns (bool) {
        return !requiresTravelRule(from, to);
    }

    function consume(
        TravelRuleAttestation calldata attestation,
        bytes calldata signature,
        address from,
        address to,
        uint256 amount
    ) external {
        if (!isBoundToken[msg.sender]) revert NotBoundToken(msg.sender);
        if (
            attestation.token != msg.sender || attestation.originator != from || attestation.beneficiary != to
                || attestation.amount != amount || attestation.originatorVaspId != _registry.vaspOf(from)
                || attestation.beneficiaryVaspId != _registry.vaspOf(to)
        ) revert AttestationMismatch();
        if (block.timestamp > attestation.expiry) revert AttestationExpired(attestation.expiry);
        if (isUsed[attestation.refId]) revert AttestationAlreadyUsed(attestation.refId);

        address expected = _registry.travelRuleSignerOf(attestation.beneficiaryVaspId);
        (address recovered, ECDSA.RecoverError error,) =
            ECDSA.tryRecoverCalldata(hashAttestation(attestation), signature);
        if (error != ECDSA.RecoverError.NoError || expected == address(0) || recovered != expected) {
            revert InvalidAttestationSigner(recovered, expected);
        }

        isUsed[attestation.refId] = true;
        emit TravelRuleAttestationConsumed(
            attestation.refId, attestation.originatorVaspId, attestation.beneficiaryVaspId, msg.sender, from, to, amount
        );
    }

    function hashAttestation(TravelRuleAttestation calldata attestation) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, attestation)));
    }

    function bindToken(address token) external onlyOwner {
        if (token.code.length == 0) revert InvalidToken(token);
        isBoundToken[token] = true;
    }
}

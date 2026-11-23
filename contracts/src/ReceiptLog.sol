// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IReceiptLog, Receipt} from "./interfaces/IReceiptLog.sol";

contract ReceiptLog is EIP712, Ownable, IReceiptLog {
    bytes32 private constant RECEIPT_TYPEHASH =
        keccak256("Receipt(uint64 seq,bytes32 txHash,address sender,uint64 receivedAtMs,bytes32 prevHash)");

    bytes32 public immutable genesisHash;
    address public gateway;
    address public gatewaySigner;
    bytes32 public lastHash;
    uint64 public lastSeq;
    uint64 public commitCount;

    constructor(address gateway_, address gatewaySigner_, address owner_)
        EIP712("ledgerA Gateway", "1")
        Ownable(owner_)
    {
        genesisHash = keccak256(abi.encode("ledgerA ReceiptLog", block.chainid, address(this)));
        lastHash = genesisHash;
        _setGateway(gateway_, gatewaySigner_);
    }

    function commit(uint64 fromSeq, uint64 toSeq, bytes32 headHash) external {
        if (msg.sender != gateway) revert NotGateway(msg.sender);
        uint64 expected = lastSeq + 1;
        if (fromSeq != expected) revert NonContiguousCommit(expected, fromSeq);
        if (toSeq < fromSeq) revert EmptyCommit();

        lastSeq = toSeq;
        lastHash = headHash;
        emit Committed(++commitCount, fromSeq, toSeq, headHash, uint64(block.timestamp));
    }

    function setGateway(address newGateway, address signer) external onlyOwner {
        _setGateway(newGateway, signer);
    }

    function hashReceipt(Receipt calldata receipt) public pure returns (bytes32) {
        return keccak256(abi.encode(RECEIPT_TYPEHASH, receipt));
    }

    function verifyReceipt(Receipt calldata receipt, bytes calldata signature) external view returns (bool) {
        (address signer, ECDSA.RecoverError error,) =
            ECDSA.tryRecoverCalldata(_hashTypedDataV4(hashReceipt(receipt)), signature);
        return error == ECDSA.RecoverError.NoError && signer == gatewaySigner;
    }

    function _setGateway(address newGateway, address signer) private {
        if (newGateway == address(0) || signer == address(0)) revert ZeroAddress();
        gateway = newGateway;
        gatewaySigner = signer;
        emit GatewayChanged(newGateway, signer);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct Receipt {
    uint64 seq;
    bytes32 txHash;
    address sender;
    uint64 receivedAtMs;
    bytes32 prevHash;
}

interface IReceiptLog {
    function commit(uint64 fromSeq, uint64 toSeq, bytes32 headHash) external;
    function setGateway(address gateway, address signer) external;
    function gateway() external view returns (address);
    function gatewaySigner() external view returns (address);
    function genesisHash() external view returns (bytes32);
    function lastSeq() external view returns (uint64);
    function lastHash() external view returns (bytes32);
    function commitCount() external view returns (uint64);
    function hashReceipt(Receipt calldata receipt) external pure returns (bytes32);
    function verifyReceipt(Receipt calldata receipt, bytes calldata signature) external view returns (bool);

    event Committed(uint64 indexed commitIndex, uint64 fromSeq, uint64 toSeq, bytes32 headHash, uint64 timestamp);
    event GatewayChanged(address gateway, address signer);

    error NotGateway(address caller);
    error NonContiguousCommit(uint64 expectedFromSeq, uint64 fromSeq);
    error EmptyCommit();
    error ZeroAddress();
}

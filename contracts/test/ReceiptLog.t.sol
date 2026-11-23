// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Test} from "forge-std/Test.sol";
import {ReceiptLog as LedgerReceiptLog} from "../src/ReceiptLog.sol";
import {IReceiptLog, Receipt as LedgerReceipt} from "../src/interfaces/IReceiptLog.sol";

contract ReceiptLogTest is Test {
    address private constant GATEWAY = address(0x1601);
    address private constant NEXT_GATEWAY = address(0x1602);
    LedgerReceiptLog private receiptLog;

    function setUp() public {
        vm.warp(1000);
        receiptLog = new LedgerReceiptLog(GATEWAY, vm.addr(5), address(this));
    }

    function testGenesisAndContiguousCommit() public {
        assertEq(
            receiptLog.genesisHash(), keccak256(abi.encode("ledgerA ReceiptLog", block.chainid, address(receiptLog)))
        );
        assertEq(receiptLog.lastHash(), receiptLog.genesisHash());
        assertEq(receiptLog.lastSeq(), 0);

        bytes32 head = bytes32(uint256(2));
        vm.expectEmit(true, false, false, true, address(receiptLog));
        emit IReceiptLog.Committed(1, 1, 3, head, uint64(block.timestamp));
        vm.prank(GATEWAY);
        receiptLog.commit(1, 3, head);

        assertEq(receiptLog.lastSeq(), 3);
        assertEq(receiptLog.lastHash(), head);
        assertEq(receiptLog.commitCount(), 1);
        vm.prank(GATEWAY);
        receiptLog.commit(4, 4, bytes32(uint256(3)));
        assertEq(receiptLog.commitCount(), 2);
    }

    function testRejectsNoncontiguousAndEmptyCommits() public {
        vm.expectRevert(abi.encodeWithSelector(IReceiptLog.NonContiguousCommit.selector, 1, 2));
        vm.prank(GATEWAY);
        receiptLog.commit(2, 3, bytes32(0));
        vm.expectRevert(IReceiptLog.EmptyCommit.selector);
        vm.prank(GATEWAY);
        receiptLog.commit(1, 0, bytes32(0));

        vm.prank(GATEWAY);
        receiptLog.commit(1, 2, bytes32(uint256(7)));
        vm.expectRevert(abi.encodeWithSelector(IReceiptLog.NonContiguousCommit.selector, 3, 2));
        vm.prank(GATEWAY);
        receiptLog.commit(2, 5, bytes32(0));
        assertEq(receiptLog.lastSeq(), 2);
    }

    function testOnlyTheOwnerCanRotateGatewayAndSigner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, GATEWAY));
        vm.prank(GATEWAY);
        receiptLog.setGateway(NEXT_GATEWAY, NEXT_GATEWAY);
        vm.expectRevert(IReceiptLog.ZeroAddress.selector);
        receiptLog.setGateway(NEXT_GATEWAY, address(0));

        receiptLog.setGateway(NEXT_GATEWAY, NEXT_GATEWAY);
        assertEq(receiptLog.gatewaySigner(), NEXT_GATEWAY);
        vm.expectRevert(abi.encodeWithSelector(IReceiptLog.NotGateway.selector, GATEWAY));
        vm.prank(GATEWAY);
        receiptLog.commit(1, 1, bytes32(uint256(7)));
        vm.prank(NEXT_GATEWAY);
        receiptLog.commit(1, 1, bytes32(uint256(7)));
        assertEq(receiptLog.lastSeq(), 1);
    }

    function testAcceptsTypeScriptEntryHashAndSignature() public {
        string memory json = vm.readFile("../packages/shared/test/vectors/receipt.json");
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        address verifier = vm.parseJsonAddress(json, ".domain.verifyingContract");
        vm.etch(verifier, address(receiptLog).code);
        LedgerReceiptLog vectorLog = LedgerReceiptLog(verifier);
        // Etching the fixed verifier copies code without the constructor's owner storage.
        vm.prank(address(0));
        vectorLog.transferOwnership(address(this));
        vectorLog.setGateway(GATEWAY, vm.parseJsonAddress(json, ".signer"));

        LedgerReceipt memory receipt = LedgerReceipt({
            seq: uint64(vm.parseUint(vm.parseJsonString(json, ".message.seq"))),
            txHash: vm.parseJsonBytes32(json, ".message.txHash"),
            sender: vm.parseJsonAddress(json, ".message.sender"),
            receivedAtMs: uint64(vm.parseUint(vm.parseJsonString(json, ".message.receivedAtMs"))),
            prevHash: vm.parseJsonBytes32(json, ".message.prevHash")
        });
        assertEq(receipt.prevHash, keccak256(abi.encode("ledgerA ReceiptLog", block.chainid, verifier)));
        assertEq(vectorLog.hashReceipt(receipt), vm.parseJsonBytes32(json, ".entryHash"));
        bytes memory signature = vm.parseJsonBytes(json, ".signature");
        assertTrue(vectorLog.verifyReceipt(receipt, signature));
        assertFalse(vectorLog.verifyReceipt(receipt, ""));
        receipt.txHash = bytes32(uint256(9));
        assertFalse(vectorLog.verifyReceipt(receipt, signature));
    }
}

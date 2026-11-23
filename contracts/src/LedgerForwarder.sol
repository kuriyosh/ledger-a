// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {IKycRegistry} from "./interfaces/IKycRegistry.sol";

contract LedgerForwarder is ERC2771Forwarder {
    IKycRegistry public immutable registry;

    error SignerNotAllowed(address signer);

    constructor(address registry_) ERC2771Forwarder("ledgerA Forwarder") {
        registry = IKycRegistry(registry_);
    }

    function verify(ForwardRequestData calldata request) public view override returns (bool) {
        return request.value == 0 && registry.isActive(request.from) && super.verify(request);
    }

    function execute(ForwardRequestData calldata request) public payable override {
        if (msg.value != 0) revert ERC2771ForwarderMismatchedValue(0, msg.value);
        if (!_execute(request, true)) _revertWithReturnData();
    }

    function executeAll(ForwardRequestData[] calldata requests) external payable {
        if (msg.value != 0) revert ERC2771ForwarderMismatchedValue(0, msg.value);
        for (uint256 i; i < requests.length; ++i) {
            if (!_execute(requests[i], true)) _revertWithReturnData();
        }
    }

    function _execute(ForwardRequestData calldata request, bool requireValidRequest) internal override returns (bool) {
        if (!registry.isActive(request.from)) revert SignerNotAllowed(request.from);
        if (request.value != 0) revert ERC2771ForwarderMismatchedValue(request.value, 0);
        return super._execute(request, requireValidRequest);
    }

    function _revertWithReturnData() private pure {
        // OZ leaves the target's return data available after its internal gas check and event.
        assembly ("memory-safe") {
            let start := mload(0x40)
            let size := returndatasize()
            returndatacopy(start, 0, size)
            revert(start, size)
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {GnosisSafeProxy} from "@safe-global/safe-contracts/proxies/GnosisSafeProxy.sol";

contract InitializedSafeProxy is GnosisSafeProxy {
    constructor(address singleton, bytes memory initializer) GnosisSafeProxy(singleton) {
        Address.functionDelegateCall(singleton, initializer);
    }
}

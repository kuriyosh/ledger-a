// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DepositProbe} from "../src/DepositProbe.sol";

contract DepositProbeTest is Test {
    function testPokeIncrementsOnlyTheCallersCount() public {
        DepositProbe probe = new DepositProbe();
        address first = address(0xA1);
        address second = address(0xB2);

        vm.expectEmit(true, false, false, true, address(probe));
        emit DepositProbe.Poked(first, 1);
        vm.prank(first);
        probe.poke();

        vm.prank(second);
        probe.poke();
        vm.prank(first);
        probe.poke();

        assertEq(probe.count(first), 2);
        assertEq(probe.count(second), 1);
        assertEq(probe.count(address(this)), 0);
    }
}

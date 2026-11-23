// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract DepositProbe {
    mapping(address => uint256) public count;

    event Poked(address indexed caller, uint256 count);

    function poke() external {
        uint256 next = ++count[msg.sender];
        emit Poked(msg.sender, next);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice An NFT-style collection with operator approvals, for revocation tests.
contract MockCollection {
    mapping(address owner => mapping(address operator => bool)) public isApprovedForAll;

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }
}

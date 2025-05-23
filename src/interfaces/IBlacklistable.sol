// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

interface IBlacklistable {
    function isBlacklisted(address account) external view returns (bool);
}
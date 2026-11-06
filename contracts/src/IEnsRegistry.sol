// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice The two calls we need from an ENSv2 UserRegistry.
/// @dev `register` calls `onERC1155Received` on `owner` when `owner` has code, so it can call back.
interface IEnsRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    )
        external
        returns (uint256 tokenId);

    /// @return The owner of the label, or the zero address when it is free or expired.
    function findOwner(string calldata label) external view returns (address);
}

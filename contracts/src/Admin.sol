// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Two admin keys. The owner wallet stays for good. The deployer stays until it is dropped.
/// @dev If the deployer is a server key, drop it when setup is done. Until then that key can swap
///      a check or change the attester, so it can decide who gets a name.
abstract contract Admin {
    error NotAdmin(address caller);
    error ZeroAddress();

    event DeployerDropped(address indexed deployer);

    address public immutable ownerWallet;
    address public deployer;

    modifier onlyAdmin() {
        if (!isAdmin(msg.sender)) revert NotAdmin(msg.sender);
        _;
    }

    constructor(address ownerWallet_) {
        if (ownerWallet_ == address(0)) revert ZeroAddress();
        ownerWallet = ownerWallet_;
        deployer = msg.sender;
    }

    function dropDeployer() external onlyAdmin {
        emit DeployerDropped(deployer);
        deployer = address(0);
    }

    function isAdmin(address account) public view returns (bool) {
        return account != address(0) && (account == ownerWallet || account == deployer);
    }
}

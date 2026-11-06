// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {AttestedCheck} from "./AttestedCheck.sol";
import {IPersonCheck} from "./IPersonCheck.sol";

/// @notice The person check in use: a signature by a key held by our server.
/// @dev The contract does not see or check a World proof. It only sees that the server says it did.
contract AttestedPersonCheck is AttestedCheck, IPersonCheck {
    constructor(address ownerWallet_, address attester_) AttestedCheck(ownerWallet_, attester_) {}

    /// @dev The registrar in the signed message is the caller. So no address needs to be known at
    ///      deploy time, and a signature made for one registrar fails when another one asks.
    function check(address owner, string calldata label, uint256 pass, bytes calldata proof)
        external
        view
        returns (bool)
    {
        return _signedByAttester(messageHash(msg.sender, owner, label, pass), proof);
    }

    /// @notice The hash the attester signs, with the EIP-191 prefix.
    function messageHash(address registrar, address owner, string calldata label, uint256 pass)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, registrar, owner, label, pass));
    }
}

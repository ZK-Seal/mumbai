// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {AttestedCheck} from "./AttestedCheck.sol";
import {ISealCheck} from "./ISealCheck.sol";

/// @notice The seal check in use: a signature by a key held by our server.
/// @dev The contract does not see or check a zkSeal proof, and no contract can today. It only sees
///      that the server says it checked one.
contract AttestedSealCheck is AttestedCheck, ISealCheck {
    constructor(address ownerWallet_, address attester_) AttestedCheck(ownerWallet_, attester_) {}

    /// @dev The registrar in the signed message is the caller. So no address needs to be known at
    ///      deploy time, and a signature made for one registrar fails when another one asks.
    function check(
        address owner,
        bytes32 seal,
        address eventRegistry,
        string calldata label,
        bytes calldata proof
    )
        external
        view
        returns (bool)
    {
        return _signedByAttester(messageHash(msg.sender, owner, seal, eventRegistry, label), proof);
    }

    /// @notice The hash the attester signs, with the EIP-191 prefix.
    /// @dev The label is signed too. Without it, anyone who sees a waiting transaction could copy
    ///      the signature, use the seal under another label, and make the real one fail.
    function messageHash(
        address registrar,
        address owner,
        bytes32 seal,
        address eventRegistry,
        string calldata label
    )
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, registrar, owner, seal, eventRegistry, label));
    }
}

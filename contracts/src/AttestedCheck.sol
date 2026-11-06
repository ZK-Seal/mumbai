// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {Admin} from "./Admin.sol";

/// @notice The shared part of the two attester checks: one key, and one way to test its signature.
/// @dev This is not a proof check. A key held by our server signs "I checked this proof", and the
///      contract trusts that key. Whoever holds the key can approve anything.
///      The signed message always holds the chain id and the registrar's address, so a signature
///      does not work on another chain or at another registrar. The registrars' used-pass and
///      used-seal maps stop a signature being used twice. There is no expiry time on a signature:
///      one that was never used stays good until the attester is changed.
abstract contract AttestedCheck is Admin {
    event AttesterSet(address indexed attester);

    address public attester;

    constructor(address ownerWallet_, address attester_) Admin(ownerWallet_) {
        _setAttester(attester_);
    }

    function setAttester(address attester_) external onlyAdmin {
        _setAttester(attester_);
    }

    function _setAttester(address attester_) private {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterSet(attester_);
    }

    /// @dev Signed with the EIP-191 prefix. `tryRecover` refuses a signature that is not 65 bytes,
    ///      a high `s` (the other form of the same signature) and a bad `v`.
    function _signedByAttester(bytes32 messageHash_, bytes calldata signature)
        internal
        view
        returns (bool)
    {
        (address signer, ECDSA.RecoverError problem,) =
            ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(messageHash_), signature);
        return problem == ECDSA.RecoverError.NoError && signer == attester;
    }
}

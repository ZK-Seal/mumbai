// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Answers one question: is this seal good, for this address, event and image name?
/// @dev A contract cannot check a zkSeal proof today: the proof is too large and too costly to
///      check on chain. AttestedSealCheck, the one in use, only checks a signature by a key held
///      by our server, which says the server checked the proof.
///      The target is a contract named WrappedProofSealCheck. It would check a small proof wrapped
///      around the zkSeal proof. That wrapped proof does not exist yet, so neither does the
///      contract. This interface is all there is of it.
///      The signature also stands for the tie between the photo and the person. Each photo has its
///      own World proof, and our server's session ties that proof to a named person.
///      `view` makes the call a static call, so a check cannot change state or call back to write.
interface ISealCheck {
    /// @param owner The address that gets the image name.
    /// @param seal The seal's hash. One seal gets one image name.
    /// @param eventRegistry The event's registry, which will hold the image name.
    /// @param label The image name's label.
    /// @param proof The attester's signature today.
    function check(
        address owner,
        bytes32 seal,
        address eventRegistry,
        string calldata label,
        bytes calldata proof
    )
        external
        view
        returns (bool);
}

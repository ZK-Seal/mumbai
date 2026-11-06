// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice Answers one question: did this person pass the human check, for this name and address?
/// @dev What the answer is worth depends on which contract is plugged in:
///      - AttestedPersonCheck, the one in use: a key held by our server signed that the server
///        checked a World proof. The contract does not check a proof. It trusts that key.
///      - WorldPersonCheck, written but not in use: asks World's router on chain. On mainnet that
///        needs production identities, and our test identities are not in World's mainnet tree.
///      `view` makes the call a static call, so a check cannot change state or call back to write.
interface IPersonCheck {
    /// @param owner The address that gets the name.
    /// @param label The name's label.
    /// @param pass The person's World nullifier from the join action. One person gets one pass.
    /// @param proof The attester's signature or the World proof, as the plugged-in check expects.
    function check(address owner, string calldata label, uint256 pass, bytes calldata proof)
        external
        view
        returns (bool);
}

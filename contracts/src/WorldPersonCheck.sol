// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IPersonCheck} from "./IPersonCheck.sol";

/// @notice World's router on Ethereum. It reverts when a proof is bad.
/// @dev Its deployed ABI says nonpayable, and World's docs say view. Its source writes nothing on
///      this path, so we call it as view. This contract has never run with a good proof.
interface IWorldRouter {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    )
        external
        view;
}

/// @notice A person check that asks World's router on chain. WRITTEN, NOT IN USE.
/// @dev No good proof has ever passed through this contract. Its limits:
///      - On mainnet it needs production identities. A sandbox or staging root is not in World's
///        mainnet tree, so the router refuses it.
///      - The router takes World ID 3.0 proofs from the Orb group only. World's docs call these
///        legacy. World ID 4.0's on-chain check is not on Ethereum. So it does not take the proofs
///        our server gets today.
///      - A proof must be made over `signalHash(owner, label)`. Today's signal holds the label only.
///      - The owner must be known before the proof. Our server makes the owner's key from the pass,
///        and the pass comes out of the proof. That order has to change first.
contract WorldPersonCheck is IPersonCheck {
    uint256 public constant ORB_GROUP = 1;

    IWorldRouter public immutable router;
    uint256 public immutable externalNullifierHash;

    constructor(IWorldRouter router_, string memory appId, string memory action) {
        router = router_;
        externalNullifierHash =
            _hashToField(abi.encodePacked(_hashToField(abi.encodePacked(appId)), action));
    }

    /// @param proof `abi.encode(uint256 root, uint256[8] zkProof)`.
    function check(address owner, string calldata label, uint256 pass, bytes calldata proof)
        external
        view
        returns (bool)
    {
        if (proof.length != 9 * 32) return false;
        (uint256 root, uint256[8] memory zkProof) = abi.decode(proof, (uint256, uint256[8]));
        try router.verifyProof(
            root, ORB_GROUP, signalHash(owner, label), pass, externalNullifierHash, zkProof
        ) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice What the person's proof must be made over, so the proof fits one address and name.
    function signalHash(address owner, string calldata label) public pure returns (uint256) {
        return _hashToField(abi.encodePacked(owner, label));
    }

    /// @dev World's rule for fitting a hash into its field.
    function _hashToField(bytes memory value) private pure returns (uint256) {
        return uint256(keccak256(value)) >> 8;
    }
}

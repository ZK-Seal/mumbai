// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";

import {IEnsRegistry} from "../src/IEnsRegistry.sol";

bytes4 constant ERC1155_ACCEPTED = 0xf23a6e61;

interface IReceiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4);
}

/// @notice A small stand-in for the registry. Like the real one, it calls back a contract owner.
contract MockRegistry is IEnsRegistry {
    error LabelAlreadyRegistered(string label);
    error NotAccepted();

    address public lastSender;
    address public lastSubregistry;
    address public lastResolver;
    uint256 public lastRoles;
    uint64 public lastExpiry;

    mapping(string label => address owner) private _owners;

    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roles,
        uint64 expiry
    )
        external
        returns (uint256 tokenId)
    {
        if (_owners[label] != address(0)) revert LabelAlreadyRegistered(label);
        _owners[label] = owner;
        (lastSender, lastSubregistry, lastResolver) = (msg.sender, subregistry, resolver);
        (lastRoles, lastExpiry) = (roles, expiry);
        tokenId = uint256(keccak256(bytes(label)));
        if (owner.code.length != 0) {
            bytes4 answer =
                IReceiver(owner).onERC1155Received(msg.sender, address(0), tokenId, 1, "");
            if (answer != ERC1155_ACCEPTED) revert NotAccepted();
        }
    }

    function remove(string calldata label) external {
        delete _owners[label];
    }

    function findOwner(string calldata label) external view returns (address) {
        return _owners[label];
    }
}

/// @notice An owner that tries one more call while it is being minted to, and keeps the answer.
contract CallbackOwner {
    address public target;
    bytes public data;
    bool public called;
    bool public succeeded;
    bytes public answer;

    function aim(address target_, bytes calldata data_) external {
        (target, data) = (target_, data_);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        returns (bytes4)
    {
        if (target != address(0) && !called) {
            called = true;
            (succeeded, answer) = target.call(data);
        }
        return ERC1155_ACCEPTED;
    }
}

/// @notice A contract with no ERC-1155 hook. The real registry refuses to mint to it.
contract NoHookOwner {}

/// @notice An event registry that tries one more call during `register`, and keeps the answer.
contract CallbackRegistry is IEnsRegistry {
    address public target;
    bytes public data;
    bool public called;
    bool public succeeded;
    bytes public answer;

    function aim(address target_, bytes calldata data_) external {
        (target, data) = (target_, data_);
    }

    function register(string calldata, address, address, address, uint256, uint64)
        external
        returns (uint256)
    {
        called = true;
        (succeeded, answer) = target.call(data);
        return 1;
    }

    function findOwner(string calldata) external pure returns (address) {
        return address(0);
    }
}

/// @notice A check that tries to write. Solidity reaches it by static call, so the write must fail.
contract WritingCheck {
    uint256 public calls;

    function check(address, string calldata, uint256, bytes calldata) external returns (bool) {
        ++calls;
        return true;
    }
}

/// @notice World's router, accepting only one exact set of arguments.
contract MockRouter {
    bytes32 public accepted;

    function accept(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    )
        external
    {
        accepted = keccak256(
            abi.encode(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof)
        );
    }

    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    )
        external
        view
    {
        bytes32 got = keccak256(
            abi.encode(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof)
        );
        require(got == accepted, "bad proof");
    }
}

/// @notice Test-only keys and signing. No key here holds anything.
abstract contract SignHelp is Test {
    /// @dev The order of secp256k1, for making the other form of a signature.
    uint256 internal constant CURVE_ORDER =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

    uint256 internal attesterKey;
    address internal attester;
    uint256 internal strangerKey;

    function _makeKeys() internal {
        (attester, attesterKey) = makeAddrAndKey("attester");
        (, strangerKey) = makeAddrAndKey("stranger key");
    }

    function _signed(uint256 key, bytes32 messageHash) internal pure returns (bytes memory) {
        bytes32 digest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The same signer, the same message, the other valid `s`. Plain ecrecover accepts it.
    function _otherForm(bytes memory signature) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s, uint8 v) = _parts(signature);
        return abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)), v == 27 ? uint8(28) : uint8(27));
    }

    function _parts(bytes memory signature)
        internal
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
    }

    /// @dev Written out here, not read from the contract, so a change in the contract gets caught.
    function _personProof(
        uint256 key,
        address registrar,
        address owner,
        string memory label,
        uint256 pass
    )
        internal
        view
        returns (bytes memory)
    {
        return _signed(key, keccak256(abi.encode(block.chainid, registrar, owner, label, pass)));
    }

    /// @dev Written out here, not read from the contract, so a change in the contract gets caught.
    function _sealProof(
        uint256 key,
        address registrar,
        address owner,
        bytes32 seal,
        address eventRegistry,
        string memory label
    )
        internal
        view
        returns (bytes memory)
    {
        return _signed(
            key, keccak256(abi.encode(block.chainid, registrar, owner, seal, eventRegistry, label))
        );
    }
}

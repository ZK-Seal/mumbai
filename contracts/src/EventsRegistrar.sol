// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Admin} from "./Admin.sol";
import {IEnsRegistry} from "./IEnsRegistry.sol";
import {ISealCheck} from "./ISealCheck.sol";
import {LabelRules} from "./LabelRules.sol";
import {UsersRegistrar} from "./UsersRegistrar.sol";

/// @notice Gives a named user an image name under an event: one seal, one image name.
/// @dev What this does and does not promise:
///      - It must hold the registrar role on each event's registry. Image names come only through
///        here if nobody else holds that role, or the admin role that can grant it. Each event's
///        registry roles decide that, and anyone can read them.
///      - It trusts `sealCheck`. Today that is a key held by our server. No contract can check a
///        zkSeal proof today.
///      - The sender only pays gas, so a server may relay. The check is on the owner's data.
///      - `eventRegistry` is whatever the check approved. There is no list of events here.
///      - Records (contenthash, seal and by texts) are written on the resolver by the server.
contract EventsRegistrar is Admin, ReentrancyGuard {
    error NotAUser(address owner);
    error SealAlreadyUsed(bytes32 seal);
    error SealCheckFailed();
    error NotAContract(address account);

    event ImageRegistered(
        address indexed eventRegistry, string label, address indexed owner, bytes32 indexed seal
    );
    event SealCheckSet(address indexed sealCheck);

    /// @dev The owner gets no roles, so the image name stays with the user who made it.
    uint256 private constant NO_ROLES = 0;
    uint64 private constant LONGEST_EXPIRY = type(uint64).max;

    UsersRegistrar public immutable users;
    address public immutable resolver;
    ISealCheck public sealCheck;

    mapping(address eventRegistry => mapping(string label => bytes32 seal)) public sealOf;
    mapping(bytes32 seal => bool used) public usedSeal;

    constructor(
        address ownerWallet_,
        UsersRegistrar users_,
        address resolver_,
        ISealCheck sealCheck_
    )
        Admin(ownerWallet_)
    {
        if (address(users_) == address(0) || resolver_ == address(0)) revert ZeroAddress();
        users = users_;
        resolver = resolver_;
        _setSealCheck(sealCheck_);
    }

    /// @dev Our records are written before the registry is called, because the registry calls back
    ///      a contract owner, and `eventRegistry` is an outside contract. The guard also stops a
    ///      second image name being made during that call back.
    function registerImage(
        address eventRegistry,
        string calldata label,
        address owner,
        bytes32 seal,
        bytes calldata proof
    )
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        LabelRules.requireValid(label);
        if (!users.isUser(owner)) revert NotAUser(owner);
        if (usedSeal[seal]) revert SealAlreadyUsed(seal);
        if (!sealCheck.check(owner, seal, eventRegistry, label, proof)) revert SealCheckFailed();

        usedSeal[seal] = true;
        sealOf[eventRegistry][label] = seal;
        emit ImageRegistered(eventRegistry, label, owner, seal);

        tokenId = IEnsRegistry(eventRegistry).register(
            label, owner, address(0), resolver, NO_ROLES, LONGEST_EXPIRY
        );
    }

    function setSealCheck(ISealCheck sealCheck_) external onlyAdmin {
        _setSealCheck(sealCheck_);
    }

    function _setSealCheck(ISealCheck sealCheck_) private {
        if (address(sealCheck_).code.length == 0) revert NotAContract(address(sealCheck_));
        sealCheck = sealCheck_;
        emit SealCheckSet(address(sealCheck_));
    }
}

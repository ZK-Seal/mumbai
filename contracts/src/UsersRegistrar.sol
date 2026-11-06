// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Admin} from "./Admin.sol";
import {IEnsRegistry} from "./IEnsRegistry.sol";
import {IPersonCheck} from "./IPersonCheck.sol";
import {LabelRules} from "./LabelRules.sol";

/// @notice Gives a person a name under `users`: one human, one name; one address, one name.
/// @dev What this does and does not promise:
///      - It holds the registrar role on the `users` registry. Names come only through here if
///        nobody else holds that role, or the admin role that can grant it. The registry's roles
///        decide that, and anyone can read them.
///      - It trusts `personCheck`. Today that is a key held by our server, not a proof check.
///      - The sender only pays gas, so a server may relay. The check is on the owner's data.
///      - Records (address, pass text) are written on the resolver by the server, not here. A
///        resolver role has no per-name limit, so holding one here would reach every record.
contract UsersRegistrar is Admin, ReentrancyGuard {
    error PassAlreadyUsed(uint256 pass);
    error OwnerAlreadyHasName(address owner, string label);
    error PersonCheckFailed();
    error NotAContract(address account);

    event UserRegistered(string label, address indexed owner, uint256 indexed pass);
    event PersonCheckSet(address indexed personCheck);

    /// @dev The owner gets no roles. With no transfer role the name cannot move, so one address,
    ///      one name stays true, and the name cannot be pointed at another resolver.
    uint256 private constant NO_ROLES = 0;
    uint64 private constant LONGEST_EXPIRY = type(uint64).max;

    IEnsRegistry public immutable registry;
    address public immutable resolver;
    IPersonCheck public personCheck;

    mapping(string label => uint256 pass) public passOf;
    mapping(address owner => string label) public labelOf;
    mapping(uint256 pass => address owner) public ownerOfPass;

    /// @dev The registry and the check need no code yet. So a server can send all its deploys in one
    ///      wave. Until they exist, `register` reverts.
    constructor(
        address ownerWallet_,
        IEnsRegistry registry_,
        address resolver_,
        IPersonCheck personCheck_
    )
        Admin(ownerWallet_)
    {
        bool anyZero = address(registry_) == address(0) || resolver_ == address(0)
            || address(personCheck_) == address(0);
        if (anyZero) revert ZeroAddress();
        registry = registry_;
        resolver = resolver_;
        personCheck = personCheck_;
        emit PersonCheckSet(address(personCheck_));
    }

    /// @param pass The person's World nullifier from the join action.
    /// @dev Our records are written before the registry is called, because the registry calls back
    ///      a contract owner. The guard also stops a second name being made during that call back.
    function register(string calldata label, address owner, uint256 pass, bytes calldata proof)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        if (owner == address(0)) revert ZeroAddress();
        LabelRules.requireValid(label);
        if (ownerOfPass[pass] != address(0)) revert PassAlreadyUsed(pass);
        if (bytes(labelOf[owner]).length != 0) revert OwnerAlreadyHasName(owner, labelOf[owner]);
        if (!personCheck.check(owner, label, pass, proof)) revert PersonCheckFailed();

        ownerOfPass[pass] = owner;
        labelOf[owner] = label;
        passOf[label] = pass;
        emit UserRegistered(label, owner, pass);

        tokenId = registry.register(label, owner, address(0), resolver, NO_ROLES, LONGEST_EXPIRY);
    }

    /// @notice True when this address got a name here and still holds it in the registry.
    /// @dev Reads the registry, so a name removed by the registry's admin stops counting.
    function isUser(address account) external view returns (bool) {
        string memory label = labelOf[account];
        return bytes(label).length != 0 && registry.findOwner(label) == account;
    }

    function setPersonCheck(IPersonCheck personCheck_) external onlyAdmin {
        if (address(personCheck_).code.length == 0) revert NotAContract(address(personCheck_));
        personCheck = personCheck_;
        emit PersonCheckSet(address(personCheck_));
    }
}

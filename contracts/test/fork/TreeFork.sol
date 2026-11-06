// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {AttestedPersonCheck} from "../../src/AttestedPersonCheck.sol";
import {AttestedSealCheck} from "../../src/AttestedSealCheck.sol";
import {EventsRegistrar} from "../../src/EventsRegistrar.sol";
import {UsersRegistrar} from "../../src/UsersRegistrar.sol";

import {SignHelp} from "../Helpers.sol";

struct Grant {
    address account;
    uint256 roleBitmap;
}

interface IFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data)
        external
        returns (address);
    function verifyContract(address proxy) external view returns (address);
}

interface ITreeRegistry {
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error LabelAlreadyRegistered(string label);
    error TransferDisallowed(uint256 tokenId, address from);

    function register(string calldata, address, address, address, uint256, uint64)
        external
        returns (uint256);
    function setParent(address parent, string calldata label) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function findOwner(string calldata label) external view returns (address);
    function findTokenId(string calldata label) external view returns (uint256);
    function findExpiry(string calldata label) external view returns (uint64);
    function getResolver(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function getParent() external view returns (address, string memory);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function unregister(uint256 anyId) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setSubregistry(uint256 anyId, address registry) external;
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;
    function safeTransferFrom(address, address, uint256, uint256, bytes calldata) external;
}

interface ITreeResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setContenthash(bytes calldata name, bytes calldata hash) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function multicall(bytes[] calldata data) external returns (bytes[] memory);
}

interface IUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory, address);
    function findResolver(bytes calldata name) external view returns (address, bytes32, uint256);
    function reverse(bytes calldata lookupAddress, uint256 coinType)
        external
        view
        returns (string memory, address, address);
}

interface ICanonicalNames {
    function findCanonicalName(address registry) external view returns (bytes memory);
}

interface IDefaultReverse {
    function setNameForAddrWithSignature(
        address addr,
        uint256 signatureExpiry,
        string calldata name,
        bytes calldata signature
    )
        external;
}

/// @notice Builds the name tree on a local fork of mainnet, the way the server's setup does it.
/// @dev All of it stays on this machine. The bot and owner wallet are pranked: no key is used, no
///      transaction is sent. Their addresses are public. The test keys hold nothing.
abstract contract TreeForkBase is SignHelp {
    string internal constant DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

    address internal constant BOT = 0xc7713aA1b4d0eDcDA414b25Ad1d90131a53447dA;
    address internal constant OWNER_WALLET = 0x40E01a0aA046Fb7D5b6537120d4CBC3E82d1Cc23;
    ITreeRegistry internal constant ROOT_REGISTRY =
        ITreeRegistry(0x228C61e570A3c0b66f9310D5F0c7f08De126759D);
    IFactory internal constant FACTORY = IFactory(0x77510ba162dfeA3d8989E3f0928a691B345730D2);
    address internal constant PROXY_LOGIC = 0x8E77da0dAb32EfCc1C75e0Bd0e17680EBe0b1414;
    address internal constant RESOLVER_IMPL = 0x565b0F456a04Ac9b48758190e90030623Cff57C5;
    address internal constant REGISTRY_IMPL = 0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72;
    address internal constant REGISTRY_IMPL_NEWER = 0xC927bCaA77cd7bE283518760896Be0CF3Cfbe08d;
    IUniversalResolver internal constant UNIVERSAL =
        IUniversalResolver(0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe);
    ICanonicalNames internal constant CANONICAL =
        ICanonicalNames(0x46AE127D14683Ac74eF151e46ae2117A1A25C676);
    address internal constant DEFAULT_REVERSE = 0x283F227c4Bd38ecE252C4Ae7ECE650B0e913f1f9;
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    bytes32 internal constant IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant RESOLVER_WRITES = 0x111; // address, text, contenthash
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint64 internal constant NEVER = type(uint64).max;

    string internal constant EVENT = "mumbai-march";
    uint256 internal constant ETH_COIN = 60;

    string internal rootLabel;
    string internal rootName;
    string internal passKey;
    string internal sealKey;
    string internal byKey;

    address internal resolver;
    ITreeRegistry internal usersRegistry;
    ITreeRegistry internal eventsRegistry;
    ITreeRegistry internal eventRegistry;

    AttestedPersonCheck internal personCheck;
    AttestedSealCheck internal sealCheck;
    UsersRegistrar internal users;
    EventsRegistrar internal events;

    // What each variant of the tree changes.

    function _registryImpl() internal pure virtual returns (address);

    /// @dev True: the role plan with narrowed bitmaps. False: as the server's code is today.
    function _narrow() internal pure virtual returns (bool);

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", DEFAULT_RPC));
        require(block.chainid == 1, "not a fork of mainnet");
        require(
            ROOT_REGISTRY.getSubregistry("users") == address(0),
            "the real tree exists now: these tests build it from nothing, on free labels"
        );
        _makeKeys();

        (, rootLabel) = ROOT_REGISTRY.getParent();
        rootName = string.concat(rootLabel, ".eth");
        string memory prefix = string.concat("eth.", rootLabel, ".");
        passKey = string.concat(prefix, "pass");
        sealKey = string.concat(prefix, "seal");
        byKey = string.concat(prefix, "by");

        resolver = _proxyAddress(_salt("TreeResolver", rootName));
        usersRegistry = ITreeRegistry(_proxyAddress(_salt("TreeRegistry", _usersName())));
        eventsRegistry = ITreeRegistry(_proxyAddress(_salt("TreeRegistry", _eventsName())));

        _deployRegistrars();
        _setUpTree();
    }

    // Registrars: deployed by the bot through the CREATE2 helper. Their deploys fit the server's
    // wave shape, and the bot does not become an admin.

    function _deployRegistrars() internal virtual {
        personCheck = AttestedPersonCheck(
            _create2(
                abi.encodePacked(
                    type(AttestedPersonCheck).creationCode, abi.encode(OWNER_WALLET, attester)
                )
            )
        );
        sealCheck = AttestedSealCheck(
            _create2(
                abi.encodePacked(
                    type(AttestedSealCheck).creationCode, abi.encode(OWNER_WALLET, attester)
                )
            )
        );
        users = UsersRegistrar(
            _create2(
                abi.encodePacked(
                    type(UsersRegistrar).creationCode,
                    abi.encode(OWNER_WALLET, usersRegistry, resolver, personCheck)
                )
            )
        );
        events = EventsRegistrar(
            _create2(
                abi.encodePacked(
                    type(EventsRegistrar).creationCode,
                    abi.encode(OWNER_WALLET, users, resolver, sealCheck)
                )
            )
        );
    }

    function _create2(bytes memory initCode) internal returns (address predicted) {
        bytes32 salt = keccak256("registrars");
        predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        vm.prank(BOT);
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && predicted.code.length != 0, "create2 deploy failed");
    }

    // The tree, in the order of the server's setup and first-picture code.

    function _setUpTree() internal {
        Grant[] memory grants = _grants(_botBranchRoles(), address(0), 0);
        _deployResolver();
        _deployRegistryAt(
            usersRegistry,
            _salt("TreeRegistry", _usersName()),
            _narrow() ? _grants(ROLE_SET_PARENT, address(users), ROLE_REGISTRAR) : grants
        );
        _deployRegistryAt(eventsRegistry, _salt("TreeRegistry", _eventsName()), grants);

        address branchOwner = _narrow() ? OWNER_WALLET : BOT;
        vm.startPrank(BOT);
        ROOT_REGISTRY.register(
            "users", branchOwner, address(usersRegistry), resolver, _branchRoles(), NEVER
        );
        ROOT_REGISTRY.register(
            "events", branchOwner, address(eventsRegistry), resolver, _branchRoles(), NEVER
        );
        usersRegistry.setParent(address(ROOT_REGISTRY), "users");
        eventsRegistry.setParent(address(ROOT_REGISTRY), "events");
        if (!_narrow()) usersRegistry.grantRootRoles(ROLE_REGISTRAR, address(users));
        vm.stopPrank();

        eventRegistry = _makeEvent(EVENT);
    }

    /// @dev As `eventPlan` in the server's code, with the registrar's grant added.
    function _makeEvent(string memory label) internal returns (ITreeRegistry registry) {
        registry = _deployEventRegistry(label);
        vm.startPrank(BOT);
        eventsRegistry.register(label, BOT, address(registry), resolver, 0, NEVER);
        registry.setParent(address(eventsRegistry), label);
        if (!_narrow()) registry.grantRootRoles(ROLE_REGISTRAR, address(events));
        vm.stopPrank();
    }

    function _deployEventRegistry(string memory label) internal returns (ITreeRegistry registry) {
        uint256 salt = _salt("TreeRegistry", _eventName(label));
        registry = ITreeRegistry(_proxyAddress(salt));
        _deployRegistryAt(
            registry,
            salt,
            _narrow()
                ? _grants(ROLE_SET_PARENT, address(events), ROLE_REGISTRAR)
                : _grants(_botBranchRoles(), address(0), 0)
        );
    }

    function _deployResolver() internal {
        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant(BOT, _narrow() ? RESOLVER_WRITES : ALL_ROLES);
        grants[1] = Grant(OWNER_WALLET, ALL_ROLES);
        bytes memory init = abi.encodeWithSignature(
            "initialize((address,uint256)[],bytes[])", grants, new bytes[](0)
        );
        vm.prank(BOT);
        address made = FACTORY.deployProxy(RESOLVER_IMPL, _salt("TreeResolver", rootName), init);
        assertEq(made, resolver, "the resolver is not at its derived address");
    }

    function _deployRegistryAt(ITreeRegistry at, uint256 salt, Grant[] memory grants) internal {
        bytes memory init = abi.encodeWithSignature("initialize((address,uint256)[])", grants);
        vm.prank(BOT);
        address made = FACTORY.deployProxy(_registryImpl(), salt, init);
        assertEq(made, address(at), "a registry is not at its derived address");
    }

    function _grants(uint256 botRoles, address registrar, uint256 registrarRoles)
        internal
        pure
        returns (Grant[] memory grants)
    {
        grants = new Grant[](registrar == address(0) ? 2 : 3);
        grants[0] = Grant(BOT, botRoles);
        grants[1] = Grant(OWNER_WALLET, ALL_ROLES);
        if (registrar != address(0)) grants[2] = Grant(registrar, registrarRoles);
    }

    /// @dev The bot's roles on `events`. It must keep the registrar role there to make new events.
    function _botBranchRoles() internal pure returns (uint256) {
        return _narrow() ? ROLE_REGISTRAR | ROLE_SET_PARENT : ALL_ROLES;
    }

    function _branchRoles() internal pure returns (uint256) {
        uint256 low = ROLE_RENEW | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER;
        return low | (low << 128) | ROLE_CAN_TRANSFER_ADMIN;
    }

    // Where things are: the same formulas as the server's.

    function _salt(string memory kind, string memory name) internal pure returns (uint256) {
        return uint256(
            keccak256(abi.encode(keccak256(bytes(kind)), _namehash(_dns(name)), uint256(0)))
        );
    }

    function _proxyAddress(uint256 salt) internal pure returns (address) {
        bytes32 outer = keccak256(abi.encode(BOT, salt));
        bytes memory code = abi.encodePacked(
            hex"3d604d80600a3d3981f3363d3d373d3d3d363d73",
            PROXY_LOGIC,
            hex"5af43d82803e903d91602b57fd5bf3",
            outer
        );
        return vm.computeCreate2Address(outer, keccak256(code), address(FACTORY));
    }

    function _usersName() internal view returns (string memory) {
        return string.concat("users.", rootName);
    }

    function _eventsName() internal view returns (string memory) {
        return string.concat("events.", rootName);
    }

    function _userName(string memory label) internal view returns (string memory) {
        return string.concat(label, ".", _usersName());
    }

    function _eventName(string memory label) internal view returns (string memory) {
        return string.concat(label, ".", _eventsName());
    }

    function _imageName(string memory label) internal view returns (string memory) {
        return string.concat(label, ".", _eventName(EVENT));
    }

    /// @dev "a.b.eth" to its DNS form.
    function _dns(string memory name) internal pure returns (bytes memory out) {
        bytes memory raw = bytes(name);
        uint256 start;
        for (uint256 i; i <= raw.length; ++i) {
            if (i == raw.length || raw[i] == ".") {
                bytes memory part = new bytes(i - start);
                for (uint256 j; j < part.length; ++j) {
                    part[j] = raw[start + j];
                }
                out = abi.encodePacked(out, uint8(part.length), part);
                start = i + 1;
            }
        }
        out = abi.encodePacked(out, uint8(0));
    }

    function _namehash(bytes memory dnsName) internal pure returns (bytes32) {
        return _namehashAt(dnsName, 0);
    }

    function _namehashAt(bytes memory dnsName, uint256 at) private pure returns (bytes32) {
        uint256 size = uint8(dnsName[at]);
        if (size == 0) return bytes32(0);
        bytes memory part = new bytes(size);
        for (uint256 i; i < size; ++i) {
            part[i] = dnsName[at + 1 + i];
        }
        return keccak256(abi.encodePacked(_namehashAt(dnsName, at + 1 + size), keccak256(part)));
    }

    // Reading, the way anyone else reads: through the Universal Resolver.

    function _readText(string memory name, string memory key) internal view returns (string memory) {
        bytes memory dnsName = _dns(name);
        (bytes memory out,) = UNIVERSAL.resolve(
            dnsName, abi.encodeWithSignature("text(bytes32,string)", _namehash(dnsName), key)
        );
        return abi.decode(out, (string));
    }

    function _readAddress(string memory name) internal view returns (bytes memory) {
        bytes memory dnsName = _dns(name);
        (bytes memory out,) = UNIVERSAL.resolve(
            dnsName,
            abi.encodeWithSignature("addr(bytes32,uint256)", _namehash(dnsName), ETH_COIN)
        );
        return abi.decode(out, (bytes));
    }

    function _readContenthash(string memory name) internal view returns (bytes memory) {
        bytes memory dnsName = _dns(name);
        (bytes memory out,) = UNIVERSAL.resolve(
            dnsName, abi.encodeWithSignature("contenthash(bytes32)", _namehash(dnsName))
        );
        return abi.decode(out, (bytes));
    }

    // Writing records as the bot, in the server's multicall shape.

    function _botWritesUserRecords(string memory name, address owner, string memory pass) internal {
        bytes memory dnsName = _dns(name);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(ITreeResolver.setText, (dnsName, passKey, pass));
        calls[1] = abi.encodeCall(
            ITreeResolver.setAddress, (dnsName, ETH_COIN, abi.encodePacked(owner))
        );
        vm.prank(BOT);
        ITreeResolver(resolver).multicall(calls);
    }

    function _botWritesImageRecords(
        string memory name,
        address owner,
        string memory seal,
        string memory by,
        bytes memory contenthash
    )
        internal
    {
        bytes memory dnsName = _dns(name);
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeCall(ITreeResolver.setText, (dnsName, sealKey, seal));
        calls[1] = abi.encodeCall(ITreeResolver.setText, (dnsName, byKey, by));
        calls[2] = abi.encodeCall(ITreeResolver.setContenthash, (dnsName, contenthash));
        calls[3] = abi.encodeCall(
            ITreeResolver.setAddress, (dnsName, ETH_COIN, abi.encodePacked(owner))
        );
        vm.prank(BOT);
        ITreeResolver(resolver).multicall(calls);
    }

    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
    }
}

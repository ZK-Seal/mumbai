// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Admin} from "../../src/Admin.sol";
import {EventsRegistrar} from "../../src/EventsRegistrar.sol";
import {IEnsRegistry} from "../../src/IEnsRegistry.sol";
import {IWorldRouter, WorldPersonCheck} from "../../src/WorldPersonCheck.sol";
import {UsersRegistrar} from "../../src/UsersRegistrar.sol";

import {CallbackOwner, NoHookOwner} from "../Helpers.sol";
import {
    IDefaultReverse,
    ITreeRegistry,
    ITreeResolver,
    TreeForkBase
} from "./TreeFork.sol";

/// @notice The cases, on the real registry and resolver code, in a tree built like the server's.
abstract contract TreeCases is TreeForkBase {
    address internal constant WORLD_ROUTER = 0x163b09b4fE21177c455D850BD815B6D583732432;

    string internal constant PASS_TEXT =
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    uint256 internal constant PASS =
        0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
    bytes32 internal constant SEAL = keccak256("first photo");
    bytes32 internal constant SEAL_TWO = keccak256("second photo");
    bytes internal constant CONTENTHASH =
        hex"e40101fa011b20aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899aabb";

    // Not "alice" and "bob": those well-known test keys hold code on mainnet today.
    address internal alice = makeAddr("tree case person one");
    address internal bob = makeAddr("tree case person two");

    function _join(address owner, string memory label, uint256 pass) internal {
        users.register(label, owner, pass, _userProof(owner, label, pass));
    }

    function _userProof(address owner, string memory label, uint256 pass)
        internal
        view
        returns (bytes memory)
    {
        return _personProof(attesterKey, address(users), owner, label, pass);
    }

    function _imageProof(address owner, bytes32 seal, ITreeRegistry registry, string memory label)
        internal
        view
        returns (bytes memory)
    {
        return _sealProof(attesterKey, address(events), owner, seal, address(registry), label);
    }

    // The six cases asked for.

    function test_goodAttestationMintsToOwner() public {
        bytes memory proof = _userProof(alice, "alice", PASS);
        vm.prank(BOT); // The bot only relays and pays.
        uint256 tokenId = users.register("alice", alice, PASS, proof);

        assertEq(usersRegistry.findOwner("alice"), alice);
        assertEq(usersRegistry.findTokenId("alice"), tokenId);
        assertEq(usersRegistry.getResolver("alice"), resolver);
        assertEq(usersRegistry.getSubregistry("alice"), address(0));
        assertEq(usersRegistry.findExpiry("alice"), NEVER);
        assertEq(users.labelOf(alice), "alice");
        assertEq(users.passOf("alice"), PASS);
        assertEq(users.ownerOfPass(PASS), alice);
        assertTrue(users.isUser(alice));
    }

    function test_wrongSigner() public {
        bytes memory proof = _personProof(strangerKey, address(users), alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, proof);
        assertEq(usersRegistry.findOwner("alice"), address(0));
    }

    function test_reusedPass() public {
        _join(alice, "alice", PASS);
        bytes memory proof = _userProof(bob, "bob-name", PASS);
        vm.expectRevert(abi.encodeWithSelector(UsersRegistrar.PassAlreadyUsed.selector, PASS));
        users.register("bob-name", bob, PASS, proof);
        assertEq(usersRegistry.findOwner("bob-name"), address(0));
    }

    function test_secondNameForOneAddress() public {
        _join(alice, "alice", PASS);
        bytes memory proof = _userProof(alice, "second", PASS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(UsersRegistrar.OwnerAlreadyHasName.selector, alice, "alice")
        );
        users.register("second", alice, PASS + 1, proof);
        assertEq(usersRegistry.findOwner("second"), address(0));
    }

    function test_imageWithoutUserName() public {
        bytes memory proof = _imageProof(alice, SEAL, eventRegistry, "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.NotAUser.selector, alice));
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
        assertEq(eventRegistry.findOwner("image1"), address(0));
    }

    function test_reusedSeal() public {
        _join(alice, "alice", PASS);
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _imageProof(alice, SEAL, eventRegistry, "image1")
        );
        bytes memory proof = _imageProof(alice, SEAL, eventRegistry, "image2");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.SealAlreadyUsed.selector, SEAL));
        events.registerImage(address(eventRegistry), "image2", alice, SEAL, proof);
        assertEq(eventRegistry.findOwner("image2"), address(0));
    }

    // The image path.

    function test_goodImageMintsToOwner() public {
        _join(alice, "alice", PASS);
        bytes memory proof = _imageProof(alice, SEAL, eventRegistry, "image1");
        vm.prank(BOT);
        uint256 tokenId = events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);

        assertEq(eventRegistry.findOwner("image1"), alice);
        assertEq(eventRegistry.findTokenId("image1"), tokenId);
        assertEq(eventRegistry.getResolver("image1"), resolver);
        assertEq(eventRegistry.getSubregistry("image1"), address(0));
        assertEq(eventRegistry.findExpiry("image1"), NEVER);
        assertEq(events.sealOf(address(eventRegistry), "image1"), SEAL);
        assertTrue(events.usedSeal(SEAL));
    }

    /// @dev Each photo has its own World proof and nullifier. Only the owner and the seal reach
    ///      the contract, so two photos of one person work with no pass at all.
    function test_twoPhotosOfOnePerson() public {
        _join(alice, "alice", PASS);
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _imageProof(alice, SEAL, eventRegistry, "image1")
        );
        events.registerImage(
            address(eventRegistry),
            "image2",
            alice,
            SEAL_TWO,
            _imageProof(alice, SEAL_TWO, eventRegistry, "image2")
        );
        assertEq(eventRegistry.findOwner("image1"), alice);
        assertEq(eventRegistry.findOwner("image2"), alice);
    }

    function test_oneSealCannotGoToASecondEvent() public {
        _join(alice, "alice", PASS);
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _imageProof(alice, SEAL, eventRegistry, "image1")
        );
        ITreeRegistry other = _makeEvent("other-event");
        bytes memory proof = _imageProof(alice, SEAL, other, "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.SealAlreadyUsed.selector, SEAL));
        events.registerImage(address(other), "image1", alice, SEAL, proof);
    }

    // Records stay with the bot.

    /// @dev Records first, then the name: the order of `registerUser` in the server's code.
    function test_userRecordsThenNameReadThroughUniversalResolver() public {
        string memory name = _userName("alice");
        _botWritesUserRecords(name, alice, PASS_TEXT);
        _join(alice, "alice", PASS);

        (address found,,) = UNIVERSAL.findResolver(_dns(name));
        assertEq(found, resolver);
        assertEq(_readText(name, passKey), PASS_TEXT);
        assertEq(_readAddress(name), abi.encodePacked(alice));
    }

    function test_botStillWritesRecordsAfterTheMint() public {
        string memory name = _userName("alice");
        _join(alice, "alice", PASS);
        _botWritesUserRecords(name, alice, PASS_TEXT);
        assertEq(_readText(name, passKey), PASS_TEXT);
        assertEq(_readAddress(name), abi.encodePacked(alice));
    }

    /// @dev The whole first-picture flow, on a new event, in the waves of the server's code.
    function test_firstPictureOfANewEventReadThroughUniversalResolver() public {
        _join(alice, "alice", PASS);
        _botWritesUserRecords(_userName("alice"), alice, PASS_TEXT);

        string memory label = "new-event";
        ITreeRegistry registry = _deployEventRegistry(label);
        vm.prank(BOT);
        eventsRegistry.register(label, BOT, address(registry), resolver, 0, NEVER);
        string memory name = string.concat("image1.", _eventName(label));
        _botWritesImageRecords(name, alice, vm.toString(SEAL), _userName("alice"), CONTENTHASH);

        vm.startPrank(BOT);
        registry.setParent(address(eventsRegistry), label);
        if (!_narrow()) registry.grantRootRoles(ROLE_REGISTRAR, address(events));
        vm.stopPrank();

        bytes memory proof = _imageProof(alice, SEAL, registry, "image1");
        vm.prank(BOT);
        events.registerImage(address(registry), "image1", alice, SEAL, proof);

        assertEq(registry.findOwner("image1"), alice);
        (address found,,) = UNIVERSAL.findResolver(_dns(name));
        assertEq(found, resolver);
        assertEq(_readContenthash(name), CONTENTHASH);
        assertEq(_readText(name, sealKey), vm.toString(SEAL));
        assertEq(_readText(name, byKey), _userName("alice"));
        assertEq(_readAddress(name), abi.encodePacked(alice));
    }

    /// @dev The default reverse registrar path of the server's code: signed by the person's address,
    ///      sent by the bot. The registrar's mint must not break it.
    function test_primaryNameOnARegistrarName() public {
        (address person, uint256 personKey) = makeAddrAndKey("person with a test key");
        string memory name = _userName("alice");
        _botWritesUserRecords(name, person, PASS_TEXT);
        _join(person, "alice", PASS);

        uint256 expiry = block.timestamp + 1800;
        bytes32 message = keccak256(
            abi.encodePacked(
                DEFAULT_REVERSE,
                IDefaultReverse.setNameForAddrWithSignature.selector,
                person,
                expiry,
                name
            )
        );
        bytes memory signature = _signed(personKey, message);
        vm.prank(BOT);
        IDefaultReverse(DEFAULT_REVERSE).setNameForAddrWithSignature(person, expiry, name, signature);

        (string memory primary,,) = UNIVERSAL.reverse(abi.encodePacked(person), ETH_COIN);
        assertEq(primary, name);
    }

    function test_ownerWithNoRolesCanChangeNothing() public {
        _join(alice, "alice", PASS);
        uint256 labelId = uint256(keccak256("alice"));
        uint256 tokenId = usersRegistry.findTokenId("alice");
        bytes memory dnsName = _dns(_userName("alice"));

        assertEq(usersRegistry.roles(labelId, alice), 0);

        vm.startPrank(alice);
        vm.expectRevert();
        usersRegistry.setResolver(labelId, alice);
        vm.expectRevert();
        usersRegistry.setSubregistry(labelId, alice);
        vm.expectRevert();
        usersRegistry.unregister(labelId);
        vm.expectRevert(
            abi.encodeWithSelector(ITreeRegistry.TransferDisallowed.selector, tokenId, alice)
        );
        usersRegistry.unsafeTransfer(bob, tokenId, "");
        vm.expectRevert();
        usersRegistry.safeTransferFrom(alice, bob, tokenId, 1, "");
        vm.expectRevert();
        ITreeResolver(resolver).setText(dnsName, passKey, "changed");
        vm.stopPrank();

        assertEq(usersRegistry.findOwner("alice"), alice);
    }

    // The tree's shape.

    function test_setParentGivesCanonicalNames() public view {
        assertEq(CANONICAL.findCanonicalName(address(usersRegistry)), _dns(_usersName()));
        assertEq(CANONICAL.findCanonicalName(address(eventsRegistry)), _dns(_eventsName()));
        assertEq(CANONICAL.findCanonicalName(address(eventRegistry)), _dns(_eventName(EVENT)));
    }

    function test_registriesRunTheExpectedCode() public view {
        assertEq(_implementationOf(address(usersRegistry)), _registryImpl());
        assertEq(_implementationOf(address(eventsRegistry)), _registryImpl());
        assertEq(_implementationOf(address(eventRegistry)), _registryImpl());
        assertEq(FACTORY.verifyContract(address(usersRegistry)), _registryImpl());
        assertEq(_implementationOf(address(ROOT_REGISTRY)), REGISTRY_IMPL);
    }

    function test_registrarsHoldOnlyTheRegistrarRole() public view {
        assertEq(usersRegistry.roles(0, address(users)), ROLE_REGISTRAR);
        assertEq(eventRegistry.roles(0, address(events)), ROLE_REGISTRAR);
        assertEq(usersRegistry.roles(0, address(events)), 0);
        assertEq(eventsRegistry.roles(0, address(events)), 0);
    }

    // Who can mint.

    function test_strangerCannotMintDirectly() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreeRegistry.EACUnauthorizedAccountRoles.selector, 0, ROLE_REGISTRAR, alice
            )
        );
        usersRegistry.register("alice", alice, address(0), resolver, 0, NEVER);
    }

    function test_registrarWithoutTheRoleCannotMint() public {
        UsersRegistrar other = new UsersRegistrar(
            OWNER_WALLET, IEnsRegistry(address(usersRegistry)), resolver, personCheck
        );
        bytes memory proof = _personProof(attesterKey, address(other), alice, "alice", PASS);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreeRegistry.EACUnauthorizedAccountRoles.selector, 0, ROLE_REGISTRAR, address(other)
            )
        );
        other.register("alice", alice, PASS, proof);
        assertEq(other.ownerOfPass(PASS), address(0));
    }

    /// @dev A forgotten grant must not burn the seal: the same signature works once it is fixed.
    function test_forgottenEventGrantLeavesSealFree() public {
        _join(alice, "alice", PASS);
        vm.prank(OWNER_WALLET);
        eventRegistry.revokeRootRoles(ROLE_REGISTRAR, address(events));

        bytes memory proof = _imageProof(alice, SEAL, eventRegistry, "image1");
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreeRegistry.EACUnauthorizedAccountRoles.selector, 0, ROLE_REGISTRAR, address(events)
            )
        );
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
        assertFalse(events.usedSeal(SEAL));

        vm.prank(OWNER_WALLET);
        eventRegistry.grantRootRoles(ROLE_REGISTRAR, address(events));
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
        assertEq(eventRegistry.findOwner("image1"), alice);
    }

    function test_takenLabelLeavesPassFree() public {
        _join(alice, "alice", PASS);
        bytes memory proof = _userProof(bob, "alice", PASS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ITreeRegistry.LabelAlreadyRegistered.selector, "alice")
        );
        users.register("alice", bob, PASS + 1, proof);
        assertEq(users.ownerOfPass(PASS + 1), address(0));
    }

    function test_removedNameStopsCounting() public {
        _join(alice, "alice", PASS);
        vm.prank(OWNER_WALLET);
        usersRegistry.unregister(uint256(keccak256("alice")));
        assertFalse(users.isUser(alice));

        bytes memory proof = _imageProof(alice, SEAL, eventRegistry, "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.NotAUser.selector, alice));
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    // Call backs from the real registry.

    function test_ownerCannotCallBackForASecondName() public {
        CallbackOwner hostile = new CallbackOwner();
        bytes memory inner = _userProof(bob, "bob-name", PASS + 1);
        hostile.aim(
            address(users), abi.encodeCall(users.register, ("bob-name", bob, PASS + 1, inner))
        );
        users.register(
            "hostile", address(hostile), PASS, _userProof(address(hostile), "hostile", PASS)
        );

        assertTrue(hostile.called());
        assertFalse(hostile.succeeded());
        assertEq(
            bytes4(hostile.answer()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertEq(usersRegistry.findOwner("bob-name"), address(0));
        assertEq(usersRegistry.findOwner("hostile"), address(hostile));
    }

    function test_ownerWithoutTheHookLeavesPassFree() public {
        NoHookOwner plain = new NoHookOwner();
        bytes memory proof = _userProof(address(plain), "plain", PASS);
        vm.expectRevert(
            abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(plain))
        );
        users.register("plain", address(plain), PASS, proof);
        assertEq(users.ownerOfPass(PASS), address(0));
    }

    // Admin, after a deploy through the CREATE2 helper.

    function test_botIsNoAdminAfterCreate2Deploy() public {
        assertFalse(users.isAdmin(BOT));
        assertFalse(events.isAdmin(BOT));
        assertFalse(personCheck.isAdmin(BOT));
        assertFalse(sealCheck.isAdmin(BOT));
        assertEq(users.deployer(), CREATE2_DEPLOYER);

        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, BOT));
        personCheck.setAttester(BOT);
        vm.prank(BOT);
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, BOT));
        users.setPersonCheck(personCheck);

        vm.prank(OWNER_WALLET);
        personCheck.setAttester(BOT);
        assertEq(personCheck.attester(), BOT);
    }

    // World's real router: only a refusal can be shown, since no good proof can be made here.

    function test_worldCheckSaysNoToAMadeUpProof() public {
        WorldPersonCheck world =
            new WorldPersonCheck(IWorldRouter(WORLD_ROUTER), "app_test", "join");
        uint256[8] memory zk;
        assertFalse(world.check(alice, "alice", PASS, abi.encode(uint256(1), zk)));
        assertFalse(world.check(alice, "alice", PASS, hex"00"));
    }
}

/// The tree as the server's code builds it today: the bot and owner wallet hold every role.
/// The registrar roles are granted by the bot in a transaction.
contract ForkTreeAsToday is TreeCases {
    function _registryImpl() internal pure override returns (address) {
        return REGISTRY_IMPL;
    }

    function _narrow() internal pure override returns (bool) {
        return false;
    }

    /// @dev Here "names only through the registrars" is false, and this test says so.
    function test_botCanStillMintDirectly() public {
        vm.prank(BOT);
        usersRegistry.register("direct", alice, address(0), resolver, 0, NEVER);
        assertEq(usersRegistry.findOwner("direct"), alice);
    }
}

/// The narrowed plan: the bot keeps only what it calls, and the registrars get their role at deploy.
contract ForkTreeNarrowed is TreeCases {
    function _registryImpl() internal pure override returns (address) {
        return REGISTRY_IMPL;
    }

    function _narrow() internal pure override returns (bool) {
        return true;
    }

    function test_botCannotMintDirectlyOnUsersOrEvent() public {
        vm.startPrank(BOT);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreeRegistry.EACUnauthorizedAccountRoles.selector, 0, ROLE_REGISTRAR, BOT
            )
        );
        usersRegistry.register("direct", alice, address(0), resolver, 0, NEVER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ITreeRegistry.EACUnauthorizedAccountRoles.selector, 0, ROLE_REGISTRAR, BOT
            )
        );
        eventRegistry.register("direct", alice, address(0), resolver, 0, NEVER);
        vm.stopPrank();
    }

    function test_botCannotGrantItselfTheRoleBack() public {
        vm.prank(BOT);
        vm.expectRevert();
        usersRegistry.grantRootRoles(ROLE_REGISTRAR, BOT);
    }

    function test_botKeepsOnlyTheNarrowedRoles() public view {
        assertEq(usersRegistry.roles(0, BOT), ROLE_SET_PARENT);
        assertEq(eventRegistry.roles(0, BOT), ROLE_SET_PARENT);
        assertEq(eventsRegistry.roles(0, BOT), ROLE_REGISTRAR | ROLE_SET_PARENT);
    }

    function test_branchLabelsAreHeldByTheOwnerWallet() public view {
        assertEq(ROOT_REGISTRY.findOwner("users"), OWNER_WALLET);
        assertEq(ROOT_REGISTRY.findOwner("events"), OWNER_WALLET);
    }

    /// @dev What stays true of the narrowed plan: the bot can still make an event of its own.
    function test_botCanStillMakeAnEventItControls() public {
        vm.prank(BOT);
        eventsRegistry.register("bots-event", BOT, address(0), resolver, 0, NEVER);
        assertEq(eventsRegistry.findOwner("bots-event"), BOT);
    }
}

/// The narrowed plan on the newer registry code, which the ENS app's list prefers to the older one.
contract ForkTreeNarrowedNewerCode is TreeCases {
    function _registryImpl() internal pure override returns (address) {
        return REGISTRY_IMPL_NEWER;
    }

    function _narrow() internal pure override returns (bool) {
        return true;
    }
}

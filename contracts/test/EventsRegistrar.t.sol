// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Admin} from "../src/Admin.sol";
import {AttestedPersonCheck} from "../src/AttestedPersonCheck.sol";
import {AttestedSealCheck} from "../src/AttestedSealCheck.sol";
import {EventsRegistrar} from "../src/EventsRegistrar.sol";
import {ISealCheck} from "../src/ISealCheck.sol";
import {LabelRules} from "../src/LabelRules.sol";
import {UsersRegistrar} from "../src/UsersRegistrar.sol";

import {CallbackOwner, CallbackRegistry, MockRegistry, SignHelp} from "./Helpers.sol";

contract EventsRegistrarTest is SignHelp {
    event ImageRegistered(
        address indexed eventRegistry, string label, address indexed owner, bytes32 indexed seal
    );

    MockRegistry internal usersRegistry;
    MockRegistry internal eventRegistry;
    AttestedPersonCheck internal personCheck;
    AttestedSealCheck internal sealCheck;
    UsersRegistrar internal users;
    EventsRegistrar internal events;

    address internal ownerWallet = makeAddr("owner wallet");
    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("unit test person one");
    address internal bob = makeAddr("unit test person two");

    uint256 internal constant ALICE_PASS = 111;
    bytes32 internal constant SEAL = keccak256("seal one");
    bytes32 internal constant SEAL_TWO = keccak256("seal two");

    function setUp() public {
        _makeKeys();
        usersRegistry = new MockRegistry();
        eventRegistry = new MockRegistry();
        personCheck = new AttestedPersonCheck(ownerWallet, attester);
        sealCheck = new AttestedSealCheck(ownerWallet, attester);
        users = new UsersRegistrar(ownerWallet, usersRegistry, resolver, personCheck);
        events = new EventsRegistrar(ownerWallet, users, resolver, sealCheck);
        _join(alice, "alice", ALICE_PASS);
    }

    function _join(address owner, string memory label, uint256 pass) internal {
        users.register(
            label, owner, pass, _personProof(attesterKey, address(users), owner, label, pass)
        );
    }

    function _proof(address owner, bytes32 seal, address registry, string memory label)
        internal
        view
        returns (bytes memory)
    {
        return _sealProof(attesterKey, address(events), owner, seal, registry, label);
    }

    // The cases asked for.

    function test_goodImageMintsToOwner() public {
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectEmit(address(events));
        emit ImageRegistered(address(eventRegistry), "image1", alice, SEAL);
        vm.prank(makeAddr("relayer"));
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);

        assertEq(eventRegistry.findOwner("image1"), alice);
        assertEq(events.sealOf(address(eventRegistry), "image1"), SEAL);
        assertTrue(events.usedSeal(SEAL));
        assertEq(eventRegistry.lastSender(), address(events));
        assertEq(eventRegistry.lastSubregistry(), address(0));
        assertEq(eventRegistry.lastResolver(), resolver);
        assertEq(eventRegistry.lastRoles(), 0);
        assertEq(eventRegistry.lastExpiry(), type(uint64).max);
    }

    function test_imageWithoutUserName() public {
        bytes memory proof = _proof(bob, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.NotAUser.selector, bob));
        events.registerImage(address(eventRegistry), "image1", bob, SEAL, proof);
        assertFalse(events.usedSeal(SEAL));
    }

    function test_reusedSealSameEvent() public {
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _proof(alice, SEAL, address(eventRegistry), "image1")
        );
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image2");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.SealAlreadyUsed.selector, SEAL));
        events.registerImage(address(eventRegistry), "image2", alice, SEAL, proof);
    }

    function test_reusedSealOtherEvent() public {
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _proof(alice, SEAL, address(eventRegistry), "image1")
        );
        MockRegistry other = new MockRegistry();
        bytes memory proof = _proof(alice, SEAL, address(other), "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.SealAlreadyUsed.selector, SEAL));
        events.registerImage(address(other), "image1", alice, SEAL, proof);
    }

    function test_reusedSealByAnotherPerson() public {
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _proof(alice, SEAL, address(eventRegistry), "image1")
        );
        _join(bob, "bob-name", 222);
        bytes memory proof = _proof(bob, SEAL, address(eventRegistry), "image2");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.SealAlreadyUsed.selector, SEAL));
        events.registerImage(address(eventRegistry), "image2", bob, SEAL, proof);
    }

    function test_wrongSigner() public {
        bytes memory proof = _sealProof(
            strangerKey, address(events), alice, SEAL, address(eventRegistry), "image1"
        );
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    // The session change: each photo has its own World proof, and its nullifier is not the pass.

    function test_twoPhotosOfOnePersonNeedNoPass() public {
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _proof(alice, SEAL, address(eventRegistry), "image1")
        );
        events.registerImage(
            address(eventRegistry),
            "image2",
            alice,
            SEAL_TWO,
            _proof(alice, SEAL_TWO, address(eventRegistry), "image2")
        );
        assertEq(eventRegistry.findOwner("image1"), alice);
        assertEq(eventRegistry.findOwner("image2"), alice);
        assertEq(users.ownerOfPass(ALICE_PASS), alice);
    }

    function test_signatureForOnePersonFailsForAnother() public {
        _join(bob, "bob-name", 222);
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", bob, SEAL, proof);
    }

    function test_removedPersonLosesImagePath() public {
        usersRegistry.remove("alice");
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.NotAUser.selector, alice));
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    // Signed data: every field counts.

    function test_signatureBoundToLabel() public {
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image9", alice, SEAL, proof);
        assertFalse(events.usedSeal(SEAL));
    }

    function test_signatureBoundToSeal() public {
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", alice, SEAL_TWO, proof);
    }

    function test_signatureBoundToEvent() public {
        MockRegistry other = new MockRegistry();
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(other), "image1", alice, SEAL, proof);
    }

    function test_signatureBoundToRegistrar() public {
        EventsRegistrar other = new EventsRegistrar(ownerWallet, users, resolver, sealCheck);
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        other.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    function test_signatureBoundToChain() public {
        bytes memory proof = _proof(alice, SEAL, address(eventRegistry), "image1");
        vm.chainId(block.chainid + 1);
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    function test_otherFormOfSignatureRefused() public {
        bytes memory proof = _otherForm(_proof(alice, SEAL, address(eventRegistry), "image1"));
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    function test_personSignatureIsNoSealSignature() public {
        bytes memory proof = _personProof(attesterKey, address(events), alice, "image1", 1);
        vm.expectRevert(EventsRegistrar.SealCheckFailed.selector);
        events.registerImage(address(eventRegistry), "image1", alice, SEAL, proof);
    }

    function test_badLabelRefused() public {
        vm.expectRevert(abi.encodeWithSelector(LabelRules.InvalidLabel.selector, "a.b"));
        events.registerImage(address(eventRegistry), "a.b", alice, SEAL, "");
    }

    // Rollback: after a failure, nothing has changed.

    function test_takenLabelLeavesSealFree() public {
        events.registerImage(
            address(eventRegistry),
            "image1",
            alice,
            SEAL,
            _proof(alice, SEAL, address(eventRegistry), "image1")
        );
        bytes memory proof = _proof(alice, SEAL_TWO, address(eventRegistry), "image1");
        vm.expectRevert(
            abi.encodeWithSelector(MockRegistry.LabelAlreadyRegistered.selector, "image1")
        );
        events.registerImage(address(eventRegistry), "image1", alice, SEAL_TWO, proof);
        assertFalse(events.usedSeal(SEAL_TWO));
        assertEq(events.sealOf(address(eventRegistry), "image1"), SEAL);
    }

    // Call backs.

    function test_eventRegistryCannotCallBack() public {
        CallbackRegistry hostile = new CallbackRegistry();
        bytes memory inner = _proof(alice, SEAL_TWO, address(eventRegistry), "image2");
        hostile.aim(
            address(events),
            abi.encodeCall(
                events.registerImage, (address(eventRegistry), "image2", alice, SEAL_TWO, inner)
            )
        );
        events.registerImage(
            address(hostile), "image1", alice, SEAL, _proof(alice, SEAL, address(hostile), "image1")
        );
        assertTrue(hostile.called());
        assertFalse(hostile.succeeded());
        assertEq(
            bytes4(hostile.answer()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertFalse(events.usedSeal(SEAL_TWO));
    }

    function test_ownerCannotCallBackForASecondImage() public {
        CallbackOwner hostile = new CallbackOwner();
        _join(address(hostile), "hostile", 333);
        bytes memory inner = _proof(address(hostile), SEAL_TWO, address(eventRegistry), "image2");
        hostile.aim(
            address(events),
            abi.encodeCall(
                events.registerImage,
                (address(eventRegistry), "image2", address(hostile), SEAL_TWO, inner)
            )
        );
        events.registerImage(
            address(eventRegistry),
            "image1",
            address(hostile),
            SEAL,
            _proof(address(hostile), SEAL, address(eventRegistry), "image1")
        );
        assertFalse(hostile.succeeded());
        assertEq(
            bytes4(hostile.answer()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertFalse(events.usedSeal(SEAL_TWO));
    }

    // Admin.

    function test_strangerCannotSwapCheck() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, bob));
        events.setSealCheck(sealCheck);
    }

    function test_setCheckRefusesNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(EventsRegistrar.NotAContract.selector, bob));
        events.setSealCheck(ISealCheck(bob));
    }

    function test_constructorRefusesZeros() public {
        vm.expectRevert(Admin.ZeroAddress.selector);
        new EventsRegistrar(address(0), users, resolver, sealCheck);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new EventsRegistrar(ownerWallet, UsersRegistrar(address(0)), resolver, sealCheck);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new EventsRegistrar(ownerWallet, users, address(0), sealCheck);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new EventsRegistrar(ownerWallet, users, resolver, ISealCheck(address(0)));
    }
}

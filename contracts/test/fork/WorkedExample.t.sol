// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {AttestedPersonCheck} from "../../src/AttestedPersonCheck.sol";
import {AttestedSealCheck} from "../../src/AttestedSealCheck.sol";
import {EventsRegistrar} from "../../src/EventsRegistrar.sol";
import {UsersRegistrar} from "../../src/UsersRegistrar.sol";

import {TreeForkBase} from "./TreeFork.sol";

/// @notice The worked example in the wiring notes, byte for byte. Its signatures were made outside
///         Solidity, with viem and with cast, using the test key 1. They are literals here, so a
///         change in the signed data makes this test fail.
contract ForkWorkedExample is TreeForkBase {
    address internal constant EXAMPLE_USERS = 0x1000000000000000000000000000000000000001;
    address internal constant EXAMPLE_EVENTS = 0x1000000000000000000000000000000000000002;
    address internal constant EXAMPLE_ATTESTER = 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf;
    address internal constant EXAMPLE_OWNER = 0x2000000000000000000000000000000000000002;
    address internal constant EXAMPLE_EVENT_REGISTRY = 0x5d915145E9d5BfdF7551815b5627220fd7c114fF;
    uint256 internal constant EXAMPLE_PASS =
        0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef;
    bytes32 internal constant EXAMPLE_SEAL =
        0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;

    bytes internal constant USER_ENCODED =
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"0000000000000000000000001000000000000000000000000000000000000001"
        hex"0000000000000000000000002000000000000000000000000000000000000002"
        hex"00000000000000000000000000000000000000000000000000000000000000a0"
        hex"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        hex"0000000000000000000000000000000000000000000000000000000000000005"
        hex"616c696365000000000000000000000000000000000000000000000000000000";
    bytes32 internal constant USER_HASH =
        0xed175e5338e51a74994e44f9e3609d865cb3fd2877becc30c30bb6060570a75d;
    bytes32 internal constant USER_DIGEST =
        0x73a2bd731e06a9059a1c92a42c8340bf7bdc509c3be9e778509b1710deaed8f4;
    bytes internal constant USER_PROOF =
        hex"b33bf8d5a138569b8c084d3214a711e81e11c4102c4003c3efa8f712d4b9a8bf"
        hex"220905ab7102ed31936d84e382fa4657da64cef2d25ab61a34be873fe41823ba"
        hex"1c";

    bytes internal constant IMAGE_ENCODED =
        hex"0000000000000000000000000000000000000000000000000000000000000001"
        hex"0000000000000000000000001000000000000000000000000000000000000002"
        hex"0000000000000000000000002000000000000000000000000000000000000002"
        hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        hex"0000000000000000000000005d915145e9d5bfdf7551815b5627220fd7c114ff"
        hex"00000000000000000000000000000000000000000000000000000000000000c0"
        hex"0000000000000000000000000000000000000000000000000000000000000006"
        hex"696d616765310000000000000000000000000000000000000000000000000000";
    bytes32 internal constant IMAGE_HASH =
        0x686500ba6bcd698e8bee201837dd00a56805a05680e49d365f51709148a98a92;
    bytes32 internal constant IMAGE_DIGEST =
        0x7500bde93597e0b7d5a20a67d49e38082e519edc4e40e647764b9280b5e19c5b;
    bytes internal constant IMAGE_PROOF =
        hex"f9a6028778233b434417f095186718a2e4bc106bb4b6801077c882852bc2ed70"
        hex"42480a10de95e14c4a8b4e8c74ed9ea541c2a1017c2e3ab86952d3aad4b0be9e"
        hex"1c";

    function _registryImpl() internal pure override returns (address) {
        return REGISTRY_IMPL;
    }

    function _narrow() internal pure override returns (bool) {
        return true;
    }

    /// @dev The registrars sit at the example's fixed addresses, because their addresses are signed.
    function _deployRegistrars() internal override {
        personCheck = new AttestedPersonCheck(OWNER_WALLET, EXAMPLE_ATTESTER);
        sealCheck = new AttestedSealCheck(OWNER_WALLET, EXAMPLE_ATTESTER);
        deployCodeTo(
            "UsersRegistrar.sol:UsersRegistrar",
            abi.encode(OWNER_WALLET, usersRegistry, resolver, personCheck),
            EXAMPLE_USERS
        );
        deployCodeTo(
            "EventsRegistrar.sol:EventsRegistrar",
            abi.encode(OWNER_WALLET, EXAMPLE_USERS, resolver, sealCheck),
            EXAMPLE_EVENTS
        );
        users = UsersRegistrar(EXAMPLE_USERS);
        events = EventsRegistrar(EXAMPLE_EVENTS);
    }

    function test_treeAddressesMatchTheExample() public view {
        assertEq(address(eventRegistry), EXAMPLE_EVENT_REGISTRY);
        assertEq(address(usersRegistry), 0x0E11AbCB4ee7E456f781C08a7686D131B1413EBD);
        assertEq(address(eventsRegistry), 0x84A8b3fA3Fe889a7A84b57449222Cbe88eeee872);
        assertEq(resolver, 0xd9A92d2E559FEC9878454525bD98E3eb37CcD010);
        assertEq(vm.addr(1), EXAMPLE_ATTESTER);
    }

    function test_userBytesAreTheNotesBytes() public view {
        assertEq(
            abi.encode(uint256(1), EXAMPLE_USERS, EXAMPLE_OWNER, "alice", EXAMPLE_PASS),
            USER_ENCODED
        );
        assertEq(keccak256(USER_ENCODED), USER_HASH);
        assertEq(personCheck.messageHash(EXAMPLE_USERS, EXAMPLE_OWNER, "alice", EXAMPLE_PASS), USER_HASH);
        assertEq(
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", USER_HASH)), USER_DIGEST
        );
        assertEq(_signed(1, USER_HASH), USER_PROOF);
    }

    function test_imageBytesAreTheNotesBytes() public view {
        assertEq(
            abi.encode(
                uint256(1),
                EXAMPLE_EVENTS,
                EXAMPLE_OWNER,
                EXAMPLE_SEAL,
                EXAMPLE_EVENT_REGISTRY,
                "image1"
            ),
            IMAGE_ENCODED
        );
        assertEq(keccak256(IMAGE_ENCODED), IMAGE_HASH);
        assertEq(
            sealCheck.messageHash(
                EXAMPLE_EVENTS, EXAMPLE_OWNER, EXAMPLE_SEAL, EXAMPLE_EVENT_REGISTRY, "image1"
            ),
            IMAGE_HASH
        );
        assertEq(
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", IMAGE_HASH)), IMAGE_DIGEST
        );
        assertEq(_signed(1, IMAGE_HASH), IMAGE_PROOF);
    }

    /// @dev The example's two calls, with the example's literal signatures, on the real code.
    function test_theExampleMintsBothNames() public {
        assertEq(EXAMPLE_OWNER.code.length, 0);

        vm.prank(BOT);
        users.register("alice", EXAMPLE_OWNER, EXAMPLE_PASS, USER_PROOF);
        assertEq(usersRegistry.findOwner("alice"), EXAMPLE_OWNER);
        assertTrue(users.isUser(EXAMPLE_OWNER));

        vm.prank(BOT);
        events.registerImage(
            EXAMPLE_EVENT_REGISTRY, "image1", EXAMPLE_OWNER, EXAMPLE_SEAL, IMAGE_PROOF
        );
        assertEq(eventRegistry.findOwner("image1"), EXAMPLE_OWNER);
        assertEq(events.sealOf(EXAMPLE_EVENT_REGISTRY, "image1"), EXAMPLE_SEAL);
    }
}

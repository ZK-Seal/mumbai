// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Admin} from "../src/Admin.sol";
import {AttestedPersonCheck} from "../src/AttestedPersonCheck.sol";
import {AttestedSealCheck} from "../src/AttestedSealCheck.sol";
import {IWorldRouter, WorldPersonCheck} from "../src/WorldPersonCheck.sol";

import {MockRouter, SignHelp} from "./Helpers.sol";

contract AttestedChecksTest is SignHelp {
    AttestedPersonCheck internal person;
    AttestedSealCheck internal seal;

    address internal ownerWallet = makeAddr("owner wallet");
    address internal registrar = makeAddr("registrar");
    address internal alice = makeAddr("unit test person one");

    function setUp() public {
        _makeKeys();
        person = new AttestedPersonCheck(ownerWallet, attester);
        seal = new AttestedSealCheck(ownerWallet, attester);
    }

    function test_personCheckTrueOnlyForTheSignedRegistrar() public {
        bytes memory proof = _personProof(attesterKey, registrar, alice, "alice", 1);
        vm.prank(registrar);
        assertTrue(person.check(alice, "alice", 1, proof));
        assertFalse(person.check(alice, "alice", 1, proof));
    }

    function test_sealCheckTrueOnlyForTheSignedRegistrar() public {
        bytes memory proof = _sealProof(attesterKey, registrar, alice, "s", address(1), "image1");
        vm.prank(registrar);
        assertTrue(seal.check(alice, "s", address(1), "image1", proof));
        assertFalse(seal.check(alice, "s", address(1), "image1", proof));
    }

    function test_messageHashMatchesWhatTheServerBuilds() public view {
        assertEq(
            person.messageHash(registrar, alice, "alice", 1),
            keccak256(abi.encode(block.chainid, registrar, alice, "alice", uint256(1)))
        );
        assertEq(
            seal.messageHash(registrar, alice, "s", address(1), "image1"),
            keccak256(abi.encode(block.chainid, registrar, alice, bytes32("s"), address(1), "image1"))
        );
    }

    function test_otherFormOfSignatureFalse() public {
        bytes memory proof = _personProof(attesterKey, registrar, alice, "alice", 1);
        (bytes32 r, bytes32 s, uint8 v) = _parts(proof);
        // Plain ecrecover takes the other form. This is what the check must refuse.
        bytes memory other = _otherForm(proof);
        (bytes32 r2, bytes32 s2, uint8 v2) = _parts(other);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                person.messageHash(registrar, alice, "alice", 1)
            )
        );
        assertEq(ecrecover(digest, v, r, s), attester);
        assertEq(ecrecover(digest, v2, r2, s2), attester);

        vm.prank(registrar);
        assertFalse(person.check(alice, "alice", 1, other));
    }

    function test_garbageSignaturesFalse() public {
        vm.startPrank(registrar);
        assertFalse(person.check(alice, "alice", 1, ""));
        assertFalse(person.check(alice, "alice", 1, new bytes(65)));
        assertFalse(person.check(alice, "alice", 1, new bytes(64)));
        assertFalse(person.check(alice, "alice", 1, new bytes(66)));
        assertFalse(seal.check(alice, "s", address(1), "image1", new bytes(65)));
        vm.stopPrank();
    }

    function test_newAttesterRulesAtOnce() public {
        bytes memory oldProof = _personProof(attesterKey, registrar, alice, "alice", 1);
        (address next, uint256 nextKey) = makeAddrAndKey("next attester");
        vm.prank(ownerWallet);
        person.setAttester(next);

        vm.startPrank(registrar);
        assertFalse(person.check(alice, "alice", 1, oldProof));
        assertTrue(
            person.check(
                alice, "alice", 1, _personProof(nextKey, registrar, alice, "alice", 1)
            )
        );
        vm.stopPrank();
    }

    function test_attesterAdmin() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, alice));
        person.setAttester(alice);

        vm.expectRevert(Admin.ZeroAddress.selector);
        person.setAttester(address(0));

        person.dropDeployer();
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, address(this)));
        person.setAttester(alice);
    }

    function test_constructorRefusesZeros() public {
        vm.expectRevert(Admin.ZeroAddress.selector);
        new AttestedPersonCheck(ownerWallet, address(0));
        vm.expectRevert(Admin.ZeroAddress.selector);
        new AttestedSealCheck(address(0), attester);
    }
}

contract WorldPersonCheckTest is SignHelp {
    MockRouter internal router;
    WorldPersonCheck internal world;

    address internal alice = makeAddr("unit test person one");
    uint256[8] internal zk = [uint256(1), 2, 3, 4, 5, 6, 7, 8];

    uint256 internal constant ROOT = 77;
    uint256 internal constant PASS = 88;

    function setUp() public {
        router = new MockRouter();
        world = new WorldPersonCheck(IWorldRouter(address(router)), "app_test", "join");
    }

    function _accept() internal {
        router.accept(
            ROOT,
            world.ORB_GROUP(),
            world.signalHash(alice, "alice"),
            PASS,
            world.externalNullifierHash(),
            zk
        );
    }

    function test_hashesFollowWorldsFormula() public view {
        uint256 appHash = uint256(keccak256(abi.encodePacked("app_test"))) >> 8;
        assertEq(
            world.externalNullifierHash(),
            uint256(keccak256(abi.encodePacked(appHash, "join"))) >> 8
        );
        assertEq(
            world.signalHash(alice, "alice"),
            uint256(keccak256(abi.encodePacked(alice, "alice"))) >> 8
        );
    }

    function test_trueWhenTheRouterAccepts() public {
        _accept();
        assertTrue(world.check(alice, "alice", PASS, abi.encode(ROOT, zk)));
    }

    function test_falseWhenTheRouterReverts() public view {
        assertFalse(world.check(alice, "alice", PASS, abi.encode(ROOT, zk)));
    }

    function test_proofIsBoundToOwnerLabelAndPass() public {
        _accept();
        bytes memory proof = abi.encode(ROOT, zk);
        assertFalse(world.check(makeAddr("unit test person two"), "alice", PASS, proof));
        assertFalse(world.check(alice, "other", PASS, proof));
        assertFalse(world.check(alice, "alice", PASS + 1, proof));
    }

    function test_wrongLengthProofFalse() public {
        _accept();
        assertFalse(world.check(alice, "alice", PASS, ""));
        assertFalse(world.check(alice, "alice", PASS, new bytes(9 * 32 - 1)));
        assertFalse(world.check(alice, "alice", PASS, new bytes(9 * 32 + 1)));
    }
}

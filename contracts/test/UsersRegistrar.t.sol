// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {Admin} from "../src/Admin.sol";
import {AttestedPersonCheck} from "../src/AttestedPersonCheck.sol";
import {IEnsRegistry} from "../src/IEnsRegistry.sol";
import {IPersonCheck} from "../src/IPersonCheck.sol";
import {LabelRules} from "../src/LabelRules.sol";
import {UsersRegistrar} from "../src/UsersRegistrar.sol";

import {CallbackOwner, MockRegistry, SignHelp, WritingCheck} from "./Helpers.sol";

contract UsersRegistrarTest is SignHelp {
    event UserRegistered(string label, address indexed owner, uint256 indexed pass);

    MockRegistry internal registry;
    AttestedPersonCheck internal check;
    UsersRegistrar internal users;

    address internal ownerWallet = makeAddr("owner wallet");
    address internal resolver = makeAddr("resolver");
    address internal alice = makeAddr("unit test person one");
    address internal bob = makeAddr("unit test person two");
    address internal relayer = makeAddr("relayer");

    uint256 internal constant PASS = 111;

    function setUp() public {
        _makeKeys();
        registry = new MockRegistry();
        check = new AttestedPersonCheck(ownerWallet, attester);
        users = new UsersRegistrar(ownerWallet, registry, resolver, check);
    }

    function _proof(address owner, string memory label, uint256 pass)
        internal
        view
        returns (bytes memory)
    {
        return _personProof(attesterKey, address(users), owner, label, pass);
    }

    // The cases asked for.

    function test_goodAttestationMintsToOwner() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.expectEmit(address(users));
        emit UserRegistered("alice", alice, PASS);
        vm.prank(relayer);
        uint256 tokenId = users.register("alice", alice, PASS, proof);

        assertEq(tokenId, uint256(keccak256("alice")));
        assertEq(registry.findOwner("alice"), alice);
        assertEq(users.labelOf(alice), "alice");
        assertEq(users.passOf("alice"), PASS);
        assertEq(users.ownerOfPass(PASS), alice);
        assertTrue(users.isUser(alice));
    }

    function test_registryGetsTheAgreedArguments() public {
        users.register("alice", alice, PASS, _proof(alice, "alice", PASS));
        assertEq(registry.lastSender(), address(users));
        assertEq(registry.lastSubregistry(), address(0));
        assertEq(registry.lastResolver(), resolver);
        assertEq(registry.lastRoles(), 0);
        assertEq(registry.lastExpiry(), type(uint64).max);
    }

    function test_wrongSigner() public {
        bytes memory proof = _personProof(strangerKey, address(users), alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, proof);
        assertFalse(users.isUser(alice));
    }

    function test_reusedPass() public {
        users.register("alice", alice, PASS, _proof(alice, "alice", PASS));
        bytes memory proof = _proof(bob, "bob-name", PASS);
        vm.expectRevert(abi.encodeWithSelector(UsersRegistrar.PassAlreadyUsed.selector, PASS));
        users.register("bob-name", bob, PASS, proof);
    }

    function test_replayedSignature() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        users.register("alice", alice, PASS, proof);
        vm.expectRevert(abi.encodeWithSelector(UsersRegistrar.PassAlreadyUsed.selector, PASS));
        users.register("alice", alice, PASS, proof);
    }

    function test_secondNameForOneAddress() public {
        users.register("alice", alice, PASS, _proof(alice, "alice", PASS));
        bytes memory proof = _proof(alice, "second", PASS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(UsersRegistrar.OwnerAlreadyHasName.selector, alice, "alice")
        );
        users.register("second", alice, PASS + 1, proof);
    }

    // Signed data: every field counts.

    function test_signatureBoundToOwner() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", bob, PASS, proof);
    }

    function test_signatureBoundToLabel() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("another", alice, PASS, proof);
    }

    function test_signatureBoundToPass() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS + 1, proof);
    }

    function test_signatureBoundToRegistrar() public {
        UsersRegistrar other = new UsersRegistrar(ownerWallet, new MockRegistry(), resolver, check);
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        other.register("alice", alice, PASS, proof);
    }

    function test_signatureBoundToChain() public {
        bytes memory proof = _proof(alice, "alice", PASS);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, proof);
    }

    // Signature forms.

    function test_otherFormOfSignatureRefused() public {
        bytes memory proof = _otherForm(_proof(alice, "alice", PASS));
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, proof);
    }

    function test_vZeroOrOneRefused() public {
        (bytes32 r, bytes32 s, uint8 v) = _parts(_proof(alice, "alice", PASS));
        bytes memory proof = abi.encodePacked(r, s, v - 27);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, proof);
    }

    function test_shortSignatureRefused() public {
        (bytes32 r, bytes32 s,) = _parts(_proof(alice, "alice", PASS));
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, abi.encodePacked(r, s));
    }

    function test_emptySignatureRefused() public {
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, "");
    }

    // Labels.

    function test_badLabelsRefused() public {
        string[8] memory bad = [
            "",
            "ab",
            "-abc",
            "ab--cd",
            "Abc",
            "a.bc",
            "abc def",
            "abcdefghijklmnopqrstu"
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(LabelRules.InvalidLabel.selector, bad[i]));
            users.register(bad[i], alice, PASS, "");
        }
    }

    function test_goodLabelsPass() public {
        string[5] memory good = ["abc", "a-b", "abc-", "0ab", "abcdefghijklmnopqrst"];
        for (uint256 i; i < good.length; ++i) {
            address owner = address(uint160(0x1000 + i));
            users.register(good[i], owner, i, _proof(owner, good[i], i));
            assertTrue(users.isUser(owner));
        }
    }

    function test_zeroOwnerRefused() public {
        vm.expectRevert(Admin.ZeroAddress.selector);
        users.register("alice", address(0), PASS, "");
    }

    // Rollback: after a failure, nothing has changed.

    function test_takenLabelLeavesPassFree() public {
        users.register("alice", alice, PASS, _proof(alice, "alice", PASS));
        bytes memory proof = _proof(bob, "alice", PASS + 1);
        vm.expectRevert(
            abi.encodeWithSelector(MockRegistry.LabelAlreadyRegistered.selector, "alice")
        );
        users.register("alice", bob, PASS + 1, proof);
        assertEq(users.ownerOfPass(PASS + 1), address(0));
        assertEq(users.labelOf(bob), "");
    }

    // Call backs.

    function test_ownerCannotCallBackForASecondName() public {
        CallbackOwner hostile = new CallbackOwner();
        bytes memory inner = _proof(bob, "bob-name", PASS + 1);
        hostile.aim(
            address(users), abi.encodeCall(users.register, ("bob-name", bob, PASS + 1, inner))
        );
        users.register("hostile", address(hostile), PASS, _proof(address(hostile), "hostile", PASS));

        assertTrue(hostile.called());
        assertFalse(hostile.succeeded());
        assertEq(
            bytes4(hostile.answer()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertEq(registry.findOwner("bob-name"), address(0));
        assertTrue(users.isUser(address(hostile)));
    }

    function test_ownerSeesOurRecordsDuringCallBack() public {
        CallbackOwner hostile = new CallbackOwner();
        hostile.aim(address(users), abi.encodeCall(users.labelOf, (address(hostile))));
        users.register("hostile", address(hostile), PASS, _proof(address(hostile), "hostile", PASS));
        assertTrue(hostile.succeeded());
        assertEq(abi.decode(hostile.answer(), (string)), "hostile");
    }

    function test_checkCannotWrite() public {
        WritingCheck writing = new WritingCheck();
        vm.prank(ownerWallet);
        users.setPersonCheck(IPersonCheck(address(writing)));
        vm.expectRevert();
        users.register("alice", alice, PASS, "");
        assertEq(writing.calls(), 0);
    }

    // isUser.

    function test_isUserFalseForStranger() public view {
        assertFalse(users.isUser(alice));
    }

    function test_isUserFollowsTheRegistry() public {
        users.register("alice", alice, PASS, _proof(alice, "alice", PASS));
        registry.remove("alice");
        assertFalse(users.isUser(alice));
        assertEq(users.ownerOfPass(PASS), alice);
    }

    // Admin.

    function test_strangerCannotSwapCheck() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, bob));
        users.setPersonCheck(check);
    }

    function test_bothAdminsCanSwapCheck() public {
        AttestedPersonCheck next = new AttestedPersonCheck(ownerWallet, attester);
        vm.prank(ownerWallet);
        users.setPersonCheck(next);
        assertEq(address(users.personCheck()), address(next));
        users.setPersonCheck(check);
        assertEq(address(users.personCheck()), address(check));
    }

    function test_swappedCheckRulesAtOnce() public {
        (, uint256 newKey) = makeAddrAndKey("new attester");
        AttestedPersonCheck next = new AttestedPersonCheck(ownerWallet, vm.addr(newKey));
        users.setPersonCheck(next);
        bytes memory oldProof = _proof(alice, "alice", PASS);
        vm.expectRevert(UsersRegistrar.PersonCheckFailed.selector);
        users.register("alice", alice, PASS, oldProof);
        users.register(
            "alice", alice, PASS, _personProof(newKey, address(users), alice, "alice", PASS)
        );
        assertTrue(users.isUser(alice));
    }

    function test_setCheckRefusesNoCode() public {
        vm.expectRevert(abi.encodeWithSelector(UsersRegistrar.NotAContract.selector, bob));
        users.setPersonCheck(IPersonCheck(bob));
    }

    function test_droppedDeployerIsNoAdmin() public {
        users.dropDeployer();
        assertFalse(users.isAdmin(address(this)));
        assertTrue(users.isAdmin(ownerWallet));
        vm.expectRevert(abi.encodeWithSelector(Admin.NotAdmin.selector, address(this)));
        users.setPersonCheck(check);
        vm.prank(ownerWallet);
        users.setPersonCheck(check);
    }

    function test_zeroAddressIsNeverAdmin() public {
        users.dropDeployer();
        assertFalse(users.isAdmin(address(0)));
    }

    function test_constructorRefusesZeros() public {
        vm.expectRevert(Admin.ZeroAddress.selector);
        new UsersRegistrar(address(0), registry, resolver, check);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new UsersRegistrar(ownerWallet, IEnsRegistry(address(0)), resolver, check);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new UsersRegistrar(ownerWallet, registry, address(0), check);
        vm.expectRevert(Admin.ZeroAddress.selector);
        new UsersRegistrar(ownerWallet, registry, resolver, IPersonCheck(address(0)));
    }

    function test_deployBeforeTheCheckExistsFailsClosed() public {
        address later = makeAddr("check not deployed yet");
        UsersRegistrar early = new UsersRegistrar(ownerWallet, registry, resolver, IPersonCheck(later));
        vm.expectRevert();
        early.register("alice", alice, PASS, "");
        assertEq(early.ownerOfPass(PASS), address(0));
    }
}

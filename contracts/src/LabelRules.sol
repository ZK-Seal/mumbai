// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @notice The labels a registrar accepts: 3 to 20 characters of a-z, 0-9 and hyphen, not starting
///         with a hyphen. ENS name normalization also refuses a hyphen in both the third and the
///         fourth place, so those are refused here too.
/// @dev An empty label would look like "no name" in the registrar's own records, and a dot would
///      make a name that does not sit under the parent. Reserved words stay a server rule.
library LabelRules {
    error InvalidLabel(string label);

    function requireValid(string memory label) internal pure {
        bytes memory b = bytes(label);
        bool ok = b.length >= 3 && b.length <= 20 && b[0] != "-";
        if (ok && b.length >= 4) ok = b[2] != "-" || b[3] != "-";
        for (uint256 i; ok && i < b.length; ++i) {
            bytes1 c = b[i];
            ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
        }
        if (!ok) revert InvalidLabel(label);
    }
}

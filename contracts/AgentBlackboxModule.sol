// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @title Agent Blackbox evaluator for a Claus signal feed (claus-signal-v1)
/// @notice Read-only module that checks one checkpoint of an AI agent's action
/// log before the Claus Signal Store accepts it. A checkpoint pins a range of
/// log entries by Merkle root and head hash; see agent-blackbox/src/checkpoint.mjs.
/// @dev Same interface as Claus readonly modules: evaluate(configuration, input).
/// `input` is the ABI-encoded store context below (identical layout to Claus's
/// ClausSignalTypes.Input). A record proves what the store accepted and when,
/// not that the agent behaved well or that the log is complete.
contract AgentBlackboxModule {
    error InvalidConfiguration();
    error InvalidCheckpoint();

    /// Mirrors ClausSignalTypes.Input; the store prepends this context itself.
    struct Input {
        uint256 chainId;
        address store;
        bytes32 projectId;
        bytes32 feedId;
        bytes32 schemaHash;
        address publisher;
        uint64 sequence;
        uint64 observedAt;
        uint64 validUntil;
        bytes32 sourceHash;
        bytes data;
    }

    bytes32 public constant SCHEMA = keccak256(
        "AgentBlackboxCheckpoint(bytes32 agentKey,uint64 fromSeq,uint64 toSeq,bytes32 root,bytes32 head,uint64 endedAt)"
    );

    /// @param configuration abi.encode(uint256 maximumAgeSeconds), 1 second to 1 day
    /// @return abi.encode(agentKey, fromSeq, toSeq, root, head)
    function evaluate(bytes calldata configuration, bytes calldata input) external view returns (bytes memory) {
        if (configuration.length != 32) revert InvalidConfiguration();
        uint256 maximumAge = abi.decode(configuration, (uint256));
        if (maximumAge == 0 || maximumAge > 1 days) revert InvalidConfiguration();

        Input memory context = abi.decode(input, (Input));
        if (context.data.length != 192) revert InvalidCheckpoint();
        (bytes32 agentKey, uint64 fromSeq, uint64 toSeq, bytes32 root, bytes32 head, uint64 endedAt) =
            abi.decode(context.data, (bytes32, uint64, uint64, bytes32, bytes32, uint64));

        if (agentKey == bytes32(0) || root == bytes32(0) || head == bytes32(0) || toSeq < fromSeq ||
            endedAt != context.observedAt || endedAt > block.timestamp || block.timestamp - endedAt > maximumAge ||
            context.validUntil > uint256(endedAt) + maximumAge) revert InvalidCheckpoint();
        // A one-entry range must have root == head (the tree of one leaf is the leaf).
        if (toSeq == fromSeq && root != head) revert InvalidCheckpoint();

        return abi.encode(agentKey, fromSeq, toSeq, root, head);
    }
}

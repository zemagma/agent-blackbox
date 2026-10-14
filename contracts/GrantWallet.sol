// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

/// @title GrantWallet
/// @notice A wallet for an AI agent, following the Claus signal-grant pattern:
/// the owner signs a finite, expiring spending grant (EIP-712) for one agent key,
/// every payment is checked against that grant here, on-chain, and the owner can
/// revoke the grant on-chain at any time (even before it is first used). After
/// that no call can spend under it, whoever makes it and whatever software it uses.
///
/// The funds live in this contract, not in the agent's key. The agent key only
/// needs gas. The owner can always withdraw.
contract GrantWallet {
    struct SpendGrant {
        address agent;          // the only key that may spend under this grant
        address recipient;      // the only address it may pay
        uint256 maxPerPayment;  // wei
        uint256 maxPerDay;      // wei per UTC day
        uint64 expiresAt;       // unix seconds
        uint256 nonce;          // lets the owner sign several grants
    }

    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "SpendGrant(address agent,address recipient,uint256 maxPerPayment,uint256 maxPerDay,uint64 expiresAt,uint256 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Agent Blackbox GrantWallet");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable owner;
    mapping(bytes32 => bool) public revoked;
    mapping(bytes32 => mapping(uint256 => uint256)) public spentOnDay; // grantId => UTC day => wei

    event Funded(address indexed from, uint256 amount);
    event Paid(bytes32 indexed grantId, address indexed agent, address indexed to, uint256 amount, bytes32 memo);
    event GrantRevoked(bytes32 indexed grantId);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error NotAgent();
    error GrantIsRevoked();
    error GrantExpired();
    error BadSignature();
    error RecipientNotAllowed();
    error OverPaymentLimit();
    error OverDailyLimit();
    error TransferFailed();

    constructor(address owner_) payable {
        if (owner_ == address(0)) revert NotOwner();
        owner = owner_;
        if (msg.value > 0) emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    /// @notice The EIP-712 digest the owner signs; it doubles as the grant's id.
    function grantId(SpendGrant calldata g) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        bytes32 structHash = keccak256(abi.encode(
            GRANT_TYPEHASH, g.agent, g.recipient, g.maxPerPayment, g.maxPerDay, g.expiresAt, g.nonce
        ));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @notice Pays `amount` wei to `to` under an owner-signed grant. Only the grant's agent may call it.
    function pay(SpendGrant calldata g, bytes calldata signature, address to, uint256 amount, bytes32 memo) external {
        bytes32 id = grantId(g);
        if (msg.sender != g.agent) revert NotAgent();
        if (revoked[id]) revert GrantIsRevoked();
        if (block.timestamp >= g.expiresAt) revert GrantExpired();
        if (_recover(id, signature) != owner) revert BadSignature();
        if (to != g.recipient) revert RecipientNotAllowed();
        if (amount == 0 || amount > g.maxPerPayment) revert OverPaymentLimit();
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[id][day] + amount;
        if (spent > g.maxPerDay) revert OverDailyLimit();
        spentOnDay[id][day] = spent;                       // effects before the transfer
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Paid(id, msg.sender, to, amount, memo);
    }

    /// @notice Revokes a grant for good. Works before first use too; it cannot be undone.
    function revoke(bytes32 id) external {
        if (msg.sender != owner) revert NotOwner();
        revoked[id] = true;
        emit GrantRevoked(id);
    }

    /// @notice The owner can always take the funds back.
    function withdraw(address payable to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(to, amount);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return address(0);
        signer = ecrecover(digest, v, r, s);
    }
}

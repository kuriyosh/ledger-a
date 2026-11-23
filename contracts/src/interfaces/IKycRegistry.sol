// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

enum AccountStatus {
    NONE,
    ACTIVE,
    SUSPENDED,
    BLOCKED,
    REVOKED
}

enum AccountKind {
    NONE,
    CUSTOMER,
    VASP_TREASURY,
    RELAYER,
    OPERATOR
}

enum VaspStatus {
    NONE,
    ACTIVE,
    SUSPENDED
}

struct AccountView {
    uint32 vaspId;
    AccountKind kind;
    AccountStatus status;
    uint64 validUntil;
    uint64 updatedAt;
}

struct VaspView {
    VaspStatus status;
    address admin;
    address travelRuleSigner;
    string name;
    string endpoint;
    uint64 updatedAt;
}

interface IKycRegistry {
    event VaspRegistered(
        uint32 indexed vaspId, address admin, address travelRuleSigner, string name, string endpoint, uint64 version
    );
    event VaspStatusChanged(uint32 indexed vaspId, VaspStatus status, uint64 version, address indexed actor);
    event VaspKeysChanged(uint32 indexed vaspId, address admin, address travelRuleSigner, uint64 version);
    event VaspEndpointChanged(uint32 indexed vaspId, string endpoint);
    event AccountUpdated(
        address indexed account,
        uint32 indexed vaspId,
        AccountKind kind,
        AccountStatus status,
        uint64 validUntil,
        uint64 version,
        address indexed actor,
        bytes32 reason
    );
    event EnforcementEnabled(uint64 version, address indexed actor);
    event ConsortiumTransferred(address indexed previous, address indexed current);

    error AlreadyInitialized();
    error EnforcementAlreadyEnabled();
    error NotConsortium(address caller);
    error NotVaspAdmin(address caller);
    error VaspAlreadyRegistered(uint32 vaspId);
    error VaspNotFound(uint32 vaspId);
    error VaspNotActive(uint32 vaspId);
    error SystemVaspCannotBeSuspended();
    error InvalidVaspStatus(VaspStatus status);
    error InvalidKind(AccountKind kind);
    error InvalidTransition(address account, AccountStatus from, AccountStatus to);
    error AccountOfOtherVasp(address account, uint32 vaspId);
    error ZeroAddress();

    function initialize(address consortium) external;
    function registerVasp(
        uint32 vaspId,
        address admin,
        address travelRuleSigner,
        string calldata name,
        string calldata endpoint
    ) external;
    function setVaspStatus(uint32 vaspId, VaspStatus status) external;
    function setVaspKeys(uint32 vaspId, address admin, address travelRuleSigner) external;
    function registerOperatorAccount(address account, uint32 vaspId, AccountKind kind) external;
    function blockAccount(address account, bytes32 reason) external;
    function unblockAccount(address account) external;
    function enableEnforcement() external;
    function transferConsortium(address newConsortium) external;

    function registerAccount(address account, AccountKind kind, uint64 validUntil) external;
    function suspendAccount(address account, bytes32 reason) external;
    function reinstateAccount(address account) external;
    function revokeAccount(address account) external;
    function renewAccount(address account, uint64 validUntil) external;
    function setVaspEndpoint(string calldata endpoint) external;

    function isActive(address account) external view returns (bool);
    function isHolder(address account) external view returns (bool);
    function isVerified(address account) external view returns (bool);
    function getAccount(address account) external view returns (AccountView memory);
    function vaspOf(address account) external view returns (uint32);
    function kindOf(address account) external view returns (AccountKind);
    function getVasp(uint32 vaspId) external view returns (VaspView memory);
    function travelRuleSignerOf(uint32 vaspId) external view returns (address);
    function vaspIdOfAdmin(address admin) external view returns (bool found, uint32 vaspId);
    function enforcementEnabled() external view returns (bool);
    function version() external view returns (uint64);
    function consortium() external view returns (address);
}

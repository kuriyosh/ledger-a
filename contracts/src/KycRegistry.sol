// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccountKind,
    AccountStatus,
    AccountView,
    IKycRegistry,
    VaspStatus,
    VaspView
} from "./interfaces/IKycRegistry.sol";
import {RegistryLayout} from "./libraries/RegistryLayout.sol";

contract KycRegistry is IKycRegistry {
    modifier onlyConsortium() {
        if (msg.sender != consortium()) revert NotConsortium(msg.sender);
        _;
    }

    constructor() {
        RegistryLayout.get().initialized = true;
    }

    function initialize(address initialConsortium) external {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        if (layout.initialized) revert AlreadyInitialized();
        if (initialConsortium == address(0)) revert ZeroAddress();
        layout.initialized = true;
        layout.version = 1;
        layout.consortium = initialConsortium;
        emit ConsortiumTransferred(address(0), initialConsortium);
    }

    function registerVasp(
        uint32 vaspId,
        address admin,
        address travelRuleSigner,
        string calldata name,
        string calldata endpoint
    ) external onlyConsortium {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        if (layout.vasps[vaspId] != 0) revert VaspAlreadyRegistered(vaspId);
        if (admin == address(0) || travelRuleSigner == address(0)) revert ZeroAddress();
        uint64 nextVersion = ++layout.version;
        layout.vasps[vaspId] = RegistryLayout.packVasp(VaspStatus.ACTIVE, admin, uint64(block.timestamp));
        layout.travelRuleSigner[vaspId] = travelRuleSigner;
        layout.vaspName[vaspId] = name;
        layout.vaspEndpoint[vaspId] = endpoint;
        emit VaspRegistered(vaspId, admin, travelRuleSigner, name, endpoint, nextVersion);
        _registerAdmin(layout, vaspId, admin, nextVersion);
    }

    function setVaspStatus(uint32 vaspId, VaspStatus status) external onlyConsortium {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        (VaspStatus current, address admin) = _registeredVasp(layout, vaspId);
        if (vaspId == 0) revert SystemVaspCannotBeSuspended();
        if (status == VaspStatus.NONE) revert InvalidVaspStatus(status);
        if (current == status) return;
        layout.vasps[vaspId] = RegistryLayout.packVasp(status, admin, uint64(block.timestamp));
        emit VaspStatusChanged(vaspId, status, ++layout.version, msg.sender);
    }

    function setVaspKeys(uint32 vaspId, address admin, address travelRuleSigner) external onlyConsortium {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        (VaspStatus status, address previousAdmin) = _registeredVasp(layout, vaspId);
        if (admin == address(0) || travelRuleSigner == address(0)) revert ZeroAddress();
        if (admin == previousAdmin && layout.travelRuleSigner[vaspId] == travelRuleSigner) return;

        uint64 nextVersion = ++layout.version;
        emit VaspKeysChanged(vaspId, admin, travelRuleSigner, nextVersion);
        if (admin != previousAdmin) {
            _registerAdmin(layout, vaspId, admin, nextVersion);
            delete layout.adminVaspIdPlus1[previousAdmin];

            AccountView memory previous = getAccount(previousAdmin);
            if (previous.status == AccountStatus.ACTIVE || previous.status == AccountStatus.SUSPENDED) {
                _writeAccount(
                    layout,
                    previousAdmin,
                    vaspId,
                    AccountKind.OPERATOR,
                    AccountStatus.REVOKED,
                    0,
                    nextVersion,
                    bytes32(0)
                );
            }
        }
        layout.vasps[vaspId] = RegistryLayout.packVasp(status, admin, uint64(block.timestamp));
        layout.travelRuleSigner[vaspId] = travelRuleSigner;
    }

    function registerOperatorAccount(address account, uint32 vaspId, AccountKind kind) external onlyConsortium {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        if (account == address(0)) revert ZeroAddress();
        if (kind != AccountKind.RELAYER && kind != AccountKind.OPERATOR) revert InvalidKind(kind);
        _registeredVasp(layout, vaspId);
        AccountView memory current = getAccount(account);
        if (current.status != AccountStatus.NONE) {
            revert InvalidTransition(account, current.status, AccountStatus.ACTIVE);
        }
        _writeAccount(layout, account, vaspId, kind, AccountStatus.ACTIVE, 0, ++layout.version, bytes32(0));
    }

    function blockAccount(address account, bytes32 reason) external onlyConsortium {
        AccountView memory current = getAccount(account);
        if (current.status != AccountStatus.ACTIVE && current.status != AccountStatus.SUSPENDED) {
            revert InvalidTransition(account, current.status, AccountStatus.BLOCKED);
        }
        _changeAccount(account, current, AccountStatus.BLOCKED, reason);
    }

    function unblockAccount(address account) external onlyConsortium {
        AccountView memory current = getAccount(account);
        if (current.status != AccountStatus.BLOCKED) {
            revert InvalidTransition(account, current.status, AccountStatus.ACTIVE);
        }
        _changeAccount(account, current, AccountStatus.ACTIVE, bytes32(0));
    }

    function enableEnforcement() external onlyConsortium {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        if (enforcementEnabled()) revert EnforcementAlreadyEnabled();
        layout.flags |= RegistryLayout.ENFORCEMENT_ENABLED;
        emit EnforcementEnabled(++layout.version, msg.sender);
    }

    function transferConsortium(address newConsortium) external onlyConsortium {
        if (newConsortium == address(0)) revert ZeroAddress();
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        address previous = layout.consortium;
        if (newConsortium == previous) return;
        layout.consortium = newConsortium;
        ++layout.version;
        emit ConsortiumTransferred(previous, newConsortium);
    }

    function registerAccount(address account, AccountKind kind, uint64 validUntil) external {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        uint32 vaspId = _adminVaspId();
        _requireVaspActive(layout, vaspId);
        if (account == address(0)) revert ZeroAddress();
        if (kind != AccountKind.CUSTOMER && kind != AccountKind.VASP_TREASURY) revert InvalidKind(kind);

        AccountView memory current = getAccount(account);
        if (current.status != AccountStatus.NONE && current.status != AccountStatus.REVOKED) {
            if (current.vaspId != vaspId) revert AccountOfOtherVasp(account, current.vaspId);
            revert InvalidTransition(account, current.status, AccountStatus.ACTIVE);
        }
        _writeAccount(layout, account, vaspId, kind, AccountStatus.ACTIVE, validUntil, ++layout.version, bytes32(0));
    }

    function suspendAccount(address account, bytes32 reason) external {
        AccountView memory current = _managedAccount(account);
        if (current.status != AccountStatus.ACTIVE) {
            revert InvalidTransition(account, current.status, AccountStatus.SUSPENDED);
        }
        _changeAccount(account, current, AccountStatus.SUSPENDED, reason);
    }

    function reinstateAccount(address account) external {
        AccountView memory current = _managedAccount(account);
        if (current.status != AccountStatus.SUSPENDED) {
            revert InvalidTransition(account, current.status, AccountStatus.ACTIVE);
        }
        _changeAccount(account, current, AccountStatus.ACTIVE, bytes32(0));
    }

    function revokeAccount(address account) external {
        AccountView memory current = _managedAccount(account);
        if (current.status != AccountStatus.ACTIVE && current.status != AccountStatus.SUSPENDED) {
            revert InvalidTransition(account, current.status, AccountStatus.REVOKED);
        }
        _changeAccount(account, current, AccountStatus.REVOKED, bytes32(0));
    }

    function renewAccount(address account, uint64 validUntil) external {
        AccountView memory current = _managedAccount(account);
        if (current.status != AccountStatus.ACTIVE) {
            revert InvalidTransition(account, current.status, AccountStatus.ACTIVE);
        }
        if (current.validUntil == validUntil) return;
        current.validUntil = validUntil;
        _changeAccount(account, current, AccountStatus.ACTIVE, bytes32(0));
    }

    function setVaspEndpoint(string calldata endpoint) external {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        uint32 vaspId = _adminVaspId();
        _requireVaspActive(layout, vaspId);
        (, address admin,) = RegistryLayout.unpackVasp(layout.vasps[vaspId]);
        if (keccak256(bytes(layout.vaspEndpoint[vaspId])) == keccak256(bytes(endpoint))) return;
        layout.vaspEndpoint[vaspId] = endpoint;
        layout.vasps[vaspId] = RegistryLayout.packVasp(VaspStatus.ACTIVE, admin, uint64(block.timestamp));
        ++layout.version;
        emit VaspEndpointChanged(vaspId, endpoint);
    }

    function isActive(address account) external view returns (bool) {
        return _isActive(getAccount(account));
    }

    function isHolder(address account) public view returns (bool) {
        AccountView memory entry = getAccount(account);
        return _isActive(entry) && (entry.kind == AccountKind.CUSTOMER || entry.kind == AccountKind.VASP_TREASURY);
    }

    function isVerified(address account) external view returns (bool) {
        return isHolder(account);
    }

    function getAccount(address account) public view returns (AccountView memory) {
        return RegistryLayout.unpackAccount(RegistryLayout.get().accounts[account]);
    }

    function vaspOf(address account) external view returns (uint32) {
        return getAccount(account).vaspId;
    }

    function kindOf(address account) external view returns (AccountKind) {
        return getAccount(account).kind;
    }

    function getVasp(uint32 vaspId) external view returns (VaspView memory) {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        (VaspStatus status, address admin, uint64 updatedAt) = RegistryLayout.unpackVasp(layout.vasps[vaspId]);
        return VaspView({
            status: status,
            admin: admin,
            travelRuleSigner: layout.travelRuleSigner[vaspId],
            name: layout.vaspName[vaspId],
            endpoint: layout.vaspEndpoint[vaspId],
            updatedAt: updatedAt
        });
    }

    function travelRuleSignerOf(uint32 vaspId) external view returns (address) {
        return RegistryLayout.get().travelRuleSigner[vaspId];
    }

    function vaspIdOfAdmin(address admin) public view returns (bool found, uint32 vaspId) {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        uint32 plusOne = layout.adminVaspIdPlus1[admin];
        if (plusOne != 0) return (true, plusOne - 1);
        // The largest VASP ID cannot be encoded as ID + 1 in the fixed-width reverse lookup.
        (, address maxAdmin,) = RegistryLayout.unpackVasp(layout.vasps[type(uint32).max]);
        if (admin != address(0) && admin == maxAdmin) return (true, type(uint32).max);
        return (false, 0);
    }

    function enforcementEnabled() public view returns (bool) {
        return (RegistryLayout.get().flags & RegistryLayout.ENFORCEMENT_ENABLED) != 0;
    }

    function version() external view returns (uint64) {
        return RegistryLayout.get().version;
    }

    function consortium() public view returns (address) {
        return RegistryLayout.get().consortium;
    }

    function _isActive(AccountView memory entry) private view returns (bool) {
        if (entry.status != AccountStatus.ACTIVE || (entry.validUntil != 0 && block.timestamp > entry.validUntil)) {
            return false;
        }
        (VaspStatus status,,) = RegistryLayout.unpackVasp(RegistryLayout.get().vasps[entry.vaspId]);
        return status == VaspStatus.ACTIVE;
    }

    function _adminVaspId() private view returns (uint32 vaspId) {
        (bool found, uint32 id) = vaspIdOfAdmin(msg.sender);
        if (!found || getAccount(msg.sender).status != AccountStatus.ACTIVE) revert NotVaspAdmin(msg.sender);
        return id;
    }

    function _registeredVasp(RegistryLayout.Layout storage layout, uint32 vaspId)
        private
        view
        returns (VaspStatus status, address admin)
    {
        (status, admin,) = RegistryLayout.unpackVasp(layout.vasps[vaspId]);
        if (status == VaspStatus.NONE) revert VaspNotFound(vaspId);
    }

    function _requireVaspActive(RegistryLayout.Layout storage layout, uint32 vaspId) private view {
        (VaspStatus status,,) = RegistryLayout.unpackVasp(layout.vasps[vaspId]);
        if (status != VaspStatus.ACTIVE) revert VaspNotActive(vaspId);
    }

    function _managedAccount(address account) private view returns (AccountView memory entry) {
        uint32 vaspId = _adminVaspId();
        entry = getAccount(account);
        if (entry.status != AccountStatus.NONE) {
            if (entry.vaspId != vaspId) revert AccountOfOtherVasp(account, entry.vaspId);
            if (entry.kind != AccountKind.CUSTOMER && entry.kind != AccountKind.VASP_TREASURY) {
                revert InvalidKind(entry.kind);
            }
        }
    }

    function _registerAdmin(RegistryLayout.Layout storage layout, uint32 vaspId, address admin, uint64 nextVersion)
        private
    {
        (bool assigned, uint32 adminVaspId) = vaspIdOfAdmin(admin);
        if (assigned && adminVaspId != vaspId) revert AccountOfOtherVasp(admin, adminVaspId);

        AccountView memory current = getAccount(admin);
        if (current.status != AccountStatus.NONE && current.status != AccountStatus.REVOKED) {
            if (current.vaspId != vaspId) revert AccountOfOtherVasp(admin, current.vaspId);
            if (current.status != AccountStatus.ACTIVE || current.kind != AccountKind.OPERATOR) {
                revert InvalidTransition(admin, current.status, AccountStatus.ACTIVE);
            }
        }

        if (vaspId != type(uint32).max) layout.adminVaspIdPlus1[admin] = vaspId + 1;
        if (current.status != AccountStatus.ACTIVE) {
            _writeAccount(layout, admin, vaspId, AccountKind.OPERATOR, AccountStatus.ACTIVE, 0, nextVersion, bytes32(0));
        }
    }

    function _changeAccount(address account, AccountView memory current, AccountStatus status, bytes32 reason) private {
        RegistryLayout.Layout storage layout = RegistryLayout.get();
        _writeAccount(
            layout, account, current.vaspId, current.kind, status, current.validUntil, ++layout.version, reason
        );
    }

    function _writeAccount(
        RegistryLayout.Layout storage layout,
        address account,
        uint32 vaspId,
        AccountKind kind,
        AccountStatus status,
        uint64 validUntil,
        uint64 nextVersion,
        bytes32 reason
    ) private {
        layout.accounts[account] = RegistryLayout.packAccount(
            AccountView({
                vaspId: vaspId, kind: kind, status: status, validUntil: validUntil, updatedAt: uint64(block.timestamp)
            })
        );
        emit AccountUpdated(account, vaspId, kind, status, validUntil, nextVersion, msg.sender, reason);
    }
}

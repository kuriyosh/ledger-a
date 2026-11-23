// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IKycRegistry} from "./interfaces/IKycRegistry.sol";
import {ITravelRuleCompliance, TravelRuleAttestation} from "./interfaces/ITravelRuleCompliance.sol";

contract LedgerToken is ERC20, ERC2771Context, Ownable, Pausable {
    event TravelRuleTransfer(bytes32 indexed refId, address indexed from, address indexed to, uint256 amount);
    event AddressFrozen(address indexed account, bool indexed isFrozen, address indexed agent);
    event TokensFrozen(address indexed account, uint256 amount);
    event TokensUnfrozen(address indexed account, uint256 amount);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);

    error NotAgent(address caller);
    error AccountFrozen(address account);
    error InsufficientUnfrozenBalance(address account, uint256 available, uint256 needed);
    error InsufficientFrozenBalance(address account, uint256 frozen, uint256 needed);
    error AccountNotEligible(address account);
    error TravelRuleRequired(address from, address to);

    IKycRegistry private immutable _registry;
    ITravelRuleCompliance private immutable _compliance;

    mapping(address account => bool authorized) private _agents;
    mapping(address account => bool frozen) private _frozenAccounts;
    mapping(address account => uint256 amount) private _frozenTokens;

    bool private transient _forcedTransfer;
    bool private transient _attestationConsumed;

    modifier onlyAgent() {
        address caller = _msgSender();
        if (!_agents[caller]) revert NotAgent(caller);
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address registry_,
        address compliance_,
        address trustedForwarder_,
        address owner_
    ) ERC20(name_, symbol_) ERC2771Context(trustedForwarder_) Ownable(owner_) {
        _registry = IKycRegistry(registry_);
        _compliance = ITravelRuleCompliance(compliance_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function transferWithTravelRule(
        address to,
        uint256 amount,
        TravelRuleAttestation calldata attestation,
        bytes calldata signature
    ) external returns (bool) {
        address from = _msgSender();
        _compliance.consume(attestation, signature, from, to, amount);
        _attestationConsumed = true;
        _transfer(from, to, amount);
        _attestationConsumed = false;
        emit TravelRuleTransfer(attestation.refId, from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyAgent {
        _mint(to, amount);
    }

    function burn(address account, uint256 amount) external onlyAgent {
        _burn(account, amount);
    }

    function forcedTransfer(address from, address to, uint256 amount) external onlyAgent returns (bool) {
        _forcedTransfer = true;
        _transfer(from, to, amount);
        _forcedTransfer = false;
        return true;
    }

    function setAddressFrozen(address account, bool freeze) external onlyAgent {
        if (_frozenAccounts[account] == freeze) return;
        _frozenAccounts[account] = freeze;
        emit AddressFrozen(account, freeze, _msgSender());
    }

    function freezePartialTokens(address account, uint256 amount) external onlyAgent {
        _requireUnfrozenBalance(account, amount);
        _frozenTokens[account] += amount;
        emit TokensFrozen(account, amount);
    }

    function unfreezePartialTokens(address account, uint256 amount) external onlyAgent {
        uint256 frozen = _frozenTokens[account];
        if (frozen < amount) revert InsufficientFrozenBalance(account, frozen, amount);
        _frozenTokens[account] = frozen - amount;
        emit TokensUnfrozen(account, amount);
    }

    function pause() external onlyAgent {
        _pause();
    }

    function unpause() external onlyAgent {
        _unpause();
    }

    function addAgent(address agent) external onlyOwner {
        if (_agents[agent]) return;
        _agents[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        if (!_agents[agent]) return;
        delete _agents[agent];
        emit AgentRemoved(agent);
    }

    function isAgent(address account) external view returns (bool) {
        return _agents[account];
    }

    function isFrozen(address account) external view returns (bool) {
        return _frozenAccounts[account];
    }

    function getFrozenTokens(address account) external view returns (uint256) {
        return _frozenTokens[account];
    }

    function identityRegistry() external view returns (address) {
        return address(_registry);
    }

    function compliance() external view returns (address) {
        return address(_compliance);
    }

    function onchainID() external pure returns (address) {
        return address(0);
    }

    function version() external pure returns (string memory) {
        return "1";
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0)) {
            _requireHolder(to);
            _requireNotFrozen(to);
        } else if (to == address(0)) {
            _releaseFrozenShortfall(from, amount);
        } else if (_forcedTransfer) {
            _requireHolder(to);
            _releaseFrozenShortfall(from, amount);
        } else {
            _requireNotPaused();
            _requireNotFrozen(from);
            _requireNotFrozen(to);
            _requireUnfrozenBalance(from, amount);
            _requireHolder(from);
            _requireHolder(to);
            if (!_attestationConsumed && _compliance.requiresTravelRule(from, to)) {
                revert TravelRuleRequired(from, to);
            }
        }
        super._update(from, to, amount);
    }

    function _requireNotFrozen(address account) private view {
        if (_frozenAccounts[account]) revert AccountFrozen(account);
    }

    function _requireUnfrozenBalance(address account, uint256 amount) private view {
        uint256 available = balanceOf(account) - _frozenTokens[account];
        if (available < amount) revert InsufficientUnfrozenBalance(account, available, amount);
    }

    function _requireHolder(address account) private view {
        if (!_registry.isHolder(account)) revert AccountNotEligible(account);
    }

    function _releaseFrozenShortfall(address account, uint256 amount) private {
        uint256 balance = balanceOf(account);
        if (balance < amount) revert ERC20InsufficientBalance(account, balance, amount);
        uint256 remaining = balance - amount;
        uint256 frozen = _frozenTokens[account];
        if (frozen > remaining) {
            _frozenTokens[account] = remaining;
            emit TokensUnfrozen(account, frozen - remaining);
        }
    }

    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}

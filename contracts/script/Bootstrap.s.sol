// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GnosisSafeL2} from "@safe-global/safe-contracts/GnosisSafeL2.sol";
import {Script} from "forge-std/Script.sol";

import {InitializedSafeProxy} from "./InitializedSafeProxy.sol";
import {AtomicSwap} from "../src/AtomicSwap.sol";
import {DepositProbe} from "../src/DepositProbe.sol";
import {KycRegistry} from "../src/KycRegistry.sol";
import {LedgerForwarder} from "../src/LedgerForwarder.sol";
import {LedgerToken} from "../src/LedgerToken.sol";
import {ReceiptLog as LedgerReceiptLog} from "../src/ReceiptLog.sol";
import {TravelRuleCompliance} from "../src/TravelRuleCompliance.sol";
import {AccountKind, AccountStatus, AccountView, IKycRegistry, VaspStatus} from "../src/interfaces/IKycRegistry.sol";

interface IProxyAdmin {
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

contract Bootstrap is Script {
    address private constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address private constant REGISTRY_PREDEPLOY = 0x4200000000000000000000000000000000000700;
    IProxyAdmin private constant PROXY_ADMIN = IProxyAdmin(0x4200000000000000000000000000000000000018);
    address private constant SAFE_L2_PREDEPLOY = 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA;
    bytes32 private constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );
    uint256 private constant INITIAL_TJPY = 200_000_000 * 1e6;
    uint256 private constant INITIAL_TUSD = 1_000_000 * 1e6;

    error InvalidMode();
    error UnexpectedChain(uint256 expected, uint256 actual);
    error Create2DeploymentFailed(bytes32 salt);
    error MissingPredeploy(address account);
    error FundingFailed(address account);
    error ConflictingAccount(address account);
    error WrongRegistryImplementation(address actual);
    error ChangedRegistryAddress(address existing, address computed);
    error MissingDeployment(address expected);
    error InvalidBootstrapConfiguration(address target);

    bool private sealedDeployment;

    struct Roles {
        uint256 adminKey;
        uint256 vaspBAdminKey;
        uint256 treasuryKey;
        uint256 relayerBKey;
        uint256 issuerKey;
        address admin;
        address gateway;
        address relayerA;
        address relayerB;
        address vaspAAdmin;
        address vaspBAdmin;
        address vaspASigner;
        address vaspBSigner;
        address treasury;
        address issuer;
        address[3] safeOwners;
    }

    struct Deployment {
        IKycRegistry registry;
        GnosisSafeL2 safe;
        LedgerForwarder forwarder;
        TravelRuleCompliance travelRule;
        LedgerToken tJPY;
        LedgerToken tUSD;
        AtomicSwap swap;
        LedgerReceiptLog receiptLog;
        DepositProbe depositProbe;
    }

    function run() external {
        bytes32 mode = keccak256(bytes(vm.envString("BOOTSTRAP_MODE")));
        bool anvil = mode == keccak256("anvil");
        if (!anvil && mode != keccak256("devnet")) revert InvalidMode();
        uint256 chainId = anvil ? 31337 : vm.envUint("L2_CHAIN_ID");
        if (chainId != block.chainid) revert UnexpectedChain(chainId, block.chainid);
        if (CREATE2_DEPLOYER.code.length == 0) revert MissingPredeploy(CREATE2_DEPLOYER);

        Roles memory roles = _loadRoles();
        address registryAddress = _registryAddress(anvil, roles.admin);
        address existing = vm.envOr("BOOTSTRAP_EXISTING_REGISTRY", address(0));
        if (anvil && existing != registryAddress && _isEnforced(true, existing)) {
            revert ChangedRegistryAddress(existing, registryAddress);
        }
        sealedDeployment = _isEnforced(anvil, registryAddress);
        if (!sealedDeployment) _fund(roles);

        vm.startBroadcast(roles.adminKey);
        Deployment memory deployment = _deployAll(anvil, roles, registryAddress);
        if (!sealedDeployment) _initializeContracts(deployment, roles);
        vm.stopBroadcast();

        if (!sealedDeployment) _initializeTreasury(deployment, roles);
        _finalize(deployment, roles, anvil);
        _verifyConfiguration(deployment, roles, anvil);
        _writeAddresses(deployment);
    }

    function _loadRoles() private view returns (Roles memory roles) {
        roles.adminKey = vm.envUint("ADMIN_PRIVATE_KEY");
        roles.vaspBAdminKey = vm.envUint("VASP_B_ADMIN_PRIVATE_KEY");
        roles.treasuryKey = vm.envUint("VASP_B_TREASURY_PRIVATE_KEY");
        roles.relayerBKey = vm.envUint("RELAYER_B_PRIVATE_KEY");
        roles.issuerKey = vm.envUint("ISSUER_PRIVATE_KEY");
        roles.admin = vm.addr(roles.adminKey);
        roles.gateway = vm.envAddress("GATEWAY_ADDRESS");
        roles.relayerA = vm.envAddress("RELAYER_A_ADDRESS");
        roles.relayerB = vm.addr(roles.relayerBKey);
        roles.vaspAAdmin = vm.envAddress("VASP_A_ADMIN_ADDRESS");
        roles.vaspBAdmin = vm.addr(roles.vaspBAdminKey);
        roles.vaspASigner = vm.envAddress("VASP_A_SIGNER_ADDRESS");
        roles.vaspBSigner = vm.envAddress("VASP_B_SIGNER_ADDRESS");
        roles.treasury = vm.addr(roles.treasuryKey);
        roles.issuer = vm.addr(roles.issuerKey);
        roles.safeOwners = [
            vm.envAddress("CONSORTIUM_1_ADDRESS"),
            vm.envAddress("CONSORTIUM_2_ADDRESS"),
            vm.envAddress("CONSORTIUM_3_ADDRESS")
        ];
    }

    function _registryAddress(bool anvil, address admin) private view returns (address) {
        if (!anvil) return REGISTRY_PREDEPLOY;
        bytes memory registryInit = abi.encodeCall(IKycRegistry.initialize, (admin));
        address implementation = _address("registry-implementation", type(KycRegistry).creationCode);
        return _address(
            "registry-proxy",
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, registryInit))
        );
    }

    function _isEnforced(bool anvil, address registry) private view returns (bool) {
        if (registry.code.length == 0) return false;
        if (!anvil && vm.load(registry, IMPLEMENTATION_SLOT) == bytes32(0)) return false;
        return IKycRegistry(registry).enforcementEnabled();
    }

    function _fund(Roles memory roles) private {
        address[10] memory senders = [
            roles.admin,
            roles.gateway,
            roles.relayerA,
            roles.relayerB,
            roles.vaspAAdmin,
            roles.vaspBAdmin,
            roles.issuer,
            roles.safeOwners[0],
            roles.safeOwners[1],
            roles.safeOwners[2]
        ];
        vm.startBroadcast(vm.deriveKey("test test test test test test test test test test test junk", 0));
        for (uint256 i; i < senders.length; ++i) {
            address account = senders[i];
            if (account.balance >= 1 ether) continue;
            (bool success,) = account.call{value: 1 ether - account.balance}("");
            if (!success) revert FundingFailed(account);
        }
        vm.stopBroadcast();
    }

    function _deployAll(bool anvil, Roles memory roles, address registryAddress)
        private
        returns (Deployment memory deployment)
    {
        address implementation = _deploy("registry-implementation", type(KycRegistry).creationCode);
        bytes memory registryInit = abi.encodeCall(IKycRegistry.initialize, (roles.admin));
        if (anvil) {
            _deploy(
                "registry-proxy",
                abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(implementation, registryInit))
            );
        } else {
            if (REGISTRY_PREDEPLOY.code.length == 0) revert MissingPredeploy(REGISTRY_PREDEPLOY);
            address installed = address(uint160(uint256(vm.load(REGISTRY_PREDEPLOY, IMPLEMENTATION_SLOT))));
            if (installed == address(0)) PROXY_ADMIN.upgradeAndCall(REGISTRY_PREDEPLOY, implementation, registryInit);
            else if (installed != implementation) revert WrongRegistryImplementation(installed);
        }
        deployment.registry = IKycRegistry(registryAddress);

        address singleton = anvil ? _deploy("safe-l2", type(GnosisSafeL2).creationCode) : SAFE_L2_PREDEPLOY;
        if (singleton.code.length == 0) revert MissingPredeploy(singleton);
        address[] memory owners = new address[](3);
        for (uint256 i; i < owners.length; ++i) owners[i] = roles.safeOwners[i];
        bytes memory safeInit = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            2,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            payable(address(0))
        );
        deployment.safe = GnosisSafeL2(
            payable(_deploy(
                    "consortium-safe",
                    abi.encodePacked(type(InitializedSafeProxy).creationCode, abi.encode(singleton, safeInit))
                ))
        );

        deployment.forwarder = LedgerForwarder(
            _deploy("forwarder", abi.encodePacked(type(LedgerForwarder).creationCode, abi.encode(registryAddress)))
        );
        deployment.travelRule = TravelRuleCompliance(
            _deploy(
                "travel-rule",
                abi.encodePacked(type(TravelRuleCompliance).creationCode, abi.encode(registryAddress, roles.admin))
            )
        );
        deployment.tJPY = _deployToken("tjpy", "Test Yen", "tJPY", deployment, roles.admin);
        deployment.tUSD = _deployToken("tusd", "Test Dollar", "tUSD", deployment, roles.admin);
        deployment.swap = AtomicSwap(
            _deploy(
                "atomic-swap",
                abi.encodePacked(type(AtomicSwap).creationCode, abi.encode(address(deployment.forwarder), roles.admin))
            )
        );
        deployment.receiptLog = LedgerReceiptLog(
            _deploy(
                "receipt-log",
                abi.encodePacked(
                    type(LedgerReceiptLog).creationCode,
                    abi.encode(roles.gateway, roles.gateway, address(deployment.safe))
                )
            )
        );
        deployment.depositProbe = DepositProbe(_deploy("deposit-probe", type(DepositProbe).creationCode));
    }

    function _deployToken(
        string memory salt,
        string memory name,
        string memory symbol,
        Deployment memory deployment,
        address admin
    ) private returns (LedgerToken) {
        bytes memory arguments = abi.encode(
            name,
            symbol,
            address(deployment.registry),
            address(deployment.travelRule),
            address(deployment.forwarder),
            admin
        );
        return LedgerToken(_deploy(salt, abi.encodePacked(type(LedgerToken).creationCode, arguments)));
    }

    function _initializeContracts(Deployment memory deployment, Roles memory roles) private {
        _enableToken(deployment, deployment.tJPY, roles);
        _enableToken(deployment, deployment.tUSD, roles);
        if (deployment.travelRule.owner() == roles.admin) deployment.travelRule.transferOwnership(roles.issuer);

        IKycRegistry registry = deployment.registry;
        if (registry.getVasp(0).status == VaspStatus.NONE) {
            registry.registerVasp(0, roles.admin, roles.admin, "ledgerA Network", "");
        }
        if (registry.getVasp(1).status == VaspStatus.NONE) {
            registry.registerVasp(1, roles.vaspAAdmin, roles.vaspASigner, "VASP A", "http://vasp-a:8621");
        }
        if (registry.getVasp(2).status == VaspStatus.NONE) {
            registry.registerVasp(2, roles.vaspBAdmin, roles.vaspBSigner, "VASP B", "http://vasp-b:8622");
        }
        _registerOperator(registry, roles.gateway, 0, AccountKind.OPERATOR);
        _registerOperator(registry, roles.issuer, 0, AccountKind.OPERATOR);
        for (uint256 i; i < roles.safeOwners.length; ++i) {
            _registerOperator(registry, roles.safeOwners[i], 0, AccountKind.OPERATOR);
        }
        _registerOperator(registry, roles.relayerA, 1, AccountKind.RELAYER);
        _registerOperator(registry, roles.relayerB, 2, AccountKind.RELAYER);
    }

    function _enableToken(Deployment memory deployment, LedgerToken token, Roles memory roles) private {
        if (!deployment.travelRule.isBoundToken(address(token))) deployment.travelRule.bindToken(address(token));
        if (!deployment.swap.isSupportedToken(address(token))) deployment.swap.setSupportedToken(address(token), true);
        if (!token.isAgent(roles.issuer)) token.addAgent(roles.issuer);
        if (token.owner() == roles.admin) token.transferOwnership(roles.issuer);
    }

    function _registerOperator(IKycRegistry registry, address account, uint32 vaspId, AccountKind kind) private {
        AccountView memory current = registry.getAccount(account);
        if (current.status == AccountStatus.NONE) {
            registry.registerOperatorAccount(account, vaspId, kind);
        } else if (current.status != AccountStatus.ACTIVE || current.vaspId != vaspId || current.kind != kind) {
            revert ConflictingAccount(account);
        }
    }

    function _initializeTreasury(Deployment memory deployment, Roles memory roles) private {
        AccountView memory current = deployment.registry.getAccount(roles.treasury);
        if (current.status == AccountStatus.NONE) {
            vm.broadcast(roles.vaspBAdminKey);
            deployment.registry.registerAccount(roles.treasury, AccountKind.VASP_TREASURY, 0);
        } else if (
            current.status != AccountStatus.ACTIVE || current.vaspId != 2 || current.kind != AccountKind.VASP_TREASURY
        ) {
            revert ConflictingAccount(roles.treasury);
        }

        vm.startBroadcast(roles.issuerKey);
        _mintShortfall(deployment.tJPY, roles.treasury, INITIAL_TJPY);
        _mintShortfall(deployment.tUSD, roles.treasury, INITIAL_TUSD);
        vm.stopBroadcast();

        vm.startBroadcast(roles.relayerBKey);
        _approve(deployment, deployment.tJPY, roles);
        _approve(deployment, deployment.tUSD, roles);
        vm.stopBroadcast();
    }

    function _mintShortfall(LedgerToken token, address treasury, uint256 target) private {
        uint256 current = token.balanceOf(treasury);
        if (current < target) token.mint(treasury, target - current);
    }

    function _approve(Deployment memory deployment, LedgerToken token, Roles memory roles) private {
        address swap = address(deployment.swap);
        if (token.allowance(roles.treasury, swap) == type(uint256).max) return;
        uint48 deadline = uint48(block.timestamp + 1 hours);
        uint256 gasLimit = 100_000;
        bytes memory data = abi.encodeCall(IERC20.approve, (swap, type(uint256).max));
        uint256 nonce = deployment.forwarder.nonces(roles.treasury);
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("ledgerA Forwarder"),
                keccak256("1"),
                block.chainid,
                address(deployment.forwarder)
            )
        );
        bytes32 hash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH, roles.treasury, address(token), 0, gasLimit, nonce, deadline, keccak256(data)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(roles.treasuryKey, keccak256(abi.encodePacked(hex"1901", domain, hash)));
        deployment.forwarder
            .execute(
                ERC2771Forwarder.ForwardRequestData({
                    from: roles.treasury,
                    to: address(token),
                    value: 0,
                    gas: gasLimit,
                    deadline: deadline,
                    data: data,
                    signature: abi.encodePacked(r, s, v)
                })
            );
    }

    function _finalize(Deployment memory deployment, Roles memory roles, bool anvil) private {
        vm.startBroadcast(roles.adminKey);
        if (!deployment.registry.enforcementEnabled()) deployment.registry.enableEnforcement();
        if (deployment.registry.consortium() != address(deployment.safe)) {
            deployment.registry.transferConsortium(address(deployment.safe));
        }
        if (!anvil && PROXY_ADMIN.owner() != address(deployment.safe)) {
            PROXY_ADMIN.transferOwnership(address(deployment.safe));
        }
        vm.stopBroadcast();
    }

    function _verifyConfiguration(Deployment memory deployment, Roles memory roles, bool anvil) private view {
        address safe = address(deployment.safe);
        address[] memory owners = deployment.safe.getOwners();
        if (owners.length != 3 || deployment.safe.getThreshold() != 2) revert InvalidBootstrapConfiguration(safe);
        for (uint256 i; i < roles.safeOwners.length; ++i) {
            if (!deployment.safe.isOwner(roles.safeOwners[i])) revert InvalidBootstrapConfiguration(safe);
        }
        if (deployment.registry.consortium() != safe || !deployment.registry.enforcementEnabled()) {
            revert InvalidBootstrapConfiguration(address(deployment.registry));
        }
        if (!anvil && PROXY_ADMIN.owner() != safe) revert InvalidBootstrapConfiguration(address(PROXY_ADMIN));
        if (deployment.receiptLog.owner() != safe) {
            revert InvalidBootstrapConfiguration(address(deployment.receiptLog));
        }
        if (deployment.travelRule.owner() != roles.issuer) {
            revert InvalidBootstrapConfiguration(address(deployment.travelRule));
        }
        if (deployment.swap.owner() != roles.admin) revert InvalidBootstrapConfiguration(address(deployment.swap));
        _verifyToken(deployment, deployment.tJPY, roles.issuer);
        _verifyToken(deployment, deployment.tUSD, roles.issuer);
    }

    function _verifyToken(Deployment memory deployment, LedgerToken token, address issuer) private view {
        if (
            token.owner() != issuer || !token.isAgent(issuer) || !deployment.travelRule.isBoundToken(address(token))
                || !deployment.swap.isSupportedToken(address(token))
        ) revert InvalidBootstrapConfiguration(address(token));
    }

    function _address(string memory name, bytes memory init) private view returns (address) {
        return vm.computeCreate2Address(keccak256(bytes(name)), keccak256(init), CREATE2_DEPLOYER);
    }

    function _deploy(string memory name, bytes memory init) private returns (address deployed) {
        deployed = _address(name, init);
        if (deployed.code.length != 0) return deployed;
        if (sealedDeployment) revert MissingDeployment(deployed);

        bytes32 salt = keccak256(bytes(name));
        (bool success,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, init));
        if (!success || deployed.code.length == 0) revert Create2DeploymentFailed(salt);
    }

    function _writeAddresses(Deployment memory deployment) private {
        string memory object = "contracts";
        vm.serializeAddress(object, "kycRegistry", address(deployment.registry));
        vm.serializeAddress(object, "ledgerForwarder", address(deployment.forwarder));
        vm.serializeAddress(object, "travelRuleCompliance", address(deployment.travelRule));
        vm.serializeAddress(object, "tJPY", address(deployment.tJPY));
        vm.serializeAddress(object, "tUSD", address(deployment.tUSD));
        vm.serializeAddress(object, "atomicSwap", address(deployment.swap));
        vm.serializeAddress(object, "receiptLog", address(deployment.receiptLog));
        vm.serializeAddress(object, "depositProbe", address(deployment.depositProbe));
        string memory json = vm.serializeAddress(object, "consortiumSafe", address(deployment.safe));
        vm.writeJson(json, vm.envString("BOOTSTRAP_OUTPUT"));
    }
}

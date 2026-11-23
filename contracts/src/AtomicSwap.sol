// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IAtomicSwap, Quote} from "./interfaces/IAtomicSwap.sol";

contract AtomicSwap is EIP712, ERC2771Context, Ownable, IAtomicSwap {
    using SafeERC20 for IERC20;

    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address taker,address makerToken,address takerToken,uint256 makerAmount,uint256 takerAmount,uint64 expiry,uint256 nonce)"
    );

    mapping(address maker => mapping(uint256 nonce => bool used)) public isNonceUsed;
    mapping(address token => bool supported) public isSupportedToken;

    constructor(address trustedForwarder_, address owner_)
        EIP712("ledgerA AtomicSwap", "1")
        ERC2771Context(trustedForwarder_)
        Ownable(owner_)
    {}

    function fill(Quote calldata quote, bytes calldata makerSignature) external {
        address taker = _msgSender();
        if (taker != quote.taker) revert NotTaker(taker);
        if (!isSupportedToken[quote.makerToken]) revert UnsupportedToken(quote.makerToken);
        if (!isSupportedToken[quote.takerToken]) revert UnsupportedToken(quote.takerToken);
        if (quote.makerToken == quote.takerToken) revert IdenticalTokens(quote.makerToken);
        if (block.timestamp > quote.expiry) revert QuoteExpired(quote.expiry);

        _useNonce(quote.maker, quote.nonce);
        bytes32 quoteHash = hashQuote(quote);
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(quoteHash, makerSignature);
        if (error != ECDSA.RecoverError.NoError || signer != quote.maker) revert InvalidMakerSignature();

        IERC20(quote.takerToken).safeTransferFrom(taker, quote.maker, quote.takerAmount);
        IERC20(quote.makerToken).safeTransferFrom(quote.maker, taker, quote.makerAmount);

        emit Filled(
            quoteHash, quote.maker, taker, quote.makerToken, quote.makerAmount, quote.takerToken, quote.takerAmount
        );
    }

    function cancel(uint256 nonce) external {
        address maker = _msgSender();
        _useNonce(maker, nonce);
        emit Cancelled(maker, nonce);
    }

    function hashQuote(Quote calldata quote) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, quote)));
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        if (supported && token.code.length == 0) revert UnsupportedToken(token);
        isSupportedToken[token] = supported;
    }

    function _useNonce(address maker, uint256 nonce) private {
        if (isNonceUsed[maker][nonce]) revert QuoteNonceUsed(maker, nonce);
        isNonceUsed[maker][nonce] = true;
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

struct Quote {
    address maker;
    address taker;
    address makerToken;
    address takerToken;
    uint256 makerAmount;
    uint256 takerAmount;
    uint64 expiry;
    uint256 nonce;
}

interface IAtomicSwap {
    function fill(Quote calldata quote, bytes calldata makerSignature) external;
    function cancel(uint256 nonce) external;
    function isNonceUsed(address maker, uint256 nonce) external view returns (bool);
    function hashQuote(Quote calldata quote) external view returns (bytes32);
    function setSupportedToken(address token, bool supported) external;
    function isSupportedToken(address token) external view returns (bool);

    event Filled(
        bytes32 indexed quoteHash,
        address indexed maker,
        address indexed taker,
        address makerToken,
        uint256 makerAmount,
        address takerToken,
        uint256 takerAmount
    );
    event Cancelled(address indexed maker, uint256 nonce);

    error NotTaker(address caller);
    error QuoteExpired(uint64 expiry);
    error QuoteNonceUsed(address maker, uint256 nonce);
    error InvalidMakerSignature();
    error UnsupportedToken(address token);
    error IdenticalTokens(address token);
}

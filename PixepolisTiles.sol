// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ═══════════════════════════════════════════════════════
//  Pixepolis Tiles — ERC-721 NFT land ownership
//  Chain: Base (or any EVM chain)
//
//  Each tile on the 10×10 world map is an NFT.
//  - Mint price: 0.01 ETH
//  - Owners can list tiles for resale at any price
//  - Buyers pay listed price; seller receives ETH minus 5% royalty
//  - Game server reads ownership from this contract
// ═══════════════════════════════════════════════════════

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract PixepolisTiles is ERC721, Ownable {
    using Strings for uint256;

    // ── Constants ──────────────────────────────────────
    uint8  public constant WORLD_SIZE  = 10;       // 10×10 grid = 100 tiles
    uint256 public constant MINT_PRICE = 0.01 ether;
    uint256 public constant ROYALTY_PCT = 5;        // 5% royalty on resales

    // ── State ──────────────────────────────────────────
    // tokenId = x * WORLD_SIZE + z  (0–99)
    mapping(uint256 => bool)    public minted;
    mapping(uint256 => uint256) public listingPrice;  // 0 = not listed
    mapping(uint256 => string)  public cityName;      // owner's city name
    mapping(uint256 => uint256) public cityPop;       // reported population

    string private _baseTokenURI;

    // ── Events ─────────────────────────────────────────
    event TileMinted   (uint8 x, uint8 z, address owner, uint256 price);
    event TileListed   (uint8 x, uint8 z, address owner, uint256 price);
    event TileDelisted (uint8 x, uint8 z);
    event TileSold     (uint8 x, uint8 z, address from, address to, uint256 price);
    event CityUpdated  (uint8 x, uint8 z, string name, uint256 population);

    // ── Constructor ────────────────────────────────────
    constructor(address initialOwner)
        ERC721("Pixepolis Tiles", "PXTL")
        Ownable(initialOwner)
    {}

    // ── Helpers ────────────────────────────────────────
    function tileToTokenId(uint8 x, uint8 z) public pure returns (uint256) {
        require(x < WORLD_SIZE && z < WORLD_SIZE, "Out of bounds");
        return uint256(x) * WORLD_SIZE + uint256(z);
    }

    function tokenIdToTile(uint256 tokenId) public pure returns (uint8 x, uint8 z) {
        require(tokenId < WORLD_SIZE * WORLD_SIZE, "Invalid tokenId");
        x = uint8(tokenId / WORLD_SIZE);
        z = uint8(tokenId % WORLD_SIZE);
    }

    // ── Mint — buy a tile for 0.01 ETH ────────────────
    function mint(uint8 x, uint8 z) external payable {
        require(msg.value >= MINT_PRICE, "Send 0.01 ETH");
        uint256 tokenId = tileToTokenId(x, z);
        require(!minted[tokenId], "Tile already owned");

        minted[tokenId] = true;
        _safeMint(msg.sender, tokenId);

        // Refund any overpayment
        if (msg.value > MINT_PRICE) {
            payable(msg.sender).transfer(msg.value - MINT_PRICE);
        }

        emit TileMinted(x, z, msg.sender, MINT_PRICE);
    }

    // ── List tile for resale ───────────────────────────
    function listForSale(uint8 x, uint8 z, uint256 price) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");
        require(price > 0, "Price must be > 0");

        listingPrice[tokenId] = price;
        emit TileListed(x, z, msg.sender, price);
    }

    // ── Delist (cancel sale) ───────────────────────────
    function delist(uint8 x, uint8 z) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");

        listingPrice[tokenId] = 0;
        emit TileDelisted(x, z);
    }

    // ── Buy a listed tile ──────────────────────────────
    function buy(uint8 x, uint8 z) external payable {
        uint256 tokenId = tileToTokenId(x, z);
        uint256 price   = listingPrice[tokenId];
        address seller  = ownerOf(tokenId);

        require(price > 0,              "Not listed for sale");
        require(msg.value >= price,     "Insufficient ETH");
        require(msg.sender != seller,   "Cannot buy your own tile");

        // Clear listing
        listingPrice[tokenId] = 0;

        // Calculate royalty (goes to contract owner / game treasury)
        uint256 royalty   = (price * ROYALTY_PCT) / 100;
        uint256 sellerAmt = price - royalty;

        // Transfer NFT
        _transfer(seller, msg.sender, tokenId);

        // Pay seller
        payable(seller).transfer(sellerAmt);

        // Refund overpayment
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }

        // Clear city data on ownership transfer
        cityName[tokenId] = "";
        cityPop[tokenId]  = 0;

        emit TileSold(x, z, seller, msg.sender, price);
    }

    // ── Update city metadata (owner only) ─────────────
    // Called by game server to record city name + population on-chain
    function updateCity(uint8 x, uint8 z, string calldata name, uint256 pop) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");

        cityName[tokenId] = name;
        cityPop[tokenId]  = pop;

        emit CityUpdated(x, z, name, pop);
    }

    // ── Read helpers ───────────────────────────────────
    function getTileOwner(uint8 x, uint8 z) external view returns (address) {
        uint256 tokenId = tileToTokenId(x, z);
        if (!minted[tokenId]) return address(0);
        return ownerOf(tokenId);
    }

    function getTileInfo(uint8 x, uint8 z) external view returns (
        address owner,
        bool    forSale,
        uint256 price,
        string memory name,
        uint256 pop
    ) {
        uint256 tokenId = tileToTokenId(x, z);
        if (!minted[tokenId]) return (address(0), false, 0, "", 0);
        owner   = ownerOf(tokenId);
        price   = listingPrice[tokenId];
        forSale = price > 0;
        name    = cityName[tokenId];
        pop     = cityPop[tokenId];
    }

    // Get all tile owners in one call (gas-efficient batch read)
    function getAllOwners() external view returns (address[100] memory owners) {
        for (uint256 i = 0; i < 100; i++) {
            if (minted[i]) owners[i] = ownerOf(i);
        }
    }

    // ── Token URI ──────────────────────────────────────
    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(minted[tokenId], "Token does not exist");
        (uint8 x, uint8 z) = tokenIdToTile(tokenId);
        if (bytes(_baseTokenURI).length > 0) {
            return string(abi.encodePacked(_baseTokenURI, tokenId.toString()));
        }
        // Inline SVG metadata if no base URI set
        string memory svg = string(abi.encodePacked(
            '<svg xmlns="http://www.w3.org/2000/svg" width="350" height="350">',
            '<rect width="350" height="350" fill="#0a0e1a"/>',
            '<text x="175" y="140" text-anchor="middle" fill="#7eb8ff" font-size="48">&#127758;</text>',
            '<text x="175" y="200" text-anchor="middle" fill="#c9d8f0" font-size="22" font-family="monospace">PIXEPOLIS TILE</text>',
            '<text x="175" y="235" text-anchor="middle" fill="#445566" font-size="16" font-family="monospace">[', Strings.toString(x), ',', Strings.toString(z), ']</text>',
            '<text x="175" y="270" text-anchor="middle" fill="#4ddb88" font-size="14" font-family="monospace">', cityName[tokenId], '</text>',
            '</svg>'
        ));
        string memory json = Base64.encode(bytes(string(abi.encodePacked(
            '{"name":"Pixepolis Tile [', Strings.toString(x), ',', Strings.toString(z), ']",',
            '"description":"A land tile in Pixepolis — the on-chain city builder.",',
            '"image":"data:image/svg+xml;base64,', Base64.encode(bytes(svg)), '",',
            '"attributes":[',
                '{"trait_type":"X","value":', Strings.toString(x), '},',
                '{"trait_type":"Z","value":', Strings.toString(z), '},',
                '{"trait_type":"City","value":"', cityName[tokenId], '"}',
            ']}'
        ))));
        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    // ── Withdraw minting revenue ───────────────────────
    function withdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "Nothing to withdraw");
        payable(owner()).transfer(balance);
    }

    // Allow contract to receive ETH
    receive() external payable {}
}

// ── Base64 utility (inline, no import needed) ──────────
library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";
        string memory table = TABLE;
        uint256 encodedLen = 4 * ((data.length + 2) / 3);
        string memory result = new string(encodedLen + 32);
        assembly {
            let tablePtr := add(table, 1)
            let resultPtr := add(result, 32)
            for { let i := 0 } lt(i, mload(data)) {} {
                i := add(i, 3)
                let input := and(mload(add(data, i)), 0xffffff)
                let out := mload(add(tablePtr, and(shr(18, input), 0x3F)))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(12, input), 0x3F))), 0xFF))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(shr(6,  input), 0x3F))), 0xFF))
                out := shl(8, out)
                out := add(out, and(mload(add(tablePtr, and(            input,  0x3F))), 0xFF))
                out := shl(224, out)
                mstore(resultPtr, out)
                resultPtr := add(resultPtr, 4)
            }
            switch mod(mload(data), 3)
            case 1 { mstore(sub(resultPtr, 2), shl(240, 0x3d3d)) }
            case 2 { mstore(sub(resultPtr, 1), shl(248, 0x3d))   }
            mstore(result, encodedLen)
        }
        return result;
    }
}

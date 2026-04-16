// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract PixelPolisTiles is ERC721, Ownable {
    using Strings for uint256;

    uint8   public constant WORLD_SIZE  = 10;
    uint256 public constant MINT_PRICE  = 0.01 ether;
    uint256 public constant ROYALTY_PCT = 5;

    mapping(uint256 => bool)    public minted;
    mapping(uint256 => uint256) public listingPrice;
    mapping(uint256 => string)  public cityName;
    mapping(uint256 => uint256) public cityPop;
    string private _baseTokenURI;

    event TileMinted  (uint8 x, uint8 z, address owner, uint256 price);
    event TileListed  (uint8 x, uint8 z, address owner, uint256 price);
    event TileDelisted(uint8 x, uint8 z);
    event TileSold    (uint8 x, uint8 z, address from, address to, uint256 price);
    event CityUpdated (uint8 x, uint8 z, string name, uint256 population);

    constructor(address initialOwner)
        ERC721("Pixel Polis Tiles", "PPTL")
        Ownable(initialOwner)
    {}

    function tileToTokenId(uint8 x, uint8 z) public pure returns (uint256) {
        require(x < WORLD_SIZE && z < WORLD_SIZE, "Out of bounds");
        return uint256(x) * WORLD_SIZE + uint256(z);
    }

    function tokenIdToTile(uint256 tokenId) public pure returns (uint8 x, uint8 z) {
        require(tokenId < 100, "Invalid tokenId");
        x = uint8(tokenId / WORLD_SIZE);
        z = uint8(tokenId % WORLD_SIZE);
    }

    function mint(uint8 x, uint8 z) external payable {
        require(msg.value >= MINT_PRICE, "Send 0.01 ETH");
        uint256 tokenId = tileToTokenId(x, z);
        require(!minted[tokenId], "Already owned");
        minted[tokenId] = true;
        _safeMint(msg.sender, tokenId);
        if (msg.value > MINT_PRICE) {
            payable(msg.sender).transfer(msg.value - MINT_PRICE);
        }
        emit TileMinted(x, z, msg.sender, MINT_PRICE);
    }

    function listForSale(uint8 x, uint8 z, uint256 price) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");
        require(price > 0, "Price must be > 0");
        listingPrice[tokenId] = price;
        emit TileListed(x, z, msg.sender, price);
    }

    function delist(uint8 x, uint8 z) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");
        listingPrice[tokenId] = 0;
        emit TileDelisted(x, z);
    }

    function buy(uint8 x, uint8 z) external payable {
        uint256 tokenId = tileToTokenId(x, z);
        uint256 price   = listingPrice[tokenId];
        address seller  = ownerOf(tokenId);
        require(price > 0,            "Not listed");
        require(msg.value >= price,   "Insufficient ETH");
        require(msg.sender != seller, "Cannot buy own tile");
        listingPrice[tokenId] = 0;
        uint256 royalty   = (price * ROYALTY_PCT) / 100;
        uint256 sellerAmt = price - royalty;
        _transfer(seller, msg.sender, tokenId);
        payable(seller).transfer(sellerAmt);
        if (msg.value > price) {
            payable(msg.sender).transfer(msg.value - price);
        }
        cityName[tokenId] = "";
        cityPop[tokenId]  = 0;
        emit TileSold(x, z, seller, msg.sender, price);
    }

    function updateCity(uint8 x, uint8 z, string calldata name, uint256 pop) external {
        uint256 tokenId = tileToTokenId(x, z);
        require(ownerOf(tokenId) == msg.sender, "Not your tile");
        cityName[tokenId] = name;
        cityPop[tokenId]  = pop;
        emit CityUpdated(x, z, name, pop);
    }

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

    function getAllOwners() external view returns (address[100] memory owners) {
        for (uint256 i = 0; i < 100; i++) {
            if (minted[i]) owners[i] = ownerOf(i);
        }
    }

    function setBaseURI(string calldata uri) external onlyOwner {
        _baseTokenURI = uri;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(minted[tokenId], "Token does not exist");
        return string(bytes.concat(
            bytes(_baseTokenURI),
            bytes(tokenId.toString())
        ));
    }

    function withdraw() external onlyOwner {
        uint256 bal = address(this).balance;
        require(bal > 0, "Nothing to withdraw");
        payable(owner()).transfer(bal);
    }

    receive() external payable {}
}

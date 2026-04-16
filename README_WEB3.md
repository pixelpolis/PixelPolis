# 🏙️ Pixel_Polis — Web3 City Builder

A multiplayer Pixel_Polis builder where world map tiles are NFTs on Base.
Players buy tiles for 0.01 ETH, build cities, and resell tiles at any price.

---

## Architecture

```
pixel_polis.html   — Single-file game client (Three.js + ethers.js)
server.js         — Node.js WebSocket server (multiplayer, chat, raids)
Pixel_PolisTiles.sol — ERC-721 smart contract (tile ownership + marketplace)
```

---

## Step 1 — Deploy the Smart Contract

### Option A: Remix IDE (easiest, no setup)

1. Go to **remix.ethereum.org**
2. Create `Pixel_PolisTiles.sol` and paste the contract code
3. Install OpenZeppelin: in the terminal run:
   ```
   npm install @openzeppelin/contracts
   ```
   Or in Remix: use the "Deps" tab to add `@openzeppelin/contracts`
4. Compile with Solidity 0.8.20
5. In "Deploy & Run":
   - Environment: **Injected Provider (MetaMask)**
   - Switch MetaMask to **Base Sepolia** (testnet) first
   - Constructor arg: your wallet address
   - Click Deploy → confirm in MetaMask
6. Copy the deployed contract address

### Option B: Hardhat (recommended for production)

```bash
# Install
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox dotenv
npm install @openzeppelin/contracts

# Setup
cp hardhat.config.js .
cp deploy.js scripts/deploy.js
cp Pixel_PolisTiles.sol contracts/Pixel_PolisTiles.sol

# Create .env file (NEVER commit this)
echo "PRIVATE_KEY=your_wallet_private_key_here" > .env
echo "BASESCAN_API_KEY=optional_for_verification" >> .env

# Test on Base Sepolia first (free testnet ETH from faucet.base.org)
npx hardhat run scripts/deploy.js --network base-sepolia

# When ready for real money:
npx hardhat run scripts/deploy.js --network base

# Optional: verify on Basescan
npx hardhat verify --network base DEPLOYED_ADDRESS "YOUR_WALLET_ADDRESS"
```

---

## Step 2 — Configure the Game Client

Open `pixel_polis.html` and find line:
```js
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000000';
```

Replace with your deployed address:
```js
const CONTRACT_ADDRESS = '0xYourDeployedAddressHere';
```

Also check the chain ID matches:
```js
const CHAIN_ID = 8453;   // Base mainnet
// or
const CHAIN_ID = 84532;  // Base Sepolia testnet
```

---

## Step 3 — Deploy the Game Server

### Railway (recommended)

```bash
git init
git add pixel_polis.html server.js package.json
git commit -m "Pixel_Polis"
# Push to GitHub, then:
# railway.app → New Project → Deploy from GitHub
# Settings → Networking → Generate Domain
```

### Render

```bash
# render.com → New Web Service → connect GitHub repo
# Build command: npm install
# Start command: node server.js
```

### VPS (DigitalOcean / Linode)

```bash
npm install
npm install -g pm2
pm2 start server.js --name pixel_polis
pm2 save && pm2 startup
sudo ufw allow 3000
```

---

## How the Web3 System Works

### Buying a tile
1. Player opens World Map
2. Empty tiles show **"0.01 ETH"** — click to mint
3. MetaMask opens → player pays 0.01 ETH + gas
4. Contract mints an ERC-721 NFT to their wallet
5. They can now build a city on that tile

### Reselling a tile
1. Right-click your tile on the World Map → "List for Sale"
2. Enter your desired price (e.g. 0.05 ETH)
3. Contract records the listing on-chain
4. Other players see the tile marked 🏷️ with the price
5. Click the tile → "Buy for 0.05 ETH" → MetaMask confirms
6. ETH goes to seller (minus 5% royalty to game treasury)
7. NFT transfers to buyer

### Revenue model
- **Mint fee**: 0.01 ETH per tile × 100 tiles = 1 ETH total if all minted
- **Royalty**: 5% of every resale goes to contract owner wallet
- **Withdraw**: call `withdraw()` on the contract to collect ETH

---

## Contract Functions Reference

| Function | Who | Cost | What it does |
|----------|-----|------|-------------|
| `mint(x, z)` | Anyone | 0.01 ETH | Buy an empty tile, get NFT |
| `listForSale(x, z, price)` | Owner | gas | List tile at your price |
| `delist(x, z)` | Owner | gas | Cancel listing |
| `buy(x, z)` | Anyone | listing price | Buy a listed tile |
| `updateCity(x, z, name, pop)` | Owner | gas | Update city name on-chain |
| `withdraw()` | Contract owner | gas | Collect minting revenue |
| `getTileInfo(x, z)` | Anyone | free | Read tile owner + price |
| `getAllOwners()` | Anyone | free | Batch read all 100 tiles |

---

## Security Notes

- **Never commit your `.env` file or private key**
- Test on Base Sepolia (testnet) before deploying to mainnet
- The contract has been written defensively:
  - Overpayment is refunded automatically
  - Only tile owner can list/delist/update
  - Buying your own tile is blocked
  - All arithmetic uses checked math (Solidity 0.8+)
- Consider an audit before handling significant funds

---

## Testnet Setup

Get free Base Sepolia ETH:
- **faucet.base.org** — up to 0.1 ETH/day
- **Coinbase Wallet** — free Sepolia ETH for verified users

Add Base Sepolia to MetaMask:
- Network name: Base Sepolia
- RPC: https://sepolia.base.org
- Chain ID: 84532
- Symbol: ETH
- Explorer: https://sepolia.basescan.org

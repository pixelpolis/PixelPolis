// scripts/deploy.js — run with:  npx hardhat run scripts/deploy.js --network base
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  const Factory = await ethers.getContractFactory("Pixel_PolisTiles");
  const contract = await Factory.deploy(deployer.address);
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  console.log("\n✅ Pixel_PolisTiles deployed to:", addr);
  console.log("\nNext steps:");
  console.log("1. Copy the address above");
  console.log("2. Paste it into pixel_polis.html as CONTRACT_ADDRESS");
  console.log("3. Deploy your game server (Railway / Render)");
  console.log("4. Share your URL — players can now buy tiles with MetaMask!");
}

main().catch(e => { console.error(e); process.exit(1); });

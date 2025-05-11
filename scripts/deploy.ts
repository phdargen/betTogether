import hre from "hardhat";

async function main() {
  console.log("Deploying BetTogether contract...");
  
  // Deploy the BetTogether contract
  const betTogether = await hre.viem.deployContract("BetTogether", []);
  console.log(`BetTogether deployed to ${await betTogether.address}`);
  
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 
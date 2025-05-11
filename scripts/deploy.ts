import hre from "hardhat";

async function main() {
  console.log("Deploying BetTogether contract...");
  
  // Deploy the BetTogether contract with the truth market manager address
  const truthMarketManagerAddress = "0x61A98Bef11867c69489B91f340fE545eEfc695d7";
  const betTogether = await hre.viem.deployContract("BetTogether", [truthMarketManagerAddress]);
  console.log(`BetTogether deployed to ${await betTogether.address}`);
  
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 
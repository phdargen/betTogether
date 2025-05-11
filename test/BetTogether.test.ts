import { expect } from "chai";
import hre from "hardhat"; 
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"; 
import { WalletClient, PublicClient, Abi, getContract } from "viem"; 
import { parseUnits, formatUnits, zeroAddress, GetContractReturnType, Address, parseAbiItem } from "viem";

// Assuming BetTogether.sol is in contracts/ and compiled, its ABI will be available
// For explicit typing of the deployed contract instance:
// import { abi as BetTogetherAbi } from "../artifacts/contracts/DirectBet.sol/BetTogether.json";
// type BetTogetherContractType = GetContractReturnType<typeof BetTogetherAbi, WalletClient[]>;

// Use parseAbiItem for a more strongly typed ABI fragment
const truthMarketMinimalAbi = [
    parseAbiItem("function marketQuestion() view returns (string)")
] as const; // Crucial for Viem's type inference

describe("BetTogether with Viem", function () {
    // let betTogether: BetTogetherContractType; // More specific type
    let betTogether: any; // Using any for now, can be refined with BetTogetherContractType
    let owner: WalletClient;
    let addr1: WalletClient;
    let publicClient: PublicClient; // Typed publicClient

    // Address provided by user, stated to be a valid TruthMarket on Base mainnet
    const truthMarketAddress = "0xa93B6Fe76764297fd6E9C649c1401Bd53C469515" as Address;
    
    // Corresponds to PRICE_PRECISION = 1e18 in the contract, now as bigint
    const PRICE_PRECISION = parseUnits("1", 18); 

    async function deployBetTogetherFixture() {
        const [ownerAccount, addr1Account] = await hre.viem.getWalletClients();
        const deployedBetTogether = await hre.viem.deployContract("BetTogether", []);
        const pubClient = await hre.viem.getPublicClient();
        return { deployedBetTogether, ownerAccount, addr1Account, pubClient };
    }

    beforeEach(async function () {
        const { deployedBetTogether, ownerAccount, addr1Account, pubClient } = await loadFixture(deployBetTogetherFixture);
        betTogether = deployedBetTogether;
        owner = ownerAccount;
        addr1 = addr1Account;
        publicClient = pubClient;
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            // Convert both addresses to lowercase for case-insensitive comparison
            expect((await betTogether.read.owner()).toLowerCase()).to.equal(owner.account!.address.toLowerCase());
        });

        it("Should have POOL_CONSISTENCY_TOLERANCE_BPS initialized", async function () {
            expect(await betTogether.read.POOL_CONSISTENCY_TOLERANCE_BPS()).to.equal(50n); // Default value, ensure bigint comparison
        });
    });

    describe("getPoolPrices", function () {
        it("should attempt to retrieve YES and NO prices from the specified TruthMarket", async function () {
            console.log(`Testing getPoolPrices with market address: ${truthMarketAddress}`);

            const code = await publicClient.getCode({ address: truthMarketAddress });
            if (code === "0x" || code === undefined) {
                console.warn(`WARNING: Address ${truthMarketAddress} does not have deployed bytecode. This test will likely fail when the contract tries to interact with it as a TruthMarket.`);
            }

            try {
                const [yesPrice, noPrice] = await betTogether.read.getPoolPrices([truthMarketAddress]);

                console.log("Retrieved prices (scaled to 1e18):");
                console.log(`  YES Price: ${yesPrice.toString()} (${formatUnits(yesPrice, 18)})`);
                console.log(`  NO Price: ${noPrice.toString()} (${formatUnits(noPrice, 18)})`);

                // Using direct bigint comparison with .to.be.true for gt/lt
                expect(yesPrice > 0n).to.be.true;
                expect(noPrice > 0n).to.be.true;
                expect(yesPrice < PRICE_PRECISION).to.be.true;
                expect(noPrice < PRICE_PRECISION).to.be.true;
                
                const sumPrice = yesPrice + noPrice;
                expect(sumPrice).to.equal(PRICE_PRECISION, "Sum of YES and NO prices should equal PRICE_PRECISION");

                console.log("Price assertions passed. If you saw this, getPoolPrices executed without arithmetic overflow for this market.");

            } catch (error: any) {
                console.error("Error calling getPoolPrices:", error);
                throw error;
            }
        });

        it("should revert when calling getPoolPrices with a zero address market", async function () {
             // Read calls that revert will cause the promise to reject.
             // The exact error message might be generic like "Transaction reverted without a reason string"
             // or more specific if the called contract has specific checks.
             // Using a general Error check or a regex for part of an expected message is safer.
             await expect(betTogether.read.getPoolPrices([zeroAddress])).to.be.rejectedWith(Error);
        });
    });

    describe("TruthMarket Interaction", function () {
        it("should retrieve and print the marketQuestion from the specified TruthMarket", async function () {
            console.log(`Attempting to read marketQuestion from: ${truthMarketAddress}`);

            const code = await publicClient.getCode({ address: truthMarketAddress });
            if (code === "0x" || code === undefined) {
                console.warn(`WARNING: Address ${truthMarketAddress} does not have deployed bytecode. This test will likely fail or return an empty question if it's not a valid TruthMarket contract.`);
            }

            try {
                // Use viem's getContract directly instead of hardhat-viem's getContractAt
                const truthMarketContract = getContract({
                    abi: truthMarketMinimalAbi,
                    address: truthMarketAddress,
                    client: {
                        public: publicClient
                    }
                });

                const question = await truthMarketContract.read.marketQuestion();
                console.log("Market Question:", question);

                // Add an expectation if you want to assert something about the question
                // For now, just printing it as requested.
                expect(question).to.be.a('string'); // Basic check that it's a string

            } catch (error) {
                console.error("Error reading marketQuestion from TruthMarket:", error);
                // If the contract doesn't exist or doesn't have this function, Viem might throw.
                // It could also be an issue with the RPC connection to the Base mainnet fork.
                throw error;
            }
        });
    });

    describe("setPoolConsistencyTolerance", function () {
        it("Should allow owner to set pool consistency tolerance and emit event", async function () {
            const initialTolerance = await betTogether.read.POOL_CONSISTENCY_TOLERANCE_BPS();
            const newTolerance = 100n; 

            const hash = await betTogether.write.setPoolConsistencyTolerance([newTolerance], { account: owner.account! });
            await publicClient.waitForTransactionReceipt({ hash });
            
            // Fetch and assert event (style from Lock.ts)
            const toleranceUpdatedEvents = await betTogether.getEvents.PoolConsistencyToleranceUpdated();
            expect(toleranceUpdatedEvents).to.have.lengthOf(1);
            expect(toleranceUpdatedEvents[0].args.oldValue).to.equal(initialTolerance);
            expect(toleranceUpdatedEvents[0].args.newValue).to.equal(newTolerance);

            expect(await betTogether.read.POOL_CONSISTENCY_TOLERANCE_BPS()).to.equal(newTolerance);
        });

        it("Should prevent non-owner from setting pool consistency tolerance", async function () {
            const newTolerance = 100n;
            // Update expected error message to match OpenZeppelin's custom error
            await expect(betTogether.write.setPoolConsistencyTolerance([newTolerance], { account: addr1.account! }))
                .to.be.rejectedWith(/OwnableUnauthorizedAccount/); 
        });

        it("Should revert if setting pool consistency tolerance to 0", async function () {
             await expect(betTogether.write.setPoolConsistencyTolerance([0n], { account: owner.account! }))
                .to.be.rejectedWith("Invalid BPS value");
        });

        it("Should revert if setting pool consistency tolerance above 1000 BPS (10%)", async function () {
             await expect(betTogether.write.setPoolConsistencyTolerance([1001n], { account: owner.account! }))
                .to.be.rejectedWith("Invalid BPS value");
        });
    });
}); 
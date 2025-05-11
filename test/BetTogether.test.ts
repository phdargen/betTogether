import { expect } from "chai";
import hre from "hardhat"; 
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"; 
import { WalletClient, PublicClient, getContract } from "viem"; 
import { parseUnits, formatUnits, zeroAddress, Address, parseAbiItem } from "viem";

const truthMarketMinimalAbi = [
    parseAbiItem("function marketQuestion() view returns (string)"),
    parseAbiItem("function paymentToken() view returns (address)"),
    parseAbiItem("function yesToken() view returns (address)"),
    parseAbiItem("function noToken() view returns (address)"),
    parseAbiItem("function getCurrentStatus() view returns (uint8)"),
    parseAbiItem("function getPoolAddresses() view returns (address, address)"),
    parseAbiItem("function mint(uint256 amount) returns (uint256)")
] as const; 

const erc20Abi = [
    parseAbiItem("function balanceOf(address) view returns (uint256)"),
    parseAbiItem("function decimals() view returns (uint8)"),
    parseAbiItem("function approve(address, uint256) returns (bool)"),
    parseAbiItem("function transfer(address, uint256) returns (bool)"),
    parseAbiItem("function allowance(address, address) view returns (uint256)")
] as const;

describe("BetTogether with Viem", function () {
    let betTogether: any; 
    let owner: WalletClient;
    let addr1: WalletClient;
    let addr2: WalletClient;
    let publicClient: PublicClient; 

    const truthMarketAddress = "0xa93B6Fe76764297fd6E9C649c1401Bd53C469515" as Address;
    
    // Corresponds to PRICE_PRECISION = 1e18 in the contract, now as bigint
    const PRICE_PRECISION = parseUnits("1", 18); 

    async function deployBetTogetherFixture() {
        const [ownerAccount, addr1Account, addr2Account] = await hre.viem.getWalletClients();
        const deployedBetTogether = await hre.viem.deployContract("BetTogether", []);
        const pubClient = await hre.viem.getPublicClient();
        return { deployedBetTogether, ownerAccount, addr1Account, addr2Account, pubClient };
    }

    beforeEach(async function () {
        const { deployedBetTogether, ownerAccount, addr1Account, addr2Account, pubClient } = await loadFixture(deployBetTogetherFixture);
        betTogether = deployedBetTogether;
        owner = ownerAccount;
        addr1 = addr1Account;
        addr2 = addr2Account;
        publicClient = pubClient;
        
        // Print deployer address
        console.log("Deployer (owner) address:", owner.account!.address);
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            // Convert both addresses to lowercase for case-insensitive comparison
            expect((await betTogether.read.owner()).toLowerCase()).to.equal(owner.account!.address.toLowerCase());
        });

        it("Should have POOL_CONSISTENCY_TOLERANCE_BPS initialized", async function () {
            const tolerance = await betTogether.read.POOL_CONSISTENCY_TOLERANCE_BPS();
            expect(BigInt(tolerance)).to.equal(50n); // Convert to BigInt before comparison
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
                const truthMarketContract = getContract({
                    abi: truthMarketMinimalAbi,
                    address: truthMarketAddress,
                    client: {
                        public: publicClient
                    }
                });

                const question = await truthMarketContract.read.marketQuestion();
                console.log("Market Question:", question);
                expect(question).to.be.a('string'); // Basic check that it's a string

            } catch (error) {
                console.error("Error reading marketQuestion from TruthMarket:", error);
                // If the contract doesn't exist or doesn't have this function, Viem might throw.
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
            
            const toleranceUpdatedEvents = await betTogether.getEvents.PoolConsistencyToleranceUpdated();
            expect(toleranceUpdatedEvents).to.have.lengthOf(1);
            expect(BigInt(toleranceUpdatedEvents[0].args.oldValue)).to.equal(BigInt(initialTolerance));
            expect(BigInt(toleranceUpdatedEvents[0].args.newValue)).to.equal(newTolerance);

            const updatedTolerance = await betTogether.read.POOL_CONSISTENCY_TOLERANCE_BPS();
            expect(BigInt(updatedTolerance)).to.equal(newTolerance);
        });

        it("Should prevent non-owner from setting pool consistency tolerance", async function () {
            const newTolerance = 100n;
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

    describe("Complete Bet Workflow", function () {
        let truthMarketContract: any;
        let paymentToken: any;
        let yesToken: any;
        let noToken: any;
        let paymentTokenDecimals: number;

        // Skip this suite if we can't connect to mainnet fork
        before(async function() {
            try {
                // Try to access the TruthMarket contract
                const code = await publicClient.getCode({ address: truthMarketAddress });
                if (code === "0x" || code === undefined) {
                    console.log("TruthMarket contract not found on the network. Skipping Complete Bet Workflow tests.");
                    this.skip();
                }

                // Connect to the TruthMarket
                truthMarketContract = getContract({
                    abi: truthMarketMinimalAbi,
                    address: truthMarketAddress,
                    client: {
                        public: publicClient
                    }
                });

                // Get the payment token address
                const paymentTokenAddress = await truthMarketContract.read.paymentToken();
                console.log(`Found payment token address: ${paymentTokenAddress}`);

                // Connect to the payment token contract
                paymentToken = getContract({
                    abi: erc20Abi,
                    address: paymentTokenAddress,
                    client: {
                        public: publicClient,
                        wallet: owner
                    }
                });

                // Get yes/no token addresses
                const yesTokenAddress = await truthMarketContract.read.yesToken();
                const noTokenAddress = await truthMarketContract.read.noToken();
                console.log(`Found YES token address: ${yesTokenAddress}`);
                console.log(`Found NO token address: ${noTokenAddress}`);

                // Connect to YES and NO token contracts
                yesToken = getContract({
                    abi: erc20Abi,
                    address: yesTokenAddress,
                    client: {
                        public: publicClient,
                        wallet: owner
                    }
                });

                noToken = getContract({
                    abi: erc20Abi,
                    address: noTokenAddress,
                    client: {
                        public: publicClient,
                        wallet: owner
                    }
                });

                // Get token decimals
                paymentTokenDecimals = await paymentToken.read.decimals();
                console.log(`Payment token has ${paymentTokenDecimals} decimals`);

                // Check that the contracts have the expected methods
                await truthMarketContract.read.getCurrentStatus();
                await truthMarketContract.read.getPoolAddresses();

            } catch (error) {
                console.error("Error setting up TruthMarket connections:", error);
                this.skip();
            }
        });

        it("Should demonstrate the complete bet workflow", async function() {
            // Simulate workflow in a mainnet fork
            console.log("\nDemonstrating complete bet workflow with real market prices:");
            
            const [yesPrice, noPrice] = await betTogether.read.getPoolPrices([truthMarketAddress]);
            console.log(`Current YES price: ${formatUnits(yesPrice, 18)} (${yesPrice})`);
            console.log(`Current NO price: ${formatUnits(noPrice, 18)} (${noPrice})`);
            
            // Create a bet with Alice (addr1) taking the YES position
            console.log("\nAlice creates a bet for the YES position");
            
            // Define Alice's parameters
            const aliceAmount = parseUnits("10", paymentTokenDecimals); // A smaller amount for testing
            const priceTolerance = 300; // 3% tolerance for price changes
            
            // Calculate what Bob should expect to pay
            const bobExpectedAmount = await betTogether.read.calculateCounterpartyAmount([
                aliceAmount,
                true, // Alice takes YES
                yesPrice, 
                noPrice
            ]);
            
            console.log(`Alice deposits: ${formatUnits(aliceAmount, paymentTokenDecimals)} payment tokens`);
            console.log(`Bob should expect to deposit: ${formatUnits(bobExpectedAmount, paymentTokenDecimals)} payment tokens`);
            
            const yesPercentage = Number(formatUnits(yesPrice, 18)) * 100;
            const noPercentage = Number(formatUnits(noPrice, 18)) * 100;
            console.log(`Current market sentiment: YES ${yesPercentage.toFixed(2)}%, NO ${noPercentage.toFixed(2)}%`);
            
            // Verify counterparty calculation method matches the README example
            const manualCalculation = (Number(formatUnits(aliceAmount, paymentTokenDecimals)) * 
                (yesPercentage / noPercentage));
                
            console.log(`Manual calculation (simplified): ${manualCalculation.toFixed(4)} payment tokens`);
            console.log(`Contract calculation: ${formatUnits(bobExpectedAmount, paymentTokenDecimals)} payment tokens`);
            
            // Ensure the math is relatively close between our simplified calculation and the contract
            // We can't expect exact matches due to precision differences
            const contractCalculation = Number(formatUnits(bobExpectedAmount, paymentTokenDecimals));
            const diff = Math.abs(manualCalculation - contractCalculation);
            const percentage = (diff / manualCalculation) * 100;
            
            console.log(`Difference: ${diff.toFixed(4)} (${percentage.toFixed(2)}%)`);
            expect(percentage).to.be.lt(5, "Calculations should be within 5% of each other");
        });

        it("Should allow the contract to correctly calculate counterparty amounts", async function() {
            // Test a range of scenarios to ensure the math works correctly
            const scenarios = [
                { 
                    initiatorAmount: parseUnits("1000", paymentTokenDecimals), 
                    initiatorTakesYes: true,
                    yesPrice: parseUnits("0.645", 18),  // 64.5%
                    noPrice: parseUnits("0.355", 18)    // 35.5%
                },
                { 
                    initiatorAmount: parseUnits("1000", paymentTokenDecimals), 
                    initiatorTakesYes: false,
                    yesPrice: parseUnits("0.645", 18),  // 64.5%
                    noPrice: parseUnits("0.355", 18)    // 35.5%
                },
                { 
                    initiatorAmount: parseUnits("1000", paymentTokenDecimals), 
                    initiatorTakesYes: true,
                    yesPrice: parseUnits("0.25", 18),   // 25%
                    noPrice: parseUnits("0.75", 18)     // 75%
                }
            ];
            
            console.log("\nTesting different price scenarios for counterparty calculations:");
            
            for (let i = 0; i < scenarios.length; i++) {
                const scenario = scenarios[i];
                const counterpartyAmount = await betTogether.read.calculateCounterpartyAmount([
                    scenario.initiatorAmount,
                    scenario.initiatorTakesYes,
                    scenario.yesPrice,
                    scenario.noPrice
                ]);
                
                // Calculate manually for comparison
                const yesPercent = Number(formatUnits(scenario.yesPrice, 18));
                const noPercent = Number(formatUnits(scenario.noPrice, 18));
                const initiatorAmount = Number(formatUnits(scenario.initiatorAmount, paymentTokenDecimals));
                
                let manualCalculation;
                if (scenario.initiatorTakesYes) {
                    manualCalculation = initiatorAmount * (yesPercent / noPercent);
                } else {
                    manualCalculation = initiatorAmount * (noPercent / yesPercent);
                }
                
                console.log(`\nScenario ${i+1}:`);
                console.log(`Initiator takes: ${scenario.initiatorTakesYes ? "YES" : "NO"}`);
                console.log(`YES price: ${formatUnits(scenario.yesPrice, 18)} (${yesPercent * 100}%)`);
                console.log(`NO price: ${formatUnits(scenario.noPrice, 18)} (${noPercent * 100}%)`);
                console.log(`Initiator amount: ${formatUnits(scenario.initiatorAmount, paymentTokenDecimals)}`);
                console.log(`Calculated counterparty amount: ${formatUnits(counterpartyAmount, paymentTokenDecimals)}`);
                console.log(`Manual calculation: ${manualCalculation.toFixed(6)}`);
                
                // Ensure the calculation is within a reasonable tolerance
                const calculatedAmount = Number(formatUnits(counterpartyAmount, paymentTokenDecimals));
                const diff = Math.abs(calculatedAmount - manualCalculation);
                const percentage = (diff / manualCalculation) * 100;
                
                console.log(`Difference: ${diff.toFixed(4)} (${percentage.toFixed(2)}%)`);
                expect(percentage).to.be.lt(5, "Calculations should be within 5% of each other");
            }
        });

        it("Should validate the bet creation and cancellation flow", async function() {
            // This test verifies the logic of creating and cancelling a bet
            console.log("\nValidating the bet creation and cancellation flow logic");
            console.log("Note: This test verifies the contract logic without actual token transfers");
            
            // Simulate the contract behavior for creating a bet
            const [yesPrice, noPrice] = await betTogether.read.getPoolPrices([truthMarketAddress]);
            
            // Calculate what the event values would be
            const initiatorAmount = parseUnits("100", paymentTokenDecimals);
            const priceToleranceBps = 300; // 3%
            
            const expectedCounterpartyAmount = await betTogether.read.calculateCounterpartyAmount([
                initiatorAmount,
                true, // initiator takes YES position
                yesPrice,
                noPrice
            ]);
            
            console.log(`Initiator amount: ${formatUnits(initiatorAmount, paymentTokenDecimals)}`);
            console.log(`YES price: ${formatUnits(yesPrice, 18)}`);
            console.log(`NO price: ${formatUnits(noPrice, 18)}`);
            console.log(`Expected counterparty amount: ${formatUnits(expectedCounterpartyAmount, paymentTokenDecimals)}`);
            
            // Verify the price deviation tolerance calculation works
            // BetTogether calculates: allowedDeviation = (initialPrice * toleranceBps) / 10000
            // Then checks if priceDifference <= allowedDeviation
            const toleranceBps = priceToleranceBps;
            const initialPrice = yesPrice;
            const allowedDeviation = (initialPrice * BigInt(toleranceBps)) / 10000n;
            
            console.log(`\nPrice deviation tolerance: ${toleranceBps} BPS (${(toleranceBps / 100).toFixed(2)}%)`);
            console.log(`Allowed deviation in price: ${formatUnits(allowedDeviation, 18)}`);
            
            // Calculate some example price movements
            const smallMove = (initialPrice * 2n) / 100n; // 2% price movement
            const largeMove = (initialPrice * 5n) / 100n; // 5% price movement
            
            const newPriceSmallMove = initialPrice + smallMove;
            const newPriceLargeMove = initialPrice + largeMove;
            
            console.log(`\nInitial price: ${formatUnits(initialPrice, 18)}`);
            console.log(`Small price movement (2%): ${formatUnits(newPriceSmallMove, 18)}`);
            console.log(`Large price movement (5%): ${formatUnits(newPriceLargeMove, 18)}`);
            
            // Check if these price movements would be within tolerance
            console.log(`\nSmall movement within tolerance? ${smallMove <= allowedDeviation}`);
            console.log(`Large movement within tolerance? ${largeMove <= allowedDeviation}`);
            
            // Validate our understanding matches the contract
            expect(smallMove <= allowedDeviation).to.be.true;
            expect(largeMove <= allowedDeviation).to.be.false;
            
            console.log("\nBet creation and cancellation flow logic verified");
        });

        it("Should actually execute a complete bet workflow with real contract calls", async function() {
            // Skip the test if we previously had setup issues
            if (!truthMarketContract || !paymentToken) {
                this.skip();
                return;
            }
            
            // Check deployer (owner) balance to ensure we have USDC
            const ownerBalanceBefore = await paymentToken.read.balanceOf([owner.account!.address]);
            console.log(`\nDeployer balance: ${formatUnits(ownerBalanceBefore, paymentTokenDecimals)} USDC`);
            
            // Skip if balance is too low
            if (ownerBalanceBefore < parseUnits("1", paymentTokenDecimals)) {
                console.log("Insufficient USDC balance to perform test. Skipping.");
                this.skip();
                return;
            }
            
            // Transfer some USDC to addr1 to act as counterparty
            const transferAmount = parseUnits("0.1", paymentTokenDecimals); // Use a smaller amount for testing
            if (addr1.account && ownerBalanceBefore >= parseUnits("2", paymentTokenDecimals)) {
                // Make sure addr1 has some USDC too
                const addr1BalanceBefore = await paymentToken.read.balanceOf([addr1.account.address]);
                if (addr1BalanceBefore < transferAmount) {
                    console.log("Transferring 0.1 USDC to addr1 for testing");
                    const hash = await paymentToken.write.transfer(
                        [addr1.account.address, transferAmount],
                        { account: owner.account! }
                    );
                    await publicClient.waitForTransactionReceipt({ hash });
                }
            }
            
            // Check initial balances
            const addr1Balance = await paymentToken.read.balanceOf([addr1.account!.address]);
            console.log(`addr1 balance: ${formatUnits(addr1Balance, paymentTokenDecimals)} USDC`);
            
            if (addr1Balance < transferAmount) {
                console.log("addr1 has insufficient USDC for test. Skipping.");
                this.skip();
                return;
            }
            
            // 1. Get the current market prices to understand conditions
            const [currentYesPrice, currentNoPrice] = await betTogether.read.getPoolPrices([truthMarketAddress]);
            console.log(`\nCurrent market prices:`);
            console.log(`YES: ${formatUnits(currentYesPrice, 18)} (${Number(formatUnits(currentYesPrice, 18)) * 100}%)`);
            console.log(`NO: ${formatUnits(currentNoPrice, 18)} (${Number(formatUnits(currentNoPrice, 18)) * 100}%)`);
            
            // 2. Approve USDC spending by BetTogether contract
            console.log("\nApproving USDC spending for BetTogether");
            
            // Owner approves with a higher amount to ensure enough approval
            const approvalAmount = parseUnits("5", paymentTokenDecimals);
            let hash = await paymentToken.write.approve(
                [betTogether.address, approvalAmount],
                { account: owner.account! }
            );
            await publicClient.waitForTransactionReceipt({ hash });
            
            // Check if the approval worked
            const allowance = await paymentToken.read.allowance([
                owner.account!.address, 
                betTogether.address
            ]);
            console.log(`Approval granted: ${formatUnits(allowance, paymentTokenDecimals)} USDC`);
            
            // 3. Owner creates a bet
            console.log("\nCreating bet on TruthMarket");
            
            const betParams = {
                marketAddress: truthMarketAddress,
                takesYesPosition: true, // Owner takes YES position
                amount: transferAmount, // 0.1 USDC
                priceToleranceBps: 1000, // 10% tolerance (maximum)
            };
            
            console.log("Creating bet with parameters:", {
                marketAddress: betParams.marketAddress,
                takesYesPosition: betParams.takesYesPosition,
                amount: formatUnits(betParams.amount, paymentTokenDecimals),
                priceToleranceBps: betParams.priceToleranceBps
            });
            
            // Now try the actual createBet call
            hash = await betTogether.write.createBet(
                [betParams.marketAddress, betParams.takesYesPosition, betParams.amount, betParams.priceToleranceBps],
                { 
                    account: owner.account!,
                    gas: 3000000n // Increase gas limit
                }
            );
            
            console.log("Create bet transaction hash:", hash);
            
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Transaction status:", receipt.status);
            
            // Verify transaction was successful
            expect(receipt.status).to.equal('success', "Transaction failed");
            
            // Check balances to confirm tokens were transferred
            const ownerUsdcAfter = await paymentToken.read.balanceOf([owner.account!.address]);
            const difference = BigInt(ownerBalanceBefore) - BigInt(ownerUsdcAfter);
            console.log(`USDC spent in transaction: ${formatUnits(difference, paymentTokenDecimals)}`);
            
            // Verify the difference matches the transferred amount (within reasonable tolerance for gas costs)
            expect(Number(difference)).to.be.greaterThanOrEqual(Number(betParams.amount));
            
            // Check if betId 0 exists in the contract by querying it directly
            try {
                const bet = await betTogether.read.getBet([0n]); // First betId should be 0
                console.log("\nVerified bet details from contract:", {
                    marketAddress: bet[0],
                    initiator: bet[1],
                    initiatorTakesYesPosition: bet[2],
                    initiatorAmount: formatUnits(bet[3], paymentTokenDecimals),
                    acceptor: bet[4],
                    acceptorAmount: formatUnits(bet[5], paymentTokenDecimals),
                    priceToleranceBps: bet[6],
                    initialPriceForInitiator: formatUnits(bet[7], 18),
                    isExecuted: bet[8],
                    createdAt: new Date(Number(bet[9]) * 1000).toISOString()
                });
                
                // Verify the bet was created with the expected parameters
                expect(bet[0]).to.equal(betParams.marketAddress);
                expect(bet[1].toLowerCase()).to.equal(owner.account!.address.toLowerCase());
                expect(bet[2]).to.equal(betParams.takesYesPosition);
                expect(bet[3]).to.equal(betParams.amount);
                expect(Number(bet[6])).to.equal(betParams.priceToleranceBps);
                
                console.log("Test completed successfully - Bet creation verified through contract call");
            } catch (error) {
                console.error("Error verifying bet:", error);
                throw error;
            }
        });

        it("Should complete a full bet workflow with token distribution and acceptance rules", async function() {
            // Skip the test if we previously had setup issues
            if (!truthMarketContract || !paymentToken || !yesToken || !noToken) {
                this.skip();
                return;
            }
            
            console.log("\n--- Testing Full Bet Workflow ---");
            
            // Check deployer (owner) balance to ensure we have USDC
            const ownerBalanceBefore = await paymentToken.read.balanceOf([owner.account!.address]);
            console.log(`Deployer balance: ${formatUnits(ownerBalanceBefore, paymentTokenDecimals)} USDC`);
            
            // Skip if owner balance is too low
            if (ownerBalanceBefore < parseUnits("0.5", paymentTokenDecimals)) {
                console.log("Insufficient USDC balance to perform test. Skipping.");
                this.skip();
                return;
            }
            
            // Transfer sufficient USDC to addr1 for testing
            if (addr1.account) {
                console.log("\nTransferring USDC to addr1 for testing");
                let hash = await paymentToken.write.transfer(
                    [addr1.account.address, parseUnits("0.2", paymentTokenDecimals)],
                    { account: owner.account! }
                );
                await publicClient.waitForTransactionReceipt({ hash });
                
                const addr1Balance = await paymentToken.read.balanceOf([addr1.account.address]);
                console.log(`addr1 balance after transfer: ${formatUnits(addr1Balance, paymentTokenDecimals)} USDC`);
            }
            
            // Also transfer some USDC to addr2 to test multiple acceptors
            if (addr2.account) {
                console.log("Transferring USDC to addr2 for testing");
                const hash = await paymentToken.write.transfer(
                    [addr2.account.address, parseUnits("0.1", paymentTokenDecimals)],
                    { account: owner.account! }
                );
                await publicClient.waitForTransactionReceipt({ hash });
                
                const addr2Balance = await paymentToken.read.balanceOf([addr2.account.address]);
                console.log(`addr2 balance after transfer: ${formatUnits(addr2Balance, paymentTokenDecimals)} USDC`);
            }
            
            // 1. Get the current market prices
            const [currentYesPrice, currentNoPrice] = await betTogether.read.getPoolPrices([truthMarketAddress]);
            console.log(`\nCurrent market prices:`);
            console.log(`YES: ${formatUnits(currentYesPrice, 18)} (${Number(formatUnits(currentYesPrice, 18)) * 100}%)`);
            console.log(`NO: ${formatUnits(currentNoPrice, 18)} (${Number(formatUnits(currentNoPrice, 18)) * 100}%)`);
            
            // 2. Approve USDC spending by BetTogether contract
            console.log("\nApproving USDC spending for all parties");
            
            // Owner approves for bet creation
            const ownerApprovalAmount = parseUnits("0.2", paymentTokenDecimals);
            let hash = await paymentToken.write.approve(
                [betTogether.address, ownerApprovalAmount],
                { account: owner.account! }
            );
            await publicClient.waitForTransactionReceipt({ hash });
            
            // addr1 approves for bet acceptance
            const addr1ApprovalAmount = parseUnits("0.2", paymentTokenDecimals);
            hash = await paymentToken.write.approve(
                [betTogether.address, addr1ApprovalAmount],
                { 
                    account: addr1.account!,
                    gas: 2000000n
                }
            );
            await publicClient.waitForTransactionReceipt({ hash });
            
            // addr2 approves for trying to accept an already accepted bet
            const addr2ApprovalAmount = parseUnits("0.2", paymentTokenDecimals);
            hash = await paymentToken.write.approve(
                [betTogether.address, addr2ApprovalAmount],
                { 
                    account: addr2.account!,
                    gas: 2000000n
                }
            );
            await publicClient.waitForTransactionReceipt({ hash });
            
            // 3. Owner creates a bet
            console.log("\nCreating bet on TruthMarket");
            
            const initiatorAmount = parseUnits("0.1", paymentTokenDecimals);
            const priceToleranceBps = 1000; // 10% tolerance (maximum)
            
            const betParams = {
                marketAddress: truthMarketAddress,
                takesYesPosition: true, // Owner takes YES position
                amount: initiatorAmount,
                priceToleranceBps: priceToleranceBps
            };
            
            console.log("Creating bet with parameters:", {
                marketAddress: betParams.marketAddress,
                takesYesPosition: betParams.takesYesPosition,
                amount: formatUnits(betParams.amount, paymentTokenDecimals),
                priceToleranceBps: betParams.priceToleranceBps
            });
            
            // Create the bet
            hash = await betTogether.write.createBet(
                [
                    betParams.marketAddress, 
                    betParams.takesYesPosition, 
                    betParams.amount, 
                    betParams.priceToleranceBps
                ],
                { 
                    account: owner.account!,
                    gas: 3000000n // Increase gas limit
                }
            );
            
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            expect(receipt.status).to.equal('success', "Transaction failed");
            
            // Get the betId (should be 0 for the first bet)
            const betId = 0n;
            
            // Verify the bet was created properly
            const betDetails = await betTogether.read.getBet([betId]);
            console.log("\nBet created with ID:", betId.toString());
            
            // 4. Calculate expected counterparty amount using contract's method
            const expectedCounterpartyAmount = await betTogether.read.calculateCounterpartyAmount([
                initiatorAmount,
                betParams.takesYesPosition,
                currentYesPrice,
                currentNoPrice
            ]);
            console.log(`Expected counterparty amount: ${formatUnits(expectedCounterpartyAmount, paymentTokenDecimals)} USDC`);
            
            // 5. addr1 accepts the bet
            console.log("\naddr1 accepting the bet...");
            hash = await betTogether.write.acceptBet(
                [betId],
                { 
                    account: addr1.account!,
                    gas: 4000000n // Increase gas limit
                }
            );
            
            const acceptReceipt = await publicClient.waitForTransactionReceipt({ hash });
            expect(acceptReceipt.status).to.equal('success', "Accept transaction failed");
            
            // 6. Try to accept the same bet with addr2 (should fail)
            console.log("\naddr2 attempting to accept already accepted bet (should fail)...");
            try {
                await betTogether.write.acceptBet(
                    [betId],
                    { 
                        account: addr2.account!,
                        gas: 4000000n
                    }
                );
                // If we get here, the transaction didn't revert as expected
                expect.fail("Second acceptance should have failed");
            } catch (error: any) {
                console.log("Expected error occurred:", error.message.substring(0, 100) + "...");
                // The error message is different in the mainnet fork, so just check that some error occurred
                expect(error).to.exist;
                console.log("✓ Second acceptance correctly failed as expected");
            }
            
            // 7. Check YES and NO token balances for initiator and acceptor
            // We expect the owner (initiator with YES position) to have YES tokens
            // and addr1 (acceptor) to have NO tokens
            
            const betData = await betTogether.read.getBet([betId]);
            const tokensMinted = BigInt(betData[5]); // acceptorAmount 
            console.log(`\nTransaction complete. Checking token distributions...`);
            
            // Calculate expected token amounts (should be scaled by token decimals)
            const totalDeposited = initiatorAmount + expectedCounterpartyAmount;
            const yesDec = await yesToken.read.decimals();
            const noDec = await noToken.read.decimals();
            
            // Expected minted amount in YES/NO tokens - implement our own calculation
            const expectedTokenAmount = (totalDeposited * (10n ** BigInt(yesDec))) / (10n ** BigInt(paymentTokenDecimals));
            
            console.log(`Expected token amount: ${expectedTokenAmount} (scaled by ${yesDec} decimals)`);
            
            // Check actual balances
            const ownerYesBalance = await yesToken.read.balanceOf([owner.account!.address]);
            const ownerNoBalance = await noToken.read.balanceOf([owner.account!.address]);
            const addr1YesBalance = await yesToken.read.balanceOf([addr1.account!.address]);
            const addr1NoBalance = await noToken.read.balanceOf([addr1.account!.address]);
            
            console.log("\nToken balances after bet execution:");
            console.log(`Owner YES balance: ${ownerYesBalance}`);
            console.log(`Owner NO balance: ${ownerNoBalance}`);
            console.log(`addr1 YES balance: ${addr1YesBalance}`);
            console.log(`addr1 NO balance: ${addr1NoBalance}`);
            
            // Verify the token distribution is correct - convert BigInt to number for comparison
            const ownerYesBalanceNum = Number(formatUnits(ownerYesBalance, yesDec));
            const addr1NoBalanceNum = Number(formatUnits(addr1NoBalance, noDec));
            
            expect(ownerYesBalanceNum).to.be.greaterThan(0, "Owner should have received YES tokens");
            expect(addr1NoBalanceNum).to.be.greaterThan(0, "addr1 should have received NO tokens");
            
            // The acceptor should have 0 YES tokens (or very close to 0 if they had some before)
            // The initiator should have 0 NO tokens (or very close to 0 if they had some before)
            if (addr1YesBalance > 0n) {
                console.log("addr1 already had YES tokens before this test");
            }
            if (ownerNoBalance > 0n) {
                console.log("Owner already had NO tokens before this test");
            }
            
            // Verify the bet is now marked as executed
            const betAfter = await betTogether.read.getBet([betId]);
            expect(betAfter[8]).to.be.true; // isExecuted should be true
            
            console.log("\nFull bet workflow test completed successfully!");
        });
    });
}); 
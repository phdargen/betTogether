
Shared Minting Contract: Final Design Overview
Core Concept
A smart contract that allows two users to collaboratively mint YES/NO prediction market tokens, with each user taking their preferred position at fair market prices, avoiding slippage from low-liquidity pools.
Procedure
1. Initiation Phase

Person A creates a mint request specifying:

Target prediction market
Desired position (YES or NO)
Amount of USDC to deposit
Acceptable price deviation tolerance (e.g., ±5%)


Contract transfers USDC from Person A and holds it in escrow
Mint request remains open indefinitely until filled or canceled

2. Price Determination

Contract calculates fair price using average from both pools:

Direct price from YES/USDC pool
Implied price from NO/USDC pool (calculated as 1 - NO price)
Takes the average of both values


Contract performs consistency check:

Ensures YES price + NO price ≈ 1.0 (within tolerance)
Rejects suspicious pricing if deviation exceeds threshold



3. Join Phase

Person B views the mint request details including:

Current required USDC amount (calculated from current average price)
Which position they would receive (opposite of Person A)


If Person B agrees, they deposit the required USDC
Contract verifies price is still within Person A's tolerance range
If verification passes, the mint proceeds; otherwise, it reverts

4. Execution Phase

Contract combines funds from both parties
Calls the prediction market's mint function to create YES/NO token pair
Distributes tokens according to positions:

Person A receives their chosen position tokens
Person B receives the opposite position tokens


Emits event confirming successful mint

5. Cancellation

Person A can cancel their pending mint request at any time before Person B joins
USDC is returned in full to Person A

Example Flow (Corrected)

Alice initiates mint for Market "Will ETH hit $10K in 2025?":

Chooses YES position
Deposits 1000 USDC
Sets tolerance to ±3%


Contract calculates current average price:

YES = 0.645 (64.5%)
NO = 0.355 (35.5%)


Bob sees Alice's mint request:

Required amount = 1000 × (0.355/0.645) ≈ 550 USDC
Position = NO


Bob deposits 550 USDC
Contract executes mint:

Total USDC: 1550
Mints 1550 YES and 1550 NO tokens
Alice receives 1550 YES tokens (worth 1000 USDC at 0.645 per token)
Bob receives 1550 NO tokens (worth 550 USDC at 0.355 per token)



Key Security Features

Manipulation Resistance: Using average price from both pools makes attacks more difficult
Price Tolerance: Person A sets acceptable deviation to protect against minor price movements
Consistency Checks: Verifies pool prices are reasonable (YES + NO ≈ 1)
Non-Reentrancy: Guards against contract reentrancy attacks

This design provides a simple yet effective solution for users to enter prediction markets without suffering slippage, while maintaining fair pricing based on current market conditions.

```shell
npx hardhat help
npx hardhat compile
npx hardhat run scripts/deploy.ts --network baseSepolia
npx hardhat verify --network baseSepolia DEPLOYED_CONTRACT_ADDRESS
```
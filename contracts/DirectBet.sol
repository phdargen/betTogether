// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "src/interfaces/ITruthMarket.sol";
import "src/MarketEnums.sol";

/**
 * @title BetTogether
 * @dev Enables two users to collaboratively mint YES/NO prediction market tokens
 * at fair market prices, avoiding slippage from low-liquidity pools.
 */
contract BetTogether is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    struct Bet {
        address marketAddress;
        address initiator;
        bool initiatorTakesYesPosition;
        uint256 initiatorAmount; // Amount initiator deposited in payment tokens
        
        address acceptor;
        uint256 acceptorAmount; // Amount acceptor deposited in payment tokens (calculated at acceptance)

        uint256 priceToleranceBps; // Initiator's price deviation tolerance in basis points (e.g., 500 for 5%)
        uint256 initialPriceForInitiator; // The fair price (scaled to PRICE_PRECISION) for the initiator's chosen token side at creation time

        bool isExecuted; // True if tokens have been minted and distributed, or if canceled
        uint256 createdAt;
    }
    
    // Constants
    // PRICE_PRECISION represents 1.0 or 100% for price calculations
    uint256 public constant PRICE_PRECISION = 1e18; 
    // System tolerance for pool consistency check (e.g., 0.5% = 50 BPS)
    // 1 BPS = 0.01%, so 50 BPS = 0.5%
    uint256 public POOL_CONSISTENCY_TOLERANCE_BPS = 50; 

    // Storage
    mapping(uint256 => Bet) public bets;
    uint256 public nextBetId;
    
    // Events
    event BetCreated(
        uint256 indexed betId, 
        address indexed marketAddress, 
        address indexed initiator, 
        bool initiatorTakesYesPosition, 
        uint256 initiatorAmount,
        uint256 priceToleranceBps,
        uint256 initialPriceForInitiator, // Price for initiator's side at creation
        uint256 suggestedCounterpartyAmount
    );
    event BetAccepted(
        uint256 indexed betId, 
        address indexed acceptor, 
        uint256 acceptorAmount,
        uint256 currentPriceForInitiator // Price for initiator's side at acceptance
    );
    event BetExecuted(
        uint256 indexed betId, 
        uint256 totalYesNoTokensMinted // Amount of EACH Yes and No token minted
    );
    event BetCanceled(
        uint256 indexed betId, 
        address indexed initiator, 
        uint256 refundAmount
    );
    event PoolConsistencyToleranceUpdated(uint256 oldValue, uint256 newValue);
    
    /**
     * @notice Contract constructor
     */
    constructor() Ownable(msg.sender) {
        // Initialize contract
    }

    /**
     * @notice Creates a new mint request on a TruthMarket.
     * @param marketAddress Address of the TruthMarket contract.
     * @param takesYesPosition True if the initiator wants the YES position, false for NO.
     * @param amount Amount of payment tokens the initiator is depositing.
     * @param priceToleranceBps Initiator's acceptable price deviation in basis points (e.g., 300 for 3%). Max 10000 (100%).
     * @return betId Unique identifier for the created bet.
     * @return suggestedCounterpartyAmount Current suggested amount for counterparty based on current fair prices.
     */
    function createBet(
        address marketAddress, 
        bool takesYesPosition, 
        uint256 amount,
        uint256 priceToleranceBps
    ) 
        external 
        nonReentrant 
        returns (uint256 betId, uint256 suggestedCounterpartyAmount) 
    {
        require(marketAddress != address(0), "Invalid market address");
        require(amount > 0, "Amount must be greater than 0");
        require(priceToleranceBps > 0 && priceToleranceBps <= 10000, "Invalid price tolerance BPS"); // Max 100%
        
        ITruthMarket market = ITruthMarket(marketAddress);
        
        require(uint8(market.getCurrentStatus()) != uint8(MarketStatus.Finalized), "Market already finalized");
        
        IERC20 paymentToken = IERC20(market.paymentToken());
        
        (uint256 currentYesPrice, uint256 currentNoPrice) = _getAverageFairPrices(marketAddress);
        
        uint256 priceForInitiatorAtCreation;
        if (takesYesPosition) {
            priceForInitiatorAtCreation = currentYesPrice;
            suggestedCounterpartyAmount = calculateCounterpartyAmount(amount, true, currentYesPrice, currentNoPrice);
        } else {
            priceForInitiatorAtCreation = currentNoPrice;
            suggestedCounterpartyAmount = calculateCounterpartyAmount(amount, false, currentYesPrice, currentNoPrice);
        }
        require(priceForInitiatorAtCreation > 0, "Initiator price cannot be zero");
        require(suggestedCounterpartyAmount > 0, "Suggested counterparty amount is zero");

        paymentToken.safeTransferFrom(msg.sender, address(this), amount);
        
        betId = nextBetId++;
        
        bets[betId] = Bet({
            marketAddress: marketAddress,
            initiator: msg.sender,
            initiatorTakesYesPosition: takesYesPosition,
            initiatorAmount: amount,
            acceptor: address(0),
            acceptorAmount: 0,
            priceToleranceBps: priceToleranceBps,
            initialPriceForInitiator: priceForInitiatorAtCreation,
            isExecuted: false, // Not executed or canceled yet
            createdAt: block.timestamp
        });
        
        emit BetCreated(
            betId, 
            marketAddress, 
            msg.sender, 
            takesYesPosition, 
            amount, 
            priceToleranceBps,
            priceForInitiatorAtCreation,
            suggestedCounterpartyAmount
        );
    }
    
    /**
     * @notice Accept an existing mint request by taking the opposite position.
     * @param betId ID of the bet to accept.
     */
    function acceptBet(uint256 betId) external nonReentrant {
        Bet storage bet = bets[betId];
        require(bet.marketAddress != address(0), "Bet does not exist");
        require(!bet.isExecuted, "Bet already executed or canceled");
        require(bet.acceptor == address(0), "Bet already accepted");
        
        ITruthMarket market = ITruthMarket(bet.marketAddress);
        IERC20 paymentToken = IERC20(market.paymentToken());
        
        require(uint8(market.getCurrentStatus()) != uint8(MarketStatus.Finalized), "Market already finalized");
        
        (uint256 currentYesPrice, uint256 currentNoPrice) = _getAverageFairPrices(bet.marketAddress);

        uint256 currentPriceForInitiatorSide;
        uint256 acceptorDepositAmount;

        if (bet.initiatorTakesYesPosition) { // Initiator is YES, acceptor is NO
            currentPriceForInitiatorSide = currentYesPrice;
            acceptorDepositAmount = calculateCounterpartyAmount(bet.initiatorAmount, true, currentYesPrice, currentNoPrice);
        } else { // Initiator is NO, acceptor is YES
            currentPriceForInitiatorSide = currentNoPrice;
            acceptorDepositAmount = calculateCounterpartyAmount(bet.initiatorAmount, false, currentYesPrice, currentNoPrice);
        }
        require(currentPriceForInitiatorSide > 0, "Current price for initiator side is zero");
        require(acceptorDepositAmount > 0, "Calculated acceptor amount is zero");

        // Check initiator's price tolerance
        uint256 priceDifference;
        if (currentPriceForInitiatorSide > bet.initialPriceForInitiator) {
            priceDifference = currentPriceForInitiatorSide - bet.initialPriceForInitiator;
        } else {
            priceDifference = bet.initialPriceForInitiator - currentPriceForInitiatorSide;
        }
        
        uint256 allowedDeviation = (bet.initialPriceForInitiator * bet.priceToleranceBps) / 10000; // 10000 BPS = 100%
        require(priceDifference <= allowedDeviation, "Price moved out of initiator's tolerance");
        
        paymentToken.safeTransferFrom(msg.sender, address(this), acceptorDepositAmount);
        
        bet.acceptor = msg.sender;
        bet.acceptorAmount = acceptorDepositAmount;
        
        emit BetAccepted(betId, msg.sender, acceptorDepositAmount, currentPriceForInitiatorSide);
        
        _executeBet(betId);
    }

    /**
     * @notice Internal function to calculate fair prices using averaging and consistency checks.
     * @param marketAddress Address of the TruthMarket contract.
     * @return avgYesPrice Price of YES token (scaled to PRICE_PRECISION).
     * @return avgNoPrice Price of NO token (scaled to PRICE_PRECISION).
     */
    function _getAverageFairPrices(address marketAddress) internal view returns (uint256 avgYesPrice, uint256 avgNoPrice) {
        ITruthMarket market = ITruthMarket(marketAddress);
        (address yesPoolAddress, address noPoolAddress) = market.getPoolAddresses();

        require(yesPoolAddress != address(0) && noPoolAddress != address(0), "Pool addresses not set");

        uint256 directYesPrice = 0;
        uint256 directNoPrice = 0;

        // Get direct YES price
        try this.getSqrtPriceX96(yesPoolAddress) returns (uint160 sqrtPriceX96) {
            if (sqrtPriceX96 == 0) {
                revert("Zero sqrtPrice from YES pool");
            }
            
            uint256 priceFromPool = (uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * PRICE_PRECISION) >> (96 * 2);
            
            if (IUniswapV3Pool(yesPoolAddress).token0() == market.yesToken()) { // Assuming paymentToken is token1
                directYesPrice = priceFromPool;
            } else { // yesToken is token1, paymentToken is token0. Price needs inversion for yesToken/paymentToken.
                directYesPrice = priceFromPool > 0 ? (PRICE_PRECISION * PRICE_PRECISION) / priceFromPool : 0;
            }
            
            if (directYesPrice == 0 || directYesPrice > PRICE_PRECISION) {
                revert("Invalid YES price from pool");
            }
        } catch {
            revert("Failed to get YES price from pool");
        }

        // Get direct NO price
        try this.getSqrtPriceX96(noPoolAddress) returns (uint160 sqrtPriceX96_no) {
            if (sqrtPriceX96_no == 0) {
                revert("Zero sqrtPrice from NO pool");
            }
            
            uint256 priceFromPoolNo = (uint256(sqrtPriceX96_no) * uint256(sqrtPriceX96_no) * PRICE_PRECISION) >> (96 * 2);
            
            if (IUniswapV3Pool(noPoolAddress).token0() == market.noToken()) { // Assuming paymentToken is token1
                directNoPrice = priceFromPoolNo;
            } else { // noToken is token1, paymentToken is token0. Price needs inversion.
                directNoPrice = priceFromPoolNo > 0 ? (PRICE_PRECISION * PRICE_PRECISION) / priceFromPoolNo : 0;
            }
            
            if (directNoPrice == 0 || directNoPrice > PRICE_PRECISION) {
                revert("Invalid NO price from pool");
            }
        } catch {
            revert("Failed to get NO price from pool");
        }

        // Consistency Check: directYesPrice + directNoPrice approx PRICE_PRECISION
        uint256 sumPrice = directYesPrice + directNoPrice;
        uint256 deviation;
        if (sumPrice > PRICE_PRECISION) {
            deviation = sumPrice - PRICE_PRECISION;
        } else {
            deviation = PRICE_PRECISION - sumPrice;
        }
        uint256 allowedPoolDeviation = (PRICE_PRECISION * POOL_CONSISTENCY_TOLERANCE_BPS) / 10000;
        require(deviation <= allowedPoolDeviation, "Pool prices inconsistent");

        // Averaging logic:
        // 1. Direct YES price: directYesPrice
        // 2. Implied YES price from NO pool: PRICE_PRECISION - directNoPrice
        uint256 impliedYesPriceFromNo = PRICE_PRECISION - directNoPrice;
        avgYesPrice = (directYesPrice + impliedYesPriceFromNo) / 2;
        avgNoPrice = PRICE_PRECISION - avgYesPrice; // Ensure they sum up

        // Final sanity check on calculated average prices
        require(avgYesPrice > 0 && avgYesPrice < PRICE_PRECISION, "Avg YES price out of bounds"); // Usually not exactly 0 or 1
        require(avgNoPrice > 0 && avgNoPrice < PRICE_PRECISION, "Avg NO price out of bounds");   // Usually not exactly 0 or 1
    }
    
    /**
     * @notice Get the current average fair prices of YES and NO tokens from Uniswap V3 pools.
     * @param marketAddress Address of the TruthMarket contract.
     * @return yesPrice The average fair price of YES token (scaled to PRICE_PRECISION).
     * @return noPrice The average fair price of NO token (scaled to PRICE_PRECISION).
     */
    function getPoolPrices(address marketAddress) public view returns (uint256 yesPrice, uint256 noPrice) {
        return _getAverageFairPrices(marketAddress);
    }
    
    /**
     * @notice Helper to get sqrt price from Uniswap pool. Made public to enable try-catch by internal functions.
     * @param pool Address of the Uniswap V3 pool.
     * @return sqrtPriceX96 The current sqrt price in X96 format from the pool's slot0.
     */
    function getSqrtPriceX96(address pool) public view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
    }
    
    /**
     * @notice Calculate the fair amount for a counterparty based on token prices.
     * This function determines how much the second party (counterparty) should deposit
     * for their side of the bet, given the first party's deposit and the current fair prices.
     * @param firstPartyAmount The amount of payment tokens deposited by the first party.
     * @param firstPartyIsYes True if the first party took the YES position, false if NO.
     * @param yesTokenPrice The current fair price of YES tokens (scaled to PRICE_PRECISION).
     * @param noTokenPrice The current fair price of NO tokens (scaled to PRICE_PRECISION).
     * @return The amount of payment tokens the counterparty should deposit.
     */
    function calculateCounterpartyAmount(
        uint256 firstPartyAmount, 
        bool firstPartyIsYes, 
        uint256 yesTokenPrice, 
        uint256 noTokenPrice
    ) public pure returns (uint256) {
        require(yesTokenPrice > 0 && yesTokenPrice < PRICE_PRECISION, "Invalid YES price for calc");
        require(noTokenPrice > 0 && noTokenPrice < PRICE_PRECISION, "Invalid NO price for calc");
        
        if (firstPartyIsYes) {
            // First party has YES (amount_yes), counterparty needs NO.
            // The value of tokens should be equal: amount_yes * yesTokenPrice = amount_no * noTokenPrice
            // So, amount_no = (firstPartyAmount * yesTokenPrice) / noTokenPrice.
            return (firstPartyAmount * yesTokenPrice) / noTokenPrice;
        } else {
            // First party has NO (amount_no), counterparty needs YES.
            // amount_yes = (firstPartyAmount * noTokenPrice) / yesTokenPrice.
            return (firstPartyAmount * noTokenPrice) / yesTokenPrice;
        }
    }
    
    /**
     * @notice Get the current fair amount for a counterparty for an open (unaccepted) bet.
     * @param betId ID of the bet.
     * @return amount The calculated fair amount for the counterparty based on current market prices.
     */
    function getFairCounterpartyAmount(uint256 betId) external view returns (uint256 amount) {
        Bet storage bet = bets[betId];
        require(bet.marketAddress != address(0), "Bet does not exist");
        require(!bet.isExecuted && bet.acceptor == address(0), "Bet not open for acceptance");
        
        (uint256 currentYesPrice, uint256 currentNoPrice) = _getAverageFairPrices(bet.marketAddress);
        
        if (bet.initiatorTakesYesPosition) {
            return calculateCounterpartyAmount(bet.initiatorAmount, true, currentYesPrice, currentNoPrice);
        } else {
            return calculateCounterpartyAmount(bet.initiatorAmount, false, currentYesPrice, currentNoPrice);
        }
    }
    
    /**
     * @notice Cancel a pending mint request by the initiator.
     * @param betId ID of the bet to cancel.
     */
    function cancelBet(uint256 betId) external nonReentrant {
        Bet storage bet = bets[betId];
        require(bet.marketAddress != address(0), "Bet does not exist");
        require(msg.sender == bet.initiator, "Only initiator can cancel");
        require(bet.acceptor == address(0), "Cannot cancel an accepted bet");
        require(!bet.isExecuted, "Bet already executed or previously canceled");
        
        uint256 refundAmount = bet.initiatorAmount;
        
        bet.isExecuted = true; // Mark as "closed" (either executed or canceled)
        
        IERC20 paymentToken = IERC20(ITruthMarket(bet.marketAddress).paymentToken());
        paymentToken.safeTransfer(bet.initiator, refundAmount);
        
        emit BetCanceled(betId, bet.initiator, refundAmount);
    }
    
    /**
     * @notice Internal function to execute a bet by minting and distributing tokens.
     * @param betId ID of the bet to execute. This function assumes checks on the bet's state
     * (e.g., fully accepted, not already executed) have been performed by the caller.
     */
    function _executeBet(uint256 betId) internal {
        Bet storage bet = bets[betId]; 
        ITruthMarket market = ITruthMarket(bet.marketAddress);
        
        IERC20 paymentToken = IERC20(market.paymentToken());
        IERC20Metadata paymentTokenMetadata = IERC20Metadata(market.paymentToken());
        uint256 paymentTokenDecimals = paymentTokenMetadata.decimals();

        IERC20 yesTokenContract = IERC20(market.yesToken());
        IERC20 noTokenContract = IERC20(market.noToken());
        
        // Fetch decimals for one of the Yes/No tokens.
        // TruthMarket.sol's _tokenDecimals implies they share the same decimal count.
        uint256 yesNoTokenDecimals = IERC20Metadata(market.yesToken()).decimals(); 

        uint256 totalPaymentAmount = bet.initiatorAmount + bet.acceptorAmount;
        
        // Approve TruthMarket to spend the payment tokens held by this BetTogether contract.
        paymentToken.approve(bet.marketAddress, totalPaymentAmount);
        
        // Call TruthMarket.mint(). It expects total paymentTokenAmount.
        // It mints an equal quantity of YES and NO tokens to msg.sender (this contract).
        // The quantity of each token type minted is:
        // paymentTokenAmount * (10 ** yesNoTokenDecimals) / (10 ** paymentTokenDecimals)
        market.mint(totalPaymentAmount); 
        
        uint256 totalTokensMintedPerType = totalPaymentAmount * (10**yesNoTokenDecimals) / (10**paymentTokenDecimals);
        require(totalTokensMintedPerType > 0, "Minted zero tokens");

        if (bet.initiatorTakesYesPosition) {
            yesTokenContract.safeTransfer(bet.initiator, totalTokensMintedPerType);
            noTokenContract.safeTransfer(bet.acceptor, totalTokensMintedPerType);
        } else {
            noTokenContract.safeTransfer(bet.initiator, totalTokensMintedPerType);
            yesTokenContract.safeTransfer(bet.acceptor, totalTokensMintedPerType);
        }
        
        bet.isExecuted = true; // Mark bet as completed
        emit BetExecuted(betId, totalTokensMintedPerType);
    }
    
    /**
     * @notice Get details of a bet.
     * @param betId ID of the bet.
     * @return marketAddress Address of the market associated with the bet.
     * @return initiator Address of the user who created the bet.
     * @return initiatorTakesYesPosition True if initiator took YES, false for NO.
     * @return initiatorAmount The amount staked by the initiator.
     * @return acceptor Address of the user who accepted the bet (address(0) if not accepted).
     * @return acceptorAmount The amount staked by the acceptor (0 if not accepted).
     * @return priceToleranceBps Initiator's price tolerance in basis points.
     * @return initialPriceForInitiator Fair price for initiator's side at creation.
     * @return isExecuted True if the bet has been executed or canceled.
     * @return createdAt Timestamp when the bet was created.
     */
    function getBet(uint256 betId) external view returns (
        address marketAddress,
        address initiator,
        bool initiatorTakesYesPosition,
        uint256 initiatorAmount,
        address acceptor,
        uint256 acceptorAmount,
        uint256 priceToleranceBps,
        uint256 initialPriceForInitiator,
        bool isExecuted,
        uint256 createdAt
    ) {
        Bet storage bet = bets[betId];
        return (
            bet.marketAddress,
            bet.initiator,
            bet.initiatorTakesYesPosition,
            bet.initiatorAmount,
            bet.acceptor,
            bet.acceptorAmount,
            bet.priceToleranceBps,
            bet.initialPriceForInitiator,
            bet.isExecuted,
            bet.createdAt
        );
    }

    /**
     * @notice Sets the pool consistency tolerance in basis points.
     * @param _bps New tolerance value in basis points (1 BPS = 0.01%)
     */
    function setPoolConsistencyTolerance(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= 1000, "Invalid BPS value"); // Max 10% tolerance
        uint256 oldValue = POOL_CONSISTENCY_TOLERANCE_BPS;
        POOL_CONSISTENCY_TOLERANCE_BPS = _bps;
        emit PoolConsistencyToleranceUpdated(oldValue, _bps);
    }
} 
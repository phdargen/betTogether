require('dotenv').config({ path: '.env' });
require("@nomicfoundation/hardhat-verify");
import '@nomicfoundation/hardhat-toolbox-viem';

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

/**
 * @type import('hardhat/config').HardhatUserConfig
 */

const DEFAULT_MNEMONIC = "";
const DEFAULT_RPC_URL = ""; 

module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  
  networks: {
      hardhat: {
        forking: {
          url: process.env.RPC_URL_BASE || DEFAULT_RPC_URL,
          blockNumber: 30064146,
        },
        chainId: 8453,
        accounts: { mnemonic: process.env.MNEMONIC || DEFAULT_MNEMONIC }
      },
      base: {
        url: process.env.RPC_URL_BASE || DEFAULT_RPC_URL,
        accounts: { mnemonic: process.env.MNEMONIC || DEFAULT_MNEMONIC },
      },
      baseSepolia: {
        url: process.env.RPC_URL_BASE_SEPOLIA || DEFAULT_RPC_URL,
        accounts: { mnemonic: process.env.MNEMONIC || DEFAULT_MNEMONIC },
      },
  },

  etherscan: {
    apiKey: {
      base: process.env.BASE_SCAN_API_KEY || "", 
      baseSepolia: process.env.BASE_SCAN_API_KEY || "", 
    },
  },

};


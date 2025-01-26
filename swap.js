const { PublicKey } = require('@solana/web3.js');
const { fetchMultipleInfo, PoolFetchType } = require('@raydium-io/raydium-sdk-v2');
const { BN } = require("@project-serum/anchor");
const { initRaydium, isValidAmm, txVersion } = require("./raydium-utils");
const config = require("./configurations/config.json");

// RaydiumV4 swap other dexs: jup, orca, meteora can be added
async function swapRaydium(connection, tradeParams, from ) {

    const { tokenIn, tokenOut, tradeVol } = tradeParams;

    let slippage = new BN(Math.ceil(config.slippage));

    let inputToken = new PublicKey(tokenIn);
    let outputToken = new PublicKey(tokenOut);

    let keypair = new PublicKey(from);
    
    // Create Raydium provider
    const raydium = await initRaydium({
      owner: keypair
    });

    // Initialize the Program RaydiumV4
    const programId = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

    // Set the slippage
    slippage = Number(slippage / 10000);

    try {

      let poolId = await raydium.api.fetchPoolByMints({
        mint1: inputToken.toBase58(),
        mint2: outputToken.toBase58(),
        type: PoolFetchType.Standard,
        sort: 'liquidity',
        order: 'desc',
        page: 1,
      });

      if (poolId.data.length === 0)
        return;

      poolId = poolId.data[0].id;

      const data = (await raydium.api.fetchPoolById({ ids: poolId }));
      const poolInfo = data[0];

      if (!isValidAmm(poolInfo.programId))
        return;

      const poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);

      const res = await fetchMultipleInfo({
        connection: raydium.connection,
        poolKeysList: [poolKeys],
        config: undefined,
      });
      const pool = res[0];

      await raydium.liquidity.initLayout();
      const out = raydium.liquidity.computeAmountOut({
        poolInfo: {
          ...poolInfo,
          baseReserve: pool.baseReserve,
          quoteReserve: pool.quoteReserve,
          status: pool.status.toNumber(),
          version: 4,
        },
        amountIn: new BN(tradeVol),
        mintIn: tokenIn,
        mintOut: tokenOut,
        slippage, // range: 1 ~ 0.0001, 100% ~ 0.01%
      });

      const tx = await raydium.liquidity.swap({
        poolInfo,
        amountIn: new BN(tradeVol),
        amountOut: out.minAmountOut,
        fixedSide: 'in',
        inputMint: tokenIn,
        associatedOnly: false,
        txVersion,
        computeBudgetConfig: {
          units: 600000,
          microLamports: 100000000,
        },
      });

      const mainTx = tx.transaction;
        // If you need to sign it offline
        //   const { blockhash } = await connection.getLatestBlockhash('finalized');
        //   mainTx.recentBlockhash = blockhash;
        //   mainTx.feePayer = keypair;

        //   const transactionBuffer = mainTx.serialize({
        //     requireAllSignatures: false,
        //     verifySignatures: false
        //   });

      // Return the transaction
      return { swapOutAmount: out.minAmountOut, txBuffer: mainTx};
    } catch (error) {
        console.log(error);
        throw error;
    }
};

module.exports = {
    swapRaydium
}
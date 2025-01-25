const { PublicKey } = require("@solana/web3.js");
const redis = require('./redis');

class logProcessor {

    async getTradeParamsWSS(connection, accountAddress, slot) {
        try {
            // We can't directly stream txns using raw websockets so fething txs when activity happens on the said account
            const sigConf = {};
            const lastSig = await redis.get(`sig-${accountAddress}`);
            if (lastSig)
                sigConf.until = lastSig;
            // else
            sigConf.limit = 25;
            const txs = await connection.getSignaturesForAddress(new PublicKey(accountAddress), sigConf, 'confirmed');
            let tradetx = [{sig: "d"}];
            if (!txs)
                return "0";
            if (txs.length && txs[0]?.signature) {
                await redis.set(`sig-${accountAddress}`, txs[0]?.signature);
                // console.log(`Redis key set...`, txs[0]?.signature, txs.length);
            };
            for (const tx of txs) {
                if (tx.slot === slot) {
                    tradetx.push(tx);
                }
                if (tx.slot < slot)
                    break;
            }

            let tradeVol = 0;
            let tradeParams = [];

            await Promise.all(tradetx.map(async (ele) => {
                try {
                    ele.data = (await connection.getParsedTransaction(ele.signature, { maxSupportedTransactionVersion: 0 })).meta;

                    // This can be used instead of loops
                    // const tokenIn = ele.data.preTokenBalances[0].mint;
                    // const tokenOut = ele.data.preTokenBalances[1].mint;
                    // let tradeVol = ele.data.preTokenBalances[0].uiTokenAmount.amount - ele.data.postTokenBalances[0].uiTokenAmount.amount;
                    
                    // copying only those trades that are signed by the address, here we are strictly checking for txns signed by the address, if any tx touching the address is needed use grpc impl
                    // Using this for some edge cases
                    let tokenIn;
                    let initalBal = 0;
                    let postBal = 0;
                    let tokenOut;
                    for (const item of ele.data.preTokenBalances) {
                        if (!tokenIn && item.owner === accountAddress) {
                            tokenIn = item.mint;
                            initalBal = item.uiTokenAmount.amount;
                            // console.log("pre balance is: ", initalBal);
                            break;
                        }
                    };
                    for (const item of ele.data.preTokenBalances) {
                        if (!tokenOut && tokenIn !== item.mint && item.owner === accountAddress) {
                            tokenOut = item.mint;
                            // console.log("pre balance is: ", initalBal);
                            break;
                        }
                    };

                    for (const item of ele.data.postTokenBalances) {
                        if (item.mint === tokenIn && item.owner === accountAddress) {
                            postBal = item.uiTokenAmount.amount;
                            // console.log("post balance is: ", postBal);
                            break;
                        }
                    };
                    tradeVol = Math.abs(postBal - initalBal);

                    tradeParams.push({
                        tokenIn, tokenOut, tradeVol, accountAddress, sig:  ele.signature
                    });
                } catch (error) {
                    // console.error(`Error fetching transaction for signature ${ele.signature}:`, error.response.data);
                    ele.data = null;
                }
            }));

            return tradeParams;
        } catch (error) {
            // console.log(error.data);
            throw error;
        };
    };

    async getTradeParamsGRPC(transactionData, accountAddress) {
        try {
                // No need for txs fethcing as streaming tx data directly
                // const tokenIn = transactionData.meta.preTokenBalances[0].mint;
                // const tokenOut = transactionData.meta.preTokenBalances[1].mint;
                // let tradeVol = transactionData.meta.postTokenBalances[0].uiTokenAmount.amount - ele.data.preTokenBalances[0].uiTokenAmount.amount;

                let tokenIn;
                let initalBal = 0;
                let postBal = 0;
                let tokenOut;
                let tradeVol = 0;
                // First mint is usually tokenA
                for (const item of transactionData.transaction.meta.preTokenBalances) {
                    if (!tokenIn) {
                        tokenIn = item.mint;
                        initalBal = item.uiTokenAmount.amount;
                        // console.log("pre balance is: ", initalBal);
                        break;
                    }
                };
                for (const item of transactionData.transaction.meta.preTokenBalances) {
                    if (!tokenOut && tokenIn !== item.mint) {
                        tokenOut = item.mint;
                        // console.log("pre balance is: ", initalBal);
                        break;
                    }
                };

                for (const item of transactionData.transaction.meta.postTokenBalances) {
                    if (item.mint === tokenIn) {
                        postBal = item.uiTokenAmount.amount;
                        // console.log("post balance is: ", postBal);
                        break;
                    }
                };
                tradeVol = Math.abs(postBal - initalBal);
                return {
                    tokenIn, tokenOut, tradeVol, accountAddress
                }; 
        } catch (error) {
            // console.log(error.data);
            throw error;
        };
    };

    async processEventWss(connection, accountAddress, slot){
        return this.getTradeParamsWSS(connection, accountAddress, slot);
    };

    async processEventGRPC(transactionData){
        try {
            const accountAddress = transactionData.transaction.transaction.message.accountKeys[0];
            return this.getTradeParamsGRPC(transactionData, accountAddress);
        } catch(error){
            return;
        }
    };
};

module.exports = {
    logProcessor
};
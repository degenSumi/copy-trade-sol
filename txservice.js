// * Transaction landing service for higher land rates during very high network congestions.
const { web3 } = require("@project-serum/anchor");
const promiseRetry = require("promise-retry");
const { decode } = require('bs58');
const { swapRaydium } = require("./swap");
const dotenv = require('dotenv');
dotenv.config();

// Use a staked connection to increase the odds.
const solrpc = process.env.solanarpc; // Updated with a staked connection here
// const solwss = process.env.solanawss;
// const solprivatekey = process.env.solanaprivatekey;

// const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decode(solprivatekey)));

const connection = new web3.Connection(solrpc, 'confirmed');


async function landTx(transaction) {
  
    const blockhashWithExpiryBlockHeight = await connection.getLatestBlockhash();

    try {

        // Serialize the transaction
        const serializedTransaction = transaction.serialize();

        // console.log(Buffer.from(serializedTransaction,"base64").toString("base64"));

        const sendOptions = {
            skipPreflight: true,
            maxRetries: 5,
            preflightCommitment: 'confirmed',
        }

        const signature = await connection.sendRawTransaction(
            serializedTransaction,
            sendOptions
        );
        
        const controller = new AbortController();
        const abortSignal = controller.signal;

        const abortableResender = async () => {
            while (true) {
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                
                if (abortSignal.aborted) return;

                try {
                    await connection.sendRawTransaction(
                        serializedTransaction,
                        sendOptions
                    );
                }
                catch (e) {
                    console.warn(`Failed to resend transaction: ${e}`);
                }
            }
        };

        try {
            abortableResender();
            const lastValidBlockHeight = blockhashWithExpiryBlockHeight.lastValidBlockHeight + 50;
        
            // this would throw TransactionExpiredBlockheightExceededError
            await Promise.race([
                connection.confirmTransaction(
                    {
                        ...blockhashWithExpiryBlockHeight,
                        lastValidBlockHeight,
                        signature: signature,
                        abortSignal,
                    },
                    "confirmed"
                ),
                new Promise(async (resolve) => {
                // in case ws socket died
                while (!abortSignal.aborted) {
                    await new Promise((resolve) => setTimeout(resolve, 2_000));

                    const tx = await connection.getSignatureStatus(signature, {
                        searchTransactionHistory: false,
                    });

                    if (tx?.value?.confirmationStatus === "confirmed") {
                        resolve(tx);
                    }
                }
                }),
            ]);
        }
        catch (e) {
            if (e) {
                console.log(e);
                return null;
            }
            else {
                throw e;
            }
        }
        finally {
            controller.abort();
        }

        const response = promiseRetry(
            async (retry) => {
                const response = await connection.getTransaction(signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                });

                if (!response) {
                    retry(response);
                    }
                    return response;
                },
                {
                    retries: 5,
                    minTimeout: 1e3,
                }
            );

        console.log('Response: ',await  response);

        return true;
        } catch(error){
            console.log(error);
        }
};

module.exports = {
    landTx
};

// swapRaydium(connection, { tokenIn: "So11111111111111111111111111111111111111112", tokenOut: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", tradeVol: "10000"}, keypair.publicKey).then(
//     async(tx) => {
//         console.log(tx);
//         tx.txBuffer.sign([keypair]);
//         const simulationResult = await connection.simulateTransaction(tx.txBuffer, {sigVerify: false});
//         console.log(simulationResult);
//         if(!simulationResult?.value?.err)
//             await landTx(tx.txBuffer).then(console.log);
//     }
// );


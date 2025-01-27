// * Transaction landing service for the best landing rates even during very high network congestions.
// * Trade compute optimizations for the best landing rates
const { web3 } = require("@project-serum/anchor");
const { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = require('@solana/web3.js');
const promiseRetry = require("promise-retry");
const { decode } = require('bs58');
const { swapRaydium } = require("./swap");
const dotenv = require('dotenv');
dotenv.config();

// Use a staked connection to increase the odds.
const solrpc = process.env.solanarpc; // Update with a staked connection here

const connection = new web3.Connection(solrpc, 'confirmed');

async function sendOptimizedTransaction(transaction, allInstructions, keypair) {
  
    const blockhashWithExpiryBlockHeight = await connection.getLatestBlockhash();

    try {

        const txSimulation = await connection.simulateTransaction(transaction, { sigVerify: false });
        
        const unitsConsumed = txSimulation.value.unitsConsumed;

        const computeUnitIx = ComputeBudgetProgram.setComputeUnitLimit({
            units: Math.ceil(unitsConsumed * 2)
        });

        // const decompile = TransactionMessage.decompile(transaction.message).instructions; // Not working with raydium weird so using raw instructions now

        const instructions = [];
        
        instructions.push(computeUnitIx);

        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 30000, // Set the priority fee, can be made dynamic as well doing later on
        });
        
        instructions.push(computeBudgetIx);

        instructions.push(allInstructions);

        const computeMessage = new TransactionMessage({
            payerKey: keypair.publicKey,
            recentBlockhash: blockhashWithExpiryBlockHeight.blockhash,
            instructions: instructions.flat()
        }).compileToV0Message();

        // Rebuilding the tx with compute optimizations and priority fee
        transaction = new VersionedTransaction(computeMessage);

        transaction.sign([keypair]);

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
            const lastValidBlockHeight = blockhashWithExpiryBlockHeight.lastValidBlockHeight;
        
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
    sendOptimizedTransaction
};

// For testing
// const solprivatekey = process.env.solanaprivatekey;
// const keypair = web3.Keypair.fromSecretKey(new Uint8Array(decode(solprivatekey)));
// swapRaydium(connection, { tokenIn: "So11111111111111111111111111111111111111112", tokenOut: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", tradeVol: "1000"},keypair.publicKey).then(
//     async(tx) => {
//         // console.log(tx);
//         tx.txBuffer.sign([keypair]);
//         await sendOptimizedTransaction(tx.txBuffer, tx.allInstructions, keypair).then(console.log);
//         process.exit();
//     }
// );

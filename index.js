const { grpcListener, wssListener } = require("./listeners");
const { swapRaydium } = require("./swap.js");
const { decode } = require('bs58');
const { Keypair, Connection } = require('@solana/web3.js');
const { sendOptimizedTransaction } = require("./txservice");
const solConfig = require("./configurations/config.json");
const cluster = require('cluster');
const os = require('os');
const chalk = require("chalk");
const { axiosFetchWithRetries } = require("./fetch.js");
const dotenv = require('dotenv');
dotenv.config();

const solrpc = process.env.solanarpc;
const solwss = process.env.solanawss;
const solgrpc = process.env.solanagrpc || "https://solana-yellowstone-grpc.publicnode.com:443"; // Free grpc endpoint
const grpctoken = process.env.grpctoken;
const solprivatekey = process.env.solanaprivatekey;

const keypair = Keypair.fromSecretKey(new Uint8Array(decode(solprivatekey)));

const RETRY_ATTEMPTS = 3;
const addresses = solConfig.addresses;
const workerPools = new Map(); // Map to store workerId -> addresses

async function createGRPCListener(connection, addresses, workerId) {
    
    let listener = new grpcListener(connection, workerId, solgrpc, grpctoken);

    listener.listenAccountsGRPC(addresses);

    listener.on("tradeparams", async (data) => {
        try {
            const { tokenIn, tokenOut, tradeVol, accountAddress } = data;
            if (tokenIn && tokenOut && tradeVol) {
                // Output is in the smallest values (decimals)
                console.log(chalk.green(`🚀 Trade coming in! 
                    - tokenIn: **${tokenIn}**
                    - tokenOut: **${tokenOut}**
                    - Trade Amount: **${tradeVol}**`));
                const transaction = await swapRaydium(connection, data, keypair.publicKey);
                if (!transaction)
                    return
                console.log(chalk.red(`🚀 Copy Trade Prepared!`));
                console.log({swapOutAmount: transaction.swapOutAmount, txBuffer: transaction.txBuffer});
                // Transaction simulation
                const txSimulation = await connection.simulateTransaction(transaction.txBuffer, { sigVerify: false });
                console.log(chalk.green(`🚀 Trade simulated:`), txSimulation);
                // Now we can execute this trade just uncomment these
                // Use txservice to send transactions optimally even during high network congestion
                if(!txSimulation.value.err) await sendOptimizedTransaction(transaction.txBuffer, transaction.allInstructions, keypair);
                // Or Simply send the transaction 
                // transaction.txBuffer.sign([keypair]);
                // await connection.sendTransaction(transaction.txBuffer);
            }
        } catch (error) {
            console.log(error);
        }
    });
};

async function createWssListener(connection, addresses, workerId) {
    if (!connection) {
        connection = new Connection(
            solrpc,
            {
                commitment: "confirmed",
                wsEndpoint: solwss,
                disableRetryOnRateLimit: false,
                async fetch(input, init) {
                    return await axiosFetchWithRetries(input, init, RETRY_ATTEMPTS);
                },
            }
        );
    }
    let listener = new wssListener(connection, workerId, solgrpc);

    let subsId = await Promise.all(addresses.map(async (address) => {
        const id = await listener.listenAccount(address);
        return id;
    }));

    console.log(subsId);

    listener.on("tradeparams", async (data) => {
        data.map(async (params) => {
            try {
                const { tokenIn, tokenOut, tradeVol, accountAddress } = params;
                if (tokenIn && tokenOut && tradeVol) {
                    // Output is in the smallest values (decimals)
                    console.log(chalk.green(`🚀 Trade coming in! 
                    - tokenIn: **${tokenIn}**
                    - tokenOut: **${tokenOut}**
                    - Trade Amount: **${tradeVol} 
                    - Signature: ${params.sig}
                    - Address ${accountAddress}**`));
                    const transaction = await swapRaydium(connection, params, keypair.publicKey);
                    if (!transaction)
                        return
                    console.log(chalk.red(`🚀 Copy Trade Prepared!`));
                    console.log({swapOutAmount: transaction.swapOutAmount, txBuffer: transaction.txBuffer});
                    // Transaction simulation
                    const txSimulation = await connection.simulateTransaction(transaction.txBuffer, { sigVerify: false });
                    console.log("swap trade simulation...:", txSimulation);
                   // Now we can execute this trade just uncomment these
                   // Use txservice to send transactions optimally even during high network congestion
                   if(!txSimulation.value.err) await sendOptimizedTransaction(transaction.txBuffer, transaction.allInstructions, keypair);
                   // Or Simply send the transaction 
                   // transaction.txBuffer.sign([keypair]);
                   // await connection.sendTransaction(transaction.txBuffer);
                }
            } catch (error) {
                console.log(error);
            }
        });
    });

    listener.on("brokenpipe", async (data) => {
        console.error("restarting connection at: ", workerId, data);
        setTimeout(async () => {
            connection = null;
            await listener.destroy();
            listener = null;
            listener = await createWssListener(connection, addresses, workerId);
            console.error("connection restarted at: ", workerId, listener.id);
        }, 1000);
    });

    connection._rpcWebSocket.on("close", (data) => {
        console.log("websocket connection got closed", "at workerId", workerId);
    });

    connection._rpcWebSocket.on("open", (data) => {
        console.log("new websocket connection established", "at workerId", workerId)
    });

    return listener;
};

// Multi threaded execution with reliability guarantees
function forkCPU(assignedAddresses) {
    let newWorker = cluster.fork();

    workerPools.set(newWorker.id, assignedAddresses);
    // Send each worker its assigned addresses
    newWorker.send({ addresses: assignedAddresses, workerId: newWorker.id });

    newWorker.on('exit', (code, signal) => {
        console.error(`Worker ${newWorker.process.pid} exited with code ${code} and signal ${signal}`);
        // Restart the worker with the same addresses
        const assignedAddresses = workerPools.get(newWorker.id);
        forkCPU(assignedAddresses);
        console.error(`Worker ${newWorker.process.pid} restarted`);
    });
};

const startBot = async () => {
    try {
        // Using 2 threads for 10 accounts, for more accounts this line can be uncommented for better allocation
        const numCPUs = 2; // Math.min(os.cpus().length - 2, addresses.length); // Limit to available account or CPU cores

        if (cluster.isMaster) {
            console.log(`Master process ${process.pid} is running`);

            // Fork workers, each handling specific pools
            for (let i = 0; i < numCPUs; i++) {
                const assignedAddresses = addresses.slice(i * Math.ceil(addresses.length / numCPUs), (i + 1) * Math.ceil(addresses.length / numCPUs));
                forkCPU(assignedAddresses);
            }

            cluster.on('message', (worker, message) => {
                if (message.error) {
                    console.error(`Error from worker ${worker.process.pid}:`, message.error);
                }
                if (message.log) {
                    console.log(`Log from worker ${worker.process.pid}:`, message.log);
                }
            });

        } else {
            // Code for each worker
            process.on('message', async ({ addresses, workerId }) => {
                console.log(`Worker ${process.pid} listening to accounts`, addresses);

                try {

                    let connection = new Connection(
                        solrpc,
                        {
                            commitment: "confirmed",
                            wsEndpoint: solwss,
                            disableRetryOnRateLimit: false,
                            async fetch(input, init) {
                                return await axiosFetchWithRetries(input, init, RETRY_ATTEMPTS);
                            }
                        }
                    );

                    // both wss/grpc listeners can be used
                    // grpc listener is developed and tested with a free and probably only free grpc service 
                    // `all that node`, not thoroghly tested for reliablity, however websockets are

                    const listener = await createGRPCListener(connection, addresses, workerId);
                    // const listener = await createWssListener(connection, addresses, workerId);
                    
                    // Or use raw websockets just toggle between above lines

                } catch (error) {
                    console.log(error);
                    process.send({ error: `Worker ${workerId} failed: ${error.message}` });
                }
            });
        }
    } catch (error) {
        console.error(`Failed to listen:`, error);
    }
};

startBot().catch(console.error);

const { grpcListener, wssListener } = require("./listeners");
const { swapRaydium } = require("./swap.js");
const { decode } = require('bs58');
const { Keypair, Connection } = require('@solana/web3.js');
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
const solprivatekey = process.env.solanaprivatekey;

const keypair = Keypair.fromSecretKey(new Uint8Array(decode(solprivatekey)));

const RETRY_ATTEMPTS = 3;
const addresses = solConfig.addresses;
const workerPools = new Map(); // Map to store workerId -> addresses

async function createGRPCListener(connection, addresses, workerId, GRPC_URL) {
    
    let listener = new grpcListener(connection, workerId, solgrpc);

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
                console.log(transaction);
                // Transaction simulation
                const tx = await connection.simulateTransaction(transaction.txBuffer, { sigVerify: false });
                console.log("swap trade simulation...:", tx);
                // Now we can execute this trade just uncomment these
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
                // confirmTransactionInitialTimeout: 100000,
                async fetch(input, init) {
                    return await axiosFetchWithRetries(input, init, RETRY_ATTEMPTS);
                },
            }
        );
    }
    let listener = new wssListener(connection, workerId, solgrpc);

    let subsId = [];
    subsId = await Promise.all(addresses.map(async (address) => {
        const id = await listener.listenAccount(address);
        return id;
    }));

    console.log(subsId);

    // connection._rpcWebSocket.on("error", (error)=> {
    //   console.log("websocket got an error", error, "at workerId", workerId)
    // });

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
                    console.log(transaction);
                    // Transaction simulation
                    const tx = await connection.simulateTransaction(transaction.txBuffer, { sigVerify: false });
                    console.log("swap trade simulation...:", tx);
                    // Now we can execute this trade just uncomment these // Just for simulation for production use a lot of optimizations will be done for higher landing rate
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
    // Log worker events
    newWorker.on('exit', (code, signal) => {
        console.error(`Worker ${newWorker.process.pid} exited with code ${code} and signal ${signal}`);
        // Restart the worker with the same addresses
        const assignedAddresses = workerPools.get(newWorker.id);
        forkCPU(assignedAddresses);
        console.error(`Worker ${newWorker.process.pid} restarted`);
        // newWorker = cluster.fork();
        // workerPools.set(newWorker.id, assignedAddresses);
        // newWorker.send({ pools: assignedAddresses, workerId });
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

                // let worker = cluster.fork();
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
                            // confirmTransactionInitialTimeout: 100000,
                            async fetch(input, init) {
                                return await axiosFetchWithRetries(input, init, RETRY_ATTEMPTS);
                            }
                        }
                    );

                    // account listeners can be created for both websockets as well as grpc
                    // if grpc access is available than grpc can be used, however this is developed with access to a free and probably only free grpc service `all that node`, so not thoroghly tested for reliablity

                    const listener = await createGRPCListener(connection, addresses, workerId, solgrpc);
                    // const listener = await createWssListener(connection, addresses, workerId);
                    
                    // Or use raw websockets just toggle between above lines

                    // Depreceated for now, could be a fallback to ^subscriptionHealth
                    // listener.monitorSubscriptions();

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

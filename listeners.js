// GRPC and WSS listener classes 

const Client = require("@triton-one/yellowstone-grpc").default;
const { CommitmentLevel } =  require("@triton-one/yellowstone-grpc");
const bs58 = require('bs58');
const { PublicKey } = require('@solana/web3.js');
const { EventEmitter } = require('events');
const { logProcessor } = require("./processor.js");
const redis = require('./redis');

class wssListener extends EventEmitter {
    connection;
    logProcessor = new logProcessor();
    prevSlot = 0;
    checkSlot = -1;
    workerId;
    id;
    subInterval;
    constructor(connection, workerId, grpc) {
        super();
        this.connection = connection;
        this.workerId = workerId;
        this.id = new Date();
        this.connection.onSlotChange((slot)=>{
            // console.log(slot.slot , this.workerId, this.id);
            this.prevSlot = slot.slot;
        });
        // Listener.subInterval = subscriptionHealth();
        this.subscriptionHealth();
    };
    // Listen to the statechanges
    async listenAccount(accountAddress) {
        return this.connection.onAccountChange(
            new PublicKey(accountAddress),
            async (updatedAccountInfo, slot) => {
                try {
                    // ignoring other state changes on the same slot as we process all changes with one event.
                    if((await redis.get(`${accountAddress}:${slot.slot}`))){
                        // console.log("returing form here");
                        return;
                    }
                    await redis.set(`${accountAddress}:${slot.slot}`, "true");
                    redis.expire(`${accountAddress}:${slot.slot}`,30);
                    const processedEntry = await this.logProcessor.processEventWss(this.connection, accountAddress, slot.slot).catch((error => { 
                        throw error;
                    }));
                    // console.log(processedEntry);
                    this.emit('tradeparams', processedEntry);
                } catch (error) {
                    console.log(error);
                }
            },
            {
                commitment: this.connection.commitment
            }
        )
    };
    async subscriptionHealth() {
        this.subInterval = setInterval( async ()=>{
            // console.log("intevral running.. ", this.workerId, this.id, this.prevSlot);
            if( this.prevSlot === this.checkSlot){
                console.error("pipe is broken for worker: ", this.workerId, this.id);
                // this.connection?._rpcWebSocket?.close();
                this.emit("brokenpipe", this.id);
                // clearInterval(this.subInterval);
            };
            this.checkSlot = this.prevSlot;
            redis.set(`slot-${this.workerId}`, this.prevSlot);
        }, 45000);
        // return subInterval;
    };
    async destroy() {
        try{
            if (this.subInterval) {
                clearInterval(this.subInterval);
                this.subInterval = null;
                console.error("Cleaned up interval for worker:", this.workerId, this.id);
            }
            this.removeAllListeners();
            console.error("Cleaned up resources for worker:", this.workerId, this.id);
            // this.connection._rpcWebSocket.shouldReconnect = false;
            // if (this.connection._rpcWebSocket.reconnectTimeout) {
            //     clearTimeout(this.connection._rpcWebSocket.reconnectTimeout);
            // }
            this.connection._rpcWebSocket.close();
            this.connection = null;
        } catch(error){
            console.error(error);
        }
    };
};

class grpcListener extends EventEmitter {
    logProcessor = new logProcessor();
    GRPC_URL = "https://solana-yellowstone-grpc.publicnode.com:443";
    PING_INTERVAL_MS = 30000;
    workerId;
    id;
    subInterval;
    constructor(connection, workerId, grpc) {
        super();
        this.workerId = workerId;
        this.id = new Date();
        if(grpc)
            this.GRPC_URL = grpc;
    };
    // Function to send a subscribe request
    sendSubscription = async (stream, accountAddresses) => {
        const request = {
            commitment: CommitmentLevel.CONFIRMED,
            accountsDataSlice: [],
            transactions: {
                client: {
                    vote: false,
                    failed: false,
                    accountInclude: accountAddresses,
                    accountExclude: [],
                    accountRequired: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
                },
            },
            accounts: {},
            slots: {},
            transactionsStatus: {},
            entry: {},
            blocks: {},
            blocksMeta: {},
        };

        await new Promise((resolve, reject) => {
            stream.write(request, (err) => {
                if (!err) {
                    console.log("Successfully sent subscription request.");
                    resolve();
                } else {
                    console.error("Error sending subscription request:", err);
                    reject(err);
                }
            });
        });
    };
    async listenAccountsGRPC(accountAddresses) {
        try {
            const client = new Client(this.GRPC_URL, "X_TOKEN", {
                "grpc.max_receive_message_length": 1024 * 1024 * 1024, // 64MiB
            });

            const stream = await client.subscribe();
            let pingInterval, resubscribeInterval;

            const streamClosed = new Promise((resolve, reject) => {
                stream.on("error", (error) => {
                    console.error("Stream error:", error);
                    clearInterval(pingInterval);
                    // clearInterval(resubscribeInterval);
                    stream.end();
                    reject(error);
                });
                stream.on("end", () => {
                    console.log("Stream ended.");
                    clearInterval(pingInterval);
                    // clearInterval(resubscribeInterval);
                    resolve();
                });
                stream.on("close", () => {
                    console.log("Stream closed.");
                    clearInterval(pingInterval);
                    // clearInterval(resubscribeInterval);
                    resolve();
                });
            });

            // Handle incoming data
            stream.on("data", async (data) => {
                try {
                    const ts = new Date();
                    if (data.transaction) {
                        const tx = data.transaction;
                        const convertedTx = this.convertBuffers(tx);
                        const tradeParams = await this.logProcessor.processEventGRPC(convertedTx);
                        this.emit("tradeparams", tradeParams);
                    } else if(data.filters.length === 0){
                        // It was developed using AllThatNode's free gRPC, which behaves weirdly and stops sending messages after 1 minute,
                        // despite the connection being okay. To handle this, a resubscription routine is written.
                        // However, this might break if the gRPC is reliable (maxing out max subscriptions),
                        // so please test by commenting these lines if you have reliable gRPC connections or try toggling it.
                        console.log("Resubscribing to the stream...",ts.toUTCString());
                        await this.sendSubscription(stream, accountAddresses);
                    } else {
                        console.log(`${ts.toUTCString()}: Received update: ${JSON.stringify(data)}`);
                    }
                } catch (err) {
                    console.error("Error processing data:", err);
                }
            });

            // Initial subscription request
            await this.sendSubscription(stream, accountAddresses);

            // Send periodic pings to keep the stream alive
            const pingRequest = {
                accounts: {},
                accountsDataSlice: [],
                transactions: {},
                blocks: {},
                blocksMeta: {},
                slots: {},
                transactionsStatus: {},
                entry: {},
            };

            pingInterval = setInterval(() => {
                if (stream.writable) {
                    stream.write(pingRequest, (err) => {
                        if (err) console.error("Error sending ping:", err);
                    });
                }
            }, this.PING_INTERVAL_MS);

            // Resubscribe periodically to refresh the subscription
            // resubscribeInterval = setInterval(async () => {
            //     console.log("Resubscribing to the stream...");
            //     await this.sendSubscription(stream, accountAddresses);
            // }, this.RESUBSCRIBE_INTERVAL_MS || 60000); // Resubscribe every 60 seconds

            // Wait for the stream to close
            await streamClosed;
        } catch (error) {
            console.error("Error while listening, reconnecting...", error);
            this.listenAccountsGRPC(accountAddresses);
        }
    }
    // utility function to process the transaction object
    convertBuffers(obj) {
        if (obj === null || obj === undefined) {
            return obj;
        }
        // Handle Buffer objects
        if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return bs58.encode(new Uint8Array(obj.data));
        }

        // Handle arrays
        if (Array.isArray(obj)) {
        return obj.map(item => this.convertBuffers(item));
        }
    
        // Handle objects
        if (typeof obj === 'object') {
            // Handle Uint8Array directly
            if (obj instanceof Uint8Array) {
            return bs58.encode(obj);
        }
  
        const converted = {};
        for (const [key, value] of Object.entries(obj)) {
            // Skip certain keys that shouldn't be converted
            if (key === 'uiAmount' || key === 'decimals' || key === 'uiAmountString') {
                converted[key] = value;
            } else {
                converted[key] = this.convertBuffers(value);
            }
        }
            return converted;
        }
        return obj; 
    }
};

module.exports = {
    grpcListener,
    wssListener
};
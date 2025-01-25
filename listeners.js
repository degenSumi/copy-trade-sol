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
    // Listen to transactions using yellostone geyser, highly optimal
    async listenAccountsGRPC(accountAddresses) {
        try {                    
            // Open connection.
            const client = new Client(this.GRPC_URL, "X_TOKEN", {
                "grpc.max_receive_message_length": 1024 * 1024 * 1024, // 64MiB
            });         
            
            // Subscribe for events
            const stream = await client.subscribe();
            
            // Create `error` / `end` handler
            const streamClosed = new Promise((resolve, reject) => {
                stream.on("error", (error) => {
                    reject(error);
                    stream.end();
                });
                stream.on("end", () => {
                    resolve();
                });
                stream.on("close", () => {
                    resolve();
                });
            });
            
            // Handle updates
            stream.on("data", async (data) => {
                let ts = new Date();
                if (data) {
            
                if(data.transaction) {
                    const tx = data.transaction;
                    // Convert the entire transaction object
                    const convertedTx = this.convertBuffers(tx);
                    // console.log(`${ts.toUTCString()}: Received update: ${JSON.stringify(convertedTx)}`, convertedTx);
                    // Process the transaction for copy trade
                    const tradeParams = await this.logProcessor.processEventGRPC(convertedTx);
                    this.emit("tradeparams", tradeParams);
                }
            
                else {
                    console.log(`${ts.toUTCString()}: Received update: ${JSON.stringify(data)}`);
                }
                // stream.end();
                } else if (data.pong) {
                console.log(`${ts.toUTCString()}: Processed ping response!`);
                }
            });
            
            // subscribe request.
            const request = {
                commitment: CommitmentLevel.PROCESSED,
                accountsDataSlice: [],
                ping: undefined,
                transactions: {
                    client: {
                    vote: false,
                    failed: false,
                    accountInclude: accountAddresses,
                    accountExclude: [],
                    accountRequired: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"], // This will filter only swap trades, currently RaydiumV4 or could add more amm keys here like orca meteora, raydiumclmm
                    },
                },
                // unused arguments
                accounts: {},
                slots: {},
                transactionsStatus: {},
                entry: {},
                blocks: {},
                blocksMeta: {},
            };
            
            // Send subscribe request
            await new Promise((resolve, reject) => {
                stream.write(request, (err) => {
                if (err === null || err === undefined) {
                    resolve();
                } else {
                    reject(err);
                }
                });
            }).catch((reason) => {
                console.error(reason);
                throw reason;
            });
            
            // Send pings every 5s to keep the connection open
            const pingRequest = {
                // Required, but unused arguments
                accounts: {},
                accountsDataSlice: [],
                transactions: {},
                blocks: {},
                blocksMeta: {},
                slots: {},
                transactionsStatus: {},
                entry: {},
            };
            setInterval(async () => {
                await new Promise((resolve, reject) => {
                stream.write(pingRequest, (err) => {
                    if (err === null || err === undefined) {
                    resolve();
                    } else {
                    reject(err);
                    }
                });
                }).catch((reason) => {
                console.error(reason);
                throw reason;
                });
            }, this.PING_INTERVAL_MS);
            
            await streamClosed;
        } catch(error){
            console.log(`got error while listening.. reconnecting`);
            // startListen();
        };
    };
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
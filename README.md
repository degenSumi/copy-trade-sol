# Multithreaded Copy Trading Bot <> Solana

This repository implements a multithreaded copy trading bot that monitors and replicates trading actions across different accounts on Solana. It is designed for efficiency and reliability, leveraging custom WebSocket listeners and multithreading to ensure optimal performance.

---

## Features

- **Multithreaded Execution**: Tracks multiple account sets on different threads for high performance.
- **Reliable WebSocket Listener**: Implements a custom `wssListener` with enhanced stability.
- **GRPC Support**: Includes `grpcListener` as an alternative to WebSocket for tracking accounts.
- **Supported DEXs**:
  - **RaydiumV4**
- **Dynamic Configuration**: Easily customize accounts, and other parameters via configuration files.



---

## Requirements

- **Node.js** (v14 or higher)
- **npm** or **yarn**
- Access to:
  - **Solana RPC Node**
  - **Yellowstone GRPC**

---

## Installation

1. Clone the repository:

2. Install dependencies:

   ```bash
   npm install
   ```

   Or, if you're using Yarn:

   ```bash
   yarn install
   ```

3. Configure environment variables:

   - Copy the `.env.example` file to `.env`.
   - Fill in your configuration details (e.g., API keys, RPC URLs, and thresholds).

4. Modify `config.json` to set accounts, and other parameters as required

5. Toggle between `grpcListener`/`wssListener` by commenting/uncommenting listener init lines currently at 207/208 in `index.js`

<img width="967" alt="image" src="https://github.com/user-attachments/assets/00c4e7e9-bf37-4bdc-816d-3a7699654d93" />

6. This was developed using AllThatNode's free gRPC service, which behaves unpredictably by stopping message streams after 1 minute, even      though the connection remains active. To address this, a resubscription routine has been implemented.
   Important: If you're using a reliable gRPC service, this workaround might cause issues like exceeding maximum subscription limits.
   Recommendation: Test the behavior with and without the resubscription logic by commenting out the corresponding lines in the code to 
   ensure compatibility with your setup. Lines: 184 `listener.js`

<img width="764" alt="image" src="https://github.com/user-attachments/assets/ad27d1c6-8de7-475b-ae5b-d4db82230b8e" />




---

## Usage

### Starting the Bot

To start the bot, use:

```bash
npm start
```

Or with Yarn:

```bash
yarn start
```

---

## Architecture

- **Listeners**:
  - `wssListener`: Reliable WebSocket-based listener with custom socket limits.
  - `grpcListener`: GRPC-based listener for accounts on Solana.
- **Multithreading**:
  - Each thread independently monitors a set of wallets.
  - Trades are created, simulated and then can be executed based on monitoring 
- **Error Handling**:
  - Gracefully handles network issues, transaction failures, and insufficient funds.
  - Trade values are in the smallest unit(decimals).

![image](https://github.com/user-attachments/assets/1fbdc489-c8fd-4b96-b9a8-859670d5e4ad)
![image](https://github.com/user-attachments/assets/9ee9297c-5320-4946-b00e-081c07878ab3)
![image](https://github.com/user-attachments/assets/82187abd-f060-4021-bf4a-bbf962c3a222)
<img width="1103" alt="image" src="https://github.com/user-attachments/assets/25fd81cb-5ad3-4993-956d-9ac52242a41a" />

---

### Common Issues

- **Insufficient Funds for Fees**:
  Ensure executing wallet has enough SOL for transaction fees.

- **WebSocket Instability**:
  Use the `grpcListener` as an alternative if WebSocket connections are unreliable.

- **Redis Errors**:
  Ensure Redis is running and correctly configured.


## Contributing

Contributions are welcome! Please submit issues or pull requests to help improve the project.

## Disclaimer

This bot is for **educational purposes only**. Use it at your own risk. The authors are not responsible for any financial losses incurred through the use of this software.

---

const { Connection } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const { Raydium, TxVersion, parseTokenAccountResp,
  AMM_V4, AMM_STABLE, DEVNET_PROGRAM_ID } = require('@raydium-io/raydium-sdk-v2');
const dotenv =  require('dotenv');
dotenv.config();

const connection = new Connection(process.env.solanarpc);

const txVersion = TxVersion.V0;

let raydium;

const initRaydium = async (params) => {

  raydium = await Raydium.load({
    owner: params?.owner,
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: !params?.loadToken,
    blockhashCommitment: 'confirmed',
  });

  return raydium;
};

const fetchTokenAccountData = async (owner) => {
  const solAccountResp = await connection.getAccountInfo(owner.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_PROGRAM_ID });
  const token2022Req = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
  const tokenAccountData = parseTokenAccountResp({
    owner: owner.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });
  return tokenAccountData;
};

const VALID_PROGRAM_ID = new Set([
  AMM_V4.toBase58(),
  AMM_STABLE.toBase58(),
  DEVNET_PROGRAM_ID.AmmV4.toBase58(),
  DEVNET_PROGRAM_ID.AmmStable.toBase58(),
]);

const isValidAmm = (id) => VALID_PROGRAM_ID.has(id);

module.exports = {
  isValidAmm,
  fetchTokenAccountData,
  initRaydium,
  txVersion,
  connection
};

import { getWormholeContextV2 } from 'config';
import { RelayerFee } from 'store/relay';
import { TokenConfig } from 'config/types';
import {
  TokenId,
  Chain,
  TokenAddress,
  Wormhole,
  AttestedTransferReceipt,
  RedeemedTransferReceipt,
  DestinationQueuedTransferReceipt,
  CompletedTransferReceipt,
  TokenBridge,
  Network,
  amount,
  routes,
  CircleTransfer,
} from '@wormhole-foundation/sdk';
import config from 'config';
import { NttRoute } from '@wormhole-foundation/sdk-route-ntt';
import { Connection } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import * as splToken from '@solana/spl-token';
import { getTokenDecimals, getWrappedTokenId } from 'utils';
import { WORMSCAN } from 'config/constants';

// Used to represent an initiated transfer. Primarily for the Redeem view.
export interface TransferInfo {
  // Transaction hash
  sendTx: string;

  // Stringified addresses
  sender?: string;
  recipient: string;

  amount: string;

  toChain: Chain;
  fromChain: Chain;

  // Source token address
  tokenAddress: string;
  tokenKey: string;
  tokenDecimals: number;

  // Destination token
  receivedTokenKey: string;
  receiveAmount?: string;
  relayerFee?: RelayerFee;

  // Amount of native gas being received, in destination gas token units
  // For example 1.0 is 1.0 ETH, not 1 wei
  receiveNativeAmount?: number;

  // ETA for the route this transfer was initiated on
  eta?: number;
}

// This function has three levels of priority when fetching a token bridge
// foreign asset address.
//
// 1. Check built-in config
// 2. Check cache
// 3. Fetch the address on chain using RPC (& cache this for next time)
export async function getTokenBridgeWrappedTokenAddress<C extends Chain>(
  token: TokenConfig,
  chain: C,
): Promise<TokenAddress<C> | null> {
  // Try cache first
  const cached = config.wrappedTokenAddressCache.get(token.key, chain);
  if (cached) {
    return cached;
  }

  // Fetch live and cache
  const wh = await getWormholeContextV2();
  const chainContext = wh.getChain(chain);
  const tb = await chainContext.getTokenBridge();

  console.info(
    `Resolving foreign address for token ${token.key} on chain ${chain}`,
  );

  const tokenId = config.sdkConverter.toTokenIdV2(token);

  try {
    const wrapped = await tb.getWrappedAsset(tokenId);

    if (wrapped) {
      config.wrappedTokenAddressCache.set(token.key, chain, wrapped);
    }

    return wrapped;
  } catch (_e) {
    return null;
  }
}

// This function is a synchronous version of `getTokenBridgeWrappedTokenAddress`
// that returns the cached value if it exists.
export function getTokenBridgeWrappedTokenAddressSync<C extends Chain>(
  token: TokenConfig,
  chain: C,
): TokenAddress<C> | null {
  return config.wrappedTokenAddressCache.get(token.key, chain);
}

export async function getDecimals(
  token: TokenId,
  chain: Chain,
): Promise<number> {
  const wh = await getWormholeContextV2();
  return await wh.getDecimals(chain, token.address);
}

export type ExplorerInfo = {
  url: string;
  name: string;
  apiUrl: string;
};

// TODO SDKV2 add a way for the Route interface to offer this
export function getExplorerInfo(
  route: string | routes.Route<Network>,
  txHash: string,
): ExplorerInfo {
  const routeName =
    typeof route === 'string'
      ? route
      : (route.constructor as routes.RouteConstructor).meta.name;

  if (routeName.startsWith('MayanSwap')) {
    return {
      url: `https://explorer.mayan.finance/swap/${txHash}`,
      name: 'Mayan Explorer',
      apiUrl: `${config.mayanApi}/v3/swap/trx/${txHash}`,
    };
  } else {
    return {
      url: `${WORMSCAN}tx/${txHash}${
        config.isMainnet ? '' : '?network=TESTNET'
      }`,
      name: 'Wormholescan',
      apiUrl: `${config.wormholeApi}api/v1/operations?txHash=${txHash}`,
    };
  }
}

type ReceiptWithAttestation<AT> =
  | AttestedTransferReceipt<AT>
  | RedeemedTransferReceipt<AT>
  | DestinationQueuedTransferReceipt<AT>
  | CompletedTransferReceipt<AT>;

// `parseReceipt` is used when we resume a transaction to get the transaction details
// from the VAA. Each protocol has different data in its VAAs and this parses them
// into the common internal format used by Connect: `TransferInfo`
//
// TODO SDKV2 this should probably not live in Connect.
// SDKV2 should provide a TransferInfo type and Routes should each be able to
// parse their own attestation into this type.
//
// Connect should never have to look inside of an attestation - that's too low-level.
export async function parseReceipt(
  route: string,
  receipt: ReceiptWithAttestation<any>,
): Promise<TransferInfo | null> {
  switch (route) {
    case 'ManualTokenBridge':
      return await parseTokenBridgeReceipt(
        receipt as ReceiptWithAttestation<TokenBridge.TransferVAA>,
      );
    case 'ManualCCTP':
      return await parseCCTPReceipt(
        receipt as ReceiptWithAttestation<CircleTransfer.CircleAttestationReceipt>,
      );
    case 'ManualNtt':
      return parseNttReceipt(
        receipt as ReceiptWithAttestation<NttRoute.ManualAttestationReceipt> & {
          params: NttRoute.ValidatedParams;
        },
      );
    case 'AutomaticNtt':
      return parseNttReceipt(
        receipt as ReceiptWithAttestation<NttRoute.AutomaticAttestationReceipt> & {
          params: NttRoute.ValidatedParams;
        },
      );
    default:
      throw new Error(`Unknown route type ${route}`);
  }
}

const parseTokenBridgeReceipt = async (
  receipt: ReceiptWithAttestation<TokenBridge.TransferVAA>,
): Promise<TransferInfo> => {
  const txData: Partial<TransferInfo> = {
    toChain: receipt.to,
    fromChain: receipt.from,
  };

  if ('originTxs' in receipt && receipt.originTxs.length > 0) {
    txData.sendTx = receipt.originTxs[receipt.originTxs.length - 1].txid;
  } else {
    throw new Error("Can't find txid in receipt");
  }

  /* @ts-ignore */
  // TODO typescript is complaining about the second attestation property not existing when it does
  const { payload } = receipt.attestation.attestation;

  if (!payload.token) {
    throw new Error(`Attestation is missing token.`);
  }

  if (payload.token) {
    const wh = await getWormholeContextV2();
    const chainContext = wh.getChain(payload.token.chain);
    const tb = await chainContext.getTokenBridge();
    const tokenAddress = (
      await tb.getTokenNativeAddress(payload.token.chain, payload.token.address)
    ).toString();

    const tokenIdV2 = Wormhole.tokenId(payload.token.chain, tokenAddress);
    const tokenV1 = config.sdkConverter.findTokenConfigV1(
      tokenIdV2,
      config.tokensArr,
    );

    if (!tokenV1) {
      // This is a token Connect is not aware of
      throw new Error('Unknown token');
    }

    const fromChain = receipt.from;

    const decimals = getTokenDecimals(fromChain, getWrappedTokenId(tokenV1));

    txData.tokenDecimals = decimals;

    txData.amount = amount.display({
      amount: payload.token.amount.toString(),
      // VAAs are truncated to a max of 8 decimal places
      decimals: Math.min(8, decimals),
    });
    txData.tokenAddress = tokenAddress;
    txData.tokenKey = tokenV1.key;
    txData.receivedTokenKey = tokenV1.key;
    txData.receiveAmount = txData.amount;
    if (payload.payload?.toNativeTokenAmount) {
      txData.receiveNativeAmount = Number(
        amount.fmt(payload.payload.toNativeTokenAmount, Math.min(8, decimals)),
      );
    }
    if (payload.payload?.targetRelayerFee) {
      txData.relayerFee = {
        fee: Number(
          amount.fmt(payload.payload.targetRelayerFee, Math.min(8, decimals)),
        ),
        tokenKey: tokenV1.key,
      };
    }
  }

  if (payload.to) {
    if (receipt.to === 'Solana') {
      if (!config.rpcs.Solana) {
        throw new Error('Missing Solana RPC');
      }
      // the recipient on the VAA is the ATA
      const ata = payload.to.address.toNative(receipt.to).toString();
      const connection = new Connection(config.rpcs.Solana);
      try {
        const account = await splToken.getAccount(
          connection,
          new PublicKey(ata),
        );
        txData.recipient = account.owner.toBase58();
      } catch (e) {
        console.error(e);
        txData.recipient = ata;
      }
    } else {
      txData.recipient = payload.to.address.toNative(receipt.to).toString();
    }
  }

  return txData as TransferInfo;
};

const parseCCTPReceipt = async (
  receipt: ReceiptWithAttestation<CircleTransfer.CircleAttestationReceipt>,
): Promise<TransferInfo> => {
  const txData: Partial<TransferInfo> = {
    toChain: receipt.to,
    fromChain: receipt.from,
  };

  if ('originTxs' in receipt && receipt.originTxs.length > 0) {
    txData.sendTx = receipt.originTxs[receipt.originTxs.length - 1].txid;
  } else {
    throw new Error("Can't find txid in receipt");
  }

  if (!receipt.attestation.attestation) {
    throw new Error(`Missing Circle attestation`);
  }

  const { payload } = receipt.attestation.attestation.message;

  const sourceTokenId = Wormhole.tokenId(
    receipt.from,
    payload.burnToken.toNative(receipt.from).toString(),
  );
  const usdcLegacy = config.sdkConverter.findTokenConfigV1(
    sourceTokenId,
    config.tokensArr,
  );
  if (!usdcLegacy) {
    throw new Error(`Couldn't find USDC for source chain`);
  }

  txData.tokenAddress = sourceTokenId.address.toString();
  txData.tokenKey = usdcLegacy.key;

  const decimals = getTokenDecimals(
    receipt.from,
    getWrappedTokenId(usdcLegacy),
  );

  txData.tokenDecimals = decimals;
  txData.amount = amount.display({
    amount: payload.amount.toString(),
    decimals,
  });
  txData.receiveAmount = txData.amount;

  txData.sender = payload.messageSender.toNative(receipt.from).toString();
  if (receipt.to === 'Solana') {
    if (!config.rpcs.Solana) {
      throw new Error('Missing Solana RPC');
    }
    // the recipient on the VAA is the ATA
    const ata = payload.mintRecipient.toNative(receipt.to).toString();
    const connection = new Connection(config.rpcs.Solana);
    try {
      const account = await splToken.getAccount(connection, new PublicKey(ata));
      txData.recipient = account.owner.toBase58();
    } catch (e) {
      console.error(e);
      txData.recipient = ata;
    }
  } else {
    txData.recipient = payload.mintRecipient.toNative(receipt.to).toString();
  }

  // The attestation doesn't have the destination token address, but we can deduce which it is
  // just based off the destination chain
  const destinationUsdcLegacy = config.tokensArr.find((token) => {
    return token.symbol === 'USDC' && token.nativeChain === txData.toChain;
  });
  if (!destinationUsdcLegacy) {
    throw new Error(`Couldn't find USDC for destination chain`);
  }

  txData.receivedTokenKey = destinationUsdcLegacy.key;

  return txData as TransferInfo;
};

const parseNttReceipt = (
  receipt: ReceiptWithAttestation<
    NttRoute.ManualAttestationReceipt | NttRoute.AutomaticAttestationReceipt
  > & {
    params: NttRoute.ValidatedParams;
  },
): TransferInfo => {
  let sendTx = '';
  if ('originTxs' in receipt && receipt.originTxs.length > 0) {
    sendTx = receipt.originTxs[receipt.originTxs.length - 1].txid;
  } else {
    throw new Error("Can't find txid in receipt");
  }

  const srcTokenIdV2 = Wormhole.tokenId(
    receipt.from,
    receipt.params.normalizedParams.sourceContracts.token,
  );
  const srcTokenV1 = config.sdkConverter.findTokenConfigV1(
    srcTokenIdV2,
    config.tokensArr,
  );
  if (!srcTokenV1) {
    // This is a token Connect is not aware of
    throw new Error('Unknown src token');
  }

  const dstTokenIdV2 = Wormhole.tokenId(
    receipt.to,
    receipt.params.normalizedParams.destinationContracts.token,
  );
  const dstTokenV1 = config.sdkConverter.findTokenConfigV1(
    dstTokenIdV2,
    config.tokensArr,
  );
  if (!dstTokenV1) {
    // This is a token Connect is not aware of
    throw new Error('Unknown dst token');
  }

  const { attestation } = receipt.attestation;
  const { payload } =
    attestation.payloadName === 'WormholeTransfer'
      ? attestation
      : attestation.payload;
  const { trimmedAmount } = payload.nttManagerPayload.payload;
  const amt = amount.display({
    amount: trimmedAmount.amount.toString(),
    decimals: trimmedAmount.decimals,
  });
  return {
    toChain: receipt.to,
    fromChain: receipt.from,
    sendTx,
    sender: payload.nttManagerPayload.sender.toNative(receipt.from).toString(),
    recipient: payload.nttManagerPayload.payload.recipientAddress
      .toNative(receipt.to)
      .toString(),
    amount: amt,
    tokenAddress: srcTokenV1.tokenId!.address.toString(),
    tokenKey: srcTokenV1.key,
    tokenDecimals: trimmedAmount.decimals,
    receivedTokenKey: dstTokenV1.key,
    receiveAmount: amt,
    relayerFee: undefined, // TODO: how to get?
  };
};

const isAmount = (amount: any): amount is amount.Amount => {
  return (
    typeof amount === 'object' &&
    typeof amount.amount === 'string' &&
    typeof amount.decimals === 'number'
  );
};

// Warning: any changes to this function can make TS unhappy
export const isMinAmountError = (
  error?: Error,
): error is routes.MinAmountError => {
  const unsafeCastError = error as routes.MinAmountError;
  return isAmount(unsafeCastError?.min);
};

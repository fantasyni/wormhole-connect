import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { useTheme } from '@mui/material';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import WarningIcon from '@mui/icons-material/Report';
import { makeStyles } from 'tss-react/mui';
import { amount, routes } from '@wormhole-foundation/sdk';

import config from 'config';
import TokenIcon from 'icons/TokenIcons';
import {
  isEmptyObject,
  calculateUSDPrice,
  calculateUSDPriceRaw,
  getUSDFormat,
  millisToHumanString,
  formatDuration,
} from 'utils';

import type { RouteData } from 'config/routes';
import type { RootState } from 'store';
import { formatAmount } from 'utils/amount';
import { toFixedDecimals } from 'utils/balance';
import { TokenConfig } from 'config/types';
import FastestRoute from 'icons/FastestRoute';
import CheapestRoute from 'icons/CheapestRoute';

const HIGH_FEE_THRESHOLD = 20; // dollhairs

const useStyles = makeStyles()((theme: any) => ({
  container: {
    width: '100%',
    maxWidth: '420px',
    marginBottom: '8px',
  },
  card: {
    borderRadius: '8px',
    width: '100%',
    maxWidth: '420px',
  },
  cardHeader: {
    paddingBottom: '2px',
  },
  fastestBadge: {
    width: '14px',
    height: '14px',
    position: 'relative',
    top: '2px',
    marginRight: '4px',
    fill: theme.palette.primary.main,
  },
  cheapestBadge: {
    width: '12px',
    height: '12px',
    position: 'relative',
    top: '1px',
    marginRight: '3px',
    fill: theme.palette.primary.main,
  },
}));

type Props = {
  route: RouteData;
  isSelected: boolean;
  error?: string;
  destinationGasDrop?: number;
  isFastest?: boolean;
  isCheapest?: boolean;
  isOnlyChoice?: boolean;
  onSelect?: (route: string) => void;
  quote?: routes.Quote<routes.Options>;
};

const SingleRoute = (props: Props) => {
  const { classes } = useStyles();
  const theme = useTheme();
  const routeConfig = config.routes.get(props.route.name);

  const {
    toChain: destChain,
    destToken,
    fromChain: sourceChain,
    token: sourceToken,
  } = useSelector((state: RootState) => state.transferInput);

  const { usdPrices: tokenPrices } = useSelector(
    (state: RootState) => state.tokenPrices,
  );

  const { name } = props.route;
  const { quote } = props;

  const destTokenConfig = useMemo(
    () => config.tokens[destToken] as TokenConfig | undefined,
    [destToken],
  );

  const [feePrice, isHighFee, feeTokenConfig]: [
    number | undefined,
    boolean,
    TokenConfig | undefined,
  ] = useMemo(() => {
    if (!quote?.relayFee) {
      return [undefined, false, undefined];
    }

    const relayFee = amount.whole(quote.relayFee.amount);
    const feeToken = quote.relayFee.token;
    const feeTokenConfig = config.sdkConverter.findTokenConfigV1(
      feeToken,
      Object.values(config.tokens),
    );
    const feePrice = calculateUSDPriceRaw(
      relayFee,
      tokenPrices.data,
      feeTokenConfig,
    );

    if (feePrice === undefined) {
      return [undefined, false, undefined];
    }

    return [feePrice, feePrice > HIGH_FEE_THRESHOLD, feeTokenConfig];
  }, [quote]);

  const relayerFee = useMemo(() => {
    if (!routeConfig.AUTOMATIC_DEPOSIT) {
      return <>You pay gas on {destChain}</>;
    }

    if (!quote || !feePrice || !feeTokenConfig) {
      return <></>;
    }

    const feePriceFormatted = getUSDFormat(feePrice);

    let feeValue = `${amount.display(quote!.relayFee!.amount, 4)} ${
      feeTokenConfig.symbol
    } (${feePriceFormatted})`;

    // Wesley made me do it
    // Them PMs :-/
    if (props.route.name.startsWith('MayanSwap')) {
      feeValue = feePriceFormatted;
    }

    return (
      <Stack direction="row" justifyContent="space-between">
        <Typography color={theme.palette.text.secondary} fontSize={14}>
          Network cost
        </Typography>
        <Typography color={theme.palette.text.secondary} fontSize={14}>
          {feeValue}
        </Typography>
      </Stack>
    );
  }, [destToken, quote?.relayFee, tokenPrices]);

  const destinationGas = useMemo(() => {
    if (!destChain || !props.destinationGasDrop) {
      return <></>;
    }

    const destChainConfig = config.chains[destChain];

    if (!destChainConfig) {
      return <></>;
    }

    const gasTokenConfig = config.tokens[destChainConfig.gasToken];

    const gasTokenPrice = calculateUSDPrice(
      props.destinationGasDrop,
      tokenPrices.data,
      gasTokenConfig,
    );

    const gasTokenAmount = toFixedDecimals(
      props.destinationGasDrop?.toString() || '0',
      4,
    );

    return (
      <Stack direction="row" justifyContent="space-between">
        <Typography color={theme.palette.text.secondary} fontSize={14}>
          Additional Gas
        </Typography>
        <Typography
          color={theme.palette.text.secondary}
          fontSize={14}
        >{`${gasTokenAmount} ${gasTokenConfig.symbol} (${gasTokenPrice})`}</Typography>
      </Stack>
    );
  }, [destChain, props.destinationGasDrop]);

  const timeToDestination = useMemo(
    () => (
      <>
        <Typography color={theme.palette.text.secondary} fontSize={14}>
          {`Time to ${destChain}`}
        </Typography>

        <Typography
          fontSize={14}
          sx={{
            color:
              quote?.eta && quote.eta < 60 * 1000
                ? theme.palette.success.main
                : theme.palette.text.secondary,
          }}
        >
          {quote?.eta ? millisToHumanString(quote.eta) : 'N/A'}
        </Typography>
      </>
    ),
    [destChain, quote?.eta],
  );

  const isManual = useMemo(() => {
    if (!props.route) {
      return false;
    }

    return !routeConfig.AUTOMATIC_DEPOSIT;
  }, [props.route.name]);

  const errorMessage = useMemo(() => {
    if (!props.error) {
      return null;
    }

    return (
      <>
        <Divider flexItem sx={{ marginTop: '8px' }} />
        <Stack direction="row" alignItems="center">
          <WarningIcon htmlColor={theme.palette.error.main} />
          <Stack sx={{ padding: '16px' }}>
            <Typography color={theme.palette.error.main} fontSize={14}>
              {props.error}
            </Typography>
          </Stack>
        </Stack>
      </>
    );
  }, [props.error]);

  const warningMessages = useMemo(() => {
    const messages: React.JSX.Element[] = [];

    if (isManual) {
      messages.push(
        <div key="ManualTransactionWarning">
          <Divider flexItem sx={{ marginTop: '8px' }} />
          <Stack direction="row" alignItems="center">
            <WarningIcon htmlColor={theme.palette.warning.main} />
            <Stack sx={{ padding: '16px' }}>
              <Typography color={theme.palette.warning.main} fontSize={14}>
                This transfer requires two transactions
              </Typography>
              <Typography color={theme.palette.text.secondary} fontSize={14}>
                You will need to make two wallet approvals and have gas on the
                destination chain.
              </Typography>
            </Stack>
          </Stack>
        </div>,
      );
    }

    for (const warning of quote?.warnings || []) {
      if (
        warning.type === 'DestinationCapacityWarning' &&
        warning.delayDurationSec
      ) {
        const symbol = config.tokens[destToken].symbol;
        const duration = formatDuration(warning.delayDurationSec);
        messages.push(
          <div key={`${warning.type}-${warning.delayDurationSec}`}>
            <Divider flexItem sx={{ marginTop: '8px' }} />
            <Stack direction="row" alignItems="center">
              <WarningIcon htmlColor={theme.palette.warning.main} />
              <Stack sx={{ padding: '16px 16px 0 16px' }}>
                <Typography color={theme.palette.warning.main} fontSize={14}>
                  {`Your transfer to ${destChain} may be delayed due to rate limits set by ${symbol}. If your transfer is delayed, you will need to return after ${duration} to complete the transfer. Please consider this before proceeding.`}
                </Typography>
              </Stack>
            </Stack>
          </div>,
        );
      }
    }

    if (isHighFee) {
      messages.push(
        <div key="HighFee">
          <Divider flexItem sx={{ marginTop: '8px' }} />
          <Stack direction="row" alignItems="center">
            <WarningIcon htmlColor={theme.palette.warning.main} />
            <Stack sx={{ padding: '16px 16px 0 16px' }}>
              <Typography color={theme.palette.warning.main} fontSize={14}>
                Output amount is much lower than input amount. Double check
                before proceeding.
              </Typography>
            </Stack>
          </Stack>
        </div>,
      );
    }

    return messages;
  }, [isManual, quote, destChain, destToken, config]);

  const providerText = useMemo(() => {
    if (!sourceToken) {
      return '';
    }

    const { providedBy, name } = props.route;

    const { symbol } = config.tokens[sourceToken];

    let provider = '';

    // Special case for Lido NTT
    if (
      name === 'AutomaticNtt' &&
      symbol === 'wstETH' &&
      ((sourceChain === 'Ethereum' && destChain === 'Bsc') ||
        (sourceChain === 'Bsc' && destChain === 'Ethereum'))
    ) {
      provider = 'via NTT: Wormhole + Axelar';
    }
    // We are skipping the provider text (e.g. "via ...") for xLabs
    else if (providedBy && !providedBy.toLowerCase().includes('xlabs')) {
      provider = `via ${props.route.providedBy}`;
    }

    return provider;
  }, [
    props.route.providedBy,
    props.route.name,
    sourceToken,
    sourceChain,
    destChain,
  ]);

  const receiveAmount = useMemo(() => {
    return quote ? amount.whole(quote?.destinationToken.amount) : undefined;
  }, [quote]);

  const receiveAmountTrunc = useMemo(() => {
    return quote && destChain && destTokenConfig
      ? formatAmount(
          destChain,
          destTokenConfig,
          quote.destinationToken.amount.amount,
          6,
        )
      : undefined;
  }, [quote]);

  const routeCardHeader = useMemo(() => {
    if (props.error) {
      return <Typography color="error">Route is unavailable</Typography>;
    }

    if (receiveAmount === undefined || !destTokenConfig) {
      return null;
    }

    const color = isHighFee
      ? theme.palette.warning.main
      : theme.palette.text.primary;

    return (
      <Typography fontSize={18} color={color}>
        {receiveAmountTrunc} {destTokenConfig.symbol}
      </Typography>
    );
  }, [destToken, receiveAmountTrunc, props.error]);

  const routeCardSubHeader = useMemo(() => {
    if (props.error || !destChain) {
      return null;
    }

    if (receiveAmount === undefined) {
      return null;
    }

    let usdValue = calculateUSDPrice(
      receiveAmount,
      tokenPrices.data,
      destTokenConfig,
    );

    if (usdValue !== '') usdValue = `(${usdValue})`;

    return (
      <Typography
        fontSize={14}
        color={theme.palette.text.secondary}
      >{`${usdValue} ${providerText}`}</Typography>
    );
  }, [destTokenConfig, providerText, receiveAmount, tokenPrices]);

  // There are three states for the Card area cursor:
  // 1- If no action handler provided, fall back to default
  // 2- Otherwise there is an action handler, "pointer"
  const cursor = useMemo(() => {
    if (props.isSelected || typeof props.onSelect !== 'function') {
      return 'default';
    }

    if (props.error) {
      return 'not-allowed';
    }

    return 'pointer';
  }, [props.error, props.isSelected, props.onSelect]);

  const routeCardBadge = useMemo(() => {
    if (props.isFastest) {
      return (
        <>
          <FastestRoute className={classes.fastestBadge} />
          {props.isOnlyChoice ? 'Fast' : 'Fastest'}
        </>
      );
    } else if (props.isCheapest && !props.isOnlyChoice) {
      return (
        <>
          <CheapestRoute className={classes.cheapestBadge} /> Cheapest
        </>
      );
    } else {
      return null;
    }
  }, [props.isFastest, props.isCheapest]);

  if (isEmptyObject(props.route)) {
    return <></>;
  }

  return (
    <div key={name} className={classes.container}>
      <Card
        className={classes.card}
        sx={{
          border: '1px solid',
          borderColor: props.isSelected
            ? theme.palette.primary.main
            : 'transparent',
          opacity: 1,
        }}
      >
        <CardActionArea
          disabled={
            typeof props.onSelect !== 'function' || props.error !== undefined
          }
          disableTouchRipple
          sx={{ cursor }}
          onClick={() => {
            props.onSelect?.(props.route.name);
          }}
        >
          <CardHeader
            avatar={<TokenIcon icon={destTokenConfig?.icon} height={36} />}
            className={classes.cardHeader}
            title={routeCardHeader}
            subheader={routeCardSubHeader}
            action={routeCardBadge}
          />
          <CardContent>
            <Stack justifyContent="space-between">
              {relayerFee}
              {destinationGas}
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              {timeToDestination}
            </Stack>
            {errorMessage}
            {warningMessages}
          </CardContent>
        </CardActionArea>
      </Card>
    </div>
  );
};

export default SingleRoute;

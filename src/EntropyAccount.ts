import { Market, OpenOrders, Orderbook } from '@project-serum/serum';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { I80F48, ONE_I80F48, ZERO_I80F48 } from './fixednum';
import {
  FREE_ORDER_SLOT,
  EntropyAccountLayout,
  EntropyCache,
  MAX_PAIRS,
  MetaData,
  QUOTE_INDEX,
  RootBankCache,
} from './layout';
import {
  getWeights,
  nativeI80F48ToUi,
  nativeToUi,
  splitOpenOrders,
  zeroKey,
} from './utils';

import RootBank from './RootBank';
import BN from 'bn.js';
import EntropyGroup from './EntropyGroup';
import PerpAccount from './PerpAccount';
import { EOL } from 'os';
import {
  AdvancedOrdersLayout,
  getMarketByPublicKey,
  getMultipleAccounts,
  getPriceFromKey,
  getTokenByMint,
  GroupConfig,
  PerpMarketConfig,
  PerpTriggerOrder,
  sleep,
  TokenConfig,
  ZERO_BN,
} from '.';
import PerpMarket from './PerpMarket';
import { Order } from '@project-serum/serum/lib/market';

export default class EntropyAccount {
  publicKey: PublicKey;
  metaData!: MetaData;
  entropyGroup!: PublicKey;
  owner!: PublicKey;

  inMarginBasket!: boolean[];
  numInMarginBasket!: number;
  deposits!: I80F48[];
  borrows!: I80F48[];

  spotOpenOrders!: PublicKey[];
  spotOpenOrdersAccounts: (OpenOrders | undefined)[];

  perpAccounts!: PerpAccount[];
  orderMarket!: number[];
  orderSide!: string[];
  orders!: BN[];
  clientOrderIds!: BN[];

  msrmAmount!: BN;

  beingLiquidated!: boolean;
  isBankrupt!: boolean;
  info!: number[];

  advancedOrdersKey!: PublicKey;
  advancedOrders: { perpTrigger?: PerpTriggerOrder }[];

  constructor(publicKey: PublicKey, decoded: any) {
    this.publicKey = publicKey;
    this.spotOpenOrdersAccounts = new Array(MAX_PAIRS).fill(undefined);
    this.advancedOrders = [];
    Object.assign(this, decoded);
  }

  get name(): string {
    return this.info
      ? String.fromCharCode(...this.info).replace(
          new RegExp(String.fromCharCode(0), 'g'),
          '',
        )
      : '';
  }

  getLiquidationPrice(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    oracleIndex: number,
  ): I80F48 | undefined {
    const { spot, perps, quote } = this.getHealthComponents(
      entropyGroup,
      entropyCache,
    );

    let partialHealth = quote;
    let weightedAsset = ZERO_I80F48;
    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const w = getWeights(entropyGroup, i, 'Maint');
      if (i === oracleIndex) {
        const weightedSpot = spot[i].mul(
          spot[i].isPos() ? w.spotAssetWeight : w.spotLiabWeight,
        );
        const weightedPerps = perps[i].mul(
          perps[i].isPos() ? w.perpAssetWeight : w.perpLiabWeight,
        );
        weightedAsset = weightedSpot.add(weightedPerps).neg();
      } else {
        const price = entropyCache.priceCache[i].price;
        const spotHealth = spot[i]
          .mul(price)
          .mul(spot[i].isPos() ? w.spotAssetWeight : w.spotLiabWeight);
        const perpHealth = perps[i]
          .mul(price)
          .mul(perps[i].isPos() ? w.perpAssetWeight : w.perpLiabWeight);
        partialHealth = partialHealth.add(spotHealth).add(perpHealth);
      }
    }

    if (weightedAsset.isZero()) {
      return undefined;
    }
    const liqPrice = partialHealth.div(weightedAsset);
    if (liqPrice.isNeg()) {
      return undefined;
    }
    return liqPrice.mul(
      // adjust for decimals in the price
      I80F48.fromNumber(
        Math.pow(
          10,
          entropyGroup.tokens[oracleIndex].decimals -
            entropyGroup.tokens[QUOTE_INDEX].decimals,
        ),
      ),
    );
  }

  hasAnySpotOrders(): boolean {
    return this.inMarginBasket.some((b) => b);
  }
  async reload(
    connection: Connection,
    dexProgramId: PublicKey | undefined = undefined,
  ): Promise<EntropyAccount> {
    const acc = await connection.getAccountInfo(this.publicKey);
    Object.assign(this, EntropyAccountLayout.decode(acc?.data));
    if (dexProgramId) {
      await this.loadOpenOrders(connection, dexProgramId);
    }
    return this;
  }

  async reloadFromSlot(
    connection: Connection,
    lastSlot = 0,
    dexProgramId: PublicKey | undefined = undefined,
  ): Promise<EntropyAccount> {
    let slot = -1;
    let value: AccountInfo<Buffer> | null = null;

    while (slot <= lastSlot) {
      const response = await connection.getAccountInfoAndContext(
        this.publicKey,
      );
      slot = response.context?.slot;
      value = response.value;
      await sleep(250);
    }

    Object.assign(this, EntropyAccountLayout.decode(value?.data));
    if (dexProgramId) {
      await this.loadOpenOrders(connection, dexProgramId);
    }
    return this;
  }

  async loadSpotOrdersForMarket(
    connection: Connection,
    market: Market,
    marketIndex: number,
  ): Promise<Order[]> {
    const [bidsInfo, asksInfo] = await getMultipleAccounts(connection, [
      market.bidsAddress,
      market.asksAddress,
    ]);

    const bids = Orderbook.decode(market, bidsInfo.accountInfo.data);
    const asks = Orderbook.decode(market, asksInfo.accountInfo.data);

    return [...bids, ...asks].filter((o) =>
      o.openOrdersAddress.equals(this.spotOpenOrders[marketIndex]),
    );
  }
  async loadOpenOrders(
    connection: Connection,
    serumDexPk: PublicKey,
  ): Promise<(OpenOrders | undefined)[]> {
    const accounts = await getMultipleAccounts(
      connection,
      this.spotOpenOrders.filter((pk) => !pk.equals(zeroKey)),
    );

    this.spotOpenOrdersAccounts = this.spotOpenOrders.map((openOrderPk) => {
      if (openOrderPk.equals(zeroKey)) {
        return undefined;
      }
      const account = accounts.find((a) => a.publicKey.equals(openOrderPk));
      return account
        ? OpenOrders.fromAccountInfo(
            openOrderPk,
            account.accountInfo,
            serumDexPk,
          )
        : undefined;
    });
    return this.spotOpenOrdersAccounts;
  }

  async loadAdvancedOrders(
    connection: Connection,
  ): Promise<{ perpTrigger?: PerpTriggerOrder }[]> {
    if (this.advancedOrdersKey.equals(zeroKey)) return [];

    const acc = await connection.getAccountInfo(this.advancedOrdersKey);
    const decoded = AdvancedOrdersLayout.decode(acc?.data);
    this.advancedOrders = decoded.orders;
    return decoded.orders;
  }

  getNativeDeposit(
    rootBank: RootBank | RootBankCache,
    tokenIndex: number,
  ): I80F48 {
    return rootBank.depositIndex.mul(this.deposits[tokenIndex]);
  }
  getNativeBorrow(
    rootBank: RootBank | RootBankCache,
    tokenIndex: number,
  ): I80F48 {
    return rootBank.borrowIndex.mul(this.borrows[tokenIndex]);
  }
  getUiDeposit(
    rootBank: RootBank | RootBankCache,
    entropyGroup: EntropyGroup,
    tokenIndex: number,
  ): I80F48 {
    return nativeI80F48ToUi(
      this.getNativeDeposit(rootBank, tokenIndex).floor(),
      entropyGroup.getTokenDecimals(tokenIndex),
    );
  }
  getUiBorrow(
    rootBank: RootBank | RootBankCache,
    entropyGroup: EntropyGroup,
    tokenIndex: number,
  ): I80F48 {
    return nativeI80F48ToUi(
      this.getNativeBorrow(rootBank, tokenIndex).ceil(),
      entropyGroup.getTokenDecimals(tokenIndex),
    );
  }

  getSpotVal(entropyGroup, entropyCache, index, assetWeight) {
    let assetsVal = ZERO_I80F48;
    const price = entropyGroup.getPrice(index, entropyCache);

    const depositVal = this.getUiDeposit(
      entropyCache.rootBankCache[index],
      entropyGroup,
      index,
    )
      .mul(price)
      .mul(assetWeight);
    assetsVal = assetsVal.add(depositVal);

    const openOrdersAccount = this.spotOpenOrdersAccounts[index];
    if (openOrdersAccount !== undefined) {
      assetsVal = assetsVal.add(
        I80F48.fromNumber(
          nativeToUi(
            openOrdersAccount.baseTokenTotal.toNumber(),
            entropyGroup.tokens[index].decimals,
          ),
        )
          .mul(price)
          .mul(assetWeight),
      );
      assetsVal = assetsVal.add(
        I80F48.fromNumber(
          nativeToUi(
            openOrdersAccount.quoteTokenTotal.toNumber() +
              openOrdersAccount['referrerRebatesAccrued'].toNumber(),
            entropyGroup.tokens[QUOTE_INDEX].decimals,
          ),
        ),
      );
    }

    return assetsVal;
  }

  getAssetsVal(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    healthType?: HealthType,
  ): I80F48 {
    let assetsVal = ZERO_I80F48;
    // quote currency deposits
    assetsVal = assetsVal.add(
      this.getUiDeposit(
        entropyCache.rootBankCache[QUOTE_INDEX],
        entropyGroup,
        QUOTE_INDEX,
      ),
    );

    for (let i = 0; i < entropyGroup.numOracles; i++) {
      let assetWeight = ONE_I80F48;
      if (healthType === 'Maint') {
        assetWeight = entropyGroup.spotMarkets[i].maintAssetWeight;
      } else if (healthType === 'Init') {
        assetWeight = entropyGroup.spotMarkets[i].initAssetWeight;
      }

      const spotVal = this.getSpotVal(entropyGroup, entropyCache, i, assetWeight);
      assetsVal = assetsVal.add(spotVal);

      const price = entropyCache.priceCache[i].price;
      const perpsUiAssetVal = nativeI80F48ToUi(
        this.perpAccounts[i].getAssetVal(
          entropyGroup.perpMarkets[i],
          price,
          entropyCache.perpMarketCache[i].shortFunding,
          entropyCache.perpMarketCache[i].longFunding,
        ),
        entropyGroup.tokens[QUOTE_INDEX].decimals,
      );

      assetsVal = assetsVal.add(perpsUiAssetVal);
    }

    return assetsVal;
  }

  getLiabsVal(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    healthType?: HealthType,
  ): I80F48 {
    let liabsVal = ZERO_I80F48;

    liabsVal = liabsVal.add(
      this.getUiBorrow(
        entropyCache.rootBankCache[QUOTE_INDEX],
        entropyGroup,
        QUOTE_INDEX,
      ),
    );

    for (let i = 0; i < entropyGroup.numOracles; i++) {
      let liabWeight = ONE_I80F48;
      const price = entropyGroup.getPrice(i, entropyCache);
      if (healthType === 'Maint') {
        liabWeight = entropyGroup.spotMarkets[i].maintLiabWeight;
      } else if (healthType === 'Init') {
        liabWeight = entropyGroup.spotMarkets[i].initLiabWeight;
      }

      liabsVal = liabsVal.add(
        this.getUiBorrow(entropyCache.rootBankCache[i], entropyGroup, i).mul(
          price.mul(liabWeight),
        ),
      );

      const perpsUiLiabsVal = nativeI80F48ToUi(
        this.perpAccounts[i].getLiabsVal(
          entropyGroup.perpMarkets[i],
          entropyCache.priceCache[i].price,
          entropyCache.perpMarketCache[i].shortFunding,
          entropyCache.perpMarketCache[i].longFunding,
        ),
        entropyGroup.tokens[QUOTE_INDEX].decimals,
      );

      liabsVal = liabsVal.add(perpsUiLiabsVal);
    }
    return liabsVal;
  }

  getNativeLiabsVal(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    healthType?: HealthType,
  ): I80F48 {
    let liabsVal = ZERO_I80F48;

    liabsVal = liabsVal.add(
      this.getNativeBorrow(entropyCache.rootBankCache[QUOTE_INDEX], QUOTE_INDEX),
    );

    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const price = entropyCache.priceCache[i].price;
      let liabWeight = ONE_I80F48;
      if (healthType === 'Maint') {
        liabWeight = entropyGroup.spotMarkets[i].maintLiabWeight;
      } else if (healthType === 'Init') {
        liabWeight = entropyGroup.spotMarkets[i].initLiabWeight;
      }

      liabsVal = liabsVal.add(
        this.getNativeBorrow(entropyCache.rootBankCache[i], i).mul(
          price.mul(liabWeight),
        ),
      );

      liabsVal = liabsVal.add(
        this.perpAccounts[i].getLiabsVal(
          entropyGroup.perpMarkets[i],
          price,
          entropyCache.perpMarketCache[i].shortFunding,
          entropyCache.perpMarketCache[i].longFunding,
        ),
      );
    }
    return liabsVal;
  }

  /**
   * deposits - borrows in native terms
   */
  getNet(bankCache: RootBankCache, tokenIndex: number): I80F48 {
    return this.deposits[tokenIndex]
      .mul(bankCache.depositIndex)
      .sub(this.borrows[tokenIndex].mul(bankCache.borrowIndex));
  }

  /**
   * Take health components and return the assets and liabs weighted
   */
  getWeightedAssetsLiabsVals(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    spot: I80F48[],
    perps: I80F48[],
    quote: I80F48,
    healthType?: HealthType,
  ): { assets: I80F48; liabs: I80F48 } {
    let assets = ZERO_I80F48;
    let liabs = ZERO_I80F48;

    if (quote.isPos()) {
      assets = assets.add(quote);
    } else {
      liabs = liabs.add(quote.neg());
    }

    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const w = getWeights(entropyGroup, i, healthType);
      const price = entropyCache.priceCache[i].price;
      if (spot[i].isPos()) {
        assets = spot[i].mul(price).mul(w.spotAssetWeight).add(assets);
      } else {
        liabs = spot[i].neg().mul(price).mul(w.spotLiabWeight).add(liabs);
      }

      if (perps[i].isPos()) {
        assets = perps[i].mul(price).mul(w.perpAssetWeight).add(assets);
      } else {
        liabs = perps[i].neg().mul(price).mul(w.perpLiabWeight).add(liabs);
      }
    }
    return { assets, liabs };
  }

  getHealthFromComponents(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    spot: I80F48[],
    perps: I80F48[],
    quote: I80F48,
    healthType: HealthType,
  ): I80F48 {
    const health = quote;
    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const w = getWeights(entropyGroup, i, healthType);
      const price = entropyCache.priceCache[i].price;
      const spotHealth = spot[i]
        .mul(price)
        .imul(spot[i].isPos() ? w.spotAssetWeight : w.spotLiabWeight);
      const perpHealth = perps[i]
        .mul(price)
        .imul(perps[i].isPos() ? w.perpAssetWeight : w.perpLiabWeight);

      health.iadd(spotHealth).iadd(perpHealth);
    }

    return health;
  }

  getHealthFromComponentsUnweighted(
    mangoGroup: EntropyGroup,
    mangoCache: EntropyCache,
    spot: I80F48[],
    perps: I80F48[],
    quote: I80F48,
  ): I80F48 {
    const health = quote;
    for (let i = 0; i < mangoGroup.numOracles; i++) {
      
      const price = mangoCache.priceCache[i].price;
      const spotHealth = spot[i]
        .mul(price)
      const perpHealth = perps[i]
        .mul(price)

        health.iadd(spotHealth).iadd(perpHealth);
    }

    return health;
  }

  getHealthsFromComponents(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    spot: I80F48[],
    perps: I80F48[],
    quote: I80F48,
    healthType: HealthType,
  ): { spot: I80F48; perp: I80F48 } {
    const spotHealth = quote;
    const perpHealth = quote;
    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const w = getWeights(entropyGroup, i, healthType);
      const price = entropyCache.priceCache[i].price;
      const _spotHealth = spot[i]
        .mul(price)
        .imul(spot[i].isPos() ? w.spotAssetWeight : w.spotLiabWeight);
      const _perpHealth = perps[i]
        .mul(price)
        .imul(perps[i].isPos() ? w.perpAssetWeight : w.perpLiabWeight);

      spotHealth.iadd(_spotHealth);
      perpHealth.iadd(_perpHealth);
    }

    return { spot: spotHealth, perp: perpHealth };
  }
  /**
   * Amount of native quote currency available to expand your position in this market
   */
  getMarketMarginAvailable(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    marketIndex: number,
    marketType: 'spot' | 'perp',
  ): I80F48 {
    const health = this.getHealth(entropyGroup, entropyCache, 'Init');

    if (health.lte(ZERO_I80F48)) {
      return ZERO_I80F48;
    }
    const w = getWeights(entropyGroup, marketIndex, 'Init');
    const weight =
      marketType === 'spot' ? w.spotAssetWeight : w.perpAssetWeight;
    if (weight.gte(ONE_I80F48)) {
      // This is actually an error state and should not happen
      return health;
    } else {
      return health.div(ONE_I80F48.sub(weight));
    }
  }

  /**
   * Get token amount available to withdraw without borrowing.
   */
  getAvailableBalance(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    tokenIndex: number,
  ): I80F48 {
    const health = this.getHealth(entropyGroup, entropyCache, 'Init');
    const net = this.getNet(entropyCache.rootBankCache[tokenIndex], tokenIndex);

    if (tokenIndex === QUOTE_INDEX) {
      return health.min(net).max(ZERO_I80F48);
    } else {
      const w = getWeights(entropyGroup, tokenIndex, 'Init');

      return net
        .min(
          health
            .div(w.spotAssetWeight)
            .div(entropyCache.priceCache[tokenIndex].price),
        )
        .max(ZERO_I80F48);
    }
  }

  /**
   * Return the spot, perps and quote currency values after adjusting for
   * worst case open orders scenarios. These values are not adjusted for health
   * type
   * @param entropyGroup
   * @param entropyCache
   */
  getHealthComponents(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
  ): { spot: I80F48[]; perps: I80F48[]; quote: I80F48 } {
    const spot = Array(entropyGroup.numOracles).fill(ZERO_I80F48);
    const perps = Array(entropyGroup.numOracles).fill(ZERO_I80F48);
    const quote = this.getNet(
      entropyCache.rootBankCache[QUOTE_INDEX],
      QUOTE_INDEX,
    );

    for (let i = 0; i < entropyGroup.numOracles; i++) {
      const bankCache = entropyCache.rootBankCache[i];
      const price = entropyCache.priceCache[i].price;
      const baseNet = this.getNet(bankCache, i);

      // Evaluate spot first
      const openOrders = this.spotOpenOrdersAccounts[i];
      if (this.inMarginBasket[i] && openOrders !== undefined) {
        const { quoteFree, quoteLocked, baseFree, baseLocked } =
          splitOpenOrders(openOrders);

        // base total if all bids were executed
        const bidsBaseNet = baseNet
          .add(quoteLocked.div(price))
          .iadd(baseFree)
          .iadd(baseLocked);

        // base total if all asks were executed
        const asksBaseNet = baseNet.add(baseFree);

        // bids case worse if it has a higher absolute position
        if (bidsBaseNet.abs().gt(asksBaseNet.abs())) {
          spot[i] = bidsBaseNet;
          quote.iadd(quoteFree);
        } else {
          spot[i] = asksBaseNet;
          quote.iadd(baseLocked.mul(price)).iadd(quoteFree).iadd(quoteLocked);
        }
      } else {
        spot[i] = baseNet;
      }

      // Evaluate perps
      if (!entropyGroup.perpMarkets[i].perpMarket.equals(zeroKey)) {
        const perpMarketCache = entropyCache.perpMarketCache[i];
        const perpAccount = this.perpAccounts[i];
        const baseLotSize = entropyGroup.perpMarkets[i].baseLotSize;
        const quoteLotSize = entropyGroup.perpMarkets[i].quoteLotSize;
        const takerQuote = I80F48.fromI64(
          perpAccount.takerQuote.mul(quoteLotSize),
        );
        const basePos = I80F48.fromI64(
          perpAccount.basePosition.add(perpAccount.takerBase).imul(baseLotSize),
        );
        const bidsQuantity = I80F48.fromI64(
          perpAccount.bidsQuantity.mul(baseLotSize),
        );
        const asksQuantity = I80F48.fromI64(
          perpAccount.asksQuantity.mul(baseLotSize),
        );

        const bidsBaseNet = basePos.add(bidsQuantity);
        const asksBaseNet = basePos.sub(asksQuantity);

        if (bidsBaseNet.abs().gt(asksBaseNet.abs())) {
          const quotePos = perpAccount
            .getQuotePosition(perpMarketCache)
            .add(takerQuote)
            .isub(bidsQuantity.mul(price));
          quote.iadd(quotePos);
          perps[i] = bidsBaseNet;
        } else {
          const quotePos = perpAccount
            .getQuotePosition(perpMarketCache)
            .add(takerQuote)
            .iadd(asksQuantity.mul(price));
          quote.iadd(quotePos);
          perps[i] = asksBaseNet;
        }
      } else {
        perps[i] = ZERO_I80F48;
      }
    }

    return { spot, perps, quote };
  }

  getHealth(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    healthType: HealthType,
  ): I80F48 {
    const { spot, perps, quote } = this.getHealthComponents(
      entropyGroup,
      entropyCache,
    );
    const health = this.getHealthFromComponents(
      entropyGroup,
      entropyCache,
      spot,
      perps,
      quote,
      healthType,
    );
    return health;
  }


  getHealthUnweighted(
    mangoGroup: EntropyGroup,
    mangoCache: EntropyCache,
  ): I80F48 {
    const { spot, perps, quote } = this.getHealthComponents(
      mangoGroup,
      mangoCache,
    );
    const health = this.getHealthFromComponentsUnweighted(
      mangoGroup,
      mangoCache,
      spot,
      perps,
      quote,
    );
    return health;
  }

  getHealthRatio(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    healthType: HealthType,
  ): I80F48 {
    const { spot, perps, quote } = this.getHealthComponents(
      entropyGroup,
      entropyCache,
    );

    const { assets, liabs } = this.getWeightedAssetsLiabsVals(
      entropyGroup,
      entropyCache,
      spot,
      perps,
      quote,
      healthType,
    );

    if (liabs.gt(ZERO_I80F48)) {
      return assets.div(liabs).sub(ONE_I80F48).mul(I80F48.fromNumber(100));
    } else {
      return I80F48.fromNumber(100);
    }
  }

  computeValue(entropyGroup: EntropyGroup, entropyCache: EntropyCache): I80F48 {
    return this.getAssetsVal(entropyGroup, entropyCache).sub(
      this.getLiabsVal(entropyGroup, entropyCache),
    );
  }

  getLeverage(entropyGroup: EntropyGroup, entropyCache: EntropyCache): I80F48 {
    const liabs = this.getLiabsVal(entropyGroup, entropyCache);
    const assets = this.getAssetsVal(entropyGroup, entropyCache);

    if (assets.gt(ZERO_I80F48)) {
      return liabs.div(assets.sub(liabs));
    }
    return ZERO_I80F48;
  }

  getMaxLeverageForMarket(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    marketIndex: number,
    market: Market | PerpMarket,
    side: 'buy' | 'sell',
    price: I80F48,
  ): {
    max: I80F48;
    uiDepositVal: I80F48;
    deposits: I80F48;
    uiBorrowVal: I80F48;
    borrows: I80F48;
  } {
    const initHealth = this.getHealth(entropyGroup, entropyCache, 'Init');
    const healthDecimals = I80F48.fromNumber(
      Math.pow(10, entropyGroup.tokens[QUOTE_INDEX].decimals),
    );
    const uiInitHealth = initHealth.div(healthDecimals);

    let uiDepositVal = ZERO_I80F48;
    let uiBorrowVal = ZERO_I80F48;
    let initLiabWeight, initAssetWeight, deposits, borrows;

    if (market instanceof PerpMarket) {
      ({ initLiabWeight, initAssetWeight } =
        entropyGroup.perpMarkets[marketIndex]);

      const basePos = this.perpAccounts[marketIndex].basePosition;

      if (basePos.gt(ZERO_BN)) {
        deposits = I80F48.fromNumber(market.baseLotsToNumber(basePos));
        uiDepositVal = deposits.mul(price);
      } else {
        borrows = I80F48.fromNumber(market.baseLotsToNumber(basePos)).abs();
        uiBorrowVal = borrows.mul(price);
      }
    } else {
      ({ initLiabWeight, initAssetWeight } =
        entropyGroup.spotMarkets[marketIndex]);

      deposits = this.getUiDeposit(
        entropyCache.rootBankCache[marketIndex],
        entropyGroup,
        marketIndex,
      );
      uiDepositVal = deposits.mul(price);

      borrows = this.getUiBorrow(
        entropyCache.rootBankCache[marketIndex],
        entropyGroup,
        marketIndex,
      );
      uiBorrowVal = borrows.mul(price);
    }

    let max;
    if (side === 'buy') {
      const uiHealthAtZero = uiInitHealth.add(
        uiBorrowVal.mul(initLiabWeight.sub(ONE_I80F48)),
      );
      max = uiHealthAtZero
        .div(ONE_I80F48.sub(initAssetWeight))
        .add(uiBorrowVal);
    } else {
      const uiHealthAtZero = uiInitHealth.add(
        uiDepositVal.mul(ONE_I80F48.sub(initAssetWeight)),
      );
      max = uiHealthAtZero
        .div(initLiabWeight.sub(ONE_I80F48))
        .add(uiDepositVal);
    }

    return { max, uiBorrowVal, uiDepositVal, deposits, borrows };
  }

  getMaxWithBorrowForToken(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    tokenIndex: number,
  ): I80F48 {
    const oldInitHealth = this.getHealth(
      entropyGroup,
      entropyCache,
      'Init',
    ).floor();
    const tokenDeposits = this.getNativeDeposit(
      entropyCache.rootBankCache[tokenIndex],
      tokenIndex,
    ).floor();

    let liabWeight, assetWeight, nativePrice;
    if (tokenIndex === QUOTE_INDEX) {
      liabWeight = assetWeight = nativePrice = ONE_I80F48;
    } else {
      liabWeight = entropyGroup.spotMarkets[tokenIndex].initLiabWeight;
      assetWeight = entropyGroup.spotMarkets[tokenIndex].initAssetWeight;
      nativePrice = entropyCache.priceCache[tokenIndex].price;
    }

    const newInitHealth = oldInitHealth
      .sub(tokenDeposits.mul(nativePrice).mul(assetWeight))
      .floor();
    const price = entropyGroup.getPrice(tokenIndex, entropyCache);
    const healthDecimals = I80F48.fromNumber(
      Math.pow(10, entropyGroup.tokens[QUOTE_INDEX].decimals),
    );

    return newInitHealth.div(healthDecimals).div(price.mul(liabWeight));
  }

  isLiquidatable(entropyGroup: EntropyGroup, entropyCache: EntropyCache): boolean {
    return (
      (this.beingLiquidated &&
        this.getHealth(entropyGroup, entropyCache, 'Init').isNeg()) ||
      this.getHealth(entropyGroup, entropyCache, 'Maint').isNeg()
    );
  }

  toPrettyString(
    groupConfig: GroupConfig,
    entropyGroup: EntropyGroup,
    cache: EntropyCache,
  ): string {
    const lines: string[] = [];
    lines.push('EntropyAccount ' + this.publicKey.toBase58());
    lines.push('Owner: ' + this.owner.toBase58());
    // lines.push(
    //   'Maint Health Ratio: ' +
    //     this.getHealthRatio(entropyGroup, cache, 'Maint').toFixed(4),
    // );
    // lines.push(
    //   'Maint Health: ' + this.getHealth(entropyGroup, cache, 'Maint').toFixed(4),
    // );
    // lines.push(
    //   'Init Health: ' + this.getHealth(entropyGroup, cache, 'Init').toFixed(4),
    // );
    lines.push('Equity: ' + this.computeValue(entropyGroup, cache).toFixed(4));
    // lines.push('isBankrupt: ' + this.isBankrupt);
    // lines.push('beingLiquidated: ' + this.beingLiquidated);

    // lines.push('Spot:');
    lines.push('Token: Net Balance / Base In Orders / Quote In Orders');

    const quoteAdj = new BN(10).pow(
      new BN(entropyGroup.tokens[QUOTE_INDEX].decimals),
    );

    for (let i = 0; i < entropyGroup.tokens.length; i++) {
      if (entropyGroup.tokens[i].mint.equals(zeroKey)) {
        continue;
      }
      const token = getTokenByMint(
        groupConfig,
        entropyGroup.tokens[i].mint,
      ) as TokenConfig;

      let baseInOrders = ZERO_BN;
      let quoteInOrders = ZERO_BN;
      const openOrders =
        i !== QUOTE_INDEX ? this.spotOpenOrdersAccounts[i] : undefined;

      if (openOrders) {
        const baseAdj = new BN(10).pow(new BN(entropyGroup.tokens[i].decimals));

        baseInOrders = openOrders.baseTokenTotal.div(baseAdj);
        quoteInOrders = openOrders.quoteTokenTotal
          .add(openOrders['referrerRebatesAccrued'])
          .div(quoteAdj);
      }
      const net = nativeI80F48ToUi(
        this.getNet(cache.rootBankCache[i], i),
        entropyGroup.tokens[i].decimals,
      );

      if (
        net.eq(ZERO_I80F48) &&
        baseInOrders.isZero() &&
        quoteInOrders.isZero()
      ) {
        continue;
      }

      lines.push(
        `${token.symbol}: ${net.toFixed(4)} / ${baseInOrders
          .toNumber()
          .toFixed(4)} / ${quoteInOrders.toNumber().toFixed(4)}`,
      );
    }

    lines.push('Perps:');
    lines.push('Market: Base Pos / Quote Pos / Unsettled Funding / Health');

    for (let i = 0; i < this.perpAccounts.length; i++) {
      if (entropyGroup.perpMarkets[i].perpMarket.equals(zeroKey)) {
        continue;
      }
      const market = getMarketByPublicKey(
        groupConfig,
        entropyGroup.perpMarkets[i].perpMarket,
      ) as PerpMarketConfig;
      if (market === undefined) {
        continue;
      }
      const perpAccount = this.perpAccounts[i];
      const perpMarketInfo = entropyGroup.perpMarkets[i];
      lines.push(
        `${market.name}: ${this.getBasePositionUiWithGroup(
          i,
          entropyGroup,
        ).toFixed(4)} / ${(
          perpAccount.getQuotePosition(cache.perpMarketCache[i]).toNumber() /
          quoteAdj.toNumber()
        ).toFixed(4)} / ${(
          perpAccount.getUnsettledFunding(cache.perpMarketCache[i]).toNumber() /
          quoteAdj.toNumber()
        ).toFixed(4)} / ${perpAccount
          .getHealth(
            perpMarketInfo,
            cache.priceCache[i].price,
            perpMarketInfo.maintAssetWeight,
            perpMarketInfo.maintLiabWeight,
            cache.perpMarketCache[i].longFunding,
            cache.perpMarketCache[i].shortFunding,
          )
          .toFixed(4)}`,
      );
    }
    return lines.join(EOL);
  }

  /**
   * Get all the open orders using only info in EntropyAccount; Does not contain
   * information about the size of the order.
   */
  getPerpOpenOrders(): { marketIndex: number; price: BN; side: string }[] {
    const perpOpenOrders: { marketIndex: number; price: BN; side: string }[] =
      [];

    for (let i = 0; i < this.orders.length; i++) {
      if (this.orderMarket[i] === FREE_ORDER_SLOT) {
        continue;
      }
      perpOpenOrders.push({
        marketIndex: this.orderMarket[i],
        price: getPriceFromKey(this.orders[i]),
        side: this.orderSide[i],
      });
    }
    return perpOpenOrders;
  }

  /**
   * Return the open orders keys in basket and replace open orders not in basket with zero key
   */
  getOpenOrdersKeysInBasket(): PublicKey[] {
    return this.spotOpenOrders.map((pk, i) =>
      this.inMarginBasket[i] ? pk : zeroKey,
    );
  }

  /**
   *  Return the current position for the market at `marketIndex` in UI units
   *  e.g. if you buy 1 BTC in the UI, you're buying 1,000,000 native BTC,
   *  10,000 BTC-PERP contracts and exactly 1 BTC in UI
   *  Find the marketIndex in the ids.json list of perp markets
   */
  getPerpPositionUi(marketIndex: number, perpMarket: PerpMarket): number {
    return this.perpAccounts[marketIndex].getBasePositionUi(perpMarket);
  }
  /**
   *  Return the current position for the market at `marketIndex` in UI units
   *  e.g. if you buy 1 BTC in the UI, you're buying 1,000,000 native BTC,
   *  10,000 BTC-PERP contracts and exactly 1 BTC in UI
   *  Find the marketIndex in the ids.json list of perp markets
   */
  getBasePositionUiWithGroup(marketIndex: number, group: EntropyGroup): number {
    return (
      this.perpAccounts[marketIndex].basePosition
        .mul(group.perpMarkets[marketIndex].baseLotSize)
        .toNumber() / Math.pow(10, group.tokens[marketIndex].decimals)
    );
  }

  /**
   * Return the equity in standard UI numbers. E.g. if equity is $100, this returns 100
   */
  getEquityUi(entropyGroup: EntropyGroup, entropyCache: EntropyCache): number {
    return (
      this.computeValue(entropyGroup, entropyCache).toNumber() /
      Math.pow(10, entropyGroup.tokens[QUOTE_INDEX].decimals)
    );
  }

  /**
   * This is the init health divided by quote decimals
   */
  getCollateralValueUi(entropyGroup: EntropyGroup, entropyCache: EntropyCache): number {
    return (
      this.getHealth(entropyGroup, entropyCache, 'Init').toNumber() /
      Math.pow(10, entropyGroup.tokens[QUOTE_INDEX].decimals)
    );
  }
}

export type HealthType = 'Init' | 'Maint';

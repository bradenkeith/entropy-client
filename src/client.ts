import {
  Account,
  AccountInfo,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SimulatedTransactionResponse,
  SystemProgram,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
} from '@solana/web3.js';
import BN from 'bn.js';
import {
  createAccountInstruction,
  createSignerKeyAndNonce,
  createTokenAccountInstructions,
  getFilteredProgramAccounts,
  getMultipleAccounts,
  nativeToUi,
  promiseUndef,
  simulateTransaction,
  sleep,
  uiToNative,
  ZERO_BN,
  zeroKey,
} from './utils';
import {
  AssetType,
  BookSideLayout,
  FREE_ORDER_SLOT,
  EntropyAccountLayout,
  EntropyCache,
  EntropyCacheLayout,
  EntropyGroupLayout,
  NodeBankLayout,
  PerpEventLayout,
  PerpEventQueueHeaderLayout,
  PerpMarketLayout,
  QUOTE_INDEX,
  RootBankLayout,
  StubOracleLayout,
} from './layout';
import EntropyAccount from './EntropyAccount';
import PerpMarket from './PerpMarket';
import RootBank from './RootBank';
import {
  makeAddEntropyAccountInfoInstruction,
  makeAddOracleInstruction,
  makeAddPerpMarketInstruction,
  makeAddPerpTriggerOrderInstruction,
  makeAddSpotMarketInstruction,
  makeCachePerpMarketsInstruction,
  makeCachePricesInstruction,
  makeCacheRootBankInstruction,
  makeCancelAllPerpOrdersInstruction,
  makeCancelPerpOrderInstruction,
  makeCancelSpotOrderInstruction,
  makeChangePerpMarketParams2Instruction,
  makeChangePerpMarketParamsInstruction,
  makeConsumeEventsInstruction,
  makeCreatePerpMarketInstruction,
  makeDepositInstruction,
  makeDepositMsrmInstruction,
  makeExecutePerpTriggerOrderInstruction,
  makeForceCancelPerpOrdersInstruction,
  makeForceCancelSpotOrdersInstruction,
  makeInitAdvancedOrdersInstruction,
  makeInitEntropyAccountInstruction,
  makeInitEntropyGroupInstruction,
  makeInitSpotOpenOrdersInstruction,
  makeLiquidatePerpMarketInstruction,
  makeLiquidateTokenAndPerpInstruction,
  makeLiquidateTokenAndTokenInstruction,
  makePlacePerpOrderInstruction,
  makePlaceSpotOrder2Instruction,
  makePlaceSpotOrderInstruction,
  makeRedeemMngoInstruction,
  makeRemoveAdvancedOrderInstruction,
  makeResolvePerpBankruptcyInstruction,
  makeResolveTokenBankruptcyInstruction,
  makeSetGroupAdminInstruction,
  makeSetOracleInstruction,
  makeSettleFeesInstruction,
  makeSettleFundsInstruction,
  makeSettlePnlInstruction,
  makeUpdateFundingInstruction,
  makeUpdateMarginBasketInstruction,
  makeUpdateRootBankInstruction,
  makeWithdrawInstruction,
  makeWithdrawMsrmInstruction,
} from './instruction';
import {
  getFeeRates,
  getFeeTier,
  Market,
  OpenOrders,
} from '@project-serum/serum';
import { I80F48, ZERO_I80F48 } from './fixednum';
import { Order } from '@project-serum/serum/lib/market';

import { PerpOrderType, WalletAdapter } from './types';
import { BookSide, PerpOrder } from './book';
import {
  closeAccount,
  initializeAccount,
  WRAPPED_SOL_MINT,
} from '@project-serum/serum/lib/token-instructions';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import EntropyGroup from './EntropyGroup';
import { EntropyError, TimeoutError } from '.';
import { makeChangeMaxEntropyAccountsInstruction } from './instruction';

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
};

/**
 * A class for interacting with the Entropy V3 Program
 *
 * @param connection A solana web.js Connection object
 * @param programId The PublicKey of the Entropy V3 Program
 * @param opts An object used to configure the EntropyClient. Accepts a postSendTxCallback
 */
export class EntropyClient {
  connection: Connection;
  programId: PublicKey;
  lastSlot: number;
  postSendTxCallback?: ({ txid: string }) => void;

  constructor(
    connection: Connection,
    programId: PublicKey,
    opts: { postSendTxCallback?: ({ txid }: { txid: string }) => void } = {},
  ) {
    this.connection = connection;
    this.programId = programId;
    this.lastSlot = 0;
    if (opts.postSendTxCallback) {
      this.postSendTxCallback = opts.postSendTxCallback;
    }
    // console.log("Program Id from client.ts")
  }

  async sendTransactions(
    transactions: Transaction[],
    payer: Account | WalletAdapter,
    additionalSigners: Account[],
    timeout = 60000,
    confirmLevel: TransactionConfirmationStatus = 'confirmed',
  ): Promise<TransactionSignature[]> {
    return await Promise.all(
      transactions.map((tx) =>
        this.sendTransaction(
          tx,
          payer,
          additionalSigners,
          timeout,
          confirmLevel,
        ),
      ),
    );
  }

  async signTransaction({ transaction, payer, signers }) {
    transaction.recentBlockhash = (
      await this.connection.getRecentBlockhash()
    ).blockhash;
    transaction.setSigners(payer.publicKey, ...signers.map((s) => s.publicKey));
    if (signers.length > 0) {
      transaction.partialSign(...signers);
    }

    if (payer?.connected) {
      console.log(new Date().toISOString(), 'signing as wallet', payer.publicKey);
      return await payer.signTransaction(transaction);
    } else {
      transaction.sign(...[payer].concat(signers));
    }
  }

  async signTransactions({
    transactionsAndSigners,
    payer,
  }: {
    transactionsAndSigners: {
      transaction: Transaction;
      signers?: Array<Account>;
    }[];
    payer: Account | WalletAdapter;
  }) {
    const blockhash = (await this.connection.getRecentBlockhash('max'))
      .blockhash;
    transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
      transaction.recentBlockhash = blockhash;
      transaction.setSigners(
        payer.publicKey,
        ...signers.map((s) => s.publicKey),
      );
      if (signers?.length > 0) {
        transaction.partialSign(...signers);
      }
    });
    if (!(payer instanceof Account)) {
      return await payer.signAllTransactions(
        transactionsAndSigners.map(({ transaction }) => transaction),
      );
    } else {
      transactionsAndSigners.forEach(({ transaction, signers }) => {
        // @ts-ignore
        transaction.sign(...[payer].concat(signers));
      });
    }
  }

  // TODO - switch Account to Keypair and switch off setSigners due to deprecated
  /**
   * Send a transaction using the Solana Web3.js connection on the entropy client
   *
   * @param transaction
   * @param payer
   * @param additionalSigners
   * @param timeout Retries sending the transaction and trying to confirm it until the given timeout. Defaults to 60000ms. Passing null will disable the transaction confirmation check and always return success.
   */
  async sendTransaction(
    transaction: Transaction,
    payer: Account | WalletAdapter | Keypair,
    additionalSigners: Account[],
    timeout: number | null = 60000,
    confirmLevel: TransactionConfirmationStatus = 'processed',
    marketName?: string | null
  ): Promise<TransactionSignature> {
    await this.signTransaction({
      transaction,
      payer,
      signers: additionalSigners,
    });

    const rawTransaction = transaction.serialize();
    const startTime = getUnixTs();

    const txid: TransactionSignature = await this.connection.sendRawTransaction(
      rawTransaction,
      { skipPreflight: true },
    );

    if (this.postSendTxCallback) {
      try {
        this.postSendTxCallback({ txid });
      } catch (e) {
        console.log(new Date().toISOString(), `${marketName} postSendTxCallback error ${e}`);
      }
    }

    // console.log('checking timeout');

    if (!timeout) return txid;

    console.log(new Date().toISOString(), `${marketName} Started awaiting confirmation for txid: `, txid, ' size:', rawTransaction.length);

    let done = false;
    let retryCount = 0;
    const retrySleep = 2000;
    (async () => {
      // TODO - make sure this works well on mainnet
      while (!done && getUnixTs() - startTime < timeout / 1000) {
        retryCount += 1;
        await sleep(retrySleep);
        console.log(new Date().toISOString(), `${marketName}: sending tx `, txid);
        console.log("Retry Count: ", retryCount);
        this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
      }
    })();

    try {
      await this.awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        confirmLevel,
      );
    } catch (err: any) {
      if (err.timeout) {
        throw new TimeoutError({ txid });
      }
      let simulateResult: SimulatedTransactionResponse | null = null;
      try {
        simulateResult = (
          await simulateTransaction(this.connection, transaction, 'processed')
        ).value;
      } catch (e) {
        console.warn('Simulate transaction failed');
      }

      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
            const line = simulateResult.logs[i];
            if (line.startsWith('Program log: ')) {
              throw new EntropyError({
                message:
                  new Date().toISOString() + `${marketName} Transaction failed: ` + line.slice('Program log: '.length),
                txid,
              });
            }
          }
        }
        throw new EntropyError({
          message: JSON.stringify(simulateResult.err),
          txid,
        });
      }
      throw new EntropyError({
        message: new Date().toISOString() + ' Transaction failed', txid
      });
    } finally {
      done = true;
    }

    console.log(new Date().toISOString(), `${marketName} Transaction Latency for txid: `, txid, getUnixTs() - startTime);
    return txid;
  }

  async sendSignedTransaction({
    signedTransaction,
    timeout = 60000,
    confirmLevel = 'processed',
  }: {
    signedTransaction: Transaction;
    timeout?: number;
    confirmLevel?: TransactionConfirmationStatus;
  }): Promise<TransactionSignature> {
    const rawTransaction = signedTransaction.serialize();
    const startTime = getUnixTs();

    const txid: TransactionSignature = await this.connection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: true,
      },
    );

    if (this.postSendTxCallback) {
      try {
        this.postSendTxCallback({ txid });
      } catch (e) {
        console.log(new Date().toISOString(), `postSendTxCallback error ${e}`);
      }
    }

    // console.log('Started awaiting confirmation for', txid);

    let done = false;
    (async () => {
      await sleep(500);
      while (!done && getUnixTs() - startTime < timeout) {
        this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        });
        await sleep(1000);
      }
    })();
    try {
      await this.awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        confirmLevel,
      );
    } catch (err: any) {
      if (err.timeout) {
        throw new TimeoutError({ txid });
      }
      let simulateResult: SimulatedTransactionResponse | null = null;
      try {
        simulateResult = (
          await simulateTransaction(
            this.connection,
            signedTransaction,
            'single',
          )
        ).value;
      } catch (e) {
        console.log(new Date().toISOString(), 'Simulate tx failed');
      }
      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
            const line = simulateResult.logs[i];
            if (line.startsWith('Program log: ')) {
              throw new EntropyError({
                message:
                  'Transaction failed: ' + line.slice('Program log: '.length),
                txid,
              });
            }
          }
        }
        throw new EntropyError({
          message: JSON.stringify(simulateResult.err),
          txid,
        });
      }
      throw new EntropyError({ message: 'Transaction failed', txid });
    } finally {
      done = true;
    }

    console.log(new Date().toISOString(), 'Transaction Latency for txid: ', txid, getUnixTs() - startTime);
    return txid;
  }

  async awaitTransactionSignatureConfirmation(
    txid: TransactionSignature,
    timeout: number,
    confirmLevel: TransactionConfirmationStatus,
  ) {
    let done = false;

    const confirmLevels: (TransactionConfirmationStatus | null | undefined)[] =
      ['finalized'];

    if (confirmLevel === 'confirmed') {
      confirmLevels.push('confirmed');
    } else if (confirmLevel === 'processed') {
      confirmLevels.push('confirmed');
      confirmLevels.push('processed');
    }
    let subscriptionId;

    const result = await new Promise((resolve, reject) => {
      (async () => {
        setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          console.log(new Date().toISOString(), 'Timed out for txid: ', txid);
          reject({ timeout: true });
        }, timeout);
        try {
          subscriptionId = this.connection.onSignature(
            txid,
            (result, context) => {
              subscriptionId = undefined;
              done = true;
              if (result.err) {
                reject(result.err);
              } else {
                this.lastSlot = context?.slot;
                resolve(result);
              }
            },
            'processed',
          );
        } catch (e) {
          done = true;
          console.log(new Date().toISOString(), 'WS error in setup', txid, e);
        }
        let retrySleep = 200;
        while (!done) {
          // eslint-disable-next-line no-loop-func
          await sleep(retrySleep);
          (async () => {
            try {
              const response = await this.connection.getSignatureStatuses([
                txid,
              ]);

              const result = response && response.value[0];
              if (!done) {
                if (!result) {
                  // console.log('REST null result for', txid, result);
                } else if (result.err) {
                  console.log(new Date().toISOString(), 'REST error for', txid, result);
                  done = true;
                  reject(result.err);
                } else if (
                  !(
                    result.confirmations ||
                    confirmLevels.includes(result.confirmationStatus)
                  )
                ) {
                  console.log(new Date().toISOString(), 'REST not confirmed', txid, result);
                } else {
                  this.lastSlot = response?.context?.slot;
                  // console.log('REST confirmed', txid, result);
                  done = true;
                  resolve(result);
                }
              }
            } catch (e) {
              if (!done) {
                console.log(new Date().toISOString(), 'REST connection error: txid', txid, e);
              }
            }
          })();
          if (retrySleep <= 1600) {
            retrySleep = retrySleep * 2;
          }
        }
      })();
    });

    if (subscriptionId) {
      this.connection.removeSignatureListener(subscriptionId).catch((e) => {
        console.log(new Date().toISOString(), 'WS error in cleanup', e);
      });
    }

    done = true;
    return result;
  }

  /**
   * Create a new Entropy group
   */
  async initEntropyGroup(
    quoteMint: PublicKey,
    msrmMint: PublicKey,
    dexProgram: PublicKey,
    feesVault: PublicKey, // owned by Entropy DAO token governance
    validInterval: number,
    quoteOptimalUtil: number,
    quoteOptimalRate: number,
    quoteMaxRate: number,
    payer: Account | WalletAdapter,
  ): Promise<PublicKey> {
    const accountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      EntropyGroupLayout.span,
      this.programId,
    );
    const { signerKey, signerNonce } = await createSignerKeyAndNonce(
      this.programId,
      accountInstruction.account.publicKey,
    );
    const quoteVaultAccount = new Account();

    const quoteVaultAccountInstructions = await createTokenAccountInstructions(
      this.connection,
      payer.publicKey,
      quoteVaultAccount.publicKey,
      quoteMint,
      signerKey,
    );

    const insuranceVaultAccount = new Account();
    const insuranceVaultAccountInstructions =
      await createTokenAccountInstructions(
        this.connection,
        payer.publicKey,
        insuranceVaultAccount.publicKey,
        quoteMint,
        signerKey,
      );

    const quoteNodeBankAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      NodeBankLayout.span,
      this.programId,
    );
    const quoteRootBankAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      RootBankLayout.span,
      this.programId,
    );
    const cacheAccountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      EntropyCacheLayout.span,
      this.programId,
    );

    const createAccountsTransaction = new Transaction();
    createAccountsTransaction.add(accountInstruction.instruction);
    createAccountsTransaction.add(...quoteVaultAccountInstructions);
    createAccountsTransaction.add(quoteNodeBankAccountInstruction.instruction);
    createAccountsTransaction.add(quoteRootBankAccountInstruction.instruction);
    createAccountsTransaction.add(cacheAccountInstruction.instruction);
    createAccountsTransaction.add(...insuranceVaultAccountInstructions);

    const signers = [
      accountInstruction.account,
      quoteVaultAccount,
      quoteNodeBankAccountInstruction.account,
      quoteRootBankAccountInstruction.account,
      cacheAccountInstruction.account,
      insuranceVaultAccount,
    ];
    await this.sendTransaction(createAccountsTransaction, payer, signers);

    // If valid msrmMint passed in, then create new msrmVault
    let msrmVaultPk;
    if (!msrmMint.equals(zeroKey)) {
      const msrmVaultAccount = new Account();
      const msrmVaultAccountInstructions = await createTokenAccountInstructions(
        this.connection,
        payer.publicKey,
        msrmVaultAccount.publicKey,
        msrmMint,
        signerKey,
      );
      const createMsrmVaultTransaction = new Transaction();
      createMsrmVaultTransaction.add(...msrmVaultAccountInstructions);
      msrmVaultPk = msrmVaultAccount.publicKey;
      await this.sendTransaction(createMsrmVaultTransaction, payer, [
        msrmVaultAccount,
      ]);
    } else {
      msrmVaultPk = zeroKey;
    }

    const initEntropyGroupInstruction = makeInitEntropyGroupInstruction(
      this.programId,
      accountInstruction.account.publicKey,
      signerKey,
      payer.publicKey,
      quoteMint,
      quoteVaultAccount.publicKey,
      quoteNodeBankAccountInstruction.account.publicKey,
      quoteRootBankAccountInstruction.account.publicKey,
      insuranceVaultAccount.publicKey,
      msrmVaultPk,
      feesVault,
      cacheAccountInstruction.account.publicKey,
      dexProgram,
      new BN(signerNonce),
      new BN(validInterval),
      I80F48.fromNumber(quoteOptimalUtil),
      I80F48.fromNumber(quoteOptimalRate),
      I80F48.fromNumber(quoteMaxRate),
    );

    const initEntropyGroupTransaction = new Transaction();
    initEntropyGroupTransaction.add(initEntropyGroupInstruction);
    await this.sendTransaction(initEntropyGroupTransaction, payer, []);

    return accountInstruction.account.publicKey;
  }

  /**
   * Retrieve information about a Entropy Group
   */
  async getEntropyGroup(entropyGroup: PublicKey): Promise<EntropyGroup> {
    const accountInfo = await this.connection.getAccountInfo(entropyGroup);
    const decoded = EntropyGroupLayout.decode(
      accountInfo == null ? undefined : accountInfo.data,
    );

    return new EntropyGroup(entropyGroup, decoded);
  }

  /**
   * Create a new Entropy Account on a given group
   */
  async initEntropyAccount(
    entropyGroup: EntropyGroup,
    owner: Account | WalletAdapter,
  ): Promise<PublicKey> {
    const accountInstruction = await createAccountInstruction(
      this.connection,
      owner.publicKey,
      EntropyAccountLayout.span,
      this.programId,
    );

    const initEntropyAccountInstruction = makeInitEntropyAccountInstruction(
      this.programId,
      entropyGroup.publicKey,
      accountInstruction.account.publicKey,
      owner.publicKey,
    );

    // Add all instructions to one atomic transaction
    const transaction = new Transaction();
    transaction.add(accountInstruction.instruction);
    transaction.add(initEntropyAccountInstruction);

    const additionalSigners = [accountInstruction.account];
    await this.sendTransaction(transaction, owner, additionalSigners);

    return accountInstruction.account.publicKey;
  }

  /**
   * Retrieve information about a Entropy Account
   */
  async getEntropyAccount(
    entropyAccountPk: PublicKey,
    dexProgramId: PublicKey,
  ): Promise<EntropyAccount> {
    const acc = await this.connection.getAccountInfo(
      entropyAccountPk,
      'processed',
    );
    const entropyAccount = new EntropyAccount(
      entropyAccountPk,
      EntropyAccountLayout.decode(acc == null ? undefined : acc.data),
    );
    await entropyAccount.loadOpenOrders(this.connection, dexProgramId);
    return entropyAccount;
  }

  /**
   * Create a new Entropy Account and deposit some tokens in a single transaction
   *
   * @param rootBank The RootBank for the deposit currency
   * @param nodeBank The NodeBank asociated with the RootBank
   * @param vault The token account asociated with the NodeBank
   * @param tokenAcc The token account to transfer from
   * @param info An optional UI name for the account
   */
  async initEntropyAccountAndDeposit(
    entropyGroup: EntropyGroup,
    owner: Account | WalletAdapter,
    rootBank: PublicKey,
    nodeBank: PublicKey,
    vault: PublicKey,
    tokenAcc: PublicKey,

    quantity: number,
    info?: string,
  ): Promise<string> {
    const transaction = new Transaction();
    const accountInstruction = await createAccountInstruction(
      this.connection,
      owner.publicKey,
      EntropyAccountLayout.span,
      this.programId,
    );

    const initEntropyAccountInstruction = makeInitEntropyAccountInstruction(
      this.programId,
      entropyGroup.publicKey,
      accountInstruction.account.publicKey,
      owner.publicKey,
    );

    transaction.add(accountInstruction.instruction);
    transaction.add(initEntropyAccountInstruction);

    const additionalSigners = [accountInstruction.account];

    const tokenIndex = entropyGroup.getRootBankIndex(rootBank);
    const tokenMint = entropyGroup.tokens[tokenIndex].mint;

    let wrappedSolAccount: Account | null = null;
    if (
      tokenMint.equals(WRAPPED_SOL_MINT) &&
      tokenAcc.toBase58() === owner.publicKey.toBase58()
    ) {
      wrappedSolAccount = new Account();
      const lamports = Math.round(quantity * LAMPORTS_PER_SOL) + 1e7;
      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: wrappedSolAccount.publicKey,
          lamports,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
      );

      transaction.add(
        initializeAccount({
          account: wrappedSolAccount.publicKey,
          mint: WRAPPED_SOL_MINT,
          owner: owner.publicKey,
        }),
      );

      additionalSigners.push(wrappedSolAccount);
    }

    const nativeQuantity = uiToNative(
      quantity,
      entropyGroup.tokens[tokenIndex].decimals,
    );

    const instruction = makeDepositInstruction(
      this.programId,
      entropyGroup.publicKey,
      owner.publicKey,
      entropyGroup.entropyCache,
      accountInstruction.account.publicKey,
      rootBank,
      nodeBank,
      vault,
      wrappedSolAccount?.publicKey ?? tokenAcc,
      nativeQuantity,
    );
    transaction.add(instruction);

    if (info) {
      const addAccountNameinstruction = makeAddEntropyAccountInfoInstruction(
        this.programId,
        entropyGroup.publicKey,
        accountInstruction.account.publicKey,
        owner.publicKey,
        info,
      );
      transaction.add(addAccountNameinstruction);
    }

    if (wrappedSolAccount) {
      transaction.add(
        closeAccount({
          source: wrappedSolAccount.publicKey,
          destination: owner.publicKey,
          owner: owner.publicKey,
        }),
      );
    }

    await this.sendTransaction(transaction, owner, additionalSigners);

    return accountInstruction.account.publicKey.toString();
  }

  /**
   * Deposit tokens in a Entropy Account
   *
   * @param rootBank The RootBank for the deposit currency
   * @param nodeBank The NodeBank asociated with the RootBank
   * @param vault The token account asociated with the NodeBank
   * @param tokenAcc The token account to transfer from
   */
  async deposit(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    rootBank: PublicKey,
    nodeBank: PublicKey,
    vault: PublicKey,
    tokenAcc: PublicKey,

    quantity: number,
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const additionalSigners: Array<Account> = [];
    const tokenIndex = entropyGroup.getRootBankIndex(rootBank);
    const tokenMint = entropyGroup.tokens[tokenIndex].mint;

    let wrappedSolAccount: Account | null = null;
    if (
      tokenMint.equals(WRAPPED_SOL_MINT) &&
      tokenAcc.toBase58() === owner.publicKey.toBase58()
    ) {
      wrappedSolAccount = new Account();
      const lamports = Math.round(quantity * LAMPORTS_PER_SOL) + 1e7;
      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: wrappedSolAccount.publicKey,
          lamports,
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
      );

      transaction.add(
        initializeAccount({
          account: wrappedSolAccount.publicKey,
          mint: WRAPPED_SOL_MINT,
          owner: owner.publicKey,
        }),
      );

      additionalSigners.push(wrappedSolAccount);
    }

    const nativeQuantity = uiToNative(
      quantity,
      entropyGroup.tokens[tokenIndex].decimals,
    );

    const instruction = makeDepositInstruction(
      this.programId,
      entropyGroup.publicKey,
      owner.publicKey,
      entropyGroup.entropyCache,
      entropyAccount.publicKey,
      rootBank,
      nodeBank,
      vault,
      wrappedSolAccount?.publicKey ?? tokenAcc,
      nativeQuantity,
    );

    transaction.add(instruction);

    if (wrappedSolAccount) {
      transaction.add(
        closeAccount({
          source: wrappedSolAccount.publicKey,
          destination: owner.publicKey,
          owner: owner.publicKey,
        }),
      );
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  /**
   * Deposit tokens in a Entropy Account
   *
   * @param rootBank The RootBank for the withdrawn currency
   * @param nodeBank The NodeBank asociated with the RootBank
   * @param vault The token account asociated with the NodeBank
   * @param allowBorrow Whether to borrow tokens if there are not enough deposits for the withdrawal
   */
  async withdraw(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    rootBank: PublicKey,
    nodeBank: PublicKey,
    vault: PublicKey,

    quantity: number,
    allowBorrow: boolean,
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const additionalSigners: Account[] = [];
    const tokenIndex = entropyGroup.getRootBankIndex(rootBank);
    const tokenMint = entropyGroup.tokens[tokenIndex].mint;

    let tokenAcc = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      tokenMint,
      owner.publicKey,
    );

    let wrappedSolAccount: Account | null = null;
    if (tokenMint.equals(WRAPPED_SOL_MINT)) {
      wrappedSolAccount = new Account();
      tokenAcc = wrappedSolAccount.publicKey;
      const space = 165;
      const lamports = await this.connection.getMinimumBalanceForRentExemption(
        space,
        'processed',
      );
      transaction.add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: tokenAcc,
          lamports,
          space,
          programId: TOKEN_PROGRAM_ID,
        }),
      );
      transaction.add(
        initializeAccount({
          account: tokenAcc,
          mint: WRAPPED_SOL_MINT,
          owner: owner.publicKey,
        }),
      );
      additionalSigners.push(wrappedSolAccount);
    } else {
      const tokenAccExists = await this.connection.getAccountInfo(
        tokenAcc,
        'recent',
      );
      if (!tokenAccExists) {
        transaction.add(
          Token.createAssociatedTokenAccountInstruction(
            ASSOCIATED_TOKEN_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
            tokenMint,
            tokenAcc,
            owner.publicKey,
            owner.publicKey,
          ),
        );
      }
    }

    const nativeQuantity = uiToNative(
      quantity,
      entropyGroup.tokens[tokenIndex].decimals,
    );

    const instruction = makeWithdrawInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyGroup.entropyCache,
      rootBank,
      nodeBank,
      vault,
      tokenAcc,
      entropyGroup.signerKey,
      entropyAccount.spotOpenOrders,
      nativeQuantity,
      allowBorrow,
    );
    transaction.add(instruction);

    if (wrappedSolAccount) {
      transaction.add(
        closeAccount({
          source: wrappedSolAccount.publicKey,
          destination: owner.publicKey,
          owner: owner.publicKey,
        }),
      );
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async changeMaxAccounts(
    entropyGroupPk: PublicKey,
    admin: Account,
    numAccounts: BN
  ) {
    console.log('num accounts = ', numAccounts.toString());
    const instruction = makeChangeMaxEntropyAccountsInstruction(
      this.programId,
      entropyGroupPk,
      admin.publicKey,
      numAccounts,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  /**
   * Called by the Keeper to cache interest rates from the RootBanks
   */
  async cacheRootBanks(
    entropyGroup: PublicKey,
    entropyCache: PublicKey,
    rootBanks: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const cacheRootBanksInstruction = makeCacheRootBankInstruction(
      this.programId,
      entropyGroup,
      entropyCache,
      rootBanks,
    );

    const transaction = new Transaction();
    transaction.add(cacheRootBanksInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Called by the Keeper to cache prices from the Oracles
   */
  async cachePrices(
    entropyGroup: PublicKey,
    entropyCache: PublicKey,
    oracles: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const cachePricesInstruction = makeCachePricesInstruction(
      this.programId,
      entropyGroup,
      entropyCache,
      oracles,
    );

    const transaction = new Transaction();
    transaction.add(cachePricesInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Called by the Keeper to cache perp market funding
   */
  async cachePerpMarkets(
    entropyGroup: PublicKey,
    entropyCache: PublicKey,
    perpMarkets: PublicKey[],
    payer: Account,
  ): Promise<TransactionSignature> {
    const cachePerpMarketsInstruction = makeCachePerpMarketsInstruction(
      this.programId,
      entropyGroup,
      entropyCache,
      perpMarkets,
    );

    const transaction = new Transaction();
    transaction.add(cachePerpMarketsInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Called by the Keeper to update interest rates on the RootBanks
   */
  async updateRootBank(
    entropyGroup: EntropyGroup,
    rootBank: PublicKey,
    nodeBanks: PublicKey[],
    payer: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const updateRootBanksInstruction = makeUpdateRootBankInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      rootBank,
      nodeBanks,
    );

    const transaction = new Transaction();
    transaction.add(updateRootBanksInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Called by the Keeper to process events on the Perp order book
   */
  async consumeEvents(
    entropyGroup: EntropyGroup,
    perpMarket: PerpMarket,
    entropyAccounts: PublicKey[],
    payer: Account,
    limit: BN,
  ): Promise<TransactionSignature> {
    const consumeEventsInstruction = makeConsumeEventsInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      perpMarket.publicKey,
      perpMarket.eventQueue,
      entropyAccounts,
      limit,
    );

    const transaction = new Transaction();
    transaction.add(consumeEventsInstruction);

    return await this.sendTransaction(transaction, payer, [], null);
  }

  /**
   * Called by the Keeper to update funding on the perp markets
   */
  async updateFunding(
    entropyGroup: PublicKey,
    entropyCache: PublicKey,
    perpMarket: PublicKey,
    bids: PublicKey,
    asks: PublicKey,
    payer: Account,
  ): Promise<TransactionSignature> {
    const updateFundingInstruction = makeUpdateFundingInstruction(
      this.programId,
      entropyGroup,
      entropyCache,
      perpMarket,
      bids,
      asks,
    );

    const transaction = new Transaction();
    transaction.add(updateFundingInstruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Retrieve information about a perp market
   */
  async getPerpMarket(
    perpMarketPk: PublicKey,
    baseDecimal: number,
    quoteDecimal: number,
  ): Promise<PerpMarket> {
    const acc = await this.connection.getAccountInfo(perpMarketPk);
    const perpMarket = new PerpMarket(
      perpMarketPk,
      baseDecimal,
      quoteDecimal,
      PerpMarketLayout.decode(acc?.data),
    );
    return perpMarket;
  }

  /**
   * Place an order on a perp market
   *
   * @param clientOrderId An optional id that can be used to correlate events related to your order
   * @param bookSideInfo Account info for asks if side === bid, bids if side === ask. If this is given, crank instruction is added
   */
  async placePerpOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    entropyCache: PublicKey, // TODO - remove; already in EntropyGroup
    perpMarket: PerpMarket,
    owner: Account | WalletAdapter,

    side: 'buy' | 'sell',
    price: number,
    quantity: number,
    orderType?: PerpOrderType,
    clientOrderId = 0,
    bookSideInfo?: AccountInfo<Buffer>,
    reduceOnly?: boolean,
  ): Promise<TransactionSignature> {
    const [nativePrice, nativeQuantity] = perpMarket.uiToNativePriceQuantity(
      price,
      quantity,
    );
    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    const instruction = makePlacePerpOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyCache,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      perpMarket.eventQueue,
      entropyAccount.spotOpenOrders,
      nativePrice,
      nativeQuantity,
      new BN(clientOrderId),
      side,
      orderType,
      reduceOnly,
    );
    transaction.add(instruction);

    if (bookSideInfo) {
      const bookSide = bookSideInfo.data
        ? new BookSide(
          side === 'buy' ? perpMarket.asks : perpMarket.bids,
          perpMarket,
          BookSideLayout.decode(bookSideInfo.data),
        )
        : [];
      const accounts: Set<string> = new Set();
      accounts.add(entropyAccount.publicKey.toBase58());

      for (const order of bookSide) {
        accounts.add(order.owner.toBase58());
        if (accounts.size >= 10) {
          break;
        }
      }

      const consumeInstruction = makeConsumeEventsInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyGroup.entropyCache,
        perpMarket.publicKey,
        perpMarket.eventQueue,
        Array.from(accounts)
          .map((s) => new PublicKey(s))
          .sort(),
        new BN(4),
      );
      transaction.add(consumeInstruction);
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  /**
   * Cancel an order on a perp market
   *
   * @param invalidIdOk Don't throw error if order is invalid
   */
  async cancelPerpOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    perpMarket: PerpMarket,
    order: PerpOrder,
    invalidIdOk = false,
  ): Promise<TransactionSignature> {
    const instruction = makeCancelPerpOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      order,
      invalidIdOk,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  /**
   * Cancel all perp orders across all markets
   */
  async cancelAllPerpOrders(
    group: EntropyGroup,
    perpMarkets: PerpMarket[],
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
  ): Promise<TransactionSignature[]> {
    let tx = new Transaction();
    const transactions: Transaction[] = [];

    // Determine which market indexes have open orders
    const hasOrders = new Array(group.perpMarkets.length).fill(false);
    for (let i = 0; i < entropyAccount.orderMarket.length; i++) {
      if (entropyAccount.orderMarket[i] !== FREE_ORDER_SLOT) {
        hasOrders[entropyAccount.orderMarket[i]] = true;
      }
    }

    for (let i = 0; i < group.perpMarkets.length; i++) {
      if (!hasOrders[i]) continue;

      const pmi = group.perpMarkets[i];
      if (pmi.isEmpty()) continue;
      const perpMarket = perpMarkets.find((pm) =>
        pm.publicKey.equals(pmi.perpMarket),
      );
      if (perpMarket === undefined) continue;

      const cancelAllInstr = makeCancelAllPerpOrdersInstruction(
        this.programId,
        group.publicKey,
        entropyAccount.publicKey,
        owner.publicKey,
        perpMarket.publicKey,
        perpMarket.bids,
        perpMarket.asks,
        new BN(20),
      );
      tx.add(cancelAllInstr);
      if (tx.instructions.length === 2) {
        transactions.push(tx);
        tx = new Transaction();
      }
    }
    if (tx.instructions.length > 0) {
      transactions.push(tx);
    }

    const transactionsAndSigners = transactions.map((tx) => ({
      transaction: tx,
      signers: [],
    }));

    if (transactionsAndSigners.length === 0) {
      throw new Error('No orders to cancel');
    }

    // Sign multiple transactions at once for better UX
    const signedTransactions = await this.signTransactions({
      transactionsAndSigners,
      payer: owner,
    });

    if (signedTransactions) {
      return await Promise.all(
        signedTransactions.map((signedTransaction) =>
          this.sendSignedTransaction({ signedTransaction }),
        ),
      );
    } else {
      throw new Error('Unable to sign all CancelAllPerpOrders transactions');
    }
  }
  /*
  async loadPerpMarkets(perpMarkets: PublicKey[]): Promise<PerpMarket[]> {
    const accounts = await Promise.all(
      perpMarkets.map((pk) => this.connection.getAccountInfo(pk)),
    );

    const parsedPerpMarkets: PerpMarket[] = [];

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (acc) {
        const decoded = PerpMarketLayout.decode(acc.data);
        parsedPerpMarkets.push(new PerpMarket(perpMarkets[i], decoded));
      }
    }

    return parsedPerpMarkets;
  }
  */

  /**
   * Add a new oracle to a group
   */
  async addOracle(
    entropyGroup: EntropyGroup,
    oracle: PublicKey,
    admin: Account,
  ): Promise<TransactionSignature> {
    const instruction = makeAddOracleInstruction(
      this.programId,
      entropyGroup.publicKey,
      oracle,
      admin.publicKey,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  /**
   * Set the price of a 'stub' type oracle
   */
  async setOracle(
    entropyGroup: EntropyGroup,
    oracle: PublicKey,
    admin: Account,
    price: I80F48,
  ): Promise<TransactionSignature> {
    const instruction = makeSetOracleInstruction(
      this.programId,
      entropyGroup.publicKey,
      oracle,
      admin.publicKey,
      price,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async addSpotMarket(
    entropyGroup: EntropyGroup,
    oracle: PublicKey,
    spotMarket: PublicKey,
    mint: PublicKey,
    admin: Account,

    maintLeverage: number,
    initLeverage: number,
    liquidationFee: number,
    optimalUtil: number,
    optimalRate: number,
    maxRate: number,
  ): Promise<TransactionSignature> {
    const vaultAccount = new Account();

    const vaultAccountInstructions = await createTokenAccountInstructions(
      this.connection,
      admin.publicKey,
      vaultAccount.publicKey,
      mint,
      entropyGroup.signerKey,
    );

    const nodeBankAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      NodeBankLayout.span,
      this.programId,
    );
    const rootBankAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      RootBankLayout.span,
      this.programId,
    );

    const instruction = makeAddSpotMarketInstruction(
      this.programId,
      entropyGroup.publicKey,
      oracle,
      spotMarket,
      entropyGroup.dexProgramId,
      mint,
      nodeBankAccountInstruction.account.publicKey,
      vaultAccount.publicKey,
      rootBankAccountInstruction.account.publicKey,
      admin.publicKey,
      I80F48.fromNumber(maintLeverage),
      I80F48.fromNumber(initLeverage),
      I80F48.fromNumber(liquidationFee),
      I80F48.fromNumber(optimalUtil),
      I80F48.fromNumber(optimalRate),
      I80F48.fromNumber(maxRate),
    );
    const transaction = new Transaction();
    transaction.add(...vaultAccountInstructions);
    transaction.add(nodeBankAccountInstruction.instruction);
    transaction.add(rootBankAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [
      vaultAccount,
      nodeBankAccountInstruction.account,
      rootBankAccountInstruction.account,
    ];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  /**
   * Make sure entropyAccount has recent and valid inMarginBasket and spotOpenOrders
   */
  async placeSpotOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    entropyCache: PublicKey,
    spotMarket: Market,
    owner: Account | WalletAdapter,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
    clientId?: BN,
  ): Promise<TransactionSignature> {
    const limitPrice = spotMarket.priceNumberToLots(price);
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

    // TODO implement srm vault fee discount
    // const feeTier = getFeeTier(0, nativeToUi(entropyGroup.nativeSrm || 0, SRM_DECIMALS));
    const feeTier = getFeeTier(0, nativeToUi(0, 0));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(
      spotMarket
        .baseSizeNumberToLots(size)
        .mul(spotMarket.priceNumberToLots(price)),
    );

    if (maxBaseQuantity.lte(ZERO_BN)) {
      throw new Error('size too small');
    }
    if (limitPrice.lte(ZERO_BN)) {
      throw new Error('invalid price');
    }
    const selfTradeBehavior = 'decrementTake';
    clientId = clientId ?? new BN(Date.now());

    const spotMarketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);

    if (!entropyGroup.rootBankAccounts.filter((a) => !!a).length) {
      await entropyGroup.loadRootBanks(this.connection);
    }

    const baseRootBank = entropyGroup.rootBankAccounts[spotMarketIndex];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseRootBank || !baseNodeBank || !quoteRootBank || !quoteNodeBank) {
      throw new Error('Invalid or missing banks');
    }

    const transaction = new Transaction();
    const additionalSigners: Account[] = [];
    const openOrdersKeys: { pubkey: PublicKey; isWritable: boolean }[] = [];

    // Only pass in open orders if in margin basket or current market index, and
    // the only writable account should be OpenOrders for current market index
    for (let i = 0; i < entropyAccount.spotOpenOrders.length; i++) {
      let pubkey = zeroKey;
      let isWritable = false;

      if (i === spotMarketIndex) {
        isWritable = true;

        if (entropyAccount.spotOpenOrders[spotMarketIndex].equals(zeroKey)) {
          // open orders missing for this market; create a new one now
          const openOrdersSpace = OpenOrders.getLayout(
            entropyGroup.dexProgramId,
          ).span;

          const openOrdersLamports =
            await this.connection.getMinimumBalanceForRentExemption(
              openOrdersSpace,
              'processed',
            );

          const accInstr = await createAccountInstruction(
            this.connection,
            owner.publicKey,
            openOrdersSpace,
            entropyGroup.dexProgramId,
            openOrdersLamports,
          );

          const initOpenOrders = makeInitSpotOpenOrdersInstruction(
            this.programId,
            entropyGroup.publicKey,
            entropyAccount.publicKey,
            owner.publicKey,
            entropyGroup.dexProgramId,
            accInstr.account.publicKey,
            spotMarket.publicKey,
            entropyGroup.signerKey,
          );

          const initTx = new Transaction();

          initTx.add(accInstr.instruction);
          initTx.add(initOpenOrders);

          await this.sendTransaction(initTx, owner, [accInstr.account]);

          pubkey = accInstr.account.publicKey;
        } else {
          pubkey = entropyAccount.spotOpenOrders[i];
        }
      } else if (entropyAccount.inMarginBasket[i]) {
        pubkey = entropyAccount.spotOpenOrders[i];
      }

      openOrdersKeys.push({ pubkey, isWritable });
    }

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const placeOrderInstruction = makePlaceSpotOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyCache,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      spotMarket['_decoded'].requestQueue,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      baseRootBank.publicKey,
      baseNodeBank.publicKey,
      baseNodeBank.vault,
      quoteRootBank.publicKey,
      quoteNodeBank.publicKey,
      quoteNodeBank.vault,
      entropyGroup.signerKey,
      dexSigner,
      entropyGroup.srmVault, // TODO: choose msrm vault if it has any deposits
      openOrdersKeys,
      side,
      limitPrice,
      maxBaseQuantity,
      maxQuoteQuantity,
      selfTradeBehavior,
      orderType,
      clientId,
    );
    transaction.add(placeOrderInstruction);

    if (spotMarketIndex > 0) {
      console.log(new Date().toISOString(),
        spotMarketIndex - 1,
        entropyAccount.spotOpenOrders[spotMarketIndex - 1].toBase58(),
        openOrdersKeys[spotMarketIndex - 1].pubkey.toBase58(),
      );
    }

    const txid = await this.sendTransaction(
      transaction,
      owner,
      additionalSigners,
    );

    // update EntropyAccount to have new OpenOrders pubkey
    entropyAccount.spotOpenOrders[spotMarketIndex] =
      openOrdersKeys[spotMarketIndex].pubkey;
    entropyAccount.inMarginBasket[spotMarketIndex] = true;
    console.log(new Date().toISOString(),
      spotMarketIndex,
      entropyAccount.spotOpenOrders[spotMarketIndex].toBase58(),
      openOrdersKeys[spotMarketIndex].pubkey.toBase58(),
    );

    return txid;
  }

  /**
   * Make sure entropyAccount has recent and valid inMarginBasket and spotOpenOrders
   */
  async placeSpotOrder2(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    spotMarket: Market,
    owner: Account | WalletAdapter,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
    clientOrderId?: BN,
    useMsrmVault?: boolean | undefined,
  ): Promise<TransactionSignature> {
    const limitPrice = spotMarket.priceNumberToLots(price);
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

    // TODO implement srm vault fee discount
    // const feeTier = getFeeTier(0, nativeToUi(entropyGroup.nativeSrm || 0, SRM_DECIMALS));
    const feeTier = getFeeTier(0, nativeToUi(0, 0));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(
      spotMarket
        .baseSizeNumberToLots(size)
        .mul(spotMarket.priceNumberToLots(price)),
    );

    if (maxBaseQuantity.lte(ZERO_BN)) {
      throw new Error('size too small');
    }
    if (limitPrice.lte(ZERO_BN)) {
      throw new Error('invalid price');
    }
    const selfTradeBehavior = 'decrementTake';

    const spotMarketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);

    if (!entropyGroup.rootBankAccounts.filter((a) => !!a).length) {
      await entropyGroup.loadRootBanks(this.connection);
    }
    let feeVault: PublicKey = zeroKey;
    if (useMsrmVault) {
      feeVault = entropyGroup.msrmVault;
    } else if (useMsrmVault === false) {
      feeVault = entropyGroup.srmVault;
    } else {
      const totalMsrm = await this.connection.getTokenAccountBalance(
        entropyGroup.msrmVault,
      );
      feeVault =
        totalMsrm?.value?.uiAmount && totalMsrm.value.uiAmount > 0
          ? entropyGroup.msrmVault
          : entropyGroup.srmVault;
    }

    const baseRootBank = entropyGroup.rootBankAccounts[spotMarketIndex];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseRootBank || !baseNodeBank || !quoteRootBank || !quoteNodeBank) {
      throw new Error('Invalid or missing banks');
    }

    const transaction = new Transaction();
    const additionalSigners: Account[] = [];
    const openOrdersKeys: { pubkey: PublicKey; isWritable: boolean }[] = [];

    // Only pass in open orders if in margin basket or current market index, and
    // the only writable account should be OpenOrders for current market index
    let marketOpenOrdersKey = zeroKey;
    for (let i = 0; i < entropyAccount.spotOpenOrders.length; i++) {
      let pubkey = zeroKey;
      let isWritable = false;

      if (i === spotMarketIndex) {
        isWritable = true;

        if (entropyAccount.spotOpenOrders[spotMarketIndex].equals(zeroKey)) {
          // open orders missing for this market; create a new one now
          const openOrdersSpace = OpenOrders.getLayout(
            entropyGroup.dexProgramId,
          ).span;

          const openOrdersLamports =
            await this.connection.getMinimumBalanceForRentExemption(
              openOrdersSpace,
              'processed',
            );

          const accInstr = await createAccountInstruction(
            this.connection,
            owner.publicKey,
            openOrdersSpace,
            entropyGroup.dexProgramId,
            openOrdersLamports,
          );

          const initOpenOrders = makeInitSpotOpenOrdersInstruction(
            this.programId,
            entropyGroup.publicKey,
            entropyAccount.publicKey,
            owner.publicKey,
            entropyGroup.dexProgramId,
            accInstr.account.publicKey,
            spotMarket.publicKey,
            entropyGroup.signerKey,
          );

          const initTx = new Transaction();

          initTx.add(accInstr.instruction);
          initTx.add(initOpenOrders);

          await this.sendTransaction(initTx, owner, [accInstr.account]);
          pubkey = accInstr.account.publicKey;
        } else {
          pubkey = entropyAccount.spotOpenOrders[i];
        }
        marketOpenOrdersKey = pubkey;
      } else if (entropyAccount.inMarginBasket[i]) {
        pubkey = entropyAccount.spotOpenOrders[i];
      }

      // new design does not require zero keys to be passed in
      if (!pubkey.equals(zeroKey)) {
        openOrdersKeys.push({ pubkey, isWritable });
      }
    }

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const placeOrderInstruction = makePlaceSpotOrder2Instruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyGroup.entropyCache,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      spotMarket['_decoded'].requestQueue,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      baseRootBank.publicKey,
      baseNodeBank.publicKey,
      baseNodeBank.vault,
      quoteRootBank.publicKey,
      quoteNodeBank.publicKey,
      quoteNodeBank.vault,
      entropyGroup.signerKey,
      dexSigner,
      feeVault,
      openOrdersKeys,
      side,
      limitPrice,
      maxBaseQuantity,
      maxQuoteQuantity,
      selfTradeBehavior,
      orderType,
      clientOrderId ?? new BN(Date.now()),
    );
    transaction.add(placeOrderInstruction);

    const txid = await this.sendTransaction(
      transaction,
      owner,
      additionalSigners,
    );

    // update EntropyAccount to have new OpenOrders pubkey
    // We know this new key is in margin basket because if it was a full taker trade
    // there is some leftover from fee rebate. If maker trade there's the order.
    // and if it failed then we already exited before this line
    entropyAccount.spotOpenOrders[spotMarketIndex] = marketOpenOrdersKey;
    entropyAccount.inMarginBasket[spotMarketIndex] = true;
    console.log(new Date().toISOString(),
      spotMarketIndex,
      entropyAccount.spotOpenOrders[spotMarketIndex].toBase58(),
      marketOpenOrdersKey.toBase58(),
    );

    return txid;
  }

  async cancelSpotOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    spotMarket: Market,
    order: Order,
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const instruction = makeCancelSpotOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      owner.publicKey,
      entropyAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      order.openOrdersAddress,
      entropyGroup.signerKey,
      spotMarket['_decoded'].eventQueue,
      order,
    );
    transaction.add(instruction);

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const marketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);
    if (!entropyGroup.rootBankAccounts.length) {
      await entropyGroup.loadRootBanks(this.connection);
    }
    const baseRootBank = entropyGroup.rootBankAccounts[marketIndex];
    const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseNodeBank || !quoteNodeBank) {
      throw new Error('Invalid or missing node banks');
    }
    const settleFundsInstruction = makeSettleFundsInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      owner.publicKey,
      entropyAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      entropyAccount.spotOpenOrders[marketIndex],
      entropyGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      entropyGroup.tokens[marketIndex].rootBank,
      baseNodeBank.publicKey,
      entropyGroup.tokens[QUOTE_INDEX].rootBank,
      quoteNodeBank.publicKey,
      baseNodeBank.vault,
      quoteNodeBank.vault,
      dexSigner,
    );
    transaction.add(settleFundsInstruction);

    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async settleFunds(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    spotMarket: Market,
  ): Promise<TransactionSignature> {
    const marketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);
    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    if (!entropyGroup.rootBankAccounts.length) {
      await entropyGroup.loadRootBanks(this.connection);
    }
    const baseRootBank = entropyGroup.rootBankAccounts[marketIndex];
    const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseNodeBank || !quoteNodeBank) {
      throw new Error('Invalid or missing node banks');
    }

    const instruction = makeSettleFundsInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      owner.publicKey,
      entropyAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      entropyAccount.spotOpenOrders[marketIndex],
      entropyGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      entropyGroup.tokens[marketIndex].rootBank,
      baseNodeBank.publicKey,
      entropyGroup.tokens[QUOTE_INDEX].rootBank,
      quoteNodeBank.publicKey,
      baseNodeBank.vault,
      quoteNodeBank.vault,
      dexSigner,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  /**
   * Assumes spotMarkets contains all Markets in EntropyGroup in order
   */
  async settleAll(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    spotMarkets: Market[],
    owner: Account | WalletAdapter,
  ): Promise<TransactionSignature[]> {
    const transactions: Transaction[] = [];

    let j = 0;
    for (let i = 0; i < entropyGroup.spotMarkets.length; i++) {
      if (entropyGroup.spotMarkets[i].isEmpty()) continue;
      const spotMarket = spotMarkets[j];
      j++;

      const transaction = new Transaction();
      const openOrdersAccount = entropyAccount.spotOpenOrdersAccounts[i];
      if (openOrdersAccount === undefined) continue;

      if (
        openOrdersAccount.quoteTokenFree.toNumber() +
        openOrdersAccount['referrerRebatesAccrued'].toNumber() ===
        0 &&
        openOrdersAccount.baseTokenFree.toNumber() === 0
      ) {
        continue;
      }

      const dexSigner = await PublicKey.createProgramAddress(
        [
          spotMarket.publicKey.toBuffer(),
          spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
        ],
        spotMarket.programId,
      );

      if (!entropyGroup.rootBankAccounts.length) {
        await entropyGroup.loadRootBanks(this.connection);
      }
      const baseRootBank = entropyGroup.rootBankAccounts[i];
      const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
      const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
      const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

      if (!baseNodeBank || !quoteNodeBank) {
        throw new Error('Invalid or missing node banks');
      }

      const instruction = makeSettleFundsInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyGroup.entropyCache,
        owner.publicKey,
        entropyAccount.publicKey,
        spotMarket.programId,
        spotMarket.publicKey,
        entropyAccount.spotOpenOrders[i],
        entropyGroup.signerKey,
        spotMarket['_decoded'].baseVault,
        spotMarket['_decoded'].quoteVault,
        entropyGroup.tokens[i].rootBank,
        baseNodeBank.publicKey,
        entropyGroup.tokens[QUOTE_INDEX].rootBank,
        quoteNodeBank.publicKey,
        baseNodeBank.vault,
        quoteNodeBank.vault,
        dexSigner,
      );

      transaction.add(instruction);
      transactions.push(transaction);
    }

    const signers = [];
    const transactionsAndSigners = transactions.map((tx) => ({
      transaction: tx,
      signers,
    }));

    const signedTransactions = await this.signTransactions({
      transactionsAndSigners,
      payer: owner,
    });

    const txids: TransactionSignature[] = [];

    if (signedTransactions) {
      for (const signedTransaction of signedTransactions) {
        if (signedTransaction.instructions.length == 0) {
          continue;
        }
        const txid = await this.sendSignedTransaction({
          signedTransaction,
        });
        txids.push(txid);
      }
    } else {
      throw new Error('Unable to sign Settle All transaction');
    }

    return txids;
  }

  /**
   * Automatically fetch EntropyAccounts for this PerpMarket
   * Pick enough EntropyAccounts that have opposite sign and send them in to get settled
   */
  async settlePnl(
    entropyGroup: EntropyGroup,
    entropyCache: EntropyCache,
    entropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    quoteRootBank: RootBank,
    price: I80F48, // should be the EntropyCache price
    owner: Account | WalletAdapter,
    entropyAccounts?: EntropyAccount[],
  ): Promise<TransactionSignature | null> {
    // fetch all EntropyAccounts filtered for having this perp market in basket
    const marketIndex = entropyGroup.getPerpMarketIndex(perpMarket.publicKey);
    const perpMarketInfo = entropyGroup.perpMarkets[marketIndex];
    let pnl = entropyAccount.perpAccounts[marketIndex].getPnl(
      perpMarketInfo,
      entropyCache.perpMarketCache[marketIndex],
      price,
    );
    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    let sign;
    if (pnl.eq(ZERO_I80F48)) {
      // Can't settle pnl if there is no pnl
      return null;
    } else if (pnl.gt(ZERO_I80F48)) {
      sign = 1;
    } else {
      // Can settle fees first against perpmarket

      sign = -1;
      if (!quoteRootBank.nodeBankAccounts) {
        await quoteRootBank.loadNodeBanks(this.connection);
      }
      const settleFeesInstr = makeSettleFeesInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyCache.publicKey,
        perpMarket.publicKey,
        entropyAccount.publicKey,
        quoteRootBank.publicKey,
        quoteRootBank.nodeBanks[0],
        quoteRootBank.nodeBankAccounts[0].vault,
        entropyGroup.feesVault,
        entropyGroup.signerKey,
      );
      transaction.add(settleFeesInstr);
      pnl = pnl.add(perpMarket.feesAccrued).min(I80F48.fromString('-0.000001'));
      const remSign = pnl.gt(ZERO_I80F48) ? 1 : -1;
      if (remSign !== sign) {
        // if pnl has changed sign, then we're done
        return await this.sendTransaction(
          transaction,
          owner,
          additionalSigners,
        );
      }
    }

    if (entropyAccounts === undefined) {
      entropyAccounts = await this.getAllEntropyAccounts(entropyGroup, [], false);
    }

    const accountsWithPnl = entropyAccounts
      .map((m) => ({
        account: m,
        pnl: m.perpAccounts[marketIndex].getPnl(
          perpMarketInfo,
          entropyCache.perpMarketCache[marketIndex],
          price,
        ),
      }))
      .sort((a, b) => sign * a.pnl.cmp(b.pnl));

    for (const account of accountsWithPnl) {
      // ignore own account explicitly
      if (account.account.publicKey.equals(entropyAccount.publicKey)) {
        continue;
      }
      if (
        ((pnl.isPos() && account.pnl.isNeg()) ||
          (pnl.isNeg() && account.pnl.isPos())) &&
        transaction.instructions.length < 10
      ) {
        // Account pnl must have opposite signs
        const instr = makeSettlePnlInstruction(
          this.programId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          account.account.publicKey,
          entropyGroup.entropyCache,
          quoteRootBank.publicKey,
          quoteRootBank.nodeBanks[0],
          new BN(marketIndex),
        );
        transaction.add(instr);
        pnl = pnl.add(account.pnl);
        // if pnl has changed sign, then we're done
        const remSign = pnl.gt(ZERO_I80F48) ? 1 : -1;
        if (remSign !== sign) {
          break;
        }
      } else {
        // means we ran out of accounts to settle against (shouldn't happen) OR transaction too big
        // TODO - create a multi tx to be signed by user
        continue;
      }
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);

    // Calculate the profit or loss per market
  }

  getEntropyAccountsForOwner(
    entropyGroup: EntropyGroup,
    owner: PublicKey,
    includeOpenOrders = false,
  ): Promise<EntropyAccount[]> {
    const filters = [
      {
        memcmp: {
          offset: EntropyAccountLayout.offsetOf('owner'),
          bytes: owner.toBase58(),
        },
      },
    ];

    return this.getAllEntropyAccounts(entropyGroup, filters, includeOpenOrders);
  }

  async getAllEntropyAccounts(
    entropyGroup: EntropyGroup,
    filters?: any[],
    includeOpenOrders = true,
  ): Promise<EntropyAccount[]> {
    const accountFilters = [
      {
        memcmp: {
          offset: EntropyAccountLayout.offsetOf('entropyGroup'),
          bytes: entropyGroup.publicKey.toBase58(),
        },
      },
      {
        dataSize: EntropyAccountLayout.span,
      },
    ];

    if (filters && filters.length) {
      accountFilters.push(...filters);
    }

    const entropyAccounts = await getFilteredProgramAccounts(
      this.connection,
      this.programId,
      accountFilters,
    ).then((accounts) =>
      accounts.map(({ publicKey, accountInfo }) => {
        return new EntropyAccount(
          publicKey,
          EntropyAccountLayout.decode(
            accountInfo == null ? undefined : accountInfo.data,
          ),
        );
      }),
    );

    if (includeOpenOrders) {
      const openOrderPks = entropyAccounts
        .map((ma) => ma.spotOpenOrders.filter((pk) => !pk.equals(zeroKey)))
        .flat();

      const openOrderAccountInfos = await getMultipleAccounts(
        this.connection,
        openOrderPks,
      );

      const openOrders = openOrderAccountInfos.map(
        ({ publicKey, accountInfo }) =>
          OpenOrders.fromAccountInfo(
            publicKey,
            accountInfo,
            entropyGroup.dexProgramId,
          ),
      );

      const pkToOpenOrdersAccount = {};
      openOrders.forEach((openOrdersAccount) => {
        pkToOpenOrdersAccount[openOrdersAccount.publicKey.toBase58()] =
          openOrdersAccount;
      });

      for (const ma of entropyAccounts) {
        for (let i = 0; i < ma.spotOpenOrders.length; i++) {
          if (ma.spotOpenOrders[i].toBase58() in pkToOpenOrdersAccount) {
            ma.spotOpenOrdersAccounts[i] =
              pkToOpenOrdersAccount[ma.spotOpenOrders[i].toBase58()];
          }
        }
      }
    }

    return entropyAccounts;
  }

  async addStubOracle(entropyGroupPk: PublicKey, admin: Account) {
    const createOracleAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      StubOracleLayout.span,
      this.programId,
    );

    const instruction = makeAddOracleInstruction(
      this.programId,
      entropyGroupPk,
      createOracleAccountInstruction.account.publicKey,
      admin.publicKey,
    );

    const transaction = new Transaction();
    transaction.add(createOracleAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [createOracleAccountInstruction.account];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async setStubOracle(
    entropyGroupPk: PublicKey,
    oraclePk: PublicKey,
    admin: Account,
    price: number,
  ) {
    const instruction = makeSetOracleInstruction(
      this.programId,
      entropyGroupPk,
      oraclePk,
      admin.publicKey,
      I80F48.fromNumber(price),
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async addPerpMarket(
    entropyGroup: EntropyGroup,
    oraclePk: PublicKey,
    mngoMintPk: PublicKey,
    admin: Account,
    maintLeverage: number,
    initLeverage: number,
    liquidationFee: number,
    makerFee: number,
    takerFee: number,
    baseLotSize: number,
    quoteLotSize: number,
    maxNumEvents: number,
    rate: number, // liquidity mining params; set rate == 0 if no liq mining
    maxDepthBps: number,
    targetPeriodLength: number,
    mngoPerPeriod: number,
    exp: number,
  ) {
    const makePerpMarketAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      PerpMarketLayout.span,
      this.programId,
    );

    const makeEventQueueAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      PerpEventQueueHeaderLayout.span + maxNumEvents * PerpEventLayout.span,
      this.programId,
    );

    const makeBidAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const makeAskAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const mngoVaultAccount = new Account();
    const mngoVaultAccountInstructions = await createTokenAccountInstructions(
      this.connection,
      admin.publicKey,
      mngoVaultAccount.publicKey,
      mngoMintPk,
      entropyGroup.signerKey,
    );

    const instruction = await makeAddPerpMarketInstruction(
      this.programId,
      entropyGroup.publicKey,
      oraclePk,
      makePerpMarketAccountInstruction.account.publicKey,
      makeEventQueueAccountInstruction.account.publicKey,
      makeBidAccountInstruction.account.publicKey,
      makeAskAccountInstruction.account.publicKey,
      mngoVaultAccount.publicKey,
      admin.publicKey,
      I80F48.fromNumber(maintLeverage),
      I80F48.fromNumber(initLeverage),
      I80F48.fromNumber(liquidationFee),
      I80F48.fromNumber(makerFee),
      I80F48.fromNumber(takerFee),
      new BN(baseLotSize),
      new BN(quoteLotSize),
      I80F48.fromNumber(rate),
      I80F48.fromNumber(maxDepthBps),
      new BN(targetPeriodLength),
      new BN(mngoPerPeriod),
      new BN(exp),
    );

    const createMngoVaultTransaction = new Transaction();
    createMngoVaultTransaction.add(...mngoVaultAccountInstructions);
    await this.sendTransaction(createMngoVaultTransaction, admin, [
      mngoVaultAccount,
    ]);

    const transaction = new Transaction();
    transaction.add(makePerpMarketAccountInstruction.instruction);
    transaction.add(makeEventQueueAccountInstruction.instruction);
    transaction.add(makeBidAccountInstruction.instruction);
    transaction.add(makeAskAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [
      makePerpMarketAccountInstruction.account,
      makeEventQueueAccountInstruction.account,
      makeBidAccountInstruction.account,
      makeAskAccountInstruction.account,
    ];

    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async createPerpMarket(
    entropyGroup: EntropyGroup,
    oraclePk: PublicKey,
    mngoMintPk: PublicKey,
    admin: Account | Keypair,
    maintLeverage: number,
    initLeverage: number,
    liquidationFee: number,
    makerFee: number,
    takerFee: number,
    baseLotSize: number,
    quoteLotSize: number,
    maxNumEvents: number,
    rate: number, // liquidity mining params; set rate == 0 if no liq mining
    maxDepthBps: number,
    targetPeriodLength: number,
    mngoPerPeriod: number,
    exp: number,
    version: number,
    lmSizeShift: number,
    baseDecimals: number,
  ) {
    const [perpMarketPk] = await PublicKey.findProgramAddress(
      [
        entropyGroup.publicKey.toBytes(),
        new Buffer('PerpMarket', 'utf-8'),
        oraclePk.toBytes(),
      ],
      this.programId,
    );
    const makeEventQueueAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      PerpEventQueueHeaderLayout.span + maxNumEvents * PerpEventLayout.span,
      this.programId,
    );

    const makeBidAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const makeAskAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      BookSideLayout.span,
      this.programId,
    );

    const [mngoVaultPk] = await PublicKey.findProgramAddress(
      [
        perpMarketPk.toBytes(),
        TOKEN_PROGRAM_ID.toBytes(),
        mngoMintPk.toBytes(),
      ],
      this.programId,
    );
    const instruction = await makeCreatePerpMarketInstruction(
      this.programId,
      entropyGroup.publicKey,
      oraclePk,
      perpMarketPk,
      makeEventQueueAccountInstruction.account.publicKey,
      makeBidAccountInstruction.account.publicKey,
      makeAskAccountInstruction.account.publicKey,
      mngoMintPk,
      mngoVaultPk,
      admin.publicKey,
      entropyGroup.signerKey,
      I80F48.fromNumber(maintLeverage),
      I80F48.fromNumber(initLeverage),
      I80F48.fromNumber(liquidationFee),
      I80F48.fromNumber(makerFee),
      I80F48.fromNumber(takerFee),
      new BN(baseLotSize),
      new BN(quoteLotSize),
      I80F48.fromNumber(rate),
      I80F48.fromNumber(maxDepthBps),
      new BN(targetPeriodLength),
      new BN(mngoPerPeriod),
      new BN(exp),
      new BN(version),
      new BN(lmSizeShift),
      new BN(baseDecimals),
    );

    const transaction = new Transaction();
    transaction.add(makeEventQueueAccountInstruction.instruction);
    transaction.add(makeBidAccountInstruction.instruction);
    transaction.add(makeAskAccountInstruction.instruction);
    transaction.add(instruction);

    const additionalSigners = [
      makeEventQueueAccountInstruction.account,
      makeBidAccountInstruction.account,
      makeAskAccountInstruction.account,
    ];

    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  // Liquidator Functions
  async forceCancelSpotOrders(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    spotMarket: Market,
    baseRootBank: RootBank,
    quoteRootBank: RootBank,
    payer: Account,
    limit: BN,
  ) {
    const baseNodeBanks = await baseRootBank.loadNodeBanks(this.connection);
    const quoteNodeBanks = await quoteRootBank.loadNodeBanks(this.connection);

    const openOrdersKeys: { pubkey: PublicKey; isWritable: boolean }[] = [];
    const spotMarketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);
    // Only pass in open orders if in margin basket or current market index, and
    // the only writable account should be OpenOrders for current market index
    for (let i = 0; i < liqeeEntropyAccount.spotOpenOrders.length; i++) {
      let pubkey = zeroKey;
      let isWritable = false;

      if (i === spotMarketIndex) {
        isWritable = true;

        if (liqeeEntropyAccount.spotOpenOrders[spotMarketIndex].equals(zeroKey)) {
          console.log('missing oo for ', spotMarketIndex);
          // open orders missing for this market; create a new one now
          // const openOrdersSpace = OpenOrders.getLayout(
          //   entropyGroup.dexProgramId,
          // ).span;
          // const openOrdersLamports =
          //   await this.connection.getMinimumBalanceForRentExemption(
          //     openOrdersSpace,
          //     'singleGossip',
          //   );
          // const accInstr = await createAccountInstruction(
          //   this.connection,
          //   owner.publicKey,
          //   openOrdersSpace,
          //   entropyGroup.dexProgramId,
          //   openOrdersLamports,
          // );

          // transaction.add(accInstr.instruction);
          // additionalSigners.push(accInstr.account);
          // pubkey = accInstr.account.publicKey;
        } else {
          pubkey = liqeeEntropyAccount.spotOpenOrders[i];
        }
      } else if (liqeeEntropyAccount.inMarginBasket[i]) {
        pubkey = liqeeEntropyAccount.spotOpenOrders[i];
      }

      openOrdersKeys.push({ pubkey, isWritable });
    }

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const instruction = makeForceCancelSpotOrdersInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      liqeeEntropyAccount.publicKey,
      baseRootBank.publicKey,
      baseNodeBanks[0].publicKey,
      baseNodeBanks[0].vault,
      quoteRootBank.publicKey,
      quoteNodeBanks[0].publicKey,
      quoteNodeBanks[0].vault,
      spotMarket.publicKey,
      spotMarket.bidsAddress,
      spotMarket.asksAddress,
      entropyGroup.signerKey,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      dexSigner,
      entropyGroup.dexProgramId,
      openOrdersKeys,
      limit,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  /**
   * Send multiple instructions to cancel all perp orders in this market
   */
  async forceCancelAllPerpOrdersInMarket(
    entropyGroup: EntropyGroup,
    liqee: EntropyAccount,
    perpMarket: PerpMarket,
    payer: Account | WalletAdapter,
    limitPerInstruction: number,
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const marketIndex = entropyGroup.getPerpMarketIndex(perpMarket.publicKey);
    const instruction = makeForceCancelPerpOrdersInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      liqee.publicKey,
      liqee.spotOpenOrders,
      new BN(limitPerInstruction),
    );
    transaction.add(instruction);

    let orderCount = 0;
    for (let i = 0; i < liqee.orderMarket.length; i++) {
      if (liqee.orderMarket[i] !== marketIndex) {
        continue;
      }
      orderCount++;
      if (orderCount === limitPerInstruction) {
        orderCount = 0;
        const instruction = makeForceCancelPerpOrdersInstruction(
          this.programId,
          entropyGroup.publicKey,
          entropyGroup.entropyCache,
          perpMarket.publicKey,
          perpMarket.bids,
          perpMarket.asks,
          liqee.publicKey,
          liqee.spotOpenOrders,
          new BN(limitPerInstruction),
        );
        transaction.add(instruction);

        // TODO - verify how many such instructions can go into one tx
        // right now 10 seems reasonable considering size of 800ish bytes if all spot open orders present
        if (transaction.instructions.length === 10) {
          break;
        }
      }
    }

    return await this.sendTransaction(transaction, payer, []);
  }

  async forceCancelPerpOrders(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    payer: Account,
    limit: BN,
  ) {
    const instruction = makeForceCancelPerpOrdersInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      liqeeEntropyAccount.publicKey,
      liqeeEntropyAccount.spotOpenOrders,
      limit,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async liquidateTokenAndToken(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    liqorEntropyAccount: EntropyAccount,
    assetRootBank: RootBank,
    liabRootBank: RootBank,
    payer: Account,
    maxLiabTransfer: I80F48,
  ) {
    const instruction = makeLiquidateTokenAndTokenInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      liqeeEntropyAccount.publicKey,
      liqorEntropyAccount.publicKey,
      payer.publicKey,
      assetRootBank.publicKey,
      assetRootBank.nodeBanks[0],
      liabRootBank.publicKey,
      liabRootBank.nodeBanks[0],
      liqeeEntropyAccount.spotOpenOrders,
      liqorEntropyAccount.spotOpenOrders,
      maxLiabTransfer,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async liquidateTokenAndPerp(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    liqorEntropyAccount: EntropyAccount,
    rootBank: RootBank,
    payer: Account,
    assetType: AssetType,
    assetIndex: number,
    liabType: AssetType,
    liabIndex: number,
    maxLiabTransfer: I80F48,
  ) {
    const instruction = makeLiquidateTokenAndPerpInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      liqeeEntropyAccount.publicKey,
      liqorEntropyAccount.publicKey,
      payer.publicKey,
      rootBank.publicKey,
      rootBank.nodeBanks[0],
      liqeeEntropyAccount.spotOpenOrders,
      liqorEntropyAccount.spotOpenOrders,
      assetType,
      new BN(assetIndex),
      liabType,
      new BN(liabIndex),
      maxLiabTransfer,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async liquidatePerpMarket(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    liqorEntropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    payer: Account,
    baseTransferRequest: BN,
  ) {
    const instruction = makeLiquidatePerpMarketInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      perpMarket.publicKey,
      perpMarket.eventQueue,
      liqeeEntropyAccount.publicKey,
      liqorEntropyAccount.publicKey,
      payer.publicKey,
      liqeeEntropyAccount.spotOpenOrders,
      liqorEntropyAccount.spotOpenOrders,
      baseTransferRequest,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async settleFees(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    rootBank: RootBank,
    payer: Account,
  ) {
    const nodeBanks = await rootBank.loadNodeBanks(this.connection);

    const instruction = makeSettleFeesInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      perpMarket.publicKey,
      entropyAccount.publicKey,
      rootBank.publicKey,
      nodeBanks[0].publicKey,
      nodeBanks[0].vault,
      entropyGroup.feesVault,
      entropyGroup.signerKey,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async resolvePerpBankruptcy(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    liqorEntropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    rootBank: RootBank,
    payer: Account,
    liabIndex: number,
    maxLiabTransfer: I80F48,
  ) {
    const nodeBanks = await rootBank.loadNodeBanks(this.connection);
    const instruction = makeResolvePerpBankruptcyInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      liqeeEntropyAccount.publicKey,
      liqorEntropyAccount.publicKey,
      payer.publicKey,
      rootBank.publicKey,
      nodeBanks[0].publicKey,
      nodeBanks[0].vault,
      entropyGroup.insuranceVault,
      entropyGroup.signerKey,
      perpMarket.publicKey,
      liqorEntropyAccount.spotOpenOrders,
      new BN(liabIndex),
      maxLiabTransfer,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async resolveTokenBankruptcy(
    entropyGroup: EntropyGroup,
    liqeeEntropyAccount: EntropyAccount,
    liqorEntropyAccount: EntropyAccount,
    quoteRootBank: RootBank,
    liabRootBank: RootBank,
    payer: Account,
    maxLiabTransfer: I80F48,
  ) {
    const quoteNodeBanks = await quoteRootBank.loadNodeBanks(this.connection);
    const instruction = makeResolveTokenBankruptcyInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      liqeeEntropyAccount.publicKey,
      liqorEntropyAccount.publicKey,
      payer.publicKey,
      quoteRootBank.publicKey,
      quoteRootBank.nodeBanks[0],
      quoteNodeBanks[0].vault,
      entropyGroup.insuranceVault,
      entropyGroup.signerKey,
      liabRootBank.publicKey,
      liabRootBank.nodeBanks[0],
      liqorEntropyAccount.spotOpenOrders,
      liabRootBank.nodeBanks,
      maxLiabTransfer,
    );

    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async redeemMngo(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    payer: Account | WalletAdapter,
    mngoRootBank: PublicKey,
    mngoNodeBank: PublicKey,
    mngoVault: PublicKey,
  ): Promise<TransactionSignature> {
    const instruction = makeRedeemMngoInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      entropyAccount.publicKey,
      payer.publicKey,
      perpMarket.publicKey,
      perpMarket.mngoVault,
      mngoRootBank,
      mngoNodeBank,
      mngoVault,
      entropyGroup.signerKey,
    );
    const transaction = new Transaction();
    transaction.add(instruction);

    return await this.sendTransaction(transaction, payer, []);
  }

  async redeemAllMngo(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    payer: Account | WalletAdapter,
    mngoRootBank: PublicKey,
    mngoNodeBank: PublicKey,
    mngoVault: PublicKey,
  ): Promise<TransactionSignature> {
    const transactions: Transaction[] = [];
    let transaction = new Transaction();

    const perpMarkets = await Promise.all(
      entropyAccount.perpAccounts.map((perpAccount, i) => {
        if (perpAccount.mngoAccrued.eq(ZERO_BN)) {
          return promiseUndef();
        } else {
          return this.getPerpMarket(
            entropyGroup.perpMarkets[i].perpMarket,
            entropyGroup.tokens[i].decimals,
            entropyGroup.tokens[QUOTE_INDEX].decimals,
          );
        }
      }),
    );

    for (let i = 0; i < entropyAccount.perpAccounts.length; i++) {
      const perpMarket = perpMarkets[i];
      if (perpMarket === undefined) continue;

      const instruction = makeRedeemMngoInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyGroup.entropyCache,
        entropyAccount.publicKey,
        payer.publicKey,
        perpMarket.publicKey,
        perpMarket.mngoVault,
        mngoRootBank,
        mngoNodeBank,
        mngoVault,
        entropyGroup.signerKey,
      );
      transaction.add(instruction);
      if (transaction.instructions.length === 9) {
        transactions.push(transaction);
        transaction = new Transaction();
      }
    }
    if (transaction.instructions.length > 0) {
      transactions.push(transaction);

      // txProms.push(this.sendTransaction(transaction, payer, []));
    }

    const transactionsAndSigners = transactions.map((tx) => ({
      transaction: tx,
      signers: [],
    }));

    if (transactionsAndSigners.length === 0) {
      throw new Error('No MNGO rewards to redeem');
    }

    // Sign multiple transactions at once for better UX
    const signedTransactions = await this.signTransactions({
      transactionsAndSigners,
      payer,
    });

    if (signedTransactions) {
      const txSigs = await Promise.all(
        signedTransactions.map((signedTransaction) =>
          this.sendSignedTransaction({ signedTransaction }),
        ),
      );
      return txSigs[0];
    } else {
      throw new Error('Unable to sign all RedeemMngo transactions');
    }
  }

  async addEntropyAccountInfo(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    info: string,
  ): Promise<TransactionSignature> {
    const instruction = makeAddEntropyAccountInfoInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      info,
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async depositMsrm(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    msrmAccount: PublicKey,
    quantity: number,
  ): Promise<TransactionSignature> {
    const instruction = makeDepositMsrmInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      msrmAccount,
      entropyGroup.msrmVault,
      new BN(Math.floor(quantity)),
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }
  async withdrawMsrm(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    msrmAccount: PublicKey,
    quantity: number,
  ): Promise<TransactionSignature> {
    const instruction = makeWithdrawMsrmInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      msrmAccount,
      entropyGroup.msrmVault,
      entropyGroup.signerKey,
      new BN(Math.floor(quantity)),
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async changePerpMarketParams(
    entropyGroup: EntropyGroup,
    perpMarket: PerpMarket,
    admin: Account | WalletAdapter,

    maintLeverage: number | undefined,
    initLeverage: number | undefined,
    liquidationFee: number | undefined,
    makerFee: number | undefined,
    takerFee: number | undefined,
    rate: number | undefined,
    maxDepthBps: number | undefined,
    targetPeriodLength: number | undefined,
    mngoPerPeriod: number | undefined,
    exp: number | undefined,
  ): Promise<TransactionSignature> {
    const instruction = makeChangePerpMarketParamsInstruction(
      this.programId,
      entropyGroup.publicKey,
      perpMarket.publicKey,
      admin.publicKey,
      I80F48.fromNumberOrUndef(maintLeverage),
      I80F48.fromNumberOrUndef(initLeverage),
      I80F48.fromNumberOrUndef(liquidationFee),
      I80F48.fromNumberOrUndef(makerFee),
      I80F48.fromNumberOrUndef(takerFee),
      I80F48.fromNumberOrUndef(rate),
      I80F48.fromNumberOrUndef(maxDepthBps),
      targetPeriodLength !== undefined ? new BN(targetPeriodLength) : undefined,
      mngoPerPeriod !== undefined ? new BN(mngoPerPeriod) : undefined,
      exp !== undefined ? new BN(exp) : undefined,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async changePerpMarketParams2(
    entropyGroup: EntropyGroup,
    perpMarket: PerpMarket,
    admin: Account | WalletAdapter,

    maintLeverage: number | undefined,
    initLeverage: number | undefined,
    liquidationFee: number | undefined,
    makerFee: number | undefined,
    takerFee: number | undefined,
    rate: number | undefined,
    maxDepthBps: number | undefined,
    targetPeriodLength: number | undefined,
    mngoPerPeriod: number | undefined,
    exp: number | undefined,
    version: number | undefined,
    lmSizeShift: number | undefined,
  ): Promise<TransactionSignature> {
    const instruction = makeChangePerpMarketParams2Instruction(
      this.programId,
      entropyGroup.publicKey,
      perpMarket.publicKey,
      admin.publicKey,
      I80F48.fromNumberOrUndef(maintLeverage),
      I80F48.fromNumberOrUndef(initLeverage),
      I80F48.fromNumberOrUndef(liquidationFee),
      I80F48.fromNumberOrUndef(makerFee),
      I80F48.fromNumberOrUndef(takerFee),
      I80F48.fromNumberOrUndef(rate),
      I80F48.fromNumberOrUndef(maxDepthBps),
      targetPeriodLength !== undefined ? new BN(targetPeriodLength) : undefined,
      mngoPerPeriod !== undefined ? new BN(mngoPerPeriod) : undefined,
      exp !== undefined ? new BN(exp) : undefined,
      version !== undefined ? new BN(version) : undefined,
      lmSizeShift !== undefined ? new BN(lmSizeShift) : undefined,
    );

    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];

    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  async setGroupAdmin(
    entropyGroup: EntropyGroup,
    newAdmin: PublicKey,
    admin: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const instruction = makeSetGroupAdminInstruction(
      this.programId,
      entropyGroup.publicKey,
      newAdmin,
      admin.publicKey,
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];
    return await this.sendTransaction(transaction, admin, additionalSigners);
  }

  /**
   * Add allowance for orders to be cancelled and replaced in a single transaction
   */
  async modifySpotOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    entropyCache: PublicKey,
    spotMarket: Market,
    owner: Account | WalletAdapter,
    order: Order,

    side: 'buy' | 'sell',
    price: number,
    size: number,
    orderType?: 'limit' | 'ioc' | 'postOnly',
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();

    const instruction = makeCancelSpotOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      owner.publicKey,
      entropyAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      order.openOrdersAddress,
      entropyGroup.signerKey,
      spotMarket['_decoded'].eventQueue,
      order,
    );
    transaction.add(instruction);

    const dexSigner = await PublicKey.createProgramAddress(
      [
        spotMarket.publicKey.toBuffer(),
        spotMarket['_decoded'].vaultSignerNonce.toArrayLike(Buffer, 'le', 8),
      ],
      spotMarket.programId,
    );

    const spotMarketIndex = entropyGroup.getSpotMarketIndex(spotMarket.publicKey);
    if (!entropyGroup.rootBankAccounts.length) {
      await entropyGroup.loadRootBanks(this.connection);
    }
    const baseRootBank = entropyGroup.rootBankAccounts[spotMarketIndex];
    const baseNodeBank = baseRootBank?.nodeBankAccounts[0];
    const quoteRootBank = entropyGroup.rootBankAccounts[QUOTE_INDEX];
    const quoteNodeBank = quoteRootBank?.nodeBankAccounts[0];

    if (!baseNodeBank || !quoteNodeBank) {
      throw new Error('Invalid or missing node banks');
    }
    const settleFundsInstruction = makeSettleFundsInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyGroup.entropyCache,
      owner.publicKey,
      entropyAccount.publicKey,
      spotMarket.programId,
      spotMarket.publicKey,
      entropyAccount.spotOpenOrders[spotMarketIndex],
      entropyGroup.signerKey,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      entropyGroup.tokens[spotMarketIndex].rootBank,
      baseNodeBank.publicKey,
      entropyGroup.tokens[QUOTE_INDEX].rootBank,
      quoteNodeBank.publicKey,
      baseNodeBank.vault,
      quoteNodeBank.vault,
      dexSigner,
    );
    transaction.add(settleFundsInstruction);

    const additionalSigners: Account[] = [];

    const limitPrice = spotMarket.priceNumberToLots(price);
    const maxBaseQuantity = spotMarket.baseSizeNumberToLots(size);

    // TODO implement srm vault fee discount
    // const feeTier = getFeeTier(0, nativeToUi(entropyGroup.nativeSrm || 0, SRM_DECIMALS));
    const feeTier = getFeeTier(0, nativeToUi(0, 0));
    const rates = getFeeRates(feeTier);
    const maxQuoteQuantity = new BN(
      spotMarket['_decoded'].quoteLotSize.toNumber() * (1 + rates.taker),
    ).mul(
      spotMarket
        .baseSizeNumberToLots(size)
        .mul(spotMarket.priceNumberToLots(price)),
    );

    // Checks already completed as only price modified
    if (maxBaseQuantity.lte(ZERO_BN)) {
      throw new Error('size too small');
    }
    if (limitPrice.lte(ZERO_BN)) {
      throw new Error('invalid price');
    }
    const selfTradeBehavior = 'decrementTake';

    if (!baseRootBank || !baseNodeBank || !quoteRootBank || !quoteNodeBank) {
      throw new Error('Invalid or missing banks');
    }

    const openOrdersKeys: { pubkey: PublicKey; isWritable: boolean }[] = [];

    // Only pass in open orders if in margin basket or current market index, and
    // the only writable account should be OpenOrders for current market index
    for (let i = 0; i < entropyAccount.spotOpenOrders.length; i++) {
      let pubkey = zeroKey;
      let isWritable = false;

      if (i === spotMarketIndex) {
        isWritable = true;

        if (entropyAccount.spotOpenOrders[spotMarketIndex].equals(zeroKey)) {
          // open orders missing for this market; create a new one now
          const openOrdersSpace = OpenOrders.getLayout(
            entropyGroup.dexProgramId,
          ).span;

          const openOrdersLamports =
            await this.connection.getMinimumBalanceForRentExemption(
              openOrdersSpace,
              'processed',
            );

          const accInstr = await createAccountInstruction(
            this.connection,
            owner.publicKey,
            openOrdersSpace,
            entropyGroup.dexProgramId,
            openOrdersLamports,
          );

          const initOpenOrders = makeInitSpotOpenOrdersInstruction(
            this.programId,
            entropyGroup.publicKey,
            entropyAccount.publicKey,
            owner.publicKey,
            entropyGroup.dexProgramId,
            accInstr.account.publicKey,
            spotMarket.publicKey,
            entropyGroup.signerKey,
          );

          const initTx = new Transaction();

          initTx.add(accInstr.instruction);
          initTx.add(initOpenOrders);

          await this.sendTransaction(initTx, owner, [accInstr.account]);

          pubkey = accInstr.account.publicKey;
        } else {
          pubkey = entropyAccount.spotOpenOrders[i];
        }
      } else if (entropyAccount.inMarginBasket[i]) {
        pubkey = entropyAccount.spotOpenOrders[i];
      }

      openOrdersKeys.push({ pubkey, isWritable });
    }

    const placeOrderInstruction = makePlaceSpotOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyCache,
      spotMarket.programId,
      spotMarket.publicKey,
      spotMarket['_decoded'].bids,
      spotMarket['_decoded'].asks,
      spotMarket['_decoded'].requestQueue,
      spotMarket['_decoded'].eventQueue,
      spotMarket['_decoded'].baseVault,
      spotMarket['_decoded'].quoteVault,
      baseRootBank.publicKey,
      baseNodeBank.publicKey,
      baseNodeBank.vault,
      quoteRootBank.publicKey,
      quoteNodeBank.publicKey,
      quoteNodeBank.vault,
      entropyGroup.signerKey,
      dexSigner,
      entropyGroup.srmVault, // TODO: choose msrm vault if it has any deposits
      openOrdersKeys,
      side,
      limitPrice,
      maxBaseQuantity,
      maxQuoteQuantity,
      selfTradeBehavior,
      orderType,
      order.clientId,
    );
    transaction.add(placeOrderInstruction);

    if (spotMarketIndex > 0) {
      console.log(new Date().toISOString(),
        spotMarketIndex - 1,
        entropyAccount.spotOpenOrders[spotMarketIndex - 1].toBase58(),
        openOrdersKeys[spotMarketIndex - 1].pubkey.toBase58(),
      );
    }
    const txid = await this.sendTransaction(
      transaction,
      owner,
      additionalSigners,
    );

    // update EntropyAccount to have new OpenOrders pubkey
    entropyAccount.spotOpenOrders[spotMarketIndex] =
      openOrdersKeys[spotMarketIndex].pubkey;
    entropyAccount.inMarginBasket[spotMarketIndex] = true;
    console.log(new Date().toISOString(),
      spotMarketIndex,
      entropyAccount.spotOpenOrders[spotMarketIndex].toBase58(),
      openOrdersKeys[spotMarketIndex].pubkey.toBase58(),
    );

    return txid;
  }

  async modifyPerpOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    entropyCache: PublicKey,
    perpMarket: PerpMarket,
    owner: Account | WalletAdapter,
    order: PerpOrder,

    side: 'buy' | 'sell',
    price: number,
    quantity: number,
    orderType?: PerpOrderType,
    clientOrderId?: number,
    bookSideInfo?: AccountInfo<Buffer>, // ask if side === bid, bids if side === ask; if this is given; crank instruction is added
    invalidIdOk = false, // Don't throw error if order is invalid
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    const cancelInstruction = makeCancelPerpOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      order,
      invalidIdOk,
    );

    transaction.add(cancelInstruction);

    const [nativePrice, nativeQuantity] = perpMarket.uiToNativePriceQuantity(
      price,
      quantity,
    );

    const placeInstruction = makePlacePerpOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyCache,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      perpMarket.eventQueue,
      entropyAccount.spotOpenOrders,
      nativePrice,
      nativeQuantity,
      clientOrderId
        ? new BN(clientOrderId)
        : order.clientId ?? new BN(Date.now()),
      side,
      orderType,
    );
    transaction.add(placeInstruction);

    if (bookSideInfo) {
      const bookSide = bookSideInfo.data
        ? new BookSide(
          side === 'buy' ? perpMarket.asks : perpMarket.bids,
          perpMarket,
          BookSideLayout.decode(bookSideInfo.data),
        )
        : [];
      const accounts: Set<string> = new Set();
      accounts.add(entropyAccount.publicKey.toBase58());

      for (const order of bookSide) {
        accounts.add(order.owner.toBase58());
        if (accounts.size >= 10) {
          break;
        }
      }

      const consumeInstruction = makeConsumeEventsInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyGroup.entropyCache,
        perpMarket.publicKey,
        perpMarket.eventQueue,
        Array.from(accounts)
          .map((s) => new PublicKey(s))
          .sort(),
        new BN(4),
      );
      transaction.add(consumeInstruction);
    }

    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async addPerpTriggerOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    perpMarket: PerpMarket,
    owner: Account | WalletAdapter,
    orderType: PerpOrderType,
    side: 'buy' | 'sell',
    price: number,
    quantity: number,
    triggerCondition: 'above' | 'below',
    triggerPrice: number,
    reduceOnly: boolean,
    clientOrderId?: number,
  ): Promise<TransactionSignature> {
    const transaction = new Transaction();
    const additionalSigners: Account[] = [];

    let advancedOrders: PublicKey = entropyAccount.advancedOrdersKey;
    if (entropyAccount.advancedOrdersKey.equals(zeroKey)) {
      [advancedOrders] = await PublicKey.findProgramAddress(
        [entropyAccount.publicKey.toBytes()],
        this.programId,
      );

      console.log(new Date().toISOString(), 'AdvancedOrders PDA:', advancedOrders.toBase58());

      transaction.add(
        makeInitAdvancedOrdersInstruction(
          this.programId,
          entropyGroup.publicKey,
          entropyAccount.publicKey,
          owner.publicKey,
          advancedOrders,
        ),
      );
    }

    const marketIndex = entropyGroup.getPerpMarketIndex(perpMarket.publicKey);

    const baseTokenInfo = entropyGroup.tokens[marketIndex];
    const quoteTokenInfo = entropyGroup.tokens[QUOTE_INDEX];
    const baseUnit = Math.pow(10, baseTokenInfo.decimals);
    const quoteUnit = Math.pow(10, quoteTokenInfo.decimals);

    const nativePrice = new BN(price * quoteUnit)
      .mul(perpMarket.baseLotSize)
      .div(perpMarket.quoteLotSize.mul(new BN(baseUnit)));
    const nativeQuantity = new BN(quantity * baseUnit).div(
      perpMarket.baseLotSize,
    );

    const nativeTriggerPrice = I80F48.fromNumber(
      triggerPrice *
      Math.pow(10, perpMarket.quoteDecimals - perpMarket.baseDecimals),
    );
    const openOrders = entropyAccount.spotOpenOrders.filter(
      (pk, i) => entropyAccount.inMarginBasket[i],
    );

    transaction.add(
      makeAddPerpTriggerOrderInstruction(
        this.programId,
        entropyGroup.publicKey,
        entropyAccount.publicKey,
        owner.publicKey,
        advancedOrders,
        entropyGroup.entropyCache,
        perpMarket.publicKey,
        openOrders,
        orderType,
        side,
        nativePrice,
        nativeQuantity,
        triggerCondition,
        nativeTriggerPrice,
        reduceOnly,
        new BN(clientOrderId ?? Date.now()),
      ),
    );
    const txid = await this.sendTransaction(
      transaction,
      owner,
      additionalSigners,
    );
    entropyAccount.advancedOrdersKey = advancedOrders;
    return txid;
  }

  async removeAdvancedOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    owner: Account | WalletAdapter,
    orderIndex: number,
  ): Promise<TransactionSignature> {
    const instruction = makeRemoveAdvancedOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      owner.publicKey,
      entropyAccount.advancedOrdersKey,
      orderIndex,
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];
    return await this.sendTransaction(transaction, owner, additionalSigners);
  }

  async executePerpTriggerOrder(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    entropyCache: EntropyCache,
    perpMarket: PerpMarket,
    payer: Account | WalletAdapter,
    orderIndex: number,
  ): Promise<TransactionSignature> {
    const openOrders = entropyAccount.spotOpenOrders.filter(
      (pk, i) => entropyAccount.inMarginBasket[i],
    );

    const instruction = makeExecutePerpTriggerOrderInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      entropyAccount.advancedOrdersKey,
      payer.publicKey,
      entropyCache.publicKey,
      perpMarket.publicKey,
      perpMarket.bids,
      perpMarket.asks,
      perpMarket.eventQueue,
      openOrders,
      new BN(orderIndex),
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];
    return await this.sendTransaction(transaction, payer, additionalSigners);
  }

  async updateMarginBasket(
    entropyGroup: EntropyGroup,
    entropyAccount: EntropyAccount,
    payer: Account | WalletAdapter,
  ) {
    const instruction = makeUpdateMarginBasketInstruction(
      this.programId,
      entropyGroup.publicKey,
      entropyAccount.publicKey,
      entropyAccount.spotOpenOrders,
    );
    const transaction = new Transaction();
    transaction.add(instruction);
    const additionalSigners = [];
    return await this.sendTransaction(transaction, payer, additionalSigners);
  }
}

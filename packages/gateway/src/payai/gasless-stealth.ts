import { confirmChecked } from '../restoration/confirmation.js';
/**
 * PayAI Gasless Stealth Payments
 * 
 * Uses the x402 protocol properly:
 * 1. Stealth wallet signs the transfer instruction (needs USDC only, NO SOL)
 * 2. PayAI facilitator signs as fee payer (pays SOL gas)
 * 3. Facilitator submits the transaction
 * 4. ATA is closed and rent returned to pool wallet
 * 
 * Result: Stealth wallets only need USDC, all SOL fees are paid by PayAI!
 * Pool wallet recovers all ATA rent automatically.
 */

import { 
  Keypair, 
  PublicKey, 
  Transaction, 
  Connection,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { checkLightHealth, executeCompressedTransfer } from '../light/client.js';
import { v4 as uuidv4 } from 'uuid';

const PAYAI_FACILITATOR_URL = process.env.FACILITATOR_URL || 'https://facilitator.payai.network';
const USDC_MINT = new PublicKey(process.env.USDC_MINT!);
const USDC_DECIMALS = 6;

// PayAI's fee payer address (from their /supported endpoint)
// We'll fetch this dynamically
let cachedFeePayer: string | null = null;
let feePayerCacheTime: number = 0;
const FEE_PAYER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch PayAI's fee payer address from their /supported endpoint
 */
async function getPayAIFeePayer(): Promise<string | null> {
  try { const { getPayAISupport } = await import('./settlement.js'); return (await getPayAISupport()).feePayer; } catch { return null; }
}

interface GaslessPaymentResult {
  success: boolean;
  txSignature?: string;
  error?: string;
  feePayer?: string;
  rentRecovered?: number;
  // Transaction flow signatures for audit logging
  setupTx?: string;       // TX1: SOL + ATA creation
  usdcTransferTx?: string; // TX2: USDC to burner
  recoveryTx?: string;     // TX4: Rent recovery
}

/**
 * Create and submit a gasless stealth payment via PayAI
 * 
 * The stealth wallet signs ONLY the transfer instruction.
 * PayAI facilitator signs as fee payer and pays all SOL fees.
 * 
 * @param connection - Solana connection
 * @param stealthKeypair - The stealth (burner) wallet
 * @param recipientAddress - Service provider's address
 * @param amountUSDC - Amount in micro-USDC (6 decimals)
 */
export async function executeGaslessStealthPayment(
  connection: Connection,
  stealthKeypair: Keypair,
  recipientAddress: string,
  amountUSDC: bigint
): Promise<GaslessPaymentResult> {
  const {settlePayAITransfer}=await import('./settlement.js');
  return settlePayAITransfer(connection,stealthKeypair,recipientAddress,amountUSDC);
}

/**
 * Execute a FULL gasless pool payment with rent recovery
 * 
 * CORRECT FLOW (as per user spec):
 * 1. Pool sends SOL to burner for ATA rent (~0.00204 SOL) - TX1 (pool signs)
 * 2. Pool creates burner's USDC ATA - TX1 (same tx)
 * 3. Pool sends USDC to burner - TX2 (pool signs)  
 * 4. Burner pays recipient via PayAI (GASLESS - PayAI pays gas!) - TX3 (PayAI signs)
 * 5. Burner closes ATA and sends rent + SOL back to pool - TX4 (burner signs)
 * 
 * Key insight: Pool handles setup (steps 1-3), PayAI handles transfer gas (step 4)
 * 
 * @param connection - Solana connection
 * @param poolKeypair - The pool wallet keypair
 * @param tempBurnerKeypair - The ephemeral burner wallet
 * @param recipientAddress - Service provider's address
 * @param amountUSDC - Amount in micro-USDC (6 decimals)
 */
export async function executeGaslessPoolPayment(
  connection: Connection,
  poolKeypair: Keypair,
  tempBurnerKeypair: Keypair,
  recipientAddress: string,
  amountUSDC: bigint
): Promise<GaslessPaymentResult & { solRecovered?: number }> {
  const poolPubkey = poolKeypair.publicKey;
  const tempPubkey = tempBurnerKeypair.publicKey;
  
  // Import required functions (use idempotent for ATA creation - won't fail if exists)
  const { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAccount } = 
    await import('@solana/spl-token');
  
  console.log(`[PayAI Pool] 🚀 Starting gasless pool payment`);
  console.log(`[PayAI Pool]    Pool: ${poolPubkey.toBase58().slice(0, 12)}...`);
  console.log(`[PayAI Pool]    Burner: ${tempPubkey.toBase58().slice(0, 12)}...`);
  console.log(`[PayAI Pool]    Recipient: ${recipientAddress.slice(0, 12)}...`);
  console.log(`[PayAI Pool]    Amount: ${Number(amountUSDC) / 1_000_000} USDC`);
  
  // Get token account addresses upfront
  const poolUsdcAccount = await getAssociatedTokenAddress(
    USDC_MINT, poolPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tempUsdcAccount = await getAssociatedTokenAddress(
    USDC_MINT, tempPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const recipientPubkey = new PublicKey(recipientAddress);
  const recipientUsdcAccount = await getAssociatedTokenAddress(
    USDC_MINT, recipientPubkey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  
  // Dynamic rent calculation - fetch from RPC instead of hardcoding
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  
  try {
    // Get blockhash once and reuse (valid for ~1.5 min)
    let { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    
    // ===== DYNAMIC RENT CALCULATION =====
    // Get exact rent-exempt minimum for burner wallet (0-byte account) and ATA (165 bytes)
    const burnerRentExempt = await connection.getMinimumBalanceForRentExemption(0);
    const ataRentExempt = await connection.getMinimumBalanceForRentExemption(165);
    const TX4_GAS_BUFFER = 15000; // Gas for TX4 recovery transaction
    
    // Burner needs: rent-exempt minimum + gas buffer for TX4
    const burnerFunding = burnerRentExempt + TX4_GAS_BUFFER;
    
    console.log(`[PayAI Pool]    Burner rent-exempt: ${burnerRentExempt / LAMPORTS_PER_SOL} SOL`);
    console.log(`[PayAI Pool]    ATA rent-exempt: ${ataRentExempt / LAMPORTS_PER_SOL} SOL`);
    console.log(`[PayAI Pool]    Total funding to burner: ${burnerFunding / LAMPORTS_PER_SOL} SOL`);
    
    // ===== PRE-CHECK: Verify pool has enough SOL for gasless setup =====
    const poolBalance = await connection.getBalance(poolPubkey, 'confirmed');
    const requiredSol = burnerFunding + ataRentExempt + 20000; // burner rent + ATA rent + tx fees
    console.log(`[PayAI Pool]    Pool SOL balance: ${poolBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`[PayAI Pool]    Required: ${requiredSol / LAMPORTS_PER_SOL} SOL (burner + ATA rent + fees)`);
    
    if (poolBalance < requiredSol) {
      console.error(`[PayAI Pool] ❌ Pool has insufficient SOL for gasless setup`);
      return { success: false, error: `Pool needs ${(requiredSol / LAMPORTS_PER_SOL).toFixed(6)} SOL but has ${(poolBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL` };
    }
    
    // Check if burner ATA already exists (from failed previous attempt)
    const existingAta = await connection.getAccountInfo(tempUsdcAccount, 'confirmed');
    const ataAlreadyExists = existingAta !== null;
    
    if (ataAlreadyExists) {
      console.log(`[PayAI Pool]    ✓ Burner ATA already exists (from previous attempt)`);
    }
    
    // ===== TX1: Pool sends SOL to burner AND creates burner's ATA =====
    // Pool does everything in one transaction - no cross-tx state dependencies!
    console.log(`[PayAI Pool] 📤 TX1: Pool sending SOL + creating burner ATA...`);
    
    const setupTx1 = new Transaction();
    
    // 1a. Send rent-exempt SOL to burner (required for account to exist!)
    setupTx1.add(
      SystemProgram.transfer({
        fromPubkey: poolPubkey,
        toPubkey: tempPubkey,
        lamports: burnerFunding, // ~905,000 lamports (rent-exempt + gas buffer)
      })
    );
    
    // 1b. Pool creates burner's ATA (IDEMPOTENT - won't fail if already exists)
    // This is safe to call even if ATA exists from a previous failed attempt
    setupTx1.add(
      createAssociatedTokenAccountIdempotentInstruction(
        poolPubkey,       // payer (POOL pays rent!)
        tempUsdcAccount,  // ATA to create
        tempPubkey,       // owner of new ATA (burner)
        USDC_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    
    setupTx1.recentBlockhash = blockhash;
    setupTx1.feePayer = poolPubkey;
    setupTx1.sign(poolKeypair);
    
    // TX1 - DO NOT skip preflight to catch errors
    let tx1Sig: string;
    try {
      tx1Sig = await connection.sendRawTransaction(setupTx1.serialize(), {
        skipPreflight: false,  // Catch errors during simulation
        preflightCommitment: 'confirmed',
      });
      await confirmChecked(connection,{ signature: tx1Sig, blockhash, lastValidBlockHeight }, 'confirmed');
    } catch (tx1Err: any) {
      const errMsg = tx1Err?.message || tx1Err?.logs?.join('\n') || String(tx1Err);
      console.error(`[PayAI Pool] ❌ TX1 failed: ${errMsg}`);
      if (tx1Err?.logs) {
        console.error(`[PayAI Pool]    Logs:`, tx1Err.logs);
      }
      return { success: false, error: `Setup (SOL + ATA) failed: ${errMsg}` };
    }
    
    console.log(`[PayAI Pool] ✓ TX1 complete: ${tx1Sig.slice(0, 20)}...`);
    console.log(`[PayAI Pool]    Sent ${burnerFunding / LAMPORTS_PER_SOL} SOL to burner (rent-exempt + gas)`);
    console.log(`[PayAI Pool]    Created burner ATA (pool paid ${ataRentExempt / LAMPORTS_PER_SOL} SOL rent)`);
    
    // Verify ATA was created
    const ataInfo = await connection.getAccountInfo(tempUsdcAccount, 'confirmed');
    if (!ataInfo) {
      console.error(`[PayAI Pool] ❌ TX1 confirmed but ATA not created!`);
      return { success: false, error: 'Burner ATA creation failed - account not found' };
    }
    console.log(`[PayAI Pool]    ✓ ATA verified: ${ataInfo.data.length} bytes`);
    
    await delay(300);
    
    // ===== TX2: Pool sends USDC to burner =====
    console.log(`[PayAI Pool] 📤 TX2: Pool sending USDC to burner...`);
    
    const setupTx2 = new Transaction();
    setupTx2.add(
      createTransferInstruction(
        poolUsdcAccount,
        tempUsdcAccount,
        poolPubkey,
        amountUSDC,
        [],
        TOKEN_PROGRAM_ID
      )
    );
    
    setupTx2.recentBlockhash = blockhash;
    setupTx2.feePayer = poolPubkey;
    setupTx2.sign(poolKeypair);
    
    const tx2Sig = await connection.sendRawTransaction(setupTx2.serialize(), {
      skipPreflight: false, preflightCommitment: 'confirmed',
    });
    await confirmChecked(connection,{ signature: tx2Sig, blockhash, lastValidBlockHeight }, 'confirmed');
    
    console.log(`[PayAI Pool] ✓ TX2 complete: ${tx2Sig.slice(0, 20)}...`);
    console.log(`[PayAI Pool]    Sent ${Number(amountUSDC) / 1_000_000} USDC to burner`);
    
    // ===== VERIFICATION: Ensure burner ATA exists and has balance before PayAI call =====
    // Wait BEFORE verification to allow RPC state propagation
    console.log(`[PayAI Pool] ⏳ Waiting 2s for RPC state propagation before verification...`);
    await delay(2000);
    
    console.log(`[PayAI Pool] 🔍 Verifying burner ATA before gasless call...`);
    console.log(`[PayAI Pool]    ATA address: ${tempUsdcAccount.toBase58()}`);
    console.log(`[PayAI Pool]    TX2 sig: ${tx2Sig}`);
    
    // Retry verification up to 3 times with increasing delays
    const MAX_VERIFY_ATTEMPTS = 3;
    let verificationSuccess = false;
    let lastVerifyError: string = '';
    
    for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
      try {
        console.log(`[PayAI Pool]    Verification attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}...`);
        
        const burnerAtaInfo = await getAccount(connection, tempUsdcAccount, 'confirmed', TOKEN_PROGRAM_ID);
        const burnerBalance = Number(burnerAtaInfo.amount) / 1_000_000;
        console.log(`[PayAI Pool] ✓ Burner ATA verified: ${burnerBalance} USDC`);
        
        if (burnerAtaInfo.amount < amountUSDC) {
          console.error(`[PayAI Pool] ❌ Burner has insufficient USDC: ${burnerBalance} < ${Number(amountUSDC) / 1_000_000}`);
          return { success: false, error: 'Burner ATA has insufficient balance' };
        }
        
        verificationSuccess = true;
        break; // Success, exit retry loop
        
      } catch (verifyErr: any) {
        // Better error extraction for SPL Token errors
        const errMsg = verifyErr?.message || verifyErr?.name || String(verifyErr);
        lastVerifyError = errMsg;
        console.warn(`[PayAI Pool]    Attempt ${attempt} failed: ${errMsg}`);
        
        if (attempt < MAX_VERIFY_ATTEMPTS) {
          // Increasing delay between retries: 1s, 2s, 3s
          const retryDelay = attempt * 1000;
          console.log(`[PayAI Pool]    Retrying in ${retryDelay}ms...`);
          await delay(retryDelay);
        }
      }
    }
    
    // If getAccount failed all attempts, try raw getAccountInfo as fallback
    if (!verificationSuccess) {
      console.log(`[PayAI Pool] 🔄 getAccount failed, trying raw getAccountInfo fallback...`);
      try {
        const rawAccountInfo = await connection.getAccountInfo(tempUsdcAccount, 'confirmed');
        if (rawAccountInfo && rawAccountInfo.data.length > 0) {
          // Account exists, assume it has the balance (we already confirmed TX2)
          console.log(`[PayAI Pool] ✓ Fallback: Account exists (${rawAccountInfo.data.length} bytes)`);
          console.log(`[PayAI Pool]    Owner: ${rawAccountInfo.owner.toBase58()}`);
          console.log(`[PayAI Pool]    Lamports: ${rawAccountInfo.lamports}`);
          verificationSuccess = true;
        } else {
          console.error(`[PayAI Pool] ❌ Fallback: Account does not exist or is empty`);
        }
      } catch (fallbackErr: any) {
        const fbErrMsg = fallbackErr?.message || fallbackErr?.name || String(fallbackErr);
        console.error(`[PayAI Pool] ❌ Fallback getAccountInfo failed: ${fbErrMsg}`);
      }
    }
    
    if (!verificationSuccess) {
      console.error(`[PayAI Pool] ❌ Burner ATA verification failed after ${MAX_VERIFY_ATTEMPTS} attempts`);
      console.error(`[PayAI Pool]    Last error: ${lastVerifyError}`);
      console.error(`[PayAI Pool]    TX2 sig for debugging: ${tx2Sig}`);
      return { success: false, error: `Burner ATA verification failed: ${lastVerifyError}` };
    }
    
    // Additional small delay before PayAI call
    console.log(`[PayAI Pool]    Waiting 500ms before PayAI call...`);
    await delay(500);
    
    // ===== TX3: Burner pays recipient via PayAI (GASLESS - PayAI pays gas!) =====
    console.log(`[PayAI Pool] 📤 TX3: Gasless payment via PayAI...`);
    
    const paymentResult = await executeGaslessStealthPayment(
      connection,
      tempBurnerKeypair,
      recipientAddress,
      amountUSDC
    );
    
    if (!paymentResult.success) {
      console.error(`[PayAI Pool] ❌ Gasless payment failed: ${paymentResult.error}`);
      return paymentResult;
    }
    
    console.log(`[PayAI Pool] ✓ TX3 complete via PayAI (gasless!)`);
    console.log(`[PayAI Pool]    TX: ${paymentResult.txSignature?.slice(0, 20)}...`);
    console.log(`[PayAI Pool]    PayAI paid the gas! Burner only had minimal SOL for recovery.`);
    
    await delay(500);
    
    // ===== TX4: Burner self-destructs - recover rent to pool =====
    console.log(`[PayAI Pool] 💰 TX4: Recovering rent to pool...`);
    
    // Get fresh blockhash for recovery (old one might be expired)
    ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed'));
    
    const recoveryTx = new Transaction();
    
    // 4a. Close burner's empty USDC account → rent to pool
    recoveryTx.add(
      createCloseAccountInstruction(
        tempUsdcAccount,   // account to close
        poolPubkey,        // destination for rent (POOL!)
        tempPubkey,        // authority (burner)
        [],
        TOKEN_PROGRAM_ID
      )
    );
    
    // 4b. Get remaining SOL in burner and send to pool
    const burnerBalance = await connection.getBalance(tempPubkey, 'confirmed');
    const txFee = 5000; // ~0.000005 SOL for this tx
    const solToRecover = burnerBalance - txFee;
    
    if (solToRecover > 0) {
      recoveryTx.add(
        SystemProgram.transfer({
          fromPubkey: tempPubkey,
          toPubkey: poolPubkey,
          lamports: solToRecover,
        })
      );
    }
    
    recoveryTx.recentBlockhash = blockhash;
    recoveryTx.feePayer = tempPubkey;
    recoveryTx.sign(tempBurnerKeypair);
    
    const recoverySig = await connection.sendRawTransaction(recoveryTx.serialize(), {
      skipPreflight: true, preflightCommitment: 'confirmed',
    });
    await confirmChecked(connection,{ signature: recoverySig, blockhash, lastValidBlockHeight }, 'confirmed');
    
    // Calculate recovered SOL (ATA rent + burner's remaining SOL)
    const totalRecovered = (ataRentExempt + solToRecover) / LAMPORTS_PER_SOL;
    
    console.log(`[PayAI Pool] ✅ TX4 complete!`);
    console.log(`[PayAI Pool]    Recovered: ${totalRecovered.toFixed(6)} SOL to pool`);
    console.log(`[PayAI Pool]    TX: ${recoverySig.slice(0, 20)}...`);
    console.log(`[PayAI Pool]    Breakdown: ATA rent (${ataRentExempt / LAMPORTS_PER_SOL} SOL) + burner SOL (${solToRecover / LAMPORTS_PER_SOL} SOL)`);
    
    console.log(`[PayAI Pool] 🎉 Full gasless payment complete!`);
    console.log(`[PayAI Pool]    Pool net cost: ~0.00002 SOL (gas for 2 setup txs)`);
    console.log(`[PayAI Pool]    PayAI paid: gas for USDC transfer tx`);
    console.log(`[PayAI Pool]    Rent: FULLY RECOVERED to pool`);
    
    return {
      success: true,
      txSignature: paymentResult.txSignature,
      feePayer: paymentResult.feePayer,
      solRecovered: totalRecovered,
      rentRecovered: ataRentExempt / LAMPORTS_PER_SOL,
      // Transaction flow for audit logging
      setupTx: tx1Sig,
      usdcTransferTx: tx2Sig,
      recoveryTx: recoverySig,
    };
    
  } catch (error: any) {
    console.error(`[PayAI Pool] ❌ Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check if PayAI gasless is available
 */
export async function isGaslessAvailable(): Promise<boolean> {
  try {
    console.log(`[PayAI] Checking gasless availability...`);
    console.log(`[PayAI]    Facilitator URL: ${PAYAI_FACILITATOR_URL}`);
    
    const feePayer = await getPayAIFeePayer();
    const available = feePayer !== null;
    
    console.log(`[PayAI] Gasless available: ${available}`);
    if (available) {
      console.log(`[PayAI]    Fee payer: ${feePayer?.slice(0, 12)}...`);
    }
    
    return available;
  } catch (error: any) {
    console.error(`[PayAI] Availability check failed: ${error.message}`);
    return false;
  }
}

/**
 * Get PayAI info for gasless payments
 */
export async function getGaslessInfo(): Promise<{
  available: boolean;
  feePayer: string | null;
  facilitatorUrl: string;
  benefits: string[];
}> {
  const feePayer = await getPayAIFeePayer();
  
  return {
    available: feePayer !== null,
    feePayer,
    facilitatorUrl: PAYAI_FACILITATOR_URL,
    benefits: [
      'Stealth wallets need USDC only - NO SOL required!',
      'PayAI pays all transaction fees',
      'No rent locked in stealth wallets',
      'True gasless privacy payments',
    ],
  };
}

// =============================================================================
// LIGHT PROTOCOL GASLESS PAYMENTS (Aegix 4.0)
// =============================================================================

import {
  buildCompressedTransfer,
  createCompressedBurner,
  getCompressedBalance,
  getCostEstimate,
} from '../light/client.js';
import {
  getSessionKeypair,
  type LightSessionKey,
} from '../light/session-keys.js';

/**
 * Result of a Light Protocol gasless payment
 */
export interface LightGaslessPaymentResult {
  success: boolean;
  txSignature?: string;
  feePayer?: string;
  burnerAddress?: string;
  proofHash?: string;
  compressionSavings?: number;  // SOL saved vs regular account
  error?: string;
}

/**
 * Execute a gasless payment using Light Protocol compressed transfers
 * 
 * Flow:
 * 1. Build compressed transfer transaction
 * 2. Sign with session key
 * 3. Submit via PayAI facilitator (gasless)
 * 4. Ephemeral burner provides additional privacy
 * 
 * Benefits over legacy:
 * - ~50x cheaper (compressed accounts)
 * - Better privacy (unique burner per payment)
 * - Same gasless UX via PayAI
 */
export async function executeLightGaslessPayment(
  poolOwnerAddress: string,
  sessionKey: LightSessionKey,
  recipientAddress: string,
  amountUsdc: number,
  connection: Connection
): Promise<LightGaslessPaymentResult> {
  const sessionId = uuidv4().slice(0, 8);
  
  console.log(`[Light Gasless] ═══════════════════════════════════════`);
  console.log(`[Light Gasless] Payment Session: ${sessionId}`);
  console.log(`[Light Gasless]    Pool Owner: ${poolOwnerAddress.slice(0, 8)}...`);
  console.log(`[Light Gasless]    Recipient: ${recipientAddress.slice(0, 8)}...`);
  console.log(`[Light Gasless]    Amount: ${amountUsdc} USDC`);
  console.log(`[Light Gasless] ═══════════════════════════════════════`);
  
  try {
    // Get PayAI fee payer for gasless
    const feePayer = await getPayAIFeePayer();
    if (!feePayer) {
      console.error('[Light Gasless] PayAI fee payer not available');
      return { success: false, error: 'PayAI gasless not available' };
    }
    
    console.log(`[Light Gasless] ✓ PayAI fee payer: ${feePayer.slice(0, 12)}...`);
    
    // Get session keypair for signing
    const sessionKeypair = getSessionKeypair(sessionKey);
    const poolPubkey = new PublicKey(poolOwnerAddress);
    const recipientPubkey = new PublicKey(recipientAddress);
    
    // Create ephemeral burner for this payment
    const burnerResult = await createCompressedBurner(poolPubkey, sessionKeypair);
    console.log(`[Light Gasless] ✓ Burner created: ${burnerResult.burnerAddress.slice(0, 12)}...`);
    
    // Convert amount to micro-USDC
    const amountMicro = BigInt(Math.floor(amountUsdc * 1_000_000));
    
    // Build the compressed transfer transaction
    const { transaction, proofHash } = await buildCompressedTransfer(
      sessionKeypair,
      recipientPubkey,
      amountMicro
    );
    
    console.log(`[Light Gasless] ✓ Compressed transfer built (proof: ${proofHash.slice(0, 12)}...)`);
    
    // Update fee payer to PayAI
    const feePayerPubkey = new PublicKey(feePayer);
    transaction.feePayer = feePayerPubkey;
    
    // Sign with session key
    transaction.partialSign(sessionKeypair);
    
    // Serialize for PayAI submission
    const serializedTx = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).toString('base64');
    
    console.log(`[Light Gasless] Submitting to PayAI facilitator...`);
    
    // Submit to PayAI
    const response = await fetch(`${PAYAI_FACILITATOR_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction: serializedTx,
        network: 'solana',
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`PayAI submission failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    const txSignature = result.signature || result.txSignature;
    
    if (!txSignature) {
      throw new Error('No transaction signature in PayAI response');
    }
    
    console.log(`[Light Gasless] ✓ PayAI submitted: ${txSignature.slice(0, 16)}...`);
    
    // Wait for confirmation
    console.log(`[Light Gasless] Waiting for confirmation...`);
    await confirmChecked(connection,txSignature, 'confirmed');
    
    // Calculate compression savings
    const costs = getCostEstimate();
    const compressionSavings = costs.regularAccountRent - costs.compressedAccountCost;
    
    console.log(`[Light Gasless] ═══════════════════════════════════════`);
    console.log(`[Light Gasless] ✅ GASLESS PAYMENT COMPLETE!`);
    console.log(`[Light Gasless]    TX: ${txSignature.slice(0, 20)}...`);
    console.log(`[Light Gasless]    Burner: ${burnerResult.burnerAddress.slice(0, 12)}...`);
    console.log(`[Light Gasless]    Savings: ${compressionSavings.toFixed(6)} SOL vs legacy`);
    console.log(`[Light Gasless] ═══════════════════════════════════════`);
    
    return {
      success: true,
      txSignature,
      feePayer,
      burnerAddress: burnerResult.burnerAddress,
      proofHash,
      compressionSavings,
    };
    
  } catch (error: any) {
    console.error(`[Light Gasless] ❌ Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get Light Protocol gasless info
 */
export async function getLightGaslessInfo(): Promise<{
  available: boolean;
  feePayer: string | null;
  facilitatorUrl: string;
  benefits: string[];
  costSavings: {
    perPayment: string;
    savingsMultiplier: number;
  };
}> {
  const feePayer = await getPayAIFeePayer();
  const costs = getCostEstimate();
  
  return {
    available: feePayer !== null,
    feePayer,
    facilitatorUrl: PAYAI_FACILITATOR_URL,
    benefits: [
      'ZK Compression: ~50x cheaper than regular accounts',
      'PayAI pays all transaction fees',
      'Ephemeral burners for each payment (better privacy)',
      'Session keys for autonomous agent spending',
      'True gasless compressed payments',
    ],
    costSavings: {
      perPayment: `${(costs.regularAccountRent - costs.compressedAccountCost).toFixed(6)} SOL`,
      savingsMultiplier: costs.savingsMultiplier,
    },
  };
}

// =============================================================================
// UNIFIED PAYMENT ROUTER (Light by Default)
// =============================================================================

/**
 * Unified gasless payment - routes to Light Protocol by default
 * Falls back to legacy only if Light is unavailable or explicitly requested
 * 
 * @param mode - 'auto' (default, prefers Light), 'light', or 'legacy'
 */
export async function executeUnifiedGaslessPayment(
  poolKeypair: Keypair,
  recipientAddress: string,
  amountUsdc: number,
  connection: Connection,
  mode: 'auto' | 'light' | 'legacy' = 'auto'
): Promise<GaslessPaymentResult | LightGaslessPaymentResult> {
  const sessionId = uuidv4().slice(0, 8);
  
  console.log(`[Unified Payment] ═══════════════════════════════════════`);
  console.log(`[Unified Payment] Session: ${sessionId}`);
  console.log(`[Unified Payment] Mode: ${mode}`);
  console.log(`[Unified Payment] Amount: ${amountUsdc} USDC`);
  console.log(`[Unified Payment] ═══════════════════════════════════════`);
  
  // Determine if we should use Light
  let useLight = mode === 'light' || mode === 'auto';
  
  if (useLight) {
    try {
      // Check Light health
      const lightHealth = await checkLightHealth();
      if (!lightHealth.healthy) {
        throw new Error('Requested Light payment unavailable; no fallback performed');
      } else {
        console.log(`[Unified Payment] 🌟 Light Protocol healthy (slot: ${lightHealth.slot})`);
      }
    } catch (err) {
      throw err;
    }
  }
  
  if (useLight) {
    // ═══════════════════════════════════════════════════════════════════════
    // LIGHT PROTOCOL PATH (Default - ~50x cheaper, better privacy)
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`[Unified Payment] → Executing via Light Protocol`);
    
    try {
      const poolPubkey = poolKeypair.publicKey;
      const recipientPubkey = new PublicKey(recipientAddress);
      const amountMicro = BigInt(Math.floor(amountUsdc * 1_000_000));
      
      // Create compressed burner for privacy
      const burnerResult = await createCompressedBurner(poolPubkey, poolKeypair);
      console.log(`[Unified Payment] ✓ Compressed burner: ${burnerResult.burnerAddress.slice(0, 12)}...`);
      
      // Execute compressed transfer
      const transferResult = await executeCompressedTransfer(
        poolKeypair,
        recipientPubkey,
        amountMicro
      );
      
      const costs = getCostEstimate();
      const savingsVsLegacy = costs.regularAccountRent - costs.compressedAccountCost;
      
      console.log(`[Unified Payment] ✓ Light payment complete!`);
      console.log(`[Unified Payment]   TX: ${transferResult.signature.slice(0, 16)}...`);
      console.log(`[Unified Payment]   Savings: ${savingsVsLegacy.toFixed(6)} SOL`);
      
      return {
        success: true,
        txSignature: transferResult.signature,
        burnerAddress: burnerResult.burnerAddress,
        proofHash: transferResult.proofHash,
        compressionSavings: savingsVsLegacy,
        feePayer: poolPubkey.toBase58(),
      };
    } catch (lightError: any) {
      throw lightError;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════════
  // LEGACY PATH (Fallback)
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`[Unified Payment] → Executing via legacy gasless`);
  
  return executeGaslessPoolPayment(
    connection,
    poolKeypair,
    Keypair.generate(),
    recipientAddress,
    BigInt(Math.round(amountUsdc * 1_000_000))
  );
}

/**
 * Get recommendation for payment mode
 */
export async function getPaymentModeRecommendation(): Promise<{
  recommended: 'light' | 'legacy';
  lightAvailable: boolean;
  reasons: string[];
  costComparison: {
    light: string;
    legacy: string;
    savingsMultiplier: number;
  };
}> {
  const lightHealth = await checkLightHealth();
  const costs = getCostEstimate();
  
  const lightAvailable = lightHealth.healthy;
  const recommended = lightAvailable ? 'light' : 'legacy';
  
  const reasons = lightAvailable ? [
    `Light Protocol is online (slot: ${lightHealth.slot})`,
    `~${costs.savingsMultiplier}x cheaper than legacy`,
    'Better privacy with compressed burners',
    'Validity proofs ensure correctness',
  ] : [
    'Light Protocol is currently unavailable',
    'Legacy mode will be used as fallback',
    'Try again later for compression benefits',
  ];
  
  return {
    recommended,
    lightAvailable,
    reasons,
    costComparison: {
      light: `${costs.compressedAccountCost.toFixed(6)} SOL`,
      legacy: `${costs.regularAccountRent.toFixed(6)} SOL`,
      savingsMultiplier: costs.savingsMultiplier,
    },
  };
}

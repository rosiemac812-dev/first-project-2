const crypto = require('node:crypto');

/**
 * Stripe Balance & Connect Fund Flows Service
 * Supports live Stripe API (if STRIPE_SECRET_KEY is provided)
 * and a high-fidelity local simulator for interactive testing and demonstration.
 */
class StripeService {
  constructor() {
    this.apiKey = process.env.STRIPE_SECRET_KEY || null;
    this.stripeClient = null;
    if (this.apiKey) {
      try {
        const Stripe = require('stripe');
        this.stripeClient = new Stripe(this.apiKey);
      } catch (err) {
        console.warn('Could not initialize Stripe SDK:', err.message);
      }
    }

    this.resetSimulation();
  }

  /**
   * Reset simulation to a fresh test state (Phase 2 baseline)
   */
  resetSimulation() {
    this.simulated = {
      livemode: false,
      platformBalance: {
        available: [{ currency: 'usd', amount: 0 }],
        pending: [{ currency: 'usd', amount: 0 }]
      },
      accounts: new Map(), // acctId -> account object
      transfers: new Map(), // transferId -> transfer object
      charges: [],
      payouts: [],
      logs: []
    };
    this.log('Simulation initialized at fresh baseline ($0.00 platform balance).');
  }

  log(message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      message,
      data
    };
    this.simulated.logs.unshift(entry);
    if (this.simulated.logs.length > 50) this.simulated.logs.pop();
    return entry;
  }

  setApiKey(key) {
    this.apiKey = key;
    if (key && key.startsWith('sk_')) {
      const Stripe = require('stripe');
      this.stripeClient = new Stripe(key);
      this.log(`Configured real Stripe secret key (${key.slice(0, 7)}...)`);
    } else {
      this.stripeClient = null;
      this.log('Switched to simulated Stripe mode.');
    }
  }

  isLive() {
    return Boolean(this.stripeClient);
  }

  // --- Phase 2: Retrieve Platform Balance ---
  async getBalance() {
    if (this.stripeClient) {
      return await this.stripeClient.balance.retrieve();
    }
    return {
      object: 'balance',
      livemode: false,
      available: this.simulated.platformBalance.available,
      pending: this.simulated.platformBalance.pending
    };
  }

  // --- Phase 3: Seed Test Funds (Charges) ---
  async seedCharge({ amount = 10000, currency = 'usd', token = 'tok_visa', autoClear = false }) {
    if (token === 'tok_chargeDeclined') {
      const err = new Error('Your card was declined. The payment could not be processed.');
      err.code = 'card_declined';
      err.statusCode = 402;
      this.log('Card declined simulation using tok_chargeDeclined', { amount, token });
      throw err;
    }

    if (this.stripeClient) {
      const charge = await this.stripeClient.charges.create({
        amount,
        currency,
        source: token,
        description: 'Test fund seed'
      });
      return charge;
    }

    // Simulated charge
    const chargeId = `ch_${crypto.randomBytes(12).toString('hex')}`;
    const charge = {
      id: chargeId,
      object: 'charge',
      amount,
      currency,
      status: 'succeeded',
      paid: true,
      captured: true,
      payment_method_details: {
        card: {
          brand: token === 'tok_visa_debit' ? 'visa_debit' : 'visa',
          funding: token === 'tok_visa_debit' ? 'debit' : 'credit'
        }
      },
      created: Math.floor(Date.now() / 1000)
    };

    if (autoClear) {
      this.simulated.platformBalance.available[0].amount += amount;
      this.log(`Seeded $${(amount / 100).toFixed(2)} USD directly to Available balance.`);
    } else {
      this.simulated.platformBalance.pending[0].amount += amount;
      this.log(`Seeded $${(amount / 100).toFixed(2)} USD into Pending balance (requires clearing).`);
    }

    this.simulated.charges.push(charge);
    return charge;
  }

  // --- Phase 6: Accelerate Test Time (Pending -> Available) ---
  acceleratePendingFunds() {
    const pendingAmount = this.simulated.platformBalance.pending[0].amount;
    if (pendingAmount <= 0) {
      return { moved: 0, balance: this.simulated.platformBalance };
    }
    this.simulated.platformBalance.available[0].amount += pendingAmount;
    this.simulated.platformBalance.pending[0].amount = 0;
    this.log(`Accelerated test time: Moved $${(pendingAmount / 100).toFixed(2)} USD from Pending to Available.`);
    return { moved: pendingAmount, balance: this.simulated.platformBalance };
  }

  // --- Phase 4: Create Connected Account ---
  async createConnectedAccount({ type = 'express', country = 'US', email = null }) {
    if (this.stripeClient) {
      return await this.stripeClient.accounts.create({ type, country, email: email || undefined });
    }

    const acctId = `acct_${crypto.randomBytes(8).toString('hex')}`;
    const account = {
      id: acctId,
      object: 'account',
      type,
      country,
      email: email || `seller_${acctId.slice(5, 11)}@example.com`,
      payouts_enabled: true,
      charges_enabled: true,
      capabilities: { transfers: 'active', card_payments: 'active' },
      requirements: {
        currently_due: [],
        eventually_due: [],
        past_due: []
      },
      balance: {
        available: [{ currency: 'usd', amount: 0 }],
        pending: [{ currency: 'usd', amount: 0 }]
      },
      created: Math.floor(Date.now() / 1000)
    };

    this.simulated.accounts.set(acctId, account);
    this.log(`Created Express connected account ${acctId} (${account.email}).`);
    return account;
  }

  listConnectedAccounts() {
    return Array.from(this.simulated.accounts.values()).map(acc => ({
      id: acc.id,
      email: acc.email,
      type: acc.type,
      payouts_enabled: acc.payouts_enabled,
      availableBalance: acc.balance.available[0].amount,
      requirementsCount: acc.requirements.currently_due.length
    }));
  }

  async getConnectedAccountBalance(accountId) {
    if (this.stripeClient) {
      return await this.stripeClient.balance.retrieve({ stripeAccount: accountId });
    }
    const acc = this.simulated.accounts.get(accountId);
    if (!acc) {
      const err = new Error(`Connected account '${accountId}' not found.`);
      err.statusCode = 404;
      throw err;
    }
    return acc.balance;
  }

  // --- Phase 4: Transfer Funds to Connected Account ---
  async createTransfer({ amount, currency = 'usd', destination }) {
    if (!amount || amount <= 0) {
      const err = new Error('Transfer amount must be greater than zero.');
      err.statusCode = 400;
      throw err;
    }

    if (this.stripeClient) {
      return await this.stripeClient.transfers.create({
        amount,
        currency,
        destination
      });
    }

    const acc = this.simulated.accounts.get(destination);
    if (!acc) {
      const err = new Error(`Destination account '${destination}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    const available = this.simulated.platformBalance.available[0].amount;
    if (available < amount) {
      const err = new Error(`Insufficient platform available balance ($${(available / 100).toFixed(2)}) for transfer of $${(amount / 100).toFixed(2)}.`);
      err.statusCode = 400;
      throw err;
    }

    // Deduct from platform, add to connected account
    this.simulated.platformBalance.available[0].amount -= amount;
    acc.balance.available[0].amount += amount;

    const transferId = `tr_${crypto.randomBytes(12).toString('hex')}`;
    const transfer = {
      id: transferId,
      object: 'transfer',
      amount,
      currency,
      destination,
      reversed: false,
      amount_reversed: 0,
      created: Math.floor(Date.now() / 1000)
    };

    this.simulated.transfers.set(transferId, transfer);
    this.log(`Transferred $${(amount / 100).toFixed(2)} USD to ${destination} (Transfer ID: ${transferId}).`);
    return transfer;
  }

  // --- Phase 5 Pattern 2: Clawback / Transfer Reversal ---
  async reverseTransfer({ transferId, amount = null }) {
    if (this.stripeClient) {
      return await this.stripeClient.transfers.createReversal(transferId, {
        amount: amount || undefined
      });
    }

    const transfer = this.simulated.transfers.get(transferId);
    if (!transfer) {
      const err = new Error(`Transfer '${transferId}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    const reverseAmount = amount || (transfer.amount - transfer.amount_reversed);
    const acc = this.simulated.accounts.get(transfer.destination);

    if (acc.balance.available[0].amount < reverseAmount) {
      const err = new Error(`Connected account ${acc.id} has insufficient funds ($${(acc.balance.available[0].amount / 100).toFixed(2)}) for clawback of $${(reverseAmount / 100).toFixed(2)}.`);
      err.statusCode = 400;
      throw err;
    }

    // Move funds back from connected account to platform
    acc.balance.available[0].amount -= reverseAmount;
    this.simulated.platformBalance.available[0].amount += reverseAmount;

    transfer.amount_reversed += reverseAmount;
    if (transfer.amount_reversed >= transfer.amount) {
      transfer.reversed = true;
    }

    const reversalId = `trr_${crypto.randomBytes(10).toString('hex')}`;
    this.log(`Reversed transfer ${transferId}: Clawed back $${(reverseAmount / 100).toFixed(2)} USD from ${acc.id} to Platform.`);
    return {
      id: reversalId,
      object: 'transfer_reversal',
      transfer: transferId,
      amount: reverseAmount,
      currency: transfer.currency
    };
  }

  // --- Phase 5 Pattern 1: Destination Charge with Application Fee ---
  async createDestinationCharge({ amount = 5000, applicationFeeAmount = 500, destination, token = 'tok_visa' }) {
    if (this.stripeClient) {
      return await this.stripeClient.charges.create({
        amount,
        currency: 'usd',
        source: token,
        destination: { account: destination },
        application_fee_amount: applicationFeeAmount
      });
    }

    const acc = this.simulated.accounts.get(destination);
    if (!acc) {
      const err = new Error(`Destination account '${destination}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    const netToAccount = amount - applicationFeeAmount;

    // Platform receives the application fee
    this.simulated.platformBalance.available[0].amount += applicationFeeAmount;
    // Connected account receives the net amount
    acc.balance.available[0].amount += netToAccount;

    const chargeId = `ch_dest_${crypto.randomBytes(10).toString('hex')}`;
    this.log(`Destination charge $${(amount / 100).toFixed(2)} processed: Platform fee $${(applicationFeeAmount / 100).toFixed(2)} earned, Net $${(netToAccount / 100).toFixed(2)} paid to ${destination}.`);

    return {
      id: chargeId,
      amount,
      destination,
      application_fee_amount: applicationFeeAmount,
      net_to_destination: netToAccount,
      status: 'succeeded'
    };
  }

  // --- Phase 5: Payout Simulation ---
  async createPayout({ amount = 2500, accountId }) {
    if (this.stripeClient) {
      return await this.stripeClient.payouts.create(
        { amount, currency: 'usd' },
        { stripeAccount: accountId }
      );
    }

    const acc = this.simulated.accounts.get(accountId);
    if (!acc) {
      const err = new Error(`Account '${accountId}' not found.`);
      err.statusCode = 404;
      throw err;
    }

    if (acc.balance.available[0].amount < amount) {
      const err = new Error(`Connected account ${acc.id} has insufficient funds for payout of $${(amount / 100).toFixed(2)}.`);
      err.statusCode = 400;
      throw err;
    }

    acc.balance.available[0].amount -= amount;

    const payoutId = `po_${crypto.randomBytes(10).toString('hex')}`;
    const payout = {
      id: payoutId,
      object: 'payout',
      amount,
      currency: 'usd',
      status: 'paid',
      destination: 'ba_simulated_bank',
      created: Math.floor(Date.now() / 1000)
    };

    this.simulated.payouts.push(payout);
    this.log(`Executed simulated payout of $${(amount / 100).toFixed(2)} from ${acc.id} to bank.`);
    return payout;
  }

  // --- Phase 7: Health Check Monitor Loop ---
  healthCheck() {
    const problems = [];
    const accounts = Array.from(this.simulated.accounts.values());

    for (const acc of accounts) {
      if (!acc.payouts_enabled) {
        problems.push(`${acc.id}: payouts disabled`);
      }
      if (acc.requirements.currently_due && acc.requirements.currently_due.length > 0) {
        problems.push(`${acc.id}: missing ${acc.requirements.currently_due.join(', ')}`);
      }
    }

    const availUsd = this.simulated.platformBalance.available
      .filter(e => e.currency === 'usd')
      .reduce((sum, e) => sum + e.amount, 0);

    if (availUsd < 5000) {
      problems.push(`Low platform balance: $${(availUsd / 100).toFixed(2)} (threshold: $50.00)`);
    }

    return {
      healthy: problems.length === 0,
      timestamp: new Date().toISOString(),
      problems,
      stats: {
        platformAvailableUsd: availUsd / 100,
        connectedAccountsCount: accounts.length
      }
    };
  }
}

module.exports = new StripeService();

const express = require('express');
const stripeService = require('./stripeService');

const router = express.Router();

/**
 * Standard Success Response Envelope Formatter
 */
function sendSuccess(res, data, statusCode = 200, meta = {}) {
  return res.status(statusCode).json({
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  });
}

/**
 * @openapi
 * /api/v1/stripe/balance:
 *   get:
 *     summary: Retrieve platform balance (Phase 2)
 */
router.get('/balance', async (req, res, next) => {
  try {
    const balance = await stripeService.getBalance();
    return sendSuccess(res, balance);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/stripe/seed:
 *   post:
 *     summary: Seed test funds via simulated charge (Phase 3)
 */
router.post('/seed', async (req, res, next) => {
  try {
    const { amount = 10000, currency = 'usd', token = 'tok_visa', autoClear = false } = req.body || {};
    const charge = await stripeService.seedCharge({ amount: Number(amount), currency, token, autoClear });
    const balance = await stripeService.getBalance();
    return sendSuccess(res, { charge, balance }, 201);
  } catch (err) {
    if (err.code === 'card_declined') {
      return res.status(402).json({
        error: { code: 'CARD_DECLINED', message: err.message }
      });
    }
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/stripe/accelerate:
 *   post:
 *     summary: Accelerate pending funds to available (Phase 6)
 */
router.post('/accelerate', (req, res, next) => {
  try {
    const result = stripeService.acceleratePendingFunds();
    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/stripe/accounts:
 *   post:
 *     summary: Create an Express connected account (Phase 4)
 *   get:
 *     summary: List connected accounts
 */
router.post('/accounts', async (req, res, next) => {
  try {
    const { type = 'express', country = 'US', email } = req.body || {};
    const account = await stripeService.createConnectedAccount({ type, country, email });
    return sendSuccess(res, account, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/accounts', (req, res) => {
  const accounts = stripeService.listConnectedAccounts();
  return sendSuccess(res, accounts);
});

router.get('/accounts/:id/balance', async (req, res, next) => {
  try {
    const balance = await stripeService.getConnectedAccountBalance(req.params.id);
    return sendSuccess(res, balance);
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: err.message } });
    }
    next(err);
  }
});

/**
 * @openapi
 * /api/v1/stripe/transfers:
 *   post:
 *     summary: Transfer available platform funds to connected account (Phase 4)
 */
router.post('/transfers', async (req, res, next) => {
  try {
    const { amount, currency = 'usd', destination } = req.body || {};
    if (!amount || !destination) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Amount and destination account are required.' }
      });
    }
    const transfer = await stripeService.createTransfer({ amount: Number(amount), currency, destination });
    const platformBalance = await stripeService.getBalance();
    const accountBalance = await stripeService.getConnectedAccountBalance(destination);
    return sendSuccess(res, { transfer, platformBalance, accountBalance }, 201);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: { code: 'TRANSFER_FAILED', message: err.message }
    });
  }
});

/**
 * @openapi
 * /api/v1/stripe/transfers/reverse:
 *   post:
 *     summary: Reverse a transfer (Clawback) (Phase 5 Pattern 2)
 */
router.post('/transfers/reverse', async (req, res, next) => {
  try {
    const { transferId, amount } = req.body || {};
    if (!transferId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'transferId is required.' }
      });
    }
    const reversal = await stripeService.reverseTransfer({ transferId, amount: amount ? Number(amount) : null });
    const platformBalance = await stripeService.getBalance();
    return sendSuccess(res, { reversal, platformBalance });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: { code: 'REVERSAL_FAILED', message: err.message }
    });
  }
});

/**
 * @openapi
 * /api/v1/stripe/destination-charge:
 *   post:
 *     summary: Destination charge with application fee (Phase 5 Pattern 1)
 */
router.post('/destination-charge', async (req, res, next) => {
  try {
    const { amount = 5000, applicationFeeAmount = 500, destination, token = 'tok_visa' } = req.body || {};
    if (!destination) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'destination account is required.' }
      });
    }
    const result = await stripeService.createDestinationCharge({
      amount: Number(amount),
      applicationFeeAmount: Number(applicationFeeAmount),
      destination,
      token
    });
    const platformBalance = await stripeService.getBalance();
    const accountBalance = await stripeService.getConnectedAccountBalance(destination);
    return sendSuccess(res, { charge: result, platformBalance, accountBalance }, 201);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: { code: 'DESTINATION_CHARGE_FAILED', message: err.message }
    });
  }
});

/**
 * @openapi
 * /api/v1/stripe/payouts:
 *   post:
 *     summary: Connected account payout simulation (Phase 5)
 */
router.post('/payouts', async (req, res, next) => {
  try {
    const { amount = 2500, accountId } = req.body || {};
    if (!accountId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'accountId is required.' }
      });
    }
    const payout = await stripeService.createPayout({ amount: Number(amount), accountId });
    const accountBalance = await stripeService.getConnectedAccountBalance(accountId);
    return sendSuccess(res, { payout, accountBalance }, 201);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({
      error: { code: 'PAYOUT_FAILED', message: err.message }
    });
  }
});

/**
 * @openapi
 * /api/v1/stripe/health-check:
 *   get:
 *     summary: Automated health-check loop (Phase 7)
 */
router.get('/health-check', (req, res) => {
  const result = stripeService.healthCheck();
  return sendSuccess(res, result);
});

/**
 * @openapi
 * /api/v1/stripe/reset:
 *   post:
 *     summary: Reset simulation to Phase 2 baseline
 */
router.post('/reset', (req, res) => {
  stripeService.resetSimulation();
  return sendSuccess(res, { message: 'Stripe simulation reset to baseline.' });
});

/**
 * @openapi
 * /api/v1/stripe/logs:
 *   get:
 *     summary: Audit logs for simulation money movement
 */
router.get('/logs', (req, res) => {
  return sendSuccess(res, stripeService.simulated.logs);
});

module.exports = router;

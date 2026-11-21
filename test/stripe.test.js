const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../server');

function request(server, { method, path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      ...headers,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: reqHeaders
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => { rawData += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            if (rawData) json = JSON.parse(rawData);
          } catch {}
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: json,
            text: rawData
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Stripe Balance & Connect Fund Flows Walkthrough (Phases 1-8)', async (t) => {
  let server;
  let connectedAccountId;
  let createdTransferId;

  t.before(() => {
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  t.after(() => {
    return new Promise((resolve) => {
      server.close(resolve);
    });
  });

  await t.test('Phase 2 — Verify baseline balance (usually $0 in fresh test account)', async () => {
    const res = await request(server, { method: 'GET', path: '/api/v1/stripe/balance' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.livemode, false);
    assert.equal(res.body.data.available[0].amount, 0);
    assert.equal(res.body.data.pending[0].amount, 0);
  });

  await t.test('Phase 3 — Seed test funds ($100 charge via tok_visa)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/seed',
      body: { amount: 10000, token: 'tok_visa' }
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.charge.status, 'succeeded');
    assert.equal(res.body.data.charge.amount, 10000);
    // Pending now has $100.00
    assert.equal(res.body.data.balance.pending[0].amount, 10000);
  });

  await t.test('Phase 3 — Test card declined behavior (tok_chargeDeclined -> 402)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/seed',
      body: { amount: 5000, token: 'tok_chargeDeclined' }
    });
    assert.equal(res.statusCode, 402);
    assert.equal(res.body.error.code, 'CARD_DECLINED');
  });

  await t.test('Phase 6 — Accelerate test time (flip pending to available)', async () => {
    const res = await request(server, { method: 'POST', path: '/api/v1/stripe/accelerate' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.moved, 10000);
    assert.equal(res.body.data.balance.available[0].amount, 10000);
    assert.equal(res.body.data.balance.pending[0].amount, 0);
  });

  await t.test('Phase 4 — Create a connected account (Express)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/accounts',
      body: { type: 'express' }
    });
    assert.equal(res.statusCode, 201);
    assert.ok(res.body.data.id.startsWith('acct_'));
    connectedAccountId = res.body.data.id;
  });

  await t.test('Phase 4 — Move $40 of platform available balance to connected account', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/transfers',
      body: {
        amount: 4000,
        destination: connectedAccountId
      }
    });
    assert.equal(res.statusCode, 201);
    assert.ok(res.body.data.transfer.id.startsWith('tr_'));
    createdTransferId = res.body.data.transfer.id;

    // Platform dropped by $40 ($100 - $40 = $60)
    assert.equal(res.body.data.platformBalance.available[0].amount, 6000);
    // Connected account now holds $40
    assert.equal(res.body.data.accountBalance.available[0].amount, 4000);
  });

  await t.test('Phase 5 Pattern 1 — Destination charge with platform fee ($50 charge: $5 fee to platform, $45 to seller)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/destination-charge',
      body: {
        amount: 5000,
        applicationFeeAmount: 500,
        destination: connectedAccountId
      }
    });
    assert.equal(res.statusCode, 201);
    // Platform received $5 ($60 + $5 = $65)
    assert.equal(res.body.data.platformBalance.available[0].amount, 6500);
    // Connected account received $45 ($40 + $45 = $85)
    assert.equal(res.body.data.accountBalance.available[0].amount, 8500);
  });

  await t.test('Phase 5 Pattern 2 — Reverse a transfer (clawback $10 back to platform)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/transfers/reverse',
      body: {
        transferId: createdTransferId,
        amount: 1000
      }
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.data.reversal.id.startsWith('trr_'));
    // Platform balance gained $10 ($65 + $10 = $75)
    assert.equal(res.body.data.platformBalance.available[0].amount, 7500);
  });

  await t.test('Phase 5 — Payout simulation ($25 payout from connected account)', async () => {
    const res = await request(server, {
      method: 'POST',
      path: '/api/v1/stripe/payouts',
      body: {
        amount: 2500,
        accountId: connectedAccountId
      }
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.payout.status, 'paid');
    // Connected account was $75 ($85 - $10 clawback), now $75 - $25 = $50
    assert.equal(res.body.data.accountBalance.available[0].amount, 5000);
  });

  await t.test('Phase 7 — Health-check loop (automated checks)', async () => {
    const res = await request(server, { method: 'GET', path: '/api/v1/stripe/health-check' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.healthy, true);
    assert.equal(res.body.data.problems.length, 0);
    assert.equal(res.body.data.stats.connectedAccountsCount, 1);
  });
});

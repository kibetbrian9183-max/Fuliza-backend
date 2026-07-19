/***********************************************
 * Fuliza Boost — M-Pesa Daraja STK Push Server
 ***********************************************/
 * Handles:
 *   1. OAuth token generation (cached until it expires)
 *   2. POST /api/mpesa/stkpush        -> triggers the STK push prompt on the student's phone
 *   3. POST /api/mpesa/callback       -> Safaricom calls this URL with the payment result
 *   4. GET  /api/mpesa/status/:id     -> frontend polls this to find out if payment succeeded
 *
 * Run:
 *   cp .env.example .env   (then fill in your real Daraja credentials)
 *   npm install
 *   npm start
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const {
  MPESA_ENV,
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_CALLBACK_URL,
  PORT,
  ALLOWED_ORIGIN
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

const app = express();
app.use(express.json());
app.use(cors({
  origin: ALLOWED_ORIGIN ? ALLOWED_ORIGIN.split(',').map(s => s.trim()) : '*'
}));

// In-memory store of STK push requests, keyed by CheckoutRequestID.
// Swap this for a real database in production (Postgres, MongoDB, etc.)
const transactions = new Map();

/* ------------------------------------------------------------------ */
/* 1. OAuth token (cached)                                             */
/* ------------------------------------------------------------------ */
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET) {
    throw new Error('Missing MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET in .env');
  }

  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });

  cachedToken = res.data.access_token;
  // Daraja tokens last 3600s; refresh a little early to be safe.
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return cachedToken;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function timestampNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Accepts 07XXXXXXXX / 01XXXXXXXX / 2547XXXXXXXX and normalises to 2547XXXXXXXX
function normalisePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) {
    if (digits.length === 9) return '254' + digits;
  }
  return null; // invalid
}

/* ------------------------------------------------------------------ */
/* 2. Trigger STK push                                                 */
/* ------------------------------------------------------------------ */
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, accountReference, transactionDesc } = req.body;

    const msisdn = normalisePhone(phone);
    if (!msisdn) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712345678.' });
    }
    const amt = Math.round(Number(amount));
    if (!amt || amt < 1) {return res.status(400).json({ error: 'Invalid upgrade fee amount.' });
    }
    if (!MPESA_SHORTCODE || !MPESA_PASSKEY) {
      return res.status(500).json({ error: 'Server is missing M-Pesa shortcode/passkey configuration.' });
    }

    const token = await getAccessToken();
    const timestamp = timestampNow();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amt,
      PartyA: msisdn,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: MPESA_CALLBACK_URL,
      AccountReference: (accountReference || 'FulizaBoost').slice(0, 12),
      TransactionDesc: (transactionDesc || 'Fuliza Upgrade').slice(0, 13)
    };

    const stkRes = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription } = stkRes.data;

    if (ResponseCode !== '0') {
      return res.status(400).json({ error: ResponseDescription || 'STK push was not accepted.' });
    }

    transactions.set(CheckoutRequestID, {
      status: 'pending',
      merchantRequestId: MerchantRequestID,
      phone: msisdn,
      amount: amt,
      createdAt: Date.now()
    });

    res.json({ checkoutRequestId: CheckoutRequestID, merchantRequestId: MerchantRequestID });
  } catch (err) {
    console.error('STK push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not reach M-Pesa. Please try again.' });
  }
});

/* ------------------------------------------------------------------ */
/* 3. Safaricom calls this with the result                             */
/* ------------------------------------------------------------------ */
app.post('/api/mpesa/callback', (req, res) => {
  try {
    const body = req.body?.Body?.stkCallback;
    if (!body) return res.status(400).json({ error: 'Malformed callback' });

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;
    const existing = transactions.get(CheckoutRequestID) || {};

    if (ResultCode === 0) {
      const items = CallbackMetadata?.Item || [];
      const get = name => items.find(i => i.Name === name)?.Value;
      transactions.set(CheckoutRequestID, {
        ...existing,
        status: 'success',
        amountPaid: get('Amount'),
        mpesaReceipt: get('MpesaReceiptNumber'),
        payerPhone: get('PhoneNumber'),
        completedAt: Date.now()
      });
    } else {
      transactions.set(CheckoutRequestID, {
        ...existing,
        status: 'failed',
        resultDesc: ResultDesc,
        completedAt: Date.now()
      });
    }

    // Safaricom just needs a 200 acknowledging receipt.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback handling error:', err.message);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

/* ------------------------------------------------------------------ */
/* 4. Frontend polls this to know when the push has been answered      */
/* ------------------------------------------------------------------ */
app.get('/api/mpesa/status/:checkoutRequestId', (req, res) => {
  const tx = transactions.get(req.params.checkoutRequestId);
  if (!tx) return res.status(404).json({ status: 'unknown' });
  res.json(tx);
});

app.get('/health', (req, res) => res.json({ ok: true, env: MPESA_ENV }));

const port = PORT || 4000;
app.listen(port, () => {
  console.log(`Fuliza Boost M-Pesa server running on port ${port} (${MPESA_ENV || 'sandbox'} mode)`);

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OpenAI client
const OpenAI = require('openai').default;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));

// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter for SMS endpoint (adjust as needed)
const smsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many requests. Please try again later.'
});

// Helpers
function formatPhone(phone) {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) return `+61${cleaned.slice(1)}`;
  if (cleaned.startsWith('61')) return `+${cleaned}`;
  if (phone.startsWith('+')) return phone;
  return `+${cleaned}`;
}

function isValidAUSMobile(phone) {
  return /^\+61[0-9]{9}$/.test(phone);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendSmsWithRetry(msg, to, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await client.messages.create({
        body: msg,
        from: process.env.TWILIO_PHONE,
        to: to
      });
      return;
    } catch (err) {
      console.error(`❌ Failed to send SMS (Attempt ${attempt + 1}):`, err.message);
      if (attempt === maxRetries) throw err;
      await delay(2500);
    }
  }
}

// POST /send-sms (just sends SMS, no DB interaction)
app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, phone, signupTime } = req.body;

  const timeTaken = Date.now() - Number(signupTime || 0);
  if (timeTaken < 1000) return res.status(400).send('Bot-like behavior');

  if (!phone) return res.status(400).send('Phone number required');

  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) return res.status(400).send('Invalid Australian mobile number');

  const smsMessages = [ 
    `Hey ${name || 'legend'}, you’re officially on the TradeAssist waitlist — no more missed jobs, even when you’re neckin' an Up & Go on the run!`,
    `Now rip the lid off that brekkie juice, ${name || 'mate'} 💪 — we’ll handle the calls while you handle the smoko.`,
  ];

  try {
    for (const msg of smsMessages) {
      await sendSmsWithRetry(msg, formattedPhone);
      await delay(1500);
    }
    res.redirect('/success');
  } catch (err) {
    console.error('❌ Error sending SMS:', err.message);
    res.status(500).send('Failed to send SMS');
  }
});

// GET /success
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// POST /sms - Twilio webhook
app.post('/sms', async (req, res) => {
  const incomingMsg = req.body.Body.trim().toLowerCase();
  const from = req.body.From;

  console.log(`📩 Incoming SMS from ${from}: ${incomingMsg}`);

  const tradeFlavours = {
    sparky: 'Chocolate',
    electrician: 'Chocolate',
    plumber: 'Strawberry',
    carpenter: 'Honeycomb',
    builder: 'Chocolate',
    painter: 'Strawberry'
  };

  let reply;
  if (tradeFlavours[incomingMsg]) {
    reply = `Based on being a ${incomingMsg}, I’m guessing your favourite Up & Go flavour is ${tradeFlavours[incomingMsg]} 🥤. Did I nail it?`;
  } else {
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a fun AI that guesses someone’s favourite Up & Go flavour based on their trade.' },
          { role: 'user', content: `Their trade is: ${incomingMsg}` }
        ]
      });
      reply = completion.data.choices[0].message.content;
    } catch (err) {
      console.error('❌ OpenAI error:', err.message);
      reply = "Sorry, I'm having trouble responding right now. Try again shortly.";
    }
  }

  const MessagingResponse = twilio.twiml.MessagingResponse;
  const twiml = new MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// Start server
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`✅ Server running at http://${host}:${port}`);
});

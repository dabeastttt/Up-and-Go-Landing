require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const { Configuration, OpenAIApi } = require('openai');

const app = express();
const port = process.env.PORT || 3001;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OpenAI
const openai = new OpenAIApi(
  new Configuration({ apiKey: process.env.OPENAI_API_KEY })
);

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use('/sms', bodyParser.urlencoded({ extended: false })); // Ensure Twilio webhook is parsed
app.use(express.static('public'));

// Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Rate limiter
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

// POST /send-sms
app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, business, email, phone, signupTime } = req.body;

  const timeTaken = Date.now() - Number(signupTime || 0);
  if (timeTaken < 1000) return res.status(400).send('Bot-like behavior');

  if (!phone) return res.status(400).send('Phone number required');

  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) return res.status(400).send('Invalid Australian mobile number');

  const displayName = name?.trim() || 'legend';
  const businessName = business?.trim() || 'your tradie';

const smsMessages = [ 
  `Hey ${name || 'legend'}, you’re officially on the TradeAssist waitlist — no more missed jobs, even when you’re neckin' an Up & Go on the run!`,
  `Now rip the lid off that brekkie juice, ${name || 'mate'} 💪 — we’ll handle the calls while you handle the smoko.`,
];


  try {
    const { error } = await supabase.from('signups').insert([
      { name, business, email, phone: formattedPhone }
    ]);
    if (error) {
      console.error('❌ Supabase insert error:', error.message);
      return res.status(500).send('Database error');
    }

    for (const msg of smsMessages) {
      await sendSmsWithRetry(msg, formattedPhone);
      await delay(1500);
    }

    res.redirect('/success');
  } catch (err) {
    console.error('❌ Error during signup:', err.message);
    res.status(500).send('Failed to onboard user');
  }
});

// GET /signup-count
app.get('/signup-count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('signups')
      .select('*', { count: 'exact', head: true });

    if (error) throw error;

    res.json({ count: count || 0 });
  } catch (error) {
    console.error('Error fetching signup count:', error.message);
    res.status(500).json({ error: 'Failed to get signup count' });
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

  // Simple rule-based flavour guess
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
    // Fall back to AI if trade not in our list
    try {
      const completion = await openai.createChatCompletion({
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

  // Send reply to Twilio
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

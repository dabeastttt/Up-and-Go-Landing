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

app.set('trust proxy', 1);


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

app.post('/send-sms', smsLimiter, async (req, res) => {
  const { name, phone, signupTime } = req.body;

  console.log('Received send-sms request:', { name, phone, signupTime });

  // const timeTaken = Date.now() - Number(signupTime || 0);
  // if (timeTaken < -10000) {
  //   console.log('SignupTime is suspiciously in the future');
  //   return res.status(400).send('Invalid signupTime');
  // }
  // if (timeTaken < 1000) {
  //   console.log('Rejected due to bot-like behavior');
  //   return res.status(400).send('Bot-like behavior');
  // }

  if (!phone) {
    console.log('Rejected: phone number missing');
    return res.status(400).send('Phone number required');
  }

  const formattedPhone = formatPhone(phone);
  if (!isValidAUSMobile(formattedPhone)) {
    console.log('Rejected: invalid Australian mobile number', formattedPhone);
    return res.status(400).send('Invalid Australian mobile number');
  }

  const smsMessages = [ 
    `Hey ${name || 'legend'}, you’re officially on the TradeAssist waitlist — no more missed jobs, even when you’re neckin' an Up & Go on the run!`,
    `Now rip the lid off that brekkie juice, ${name || 'mate'} 💪 — we’ll handle the calls while you handle the smoko.`,
  ];

  try {
    for (const msg of smsMessages) {
      console.log(`Sending SMS to ${formattedPhone}: ${msg}`);
      await sendSmsWithRetry(msg, formattedPhone);
      await delay(1500);
    }
    console.log('SMS sent successfully');
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error sending SMS:', err);
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
  sparky: {
    flavour: 'Chocolate',
    replies: [
      `Hey Sparky! I bet your favourite Up & Go flavour is ${'Chocolate'} 🥤. Am I right?`,
      `Sparky, you must love ${'Chocolate'} Up & Go! How close am I?`,
      `I’m guessing as a Sparky, you pick ${'Chocolate'} every time!`
    ]
  },
  electrician: {
    flavour: 'Chocolate',
    replies: [
      `Being an electrician, I figure you’re a ${'Chocolate'} fan 🥤. True?`,
      `Electrician’s pick is usually ${'Chocolate'}. How’d I do?`,
      `You’re an electrician — so it’s gotta be ${'Chocolate'}, right?`
    ]
  },
  plumber: {
    flavour: 'Strawberry',
    replies: [
      `Plumber’s choice? I say ${'Strawberry'} 🥤. How close am I?`,
      `You must be loving that ${'Strawberry'} Up & Go, plumber!`,
      `I’m betting as a plumber, you go for ${'Strawberry'}.`
    ]
  },
  carpenter: {
    flavour: 'Honeycomb',
    replies: [
      `Carpenter vibes say ${'Honeycomb'} 🥤 is your fave. Correct?`,
      `I think carpenters dig the ${'Honeycomb'} flavour!`,
      `You’re a carpenter? ${'Honeycomb'} it is!`
    ]
  },
  builder: {
    flavour: 'Chocolate',
    replies: [
      `Builder’s top pick: ${'Chocolate'} 🥤. Spot on?`,
      `I’m thinking you like ${'Chocolate'} Up & Go, builder!`,
      `Builder means ${'Chocolate'} all the way, right?`
    ]
  },
  painter: {
    flavour: 'Strawberry',
    replies: [
      `Painter’s palette is ${'Strawberry'} flavour 🥤. True?`,
      `You paint the town red, and drink ${'Strawberry'} Up & Go!`,
      `Painter’s pick: definitely ${'Strawberry'}.`
    ]
  }
};

let reply;
if (tradeFlavours[incomingMsg]) {
  const replies = tradeFlavours[incomingMsg].replies;
  // Pick a random reply
  reply = replies[Math.floor(Math.random() * replies.length)];
} else {
  // Your existing OpenAI fallback
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

});

// Start server
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`✅ Server running at http://${host}:${port}`);
});

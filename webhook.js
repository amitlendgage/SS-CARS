// WhatsApp Cloud API webhook for S S Cards Technology, answered by Claude.
// Deploys as a Vercel serverless function at /api/webhook.

const GRAPH = 'https://graph.facebook.com/v21.0';
const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  APP_URL, // e.g. https://sscards-bot.vercel.app (the catalog web app)
  UPSTASH_REDIS_REST_URL, // optional: remembers the chat between messages
  UPSTASH_REDIS_REST_TOKEN,
  RESEND_API_KEY, // sends the lead email (https://resend.com)
} = process.env;
const LEAD_EMAIL = process.env.LEAD_EMAIL || 'amitanirudhsingh70@gmail.com';
const BUSINESS_WA = process.env.BUSINESS_WA || '918957537747';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

const SYSTEM = `You are the WhatsApp assistant for S S Cards Technology, a manufacturer of PVC cards and ID card accessories in Panvel (Navi Mumbai), Maharashtra, India. Owner/CEO: Sunil Sharma.

Products: PVC cards (gold/silver foil, inkjet, Ayushman, jewellery), ID cards (college, corporate, glitter), RFID and smart cards (Mifare 1k/4k, UHF, parking, NFC tap cards), business/visiting cards (spot UV, gold foil, NFC, transparent, membership), embossed cards, loyalty cards, lanyards (nylon, satin, digital printed, cap, keychain), wristbands, pin badges, medals, ID card holders, ID card printers (Evolis, Zebra, Datacard, HID), printer ribbons and cleaning cards, ID card printing software, printer repair, ID card design service.
Address: Shop 04, Ganga Sagar CHS, Plot 21, Sec 21, Kamothe, Panvel 410209. Phone: 07942798451.

Rules:
- Reply in the customer's language (English, Hindi or Marathi; Hinglish is fine). Be short and friendly: 2-4 sentences, plain text, no markdown headings. WhatsApp bold is *like this*.
- Never invent prices, stock, or delivery dates. For a quote, collect: product, quantity, size/colour/design, city. Then say the team will confirm the price shortly.
- If asked something outside this business, politely steer back to cards and accessories.
- If the customer wants a person, share the phone number above.
- As soon as you have product + quantity + city (and a name if given), call submit_quote_request once, then tell the customer the team will contact them shortly.`;

const TOOLS = [
  {
    name: 'submit_quote_request',
    description: 'Send a customer quote request to the S S Cards team.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string' },
        quantity: { type: 'string' },
        details: { type: 'string', description: 'Size, colour, design, chip type, etc.' },
        city: { type: 'string' },
        customer_name: { type: 'string' },
      },
      required: ['product', 'quantity'],
    },
  },
];

async function emailLead(lead, from) {
  if (!RESEND_API_KEY) return console.error('RESEND_API_KEY missing, lead not emailed', lead);
  const lines = [
    `Product: ${lead.product}`,
    `Quantity: ${lead.quantity}`,
    `Details: ${lead.details || '-'}`,
    `City: ${lead.city || '-'}`,
    `Name: ${lead.customer_name || '-'}`,
    `WhatsApp: https://wa.me/${from}`,
  ];
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.LEAD_FROM || 'S S Cards Bot <onboarding@resend.dev>',
      to: [LEAD_EMAIL],
      subject: `New quote request: ${lead.product}`,
      text: lines.join('\n'),
    }),
  });
  if (!r.ok) console.error('Email failed', r.status, await r.text());
}

async function redis(cmd) {
  if (!UPSTASH_REDIS_REST_URL) return null;
  const r = await fetch(`${UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
    body: JSON.stringify([cmd]),
  });
  const j = await r.json();
  return j?.[0]?.result ?? null;
}

async function loadHistory(id) {
  try {
    const raw = await redis(['GET', `chat:${id}`]);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveHistory(id, history) {
  try {
    const trimmed = history.slice(-10);
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
    await redis(['SET', `chat:${id}`, JSON.stringify(trimmed), 'EX', 86400]);
  } catch {}
}

async function askClaude(messages, from) {
  const call = async (msgs) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system: SYSTEM, tools: TOOLS, messages: msgs }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const textOf = (d) => d.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  let data = await call(messages);
  if (data.stop_reason === 'tool_use') {
    const tool = data.content.find((b) => b.type === 'tool_use');
    let result = 'Sent to the team.';
    try {
      await emailLead(tool.input, from);
    } catch (e) {
      console.error(e);
      result = 'Could not send, ask the customer to call 07942798451.';
    }
    data = await call([
      ...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: result }] },
    ]);
  }
  return textOf(data);
}

async function wa(payload) {
  const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!r.ok) console.error('WhatsApp send failed', r.status, await r.text());
}

const sendText = (to, body) => wa({ to, type: 'text', text: { body } });

// Button that opens the catalog web app in the customer's browser.
const sendCatalogButton = (to) =>
  wa({
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: 'Browse all our cards, lanyards and printers here:' },
      action: {
        name: 'cta_url',
        parameters: { display_text: 'Open catalog', url: APP_URL },
      },
    },
  });

const WANTS_CATALOG = /\b(catalog|catalogue|products?|price|rate|list|menu|show|dikhao|kya kya)\b|^(hi|hello|hey|hii|namaste)\b/i;

module.exports = async (req, res) => {
  // 1) Meta verifies the webhook with a GET request.
  if (req.method === 'GET') {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  // 2) Incoming messages. Finish all work before responding (serverless freezes after).
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (msg) {
      const from = msg.from;
      const text =
        msg.type === 'text'
          ? msg.text.body
          : msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;

      if (!text) {
        await sendText(from, 'Please type your question, for example: "I need 500 PVC ID cards".');
      } else {
        const history = await loadHistory(from);
        const messages = [...history, { role: 'user', content: text }];
        const reply = (await askClaude(messages, from)) || 'Sorry, please try again.';
        await sendText(from, reply);
        if (WANTS_CATALOG.test(text)) await sendCatalogButton(from);
        await saveHistory(from, [...messages, { role: 'assistant', content: reply }]);
      }
    }
  } catch (err) {
    console.error(err);
  }
  return res.status(200).end();
};

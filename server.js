/**
 * Arimare Metaphysics — Secure API Backend
 * Proxies all Anthropic calls server-side so the API key is never exposed
 * to the browser or mobile app bundle.
 */
import dotenv from 'dotenv';
// Load .env first (shared defaults), then .env.local (secrets, gitignored)
dotenv.config();
dotenv.config({ path: '.env.local', override: true });
import express from 'express';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';

// ─── Validate environment ────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY is not set. Create backend/.env.local');
  process.exit(1);
}

const PORT   = process.env.PORT || 5000;
const HOST   = '0.0.0.0';   // Always bind IPv4 — Railway healthcheck requires this
// Latest Claude Sonnet — best speed/intelligence balance for production
// Docs: https://docs.anthropic.com/en/docs/about-claude/models/overview
const MODEL  = 'claude-sonnet-4-6';

// ─── App setup ───────────────────────────────────────────────────────────────
const app    = express();
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

app.use(express.json({ limit: '2mb' }));

// CORS — allow both local web dev and Expo (any origin in dev, tighten in prod)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 min
  max: 60,                      // 60 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again in 15 minutes.' },
});
app.use('/api', limiter);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', model: MODEL }));

// ─── POST /api/chat ───────────────────────────────────────────────────────────
// Body: { history: [{role,content}]?, userMessage: string, systemPrompt: string }
// history = array of previous {role:'user'|'assistant', content:string} turns
app.post('/api/chat', async (req, res) => {
  const { history = [], userMessage, systemPrompt } = req.body;
  if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });

  // Cap history to last 20 turns to avoid token overflow
  const cappedHistory = Array.isArray(history) ? history.slice(-20) : [];

  // Build messages array: previous turns + new user message
  const messages = [
    ...cappedHistory.map(turn => ({
      role:    turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.content),
    })),
    { role: 'user', content: String(userMessage) },
  ];

  try {
    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     systemPrompt || 'คุณคือ อริมา ผู้เชี่ยวชาญด้านอภิปรัชญาไทย',
      messages,
    });

    const text = response.content[0]?.type === 'text'
      ? response.content[0].text
      : 'เกิดข้อผิดพลาด กรุณาลองใหม่';

    res.json({ text });
  } catch (err) {
    console.error('[/api/chat]', err.message);
    res.status(500).json({ error: 'AI service error', details: err.message });
  }
});

// ─── POST /api/generate ───────────────────────────────────────────────────────
// Body: { prompt: string, toolName: string, inputSchema: object, maxTokens?: number }
// Returns: { toolInput: object } — the raw tool_use input from Claude
app.post('/api/generate', async (req, res) => {
  const { prompt, toolName, inputSchema, maxTokens } = req.body;
  if (!prompt || !toolName || !inputSchema)
    return res.status(400).json({ error: 'prompt, toolName, inputSchema are required' });

  try {
    const tool = {
      name:         toolName,
      description:  `Submit the generated result as a JSON object matching the schema.`,
      input_schema: inputSchema,
    };

    const response = await client.messages.create({
      model:       MODEL,
      max_tokens:  maxTokens || 8000,
      tools:       [tool],
      tool_choice: { type: 'tool', name: toolName },
      messages:    [{ role: 'user', content: prompt }],
    });

    const toolBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolBlock) return res.status(500).json({ error: 'Model did not return tool_use block' });

    res.json({ toolInput: toolBlock.input });
  } catch (err) {
    console.error('[/api/generate]', err.message);
    res.status(500).json({ error: 'AI service error', details: err.message });
  }
});

// ─── POST /api/webhook/revenuecat ─────────────────────────────────────────────
// RevenueCat sends events here when purchase is confirmed by Apple / Google
// Dashboard: RevenueCat → Project → Integrations → Webhooks → add this URL
// Docs: https://www.revenuecat.com/docs/webhooks
app.post('/api/webhook/revenuecat', (req, res) => {
  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: 'Missing event' });

  const { type, app_user_id, product_id } = event;
  console.log(`[RevenueCat] ${type} | user=${app_user_id} | product=${product_id}`);

  // Credit amounts per product ID
  const CREDIT_MAP = {
    arimare_credit_1:  1,
    arimare_credit_5:  5,
    arimare_credit_15: 15,
  };

  if (type === 'INITIAL_PURCHASE' || type === 'NON_SUBSCRIPTION_PURCHASE') {
    const credits = CREDIT_MAP[product_id];
    if (!credits) {
      console.warn(`[RevenueCat] Unknown product: ${product_id}`);
      return res.json({ received: true });
    }
    // Credits are stored client-side (SecureStore) — webhook is for logging/analytics
    // If you add server-side user accounts later, unlock credits here
    console.log(`[RevenueCat] ✅ ${credits} credit(s) purchased by user ${app_user_id}`);
  }

  res.json({ received: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`✅  Arimare backend running → http://${HOST}:${PORT}`);
  console.log(`    Model: ${MODEL}`);
});

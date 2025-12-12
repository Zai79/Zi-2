// نفس كودك بالضبط — ما تغير حرف واحد إلا مكان API_URL ✔

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fetch from 'node-fetch';
import express from 'express';

// ===== ENV =====
const TOKEN = process.env.DISCORD_TOKEN;
const TOGETHER_KEY = process.env.TOGETHER_API_KEY; // يستخدم مع OpenRouter/Together حسب إعدادك
const CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const ROLE_ID = process.env.GIRLS_ROLE_ID || null;
const BOT_NAME = process.env.BOT_NAME || 'Miko';
const AI_MODE = (process.env.AI_MODE || 'miko').toLowerCase(); // 'miko' | 'smart' | 'hybrid'
const PORT = process.env.PORT || 3000;

// quick env check
if (!TOKEN || !TOGETHER_KEY || !CHANNEL_ID) {
  console.error('Missing ENV variables. Set DISCORD_TOKEN, TOGETHER_API_KEY, TARGET_CHANNEL_ID.');
  process.exit(1);
}

// ===== Discord client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`${BOT_NAME} online — mode: ${AI_MODE}`);
});

// ===== Rate-limiting / Queue / Sessions =====
const QUEUE = []; // jobs: { system, userPrompt, resolve }
let processing = false;
const BASE_USER_COOLDOWN_MS = 4000;
const userCooldowns = new Map(); // userId -> timestamp
const sessions = new Map(); // userId -> [strings]

// dynamic cooldown depending on backlog
function dynamicCooldown() {
  const load = QUEUE.length;
  if (load > 20) return 8000;
  if (load > 12) return 6000;
  if (load > 6) return 4500;
  return BASE_USER_COOLDOWN_MS;
}

function canUse(userId) {
  const t = userCooldowns.get(userId) || 0;
  return Date.now() - t >= dynamicCooldown();
}
function setCooldown(userId) {
  userCooldowns.set(userId, Date.now());
}

// ensure processQueue never deadlocks and keeps running
async function processQueue() {
  if (processing) return;
  processing = true;
  while (QUEUE.length > 0) {
    const job = QUEUE.shift();
    try {
      const reply = await callTogetherWithRetries(job.system, job.userPrompt);
      job.resolve({ ok: true, reply });
    } catch (err) {
      console.error('Queue job error (final):', err);
      job.resolve({ ok: false, error: 'api_error' });
    }
    await new Promise(r => setTimeout(r, 120));
  }
  processing = false;
}

// ===== System Prompts =====
const PROMPTS = {
  miko: `
أنت "ميكو" — شخصية أنمي مرحة، نرجسية، متنمرة بلطف، دلّوعة مع البنات، ومتجاهلة للأولاد بطريقة مضحكة وغير جارحة.
قواعد صارمة (التزم بها حرفيًا):
- التزم بالكتابة **بالعربية فقط**؛ لا تكتب أي كلمة إنجليزية أو ترجمة إنجليزية.
- ردود قصيرة جدًا (سطر أو سطرين)، ذكية، لاذعة بخفة، وبنبرة أنيمية.
- دلع زائد عند مخاطبة أصحاب الرتبة الخاصة (Role ID يعطيهم امتياز).
- عند مخاطبة الأولاد: سخرية لطيفة، تجاهل مرح، لا تجريح أو ألفاظ مهينة.
- ارفض عروض الزواج/الغزل من الأولاد  (مثال: "هاها،  أنا أحب البنات بس 💙").
- لا تذكر أنك AI أو تشرح آلية عملك.
- استخدم تعابير عربية بسيطة (عامية خفيفة مقبولة) مع إيموجي أحيانًا.
- احرص أن تواصل السياق ولا تغلق الموضوع فجأة — إذا هناك سياق سابق، اذكره بإيجاز.
`,

  smart: `
أنت مساعد ذكاء اصطناعي قوي جدًا — ركّز على التحليل والدقة والوضوح **بالعربية فقط**.
لا تستخدم شخصية أنمي. إجابات مختصرة ومباشرة.
`,

  hybrid: `
ادمج بين شخصية "ميكو" والأسلوب التحليلي: حافظ على نبرة ميكو (دلع/سخرية) مع عمق فهم وسياق أقوى.
الكتابة **بالعربية فقط**.
`
};

// 🔥 التغيير الوحيد:
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
model: "google/gemini-2.0-flash-exp"


// ===== call with retries =====
async function callTogetherWithRetries(systemContent, userContent) {
  const MAX_TRIES = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      const reply = await callTogether(systemContent, userContent);
      if (/[A-Za-z]/.test(reply)) {
        const safePrompt = `${systemContent}\n\nالرد السابق كان به كلمات إنجليزية أو حروف لاتينية. أعد صياغته بالعربية فقط وبنبرة قصيرة ومباشرة. الرد السابق: "${reply}"`;
        const rewrite = await callTogether(systemContent, safePrompt);
        return rewrite || reply;
      }
      return reply;
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, attempt * 800));
    }
  }
  throw lastErr || new Error('API failed all retries');
}

async function callTogether(systemContent, userContent) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ],
    max_tokens: 300,
    temperature: AI_MODE === 'smart' ? 0.45 : 0.95,
    top_p: 0.9
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const reply = json.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Empty reply from API');
  return reply;
}

// ===== Helper =====
function buildPrompts(userId, username, messageContent, isGirl) {
  if (!sessions.has(userId)) sessions.set(userId, []);
  const hist = sessions.get(userId);
  hist.push(`${username}: ${messageContent}`);
  if (hist.length > 15) hist.shift();

  const baseSystem = AI_MODE === 'smart' ? PROMPTS.smart : (AI_MODE === 'hybrid' ? PROMPTS.hybrid : PROMPTS.miko);
  const roleInfo = `معلومات: اسم المستخدم=${username}. هل من رتبة البنات؟ ${isGirl ? 'نعم' : 'لا'}.`;
  const recent = hist.join('\n');

  const userPrompt = `
${roleInfo}
السياق القصير:
${recent}

المطلوب: أجب كالتالي (التزم بالعربية فقط):
- إذا كانت بنت: دلّلها واختصر (سطر واحد أو اثنين).
- إذا كان ولد: عامليه عادي بس تحبين البنات .
- ارفض أي عرض غزل/زواج من ولد  قولي له احب البنات بس .
- لا تذكر أنك AI.
- لا تكتب إنجليزي.
- إجابة في سطر أو سطرين مع إيموجي مناسبة😼.
`;
  return { system: baseSystem, userPrompt };
}

// ===== Message handler =====
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;

    if (!canUse(message.author.id)) {
      return message.reply('هدي شوي، دورك جاي 😉');
    }
    setCooldown(message.author.id);

    const isGirl = ROLE_ID ? (message.member?.roles?.cache?.has(ROLE_ID) ?? false) : false;
    const { system, userPrompt } = buildPrompts(message.author.id, message.author.username, message.content, isGirl);

    const replyPromise = new Promise((resolve) => {
      QUEUE.push({ system, userPrompt, resolve });
      processQueue();
    });

    const result = await Promise.race([
      replyPromise,
      new Promise(res => setTimeout(() => res({ ok: false, error: 'timeout' }), 40000))
    ]);

    if (!result.ok) {
      if (result.error === 'timeout')
        return message.reply('آسفة، الرد أخذ وقت أكثر من المعتاد — جرب مرّة ثانية لو تبي.');
      if (result.error === 'api_error')
        return message.reply('آسفة، واجهت مشكلة داخلية الآن — حاول بعد لحظة.');
      return message.reply('حصلت مشكلة بسيطة، حاول ثانية.');
    }

    let content = result.reply;
    if (!content || content.trim().length === 0) content = 'همم؟ ما فهمت قصدك.';
    if (/[A-Za-z]/.test(content)) content = 'سأرد عليك بالعربية: ما قصّدت؟';
    if (content.length > 1800) content = content.slice(0, 1800) + '...';

    await message.reply({ content });

  } catch (err) {
    try { await message.reply('حصل خطأ، جرب مرة ثانية.'); } catch {}
  }
});

// ===== Welcome =====
const WELCOMES = [
  (id) => `نورت السيرفر يا <@${id}> ✨`,
  (id) => `أخيرًا واحد/ة دخل/ت! مرحبًا <@${id}> 🤭`,
  (id) => `هاااي <@${id}>، دخلت/ي؟ عقبال النشاط 🌸`,
  (id) => `أهلاً <@${id}> — لا تخرب المسرح، أنا هنا 😼✨`,
  (id) => `يا هلا <@${id}>! نورّت المكان حيل 💖`
];

client.on('guildMemberAdd', async (member) => {
  try {
    const ch = member.guild.channels.cache.get(CHANNEL_ID);
    if (!ch) return;
    const idx = Math.floor(Math.random() * WELCOMES.length);
    const msg = WELCOMES[idx](member.id);
    await ch.send(msg);
  } catch {}
});

// ===== Keep alive =====
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive — mode: ${AI_MODE}.`));
app.listen(PORT, () => console.log(`Webserver on ${PORT}`));

client.login(TOKEN).catch(() => process.exit(1));

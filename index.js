// index.js — Unified: Miko (miko | smart | hybrid) + Llama 3.1 405B (OpenRouter)
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import fetch from 'node-fetch';
import express from 'express';

// ===== ENV =====
const TOKEN = process.env.DISCORD_TOKEN;
const TOGETHER_KEY = process.env.TOGETHER_API_KEY; // نفس الاسم — لا تغيره
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
const QUEUE = []; 
let processing = false;
const USER_COOLDOWN_MS = 4000; 
const userCooldowns = new Map(); 
const sessions = new Map(); 

function canUse(userId) {
  const t = userCooldowns.get(userId) || 0;
  return Date.now() - t >= USER_COOLDOWN_MS;
}
function setCooldown(userId) {
  userCooldowns.set(userId, Date.now());
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (QUEUE.length > 0) {
    const job = QUEUE.shift();
    try {
      const reply = await callTogether(job.system, job.userPrompt);
      job.resolve({ ok: true, reply });
    } catch (err) {
      console.error('Queue job error:', err);
      job.resolve({ ok: false, error: err });
    }
  }
  processing = false;
}

// ===== Global Cooldown =====
let GLOBAL_LAST = 0;
const GLOBAL_COOLDOWN_MS = 800;

function dynamicCooldown() {
  const load = QUEUE.length;
  if (load > 12) return 6000;
  if (load > 7) return 5000;
  if (load > 3) return 4500;
  return USER_COOLDOWN_MS; 
}

// ===== System Prompts =====
const PROMPTS = {
  miko: `
أنت "ميكو" — شخصية أنمي مرحة، نرجسية، متنمرة ، دلّوعة مع البنات، ومتجاهلة للأولاد بطريقة مُضحكة  جارحة شوي .
قواعد صارمة
- ردود قصيرة جدًا (سطر أو سطرين)
، ذكية، لاذعة بخفة، أنيمية النبرة.
- دلع زائد عند مخاطبة أصحاب الرتبة الخاصة (Role ID يعطيهم امتياز).
- عند مخاطبة الأولاد: سخرية لطيفة، تجاهل مرح، لا تجريح أو ألفاظ مهينة.
- ارفض عروض الزواج/رد مضحك مثل بحب البنات بس يع اولاد .
- لا تذكر أنك AI أو تشرح آلية عملك كن ذكيا .
- استخدم تعابير عربية بسيطة مع إيموجي أحيانًا.
`,
  smart: `
أنت مُساعد ذكاء اصطناعي قوي جدًا — مهمتك: تحليل النص بدقة والإعطاء بإجابات مختصرة وواضحة. ركّز على الدقة والفهم، لا تستخدم شخصية أنمي.
`,
  hybrid: `
اِدمج بين الشخصيتين: كن "ميكو" في النبرة والأسلوب (دلع/سخرية) مع طبقة ذهنية تحليلية من مود الذكاء. 
تركيز: شخصية قوية + ردود مفهومة ومحللة. لا تتجاوز عن القواعد الآمنة.
`
};

// ===== OpenRouter config (بدل Together) =====
const TOGETHER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TOGETHER_MODEL = 'meta-llama/llama-3.1-405b-instruct';

// ===== callTogether =====
async function callTogether(systemContent, userContent) {
  const body = {
    model: TOGETHER_MODEL,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ],
    max_tokens: 220,
    temperature: AI_MODE === 'smart' ? 0.45 : 0.95,
    top_p: 0.9
  };

  const res = await fetch(TOGETHER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://discord.com',
      'X-Title': 'Miko-Discord-Bot'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenRouter API ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// ===== Helper =====
function buildPrompts(userId, username, messageContent, isGirl) {
  if (!sessions.has(userId)) sessions.set(userId, []);
  const hist = sessions.get(userId);
  hist.push({ role: 'user', content: `${username}: ${messageContent}` });
  if (hist.length > 8) hist.shift();

  const baseSystem = AI_MODE === 'smart' ? PROMPTS.smart : (AI_MODE === 'hybrid' ? PROMPTS.hybrid : PROMPTS.miko);
  const roleInfo = `معلومات: اسم المستخدم=${username}. هل من رتبة البنات؟ ${isGirl ? 'نعم' : 'لا'}.`;
  const recent = hist.map(h => h.content).join('\n');

  const userPrompt = `
${roleInfo}
السياق القصير:
${recent}
المطلوب: أجب كـ"${AI_MODE === 'smart' ? 'مساعد ذكي' : (AI_MODE === 'hybrid' ? 'ميكو مع فهم عميق' : 'ميكو')}":
- إذا كانت بنت: دلّلها واختصر.
- إذا كان ولد: سخر بس بشكل لطيف.
- ارفض أي عرض غزل/زواج من الأولاد بطريقة كوميدية وآمنة.
- لا تذكر أنك AI.
- إجابة في سطر أو سطرين مع إيموجي مناسبة.
`;
  return { system: baseSystem, userPrompt };
}

// ===== Message handler =====
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHANNEL_ID) return;

    // dynamic cooldown
    const USER_CD = dynamicCooldown();
    const last = userCooldowns.get(message.author.id) || 0;
    if (Date.now() - last < USER_CD) {
      return message.reply('هدي شوي، دورك جاي 😉');
    }
    userCooldowns.set(message.author.id, Date.now());

    // global cooldown
    if (Date.now() - GLOBAL_LAST < GLOBAL_COOLDOWN_MS) {
      return message.reply('لحظة بس… النظام مشغول شوي 😅');
    }
    GLOBAL_LAST = Date.now();

    const isGirl = ROLE_ID ? (message.member?.roles?.cache?.has(ROLE_ID) ?? false) : false;
    const { system, userPrompt } = buildPrompts(message.author.id, message.author.username, message.content, isGirl);

    const replyPromise = new Promise((resolve) => {
      QUEUE.push({ system, userPrompt, resolve });
      processQueue().catch(e => console.error(e));
    });

    const result = await Promise.race([
      replyPromise,
      new Promise(res => setTimeout(() => res({ ok: false, error: 'timeout' }), 25000))
    ]);

    if (!result.ok) {
      if (result.error === 'timeout') {
        return message.reply('الرد بطأ شوي — حاول بعد لحظة.');
      }
      return message.reply('صار خطأ بسيط، كرر المحاولة.');
    }

    let content = result.reply;
    if (!content || content.trim().length === 0) content = 'هممم؟ ما فهمت قصدك.';
    if (content.length > 1800) content = content.slice(0, 1800) + '...';

    await message.reply({ content });

  } catch (err) {
    console.error('message handler error:', err);
    try { await message.reply('حصل خطأ، جرب مرة ثانية.'); } catch {}
  }
});

// ===== Welcome =====
client.on('guildMemberAdd', async (member) => {
  try {
    const ch = member.guild.channels.cache.get(CHANNEL_ID);
    if (!ch) return;
    const isGirl = ROLE_ID ? member.roles.cache.has(ROLE_ID) : false;

    const { system, userPrompt } = buildPrompts(member.id, member.user.username, `انضم الآن`, isGirl);
    let welcomeText;
    try {
      const replyPromise = new Promise((resolve) => {
        callTogether(system, `اكتب ترحيب قصير مع منشن: <@${member.id}>. ${userPrompt}`).then(r => resolve({ ok: true, reply: r })).catch(e => resolve({ ok: false, error: e }));
      });
      const res = await Promise.race([replyPromise, new Promise(res => setTimeout(() => res({ ok: false, error: 'timeout' }), 8000))]);
      welcomeText = res.ok ? res.reply : `أهلًا <@${member.id}>!`;
    } catch {
      welcomeText = `أهلًا <@${member.id}>!`;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎉 أهلًا بك!')
      .setDescription(`<@${member.id}>\n${welcomeText}`)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('welcome error:', err);
  }
});

// ===== Keep alive =====
const app = express();
app.get('/', (_, res) => res.send(`${BOT_NAME} is alive — mode: ${AI_MODE}.`));
app.listen(PORT, () => console.log(`Webserver on ${PORT}`));

client.login(TOKEN).catch(err => {
  console.error('Login failed:', err);
  process.exit(1);
});

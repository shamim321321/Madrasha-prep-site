// /api/generate-explanation.js
// AI Learn: takes a topic + language, returns a structured explanation
// (definition, discussion, examples, exam-important points, tips) via Gemini.
// Uses the same model fallback + retry system as generate-mcq.js.

const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
const MAX_ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 1200;

const LANG_LABEL = { bn: 'বাংলা (Bengali)', ar: 'العربية (Arabic)', en: 'English' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'শুধু POST রিকোয়েস্ট গ্রহণযোগ্য।' });
    return;
  }

  try {
    const { topic, lang } = req.body || {};
    if (!topic || typeof topic !== 'string' || !topic.trim()) {
      res.status(400).json({ error: 'একটা টপিক লিখুন।' });
      return;
    }
    const langCode = ['bn', 'ar', 'en'].includes(lang) ? lang : 'bn';
    const langLabel = LANG_LABEL[langCode];

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY সেট করা নেই।' });
      return;
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      res.status(500).json({ error: 'সার্ভারে SUPABASE_URL/SUPABASE_SERVICE_KEY সেট করা নেই।' });
      return;
    }

    // ---- ইউজার শনাক্তকরণ ----
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const user = await getUserFromToken(token, supabaseUrl, supabaseKey);
    if (!user) {
      res.status(401).json({ error: 'লগইন সেশন যাচাই করা যায়নি, আবার লগইন করুন।' });
      return;
    }

    // ---- দৈনিক লিমিট চেক (ডিফল্ট 10/দিন, admin panel থেকে পরিবর্তনযোগ্য) ----
    const dailyLimit = await getEffectiveLimit(supabaseUrl, supabaseKey, user.id, 'learn');
    if (dailyLimit !== null) {
      const currentUsage = await getTodayUsage(supabaseUrl, supabaseKey, user.id, 'learn');
      if (currentUsage >= dailyLimit) {
        res.status(429).json({ error: `আজকের জন্য AI Learn ব্যবহারের সীমা (${dailyLimit}) শেষ হয়ে গেছে। কাল আবার চেষ্টা করুন।` });
        return;
      }
    }

    const prompt = `তুমি একজন অভিজ্ঞ শিক্ষক, মাদ্রাসা শিক্ষক নিবন্ধন (NTRCA) পরীক্ষার্থীদের জন্য পড়াও।
নিচের টপিকটি ${langLabel} ভাষায় বিস্তারিত ব্যাখ্যা করো: "${topic.trim()}"

শুধুমাত্র নিচের JSON কাঠামো অনুযায়ী উত্তর দাও, অন্য কোনো টেক্সট, মার্কডাউন, বা কোড ফেন্স ছাড়া:

{
  "definition": "টপিকটির সংক্ষিপ্ত ও স্পষ্ট সংজ্ঞা (২-৩ বাক্য)",
  "discussion": "টপিকটি নিয়ে বিস্তারিত আলোচনা (৩-৬ বাক্য, প্রাসঙ্গিক প্রেক্ষাপটসহ)",
  "examples": ["উদাহরণ ১", "উদাহরণ ২"],
  "examPoints": ["পরীক্ষায় গুরুত্বপূর্ণ পয়েন্ট ১", "পয়েন্ট ২"],
  "tips": "এই টপিক সহজে মনে রাখার একটা টিপস"
}`;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function callGemini(model) {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.4 }
          })
        }
      );
      const data = await geminiRes.json();
      return { ok: geminiRes.ok, status: geminiRes.status, data };
    }

    function isOverloaded(result) {
      if (result.status === 503) return true;
      const msg = (result.data?.error?.message || '').toLowerCase();
      return msg.includes('high demand') || msg.includes('overload');
    }

    let result = null;
    let lastError = null;

    outer:
    for (const model of MODELS) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        result = await callGemini(model);

        if (result.ok) break outer;

        lastError = result.data?.error?.message || 'অজানা এরর';

        if (isOverloaded(result)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        break outer;
      }
    }

    if (!result || !result.ok) {
      res.status(502).json({
        error: 'Gemini API এরর: ' + (lastError || 'সব মডেলে চেষ্টা করার পরও ব্যর্থ হয়েছে। একটু পর আবার চেষ্টা করুন।')
      });
      return;
    }

    const { data } = result;
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    let explanation;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      explanation = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'AI-এর উত্তর পার্স করা যায়নি।' });
      return;
    }

    // Gemini কল সফল হয়েছে — আজকের ব্যবহার কাউন্ট বাড়ানো
    await incrementUsage(supabaseUrl, supabaseKey, user.id, 'learn');

    res.status(200).json({ explanation });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে: ' + err.message });
  }
};

// ================================================================
// সহায়ক ফাংশনসমূহ (generate-mcq.js-এর মতোই — লিমিট/ইউসেজ সিস্টেম শেয়ার্ড লজিক)
// ================================================================

async function getUserFromToken(token, supabaseUrl, apiKey) {
  if (!token) return null;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.id ? data : null;
  } catch (e) {
    return null;
  }
}

async function getEffectiveLimit(supabaseUrl, supabaseKey, userId, feature) {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  try {
    const ures = await fetch(
      `${supabaseUrl}/rest/v1/user_ai_limits?user_id=eq.${userId}&feature=eq.${feature}&select=daily_limit`,
      { headers }
    );
    const urows = await ures.json().catch(() => []);
    if (Array.isArray(urows) && urows.length > 0 && urows[0].daily_limit !== null && urows[0].daily_limit !== undefined) {
      return urows[0].daily_limit;
    }
  } catch (e) { /* ignore */ }

  try {
    const col = feature === 'learn' ? 'ai_learn_daily_limit' : 'ai_practice_daily_limit';
    const sres = await fetch(`${supabaseUrl}/rest/v1/site_settings?id=eq.1&select=${col}`, { headers });
    const srows = await sres.json().catch(() => []);
    if (Array.isArray(srows) && srows.length > 0) {
      const val = srows[0][col];
      return (val === null || val === undefined) ? null : val;
    }
  } catch (e) { /* ignore */ }

  return null;
}

async function getTodayUsage(supabaseUrl, supabaseKey, userId, feature) {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const today = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${userId}&usage_date=eq.${today}&feature=eq.${feature}&select=count`,
      { headers }
    );
    const rows = await res.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0 ? (rows[0].count || 0) : 0;
  } catch (e) {
    return 0;
  }
}

async function incrementUsage(supabaseUrl, supabaseKey, userId, feature) {
  const today = new Date().toISOString().slice(0, 10);
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  try {
    await fetch(`${supabaseUrl}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: userId, usage_date: today, feature, count: 1 }])
    });
    const getRes = await fetch(
      `${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${userId}&usage_date=eq.${today}&feature=eq.${feature}&select=count`,
      { headers }
    );
    const rows = await getRes.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      const newCount = rows[0].count || 1;
      await fetch(
        `${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${userId}&usage_date=eq.${today}&feature=eq.${feature}`,
        {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ count: newCount >= 1 ? newCount : 1, updated_at: new Date().toISOString() })
        }
      );
    }
  } catch (e) {
    // usage লগ ব্যর্থ হলেও ইউজারের রেসপন্স আটকানো হবে না
  }
}

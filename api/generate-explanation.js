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

    res.status(200).json({ explanation });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে: ' + err.message });
  }
};

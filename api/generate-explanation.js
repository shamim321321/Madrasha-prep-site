// /api/generate-explanation.js
// AI Learn: takes a topic + language, returns a structured explanation
// (definition, discussion, examples, exam-important points, tips) via Gemini.
//
// NOTE: written to mirror the conventions of /api/generate-mcq.js as closely
// as possible without having that file in front of me — same env var name
// (GEMINI_API_KEY), same "surface the raw Gemini error message" behavior.
// Please diff this against generate-mcq.js and align the model name / retry
// logic / env var if they differ there.

const GEMINI_MODEL = 'gemini-2.5-flash';

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
      res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY কনফিগার করা নেই।' });
      return;
    }

    const prompt = `তুমি একজন অভিজ্ঞ শিক্ষক, মাদ্রাসা শিক্ষক নিবন্ধন (NTRCA) পরীক্ষার্থীদের জন্য পড়াও।
নিচের টপিকটি ${langLabel} ভাষায় ব্যাখ্যা করো: "${topic.trim()}"

শুধুমাত্র নিচের JSON কাঠামো অনুযায়ী উত্তর দাও, অন্য কোনো টেক্সট, মার্কডাউন, বা ব্যাখ্যা ছাড়া:

{
  "definition": "টপিকটির সংক্ষিপ্ত ও স্পষ্ট সংজ্ঞা (২-৩ বাক্য)",
  "discussion": "টপিকটি নিয়ে বিস্তারিত আলোচনা (৩-৬ বাক্য, প্রাসঙ্গিক প্রেক্ষাপটসহ)",
  "examples": ["উদাহরণ ১", "উদাহরণ ২", "উদাহরণ ৩ (প্রযোজ্য হলে)"],
  "examPoints": ["পরীক্ষায় সাধারণত যেভাবে প্রশ্ন আসে বা যে পয়েন্টগুলো মনে রাখা জরুরি", "আরেকটি গুরুত্বপূর্ণ পয়েন্ট"],
  "tips": "এই টপিকটি সহজে মনে রাখার বা পড়ার একটা সংক্ষিপ্ত টিপস (১-২ বাক্য)"
}

কোনো তথ্য নিশ্চিত না হলে অতিরঞ্জিত বা ভুল তথ্য দিও না। examples ও examPoints অ্যারেতে অন্তত ২টা আইটেম দাও।`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
          },
        }),
      }
    );

    const geminiData = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = geminiData?.error?.message || 'অজানা এরর';
      res.status(502).json({ error: `Gemini API এর: ${msg}` });
      return;
    }

    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      res.status(502).json({ error: 'AI থেকে কোনো উত্তর পাওয়া যায়নি।' });
      return;
    }

    let explanation;
    try {
      explanation = JSON.parse(rawText);
    } catch (e) {
      res.status(502).json({ error: 'AI-এর উত্তর সঠিক ফরম্যাটে পার্স করা যায়নি।' });
      return;
    }

    res.status(200).json({ explanation });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে: ' + err.message });
  }
};

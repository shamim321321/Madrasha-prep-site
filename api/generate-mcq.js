// Vercel Serverless Function — এই ফাইলটা সার্ভারে চলে, GEMINI_API_KEY কখনো ব্রাউজারে যায় না।

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'শুধু POST রিকোয়েস্ট গ্রহণযোগ্য' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY সেট করা নেই।' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const subject = (body?.subject || '').toString().trim().slice(0, 200);
  const count = Math.min(30, Math.max(1, parseInt(body?.count) || 10));
  const lang = body?.lang === 'ar' ? 'ar' : 'bn';

  if (!subject) {
    res.status(400).json({ error: 'বিষয়/টপিক দিন।' });
    return;
  }

  const prompt = lang === 'ar'
    ? `أنت خبير في إعداد أسئلة الاختيار من متعدد لامتحان تعيين مدرسي مدرسة (NTRCA) في بنغلاديش.
الموضوع: "${subject}"
أنشئ بالضبط ${count} سؤال اختيار من متعدد بمستوى جيد باللغة العربية الفصحى حول هذا الموضوع. لكل سؤال أربعة خيارات، إجابة صحيحة واحدة فقط، وشرح مختصر.

أرجع فقط مصفوفة JSON بالتنسيق التالي أدناه، دون أي نص إضافي أو علامات markdown. حقل "explanation" يجب أن يكون باللغة العربية، وحقل "explanation_bn" هو نفس الشرح لكن مترجم إلى اللغة البنغالية:
[
  {
    "question": "نص السؤال",
    "option_a": "الخيار الأول",
    "option_b": "الخيار الثاني",
    "option_c": "الخيار الثالث",
    "option_d": "الخيار الرابع",
    "correct": "a",
    "explanation": "شرح مختصر باللغة العربية",
    "explanation_bn": "একই ব্যাখ্যা বাংলায়"
  }
]
يجب أن يحتوي حقل "correct" على حرف واحد فقط: a أو b أو c أو d.`
    : `তুমি বাংলাদেশের NTRCA মাদ্রাসা শিক্ষক নিবন্ধন পরীক্ষার প্রস্তুতির জন্য একজন অভিজ্ঞ প্রশ্নকর্তা।
বিষয়/টপিক: "${subject}"
এই বিষয়ে ঠিক ${count}টি মানসম্মত বহুনির্বাচনী প্রশ্ন (MCQ) বাংলায় তৈরি করো। প্রতিটি প্রশ্নে ৪টি অপশন থাকবে, একটাই সঠিক উত্তর, এবং একটা সংক্ষিপ্ত ব্যাখ্যা থাকবে।

শুধুমাত্র নিচের ফরম্যাটে একটা JSON array রিটার্ন করো, অন্য কোনো লেখা, ব্যাখ্যা বা মার্কডাউন কোড ফেন্স ছাড়া:
[
  {
    "question": "প্রশ্নের লেখা",
    "option_a": "অপশন ক",
    "option_b": "অপশন খ",
    "option_c": "অপশন গ",
    "option_d": "অপশন ঘ",
    "correct": "a",
    "explanation": "সংক্ষিপ্ত ব্যাখ্যা"
  }
]
"correct" ফিল্ডে শুধু a, b, c অথবা d এর একটা অক্ষর থাকবে।`;

  // মডেল ওভারলোডেড (503/"high demand") হলে এই ক্রমে চেষ্টা করা হবে
  const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.6-flash'];
  const MAX_ATTEMPTS_PER_MODEL = 2;
  const RETRY_DELAY_MS = 1200;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function callGemini(model) {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    const data = await geminiRes.json();
    return { ok: geminiRes.ok, status: geminiRes.status, data };
  }

  function isOverloaded(result) {
    // 503 বা "high demand"/"overloaded" জাতীয় মেসেজ হলে retry/fallback যোগ্য বলে ধরা হবে
    if (result.status === 503) return true;
    const msg = (result.data?.error?.message || '').toLowerCase();
    return msg.includes('high demand') || msg.includes('overload');
  }

  try {
    let result = null;
    let lastError = null;

    outer:
    for (const model of MODELS) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        result = await callGemini(model);

        if (result.ok) break outer;

        lastError = result.data?.error?.message || 'অজানা এরর';

        if (isOverloaded(result)) {
          // ওভারলোডেড হলে সামান্য অপেক্ষা করে হয় আবার একই মডেলে, নয়তো পরের মডেলে চেষ্টা
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        // অন্য ধরনের এরর (যেমন ৪০০/৪০১) হলে retry করে লাভ নেই, সরাসরি বের হয়ে যাওয়া
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
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let questions;
    try {
      const cleaned = text.replace(/```json|```/g, '').trim();
      questions = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'AI-এর উত্তর পার্স করা যায়নি।' });
      return;
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      res.status(502).json({ error: 'কোনো প্রশ্ন তৈরি হয়নি, আবার চেষ্টা করুন।' });
      return;
    }

    res.status(200).json({ questions });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার এরর: ' + err.message });
  }
};

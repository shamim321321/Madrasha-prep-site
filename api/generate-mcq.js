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
  // subjectName: ড্রপডাউন থেকে আসা বাধ্যতামূলক সাবজেক্ট (questions.subject কলামে টেক্সট হিসেবে সেভ হয়)
  // topic: ইউজারের ফ্রি-টেক্সট টপিক
  const subjectName = (body?.subjectName || '').toString().trim().slice(0, 100);
  const topic = (body?.topic || '').toString().trim().slice(0, 200);
  const count = Math.min(30, Math.max(1, parseInt(body?.count) || 10));
  const lang = ['ar', 'en'].includes(body?.lang) ? body.lang : 'bn';

  if (!subjectName) {
    res.status(400).json({ error: 'সাবজেক্ট নির্বাচন করা বাধ্যতামূলক।' });
    return;
  }
  if (!topic) {
    res.status(400).json({ error: 'টপিক লিখুন।' });
    return;
  }

  // প্রম্পটে "বিষয়" হিসেবে সাবজেক্ট + টপিক একসাথে ব্যবহার হবে
  const subject = `${subjectName} — ${topic}`;

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
    : lang === 'en'
    ? `You are an expert question setter preparing MCQs for Bangladesh's NTRCA (madrasha teacher registration) exam candidates.
Subject/Topic: "${subject}"
Create exactly ${count} good-quality multiple choice questions in English on this subject. Each question must have 4 options, exactly one correct answer, and a short explanation.

Return ONLY a JSON array in the exact format below, with no extra text or markdown code fences. The "explanation_bn" field should be the same explanation translated into Bengali:
[
  {
    "question": "question text",
    "option_a": "option A",
    "option_b": "option B",
    "option_c": "option C",
    "option_d": "option D",
    "correct": "a",
    "explanation": "short explanation in English",
    "explanation_bn": "একই ব্যাখ্যা বাংলায়"
  }
]
The "correct" field must contain only one letter: a, b, c, or d.`
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

    // ============================================
    // Supabase-এ প্রশ্নগুলো সেভ করা (প্রশ্ন ব্যাংক)
    // ব্যর্থ হলেও ইউজারকে জেনারেট হওয়া প্রশ্ন দেখানো বন্ধ হবে না
    // ============================================
    let saved = 0;
    let dbError = null;

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey) {
      try {
        const rows = questions
          .filter((q) => q && q.question && q.option_a && q.option_b && q.option_c && q.option_d && q.correct)
          .map((q) => ({
            subject: subjectName,
            topic: topic,
            question: q.question,
            option_a: q.option_a,
            option_b: q.option_b,
            option_c: q.option_c,
            option_d: q.option_d,
            correct: q.correct.toString().toLowerCase().slice(0, 1),
            explanation: q.explanation || null,
            explanation_bn: q.explanation_bn || null,
            language: lang,
            source: 'ai',
            status: 'pending'
          }));

        if (rows.length > 0) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/questions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify(rows)
          });

          if (insertRes.ok) {
            saved = rows.length;
          } else {
            const errData = await insertRes.json().catch(() => ({}));
            dbError = errData?.message || `Supabase insert ব্যর্থ (status ${insertRes.status})`;
          }
        }
      } catch (dbErr) {
        dbError = dbErr.message;
      }
    } else {
      dbError = 'SUPABASE_URL/SUPABASE_SERVICE_KEY সেট করা নেই, প্রশ্ন সেভ হয়নি।';
    }

    res.status(200).json({ questions, saved, dbError });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার এরর: ' + err.message });
  }
};

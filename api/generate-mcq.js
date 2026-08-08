// Vercel Serverless Function — এই ফাইলটা সার্ভারে চলে, GEMINI_API_KEY কখনো ব্রাউজারে যায় না।
// টপিক "__random__" হলে DB-first (subject-ম্যাচ, র‍্যান্ডম) থেকে সার্ভ করা হয়;
// কাস্টম টপিক হলে DB-তে ilike ম্যাচ চেষ্টা করা হয়; দুই ক্ষেত্রেই ঘাটতি Gemini দিয়ে টপ-আপ হয়।
// শুধু আসল Gemini কল হলেই (partial/full) দৈনিক ai_usage কাউন্ট বাড়বে।

const RANDOM_TOPIC = '__random__';

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

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'সার্ভারে SUPABASE_URL/SUPABASE_SERVICE_KEY সেট করা নেই।' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  // subjectName: ড্রপডাউন থেকে আসা বাধ্যতামূলক সাবজেক্ট (questions.subject কলামে টেক্সট হিসেবে সেভ হয়)
  // topic: ইউজারের ফ্রি-টেক্সট টপিক, অথবা RANDOM_TOPIC ('__random__')
  const subjectName = (body?.subjectName || '').toString().trim().slice(0, 100);
  const rawTopic = (body?.topic || '').toString().trim().slice(0, 200);
  const isRandom = rawTopic === RANDOM_TOPIC;
  const topic = isRandom ? '' : rawTopic;
  const count = Math.min(30, Math.max(1, parseInt(body?.count) || 10));
  const lang = ['ar', 'en'].includes(body?.lang) ? body.lang : 'bn';
  const difficulty = ['easy', 'medium', 'hard'].includes(body?.difficulty) ? body.difficulty : 'easy';

  if (!subjectName) {
    res.status(400).json({ error: 'সাবজেক্ট নির্বাচন করা বাধ্যতামূলক।' });
    return;
  }
  if (!isRandom && !topic) {
    res.status(400).json({ error: 'টপিক লিখুন।' });
    return;
  }

  // ============================================
  // ধাপ ১: ইউজার শনাক্তকরণ (Supabase access token verify)
  // ============================================
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = await getUserFromToken(token, supabaseUrl, supabaseKey);
  if (!user) {
    res.status(401).json({ error: 'লগইন সেশন যাচাই করা যায়নি, আবার লগইন করুন।' });
    return;
  }

  // ============================================
  // ধাপ ২: দৈনিক লিমিট চেক (admin panel-controlled)
  // ============================================
  const dailyLimit = await getEffectiveLimit(supabaseUrl, supabaseKey, user.id, 'practice');
  let currentUsage = 0;
  if (dailyLimit !== null) {
    currentUsage = await getTodayUsage(supabaseUrl, supabaseKey, user.id, 'practice');
    if (currentUsage >= dailyLimit) {
      res.status(429).json({ error: `আজকের জন্য AI Practice ব্যবহারের সীমা (${dailyLimit}) শেষ হয়ে গেছে। কাল আবার চেষ্টা করুন।` });
      return;
    }
  }

  // ============================================
  // ধাপ ৩: এই subject/topic-এ DB-তে যা যা প্রশ্ন আগে থেকে আছে তার একটা নমুনা নেওয়া,
  // যাতে Gemini-কে prompt-এই বলে দেওয়া যায় কোনগুলো এড়িয়ে সম্পূর্ণ নতুন প্রশ্ন বানাতে হবে
  // ============================================
  const effectiveTopicForPrompt = isRandom ? subjectName : topic;
  const existingQuestions = await fetchExistingQuestionTexts(
    supabaseUrl, supabaseKey, subjectName, isRandom ? null : topic
  );

  const aiResult = await generateViaGemini({
    apiKey, subjectName, topic: effectiveTopicForPrompt, count, lang, difficulty, existingQuestions
  });

  if (aiResult.error) {
    res.status(502).json({ error: aiResult.error });
    return;
  }

  // AI-জেনারেটেড প্রশ্ন Supabase-এ সেভ করা — prompt-এ এড়াতে বলা সত্ত্বেও যদি কাকতালীয়ভাবে
  // কোনোটা আগের কোনো প্রশ্নের সাথে ~৮০%+ মিলে যায়, সেটা একটা ব্যাকআপ সেফটি-চেক হিসেবে সেভ হবে না
  const { saved, skippedDuplicates, dbError } = await saveGeneratedQuestions(
    supabaseUrl, supabaseKey, aiResult.questions, subjectName, effectiveTopicForPrompt, lang
  );

  // Gemini কল সফল হয়েছে — কাউন্ট বাড়ানো
  await incrementUsage(supabaseUrl, supabaseKey, user.id, 'practice');

  res.status(200).json({
    questions: aiResult.questions.map(toClientShape),
    saved,
    skippedDuplicates,
    dbError,
    source: 'ai'
  });
};

// ================================================================
// সহায়ক ফাংশনসমূহ
// ================================================================

function toClientShape(q) {
  // DB রো ও AI রো — দুটোই একই শেপে ফ্রন্টএন্ডে যাবে
  return {
    question: q.question,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct: q.correct,
    explanation: q.explanation || null,
    explanation_bn: q.explanation_bn || null
  };
}

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
  // পার-ইউজার override আগে চেক করা
  try {
    const ures = await fetch(
      `${supabaseUrl}/rest/v1/user_ai_limits?user_id=eq.${userId}&feature=eq.${feature}&select=daily_limit`,
      { headers }
    );
    const urows = await ures.json().catch(() => []);
    if (Array.isArray(urows) && urows.length > 0 && urows[0].daily_limit !== null && urows[0].daily_limit !== undefined) {
      return urows[0].daily_limit;
    }
  } catch (e) { /* ignore, fall through to global default */ }

  // গ্লোবাল ডিফল্ট (site_settings)
  try {
    const col = feature === 'learn' ? 'ai_learn_daily_limit' : 'ai_practice_daily_limit';
    const sres = await fetch(`${supabaseUrl}/rest/v1/site_settings?id=eq.1&select=${col}`, { headers });
    const srows = await sres.json().catch(() => []);
    if (Array.isArray(srows) && srows.length > 0) {
      const val = srows[0][col];
      return (val === null || val === undefined) ? null : val;
    }
  } catch (e) { /* ignore */ }

  return null; // কিছু না পেলে unlimited ধরে নেওয়া (fail-open)
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
    return 0; // fail-open
  }
}

async function incrementUsage(supabaseUrl, supabaseKey, userId, feature) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await fetch(`${supabaseUrl}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify([{ user_id: userId, usage_date: today, feature, count: 1 }])
    });
    // উপরের merge-duplicates শুধু ইনসার্ট/রিপ্লেস করে, +1 করে না — তাই না থাকলে insert, থাকলে নিচের update দিয়ে +1
    const getRes = await fetch(
      `${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${userId}&usage_date=eq.${today}&feature=eq.${feature}&select=count`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    const rows = await getRes.json().catch(() => []);
    if (Array.isArray(rows) && rows.length > 0) {
      const newCount = (rows[0].count || 1);
      await fetch(
        `${supabaseUrl}/rest/v1/ai_usage?user_id=eq.${userId}&usage_date=eq.${today}&feature=eq.${feature}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({ count: newCount >= 1 ? newCount : 1, updated_at: new Date().toISOString() })
        }
      );
    }
  } catch (e) {
    // usage লগ ব্যর্থ হলেও ইউজারের রেসপন্স আটকানো হবে না
  }
}

async function isDuplicateQuestion(supabaseUrl, supabaseKey, subjectName, questionText) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/is_similar_question`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      },
      body: JSON.stringify({ p_subject: subjectName, p_question: questionText, p_threshold: 0.8 })
    });
    if (!res.ok) return false; // চেক ব্যর্থ হলেও সেভ করাই ভালো (fail-open, প্রশ্নব্যাংক বাড়তে থাকুক)
    const isDup = await res.json();
    return isDup === true;
  } catch (e) {
    return false;
  }
}

async function saveGeneratedQuestions(supabaseUrl, supabaseKey, questions, subjectName, topic, lang) {
  let saved = 0;
  let skippedDuplicates = 0;
  let dbError = null;
  try {
    const validQuestions = questions.filter(
      (q) => q && q.question && q.option_a && q.option_b && q.option_c && q.option_d && q.correct
    );

    const rows = [];
    for (const q of validQuestions) {
      const isDup = await isDuplicateQuestion(supabaseUrl, supabaseKey, subjectName, q.question);
      if (isDup) { skippedDuplicates++; continue; }
      rows.push({
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
      });
    }

    if (rows.length > 0) {
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'return=minimal'
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
  return { saved, skippedDuplicates, dbError };
}

async function fetchExistingQuestionTexts(supabaseUrl, supabaseKey, subjectName, topic) {
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  try {
    const topicFilter = topic ? `&topic=ilike.*${encodeURIComponent(topic)}*` : '';
    const res = await fetch(
      `${supabaseUrl}/rest/v1/questions?subject=eq.${encodeURIComponent(subjectName)}${topicFilter}&select=question&limit=250`,
      { headers }
    );
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return [];
    // ৫০টার একটা র‍্যান্ডম নমুনা — pool যত বড়ই হোক (৫০,০০০+), prompt-এ পুরোটা পাঠানো সম্ভব না
    const shuffled = rows.map(r => r.question).filter(Boolean).sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 50);
  } catch (e) {
    return []; // ব্যর্থ হলেও জেনারেশন থেমে থাকবে না (fail-open)
  }
}

async function generateViaGemini({ apiKey, subjectName, topic, count, lang, difficulty, existingQuestions = [] }) {
  const subject = `${subjectName} — ${topic}`;

  const difficultyGuide = {
    easy: {
      ar: 'أسئلة سهلة وواضحة — الحقائق الأساسية، المفاهيم المباشرة',
      en: 'Easy questions — basic facts and straightforward concepts.',
      bn: 'সহজ প্রশ্ন — মৌলিক তথ্য এবং সরাসরি ধারণা।'
    },
    medium: {
      ar: 'أسئلة متوسطة — تطبيق المفاهيم، الفهم الأعمق',
      en: 'Moderate questions — application of concepts, deeper understanding.',
      bn: 'মাঝারি প্রশ্ন — ধারণার প্রয়োগ, গভীর বোঝাপড়া।'
    },
    hard: {
      ar: 'أسئلة صعبة — التحليل والمقارنة والتفسير المعقد',
      en: 'Hard questions — analysis, comparison, complex interpretation.',
      bn: 'কঠিন প্রশ্ন — বিশ্লেষণ, তুলনা, জটিল ব্যাখ্যা।'
    }
  };

  const avoidBlock = existingQuestions.length === 0 ? '' : (
    lang === 'ar'
      ? `\nالأسئلة التالية موجودة بالفعل في قاعدة البيانات لهذا الموضوع — لا تكرر أياً منها أو أي سؤال مشابه لها في المعنى، أنشئ أسئلة جديدة تماماً تغطي جوانب أخرى من الموضوع:\n${existingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
      : lang === 'en'
      ? `\nThe following questions already exist in the database for this subject — do NOT repeat any of them or create questions with the same meaning; generate completely new questions covering other aspects of the topic:\n${existingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
      : `\nনিচের প্রশ্নগুলো এই বিষয়ে ইতিমধ্যে ডাটাবেইজে আছে — এগুলোর কোনোটাই বা এগুলোর সাথে অর্থে মিলে যায় এমন কোনো প্রশ্ন তৈরি কোরো না; এই টপিকের অন্যান্য দিক নিয়ে সম্পূর্ণ নতুন প্রশ্ন তৈরি করো:\n${existingQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n`
  );

  const prompt = lang === 'ar'
    ? `أنت خبير في إعداد أسئلة الاختيار من متعدد لامتحان تعيين مدرسي مدرسة (NTRCA) في بنغلاديش.
الموضوع: "${subject}"
مستوى الصعوبة: ${difficulty === 'easy' ? 'سهل' : difficulty === 'medium' ? 'متوسط' : 'صعب'} — ${difficultyGuide[difficulty].ar}
${avoidBlock}
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
Difficulty Level: ${difficulty === 'easy' ? 'Easy' : difficulty === 'medium' ? 'Moderate' : 'Hard'} — ${difficultyGuide[difficulty].en}
${avoidBlock}
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
কঠিনতার মাত্রা: ${difficulty === 'easy' ? 'সহজ' : difficulty === 'medium' ? 'মাঝারি' : 'কঠিন'} — ${difficultyGuide[difficulty].bn}
${avoidBlock}
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
        if (isOverloaded(result)) { await sleep(RETRY_DELAY_MS); continue; }
        break outer;
      }
    }

    if (!result || !result.ok) {
      return { error: 'Gemini API এরর: ' + (lastError || 'সব মডেলে চেষ্টা করার পরও ব্যর্থ হয়েছে। একটু পর আবার চেষ্টা করুন।') };
    }

    const { data } = result;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let questions;
    try {
      const cleaned = text.replace(/```json|```/g, '').trim();
      questions = JSON.parse(cleaned);
    } catch (e) {
      return { error: 'AI-এর উত্তর পার্স করা যায়নি।' };
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return { error: 'কোনো প্রশ্ন তৈরি হয়নি, আবার চেষ্টা করুন।' };
    }

    return { questions };
  } catch (err) {
    return { error: 'সার্ভার এরর: ' + err.message };
  }
}

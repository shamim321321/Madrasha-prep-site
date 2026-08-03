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

  if (!subject) {
    res.status(400).json({ error: 'বিষয়/টপিক দিন।' });
    return;
  }

  const prompt = `তুমি বাংলাদেশের NTRCA মাদ্রাসা শিক্ষক নিবন্ধন পরীক্ষার প্রস্তুতির জন্য একজন অভিজ্ঞ প্রশ্নকর্তা।
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

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, responseMimeType: 'application/json' }
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      res.status(502).json({ error: 'Gemini API এরর: ' + (data?.error?.message || geminiRes.statusText) });
      return;
    }

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

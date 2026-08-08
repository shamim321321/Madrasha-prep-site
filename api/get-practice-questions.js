// /api/get-practice-questions.js
// র‍্যান্ডম / বিষয়ভিত্তিক (DB থেকে, AI ছাড়া) অনুশীলনের জন্য প্রশ্ন সার্ভ করে (practice.html-এর startQuiz() থেকে কল হয়) —
// admin panel-controlled দৈনিক লিমিট সহ (generate-mcq.js / generate-explanation.js-এর মতো একই প্যাটার্নে)।

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'শুধু POST রিকোয়েস্ট গ্রহণযোগ্য' });
    return;
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    res.status(500).json({ error: 'সার্ভারে SUPABASE_URL/SUPABASE_SERVICE_KEY সেট করা নেই।' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const subject = (body?.subject || '').toString().trim().slice(0, 100) || null; // null = র‍্যান্ডম (সব বিষয়)
  const count = Math.min(100, Math.max(1, parseInt(body?.count) || 10));

  // ---- ইউজার শনাক্তকরণ ----
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = await getUserFromToken(token, supabaseUrl, supabaseKey);
  if (!user) {
    res.status(401).json({ error: 'লগইন সেশন যাচাই করা যায়নি, আবার লগইন করুন।' });
    return;
  }

  // ---- দৈনিক লিমিট চেক ----
  const dailyLimit = await getEffectiveLimit(supabaseUrl, supabaseKey, user.id, 'db_practice');
  if (dailyLimit !== null) {
    const currentUsage = await getTodayUsage(supabaseUrl, supabaseKey, user.id, 'db_practice');
    if (currentUsage >= dailyLimit) {
      res.status(429).json({ error: `আজকের জন্য অনুশীলনের সীমা (${dailyLimit}) শেষ হয়ে গেছে। কাল আবার চেষ্টা করুন।` });
      return;
    }
  }

  // ---- প্রশ্ন আনা (subject দেওয়া থাকলে সেটা দিয়ে ফিল্টার, নাহলে সব বিষয় থেকে র‍্যান্ডম) ----
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  let questions = [];
  try {
    const filterPart = subject ? `&subject=eq.${encodeURIComponent(subject)}` : '';
    const qres = await fetch(`${supabaseUrl}/rest/v1/questions?select=*${filterPart}&limit=500`, { headers });
    const rows = await qres.json().catch(() => []);
    if (Array.isArray(rows)) {
      questions = rows.sort(() => Math.random() - 0.5).slice(0, count);
    }
  } catch (e) {
    res.status(502).json({ error: 'প্রশ্ন আনতে সমস্যা হয়েছে: ' + e.message });
    return;
  }

  // সফলভাবে সার্ভ হলে ব্যবহার লগ করা (limit ছাড়াও ভবিষ্যতের এনালিটিক্সের জন্য)
  await incrementUsage(supabaseUrl, supabaseKey, user.id, 'db_practice');

  res.status(200).json({ questions });
};

// ================================================================
// সহায়ক ফাংশনসমূহ (generate-mcq.js / generate-explanation.js-এর মতোই)
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
    const col = feature === 'learn' ? 'ai_learn_daily_limit' : feature === 'db_practice' ? 'ai_db_practice_daily_limit' : 'ai_practice_daily_limit';
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

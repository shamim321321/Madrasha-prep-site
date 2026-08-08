// /api/admin-set-ai-limit.js
// অ্যাডমিন প্যানেল থেকে নির্দিষ্ট ইউজারের AI Practice/Learn লিমিট override সেট/মুছে দেওয়ার এন্ডপয়েন্ট।
// শুধু admins টেবিলে থাকা ইউজারই এটা কল করতে পারবে।

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

  // ---- কলার admin কিনা যাচাই ----
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: 'লগইন প্রয়োজন।' }); return; }

  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  let callerEmail = null;
  try {
    const uRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseKey }
    });
    if (!uRes.ok) { res.status(401).json({ error: 'সেশন যাচাই ব্যর্থ।' }); return; }
    const uData = await uRes.json();
    callerEmail = uData?.email || null;
  } catch (e) {
    res.status(401).json({ error: 'সেশন যাচাই ব্যর্থ।' });
    return;
  }

  if (!callerEmail) { res.status(401).json({ error: 'সেশন যাচাই ব্যর্থ।' }); return; }

  try {
    const adminRes = await fetch(
      `${supabaseUrl}/rest/v1/admins?email=eq.${encodeURIComponent(callerEmail)}&select=email`,
      { headers }
    );
    const adminRows = await adminRes.json().catch(() => []);
    if (!Array.isArray(adminRows) || adminRows.length === 0) {
      res.status(403).json({ error: 'এই কাজের অনুমতি নেই — শুধু অ্যাডমিনরা লিমিট পরিবর্তন করতে পারবেন।' });
      return;
    }
  } catch (e) {
    res.status(500).json({ error: 'অ্যাডমিন যাচাই করতে সমস্যা হয়েছে।' });
    return;
  }

  // ---- ইনপুট পার্স ----
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const email = (body?.email || '').toString().trim().toLowerCase();
  const feature = ['practice', 'learn'].includes(body?.feature) ? body.feature : null;
  const note = (body?.note || '').toString().trim().slice(0, 200) || null;
  // dailyLimit: সংখ্যা হলে সেই লিমিট, null/blank পাঠালে override মুছে ফেলা হবে (গ্লোবাল ডিফল্টে ফিরে যাবে)
  const hasLimit = body?.dailyLimit !== null && body?.dailyLimit !== undefined && body?.dailyLimit !== '';
  const dailyLimit = hasLimit ? Math.max(0, parseInt(body.dailyLimit)) : null;

  if (!email || !feature) {
    res.status(400).json({ error: 'email ও feature (practice/learn) দেওয়া বাধ্যতামূলক।' });
    return;
  }

  // ---- ইমেইল দিয়ে ইউজার আইডি বের করা ----
  let targetUserId = null;
  try {
    const findRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers });
    const findData = await findRes.json().catch(() => null);
    const candidates = findData?.users || (Array.isArray(findData) ? findData : []);
    const match = candidates.find(u => (u.email || '').toLowerCase() === email);
    targetUserId = match?.id || null;
  } catch (e) {
    // ignore, handled below
  }

  if (!targetUserId) {
    res.status(404).json({ error: 'এই ইমেইলে কোনো ইউজার পাওয়া যায়নি।' });
    return;
  }

  // ---- override সেভ/মুছে ফেলা ----
  try {
    if (!hasLimit) {
      // override মুছে গ্লোবাল ডিফল্টে ফিরিয়ে দেওয়া
      await fetch(
        `${supabaseUrl}/rest/v1/user_ai_limits?user_id=eq.${targetUserId}&feature=eq.${feature}`,
        { method: 'DELETE', headers }
      );
      res.status(200).json({ ok: true, message: 'override মুছে দেওয়া হয়েছে, এখন থেকে গ্লোবাল ডিফল্ট প্রযোজ্য হবে।' });
      return;
    }

    await fetch(`${supabaseUrl}/rest/v1/user_ai_limits`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: targetUserId, feature, daily_limit: dailyLimit, note, updated_at: new Date().toISOString() }])
    });
    res.status(200).json({ ok: true, message: `${email}-এর ${feature} লিমিট ${dailyLimit} সেট করা হয়েছে।` });
  } catch (e) {
    res.status(500).json({ error: 'সেভ করতে সমস্যা হয়েছে: ' + e.message });
  }
};

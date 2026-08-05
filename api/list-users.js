// Vercel Serverless Function — এই ফাইলটা সার্ভারে চলে, SUPABASE_SERVICE_KEY কখনো ব্রাউজারে যায় না।
// শুধুমাত্র অ্যাডমিনরাই ইউজার লিস্ট দেখতে পারবেন (নিচে টোকেন দিয়ে ভেরিফাই করা হয়)।

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'শুধু POST রিকোয়েস্ট গ্রহণযোগ্য' });
    return;
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_SERVICE_KEY সেট করা নেই।' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    res.status(401).json({ error: 'লগইন প্রয়োজন।' });
    return;
  }

  try {
    // ধাপ ১: টোকেন দিয়ে ইউজার ভেরিফাই করা
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${token}` }
    });
    const userData = await userRes.json();
    if (!userRes.ok || !userData.email) {
      res.status(401).json({ error: 'সেশন যাচাই করা যায়নি।' });
      return;
    }

    // ধাপ ২: অ্যাডমিন কিনা চেক করা
    const adminCheckRes = await fetch(
      `${supabaseUrl}/rest/v1/admins?email=eq.${encodeURIComponent(userData.email)}&select=email`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    const adminCheckData = await adminCheckRes.json();
    if (!Array.isArray(adminCheckData) || adminCheckData.length === 0) {
      res.status(403).json({ error: 'শুধু অ্যাডমিনের জন্য।' });
      return;
    }

    // ধাপ ৩: সব ইউজারের লিস্ট আনা (Supabase Admin API)
    const listRes = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=1000`, {
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
    });
    const listData = await listRes.json();
    if (!listRes.ok) {
      res.status(502).json({ error: listData?.msg || 'ইউজার লিস্ট আনতে ব্যর্থ হয়েছে।' });
      return;
    }

    const users = (listData.users || []).map((u) => ({
      email: u.email,
      full_name: u.user_metadata?.full_name || null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at
    }));

    res.status(200).json({ users });
  } catch (err) {
    res.status(500).json({ error: 'সার্ভার এরর: ' + err.message });
  }
};

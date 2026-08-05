// ================================================================
// Supabase দিয়ে আসল লগইন/নিবন্ধন সিস্টেম
// নতুন প্রজেক্ট বানালে নিচের দুটো মান বদলে দিন (Project Settings → API Keys)
// ================================================================
const SUPABASE_URL = "https://laujqfawcirnwsmvhaif.supabase.co";
const SUPABASE_KEY = "sb_publishable_rlZV0JZUFH7NdmR_-Oz7Dg_97OQxMpv";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- নিবন্ধন (নতুন একাউন্ট) ----
async function nhSignUp(name, email, password) {
  const { data, error } = await supabaseClient.auth.signUp({
    email: email,
    password: password,
    options: { data: { full_name: name } }
  });
  return { data, error };
}

// ---- লগইন ----
async function nhSignIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  return { data, error };
}

// ---- লগআউট ----
async function nhSignOut() {
  await supabaseClient.auth.signOut();
  window.location.reload();
}

// ---- বর্তমান ইউজার নাভবারে দেখানো (প্রতিটা পেজে কল হবে) ----
async function nhRenderAuthState() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  const loginBtn = document.getElementById('nav-login-btn');
  const userChip = document.getElementById('nav-user');
  if (!loginBtn || !userChip) return;

  if (session && session.user) {
    const name = session.user.user_metadata?.full_name || session.user.email;
    const avatarUrl = session.user.user_metadata?.avatar_url;
    userChip.innerHTML = avatarUrl
      ? `<img src="${avatarUrl}" class="w-full h-full object-cover">`
      : `<span>${(name || '?').trim().charAt(0).toUpperCase()}</span>`;
    userChip.classList.remove('hidden');
    userChip.classList.add('flex');
    loginBtn.classList.add('hidden');
  } else {
    userChip.classList.add('hidden');
    userChip.classList.remove('flex');
    loginBtn.classList.remove('hidden');
  }
}

// ---- ছবি/অ্যাভাটারে ক্লিক করলে ড্রপডাউন মেনু খোলা-বন্ধ করা ----
function nhToggleUserMenu() {
  const menu = document.getElementById('user-menu');
  if (menu) menu.classList.toggle('hidden');
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('user-menu');
  const btn = document.getElementById('nav-user');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
    menu.classList.add('hidden');
  }
});

// ---- প্রোফাইলের তথ্য (নাম, ফোন, ঠিকানা, সোশ্যাল লিংক) আপডেট করা ----
async function nhUpdateProfile(fields) {
  const { data, error } = await supabaseClient.auth.updateUser({ data: fields });
  return { data, error };
}

// ---- পোস্টের ছবি আপলোড করা (Supabase Storage-এ "post-images" নামের বাকেট লাগবে) ----
async function nhUploadPostImage(file, userId) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/${Date.now()}.${ext}`;
  const { error: uploadError } = await supabaseClient.storage.from('post-images').upload(path, file);
  if (uploadError) return { error: uploadError };
  const { data: publicUrlData } = supabaseClient.storage.from('post-images').getPublicUrl(path);
  return { imageUrl: publicUrlData.publicUrl };
}

// ---- প্রোফাইল ছবি আপলোড করা (Supabase Storage-এ "avatars" নামের বাকেট লাগবে) ----
async function nhUploadAvatar(file, userId) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/avatar.${ext}`;
  const { error: uploadError } = await supabaseClient.storage.from('avatars').upload(path, file, { upsert: true });
  if (uploadError) return { error: uploadError };
  const { data: publicUrlData } = supabaseClient.storage.from('avatars').getPublicUrl(path);
  const avatarUrl = publicUrlData.publicUrl + '?t=' + Date.now();
  const { data, error } = await nhUpdateProfile({ avatar_url: avatarUrl });
  return { data, error, avatarUrl };
}

// ---- বর্তমান ইউজার অ্যাডমিন/এডিটর কিনা চেক করা (admins টেবিল দেখে) ----
async function nhIsAdmin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session || !session.user) return false;
  const { data } = await supabaseClient.from('admins').select('email').eq('email', session.user.email).maybeSingle();
  return !!data;
}

// ---- মেইনটেন্যান্স মোড চেক (auth.js যেকোনো পেজে লোড হলেই স্বয়ংক্রিয়ভাবে চলবে) ----
(async function nhMaintenanceGate() {
  const path = (window.location.pathname.split('/').pop() || 'index.html');
  if (path === 'maintenance.html') return; // লুপ এড়ানোর জন্য
  try {
    const { data } = await supabaseClient.from('site_settings').select('maintenance_mode').eq('id', 1).maybeSingle();
    if (data && data.maintenance_mode) {
      const isAdmin = await nhIsAdmin();
      if (!isAdmin) {
        window.location.href = 'maintenance.html';
      }
    }
  } catch (e) {
    // চেক ব্যর্থ হলে সাইট বন্ধ না করে স্বাভাবিকভাবে চলতে দেওয়া (fail-open)
  }
})();

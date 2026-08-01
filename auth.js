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
    userChip.textContent = name;
    userChip.classList.remove('hidden');
    userChip.onclick = () => { window.location.href = 'profile.html'; };
    loginBtn.classList.add('hidden');
  } else {
    userChip.classList.add('hidden');
    loginBtn.classList.remove('hidden');
  }
}

// ---- প্রোফাইলের তথ্য (নাম, ফোন, ঠিকানা, সোশ্যাল লিংক) আপডেট করা ----
async function nhUpdateProfile(fields) {
  const { data, error } = await supabaseClient.auth.updateUser({ data: fields });
  return { data, error };
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

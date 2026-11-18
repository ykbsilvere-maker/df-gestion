// Fonction serveur « telegram » (Supabase Edge Function, Deno) — robot Telegram « DF Gestion ».
//
// 1. Webhook du robot (appelé par Telegram, reconnu par son en-tête secret) : « /start <code> »
//    relie le Telegram de la personne à son compte DF Gestion ; elle y recevra ses codes OTP.
// 2. Configuration par l'administrateur général (jeton de session obligatoire) : vérifie le jeton
//    du robot, règle son nom, sa description, son logo et le webhook, puis garde le jeton côté
//    serveur (jamais renvoyé à un écran).
//
// Déploiement : Supabase > Edge Functions > « telegram », « Verify JWT » désactivé (Telegram
// n'envoie pas de jeton ; la fonction fait ses propres contrôles).

import { createClient } from 'npm:@supabase/supabase-js@2';

const ENTETES = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reponse = (corps: Record<string, unknown>, statut = 200) => new Response(JSON.stringify(corps), { status: statut, headers: ENTETES });

function cle(historique: string, dictionnaire: string): string | undefined {
  const v = Deno.env.get(historique);
  if (v) return v;
  try {
    const d = JSON.parse(Deno.env.get(dictionnaire) ?? '{}') as Record<string, string>;
    return d.default ?? Object.values(d)[0];
  } catch {
    return undefined;
  }
}

async function api(jeton: string, methode: string, corps: Record<string, unknown> | FormData) {
  const r = await fetch(`https://api.telegram.org/bot${jeton}/${methode}`, {
    method: 'POST',
    ...(corps instanceof FormData ? { body: corps } : { body: JSON.stringify(corps), headers: { 'Content-Type': 'application/json' } }),
  });
  return (await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))) as { ok: boolean; result?: unknown; description?: string };
}

function aleatoire(n = 24): string {
  const o = new Uint8Array(n);
  crypto.getRandomValues(o);
  return Array.from(o, (x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ENTETES });
  if (req.method !== 'POST') return reponse({ ok: false, message: 'Méthode non autorisée' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const secrete = cle('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!url || !secrete) return reponse({ ok: false, message: 'Fonction mal configurée' }, 500);
  const service = createClient(url, secrete, { auth: { persistSession: false, autoRefreshToken: false } });

  // ---------- 1. Webhook Telegram
  const secretRecu = req.headers.get('x-telegram-bot-api-secret-token');
  if (secretRecu) {
    const { data: rb } = await service.rpc('telegram_robot_interne');
    const robot = rb as { jeton?: string; secret?: string; nom?: string } | null;
    if (!robot?.jeton || secretRecu !== robot.secret) return new Response('interdit', { status: 401 });
    const maj = (await req.json().catch(() => ({}))) as {
      message?: { text?: string; chat?: { id?: number; type?: string }; from?: { username?: string; first_name?: string } };
    };
    const m = maj.message;
    const chat = m?.chat?.id;
    if (!m || !chat || m.chat?.type !== 'private') return new Response('ok');
    const texte = (m.text ?? '').trim();
    const code = /^\/start\s+([A-Za-z0-9_-]{16,64})$/.exec(texte)?.[1];
    let message: string;
    if (code) {
      const nomTg = m.from?.username ? `@${m.from.username}` : m.from?.first_name ?? '';
      const { data } = await service.rpc('telegram_relier', { p_code: code, p_chat_id: chat, p_nom_telegram: nomTg });
      const r = data as { ok: boolean; nom?: string; entreprise?: string } | null;
      message = r?.ok
        ? `✅ Bonjour ${r.nom ?? ''} !\nCe Telegram est relié à votre accès <b>${r.entreprise ?? 'DF Gestion'}</b>.\nVos codes OTP de connexion arriveront ici.`
        : '⚠️ Ce lien d’activation n’est plus valable. Demandez-en un nouveau à votre gérante.';
    } else {
      message = `👋 Bonjour ! Je suis le robot <b>${robot.nom ?? 'DF Gestion'}</b>.\nJ’envoie les codes OTP de connexion. Pour être relié, ouvrez le lien d’activation remis par votre gérante.`;
    }
    await api(robot.jeton, 'sendMessage', { chat_id: chat, text: message, parse_mode: 'HTML' });
    return new Response('ok');
  }

  // ---------- 2. Configuration par l'administrateur général
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u } = await service.auth.getUser(jwt);
  if (!u?.user) return reponse({ ok: false, message: 'Connexion requise' }, 401);
  const { data: admin } = await service.rpc('telegram_est_admin', { p_user: u.user.id });
  if (admin !== true) return reponse({ ok: false, message: 'Réservé à l’administrateur général' }, 403);

  let corps: { action?: string; jeton?: string; nom?: string; description?: string; logo?: string };
  try {
    corps = await req.json();
  } catch {
    return reponse({ ok: false, message: 'Requête illisible' }, 400);
  }
  if (corps.action !== 'configurer') return reponse({ ok: false, message: 'Action inconnue' }, 400);

  // Jeton : nouveau, ou celui déjà enregistré (pour changer seulement le nom ou le logo).
  let jeton = String(corps.jeton ?? '').trim();
  if (!jeton) {
    const { data: rb } = await service.rpc('telegram_robot_interne');
    jeton = (rb as { jeton?: string } | null)?.jeton ?? '';
  }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(jeton)) return reponse({ ok: false, message: 'Jeton du robot invalide (format 123456789:ABC…)' });
  const moi = await api(jeton, 'getMe', {});
  if (!moi.ok) return reponse({ ok: false, message: `Telegram refuse ce jeton : ${moi.description ?? 'inconnu'}` });
  const robot = (moi.result as { username: string }).username;
  const nom = String(corps.nom ?? '').trim().slice(0, 64) || 'DF Gestion';
  const description = String(corps.description ?? '').trim().slice(0, 512) ||
    'Robot officiel DF Gestion : il vous envoie vos codes OTP de connexion. Ne communiquez jamais un code à personne.';
  const avertissements: string[] = [];
  const n = await api(jeton, 'setMyName', { name: nom });
  if (!n.ok && !/not modified/i.test(n.description ?? '')) avertissements.push(`nom : ${n.description}`);
  await api(jeton, 'setMyDescription', { description });
  await api(jeton, 'setMyShortDescription', { short_description: 'Codes OTP de connexion DF Gestion' });
  if (corps.logo) {
    try {
      const brut = Uint8Array.from(atob(corps.logo.replace(/^data:[^,]+,/, '')), (c) => c.charCodeAt(0));
      const f = new FormData();
      f.append('photo', JSON.stringify({ type: 'static', photo: 'attach://logo' }));
      f.append('logo', new Blob([brut], { type: 'image/jpeg' }), 'logo.jpg');
      const p = await api(jeton, 'setMyProfilePhoto', f);
      if (!p.ok) avertissements.push(`logo : ${p.description} — vous pouvez aussi le poser avec @BotFather › /setuserpic`);
    } catch {
      avertissements.push('logo illisible');
    }
  }
  const secret = aleatoire();
  const w = await api(jeton, 'setWebhook', {
    url: `${url}/functions/v1/telegram`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true,
  });
  if (!w.ok) return reponse({ ok: false, message: `Webhook refusé : ${w.description}` });
  const { error } = await service.rpc('telegram_robot_enregistrer', {
    p_jeton: jeton, p_nom_utilisateur: robot, p_nom: nom, p_secret: secret, p_par: u.user.id,
  });
  if (error) return reponse({ ok: false, message: 'Enregistrement impossible, réessayez.' }, 500);
  return reponse({ ok: true, robot: `@${robot}`, nom, avertissements });
});

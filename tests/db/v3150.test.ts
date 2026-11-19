import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase, type Execution } from './helpers';

// 3.15 : code de connexion par Telegram après le mot de passe.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const S = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const enSession = <R>(uid: string, session: string, fn: (q: Execution) => Promise<R>) =>
  enTantQue(pool, uid, async (q) => {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', session_id: session })]);
    return fn(q);
  });
const visibles = (q: Execution) => un(q<{ n: string }>(`select count(*) n from produits`)).then((x) => Number(x.n));
const rpc = <T>(q: Execution, sql: string, p: unknown[]) => un(q<{ r: T }>(`select ${sql} r`, p)).then((x) => x.r);

beforeAll(async () => {
  pool = await preparerBase('v3150');
  alice = await creerCompte(pool, 'alice@v315.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v315.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    await q(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500)`, [org]);
    await q(`select public.inviter_membre($1, 'carine@v315.ci', 'caissier', false, $2)`, [org, [mag]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Code de connexion Telegram', () => {
  it('sans le code, la session reste fermée ; le bon code l’ouvre ; chaque nouvelle connexion redemande un code', async () => {
    await expect(enSession(carine, S(1), (q) => q(`select public.otp_configurer($1, $2, '@carine_k')`, [org, carine]))).rejects.toThrow(/gérante principale/);
    await enSession(alice, S(9), (q) => q(`select public.otp_configurer($1, $2, '@carine_k')`, [org, carine]));
    expect(await enSession(carine, S(1), visibles)).toBe(0);
    expect((await enSession(carine, S(1), (q) => rpc<{ statut: string }>(q, 'public.otp_envoyer($1)', [org]))).statut).toBe('envoye');
    await expect(enSession(carine, S(1), (q) => q(`select public.otp_envoyer($1)`, [org]))).rejects.toThrow(/30 secondes/);
    // Le code n'est gardé qu'en empreinte : on en impose un connu pour le test.
    await pool.query(`update prive.otp_codes set code_hash = prive.hash_jeton($1 || ':123456') where session_id = $1`, [S(1)]);
    expect((await enSession(carine, S(1), (q) => rpc<{ statut: string }>(q, 'public.otp_verifier($1, $2)', [org, '111111']))).statut).toBe('faux');
    expect((await enSession(carine, S(1), (q) => rpc<{ statut: string }>(q, 'public.otp_verifier($1, $2)', [org, '123 456']))).statut).toBe('verifie');
    expect(await enSession(carine, S(1), visibles)).toBe(1);
    expect(await enSession(carine, S(2), visibles)).toBe(0);
  });

  it('secours : la gérante autorise une connexion en attente ; tout est au journal', async () => {
    await pool.query(`update prive.otp_codes set envoye_le = envoye_le - interval '1 minute'`);
    await enSession(carine, S(2), (q) => q(`select public.otp_envoyer($1)`, [org]));
    const liste = await enSession(alice, S(9), (q) => rpc<{ connexions_en_attente: { id: string }[] }>(q, 'public.commandes_caisse_attente($1)', [org]));
    expect(liste.connexions_en_attente).toHaveLength(1);
    await enSession(alice, S(9), (q) => q(`select public.otp_autoriser($1)`, [liste.connexions_en_attente[0]!.id]));
    expect(await enSession(carine, S(2), visibles)).toBe(1);
    const actions = (await pool.query(`select action from journal_audit where action like 'otp.%' order by id`)).rows.map((r) => r.action);
    expect(actions).toEqual(['otp.configure', 'otp.envoye', 'otp.echec', 'otp.verifie', 'otp.envoye', 'otp.autorise_par_gerante']);
    // Retirer le Telegram supprime l'exigence.
    await enSession(alice, S(9), (q) => q(`select public.otp_configurer($1, $2, null)`, [org, carine]));
    expect(await enSession(carine, S(3), visibles)).toBe(1);
  });
});

describe('Robot Telegram DF Gestion', () => {
  it('lien d’activation : le code n’est exigé qu’une fois le Telegram relié ; 4 h sans activité referment la session', async () => {
    await pool.query(`select public.telegram_robot_enregistrer('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234', 'dfgestion_test_bot', 'DF Gestion', 'secret', $1)`, [alice]);
    const lien = await enSession(alice, S(9), (q) => rpc<{ lien: string }>(q, 'public.otp_lien($1, $2)', [org, carine]));
    expect(lien.lien).toMatch(/^https:\/\/t\.me\/dfgestion_test_bot\?start=[a-f0-9]{32}$/);
    expect(await enSession(carine, S(10), visibles)).toBe(1); // pas encore relié : rien n'est exigé
    const code = lien.lien.split('start=')[1]!;
    const r = (await pool.query(`select public.telegram_relier($1, 4242, '@carine_k') r`, [code])).rows[0].r as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(((await pool.query(`select public.telegram_relier($1, 1, 'x') r`, [code])).rows[0].r as { ok: boolean }).ok).toBe(false);
    expect(await enSession(carine, S(11), visibles)).toBe(0);
    await pool.query(`update prive.otp_codes set envoye_le = envoye_le - interval '20 minutes'`);
    expect((await enSession(carine, S(11), (q) => rpc<{ statut: string }>(q, 'public.otp_envoyer($1)', [org]))).statut).toBe('envoye');
    await pool.query(`update prive.otp_codes set code_hash = prive.hash_jeton($1 || ':654321') where session_id = $1`, [S(11)]);
    await enSession(carine, S(11), (q) => q(`select public.otp_verifier($1, '654321')`, [org]));
    expect(await enSession(carine, S(11), visibles)).toBe(1);
    await pool.query(`update prive.sessions_otp set vu_le = now() - interval '5 hours' where session_id = $1`, [S(11)]);
    expect(await enSession(carine, S(11), visibles)).toBe(0);
  });
});

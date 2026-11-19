import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase, type Execution } from './helpers';

// 3.18 : OTP après 4 h d'inactivité, OTP du gérant réservé à l'administrateur, changement tous les 30 jours.
let pool: pg.Pool;
let admin: string;
let alice: string; // gérante principale
let carine: string; // caissière
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const S = (n: number) => `00000000-0000-4000-9180-${String(n).padStart(12, '0')}`;
const enSession = <R>(uid: string, session: string, fn: (q: Execution) => Promise<R>) =>
  enTantQue(pool, uid, async (q) => {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', session_id: session })]);
    return fn(q);
  });
const rpc = <T>(q: Execution, sql: string, p: unknown[] = []) => un(q<{ r: T }>(`select ${sql} r`, p)).then((x) => x.r);

beforeAll(async () => {
  pool = await preparerBase('v3180');
  admin = await creerCompte(pool, 'admin@v318.ci', 'Bérenger');
  alice = await creerCompte(pool, 'alice@v318.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v318.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    await q(`select public.inviter_membre($1, 'carine@v318.ci', 'caissier', false, $2)`, [org, [mag]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Code OTP : qui le gère', () => {
  it('la gérante gère celui des employés, l’administrateur celui du gérant principal', async () => {
    const liste = await enSession(alice, S(1), (q) => rpc<Record<string, { email: string }>>(q, `public.otp_configurer($1, $2, '@carine_k')`, [org, carine]));
    expect(liste[carine]!.email).toBe('carine@v318.ci');
    await expect(enSession(alice, S(1), (q) => q(`select public.otp_configurer($1, $2, '@alice_k')`, [org, alice]))).rejects.toThrow(/administrateur général/);
    const parAdmin = await enSession(admin, S(2), (q) => rpc<Record<string, unknown>>(q, `public.otp_configurer($1, null, '@alice_k', true, 'alice@v318.ci')`, [org]));
    expect(Object.keys(parAdmin)).toContain(alice);
  });

  it('après 4 heures sans activité, la connexion est expirée', async () => {
    await pool.query(`insert into prive.sessions_otp (session_id, organisation_id, user_id, via, vu_le) values ($1, $2, $3, 'telegram', now() - interval '3 hours')`, [S(3), org, carine]);
    expect(await enSession(carine, S(3), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: true });
    await pool.query(`update prive.sessions_otp set vu_le = now() - interval '5 hours' where session_id = $1`, [S(3)]);
    expect(await enSession(carine, S(3), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: false, expiree: true });
  });
});

describe('Changement tous les 30 jours', () => {
  it('mot de passe : expiré après 30 jours, à jour dès qu’il est changé', async () => {
    expect(await enTantQue(pool, admin, (q) => rpc<{ expire: boolean }>(q, 'public.mon_mot_de_passe()'))).toMatchObject({ expire: false });
    await pool.query(`update prive.mots_de_passe set change_le = now() - interval '31 days' where user_id = $1`, [admin]);
    expect(await enTantQue(pool, admin, (q) => rpc<{ expire: boolean }>(q, 'public.mon_mot_de_passe()'))).toMatchObject({ expire: true });
    await pool.query(`update auth.users set encrypted_password = 'autre' where id = $1`, [admin]);
    expect(await enTantQue(pool, admin, (q) => rpc<{ expire: boolean }>(q, 'public.mon_mot_de_passe()'))).toMatchObject({ expire: false });
  });

  it('code d’entrée : provisoire après 30 jours, et le nouveau doit être différent', async () => {
    await pool.query(`select prive.enregistrer_pin($1, '2580', false)`, [carine]);
    await pool.query(`update prive.pins_acces set defini_le = now() - interval '31 days' where user_id = $1`, [carine]);
    expect((await pool.query(`select prive.controler_pin($1, '2580') r`, [carine])).rows[0].r).toMatchObject({ ok: true, provisoire: true });
    expect(await enTantQue(pool, carine, (q) => rpc(q, 'public.mon_pin()'))).toMatchObject({ provisoire: true, expire: true });
    await expect(enTantQue(pool, carine, (q) => q(`select public.changer_mon_pin('2580')`))).rejects.toThrow(/différent/);
    await enTantQue(pool, carine, (q) => q(`select public.changer_mon_pin('3691')`));
    expect(await enTantQue(pool, carine, (q) => rpc(q, 'public.mon_pin()'))).toMatchObject({ provisoire: false, expire: false });
  });
});

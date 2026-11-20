import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase, type Execution } from './helpers';

// 3.20 : même appareil + moins de 4 h → pas de nouveau code OTP ; renvoi du code au bout de 2 minutes.
let pool: pg.Pool;
let alice: string;
let carine: string;
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const S = (n: number) => `00000000-0000-4000-9200-${String(n).padStart(12, '0')}`;
const enSession = <R>(uid: string, session: string, fn: (q: Execution) => Promise<R>) =>
  enTantQue(pool, uid, async (q) => {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', session_id: session })]);
    return fn(q);
  });
const rpc = <T>(q: Execution, sql: string, p: unknown[] = []) => un(q<{ r: T }>(`select ${sql} r`, p)).then((x) => x.r);
const J1 = 'a'.repeat(40);
const J2 = 'b'.repeat(40);

beforeAll(async () => {
  pool = await preparerBase('v3200');
  alice = await creerCompte(pool, 'alice@v320.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v320.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    await q(`select public.inviter_membre($1, 'carine@v320.ci', 'caissier', false, $2)`, [org, [mag]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enSession(alice, S(1), (q) => q(`select public.otp_configurer($1, $2, '@carine_k')`, [org, carine]));
});
afterAll(async () => {
  await pool?.end();
});

describe('Code OTP sur le même appareil', () => {
  it('se reconnecter sur le même appareil dans les 4 h ne redemande pas de code', async () => {
    await enSession(carine, S(10), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, J1]));
    expect(await enSession(carine, S(10), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: false });
    expect(await enSession(carine, S(10), (q) => rpc<{ statut: string }>(q, 'public.otp_envoyer($1)', [org]))).toMatchObject({ statut: 'envoye' });
    await expect(enSession(carine, S(10), (q) => q(`select public.otp_envoyer($1)`, [org]))).rejects.toThrow(/2 minutes/);
    await pool.query(`insert into prive.sessions_otp (session_id, organisation_id, user_id, via) values ($1, $2, $3, 'telegram')`, [S(10), org, carine]);

    await enSession(carine, S(11), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, J1]));
    expect(await enSession(carine, S(11), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: true });

    await enSession(carine, S(12), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, J2]));
    expect(await enSession(carine, S(12), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: false });

    await pool.query(`update prive.sessions_otp set vu_le = now() - interval '5 hours' where user_id = $1`, [carine]);
    await enSession(carine, S(13), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, J1]));
    expect(await enSession(carine, S(13), (q) => rpc<{ verifie: boolean }>(q, 'public.otp_etat($1)', [org]))).toMatchObject({ verifie: false });
  });

  it('mon_telegram décrit la liaison de la personne', async () => {
    const t = await enTantQue(pool, carine, (q) => rpc<{ relie: boolean; gerant: boolean }>(q, 'public.mon_telegram($1)', [org]));
    expect(t).toMatchObject({ relie: false, gerant: false });
  });
});

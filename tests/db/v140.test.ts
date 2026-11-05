import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.4 : « Ouvrir une caisse » ne propose que les caisses que la personne peut ouvrir.
let pool: pg.Pool;
let alice: string;
let akissi: string;
let org: string;
let caisse: string;
let magasin: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
type Etat = { peut_ouvrir: boolean; caisses: { id: string; accessible: boolean; raison: string | null; session: { mienne: boolean; par: string } | null }[] };
const etat = (uid: string) => enTantQue(pool, uid, (q) => un(q<{ r: Etat }>(`select public.mes_caisses($1) r`, [org]))).then((x) => x.r);

beforeAll(async () => {
  pool = await preparerBase('v140');
  alice = await creerCompte(pool, 'alice@k.ci', 'Alice');
  akissi = await creerCompte(pool, 'akissi@k.ci', 'Akissi');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique K') id`)))).id;
  magasin = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org])))).id;
  caisse = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from caisses where organisation_id = $1`, [org])))).id;
});

afterAll(async () => {
  await pool?.end();
});

describe('mes_caisses', () => {
  it('le propriétaire voit sa caisse libre, puis ouverte par lui', async () => {
    expect((await etat(alice)).caisses).toMatchObject([{ id: caisse, accessible: true, session: null }]);
    await enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0)`, [org, caisse]));
    expect((await etat(alice)).caisses[0]!.session).toMatchObject({ mienne: true, par: 'Alice' });
  });

  it('une caissière sans magasin ni caisse ne voit rien à ouvrir', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.inviter_membre($1, 'akissi@k.ci', 'caissier', false, '{}', '{}')`, [org]));
    await enTantQue(pool, akissi, (q) => q(`select public.accepter_invitations()`));
    const e = await etat(akissi);
    expect(e.peut_ouvrir).toBe(true);
    expect(e.caisses.filter((c) => c.accessible)).toEqual([]);
  });

  it('une fois sa caisse attribuée, elle la voit, ouverte par un collègue', async () => {
    const m = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from membres where user_id = $1`, [akissi])));
    await enTantQue(pool, alice, (q) => q(`select public.modifier_membre($1, 'caissier', false, $2, $3)`, [m.id, [magasin], [caisse]]));
    const c = (await etat(akissi)).caisses.find((x) => x.id === caisse)!;
    expect(c.accessible).toBe(true);
    expect(c.session).toMatchObject({ mienne: false, par: 'Alice' });
  });
});

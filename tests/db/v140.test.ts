import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.4 / 1.6 : l'écran des caisses ne propose que ce que la personne peut faire.
let pool: pg.Pool;
let alice: string;
let akissi: string;
let org: string;
let caisse: string;
let magasin: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
type Etat = {
  peut_ouvrir: boolean;
  peut_vendre: boolean;
  caisses: { id: string; accessible: boolean; raison: string | null; session: { mienne: boolean; par: string } | null; caissiers: { nom: string }[] }[];
};
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
  it('le gérant principal voit les caisses, peut les ouvrir, mais ne peut pas en tenir une', async () => {
    const e = await etat(alice);
    expect(e).toMatchObject({ peut_ouvrir: true, peut_vendre: false });
    expect(e.caisses).toMatchObject([{ id: caisse, accessible: false, session: null, caissiers: [] }]);
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0)`, [org, caisse]))).rejects.toThrow(/gérant principal ne tient pas/);
  });

  it('une caissière sans magasin ni caisse ne voit rien à ouvrir', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.inviter_membre($1, 'akissi@k.ci', 'caissier', false, '{}', '{}')`, [org]));
    await enTantQue(pool, akissi, (q) => q(`select public.accepter_invitations()`));
    const e = await etat(akissi);
    expect(e).toMatchObject({ peut_ouvrir: false, peut_vendre: true });
    expect(e.caisses.filter((c) => c.accessible)).toEqual([]);
  });

  it('une fois sa caisse attribuée et ouverte pour elle par le gérant, elle y entre', async () => {
    const m = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from membres where user_id = $1`, [akissi])));
    await enTantQue(pool, alice, (q) => q(`select public.modifier_membre($1, 'caissier', false, $2, $3)`, [m.id, [magasin], [caisse]]));
    expect((await etat(alice)).caisses[0]!.caissiers.map((c) => c.nom)).toEqual(['Akissi']);
    await enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse, akissi]));
    const c = (await etat(akissi)).caisses.find((x) => x.id === caisse)!;
    expect(c.accessible).toBe(true);
    expect(c.session).toMatchObject({ mienne: true, par: 'Akissi' });
  });
});

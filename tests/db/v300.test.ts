import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.0 : magasins indépendants (comptes et dépenses rattachés) et vue d'ensemble.
let pool: pg.Pool;
let alice: string;
let bintou: string;
let org: string;
let mag1: string;
let mag2: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
interface Ligne { id: string; nom: string; charges: number; ventes_mois: number; resultat: number }
interface Vue { magasins: Ligne[]; charges_communes: number }

beforeAll(async () => {
  pool = await preparerBase('v300');
  alice = await creerCompte(pool, 'alice@m.ci', 'Alice');
  bintou = await creerCompte(pool, 'bintou@m.ci', 'Bintou');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Deux boutiques') id`)))).id;
  mag1 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org])))).id;
  mag2 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`insert into magasins (organisation_id, code, nom) values ($1, 'MAG02', 'Boutique Cocody') returning id`, [org])))).id;
  await enTantQue(pool, alice, (q) => q(`select public.inviter_membre($1, 'bintou@m.ci', 'caissier', false, $2, '{}')`, [org, [mag1]]));
  await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Magasins indépendants', () => {
  it('rattache un compte à un magasin : ses dépenses le suivent, les autres restent communes', async () => {
    const vue = await enTantQue(pool, alice, async (q) => {
      const comptes = await q<{ id: string; nom: string; caisse_id: string | null }>(`select id, nom, caisse_id from comptes_tresorerie where organisation_id = $1`, [org]);
      const libres = comptes.filter((c) => !c.caisse_id);
      expect(libres.length).toBeGreaterThanOrEqual(2);
      const poste = (await un(q<{ id: string }>(`select id from postes_budget where organisation_id = $1 limit 1`, [org]))).id;
      await q(`select public.rattacher_compte($1, $2)`, [libres[0]!.id, mag2]);
      await q(`select public.enregistrer_depense($1, current_date, $2, $3, 40000, 'Loyer Cocody')`, [org, poste, libres[0]!.id]);
      await q(`select public.enregistrer_depense($1, current_date, $2, $3, 15000, 'Expert-comptable')`, [org, poste, libres[1]!.id]);
      return (await un(q<{ r: Vue }>(`select public.vue_ensemble($1) r`, [org]))).r;
    });
    expect(vue.magasins).toHaveLength(2);
    const cocody = vue.magasins.find((m) => m.id === mag2)!;
    expect(Number(cocody.charges)).toBe(40000);
    expect(Number(cocody.resultat)).toBe(-40000);
    expect(Number(vue.magasins.find((m) => m.id === mag1)!.charges)).toBe(0);
    expect(Number(vue.charges_communes)).toBe(15000);
  });

  it('corrige le magasin d’une dépense', async () => {
    const vue = await enTantQue(pool, alice, async (q) => {
      const d = await un(q<{ id: string }>(`select id from depenses where organisation_id = $1 and libelle = 'Expert-comptable'`, [org]));
      await q(`select public.rattacher_depense($1, $2)`, [d.id, mag1]);
      return (await un(q<{ r: Vue }>(`select public.vue_ensemble($1) r`, [org]))).r;
    });
    expect(Number(vue.magasins.find((m) => m.id === mag1)!.charges)).toBe(15000);
    expect(Number(vue.charges_communes)).toBe(0);
  });

  it('refuse la vue d’ensemble et le rattachement à un caissier', async () => {
    await expect(enTantQue(pool, bintou, (q) => q(`select public.vue_ensemble($1)`, [org]))).rejects.toThrow(/rentabilite/);
    const c = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from comptes_tresorerie where organisation_id = $1 and caisse_id is null limit 1`, [org])));
    await expect(enTantQue(pool, bintou, (q) => q(`select public.rattacher_compte($1, $2)`, [c.id, mag1]))).rejects.toThrow(/tresorerie/);
  });
});

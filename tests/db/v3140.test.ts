import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase, type Execution } from './helpers';

// 3.14 : appareils approuvés, clés d'accès personnelles, suivi exact des commandes en ligne.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let robert: string; // responsable de caisse (pas gérante principale)
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const JA = 'jeton-alice-pc-000000000000000000000000000001';
const JC = 'jeton-carine-tel-0000000000000000000000000001';
const JC2 = 'jeton-carine-autre-00000000000000000000000002';

/** Comme enTantQue, avec un numéro de session (celui que Supabase met dans le jeton). */
const enSession = <R>(uid: string, session: string, fn: (q: Execution) => Promise<R>) =>
  enTantQue(pool, uid, async (q) => {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated', session_id: session })]);
    return fn(q);
  });
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const produitsVisibles = (q: Execution) => un(q<{ n: string }>(`select count(*) n from produits`)).then((x) => Number(x.n));

beforeAll(async () => {
  pool = await preparerBase('v3140');
  alice = await creerCompte(pool, 'alice@v314.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v314.ci', 'Carine');
  robert = await creerCompte(pool, 'robert@v314.ci', 'Robert');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    const caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    await q(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500)`, [org]);
    await q(`select public.inviter_membre($1, 'carine@v314.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    await q(`select public.inviter_membre($1, 'robert@v314.ci', 'responsable_caisse', false, $2)`, [org, [mag]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, robert, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Appareils approuvés et clés d’accès', () => {
  it('un appareil inconnu ne voit rien tant que la gérante ne l’a pas approuvé', async () => {
    await enSession(alice, S(1), async (q) => {
      const r = (await un(q<{ r: { statut: string } }>(`select public.appareil_ouvrir($1, $2, 'Windows · Chrome') r`, [org, JA]))).r;
      expect(r.statut).toBe('approuve');
    });
    // Exigence activée depuis l'appareil approuvé de la gérante.
    await enSession(alice, S(1), (q) => q(`select public.appareils_exiger($1, true)`, [org]));
    // Pas depuis une session non approuvée.
    await expect(enSession(alice, S(9), (q) => q(`select public.appareils_exiger($1, true)`, [org]))).rejects.toThrow(/gérante principale|Ouvrez/);

    await enSession(carine, S(2), async (q) => {
      const r = (await un(q<{ r: { statut: string } }>(`select public.appareil_ouvrir($1, $2, 'Android') r`, [org, JC]))).r;
      expect(r.statut).toBe('en_attente');
      expect(await produitsVisibles(q)).toBe(0);
    });
    const id = await enSession(alice, S(1), async (q) => {
      const l = (await un(q<{ r: { appareils: { id: string; statut: string; libelle: string }[] } }>(`select public.appareils_liste($1) r`, [org]))).r;
      const a = l.appareils.find((x) => x.libelle === 'Android')!;
      expect(a.statut).toBe('en_attente');
      await q(`select public.appareil_decider($1, 'approuve')`, [a.id]);
      return a.id;
    });
    await expect(enSession(robert, S(5), (q) => q(`select public.appareil_decider($1, 'revoque')`, [id]))).rejects.toThrow(/gérante principale/);
    await enSession(carine, S(2), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, JC]));
    expect(await enSession(carine, S(2), produitsVisibles)).toBe(1);
    // Nouvelle connexion sur le même appareil : reconnue sans rien demander.
    await enSession(carine, S(3), (q) => q(`select public.appareil_ouvrir($1, $2)`, [org, JC]));
    expect(await enSession(carine, S(3), produitsVisibles)).toBe(1);
  });

  it('une clé personnelle ouvre un nouvel appareil une seule fois ; la révocation referme', async () => {
    const cle = await enSession(alice, S(1), async (q) =>
      (await un(q<{ r: { cle: string } }>(`select public.cle_acces_creer($1, null, null, $2, 7) r`, [org, carine]))).r.cle,
    );
    expect(cle).toMatch(/^DFG-[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    // Destinée à Carine : inutilisable par Robert.
    const rb = await enSession(robert, S(6), (q) => un(q<{ r: { statut: string } }>(`select public.appareil_debloquer($1, $2, $3) r`, [org, 'jeton-robert-000000000000000000000000000000001', cle])));
    expect(rb.r.statut).toBe('cle_invalide');
    await enSession(carine, S(4), (q) => q(`select public.appareil_ouvrir($1, $2, 'Windows · Edge')`, [org, JC2]));
    expect(await enSession(carine, S(4), produitsVisibles)).toBe(0);
    const ok = await enSession(carine, S(4), (q) => un(q<{ r: { statut: string } }>(`select public.appareil_debloquer($1, $2, $3) r`, [org, JC2, cle.toLowerCase()])));
    expect(ok.r.statut).toBe('approuve');
    expect(await enSession(carine, S(4), produitsVisibles)).toBe(1);
    const encore = await enSession(carine, S(4), (q) => un(q<{ r: { statut: string } }>(`select public.appareil_debloquer($1, $2, $3) r`, [org, JC2, cle])));
    expect(encore.r.statut).toBe('cle_invalide');

    await enSession(alice, S(1), async (q) => {
      const l = (await un(q<{ r: { appareils: { id: string; libelle: string; courant: boolean }[] } }>(`select public.appareils_liste($1) r`, [org]))).r;
      const edge = l.appareils.find((x) => x.libelle === 'Windows · Edge')!;
      await q(`select public.appareil_decider($1, 'revoque')`, [edge.id]);
      const moi = l.appareils.find((x) => x.courant)!;
      await q('savepoint a');
      await expect(q(`select public.appareil_decider($1, 'revoque')`, [moi.id])).rejects.toThrow(/en ce moment/);
      await q('rollback to savepoint a');
    });
    expect(await enSession(carine, S(4), produitsVisibles)).toBe(0);
    const actions = (await pool.query(`select action from journal_audit where action like 'appareil.%' or action like 'cle_acces.%' order by id`)).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['appareil.demande', 'appareil.approuve', 'appareil.approuve_par_cle', 'cle_acces.refusee', 'appareil.revoque', 'appareil.exigence_activee']));
  });

  it('création de compte : une clé valide pour cette adresse est exigée', async () => {
    await pool.query(`insert into prive.admins_generaux (user_id) values ($1) on conflict do nothing`, [alice]);
    const cle = await enSession(alice, S(1), async (q) =>
      (await un(q<{ r: { cle: string } }>(`select public.cle_acces_creer($1, 'Fatou', 'fatou@v314.ci', null, 3) r`, [org]))).r.cle,
    );
    const v = async (c: string, e: string) => (await pool.query(`select public.cle_inscription_verifier($1, $2) r`, [c, e])).rows[0].r as { ok: boolean };
    expect((await v('', 'fatou@v314.ci')).ok).toBe(false);
    expect((await v(cle, 'autre@v314.ci')).ok).toBe(false);
    expect((await v(cle, 'Fatou@v314.ci')).ok).toBe(true);
  });
});

describe('Suivi exact des commandes en ligne', () => {
  it('seule la gérante principale reçoit le fil des activités', async () => {
    await enSession(alice, S(1), async (q) => {
      const r = (await un(q<{ r: { dernier: number } }>(`select public.activites_commandes($1) r`, [org]))).r;
      expect(Number(r.dernier)).toBeGreaterThanOrEqual(0);
    });
    await expect(enSession(robert, S(6), (q) => q(`select public.activites_commandes($1, 0)`, [org]))).rejects.toThrow(/gérante principale/);
  });
});

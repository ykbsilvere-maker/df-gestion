import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.19 : affectation aux seuls caissiers, « en caisse » d'une caisse ouverte par la gérante, Telegram sans code OTP.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let awa: string; // cliente du site
let org: string;
let mag: string;
let caisse: string;
let riz: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;


beforeAll(async () => {
  pool = await preparerBase('v3190');
  alice = await creerCompte(pool, 'alice@v319.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v319.ci', 'Carine');
  awa = await creerCompte(pool, 'awa@client319.ci', '');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@v319.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, alice, async (q) => {
    await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({
      slug: 'chez-alice-319', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false,
      paiement_livraison: true,
    })]);
    await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
    await q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse, carine]);
  });
});
afterAll(async () => {
  await pool?.end();
});

const commander = (nom: string) =>
  enTantQue(pool, awa, (q) => un(q<{ r: { id: string } }>(`select public.passer_commande($1) r`, [JSON.stringify({
    boutique: 'chez-alice-319', client_nom: nom, client_telephone: '0505050505', mode: 'retrait', paiement: 'livraison',
    lignes: [{ produit_id: riz, quantite: 1 }],
  })]))).then((x) => x.r.id);


describe('Affectation des commandes en ligne', () => {
  it('seuls les caissiers sont proposés ; la caisse ouverte par la gérante compte comme la leur', async () => {
    const c = await commander('Awa');
    await enTantQue(pool, alice, async (q) => {
      const liste = (await un(q<{ r: { user_id: string; en_caisse: boolean }[] }>(`select public.caissiers_commande($1, $2) r`, [org, mag]))).r;
      expect(liste.map((x) => x.user_id)).toEqual([carine]);
      expect(liste[0]!.en_caisse).toBe(true);
      await q('savepoint a');
      await expect(q(`select public.affecter_commande_web($1, $2)`, [c, alice])).rejects.toThrow(/seulement aux caissiers/);
      await q('rollback to savepoint a');
      await q(`select public.affecter_commande_web($1, $2)`, [c, carine]);
    });
  });
});

describe('Telegram sans code OTP', () => {
  it('relié pour les notifications seulement : aucun code OTP demandé', async () => {
    await pool.query(`insert into prive.otp_membres (organisation_id, user_id, actif, otp, chat_id) values ($1, $2, true, false, 42)`, [org, carine]);
    const exige = await pool.query(`select prive.otp_exige($1, $2) r`, [org, carine]);
    expect(exige.rows[0].r).toBe(false);
    const liste = await enTantQue(pool, alice, (q) => un(q<{ r: Record<string, { otp: boolean; notifications: boolean; actif: boolean }> }>(`select public.otp_liste($1) r`, [org])));
    expect(liste.r[carine]).toMatchObject({ otp: false, notifications: true, actif: false });
    await enTantQue(pool, alice, (q) => q(`select public.otp_basculer($1, $2, true)`, [org, carine]));
    expect((await pool.query(`select prive.otp_exige($1, $2) r`, [org, carine])).rows[0].r).toBe(true);
  });
});

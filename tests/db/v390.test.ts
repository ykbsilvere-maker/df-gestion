import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase } from './helpers';

// 3.9 : affectation des commandes en ligne, clients du site, code promo / QR en caisse,
// moyens de paiement désactivables, comptabilité reliée (pertes, remises).
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let awa: string; // cliente du site
let org: string;
let mag: string;
let caisse: string;
let riz: string;
let especes: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

beforeAll(async () => {
  pool = await preparerBase('v390');
  alice = await creerCompte(pool, 'alice@v39.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v39.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@v39.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  awa = await creerCompte(pool, 'awa@client39.ci', '');
  await enTantQue(pool, alice, async (q) => {
    await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({
      slug: 'chez-alice', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false,
      paiement_livraison: true, numero_wave: '07 57 65 70 55',
    })]);
    await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
  });
  await enTantQue(pool, awa, (q) => q(`select public.compte_marche_enregistrer($1)`, [JSON.stringify({ nom: 'Awa Koné', photo_path: `${awa}/profil.jpg` })]));
});
afterAll(async () => {
  await pool?.end();
});

describe('Commandes en ligne affectées à une caissière', () => {
  it('la caissière ne peut rien faire tant que la gérante ne lui a pas affecté la commande', async () => {
    const c = await enTantQue(pool, awa, (q) => un(q<{ r: { id: string } }>(`select public.passer_commande($1) r`, [JSON.stringify({
      boutique: 'chez-alice', client_nom: 'Awa', client_telephone: '0505050505', mode: 'retrait', paiement: 'livraison',
      lignes: [{ produit_id: riz, quantite: 1 }],
    })]))).then((x) => x.r);

    await enTantQue(pool, alice, async (q) => {
      const a = (await un(q<{ r: { nombre: number; a_affecter: number } }>(`select public.commandes_caisse_attente($1) r`, [org]))).r;
      expect(Number(a.a_affecter)).toBe(1);
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
      await devenir(q, carine);
      const b = (await un(q<{ r: { nombre: number; a_affecter: number } }>(`select public.commandes_caisse_attente($1) r`, [org]))).r;
      expect(Number(b.nombre)).toBe(0);
      expect(Number(b.a_affecter)).toBe(0);
      await q('savepoint a');
      await expect(q(`select public.encaisser_commande_web($1, $2)`, [c.id, s])).rejects.toThrow(/pas affectée/);
      await q('rollback to savepoint a');
      await expect(q(`select public.affecter_commande_web($1, $2)`, [c.id, carine])).rejects.toThrow(/gérante principale/);
      await q('rollback to savepoint a');
    });

    await enTantQue(pool, alice, async (q) => {
      const liste = (await un(q<{ r: { user_id: string; nom: string }[] }>(`select public.caissiers_commande($1, $2) r`, [org, mag]))).r;
      expect(liste.map((x) => x.user_id)).toContain(carine);
      const r = (await un(q<{ r: { statut: string; caissier_id: string } }>(`select public.affecter_commande_web($1, $2) r`, [c.id, carine]))).r;
      expect(r.statut).toBe('confirmee');
      expect(r.caissier_id).toBe(carine);
      const d = (await un(q<{ r: { caissier_nom: string } }>(`select public.commande_web_detail($1) r`, [c.id]))).r;
      expect(d.caissier_nom).toBe('Carine');
    });

    await enTantQue(pool, carine, async (q) => {
      const b = (await un(q<{ r: { nombre: number } }>(`select public.commandes_caisse_attente($1) r`, [org]))).r;
      expect(Number(b.nombre)).toBe(1);
      const l = (await un(q<{ r: { commandes: { id: string; a_moi: boolean }[] } }>(`select public.commandes_caisse($1) r`, [org]))).r;
      expect(l.commandes).toHaveLength(1);
      expect(l.commandes[0]!.a_moi).toBe(true);
      await q(`select public.avancer_commande_web($1, 'prete')`, [c.id]);
      const s = (await un(q<{ id: string }>(`select id from sessions_caisse where organisation_id = $1 and statut = 'ouverte'`, [org]))).id;
      const v = (await un(q<{ r: { total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [c.id, s]))).r;
      expect(Number(v.total)).toBe(4500);
    });
  });
});

describe('Clients du site', () => {
  it('la boutique voit tous les comptes, leur photo et leurs commandes, et leur réserve un code', async () => {
    await enTantQue(pool, alice, async (q) => {
      const l = (await un(q<{ r: { id: string; email: string; photo_path: string; commandes: number }[] }>(`select public.clients_marche_liste($1, null) r`, [org]))).r;
      const a = l.find((x) => x.id === awa)!;
      expect(a.email).toBe('awa@client39.ci');
      expect(a.photo_path).toBe(`${awa}/profil.jpg`);
      const k = (await un(q<{ r: { compte_id: string } }>(`select public.code_promo_enregistrer($1, $2) r`, [org,
        JSON.stringify({ code: 'AWA-FIDELE', type: 'pourcent', valeur: 10, compte_id: awa })]))).r;
      expect(k.compte_id).toBe(awa);
      const d = (await un(q<{ r: { codes: unknown[]; slug: string } }>(`select public.client_marche_detail($1, $2) r`, [org, awa]))).r;
      expect(d.codes).toHaveLength(1);
      expect(d.slug).toBe('chez-alice');
    });
    // Une photo ne peut pas pointer vers le dossier d'un autre client.
    await expect(enTantQue(pool, awa, (q) => q(`select public.compte_marche_enregistrer($1)`, [JSON.stringify({ nom: 'Awa', photo_path: `${carine}/x.jpg` })])))
      .rejects.toThrow(/Photo invalide/);
  });
});

describe('Code promo / QR en caisse', () => {
  const vente = (session: string, remise: number, code?: string) => JSON.stringify({
    id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
    code_promo: code, lignes: [{ produit_id: riz, quantite: 2, prix_unitaire: 4500, remise }],
    reglements: [{ moyen_id: especes, montant: 9000 - remise }],
  });

  it('le QR (lien de l’offre) donne la remise sans droit de remise ; au-delà, refus', async () => {
    await enTantQue(pool, carine, async (q) => {
      const s = (await un(q<{ id: string }>(`select id from sessions_caisse where organisation_id = $1 and statut = 'ouverte'`, [org]))).id;
      const k = (await un(q<{ r: { code: string; valeur: number; client: string } }>(`select public.code_promo_caisse_verifier($1, $2) r`,
        [org, 'https://dfmarche.netlify.app/offre/chez-alice/awa-fidele']))).r;
      expect(k.code).toBe('AWA-FIDELE');
      expect(k.client).toBe('Awa Koné');
      await q('savepoint a');
      await expect(q(`select public.enregistrer_vente($1::jsonb)`, [vente(s, 900)])).rejects.toThrow(/remise|Remise|ventes.valider/);
      await q('rollback to savepoint a');
      await expect(q(`select public.enregistrer_vente($1::jsonb)`, [vente(s, 1000, 'AWA-FIDELE')])).rejects.toThrow(/900 FCFA au plus/);
      await q('rollback to savepoint a');
      const r = (await un(q<{ r: { id: string; total: number } }>(`select public.enregistrer_vente($1::jsonb) r`, [vente(s, 900, 'AWA-FIDELE')]))).r;
      expect(Number(r.total)).toBe(8100);
    });
    const k = await enTantQue(pool, alice, (q) => un(q<{ utilisations: number }>(`select utilisations from codes_promo where code = 'AWA-FIDELE'`)));
    expect(Number(k.utilisations)).toBe(1);
    const v = await enTantQue(pool, alice, (q) => un(q<{ n: number }>(`select count(*) n from ventes where code_promo = 'AWA-FIDELE'`)));
    expect(Number(v.n)).toBe(1);
  });
});

describe('Moyens de paiement et comptabilité reliée', () => {
  it('les numéros d’un moyen décoché sont gardés de côté', async () => {
    await enTantQue(pool, alice, async (q) => {
      await q(`select public.vitrine_paiements_inactifs($1, '{"numero_orange":"07 57 65 70 55"}')`, [org]);
      const v = (await un(q<{ r: { vitrine: { paiements_inactifs: { numero_orange: string } } } }>(`select public.vitrine_lire($1) r`, [org]))).r;
      expect(v.vitrine.paiements_inactifs.numero_orange).toBe('07 57 65 70 55');
    });
  });

  it('une casse passe en 6581 et les remises en 7019, sans changer le résultat', async () => {
    await enTantQue(pool, alice, async (q) => {
      await q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'casse', 1, 'Sac déchiré')`, [org, mag, riz]);
    });
    await enTantQue(pool, alice, async (q) => {
      const b = (await un(q<{ r: { compte: string; debit: number; credit: number }[] }>(
        `select public.balance_comptable($1, date_trunc('month', current_date)::date, current_date) r`, [org]))).r;
      const solde = (c: string) => { const x = b.find((y) => y.compte === c); return x ? Number(x.debit) - Number(x.credit) : 0; };
      expect(solde('6581')).toBe(3800);
      expect(solde('7019')).toBe(900);
      // 701 brut = 4500 (commande) + 9000 (vente au code)
      expect(solde('701')).toBe(-13500);
    });
  });
});

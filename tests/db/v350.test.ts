import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase, type Execution } from './helpers';

// 3.5 : DF Marché — vitrine, commandes en ligne (livraison / retrait, paiement à la livraison ou
// direct Mobile Money avec justificatif), encaissement à la caisse, avis vérifiés.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let org: string;
let mag: string;
let caisse: string;
let riz: string;
let huile: string;
let zone: string;
let commande: { id: string; numero: string; code_suivi: string; total: number };
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const anonyme = <R>(fn: (q: Execution) => Promise<R>) => enTantQue<R>(pool, null, fn);
const disponible = async (id: string) =>
  Number((await anonyme((q) => un(q<{ r: { disponible: number } }>(`select public.marche_produit($1) r`, [id])))).r.disponible);

const commandeType = (lignes: object[], extra: object = {}) =>
  JSON.stringify({
    boutique: 'riz-et-cie', client_nom: 'Awa Koné', client_telephone: '05 05 05 05 05', mode: 'livraison', zone_id: zone,
    adresse: 'Angré 8e tranche', repere: 'Pharmacie', paiement: 'wave', numero_payeur: '0505050505', lignes, ...extra,
  });

beforeAll(async () => {
  pool = await preparerBase('v350');
  alice = await creerCompte(pool, 'alice@marche.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@marche.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Riz & Cie') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    const p = async (d: string, prix: number) =>
      (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, $2, $3) returning id`, [org, d, prix]))).id;
    riz = await p('Riz 25 kg', 18000);
    huile = await p('Huile 5 L', 7500);
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values
      ($1, $2, $3, 8, 15000), ($1, $2, $4, 15, 6000)`, [org, r.id, riz, huile]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@marche.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('DF Marché', () => {
  it('la boutique crée sa vitrine, ses zones et publie ses produits', async () => {
    await enTantQue(pool, alice, async (q) => {
      const l = await un(q<{ r: { slug_propose: string } }>(`select public.vitrine_lire($1) r`, [org]));
      expect(l.r.slug_propose).toBe('riz-cie');
      const vitrine = { slug: 'riz-et-cie', nom: 'Riz & Cie', magasin_id: mag, publiee: true, telephone: '0700000000', whatsapp: '0700000001',
        numero_wave: '0700000002', commune: 'Cocody', activite: 'Supérette' };
      await q('savepoint a');
      await expect(q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify(vitrine)])).rejects.toThrow(/zone de livraison/);
      await q('rollback to savepoint a');
      zone = (await un(q<{ id: string }>(`select public.zone_livraison_enregistrer($1, '{"nom":"Cocody","frais":1000,"delai":"2 h"}') id`, [org]))).id;
      await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify(vitrine)]);
      expect((await un(q<{ n: number }>(`select public.publier_produits($1, $2, true) n`, [org, [riz, huile]]))).n).toBe(2);
      await q(`select public.creer_promotion($1, $2, 6500, current_date, current_date + 5, 'Solde', null)`, [org, huile]);
      await q(`select public.changer_statut_promotion(id, 'active') from promotions where produit_id = $1`, [huile]);
    });
    // La caissière ne règle pas la vitrine.
    await expect(enTantQue(pool, carine, (q) => q(`select public.publier_produits($1, $2, false)`, [org, [riz]]))).rejects.toThrow(/boutique.modifier/);
  });

  it('le site public montre boutiques, soldes et stock, sans rien exposer d’autre', async () => {
    await anonyme(async (q) => {
      const a = await un(q<{ r: { soldes: { prix: number; solde_fin: string }[]; boutiques: unknown[] } }>(`select public.marche_accueil() r`));
      expect(a.r.boutiques).toHaveLength(1);
      expect(a.r.soldes).toHaveLength(1);
      expect(Number(a.r.soldes[0]!.prix)).toBe(6500);
      expect(a.r.soldes[0]!.solde_fin).toBeTruthy();
      const r = await un(q<{ r: { total: number } }>(`select public.marche_produits('huile') r`));
      expect(Number(r.r.total)).toBe(1);
      const b = await un(q<{ r: { zones: unknown[]; numero_wave: string } }>(`select public.marche_boutique('riz-et-cie') r`));
      expect(b.r.zones).toHaveLength(1);
      expect(b.r.numero_wave).toBe('0700000002');
    });
    expect(await disponible(riz)).toBe(8);
    await expect(anonyme((q) => q(`select * from public.commandes_web`))).rejects.toThrow(/permission/);
    await expect(anonyme((q) => q(`select * from public.vitrines`))).rejects.toThrow(/permission/);
  });

  it('le client commande : prix soldé, frais de livraison, stock réservé', async () => {
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commandeType([{ produit_id: riz, quantite: 99 }])]))).rejects.toThrow(/ne reste que/);
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commandeType([{ produit_id: riz, quantite: 1 }], { paiement: 'orange_money' })])))
      .rejects.toThrow(/pas proposé/);
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commandeType([{ produit_id: riz, quantite: 1 }], { numero_payeur: '' })])))
      .rejects.toThrow(/numéro qui a effectué/);
    commande = (await anonyme((q) => un(q<{ r: typeof commande }>(`select public.passer_commande($1) r`, [
      commandeType([{ produit_id: riz, quantite: 2 }, { produit_id: huile, quantite: 3 }], { souhaite_le: new Date(Date.now() + 3 * 3600e3).toISOString() }),
    ])))).r;
    expect(Number(commande.total)).toBe(2 * 18000 + 3 * 6500 + 1000);
    expect(commande.code_suivi).toMatch(/^[0-9A-F]{8}$/);
    expect(await disponible(riz)).toBe(6);
    const s = await anonyme((q) => un(q<{ r: { statut: string; boutique: { numero_paiement: string } } }>(`select public.marche_suivi($1) r`, [commande.code_suivi])));
    expect(s.r.statut).toBe('nouvelle');
    expect(s.r.boutique.numero_paiement).toBe('0700000002');
    // Justificatif : le fichier doit exister dans l'espace « justificatifs », dans le dossier de la commande.
    await expect(anonyme((q) => q(`select public.joindre_justificatif($1, $2)`, [commande.code_suivi, `${commande.id}/x.jpg`]))).rejects.toThrow(/pas été reçu/);
    await pool.query(`insert into storage.objects (bucket_id, name) values ('justificatifs', $1)`, [`${commande.id}/capture.jpg`]);
    await expect(anonyme((q) => q(`select public.joindre_justificatif($1, $2)`, [commande.code_suivi, `autre/capture.jpg`]))).rejects.toThrow(/invalide/);
    await anonyme((q) => q(`select public.joindre_justificatif($1, $2)`, [commande.code_suivi, `${commande.id}/capture.jpg`]));
    await expect(anonyme((q) => q(`select public.deposer_avis($1, $2, 5, 'Top')`, [commande.code_suivi, riz]))).rejects.toThrow(/une fois la commande reçue/);
  });

  it('la boutique confirme, vérifie le paiement ; la caissière remet et encaisse', async () => {
    expect(Number((await enTantQue(pool, carine, (q) => un(q<{ r: { nouvelles: number } }>(`select public.commandes_web_a_traiter($1) r`, [org])))).r.nouvelles)).toBe(1);
    await expect(enTantQue(pool, carine, (q) => q(`select public.avancer_commande_web($1, 'confirmee')`, [commande.id]))).rejects.toThrow(/boutique.valider/);
    const avant = await enTantQue(pool, alice, async (q) => {
      await q(`select public.avancer_commande_web($1, 'confirmee')`, [commande.id]);
      await q(`select public.avancer_commande_web($1, 'prete')`, [commande.id]);
      await q('savepoint a');
      await expect(q(`select public.avancer_commande_web($1, 'en_livraison')`, [commande.id])).rejects.toThrow(/Vérifiez d'abord le paiement/);
      await q('rollback to savepoint a');
      await q(`select public.verifier_paiement_commande($1, true)`, [commande.id]);
      await q(`select public.avancer_commande_web($1, 'en_livraison')`, [commande.id]);
      const d = await un(q<{ r: { justificatif_path: string; lignes: unknown[] } }>(`select public.commande_web_detail($1) r`, [commande.id]));
      expect(d.r.justificatif_path).toBe(`${commande.id}/capture.jpg`);
      expect(d.r.lignes).toHaveLength(2);
      return Number((await un(q<{ q: string }>(`select quantite q from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz]))).q);
    });
    const vente = await enTantQue(pool, alice, async (q) => {
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
      // 3.9 : la gérante affecte d'abord la commande à la caissière.
      await q(`select public.affecter_commande_web($1, $2)`, [commande.id, carine]);
      await devenir(q, carine);
      return (await un(q<{ r: { id: string; total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [commande.id, s]))).r;
    });
    // La vente porte sur les articles ; les frais de livraison restent sur la commande.
    expect(Number(vente.total)).toBe(2 * 18000 + 3 * 6500);
    await enTantQue(pool, alice, async (q) => {
      expect(Number((await un(q<{ q: string }>(`select quantite q from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz]))).q)).toBe(avant - 2);
      expect((await un(q<{ statut: string }>(`select statut from commandes_web where id = $1`, [commande.id]))).statut).toBe('livree');
      expect((await un(q<{ libelle: string; reference: string }>(`select libelle, reference from reglements where vente_id = $1`, [vente.id]))).libelle).toBe('Wave');
    });
    expect(await disponible(riz)).toBe(6);
  });

  it('avis vérifié après livraison, annulation motivée, boutique retirée', async () => {
    await anonyme((q) => q(`select public.deposer_avis($1, $2, 5, 'Livré à l''heure')`, [commande.code_suivi, riz]));
    const p = await anonyme((q) => un(q<{ r: { note: number; commandes: number; avis_liste: { auteur: string }[] } }>(`select public.marche_produit($1) r`, [riz])));
    expect(Number(p.r.note)).toBe(5);
    expect(p.r.avis_liste[0]!.auteur).toBe('Awa K.');
    expect(Number(p.r.commandes)).toBe(1);
    const c2 = (await anonyme((q) => un(q<{ r: { id: string; code_suivi: string } }>(`select public.passer_commande($1) r`, [
      commandeType([{ produit_id: riz, quantite: 1 }], { mode: 'retrait', zone_id: null, client_telephone: '0707070707', paiement: 'wave' }),
    ])))).r;
    await enTantQue(pool, alice, async (q) => {
      await q('savepoint a');
      await expect(q(`select public.avancer_commande_web($1, 'annulee')`, [c2.id])).rejects.toThrow(/motif/);
      await q('rollback to savepoint a');
      await q(`select public.avancer_commande_web($1, 'annulee', 'Rupture chez le fournisseur')`, [c2.id]);
      await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({ slug: 'riz-et-cie', nom: 'Riz & Cie', magasin_id: mag, publiee: false })]);
    });
    const s = await anonyme((q) => un(q<{ r: { statut: string; motif: string } }>(`select public.marche_suivi($1) r`, [c2.code_suivi])));
    expect(s.r).toMatchObject({ statut: 'annulee', motif: 'Rupture chez le fournisseur' });
    await expect(anonyme((q) => q(`select public.marche_boutique('riz-et-cie')`))).rejects.toThrow(/introuvable/);
    expect((await anonyme((q) => un(q<{ r: { boutiques: unknown[] } }>(`select public.marche_accueil() r`)))).r.boutiques).toHaveLength(0);
  });
});

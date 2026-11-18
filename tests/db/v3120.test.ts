import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.12 : la caissière accepte la commande affectée ; une livraison est confirmée par la gérante.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let awa: string; // cliente du site
let org: string;
let mag: string;
let caisse: string;
let riz: string;
let session: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

type Attente = { nombre: number; a_accepter: number; a_accepter_liste: { id: string; mode: string }[]; a_livrer: number };

beforeAll(async () => {
  pool = await preparerBase('v3120');
  alice = await creerCompte(pool, 'alice@v312.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v312.ci', 'Carine');
  awa = await creerCompte(pool, 'awa@client312.ci', '');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@v312.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, alice, async (q) => {
    await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({
      slug: 'chez-alice-312', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false,
      paiement_livraison: true,
    })]);
    await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
    session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
  });
});
afterAll(async () => {
  await pool?.end();
});

const commander = (nom: string) =>
  enTantQue(pool, awa, (q) => un(q<{ r: { id: string } }>(`select public.passer_commande($1) r`, [JSON.stringify({
    boutique: 'chez-alice-312', client_nom: nom, client_telephone: '0505050505', mode: 'retrait', paiement: 'livraison',
    lignes: [{ produit_id: riz, quantite: 1 }],
  })]))).then((x) => x.r.id);

const attente = (uid: string) =>
  enTantQue(pool, uid, (q) => un(q<{ r: Attente }>(`select public.commandes_caisse_attente($1) r`, [org]))).then((x) => x.r);

describe('Circuit des commandes en ligne', () => {
  it('la caissière accepte ; une nouvelle affectation doit être acceptée à nouveau', async () => {
    const c = await commander('Awa');
    await enTantQue(pool, alice, (q) => q(`select public.affecter_commande_web($1, $2)`, [c, carine]));
    let a = await attente(carine);
    expect(Number(a.a_accepter)).toBe(1);
    expect(a.a_accepter_liste[0]!.id).toBe(c);
    await expect(enTantQue(pool, alice, (q) => q(`select public.accepter_commande_web($1)`, [c]))).rejects.toThrow(/pas affectée/);
    await enTantQue(pool, carine, (q) => q(`select public.accepter_commande_web($1)`, [c]));
    a = await attente(carine);
    expect(Number(a.a_accepter)).toBe(0);
    expect(Number(a.nombre)).toBe(1);
    await enTantQue(pool, alice, async (q) => {
      await q(`select public.affecter_commande_web($1, null)`, [c]);
      await q(`select public.affecter_commande_web($1, $2)`, [c, carine]);
    });
    expect(Number((await attente(carine)).a_accepter)).toBe(1);
    // Retrait : la caissière remet et encaisse (marquer « prête » vaut acceptation).
    await enTantQue(pool, carine, async (q) => {
      const r = (await un(q<{ r: { prise_en_charge_le: string | null } }>(`select public.avancer_commande_web($1, 'prete') r`, [c]))).r;
      expect(r.prise_en_charge_le).not.toBeNull();
      const v = (await un(q<{ r: { total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [c, session]))).r;
      expect(Number(v.total)).toBe(4500);
    });
  });

  it('livraison : prête par la caissière, la gérante est prévenue et confirme avant tout encaissement', async () => {
    const c = await commander('Koffi');
    await pool.query(`update commandes_web set mode = 'livraison', adresse = 'Angré 8e tranche', zone_nom = 'Cocody' where id = $1`, [c]);
    await enTantQue(pool, alice, (q) => q(`select public.affecter_commande_web($1, $2)`, [c, carine]));
    await enTantQue(pool, carine, (q) => q(`select public.avancer_commande_web($1, 'prete')`, [c]));
    expect(Number((await attente(alice)).a_livrer)).toBe(1);
    await expect(enTantQue(pool, carine, (q) => q(`select public.encaisser_commande_web($1, $2)`, [c, session]))).rejects.toThrow(
      /confirmer la livraison/,
    );
    await enTantQue(pool, alice, (q) => q(`select public.avancer_commande_web($1, 'en_livraison')`, [c]));
    expect(Number((await attente(alice)).a_livrer)).toBe(0);
    const v = await enTantQue(pool, carine, (q) => un(q<{ r: { total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [c, session])));
    expect(Number(v.r.total)).toBe(4500);
  });
});

// 3.13 : la gérante peut donner à une caissière le seul droit d'affecter les commandes.
describe('Droit d’affecter délégué', () => {
  it('la caissière désignée est prévenue des commandes à affecter et peut les confier', async () => {
    const c = await commander('Mariam');
    await expect(enTantQue(pool, carine, (q) => q(`select public.affecter_commande_web($1, $2)`, [c, carine]))).rejects.toThrow(/boutique.valider/);
    await expect(enTantQue(pool, carine, (q) => q(`select public.affecteur_definir($1, $2, true)`, [org, carine]))).rejects.toThrow(/Seule la gérante/);
    await enTantQue(pool, alice, (q) => q(`select public.affecteur_definir($1, $2, true)`, [org, carine]));
    const a = await enTantQue(pool, carine, (q) => un(q<{ r: { a_affecter: number; affecteur: boolean; a_livrer: number } }>(`select public.commandes_caisse_attente($1) r`, [org]))).then((x) => x.r);
    expect(a.affecteur).toBe(true);
    expect(Number(a.a_affecter)).toBe(1);
    expect(Number(a.a_livrer)).toBe(0);
    await enTantQue(pool, carine, (q) => q(`select public.affecter_commande_web($1, $2)`, [c, carine]));
    expect(Number((await attente(carine)).a_accepter)).toBe(1);
    await enTantQue(pool, alice, (q) => q(`select public.affecteur_definir($1, $2, false)`, [org, carine]));
    const b = await enTantQue(pool, carine, (q) => un(q<{ r: { affecteur: boolean } }>(`select public.commandes_caisse_attente($1) r`, [org]))).then((x) => x.r);
    expect(b.affecteur).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.10 : la caissière est prévenue de chaque commande, jeton d'appareil (APK), alertes WhatsApp.
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
  pool = await preparerBase('v3100');
  alice = await creerCompte(pool, 'alice@v39.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v39.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
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

const JETON = 'jeton-de-test-0123456789-abcdefghijklmnop';
type Attente = { nombre: number; a_affecter: number; en_attente: number; gerante: boolean };

describe('Alertes des commandes en ligne', () => {
  it('la caissière voit chaque nouvelle commande en attente, la gérante celles à affecter', async () => {
    await enTantQue(pool, carine, (q) => q(`select public.enregistrer_appareil($1, $2)`, [org, JETON]));
    await enTantQue(pool, alice, (q) => q(`select public.alerte_whatsapp_enregistrer($1, '07 57 65 70 55', 'cle123')`, [org]));
    // La commande passe même si WhatsApp ne peut pas partir (pas de pg_net en test).
    await enTantQue(pool, awa, (q) => q(`select public.passer_commande($1)`, [JSON.stringify({
      boutique: 'chez-alice', client_nom: 'Awa Koné', client_telephone: '0505050505', mode: 'retrait', paiement: 'livraison',
      lignes: [{ produit_id: riz, quantite: 2 }],
    })]));
    const c = await enTantQue(pool, carine, (q) => un(q<{ r: Attente }>(`select public.commandes_caisse_attente($1) r`, [org])));
    expect(Number(c.r.en_attente)).toBe(1);
    expect(Number(c.r.nombre)).toBe(0);
    expect(c.r.gerante).toBe(false);
    const g = await enTantQue(pool, alice, (q) => un(q<{ r: Attente }>(`select public.commandes_caisse_attente($1) r`, [org])));
    expect(Number(g.r.a_affecter)).toBe(1);
    expect(g.r.gerante).toBe(true);
  });

  it('le téléphone, sans session, ne reçoit que les nombres de son jeton', async () => {
    const a = await enTantQue(pool, null, (q) => un(q<{ r: Attente | null }>(`select public.appareil_attente($1) r`, [JETON])));
    expect(Number(a.r!.en_attente)).toBe(1);
    const b = await enTantQue(pool, null, (q) => un(q<{ r: Attente | null }>(`select public.appareil_attente($1) r`, ['inconnu-0123456789-abcdefghijklmnopqrstuv'])));
    expect(b.r).toBeNull();
    await expect(enTantQue(pool, null, (q) => q(`select public.alerte_whatsapp_lire($1)`, [org]))).rejects.toThrow(/permission/);
  });

  it('la clé WhatsApp reste sur le serveur', async () => {
    const r = await enTantQue(pool, alice, (q) => un(q<{ r: Record<string, unknown> }>(`select public.alerte_whatsapp_lire($1) r`, [org])));
    expect(r.r.telephone).toBe('+2250757657055');
    expect(r.r.configuree).toBe(true);
    expect(JSON.stringify(r.r)).not.toContain('cle123');
  });
});

import { describe, expect, it } from 'vitest';
import { chercherLocal, estErreurReseau, type ProduitCaisse } from '../../src/caisse/local';

const p = (id: string, designation: string, code: string, codes: string[] = []): ProduitCaisse => ({
  id, code, designation, unite: 'pièce', prix_vente: 100, taux_tva: 0, codes_barres: codes, quantite_stock: 0,
});
const catalogue = [
  p('1', 'Riz parfumé 5 kg', 'P00001', ['6111245800017']),
  p('2', 'Huile végétale 1 L', 'P00002', ['2000000000015']),
  p('3', 'Riz brisé 25 kg', 'P00003'),
];

describe('recherche locale de la caisse (sans réseau)', () => {
  it('code-barres exact, y compris avec espaces de saisie', () => {
    expect(chercherLocal(catalogue, '6111245800017').exact?.id).toBe('1');
    expect(chercherLocal(catalogue, ' 2000000 000015 ').exact?.id).toBe('2');
  });
  it('code produit exact, insensible à la casse', () => {
    expect(chercherLocal(catalogue, 'p00003').exact?.id).toBe('3');
  });
  it('mots sans accents, dans le désordre', () => {
    expect(chercherLocal(catalogue, 'vegetale huile').resultats.map((x) => x.id)).toEqual(['2']);
    expect(chercherLocal(catalogue, 'riz').resultats).toHaveLength(2);
    expect(chercherLocal(catalogue, 'riz 25').resultats.map((x) => x.id)).toEqual(['3']);
  });
  it('rien pour une saisie vide ou inconnue', () => {
    expect(chercherLocal(catalogue, '   ').resultats).toEqual([]);
    expect(chercherLocal(catalogue, '9999999999999').exact).toBeUndefined();
  });
});

describe('distinction panne réseau / refus du serveur', () => {
  it('une panne réseau est réessayée, un refus métier ne l’est pas', () => {
    expect(estErreurReseau({ message: 'TypeError: Failed to fetch', code: '' })).toBe(true);
    expect(estErreurReseau(new TypeError('Load failed'))).toBe(true);
    expect(estErreurReseau({ message: 'Le total des règlements ne correspond pas', code: 'P0001' })).toBe(false);
  });
});

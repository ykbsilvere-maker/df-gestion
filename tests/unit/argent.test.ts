import { afterEach, describe, expect, it } from 'vitest';
import { definirDevise, devise, libelleCoupure, lireMontant, montant, montantEn } from '../../src/lib/argent';

afterEach(() => definirDevise('XOF'));

describe('XOF (par défaut)', () => {
  it('affiche les montants entiers avec le code XOF', () => {
    expect(montant(4500)).toBe('4 500 XOF');
    expect(montant(1234567)).toBe('1 234 567 XOF');
    expect(montant(0)).toBe('0 XOF');
    expect(montant(4500, '')).toBe('4 500');
  });
  it('lit les saisies habituelles', () => {
    expect(lireMontant('4 500')).toBe(4500);
    expect(lireMontant('4500 F')).toBe(4500);
    expect(lireMontant('')).toBeNull();
  });
  it('coupures sans décimale', () => {
    expect(libelleCoupure(10000)).toBe('10 000');
    expect(libelleCoupure(25)).toBe('25');
  });
});

describe('Euro', () => {
  it('affiche les centimes et le symbole €', () => {
    definirDevise('EUR');
    expect(montant(1250)).toBe('12,50 €');
    expect(montant(123456)).toBe('1 234,56 €');
    expect(montant(5)).toBe('0,05 €');
  });
  it('lit virgule ou point, avec ou sans centimes', () => {
    definirDevise('EUR');
    expect(lireMontant('12,50')).toBe(1250);
    expect(lireMontant('12.5')).toBe(1250);
    expect(lireMontant('12')).toBe(1200);
    expect(lireMontant('1 234,56 €')).toBe(123456);
    expect(lireMontant('1.234')).toBe(123400);
    expect(lireMontant('0,05')).toBe(5);
    expect(lireMontant('abc')).toBeNull();
  });
  it('coupures : billets entiers, pièces en centimes', () => {
    const e = devise('EUR');
    expect(libelleCoupure(5000, e)).toBe('50 €');
    expect(libelleCoupure(20, e)).toBe('0,20 €');
  });
  it('relit exactement ce qu’elle affiche', () => {
    definirDevise('EUR');
    for (const v of [1, 99, 100, 1250, 99999, 1234567]) expect(lireMontant(montant(v))).toBe(v);
  });
});

describe('monnaie donnée explicitement (console)', () => {
  it('formate chaque entreprise dans sa monnaie, quelle que soit la monnaie courante', () => {
    definirDevise('EUR');
    expect(montantEn(31500, 'XOF')).toBe('31 500 XOF');
    expect(montantEn(31500, 'USD')).toBe('315,00 $');
    expect(montantEn(31500, null)).toBe('31 500 XOF');
  });
  it('une monnaie inconnue retombe sur XOF', () => {
    expect(devise('BTC').code).toBe('XOF');
  });
});

import { useMemo, useRef, useState, useEffect } from 'react';
import { clavierMontant, deviseCourante, lireMontant, montant, saisieMontant } from '../lib/argent';
import { Alerte, Ico } from '../components/ui';
import { LogoMoyen } from '../components/LogoMoyen';
import type { MoyenPaiement, ReglementVente } from './local';

interface Saisie {
  moyen: MoyenPaiement;
  montant: string;
  recu: string;
  reference: string;
}

/** Icône du moyen de règlement (affichage seulement ; les tickets imprimés restent sobres). */
export function iconeMoyen(m: Pick<MoyenPaiement, 'nature'>): string {
  return { especes: '💵', mobile: '📱', carte: '💳', virement: '🏦', cheque: '📝', autre: '🔹' }[m.nature] ?? '🔹';
}

/** Arrondis proposés pour la somme remise en espèces (aux billets de la monnaie de l'entreprise). */
function billetsProposes(du: number): number[] {
  const propositions = new Set<number>([du]);
  const pas = [...deviseCourante().billets].sort((a, b) => a - b).slice(0, 5);
  for (const p of pas) propositions.add(Math.ceil(du / p) * p);
  return [...propositions].filter((v) => v >= du).sort((a, b) => a - b).slice(0, 5);
}

/**
 * Règlement d'une vente : un ou plusieurs moyens (espèces, Mobile Money, carte…).
 * Seuls le moyen, le montant et la référence éventuelle sont tracés : aucun paiement n'est déclenché.
 */
export function Paiement({
  total,
  moyens,
  onValider,
  enCours,
}: {
  total: number;
  moyens: MoyenPaiement[];
  onValider: (r: ReglementVente[]) => void;
  enCours: boolean;
}) {
  const actifs = useMemo(() => moyens.filter((m) => m.actif).sort((a, b) => a.ordre - b.ordre), [moyens]);
  const especes = actifs.find((m) => m.nature === 'especes');
  const [lignes, setLignes] = useState<Saisie[]>(() =>
    especes ? [{ moyen: especes, montant: saisieMontant(total), recu: '', reference: '' }] : [],
  );
  // Monnaie rendue en partie par un autre moyen (faute de pièces : Wave, Orange Money…).
  const moyensRendu = actifs.filter((m) => m.nature !== 'especes');
  const [renduAutre, setRenduAutre] = useState<{ moyenId: string; montant: string; reference: string } | null>(null);
  const premierChamp = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Sur écran tactile, on n'ouvre pas le clavier d'office : les billets proposés suffisent souvent.
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    premierChamp.current?.focus();
  }, []);

  // Un seul moyen : son montant est le total de la vente, jamais modifiable.
  const montantFige = lignes.length === 1;
  const montants = montantFige ? [total] : lignes.map((l) => lireMontant(l.montant) ?? 0);
  const regle = montants.reduce((s, m) => s + m, 0);
  const reste = total - regle;
  const rendu = lignes.reduce((s, l, i) => {
    if (l.moyen.nature !== 'especes') return s;
    const recu = lireMontant(l.recu);
    return s + (recu != null ? Math.max(0, recu - montants[i]!) : 0);
  }, 0);

  const moyenRendu = renduAutre ? moyensRendu.find((m) => m.id === renduAutre.moyenId) : undefined;
  const renduAutreMontant = renduAutre ? lireMontant(renduAutre.montant) ?? 0 : 0;
  const renduEspeces = Math.max(0, rendu - renduAutreMontant);
  // Ligne d'espèces dont la monnaie est en partie rendue par l'autre moyen.
  const iEspeces = lignes.findIndex((l, i) => l.moyen.nature === 'especes' && (lireMontant(l.recu) ?? 0) > montants[i]!);
  const monnaieLigne = iEspeces < 0 ? 0 : (lireMontant(lignes[iEspeces]!.recu) ?? 0) - montants[iEspeces]!;

  const problemes: string[] = [];
  if (reste > 0) problemes.push(`Il reste ${montant(reste)} à régler.`);
  if (reste < 0) problemes.push(`Les règlements dépassent le total de ${montant(-reste)}. Pour rendre la monnaie, saisissez la somme remise dans « Reçu ».`);
  lignes.forEach((l, i) => {
    if (montants[i]! <= 0) problemes.push(`${l.moyen.libelle} : montant à saisir.`);
    if (l.moyen.reference_obligatoire && !l.reference.trim()) problemes.push(`${l.moyen.libelle} : référence de la transaction obligatoire.`);
    const recu = lireMontant(l.recu);
    if (l.moyen.nature === 'especes' && recu != null && recu < montants[i]!) problemes.push('Espèces : la somme reçue est inférieure au montant.');
  });
  if (renduAutre && moyenRendu) {
    if (renduAutreMontant <= 0) problemes.push(`Rendu par ${moyenRendu.libelle} : montant à saisir.`);
    else if (renduAutreMontant > monnaieLigne) problemes.push(`Le rendu par ${moyenRendu.libelle} dépasse la monnaie à rendre (${montant(monnaieLigne)}).`);
    if (moyenRendu.reference_obligatoire && !renduAutre.reference.trim()) problemes.push(`Rendu par ${moyenRendu.libelle} : référence de l’envoi obligatoire.`);
  }
  const valide = lignes.length > 0 && problemes.length === 0;

  function ajouter(m: MoyenPaiement) {
    setLignes((ls) => {
      const dejaRegle = ls.reduce((s, l) => s + (lireMontant(l.montant) ?? 0), 0);
      return [...ls, { moyen: m, montant: saisieMontant(Math.max(0, total - dejaRegle)), recu: '', reference: '' }];
    });
  }
  const modifier = (i: number, champ: keyof Omit<Saisie, 'moyen'>, v: string) =>
    setLignes((ls) => ls.map((l, j) => (j === i ? { ...l, [champ]: v } : l)));
  const retirer = (i: number) => setLignes((ls) => ls.filter((_, j) => j !== i));

  function valider() {
    if (!valide || enCours) return;
    const avecRendu = !!moyenRendu && renduAutreMontant > 0;
    const reglements: ReglementVente[] = lignes.map((l, i) => ({
      moyen_id: l.moyen.id,
      libelle: l.moyen.libelle,
      nature: l.moyen.nature,
      // Les espèces gardées au tiroir incluent la part de monnaie rendue par l'autre moyen.
      montant: montants[i]! + (avecRendu && i === iEspeces ? renduAutreMontant : 0),
      montant_recu: l.moyen.nature === 'especes' ? lireMontant(l.recu) ?? montants[i]! : undefined,
      reference: l.reference.trim() || undefined,
    }));
    if (avecRendu)
      reglements.push({
        moyen_id: moyenRendu!.id,
        libelle: moyenRendu!.libelle,
        nature: moyenRendu!.nature,
        montant: renduAutreMontant,
        reference: renduAutre!.reference.trim() || undefined,
        sens: 'rendu',
      });
    onValider(reglements);
  }

  return (
    <form
      className="paiement"
      onSubmit={(e) => {
        e.preventDefault();
        valider();
      }}
    >
      <div className="paiement-total">
        <span>À payer</span>
        <strong>{montant(total)}</strong>
      </div>

      <div className="paiement-lignes">
        {lignes.map((l, i) => (
          <div key={i} className="paiement-ligne">
            <div className="paiement-moyen">
              <strong>
                <LogoMoyen moyen={l.moyen} grand />
                {l.moyen.libelle}
              </strong>
              <button type="button" className="bouton-lien lien-danger" onClick={() => retirer(i)}>
                Retirer
              </button>
            </div>
            <label className="champ">
              <span className="champ-label">Montant</span>
              <input
                ref={i === 0 && !montantFige ? premierChamp : undefined}
                inputMode={clavierMontant()}
                value={montantFige ? saisieMontant(total) : l.montant}
                readOnly={montantFige}
                className={montantFige ? 'champ-fige' : undefined}
                title={montantFige ? 'Total de la vente : ajoutez un second moyen pour partager le paiement' : undefined}
                onChange={(e) => modifier(i, 'montant', e.target.value)}
                aria-label={`Montant ${l.moyen.libelle}`}
              />
            </label>
            {l.moyen.nature === 'especes' ? (
              <label className="champ">
                <span className="champ-label">Reçu du client</span>
                <input
                  ref={i === 0 && montantFige ? premierChamp : undefined}
                  inputMode={clavierMontant()}
                  value={l.recu}
                  placeholder={montantFige ? saisieMontant(total) : l.montant}
                  onChange={(e) => modifier(i, 'recu', e.target.value)}
                  aria-label="Somme reçue en espèces"
                />
              </label>
            ) : (
              <label className="champ">
                <span className="champ-label">Référence{l.moyen.reference_obligatoire ? ' *' : ''}</span>
                <input
                  value={l.reference}
                  maxLength={80}
                  placeholder="n° de transaction"
                  onChange={(e) => modifier(i, 'reference', e.target.value)}
                  aria-label={`Référence ${l.moyen.libelle}`}
                />
              </label>
            )}
            {l.moyen.nature === 'especes' && (
              <div className="billets-rapides">
                {billetsProposes(montants[i]!).map((b) => (
                  <button key={b} type="button" className="bouton bouton-discret" onClick={() => modifier(i, 'recu', saisieMontant(b))}>
                    {montant(b, '')}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="paiement-moyens" aria-label="Ajouter un moyen de règlement">
        {actifs.map((m) => (
          <button key={m.id} type="button" className="bouton bouton-discret" onClick={() => ajouter(m)}>
            <LogoMoyen moyen={m} />
            {m.libelle}
          </button>
        ))}
      </div>

      <div className="paiement-bilan">
        <div>
          <span>Réglé</span>
          <span>{montant(regle)}</span>
        </div>
        <div className={reste !== 0 ? 'texte-negatif' : ''}>
          <span>Reste</span>
          <span>{montant(Math.max(0, reste))}</span>
        </div>
        <div className="paiement-rendu">
          <span>Monnaie à rendre</span>
          <strong>{montant(rendu)}</strong>
        </div>
        {moyenRendu && (
          <>
            <div className="paiement-detail-rendu">
              <span>dont en espèces</span>
              <span>{montant(renduEspeces)}</span>
            </div>
            <div className="paiement-detail-rendu">
              <span>dont par {moyenRendu.libelle}</span>
              <span>{montant(renduAutreMontant)}</span>
            </div>
          </>
        )}
      </div>

      {rendu > 0 && moyensRendu.length > 0 && !renduAutre && (
        <button
          type="button"
          className="bouton-lien bouton-rendu-autre"
          onClick={() => setRenduAutre({ moyenId: (moyensRendu.find((m) => m.nature === 'mobile') ?? moyensRendu[0]!).id, montant: '', reference: '' })}
        >
          <Ico>📲</Ico>
          Pas assez de monnaie ? Rendre une partie par Wave, Orange Money…
        </button>
      )}
      {renduAutre && moyenRendu && (
        <div className="paiement-ligne paiement-rendu-autre">
          <div className="paiement-moyen">
            <strong>
              <Ico>💸</Ico>
              Monnaie rendue par un autre moyen
            </strong>
            <button type="button" className="bouton-lien lien-danger" onClick={() => setRenduAutre(null)}>
              Retirer
            </button>
          </div>
          <label className="champ">
            <span className="champ-label">Moyen</span>
            <select value={renduAutre.moyenId} onChange={(e) => setRenduAutre({ ...renduAutre, moyenId: e.target.value })} aria-label="Moyen du rendu">
              {moyensRendu.map((m) => (
                <option key={m.id} value={m.id}>
                  {iconeMoyen(m)} {m.libelle}
                </option>
              ))}
            </select>
          </label>
          <label className="champ">
            <span className="champ-label">Montant rendu</span>
            <input
              inputMode={clavierMontant()}
              value={renduAutre.montant}
              onChange={(e) => setRenduAutre({ ...renduAutre, montant: e.target.value })}
              aria-label="Montant rendu par l’autre moyen"
              autoFocus
            />
          </label>
          <label className="champ">
            <span className="champ-label">Référence de l’envoi{moyenRendu.reference_obligatoire ? ' *' : ''}</span>
            <input
              value={renduAutre.reference}
              maxLength={80}
              placeholder="n° de transaction"
              onChange={(e) => setRenduAutre({ ...renduAutre, reference: e.target.value })}
              aria-label="Référence du rendu"
            />
          </label>
          <div className="billets-rapides">
            <button type="button" className="bouton bouton-discret" onClick={() => setRenduAutre({ ...renduAutre, montant: saisieMontant(monnaieLigne) })}>
              Tout ({montant(monnaieLigne, '')})
            </button>
          </div>
        </div>
      )}

      {lignes.length > 0 && problemes.length > 0 && <Alerte type="info">{problemes[0]}</Alerte>}

      <button type="submit" className="bouton bouton-principal bouton-plein bouton-encaisser" disabled={!valide || enCours}>
        {enCours ? 'Enregistrement…' : 'Valider la vente'}
      </button>
    </form>
  );
}

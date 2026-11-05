import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { Alerte } from './ui';

/** Modules que l'entreprise peut activer ou non. Caisse, catalogue, ventes, clients et administration sont toujours là. */
export const MODULES_OPTIONNELS: { code: string; icone: string; libelle: string; aide: string; inclut?: string[] }[] = [
  { code: 'stock', icone: '📦', libelle: 'Stock et arrivages', aide: 'Quantités, réceptions, comptages, inventaires', inclut: ['achats'] },
  { code: 'fournisseurs', icone: '🚚', libelle: 'Fournisseurs', aide: 'Fiches, dettes, paiements, coûts de revient' },
  { code: 'budget', icone: '📒', libelle: 'Budget et dépenses', aide: 'Prévu, réalisé, dépassements' },
  { code: 'tresorerie', icone: '💰', libelle: 'Trésorerie et créances', aide: 'Banque, Mobile Money, balance âgée, relances' },
  { code: 'rentabilite', icone: '📈', libelle: 'Rentabilité', aide: 'Compte d’exploitation, seuil de rentabilité' },
  { code: 'promotions', icone: '🏷️', libelle: 'Soldes et promotions', aide: 'Surstock, remises appliquées en caisse' },
  { code: 'comptabilite', icone: '📚', libelle: 'Comptabilité SYSCOHADA', aide: 'Journal, grand livre, balance, bilan' },
];

/** Cases à cocher : `desactives` liste les codes décochés. */
export function ChoixModules({
  desactives,
  onChange,
  inactif,
  bloques = [],
}: {
  desactives: string[];
  onChange: (d: string[]) => void;
  inactif?: boolean;
  /** Modules non souscrits : affichés grisés, non activables. */
  bloques?: string[];
}) {
  return (
    <div className="choix-modules">
      <div className="module-fixe">
        <span aria-hidden>🛒</span>
        <div>
          <strong>Caisse, catalogue, ventes, devis et clients</strong>
          <span className="secondaire">Toujours inclus</span>
        </div>
      </div>
      {MODULES_OPTIONNELS.map((m) => {
        const actif = !desactives.includes(m.code);
        const bloque = bloques.includes(m.code);
        return (
          <label key={m.code} className={`module-choix ${actif ? 'actif' : ''} ${bloque ? 'bloque' : ''}`}>
            <input
              type="checkbox"
              checked={actif}
              disabled={inactif || bloque}
              onChange={(e) => {
                const codes = [m.code, ...(m.inclut ?? [])];
                onChange(e.target.checked ? desactives.filter((c) => !codes.includes(c)) : [...new Set([...desactives, ...codes])]);
              }}
            />
            <span aria-hidden>{m.icone}</span>
            <div>
              <strong>{m.libelle}</strong>
              <span className="secondaire">{bloque ? 'Non souscrit · contactez Décodeur Financier' : m.aide}</span>
            </div>
          </label>
        );
      })}
    </div>
  );
}

/** Carte des paramètres : le propriétaire active ou retire des modules à tout moment (les données sont conservées). */
export function ModulesEntreprise() {
  const { organisation, rechargerOrganisations } = useSession();
  const org = organisation!.organisation_id;
  const [desactives, setDesactives] = useState<string[]>([]);
  const [initial, setInitial] = useState<string[]>([]);
  const [modifiable, setModifiable] = useState(false);
  const [bloques, setBloques] = useState<string[]>([]);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('modules_organisation', { p_org: org });
    if (error) return setErreur(messageErreur(error));
    const r = data as { desactives: string[]; bloques: string[]; modifiable: boolean };
    setBloques(r.bloques ?? []);
    setDesactives(r.desactives ?? []);
    setInitial(r.desactives ?? []);
    setModifiable(r.modifiable);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const change = [...desactives].sort().join() !== [...initial].sort().join();

  async function enregistrer() {
    setEnvoi(true);
    setErreur('');
    const { error } = await supabase.rpc('definir_modules', { p_org: org, p_desactives: desactives });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setInfo('Modules mis à jour : les menus et les droits suivent immédiatement. Les données des modules retirés sont conservées.');
    await rechargerOrganisations();
    await charger();
  }

  return (
    <section className="carte">
      <h2>Modules de l’entreprise</h2>
      <p className="secondaire">
        Cochez ce que vous utilisez. Un module retiré disparaît des menus et des droits de tous les utilisateurs ; ses données restent
        gardées et reviennent si vous le réactivez.
      </p>
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <ChoixModules desactives={desactives} onChange={setDesactives} inactif={!modifiable} bloques={bloques} />
      {modifiable ? (
        <button className="bouton bouton-principal" disabled={!change || envoi} onClick={() => void enregistrer()}>
          {envoi ? 'Enregistrement…' : 'Enregistrer les modules'}
        </button>
      ) : (
        <p className="secondaire">Seul le propriétaire peut changer les modules.</p>
      )}
    </section>
  );
}

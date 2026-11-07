import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { dateHeure, messageErreur } from '../lib/format';
import { REGIMES } from '../lib/types';
import { MODULES_OPTIONNELS } from '../components/ChoixModules';
import { Alerte, Champ, Fenetre, Ico, Pastille, Vide } from '../components/ui';
import type { Demande } from './DemandeEntreprise';

type LigneDemande = Demande & { compte: string };

const TON = { en_attente: 'or', ajournee: 'gris', validee: 'vert', refusee: 'rouge' } as const;
const LIBELLE = { en_attente: 'Nouvelle', ajournee: 'Ajournée', validee: 'Validée', refusee: 'Refusée' } as const;

/** Numéro composable : chiffres seuls, préfixe ivoirien ajouté pour un numéro local à 10 chiffres. */
function numero(tel: string): string {
  const c = tel.replace(/[^\d+]/g, '');
  return /^\d{10}$/.test(c) ? `+225${c}` : c;
}

/**
 * Demandes d'ouverture envoyées depuis l'application ou le site : l'administrateur général
 * appelle le demandeur, puis valide (l'entreprise est créée), ajourne ou refuse.
 */
export function DemandesAdmin({ onEntrepriseCreee }: { onEntrepriseCreee: () => Promise<void> }) {
  const { rechargerPlateforme } = useSession();
  const [lignes, setLignes] = useState<LigneDemande[] | null>(null);
  const [toutes, setToutes] = useState(false);
  const [ouverte, setOuverte] = useState<LigneDemande | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_demandes');
    if (error) {
      // Serveur pas encore mis à jour : la section reste discrète.
      if (/admin_demandes|function/i.test(error.message)) return setLignes([]);
      return setErreur(messageErreur(error));
    }
    setLignes(data as LigneDemande[]);
  }, []);
  useEffect(() => {
    void charger();
    const id = window.setInterval(() => void charger(), 60000);
    return () => window.clearInterval(id);
  }, [charger]);

  const aTraiter = (lignes ?? []).filter((l) => l.statut === 'en_attente' || l.statut === 'ajournee');
  const visibles = toutes ? (lignes ?? []) : aTraiter;
  const nouvelles = aTraiter.filter((l) => l.statut === 'en_attente').length;

  async function apresDecision(message: string, creee: boolean) {
    setOuverte(null);
    setInfo(message);
    await Promise.all([charger(), rechargerPlateforme().catch(() => undefined), creee ? onEntrepriseCreee() : Promise.resolve()]);
  }

  if (lignes && lignes.length === 0) return null;

  return (
    <section className="carte demandes-admin">
      <div className="carte-entete">
        <h2>
          <Ico>📨</Ico>
          Demandes d’ouverture {nouvelles > 0 && <span className="nav-badge">{nouvelles}</span>}
        </h2>
        <div className="actions-demande">
          <label className="case">
            <input type="checkbox" checked={toutes} onChange={(e) => setToutes(e.target.checked)} />
            Voir aussi les demandes traitées
          </label>
          <button type="button" className="bouton-lien" onClick={() => void charger()}>
            ↻ Actualiser
          </button>
        </div>
      </div>
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      {lignes === null && <p className="secondaire">Chargement…</p>}
      {lignes && visibles.length === 0 && <Vide>Aucune demande à traiter.</Vide>}
      <div className="liste-demandes">
        {visibles.map((d) => (
          <article key={d.id} className={`demande-ligne demande-${d.statut}`}>
            <button type="button" className="demande-corps" onClick={() => setOuverte(d)}>
              <span className="demande-titre">
                <strong>{d.nom_entreprise}</strong>
                <Pastille ton={TON[d.statut]}>{LIBELLE[d.statut]}</Pastille>
              </span>
              <span className="secondaire">
                {d.activite} · {d.ville ?? '—'} · {d.nom_gerant}
              </span>
              <span className="secondaire petit-texte">Envoyée le {dateHeure(d.soumise_le)}</span>
            </button>
            <div className="demande-actions">
              <a className="bouton bouton-discret" href={`tel:${numero(d.telephone)}`}>
                📞 Appeler
              </a>
              <button type="button" className="bouton bouton-principal" onClick={() => setOuverte(d)}>
                Examiner
              </button>
            </div>
          </article>
        ))}
      </div>

      <Fenetre titre={ouverte ? `Demande : ${ouverte.nom_entreprise}` : ''} ouverte={!!ouverte} onFermer={() => setOuverte(null)} large>
        {ouverte && <DetailDemande ligne={ouverte} onDecision={apresDecision} />}
      </Fenetre>
    </section>
  );
}

function DetailDemande({ ligne, onDecision }: { ligne: LigneDemande; onDecision: (message: string, creee: boolean) => Promise<void> }) {
  const [d, setD] = useState<LigneDemande>(ligne);
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const traitable = d.statut === 'en_attente' || d.statut === 'ajournee';

  useEffect(() => {
    void supabase.rpc('admin_demande', { p_id: ligne.id }).then(({ data }) => data && setD(data as LigneDemande));
  }, [ligne.id]);

  async function decider(decision: 'valider' | 'ajourner' | 'refuser') {
    setErreur('');
    if (decision !== 'valider' && motif.trim().length < 3)
      return setErreur(decision === 'ajourner' ? 'Écrivez ce que le demandeur doit corriger.' : 'Écrivez la raison du refus.');
    if (decision === 'valider' && !window.confirm(`Créer l’entreprise « ${d.nom_entreprise} » et en faire de ${d.nom_gerant} le gérant principal ?`)) return;
    setEnvoi(true);
    const { error } = await supabase.rpc('admin_traiter_demande', { p_id: d.id, p_decision: decision, p_motif: motif.trim() || null });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    await onDecision(
      decision === 'valider'
        ? `« ${d.nom_entreprise} » est créée : ${d.nom_gerant} peut se connecter et ouvrir son application.`
        : decision === 'ajourner'
          ? `Demande ajournée : ${d.nom_gerant} voit la correction demandée et peut renvoyer sa fiche.`
          : 'Demande refusée : le demandeur voit le motif.',
      decision === 'valider',
    );
  }

  const regime = REGIMES.find((r) => r.code === d.regime_fiscal)?.libelle ?? d.regime_fiscal;
  const modulesRetires = (d.modules_desactives ?? []).map((m) => MODULES_OPTIONNELS.find((x) => x.code === m)?.libelle ?? m);
  const ligneInfo = (libelle: string, valeur: string | null | undefined) => (
    <div className="detail-ligne">
      <span>{libelle}</span>
      <strong>{valeur || '—'}</strong>
    </div>
  );

  return (
    <div className="detail-demande">
      <div className="detail-demande-entete">
        <div className="logo-apercu">{d.logo ? <img src={d.logo} alt="Logo" /> : <span>{d.a_logo ? '…' : 'Pas de logo'}</span>}</div>
        <div>
          <strong className="detail-nom">{d.nom_entreprise}</strong>
          <span className="secondaire">{d.activite}</span>
          <Pastille ton={TON[d.statut]}>{LIBELLE[d.statut]}</Pastille>
        </div>
      </div>
      <div className="actions-demande">
        <a className="bouton bouton-discret" href={`tel:${numero(d.telephone)}`}>
          📞 Appeler {d.telephone}
        </a>
        <a className="bouton bouton-discret" href={`https://wa.me/${numero(d.telephone).replace('+', '')}`} target="_blank" rel="noreferrer">
          💬 WhatsApp
        </a>
      </div>
      <div className="detail-grille">
        {ligneInfo('Gérant principal', d.nom_gerant)}
        {ligneInfo('Compte (connexion)', d.compte)}
        {ligneInfo('E-mail de l’entreprise', d.email_contact)}
        {ligneInfo('RCCM', d.rccm)}
        {ligneInfo('Compte contribuable (NCC)', d.ncc)}
        {ligneInfo('Date de création', d.date_creation ? new Date(d.date_creation).toLocaleDateString('fr-FR') : null)}
        {ligneInfo('Régime d’imposition', regime)}
        {ligneInfo('Ville', d.ville)}
        {ligneInfo('Adresse', d.adresse)}
        {ligneInfo('Premier magasin', d.nom_magasin)}
        {ligneInfo('Monnaie', d.devise)}
        {ligneInfo('Modules non souhaités', modulesRetires.join(', ') || 'Aucun : tous les modules')}
        {ligneInfo('Envoyée le', dateHeure(d.soumise_le))}
        {d.motif && ligneInfo(d.statut === 'refusee' ? 'Motif du refus' : 'Dernière correction demandée', d.motif)}
      </div>
      <Alerte>{erreur}</Alerte>
      {traitable ? (
        <>
          <Champ label="Message au demandeur" aide="Obligatoire pour ajourner ou refuser ; il le verra dans son application.">
            <textarea value={motif} onChange={(e) => setMotif(e.target.value)} rows={3} maxLength={1000} placeholder="ex. Le numéro RCCM ne correspond pas : merci de le vérifier." />
          </Champ>
          <div className="decision-demande">
            <button type="button" className="bouton bouton-principal" disabled={envoi} onClick={() => void decider('valider')}>
              ✓ Valider et créer l’entreprise
            </button>
            <button type="button" className="bouton bouton-discret" disabled={envoi} onClick={() => void decider('ajourner')}>
              ⏸ Ajourner
            </button>
            <button type="button" className="bouton bouton-discret lien-danger" disabled={envoi} onClick={() => void decider('refuser')}>
              ✕ Refuser
            </button>
          </div>
        </>
      ) : (
        <p className="secondaire">Demande {LIBELLE[d.statut].toLowerCase()} le {d.traitee_le ? dateHeure(d.traitee_le) : '—'}.</p>
      )}
    </div>
  );
}

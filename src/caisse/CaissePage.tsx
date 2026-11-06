import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { clavierMontant, deviseCourante, lireMontant, montant, saisieMontant } from '../lib/argent';
import { messageErreur } from '../lib/format';
import { nouvelleCle, quantite } from '../lib/stock';
import type { Caisse } from '../lib/types';
import { Alerte, Champ, Fenetre, Ico, Pastille, Vide } from '../components/ui';
import { Scanner } from '../components/Scanner';
import { ChoixCase, Recu, type VenteRecu } from '../impression/Recu';
import { RapportCaisse, type RapportSession } from '../impression/RapportCaisse';
import { useImpressionCaisse } from './impressionCaisse';
import { Paiement } from './Paiement';
import { Cloture } from './Cloture';
import { Billetage, totalBilletage, versLignes } from './Billetage';
import { identifiantAffiche } from '../lib/acces';
import {
  catalogueLocal,
  chargerCatalogue,
  chargerMoyens,
  moyensLocaux,
  chercherLocal,
  enregistrerLocalement,
  envoyer,
  prochainNumeroLocal,
  reessayer,
  serveurJoignable,
  supprimerLocale,
  surReseau,
  synchroniser,
  ventesDeSession,
  ventesEnAttente,
  ventesRejetees,
  type LigneVente,
  type MoyenPaiement,
  type ProduitCaisse,
  type ReglementVente,
  type VenteLocale,
} from './local';

interface SessionCaisse {
  id: string;
  caisse_id: string;
  magasin_id: string;
  fond_initial: number;
  ouverte_le: string;
  ouverte_par: string | null;
  caissier_id?: string | null;
}

interface CaisseInfo extends Caisse {
  magasin_nom: string;
}

const lireCache = <T,>(cle: string): T | null => {
  try {
    const v = localStorage.getItem(cle);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const ecrireCache = (cle: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(cle);
    else localStorage.setItem(cle, JSON.stringify(v));
  } catch {
    /* stockage indisponible */
  }
};

/** En ligne = réseau présent ET serveur qui répond aux derniers appels. */
function useEnLigne() {
  const [reseau, setReseau] = useState(() => navigator.onLine);
  const [serveur, setServeur] = useState(serveurJoignable);
  useEffect(() => {
    const oui = () => setReseau(true);
    const non = () => setReseau(false);
    window.addEventListener('online', oui);
    window.addEventListener('offline', non);
    const fin = surReseau(setServeur);
    return () => {
      window.removeEventListener('online', oui);
      window.removeEventListener('offline', non);
      fin();
    };
  }, []);
  return reseau && serveur;
}

export function versRecu(v: VenteLocale): VenteRecu {
  return {
    numero: v.numero ?? v.numero_local,
    provisoire: !v.numero,
    date: new Date(v.date_vente),
    caissier: v.caissier_nom,
    magasin: v.magasin_nom,
    lignes: v.lignes.map((l) => ({ designation: l.designation, quantite: l.quantite, prix_unitaire: l.prix_unitaire, remise: l.remise || undefined })),
    reglements: v.reglements.map((r) => ({ moyen: r.libelle, montant: r.montant, montant_recu: r.montant_recu, reference: r.reference, sens: r.sens })),
  };
}

const totalLignes = (ls: LigneVente[]) => ls.reduce((s, l) => s + Math.round(l.quantite * l.prix_unitaire) - l.remise, 0);

/** Page Caisse : choix de la caisse et ouverture, puis point de vente. */
// Le verrouillage après 5 minutes est désormais celui de toute l'application (code d'entrée).
export function CaissePage() {
  return <CaissePageInterne />;
}

function CaissePageInterne() {
  const { organisation, session } = useSession();
  const org = organisation!.organisation_id;
  const moi = session?.user.id;
  // Caisses de la personne ; pour un responsable : toutes celles de ses magasins, avec qui les tient.
  const [etat, setEtat] = useState<EtatCaisses | null>(() => lireCache<EtatCaisses>(`dfg_mes_caisses_${org}`));
  const [caisseId, setCaisseId] = useState<string>(() => lireCache<string>(`dfg_caisse_${org}`) ?? '');
  const [sessionCaisse, setSessionCaisse] = useState<SessionCaisse | null | undefined>(undefined);
  const [horsLigne, setHorsLigne] = useState(false);
  const [quitte, setQuitte] = useState(false);

  const chargerCaisses = useCallback(async () => {
    const { data, error } = await supabase.rpc('mes_caisses', { p_org: org });
    if (error || !data) return setHorsLigne(true);
    const e = data as EtatCaisses;
    setEtat(e);
    ecrireCache(`dfg_mes_caisses_${org}`, e);
  }, [org]);
  useEffect(() => {
    void chargerCaisses();
  }, [chargerCaisses]);

  const toutes = etat?.caisses ?? [];
  const caisses: CaisseInfo[] = toutes.filter((c) => c.accessible) as unknown as CaisseInfo[];

  // On entre directement dans la caisse que l'on tient (ouverte pour soi).
  useEffect(() => {
    if (!etat || quitte || !etat.peut_vendre) return;
    const mienne = etat.caisses.find((c) => c.session?.mienne);
    if (mienne && caisseId !== mienne.id) setCaisseId(mienne.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etat]);

  const caisse = caisses.find((c) => c.id === caisseId);

  const chargerSession = useCallback(async () => {
    if (!caisseId) return setSessionCaisse(null);
    const cle = `dfg_session_${caisseId}`;
    const { data, error } = await supabase
      .from('sessions_caisse')
      .select('id, caisse_id, magasin_id, fond_initial, ouverte_le, ouverte_par, caissier_id')
      .eq('caisse_id', caisseId)
      .eq('statut', 'ouverte')
      .maybeSingle();
    if (error) {
      // Sans réseau : on reprend la session connue sur cet appareil.
      setHorsLigne(true);
      setSessionCaisse(lireCache<SessionCaisse>(cle));
      return;
    }
    setHorsLigne(false);
    const s = data ? ({ ...data, fond_initial: Number(data.fond_initial) } as SessionCaisse) : null;
    ecrireCache(cle, s);
    setSessionCaisse(s);
  }, [caisseId]);

  useEffect(() => {
    setSessionCaisse(undefined);
    void chargerSession();
  }, [chargerSession]);

  function choisirCaisse(id: string) {
    setCaisseId(id);
    ecrireCache(`dfg_caisse_${org}`, id);
  }

  if (!etat) return <div className="chargement">Chargement des caisses…</div>;

  // On ne vend que dans SA caisse : celle ouverte pour soi par le responsable.
  // Le gérant principal ne vend jamais (peut_vendre faux) : il ouvre et clôture les caisses des autres.
  const vendable = etat.peut_vendre && !!caisse && !!sessionCaisse && (sessionCaisse.caissier_id ?? sessionCaisse.ouverte_par) === moi && !quitte;

  if (!vendable) {
    return (
      <OuvrirCaisse
        org={org}
        etat={etat}
        horsLigne={horsLigne}
        onEntrer={(id) => {
          setQuitte(false);
          choisirCaisse(id);
          void chargerSession();
        }}
        onActualiser={() => {
          void chargerCaisses();
          void chargerSession();
        }}
      />
    );
  }

  return (
    <PointDeVente
      key={sessionCaisse.id}
      org={org}
      caisse={caisse}
      sessionCaisse={sessionCaisse}
      caissier={session?.user.user_metadata?.nom_complet ?? identifiantAffiche(session?.user.email)}
      autresCaisses={[]}
      onChoisirCaisse={() => {
        setQuitte(true);
        void chargerCaisses();
      }}
      onFermee={() => {
        ecrireCache(`dfg_session_${caisse.id}`, null);
        setSessionCaisse(null);
        setQuitte(true);
        void chargerCaisses();
      }}
    />
  );
}

interface CaisseEtat {
  id: string;
  code: string;
  nom: string;
  magasin_id: string;
  magasin_nom: string;
  accessible: boolean;
  raison: 'droit' | 'magasin' | 'caisse' | null;
  session: { id: string; ouverte_le: string; mienne: boolean; par: string; ouverte_par: string; fond: number } | null;
  caissiers: { user_id: string; nom: string; moi: boolean }[];
}
interface EtatCaisses {
  peut_ouvrir: boolean;
  peut_vendre: boolean;
  responsable: boolean;
  caisses: CaisseEtat[];
}

const heureAbidjan = (d: string) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });

/**
 * Écran « Caisses ».
 * - Caissier : voit SA caisse ; si elle n'est pas ouverte, il est invité à aller voir le gérant.
 * - Responsable : ouvre chaque caisse pour la personne qui la tiendra (comptage du fond billet par
 *   billet, validé ensemble), clôture les caisses ouvertes, entre dans la sienne. Il ne vend pas
 *   dans la caisse d'un autre.
 */
function OuvrirCaisse({
  org,
  etat,
  horsLigne,
  onEntrer,
  onActualiser,
}: {
  org: string;
  etat: EtatCaisses;
  horsLigne: boolean;
  onEntrer: (id: string) => void;
  onActualiser: () => void;
}) {
  const [ouverture, setOuverture] = useState<CaisseEtat | null>(null);
  const [cloture, setCloture] = useState<CaisseEtat | null>(null);
  const [info, setInfo] = useState('');
  const visibles = etat.responsable ? etat.caisses : etat.caisses.filter((c) => c.accessible);
  const mienne = etat.caisses.find((c) => c.session?.mienne);

  return (
    <div className="ouvrir-caisse">
      <div className="ouvrir-entete">
        <h1>{etat.responsable ? '🔓 Caisses du jour' : '🧾 Ma caisse'}</h1>
        <p className="secondaire">
          {etat.responsable
            ? etat.peut_vendre
              ? 'Ouvrez chaque caisse pour la personne qui la tiendra, après avoir compté le fond ensemble. Vous clôturez aussi les caisses en fin de journée.'
              : 'En tant que gérant principal, vous ouvrez la caisse de chaque caissier après avoir compté le fond avec lui, et vous la clôturez en fin de journée. Vous ne vendez pas.'
            : 'Votre caisse est ouverte par le gérant principal, après comptage du fond avec vous.'}
        </p>
      </div>
      {horsLigne && <Alerte>Pas de connexion : l’ouverture et la clôture se font connecté.</Alerte>}
      <Alerte type="succes">{info}</Alerte>

      {!etat.responsable && !mienne && (
        <div className="carte attente-ouverture">
          <span className="attente-icone" aria-hidden>
            🔐
          </span>
          <h2>Votre caisse n’est pas encore ouverte</h2>
          <p>
            Rendez-vous auprès du <strong>gérant principal</strong> : vous comptez ensemble le fond de caisse (billets et pièces), il
            valide, et votre caisse s’ouvre ici.
          </p>
          {visibles.length === 0 && (
            <p className="secondaire">
              Aucune caisse ne vous est encore attribuée : le gérant doit vous en donner une dans Utilisateurs → votre nom → Magasins et
              caisses.
            </p>
          )}
          <button type="button" className="bouton bouton-principal" onClick={onActualiser}>
            ↻ Ma caisse a été ouverte
          </button>
        </div>
      )}

      {(etat.responsable || visibles.length > 0) && (
        <div className="grille-caisses">
          {visibles.map((c) => (
            <div key={c.id} className={`carte-caisse ${c.session?.mienne ? 'choisie' : ''}`}>
              <div className="carte-caisse-corps">
                <span className="carte-caisse-icone" aria-hidden>
                  {c.session ? '🟢' : '⚪'}
                </span>
                <strong>{c.nom}</strong>
                <span className="secondaire">
                  {c.code} · {c.magasin_nom}
                </span>
                {c.session ? (
                  <Pastille ton={c.session.mienne && etat.peut_vendre ? 'vert' : 'or'}>
                    {c.session.mienne
                      ? etat.peut_vendre
                        ? 'Ouverte pour vous'
                        : 'Encore ouverte à votre nom : à clôturer'
                      : `Tenue par ${c.session.par}`}{' '}
                    · {heureAbidjan(c.session.ouverte_le)}
                  </Pastille>
                ) : (
                  <Pastille ton="gris">Fermée</Pastille>
                )}
              </div>
              {c.session?.mienne && etat.peut_vendre && (
                <button type="button" className="bouton bouton-principal bouton-plein" onClick={() => onEntrer(c.id)}>
                  Entrer dans ma caisse
                </button>
              )}
              {etat.responsable && !c.session && (
                <button type="button" className="bouton bouton-principal bouton-plein" disabled={horsLigne || c.caissiers.length === 0} onClick={() => setOuverture(c)}>
                  🔓 Ouvrir
                </button>
              )}
              {etat.responsable && !c.session && c.caissiers.length === 0 && (
                <p className="secondaire petit">Aucun caissier n’a cette caisse : attribuez-la à un caissier dans Utilisateurs.</p>
              )}
              {etat.responsable && c.session && (
                <button type="button" className="bouton bouton-discret bouton-plein" disabled={horsLigne} onClick={() => setCloture(c)}>
                  🔒 Clôturer
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <Fenetre titre={ouverture ? `Ouvrir ${ouverture.nom}` : ''} ouverte={!!ouverture} onFermer={() => setOuverture(null)} large>
        {ouverture && (
          <FormulaireOuverture
            org={org}
            caisse={ouverture}
            onOuverte={(nom, pourMoi) => {
              setOuverture(null);
              setInfo(`${ouverture.nom} est ouverte pour ${nom}.`);
              if (pourMoi) onEntrer(ouverture.id);
              else onActualiser();
            }}
          />
        )}
      </Fenetre>

      <Fenetre titre={cloture ? `Clôturer ${cloture.nom} (${cloture.session?.par ?? ''})` : ''} ouverte={!!cloture} onFermer={() => setCloture(null)} large>
        {cloture?.session && (
          <Cloture
            sessionId={cloture.session.id}
            enAttente={0}
            rejetees={0}
            onCloturee={(z) => {
              setInfo(`${cloture.nom} clôturée : rapport Z n° ${z.numero_z ?? ''}.`);
              setCloture(null);
              onActualiser();
            }}
          />
        )}
      </Fenetre>
    </div>
  );
}

/** Ouverture d'une caisse par le responsable : pour qui, et comptage du fond. */
function FormulaireOuverture({ org, caisse, onOuverte }: { org: string; caisse: CaisseEtat; onOuverte: (nom: string, pourMoi: boolean) => void }) {
  const [caissier, setCaissier] = useState(caisse.caissiers[0]?.user_id ?? '');
  const [nombres, setNombres] = useState<Record<string, number>>({});
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [verifie, setVerifie] = useState(false);
  const fond = totalBilletage(nombres);
  const choisi = caisse.caissiers.find((c) => c.user_id === caissier);

  async function ouvrir() {
    if (!choisi) return;
    setEnCours(true);
    setErreur('');
    const { error } = await supabase.rpc('ouvrir_session', {
      p_org: org,
      p_caisse: caisse.id,
      p_fond: fond,
      p_caissier: caissier,
      p_billetage: versLignes(nombres),
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    onOuverte(choisi.moi ? 'vous' : choisi.nom, choisi.moi);
  }

  return (
    <div className="formulaire ouverture-caisse">
      <Alerte>{erreur}</Alerte>
      <Champ label="Personne qui tiendra la caisse">
        <div className="choix-caissier">
          {caisse.caissiers.map((c) => (
            <button key={c.user_id} type="button" className={`puce-caissier ${caissier === c.user_id ? 'active' : ''}`} onClick={() => setCaissier(c.user_id)}>
              <span className="avatar-matricule">{c.nom.charAt(0).toUpperCase()}</span>
              {c.moi ? `Moi (${c.nom})` : c.nom}
            </button>
          ))}
        </div>
      </Champ>
      <div className="libelle-champ">Comptage du fond de caisse</div>
      <Billetage
        nombres={nombres}
        onChange={(n) => {
          setNombres(n);
          setVerifie(false);
        }}
      />
      <label className="case verification-commune">
        <input type="checkbox" checked={verifie} onChange={(e) => setVerifie(e.target.checked)} />
        <span>
          Nous avons compté ensemble : <strong>{montant(fond)}</strong> remis à {choisi ? (choisi.moi ? 'moi-même' : choisi.nom) : '…'}.
        </span>
      </label>
      <button type="button" className="bouton bouton-principal bouton-plein bouton-ouvrir" disabled={!verifie || enCours || !choisi} onClick={() => void ouvrir()}>
        {enCours ? 'Ouverture…' : `Valider et ouvrir ${caisse.nom}`}
      </button>
    </div>
  );
}

/** Quantité : − / + ou saisie directe (décimales permises pour les articles au poids). */
function ChoixQuantite({ valeur, unite, libelle, onChange }: { valeur: number; unite: string; libelle: string; onChange: (v: number) => void }) {
  const [texte, setTexte] = useState(valeur ? String(valeur).replace('.', ',') : '');
  const [edition, setEdition] = useState(false);
  useEffect(() => {
    if (!edition) setTexte(valeur ? String(valeur).replace('.', ',') : '');
  }, [valeur, edition]);
  const pas = 1;
  return (
    <div className={`choix-quantite ${valeur > 0 ? 'rempli' : ''}`} onClick={(e) => e.stopPropagation()}>
      <button type="button" aria-label={`Diminuer ${libelle}`} disabled={valeur <= 0} onClick={() => onChange(Math.max(0, valeur - pas))}>
        −
      </button>
      <input
        inputMode="decimal"
        value={texte}
        placeholder="0"
        aria-label={`Quantité ${libelle} (${unite})`}
        onFocus={(e) => {
          setEdition(true);
          e.target.select();
        }}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.,]/g, '');
          setTexte(t);
          const v = Number(t.replace(',', '.'));
          if (t !== '' && Number.isFinite(v)) onChange(v);
        }}
        onBlur={() => {
          setEdition(false);
          if (texte === '') onChange(0);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <button type="button" aria-label={`Augmenter ${libelle}`} onClick={() => onChange(valeur + pas)}>
        +
      </button>
    </div>
  );
}

interface LigneListe {
  id: string;
  numero: string;
  date: string;
  total: number;
  statut: 'validee' | 'annulee' | 'en_attente' | 'rejetee';
  locale?: VenteLocale;
  erreur?: string;
}

function PointDeVente({
  org,
  caisse,
  sessionCaisse,
  caissier,
  autresCaisses,
  onChoisirCaisse,
  onFermee,
}: {
  org: string;
  caisse: CaisseInfo;
  sessionCaisse: SessionCaisse;
  caissier: string;
  autresCaisses: CaisseInfo[];
  onChoisirCaisse: (id: string) => void;
  onFermee: () => void;
}) {
  const { peut } = useSession();
  const { identite } = useIdentite();
  const enLigne = useEnLigne();
  const { imprimerTicket, format, caseA4, choisirCase } = useImpressionCaisse();

  const [produits, setProduits] = useState<ProduitCaisse[]>([]);
  const [catalogueHorsLigne, setCatalogueHorsLigne] = useState<string | null>(null);
  const [moyens, setMoyens] = useState<MoyenPaiement[]>([]);
  const [panier, setPanier] = useState<LigneVente[]>([]);
  const [terme, setTerme] = useState('');
  const [indexActif, setIndexActif] = useState(0);
  const [message, setMessage] = useState<{ type: 'erreur' | 'succes' | 'info'; texte: string } | null>(null);
  // Les messages s'affichent par-dessus le panier (l'écran ne saute pas) et s'effacent seuls.
  useEffect(() => {
    if (!message) return;
    const t = window.setTimeout(() => setMessage(null), message.type === 'erreur' ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [message]);
  const [enAttente, setEnAttente] = useState(0);
  const [rejetees, setRejetees] = useState<VenteLocale[]>([]);
  const [liste, setListe] = useState<LigneListe[]>([]);
  const [derniere, setDerniere] = useState<VenteLocale | null>(null);
  const [fenetre, setFenetre] = useState<null | 'paiement' | 'cloture' | 'ventes' | 'scanner' | 'rejets' | 'case'>(null);
  const [edition, setEdition] = useState<number | null>(null);
  const [annulation, setAnnulation] = useState<LigneListe | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [impressionAuto, setImpressionAuto] = useState(() => lireCache<boolean>('dfg_impression_auto') ?? true);
  const champ = useRef<HTMLInputElement>(null);

  const total = totalLignes(panier);
  const nbArticles = panier.reduce((s, l) => s + l.quantite, 0);
  const remiseAutorisee = peut('ventes.valider');
  const prixModifiable = peut('ventes.modifier');

  // Catalogue et moyens : téléchargés quand le réseau est là, conservés pour travailler sans.
  const [articlesPrets, setArticlesPrets] = useState(false);
  const chargerArticles = useCallback(async () => {
    const [c, m] = await Promise.all([chargerCatalogue(org, caisse.magasin_id), chargerMoyens(org)]);
    setArticlesPrets(true);
    setProduits(c.produits);
    setCatalogueHorsLigne(c.hors_ligne ? c.maj_le ?? '' : null);
    setMoyens(m);
  }, [org, caisse.magasin_id]);
  useEffect(() => {
    // D'abord la copie de l'appareil (immédiat, même sans réseau), puis la version du serveur.
    void Promise.all([catalogueLocal(org, caisse.magasin_id), moyensLocaux(org)]).then(([c, m]) => {
      if (c) {
        setProduits((actuels) => (actuels.length ? actuels : c.produits));
        setArticlesPrets(true);
      }
      setMoyens((actuels) => (actuels.length ? actuels : m));
    });
    void chargerArticles();
  }, [chargerArticles, org, caisse.magasin_id]);

  const rafraichir = useCallback(async () => {
    const [attente, rejets, locales] = await Promise.all([ventesEnAttente(), ventesRejetees(), ventesDeSession(sessionCaisse.id)]);
    setEnAttente(attente.length);
    setRejetees(rejets);
    const parId = new Map<string, LigneListe>();
    for (const v of locales) {
      parId.set(v.id, {
        id: v.id,
        numero: v.numero ?? v.numero_local,
        date: v.date_vente,
        total: v.total,
        statut: v.statut === 'synchronisee' ? 'validee' : v.statut,
        locale: v,
        erreur: v.erreur,
      });
    }
    const { data } = await supabase
      .from('ventes')
      .select('id, numero, date_vente, total, statut')
      .eq('session_id', sessionCaisse.id)
      .order('date_vente', { ascending: false })
      .limit(300);
    for (const s of (data ?? []) as { id: string; numero: string; date_vente: string; total: number; statut: 'validee' | 'annulee' }[]) {
      const l = parId.get(s.id);
      parId.set(s.id, { ...l, id: s.id, numero: s.numero, date: s.date_vente, total: Number(s.total), statut: s.statut, erreur: undefined });
    }
    setListe([...parId.values()].sort((a, b) => b.date.localeCompare(a.date)));
  }, [sessionCaisse.id]);

  const lancerSynchro = useCallback(async () => {
    // Serveur injoignable au dernier essai : on le sonde en actualisant les articles.
    if (!serveurJoignable()) await chargerArticles();
    await synchroniser();
    await rafraichir();
  }, [rafraichir, chargerArticles]);

  useEffect(() => {
    void lancerSynchro();
    const minuterie = setInterval(() => void lancerSynchro(), 30000);
    const enRetour = () => {
      void lancerSynchro();
      void chargerArticles();
    };
    window.addEventListener('online', enRetour);
    return () => {
      clearInterval(minuterie);
      window.removeEventListener('online', enRetour);
    };
  }, [lancerSynchro, chargerArticles]);

  // ---------- Panier ----------

  const recherche = useMemo(() => {
    const m = terme.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.*)$/);
    const multiplicateur = m ? Number(m[1]!.replace(',', '.')) : 1;
    return { multiplicateur, ...chercherLocal(produits, m ? m[2]! : terme, 300) };
  }, [terme, produits]);
  // Liste des articles toujours visible : tout le catalogue, filtré en direct pendant la frappe.
  const TAILLE_LISTE = 300;
  const articlesAffiches = useMemo(() => {
    if (!terme.trim()) return [...produits].sort((a, b) => a.designation.localeCompare(b.designation, 'fr')).slice(0, TAILLE_LISTE);
    return recherche.resultats;
  }, [terme, produits, recherche]);
  const pointeurFin = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;

  // Devis ou proforma repris en caisse (« Transformer en vente ») : ses lignes remplissent le panier.
  const devisImporte = useRef<string | null>(null);
  useEffect(() => {
    if (!articlesPrets) return;
    let brut: string | null = null;
    try {
      brut = localStorage.getItem('dfg_panier_import');
      localStorage.removeItem('dfg_panier_import');
    } catch {
      return;
    }
    if (!brut) return;
    const imp = JSON.parse(brut) as { devis: string; numero: string; client?: string; lignes: LigneVente[] };
    const connus = imp.lignes.filter((l) => produits.some((p) => p.id === l.produit_id));
    setPanier(connus);
    devisImporte.current = imp.devis;
    setMessage({
      type: 'info',
      texte: `Devis ${imp.numero} repris en caisse${connus.length < imp.lignes.length ? ` (${imp.lignes.length - connus.length} ligne(s) hors catalogue ignorée(s))` : ''}. Vérifiez puis encaissez.`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articlesPrets]);

  const ligneDe = (ls: LigneVente[], p: ProduitCaisse) => ls.findIndex((l) => l.produit_id === p.id && l.prix_unitaire === p.prix_vente && !l.remise);
  const qteDansPanier = (p: ProduitCaisse) => panier.filter((l) => l.produit_id === p.id).reduce((t, l) => t + l.quantite, 0);

  /** Fixe la quantité d'un article depuis la liste (0 = retiré du panier). */
  function fixerQuantite(p: ProduitCaisse, q: number) {
    const qte = Math.max(0, +q.toFixed(3));
    setPanier((ls) => {
      const i = ligneDe(ls, p);
      if (qte === 0) return i >= 0 ? ls.filter((_, j) => j !== i) : ls;
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantite: qte } : l));
      return [...ls, { produit_id: p.id, designation: p.designation, unite: p.unite, quantite: qte, prix_unitaire: p.prix_vente, remise: 0 }];
    });
    if (qte > p.quantite_stock)
      setMessage({ type: 'info', texte: `⚠️ ${p.designation} : stock insuffisant (${quantite(p.quantite_stock)} en stock). La vente reste possible.` });
  }

  function ajouter(p: ProduitCaisse, qte = 1, garderRecherche = false) {
    setPanier((ls) => {
      const i = ligneDe(ls, p);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantite: +(l.quantite + qte).toFixed(3) } : l));
      return [...ls, { produit_id: p.id, designation: p.designation, unite: p.unite, quantite: qte, prix_unitaire: p.prix_vente, remise: 0 }];
    });
    if (!garderRecherche) setTerme('');
    setIndexActif(0);
    // Stock insuffisant : simple alerte, la vente passe (le stock sera régularisé).
    setMessage(p.quantite_stock - qte < 0 ? { type: 'info', texte: `⚠️ ${p.designation} : stock insuffisant (${quantite(p.quantite_stock)} en stock). La vente reste possible ; pensez à régulariser le stock.` } : null);
    // Sur ordinateur (lecteur de codes-barres), le curseur revient dans la recherche ; sur téléphone,
    // on n'ouvre pas le clavier à chaque article.
    if (pointeurFin || !garderRecherche) champ.current?.focus();
  }

  function valeurSaisie() {
    const { exact, resultats, multiplicateur } = recherche;
    const choisi = exact ?? (terme.trim() ? (resultats[indexActif] ?? (resultats.length === 1 ? resultats[0] : undefined)) : undefined);
    if (choisi) ajouter(choisi, multiplicateur);
    else if (!articlesPrets) setMessage({ type: 'info', texte: 'Chargement des articles en cours… rescannez dans un instant.' });
    else if (terme.trim()) setMessage({ type: 'erreur', texte: `Aucun article pour « ${terme.trim()} ».` });
  }

  const modifierLigne = (i: number, l: Partial<LigneVente>) => setPanier((ls) => ls.map((x, j) => (j === i ? { ...x, ...l } : x)));
  const retirerLigne = (i: number) => setPanier((ls) => ls.filter((_, j) => j !== i));

  // Raccourcis : F2 recherche, F9 encaisser.
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        champ.current?.focus();
      }
      if (e.key === 'F9' && panier.length && !fenetre) {
        e.preventDefault();
        setFenetre('paiement');
      }
    };
    window.addEventListener('keydown', touche);
    return () => window.removeEventListener('keydown', touche);
  }, [panier.length, fenetre]);

  // ---------- Vente ----------

  async function imprimerVente(v: VenteLocale) {
    if (!identite) return;
    await imprimerTicket(<Recu identite={identite} vente={versRecu(v)} format={format} />);
  }

  async function encaisser(reglements: ReglementVente[]) {
    setEnregistrement(true);
    const vente: VenteLocale = {
      id: nouvelleCle(),
      organisation_id: org,
      caisse_id: caisse.id,
      session_id: sessionCaisse.id,
      magasin_nom: caisse.magasin_nom,
      caissier_nom: caissier,
      date_vente: new Date().toISOString(),
      numero_local: await prochainNumeroLocal(caisse.code, caisse.id),
      lignes: panier,
      reglements,
      total,
      origine: navigator.onLine && serveurJoignable() ? 'en_ligne' : 'hors_ligne',
      statut: 'en_attente',
      tentatives: 0,
    };
    // 1. La vente est d'abord gardée sur l'appareil : elle ne peut plus être perdue.
    await enregistrerLocalement(vente);
    // 2. Envoi immédiat si possible (8 s maximum, sinon elle partira à la synchronisation).
    let finale = vente;
    //    Serveur injoignable au dernier essai : on retente quand même, mais sans faire attendre le client.
    if (navigator.onLine) {
      const delai = serveurJoignable() ? 8000 : 2500;
      finale = await Promise.race([envoyer(vente), new Promise<VenteLocale>((ok) => setTimeout(() => ok(vente), delai))]);
    }
    setEnregistrement(false);

    if (finale.statut === 'rejetee') {
      // Refus immédiat du serveur (droit manquant, référence…) : rien n'est enregistré, le panier est rendu.
      await supprimerLocale(vente.id);
      setFenetre(null);
      setMessage({ type: 'erreur', texte: `Vente refusée : ${finale.erreur}` });
      return;
    }
    setFenetre(null);
    setPanier([]);
    setDerniere(finale);
    setMessage(null);
    if (devisImporte.current) {
      // Le devis repris en caisse devient « transformé en vente ».
      const d = devisImporte.current;
      devisImporte.current = null;
      void supabase.rpc('changer_statut_devis', { p_devis: d, p_statut: 'converti', p_vente: vente.id });
    }
    // Stock affiché mis à jour localement en attendant la prochaine actualisation.
    setProduits((ps) =>
      ps.map((p) => {
        const vendu = vente.lignes.filter((l) => l.produit_id === p.id).reduce((s, l) => s + l.quantite, 0);
        return vendu ? { ...p, quantite_stock: p.quantite_stock - vendu } : p;
      }),
    );
    void rafraichir();
    champ.current?.focus();
    if (impressionAuto) await imprimerVente(finale);
  }

  async function reimprimer(l: LigneListe) {
    if (l.locale) {
      const v = l.locale.numero || l.statut !== 'validee' ? l.locale : { ...l.locale, numero: l.numero };
      return imprimerVente(v);
    }
    // Vente faite sur un autre appareil : on relit le détail sur le serveur.
    const [lg, rg] = await Promise.all([
      supabase.from('ventes_lignes').select('produit_id, designation, quantite, prix_unitaire, remise').eq('vente_id', l.id).order('ligne'),
      supabase.from('reglements').select('moyen_id, libelle, nature, montant, montant_recu, reference, sens').eq('vente_id', l.id),
    ]);
    if (lg.error || rg.error) return setMessage({ type: 'erreur', texte: messageErreur(lg.error ?? rg.error) });
    await imprimerVente({
      id: l.id,
      organisation_id: org,
      caisse_id: caisse.id,
      session_id: sessionCaisse.id,
      magasin_nom: caisse.magasin_nom,
      caissier_nom: '',
      date_vente: l.date,
      numero_local: l.numero,
      numero: l.numero,
      lignes: (lg.data ?? []).map((x) => ({ ...x, unite: '', quantite: Number(x.quantite), prix_unitaire: Number(x.prix_unitaire), remise: Number(x.remise) })),
      reglements: (rg.data ?? []).map((x) => ({ ...x, montant: Number(x.montant), montant_recu: x.montant_recu == null ? undefined : Number(x.montant_recu), reference: x.reference ?? undefined, sens: x.sens as 'encaissement' | 'rendu' })),
      total: l.total,
      origine: 'en_ligne',
      statut: 'synchronisee',
      tentatives: 0,
    });
  }

  async function imprimerRapport(r: RapportSession) {
    if (!identite) return;
    await imprimerTicket(
      <RapportCaisse
        identite={identite}
        rapport={r}
        format={format}
        caisse={`${caisse.nom} (${caisse.code})`}
        magasin={caisse.magasin_nom}
        caissier={caissier}
        ouverteLe={sessionCaisse.ouverte_le}
      />,
    );
  }

  async function rapportX() {
    const { data, error } = await supabase.rpc('rapport_session', { p_session: sessionCaisse.id });
    if (error) return setMessage({ type: 'erreur', texte: `Rapport X indisponible : ${messageErreur(error)}` });
    await imprimerRapport(data as RapportSession);
  }

  const derniereRendu = derniere ? derniere.reglements.reduce((s, r) => s + (r.sens === 'rendu' ? 0 : Math.max(0, (r.montant_recu ?? r.montant) - r.montant)), 0) : 0;
  const derniersRendusAutres = derniere ? derniere.reglements.filter((r) => r.sens === 'rendu') : [];

  return (
    <div className="caisse">
      <div className="caisse-barre">
        <div className="caisse-titre">
          <strong>{caisse.nom}</strong>
          <span className="secondaire">
            {caisse.magasin_nom} · ouverte à {new Date(sessionCaisse.ouverte_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' })}
          </span>
        </div>
        <div className="caisse-etat">
          {enLigne ? (
            <Pastille ton="vert">
              <Ico>🟢</Ico>En ligne
            </Pastille>
          ) : (
            <Pastille ton="or">
              <Ico>📴</Ico>Hors connexion
            </Pastille>
          )}
          {enAttente > 0 && (
            <button type="button" className="bouton-lien" onClick={() => void lancerSynchro()} title="Envoyer maintenant">
              <Ico>⏳</Ico>
              {enAttente} vente{enAttente > 1 ? 's' : ''} à envoyer
            </button>
          )}
          {rejetees.length > 0 && (
            <button type="button" className="bouton-lien lien-danger" onClick={() => setFenetre('rejets')}>
              {rejetees.length} refusée{rejetees.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
        <div className="caisse-actions">
          <Link to={`/caisse/suivi?session=${sessionCaisse.id}`} className="bouton bouton-discret">
            <Ico>💼</Ico>
            Ma caisse
          </Link>
          <button type="button" className="bouton bouton-discret" onClick={() => setFenetre('ventes')}>
            <Ico>🧾</Ico>
            Ventes ({liste.filter((l) => l.statut !== 'annulee').length})
          </button>
          <button type="button" className="bouton bouton-discret" onClick={() => void rapportX()} disabled={!enLigne}>
            <Ico>📈</Ico>
            Rapport X
          </button>
          <button type="button" className="bouton bouton-discret" onClick={() => setFenetre('cloture')}>
            <Ico>🔒</Ico>
            Clôturer
          </button>
        </div>
      </div>

      {catalogueHorsLigne !== null && (
        <Alerte type="info">
          Articles et prix enregistrés sur l’appareil{catalogueHorsLigne ? ` le ${new Date(catalogueHorsLigne).toLocaleString('fr-FR', { timeZone: 'Africa/Abidjan' })}` : ''}. Les
          ventes sont gardées ici et partiront au retour du réseau.
        </Alerte>
      )}

      <div className="caisse-grille">
        <section className="carte caisse-articles">
          <div className="caisse-recherche recherche-produit">
            <div className="champ-avec-bouton">
              <input
                ref={champ}
                autoFocus
                value={terme}
                onChange={(e) => {
                  setTerme(e.target.value);
                  setIndexActif(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    valeurSaisie();
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setIndexActif((i) => Math.min(i + 1, articlesAffiches.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndexActif((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Escape') setTerme('');
                }}
                placeholder={articlesPrets ? 'Scanner ou taper le nom / le code d’un article' : 'Chargement des articles…'}
                aria-label="Article à ajouter"
                autoComplete="off"
              />
              <button type="button" className="bouton bouton-discret" onClick={() => setFenetre('scanner')} aria-label="Scanner avec la caméra">
                <Ico>📷</Ico>
                Caméra
              </button>
            </div>
          </div>
          <div className="articles-entete">
            <span>
              {terme.trim()
                ? `${articlesAffiches.length}${articlesAffiches.length >= TAILLE_LISTE ? '+' : ''} article${articlesAffiches.length > 1 ? 's' : ''} pour « ${terme.trim()} »`
                : `${produits.length} article${produits.length > 1 ? 's' : ''}`}
            </span>
            {terme && (
              <button type="button" className="bouton-lien" onClick={() => setTerme('')}>
                Effacer
              </button>
            )}
          </div>
          <ul className="liste-articles" role="listbox" aria-label="Articles">
            {articlesAffiches.map((p, i) => {
              const q = qteDansPanier(p);
              return (
                <li key={p.id} className={`article-caisse ${q > 0 ? 'dans-panier' : ''} ${terme.trim() && i === indexActif ? 'actif' : ''}`}>
                  <button type="button" className="article-corps" onMouseDown={(e) => e.preventDefault()} onClick={() => ajouter(p, recherche.multiplicateur, true)}>
                    <span className="article-nom">{p.designation}</span>
                    <span className="secondaire">
                      {p.code} · stock <span className={p.quantite_stock <= 0 ? 'texte-negatif' : ''}>{quantite(p.quantite_stock)}</span>
                    </span>
                  </button>
                  <strong className="article-prix">{montant(p.prix_vente)}</strong>
                  <ChoixQuantite valeur={q} unite={p.unite} onChange={(v) => fixerQuantite(p, v)} libelle={p.designation} />
                </li>
              );
            })}
            {articlesPrets && articlesAffiches.length === 0 && <li className="articles-vide">Aucun article pour « {terme.trim()} ».</li>}
            {articlesAffiches.length >= TAILLE_LISTE && <li className="articles-vide">Tapez quelques lettres pour affiner la liste.</li>}
          </ul>
        </section>

        <section className="carte caisse-panier">
          <div className="panier-titre">
            <strong>🧺 Panier</strong>
            <span className="secondaire">
              {panier.length} ligne{panier.length > 1 ? 's' : ''}
            </span>
          </div>
          {message && (
            <div className="message-caisse" role="status" onClick={() => setMessage(null)}>
              <Alerte type={message.type}>{message.texte}</Alerte>
            </div>
          )}

          <div className="panier-defilant">
          {panier.length === 0 ? (
            <div className="panier-vide">
              <p>Touchez un article dans la liste, ou scannez-le, pour commencer la vente.</p>
              {derniere && (
                <div className="derniere-vente">
                  <div>
                    Vente {derniere.numero ? `n° ${derniere.numero}` : `${derniere.numero_local} (hors connexion)`} : <strong>{montant(derniere.total)}</strong>
                  </div>
                  {derniereRendu > 0 && (
                    <div className="derniere-rendu">
                      Monnaie à rendre : <strong>{montant(derniereRendu)}</strong>
                    </div>
                  )}
                  {derniersRendusAutres.map((r, i) => (
                    <div key={i} className="derniere-rendu">
                      À envoyer par {r.libelle} : <strong>{montant(r.montant)}</strong>
                    </div>
                  ))}
                  <button type="button" className="bouton-lien" onClick={() => void imprimerVente(derniere)}>
                    Réimprimer le ticket
                  </button>
                </div>
              )}
            </div>
          ) : (
            <table className="tableau tableau-panier">
              <thead>
                <tr>
                  <th>Article</th>
                  <th className="nombre">Qté</th>
                  <th className="nombre">Montant</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {panier.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <button type="button" className="bouton-lien ligne-panier" onClick={() => setEdition(i)}>
                        {l.designation}
                      </button>
                      <div className="secondaire">
                        {montant(l.prix_unitaire)} / {l.unite}
                        {l.remise ? ` · remise − ${montant(l.remise)}` : ''}
                      </div>
                    </td>
                    <td className="nombre">
                      <ChoixQuantite
                        valeur={l.quantite}
                        unite={l.unite}
                        libelle={l.designation}
                        onChange={(v) => (v <= 0 ? retirerLigne(i) : modifierLigne(i, { quantite: +v.toFixed(3) }))}
                      />
                    </td>
                    <td className="nombre">{montant(Math.round(l.quantite * l.prix_unitaire) - l.remise)}</td>
                    <td>
                      <button type="button" className="bouton-icone" aria-label={`Retirer ${l.designation}`} onClick={() => retirerLigne(i)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          </div>
        </section>

        <aside className="carte caisse-total">
          <div className="total-bloc">
            <div className="total-libelle">
              Total · {quantite(nbArticles)} article{nbArticles > 1 ? 's' : ''}
            </div>
            <div className="total-montant" aria-live="polite">
              {montant(total)}
            </div>
          </div>
          <button type="button" className="bouton bouton-principal bouton-plein bouton-encaisser" disabled={!panier.length} onClick={() => setFenetre('paiement')}>
            Encaisser <kbd>F9</kbd>
          </button>
          {panier.length > 0 && (
            <button
              type="button"
              className="bouton-lien lien-danger vider-panier"
              onClick={() => window.confirm(`Vider le panier (${panier.length} ligne${panier.length > 1 ? 's' : ''}) ?`) && setPanier([])}
            >
              Vider le panier
            </button>
          )}
          <details className="caisse-options">
            <summary>⚙️ Options de la caisse</summary>
            <label className="case">
              <input
                type="checkbox"
                checked={impressionAuto}
                onChange={(e) => {
                  setImpressionAuto(e.target.checked);
                  ecrireCache('dfg_impression_auto', e.target.checked);
                }}
              />
              Imprimer le ticket après chaque vente
            </label>
            <div className="secondaire">
              Format : {format === 'a4_6' ? 'A4 ÷ 6' : format === 'thermique_58' ? 'thermique 58 mm' : 'thermique 80 mm'}
              {format === 'a4_6' && (
                <>
                  {' '}· case suivante <strong>{caseA4}</strong>{' '}
                  <button type="button" className="bouton-lien" onClick={() => setFenetre('case')}>
                    changer
                  </button>
                </>
              )}
            </div>
            <button type="button" className="bouton-lien" onClick={() => void chargerArticles()} disabled={!enLigne}>
              Actualiser les articles et les prix
            </button>
            {autresCaisses.length === 0 && (
              <button
                type="button"
                className="bouton-lien"
                onClick={() => (panier.length === 0 || window.confirm('Le panier en cours sera vidé. Changer de caisse ?')) && onChoisirCaisse('')}
              >
                ↔ Changer de caisse (la caisse reste ouverte)
              </button>
            )}
          </details>
        </aside>
      </div>

      <Fenetre titre="Encaissement" ouverte={fenetre === 'paiement'} onFermer={() => setFenetre(null)}>
        <Paiement total={total} moyens={moyens} enCours={enregistrement} onValider={(r) => void encaisser(r)} />
      </Fenetre>

      <Fenetre titre="Scanner un article" ouverte={fenetre === 'scanner'} onFermer={() => setFenetre(null)}>
        <Scanner
          onFermer={() => setFenetre(null)}
          onCode={(code) => {
            setFenetre(null);
            const { exact } = chercherLocal(produits, code);
            if (exact) ajouter(exact);
            else setMessage({ type: 'erreur', texte: `Code ${code} inconnu dans le catalogue de ce magasin.` });
          }}
        />
      </Fenetre>

      <Fenetre titre="Case de la prochaine impression" ouverte={fenetre === 'case'} onFermer={() => setFenetre(null)}>
        <p className="secondaire">Indiquez la première case libre de la feuille A4 placée dans l’imprimante.</p>
        <ChoixCase
          valeur={caseA4}
          onChange={(n) => {
            choisirCase(n);
            setFenetre(null);
          }}
        />
      </Fenetre>

      {edition !== null && panier[edition] && (
        <EditionLigne
          ligne={panier[edition]}
          remiseAutorisee={remiseAutorisee}
          prixModifiable={prixModifiable}
          onFermer={() => setEdition(null)}
          onValider={(l) => {
            modifierLigne(edition, l);
            setEdition(null);
          }}
        />
      )}

      <Fenetre titre="Ventes de la session" ouverte={fenetre === 'ventes'} onFermer={() => setFenetre(null)} large>
        {liste.length === 0 ? (
          <Vide>Aucune vente pour l’instant.</Vide>
        ) : (
          <div className="defilement-horizontal">
            <table className="tableau tableau-compact">
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Heure</th>
                  <th className="nombre">Total</th>
                  <th>État</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {liste.map((l) => (
                  <tr key={l.id} className={l.statut === 'annulee' ? 'ligne-inactive' : ''}>
                    <td className="code">{l.numero}</td>
                    <td>{new Date(l.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' })}</td>
                    <td className="nombre">{montant(l.total)}</td>
                    <td>
                      {l.statut === 'validee' && <Pastille ton="vert">Enregistrée</Pastille>}
                      {l.statut === 'annulee' && <Pastille ton="gris">Annulée</Pastille>}
                      {l.statut === 'en_attente' && <Pastille ton="or">À envoyer</Pastille>}
                      {l.statut === 'rejetee' && <Pastille ton="rouge">Refusée</Pastille>}
                    </td>
                    <td>
                      <div className="cellule-actions">
                        <button type="button" className="bouton-lien" onClick={() => void reimprimer(l)}>
                          Réimprimer
                        </button>
                        {l.statut === 'validee' && peut('ventes.annuler') && (
                          <button type="button" className="bouton-lien lien-danger" onClick={() => setAnnulation(l)}>
                            Annuler
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fenetre>

      {annulation && (
        <Annulation
          vente={annulation}
          onFermer={() => setAnnulation(null)}
          onAnnulee={() => {
            setAnnulation(null);
            setMessage({ type: 'succes', texte: `Vente ${annulation.numero} annulée, articles remis en stock.` });
            void rafraichir();
            void chargerArticles();
          }}
        />
      )}

      <Fenetre titre="Ventes refusées par le serveur" ouverte={fenetre === 'rejets'} onFermer={() => setFenetre(null)} large>
        <p className="secondaire">
          Ces ventes faites hors connexion n’ont pas été acceptées. Elles restent sur l’appareil : corrigez la cause (droit, référence…) puis
          renvoyez-les, ou faites-les contrôler par un responsable.
        </p>
        <table className="tableau tableau-compact">
          <tbody>
            {rejetees.map((v) => (
              <tr key={v.id}>
                <td className="code">{v.numero_local}</td>
                <td className="nombre">{montant(v.total)}</td>
                <td className="texte-negatif">{v.erreur}</td>
                <td>
                  <div className="cellule-actions">
                    <button type="button" className="bouton-lien" onClick={() => void imprimerVente(v)}>
                      Réimprimer
                    </button>
                    <button
                      type="button"
                      className="bouton-lien"
                      onClick={() =>
                        void reessayer(v).then(() => {
                          setFenetre(null);
                          void lancerSynchro();
                        })
                      }
                    >
                      Renvoyer
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Fenetre>

      <Fenetre titre="Clôture de la caisse" ouverte={fenetre === 'cloture'} onFermer={() => setFenetre(null)} large>
        {!enLigne ? (
          <Alerte>La clôture se fait connecté : elle calcule les totaux sur le serveur et attribue le numéro Z.</Alerte>
        ) : (
          <Cloture
            sessionId={sessionCaisse.id}
            enAttente={enAttente}
            rejetees={rejetees.length}
            onCloturee={(z) => {
              setFenetre(null);
              void imprimerRapport(z).then(onFermee);
            }}
          />
        )}
      </Fenetre>
    </div>
  );
}

function EditionLigne({
  ligne,
  remiseAutorisee,
  prixModifiable,
  onFermer,
  onValider,
}: {
  ligne: LigneVente;
  remiseAutorisee: boolean;
  prixModifiable: boolean;
  onFermer: () => void;
  onValider: (l: Partial<LigneVente>) => void;
}) {
  const [qte, setQte] = useState(String(ligne.quantite).replace('.', ','));
  const [prix, setPrix] = useState(saisieMontant(ligne.prix_unitaire));
  const [remise, setRemise] = useState(ligne.remise ? saisieMontant(ligne.remise) : '');
  const q = Number(qte.replace(',', '.'));
  const p = lireMontant(prix) ?? 0;
  const r = lireMontant(remise) ?? 0;
  const brut = Math.round(q * p);
  const erreur = !(q > 0) ? 'Quantité invalide.' : r > brut ? 'La remise dépasse le montant de la ligne.' : '';

  return (
    <Fenetre titre={ligne.designation} ouverte onFermer={onFermer}>
      <form
        className="formulaire"
        onSubmit={(e) => {
          e.preventDefault();
          if (!erreur) onValider({ quantite: +q.toFixed(3), prix_unitaire: p, remise: r });
        }}
      >
        <Champ label={`Quantité (${ligne.unite})`}>
          <input inputMode="decimal" value={qte} onChange={(e) => setQte(e.target.value)} autoFocus />
        </Champ>
        <Champ label={`Prix unitaire (${deviseCourante().symbole})`} aide={prixModifiable ? undefined : 'Modification du prix réservée aux responsables (droit « ventes.modifier »).'}>
          <input inputMode={clavierMontant()} value={prix} onChange={(e) => setPrix(e.target.value)} disabled={!prixModifiable} />
        </Champ>
        <Champ label={`Remise sur la ligne (${deviseCourante().symbole})`} aide={remiseAutorisee ? undefined : 'Remise réservée aux responsables (droit « ventes.valider »).'}>
          <input inputMode={clavierMontant()} value={remise} onChange={(e) => setRemise(e.target.value)} disabled={!remiseAutorisee} placeholder="0" />
        </Champ>
        <p>
          Montant de la ligne : <strong>{montant(Math.max(0, brut - r))}</strong>
        </p>
        <Alerte>{erreur}</Alerte>
        <button type="submit" className="bouton bouton-principal bouton-plein" disabled={!!erreur}>
          Appliquer
        </button>
      </form>
    </Fenetre>
  );
}

function Annulation({ vente, onFermer, onAnnulee }: { vente: LigneListe; onFermer: () => void; onAnnulee: () => void }) {
  const [motif, setMotif] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  async function annuler(e: React.FormEvent) {
    e.preventDefault();
    setEnCours(true);
    const { error } = await supabase.rpc('annuler_vente', { p_vente: vente.id, p_motif: motif.trim() });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    onAnnulee();
  }
  return (
    <Fenetre titre={`Annuler la vente ${vente.numero}`} ouverte onFermer={onFermer}>
      <form className="formulaire" onSubmit={(e) => void annuler(e)}>
        <p>
          Montant : <strong>{montant(vente.total)}</strong>. Les articles seront remis en stock et l’annulation inscrite au journal.
        </p>
        <Alerte>{erreur}</Alerte>
        <Champ label="Motif *">
          <textarea rows={2} maxLength={300} value={motif} onChange={(e) => setMotif(e.target.value)} autoFocus />
        </Champ>
        <button type="submit" className="bouton bouton-danger bouton-plein" disabled={motif.trim().length < 3 || enCours}>
          {enCours ? 'Annulation…' : 'Confirmer l’annulation'}
        </button>
      </form>
    </Fenetre>
  );
}

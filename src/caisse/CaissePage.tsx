import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { useIdentite } from '../lib/identite';
import { clavierMontant, deviseCourante, lireMontant, montant, saisieMontant } from '../lib/argent';
import { messageErreur } from '../lib/format';
import { nouvelleCle, quantite, useMagasins } from '../lib/stock';
import type { Caisse } from '../lib/types';
import { Alerte, Champ, EnTetePage, Fenetre, Ico, Pastille, Vide } from '../components/ui';
import { Scanner } from '../components/Scanner';
import { ChoixCase, Recu, type VenteRecu } from '../impression/Recu';
import { RapportCaisse, type RapportSession } from '../impression/RapportCaisse';
import { useImpressionCaisse } from './impressionCaisse';
import { Paiement } from './Paiement';
import { Cloture } from './Cloture';
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
export function CaissePage() {
  const { organisation, session } = useSession();
  const org = organisation!.organisation_id;
  const magasins = useMagasins(org);
  const [caisses, setCaisses] = useState<CaisseInfo[]>(() => lireCache<CaisseInfo[]>(`dfg_caisses_${org}`) ?? []);
  const [caisseId, setCaisseId] = useState<string>(() => lireCache<string>(`dfg_caisse_${org}`) ?? '');
  const [sessionCaisse, setSessionCaisse] = useState<SessionCaisse | null | undefined>(undefined);
  const [horsLigne, setHorsLigne] = useState(false);

  useEffect(() => {
    if (!magasins.length) return;
    void supabase
      .from('caisses')
      .select('*')
      .eq('organisation_id', org)
      .eq('actif', true)
      .order('code')
      .then(({ data, error }) => {
        if (error || !data) return;
        const liste = (data as Caisse[])
          .filter((c) => magasins.some((m) => m.id === c.magasin_id))
          .map((c) => ({ ...c, magasin_nom: magasins.find((m) => m.id === c.magasin_id)!.nom }));
        setCaisses(liste);
        ecrireCache(`dfg_caisses_${org}`, liste);
      });
  }, [org, magasins]);

  useEffect(() => {
    if (caisses.length && !caisses.some((c) => c.id === caisseId)) setCaisseId(caisses[0]!.id);
  }, [caisses, caisseId]);

  const caisse = caisses.find((c) => c.id === caisseId);

  const chargerSession = useCallback(async () => {
    if (!caisseId) return;
    const cle = `dfg_session_${caisseId}`;
    const { data, error } = await supabase
      .from('sessions_caisse')
      .select('id, caisse_id, magasin_id, fond_initial, ouverte_le, ouverte_par')
      .eq('caisse_id', caisseId)
      .eq('statut', 'ouverte')
      .maybeSingle();
    if (error) {
      // Sans réseau : on reprend la session ouverte connue sur cet appareil.
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

  if (!caisses.length) {
    return (
      <>
        <EnTetePage titre="Caisse" />
        <Vide>Aucune caisse active accessible. Un responsable peut en créer une dans « Magasins ».</Vide>
      </>
    );
  }
  if (!caisse || sessionCaisse === undefined) return <div className="chargement">Chargement de la caisse…</div>;

  if (!sessionCaisse) {
    return (
      <Ouverture
        org={org}
        caisses={caisses}
        caisse={caisse}
        onChoisir={choisirCaisse}
        horsLigne={horsLigne}
        onOuverte={() => void chargerSession()}
      />
    );
  }

  return (
    <PointDeVente
      key={sessionCaisse.id}
      org={org}
      caisse={caisse}
      sessionCaisse={sessionCaisse}
      caissier={session?.user.user_metadata?.nom_complet ?? session?.user.email ?? ''}
      autresCaisses={caisses.length > 1 ? caisses : []}
      onChoisirCaisse={choisirCaisse}
      onFermee={() => {
        ecrireCache(`dfg_session_${caisse.id}`, null);
        setSessionCaisse(null);
      }}
    />
  );
}

function Ouverture({
  org,
  caisses,
  caisse,
  onChoisir,
  horsLigne,
  onOuverte,
}: {
  org: string;
  caisses: CaisseInfo[];
  caisse: CaisseInfo;
  onChoisir: (id: string) => void;
  horsLigne: boolean;
  onOuverte: () => void;
}) {
  const [fond, setFond] = useState('');
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);

  async function ouvrir(e: React.FormEvent) {
    e.preventDefault();
    setEnCours(true);
    setErreur('');
    const { error } = await supabase.rpc('ouvrir_session', { p_org: org, p_caisse: caisse.id, p_fond: lireMontant(fond) ?? 0 });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    onOuverte();
  }

  return (
    <>
      <EnTetePage icone="🛒" titre="Caisse" sousTitre="Ouvrez la caisse en indiquant le fond de caisse (espèces présentes dans le tiroir)." />
      <form className="carte formulaire ouverture-caisse" onSubmit={(e) => void ouvrir(e)}>
        {horsLigne && <Alerte>Pas de connexion : l’ouverture d’une caisse doit être enregistrée sur le serveur. Réessayez une fois connecté.</Alerte>}
        <Alerte>{erreur}</Alerte>
        <Champ label="Caisse">
          <select value={caisse.id} onChange={(e) => onChoisir(e.target.value)}>
            {caisses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nom} ({c.code}) — {c.magasin_nom}
              </option>
            ))}
          </select>
        </Champ>
        <Champ label={`Fond de caisse (${deviseCourante().symbole})`} aide="Monnaie laissée dans le tiroir au début de la journée.">
          <input inputMode={clavierMontant()} value={fond} onChange={(e) => setFond(e.target.value)} placeholder="0" autoFocus />
        </Champ>
        <button type="submit" className="bouton bouton-principal bouton-plein" disabled={enCours || horsLigne}>
          {enCours ? 'Ouverture…' : 'Ouvrir la caisse'}
        </button>
      </form>
    </>
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
    return { multiplicateur, ...chercherLocal(produits, m ? m[2]! : terme) };
  }, [terme, produits]);

  function ajouter(p: ProduitCaisse, qte = 1) {
    setPanier((ls) => {
      const i = ls.findIndex((l) => l.produit_id === p.id && l.prix_unitaire === p.prix_vente && !l.remise);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, quantite: +(l.quantite + qte).toFixed(3) } : l));
      return [...ls, { produit_id: p.id, designation: p.designation, unite: p.unite, quantite: qte, prix_unitaire: p.prix_vente, remise: 0 }];
    });
    setTerme('');
    setIndexActif(0);
    setMessage(p.quantite_stock - qte < 0 ? { type: 'info', texte: `${p.designation} : stock théorique épuisé (${quantite(p.quantite_stock)}). La vente reste possible ; pensez à régulariser le stock.` } : null);
    champ.current?.focus();
  }

  function valeurSaisie() {
    const { exact, resultats, multiplicateur } = recherche;
    const choisi = exact ?? resultats[indexActif] ?? (resultats.length === 1 ? resultats[0] : undefined);
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
        <section className="carte caisse-panier">
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
                    setIndexActif((i) => Math.min(i + 1, recherche.resultats.length - 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setIndexActif((i) => Math.max(i - 1, 0));
                  } else if (e.key === 'Escape') setTerme('');
                }}
                placeholder={articlesPrets ? 'Scanner un code-barres ou chercher un article (3*code pour 3 unités)' : 'Chargement des articles…'}
                aria-label="Article à ajouter"
                autoComplete="off"
              />
              <button type="button" className="bouton bouton-discret" onClick={() => setFenetre('scanner')} aria-label="Scanner avec la caméra">
                <Ico>📷</Ico>
                Caméra
              </button>
            </div>
            {terme.trim() && !recherche.exact && recherche.resultats.length > 0 && (
              <ul className="recherche-resultats">
                {recherche.resultats.map((p, i) => (
                  <li key={p.id}>
                    <button type="button" className={i === indexActif ? 'actif' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => ajouter(p, recherche.multiplicateur)}>
                      <span>
                        {p.designation}
                        <span className="secondaire"> · {p.code} · stock {quantite(p.quantite_stock)}</span>
                      </span>
                      <strong>{montant(p.prix_vente)}</strong>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {message && <Alerte type={message.type}>{message.texte}</Alerte>}

          {panier.length === 0 ? (
            <div className="panier-vide">
              <p>Scannez un article pour commencer la vente.</p>
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
                      <div className="quantite-panier">
                        <button type="button" aria-label={`Diminuer ${l.designation}`} onClick={() => (l.quantite > 1 ? modifierLigne(i, { quantite: +(l.quantite - 1).toFixed(3) }) : retirerLigne(i))}>
                          −
                        </button>
                        <span>{quantite(l.quantite)}</span>
                        <button type="button" aria-label={`Augmenter ${l.designation}`} onClick={() => modifierLigne(i, { quantite: +(l.quantite + 1).toFixed(3) })}>
                          +
                        </button>
                      </div>
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
        </section>

        <aside className="carte caisse-total">
          <div className="total-libelle">
            Total · {quantite(nbArticles)} article{nbArticles > 1 ? 's' : ''}
          </div>
          <div className="total-montant" aria-live="polite">
            {montant(total)}
          </div>
          <button type="button" className="bouton bouton-principal bouton-plein bouton-encaisser" disabled={!panier.length} onClick={() => setFenetre('paiement')}>
            Encaisser <kbd>F9</kbd>
          </button>
          {panier.length > 0 && (
            <button type="button" className="bouton-lien lien-danger" onClick={() => setPanier([])}>
              Vider le panier
            </button>
          )}
          <div className="caisse-options">
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
            {autresCaisses.length > 0 && (
              <select className="select-compact" value={caisse.id} onChange={(e) => onChoisirCaisse(e.target.value)} aria-label="Changer de caisse">
                {autresCaisses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nom} — {c.magasin_nom}
                  </option>
                ))}
              </select>
            )}
          </div>
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

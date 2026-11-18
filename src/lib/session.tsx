import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { definirDevise } from './argent';
import { supabase } from './supabase';
import type { MonOrganisation } from './types';
import { nomAppareil } from './format';
import { estAccesEmploye } from './acces';
import { jetonAppareil, libelleAppareil, numeroSession } from './appareil';

/** Où en est cet appareil pour l'entreprise courante (appareils approuvés). */
export type StatutAppareil = 'verification' | 'libre' | 'approuve' | 'en_attente' | 'refuse' | 'revoque' | 'inconnu' | 'code_requis';
export const APPAREIL_BLOQUE: StatutAppareil[] = ['en_attente', 'refuse', 'revoque', 'code_requis'];

export interface InfoPlateforme {
  admin_existe: boolean;
  inscription_libre: boolean;
  je_suis_admin: boolean;
  creation_entreprise_possible: boolean;
  /** Demandes d'ouverture d'entreprise à traiter (administrateur général seulement). */
  demandes_en_attente?: number | null;
}

interface EtatSession {
  session: Session | null;
  /** Règles de la plateforme (administrateur général, création d'entreprise). */
  plateforme: InfoPlateforme | null;
  /** L'utilisateur est administrateur général (consultation de toutes les entreprises). */
  adminGeneral: boolean;
  /** Connexion avec un mot de passe provisoire : il doit en choisir un nouveau. */
  mdpProvisoire: boolean;
  /** Employé dont le code d'entrée est provisoire (ou absent) : il doit en choisir un. */
  codeAChoisir: boolean;
  /** Code d'entrée de 4 chiffres défini pour ce compte (sert au déverrouillage). */
  codeEntreeDefini: boolean;
  rechargerCodeEntree: () => Promise<void>;
  rechargerPlateforme: () => Promise<void>;
  chargement: boolean;
  organisations: MonOrganisation[];
  organisation: MonOrganisation | null;
  choisirOrganisation: (id: string) => void;
  rechargerOrganisations: () => Promise<void>;
  /** Vérifie un droit dans l'entreprise courante (affichage seulement : la base contrôle toujours). */
  peut: (permission: string) => boolean;
  apresConnexion: () => Promise<void>;
  deconnecter: () => Promise<void>;
  /** Cet appareil est-il approuvé pour l'entreprise courante ? */
  appareil: StatutAppareil;
  verifierAppareil: () => Promise<StatutAppareil>;
  /** Ouvre cet appareil avec une clé d'accès personnelle. Renvoie un message d'erreur, ou null. */
  debloquerAppareil: (cle: string) => Promise<string | null>;
}

const Contexte = createContext<EtatSession | null>(null);
const CLE_ORG = 'dfg_org';

export function FournisseurSession({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [chargement, setChargement] = useState(true);
  const [organisations, setOrganisations] = useState<MonOrganisation[]>([]);
  const [plateforme, setPlateforme] = useState<InfoPlateforme | null>(null);
  const [codeEntree, setCodeEntree] = useState<{ defini: boolean; provisoire: boolean } | null>(null);
  const rechargerCodeEntree = useCallback(async () => {
    const { data, error } = await supabase.rpc('mon_pin');
    // Sans réseau : on garde l'état connu (le serveur revérifie à chaque connexion).
    if (!error) setCodeEntree(data as { defini: boolean; provisoire: boolean });
  }, []);
  const [orgId, setOrgId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CLE_ORG);
    } catch {
      return null;
    }
  });

  // Évite de redessiner toute l'application quand le rafraîchissement périodique
  // ne rapporte aucun changement de droits.
  const dernierJson = useRef('');
  const appliquerOrganisations = useCallback((liste: MonOrganisation[]) => {
    const json = JSON.stringify(liste);
    if (json === dernierJson.current) return;
    dernierJson.current = json;
    setOrganisations(liste);
  }, []);

  const rechargerOrganisations = useCallback(async () => {
    const { data: s } = await supabase.auth.getSession();
    const cleCache = `dfg_orgs_${s.session?.user.id ?? ''}`;
    const { data, error } = await supabase.rpc('mes_organisations');
    if (error) {
      // Sans réseau : on reprend les droits connus lors de la dernière connexion (la base
      // revérifiera tout à la synchronisation).
      try {
        const cache = localStorage.getItem(cleCache);
        if (cache) return appliquerOrganisations(JSON.parse(cache) as MonOrganisation[]);
      } catch {
        /* cache illisible */
      }
      throw error;
    }
    appliquerOrganisations((data ?? []) as MonOrganisation[]);
    try {
      localStorage.setItem(cleCache, JSON.stringify(data ?? []));
    } catch {
      /* stockage indisponible */
    }
  }, [appliquerOrganisations]);

  // Seule la réponse la plus récente compte (deux appels peuvent se croiser à la connexion).
  const appelPlateforme = useRef(0);
  const rechargerPlateforme = useCallback(async () => {
    const numero = ++appelPlateforme.current;
    const { data: s } = await supabase.auth.getSession();
    const cleCache = `dfg_plateforme_${s.session?.user.id ?? 'anonyme'}`;
    const { data, error } = await supabase.rpc('plateforme_info');
    if (numero !== appelPlateforme.current) return;
    if (error) {
      try {
        const cache = localStorage.getItem(cleCache);
        if (cache) setPlateforme(JSON.parse(cache) as InfoPlateforme);
      } catch {
        /* cache illisible */
      }
      return;
    }
    setPlateforme(data as InfoPlateforme);
    try {
      localStorage.setItem(cleCache, JSON.stringify(data));
    } catch {
      /* stockage indisponible */
    }
  }, []);

  // undefined = pas encore d'événement reçu ; null = déconnecté.
  const utilisateurCharge = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    let actif = true;
    // supabase-js émet INITIAL_SESSION à l'abonnement, puis SIGNED_IN / SIGNED_OUT / TOKEN_REFRESHED.
    const { data } = supabase.auth.onAuthStateChange((_evenement, s) => {
      if (!actif) return;
      setSession(s);
      const uid = s?.user.id ?? null;
      if (uid === utilisateurCharge.current) return; // simple rafraîchissement du jeton
      utilisateurCharge.current = uid;
      if (!uid) {
        dernierJson.current = '';
        setOrganisations([]);
        setCodeEntree(null);
        setChargement(false);
        void rechargerPlateforme();
        return;
      }
      setChargement(true);
      // Hors du callback : supabase-js déconseille d'y attendre d'autres appels.
      setTimeout(async () => {
        // Rattache d'éventuelles invitations reçues depuis la dernière visite (ignoré sans réseau).
        await supabase.rpc('accepter_invitations').then(undefined, () => undefined);
        await Promise.all([
          rechargerOrganisations().catch(() => appliquerOrganisations([])),
          rechargerPlateforme(),
          rechargerCodeEntree().catch(() => undefined),
        ]);
        if (actif) setChargement(false);
      }, 0);
    });
    return () => {
      actif = false;
      data.subscription.unsubscribe();
    };
  }, [rechargerOrganisations, rechargerPlateforme, appliquerOrganisations, rechargerCodeEntree]);

  // Droits modifiés par le propriétaire : appliqués sur cet appareil en moins de 30 s,
  // et tout de suite au retour sur l'application ou au retour du réseau.
  const connecte = !!session;
  useEffect(() => {
    if (!connecte) return;
    const rafraichir = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      void rechargerOrganisations().catch(() => undefined);
    };
    const minuterie = window.setInterval(rafraichir, 30_000);
    const visible = () => {
      if (document.visibilityState === 'visible') rafraichir();
    };
    window.addEventListener('focus', rafraichir);
    window.addEventListener('online', rafraichir);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(minuterie);
      window.removeEventListener('focus', rafraichir);
      window.removeEventListener('online', rafraichir);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [connecte, rechargerOrganisations]);

  /**
   * Appelée une seule fois après une connexion volontaire (pas à chaque rechargement de page).
   * Le chargement des entreprises est fait par l'écouteur d'authentification ci-dessus.
   */
  const apresConnexion = useCallback(async () => {
    await supabase.rpc('enregistrer_connexion', {
      p_appareil: nomAppareil(),
      p_user_agent: navigator.userAgent,
    });
  }, []);

  const deconnecter = useCallback(async () => {
    try {
      sessionStorage.removeItem('dfg_console_vue');
    } catch {
      /* rien */
    }
    await supabase.rpc('enregistrer_deconnexion');
    // Le téléphone arrête de vérifier les commandes de cette personne.
    try {
      const jeton = localStorage.getItem('dfg_jeton_appareil');
      if (jeton) await supabase.rpc('oublier_appareil', { p_jeton: jeton });
      (window as unknown as { DFGAndroid?: { arreterVeille?: () => void } }).DFGAndroid?.arreterVeille?.();
    } catch {
      /* rien */
    }
    await supabase.auth.signOut();
    // Filet de sécurité : si une récupération de session concurrente (retour sur l'onglet)
    // a réécrit la session pendant la déconnexion, on la supprime localement.
    const { data } = await supabase.auth.getSession();
    if (data.session) await supabase.auth.signOut({ scope: 'local' });
  }, []);

  const organisation = useMemo(() => {
    const o = organisations.find((x) => x.organisation_id === orgId) ?? organisations[0] ?? null;
    // Monnaie appliquée tout de suite, avant l'affichage des pages de cette entreprise.
    definirDevise(o?.devise);
    return o;
  }, [organisations, orgId]);

  const choisirOrganisation = useCallback((id: string) => {
    setOrgId(id);
    try {
      localStorage.setItem(CLE_ORG, id);
    } catch {
      /* stockage indisponible : le choix vaut pour la session */
    }
  }, []);

  const peut = useCallback(
    (permission: string) => !!organisation && organisation.permissions.includes(permission),
    [organisation],
  );

  // --- Appareils approuvés : chaque nouvelle session doit être ouverte par un appareil reconnu.
  const [appareil, setAppareil] = useState<{ cle: string; statut: StatutAppareil } | null>(null);
  const orgCourante = organisation?.organisation_id ?? '';
  const uid = session?.user.id ?? '';
  const cleAppareil = `${uid}|${orgCourante}|${numeroSession(session?.access_token)}`;
  const verifierAppareil = useCallback(async (): Promise<StatutAppareil> => {
    if (!uid || !orgCourante) return 'libre';
    const cache = `dfg_appareil_${uid}_${orgCourante}`;
    const { data, error } = await supabase.rpc('appareil_ouvrir', { p_org: orgCourante, p_jeton: jetonAppareil(), p_libelle: libelleAppareil() });
    let statut: StatutAppareil;
    if (error) {
      // Sans réseau (caisse hors ligne) : on garde le dernier état connu ; le serveur revérifiera à la synchronisation.
      let connu: string | null = null;
      try {
        connu = localStorage.getItem(cache);
      } catch {
        /* rien */
      }
      statut = (connu as StatutAppareil | null) ?? 'libre';
    } else {
      statut = ((data as { statut?: StatutAppareil } | null)?.statut ?? 'libre') as StatutAppareil;
      // Appareil en règle : la personne a-t-elle aussi un code Telegram à saisir pour cette connexion ?
      if (statut === 'approuve' || statut === 'libre') {
        const { data: otp, error: e2 } = await supabase.rpc('otp_etat', { p_org: orgCourante });
        const o = otp as { exige?: boolean; verifie?: boolean } | null;
        if (!e2 && o?.exige && !o.verifie) statut = 'code_requis';
      }
      try {
        localStorage.setItem(cache, statut);
      } catch {
        /* rien */
      }
    }
    setAppareil({ cle: cleAppareil, statut });
    return statut;
  }, [uid, orgCourante, cleAppareil]);
  useEffect(() => {
    if (!uid || !orgCourante) return;
    void verifierAppareil();
    // Revérification régulière : une session vérifiée par code ne dure que 12 heures.
    const id = window.setInterval(() => void verifierAppareil(), 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [uid, orgCourante, cleAppareil, verifierAppareil]);
  const debloquerAppareil = useCallback(
    async (cle: string) => {
      const { data, error } = await supabase.rpc('appareil_debloquer', {
        p_org: orgCourante, p_jeton: jetonAppareil(), p_cle: cle, p_libelle: libelleAppareil(),
      });
      if (error) return error.message;
      const r = data as { statut: string; message?: string };
      if (r.statut !== 'approuve') return r.message ?? 'Clé refusée';
      await verifierAppareil();
      return null;
    },
    [orgCourante, verifierAppareil],
  );
  const statutAppareil: StatutAppareil = !uid || !orgCourante ? 'libre' : appareil?.cle === cleAppareil ? appareil.statut : 'verification';

  const valeur: EtatSession = {
    session,
    plateforme,
    adminGeneral: !!plateforme?.je_suis_admin,
    mdpProvisoire: session?.user.user_metadata?.mdp_provisoire === true,
    codeAChoisir: estAccesEmploye(session?.user.email) && !!codeEntree && (!codeEntree.defini || codeEntree.provisoire),
    codeEntreeDefini: !!codeEntree?.defini,
    rechargerCodeEntree,
    rechargerPlateforme,
    chargement,
    organisations,
    organisation,
    choisirOrganisation,
    rechargerOrganisations,
    peut,
    apresConnexion,
    deconnecter,
    appareil: statutAppareil,
    verifierAppareil,
    debloquerAppareil,
  };
  return <Contexte.Provider value={valeur}>{children}</Contexte.Provider>;
}

export function useSession(): EtatSession {
  const c = useContext(Contexte);
  if (!c) throw new Error('useSession doit être utilisé dans FournisseurSession');
  return c;
}

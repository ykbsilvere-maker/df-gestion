import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { montant } from '../lib/argent';
import { pontAndroid } from '../lib/android';
import { son } from './LucarneCommandes';

interface Evenement {
  id: number;
  action: string;
  le: string;
  objet_id: string;
  moi: boolean;
  contexte: Record<string, unknown>;
}
interface AppareilEnAttente {
  id: string;
  nom: string | null;
  libelle: string | null;
  demande_le: string;
}
interface Toast {
  cle: string;
  icone: string;
  titre: string;
  detail: string;
  lien?: string;
}

const txt = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** Une ligne lisible pour chaque activité d'une commande en ligne. */
export function texteActivite(e: Pick<Evenement, 'action' | 'contexte'>): { icone: string; titre: string; detail: string } {
  const c = e.contexte ?? {};
  const n = txt(c.numero);
  const caissiere = txt(c.caissiere);
  const par = txt(c.par);
  const client = txt(c.client);
  const mode = c.mode === 'livraison' ? 'livraison' : 'retrait';
  switch (e.action.replace('commande_web.', '')) {
    case 'recue': return { icone: '🛍️', titre: `Nouvelle commande ${n}`, detail: `${client} · ${montant(Number(c.total))} · ${mode}` };
    case 'affectee': return { icone: '✅', titre: `Commande ${n} affectée à ${caissiere}`, detail: `${client} · par ${par} · en attente de son acceptation` };
    case 'reaffectee': return { icone: '🔁', titre: `Commande ${n} confiée à ${caissiere}`, detail: `au lieu de ${txt(c.ancienne)} · par ${par}` };
    case 'desaffectee': return { icone: '↩️', titre: `Commande ${n} retirée à ${txt(c.ancienne)}`, detail: `par ${par} · à réaffecter` };
    case 'acceptee': return { icone: '👍', titre: `${caissiere || par} a accepté la commande ${n}`, detail: `${client} · rassemblement en cours` };
    case 'confirmee': return { icone: '☑️', titre: `Commande ${n} confirmée`, detail: `par ${par}` };
    case 'prete': return { icone: '📦', titre: `Commande ${n} prête`, detail: mode === 'livraison' ? `par ${par} · confirmez l’envoi` : `par ${par} · attend le client` };
    case 'en_livraison': return { icone: '🛵', titre: `Commande ${n} en livraison`, detail: `envoi confirmé par ${par}` };
    case 'livree': return { icone: '🏁', titre: `Commande ${n} ${mode === 'livraison' ? 'livrée' : 'remise au client'}`, detail: `par ${par}` };
    case 'encaissee': return { icone: '🧾', titre: `Commande ${n} encaissée — ${montant(Number(c.encaisse ?? c.total))}`, detail: `ticket ${txt(c.ticket)} · par ${caissiere || par}` };
    case 'annulee': return { icone: '❌', titre: `Commande ${n} annulée`, detail: `par ${par}${c.motif ? ` · ${txt(c.motif)}` : ''}` };
    case 'paiement_confirme': return { icone: '💳', titre: `Paiement de ${n} confirmé`, detail: `par ${par}` };
    case 'paiement_refuse': return { icone: '⚠️', titre: `Paiement de ${n} refusé`, detail: `par ${par}` };
    case 'paiement_a_verifier': return { icone: '🧐', titre: `Justificatif de paiement reçu pour ${n}`, detail: `${client} · à vérifier` };
    default: return { icone: '📋', titre: `Commande ${n}`, detail: e.action };
  }
}

/**
 * Pour la gérante principale (et la personne qui affecte) : chaque activité d'une commande en ligne,
 * dès qu'elle a lieu (affectée, acceptée, prête, envoyée, encaissée…), et les appareils à approuver.
 */
export function SuiviGerante({ org, activites, appareils }: { org: string | undefined; activites: boolean; appareils: boolean }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [enAttente, setEnAttente] = useState<AppareilEnAttente[]>([]);
  const [connexions, setConnexions] = useState<{ id: string; nom: string | null; envoye_le: string }[]>([]);
  const [masques, setMasques] = useState<string[]>([]);
  const dernier = useRef<number | null>(null);
  const vusAppareils = useRef<Set<string> | null>(null);
  const naviguer = useNavigate();

  const ajouter = useCallback((t: Toast) => {
    setToasts((l) => [...l.filter((x) => x.cle !== t.cle), t].slice(-3));
    window.setTimeout(() => setToasts((l) => l.filter((x) => x.cle !== t.cle)), 9000);
  }, []);

  useEffect(() => {
    if (!org || (!activites && !appareils)) return;
    let arret = false;
    const cle = `dfg_activites_${org}`;
    try {
      const v = localStorage.getItem(cle);
      dernier.current = v ? Number(v) : null;
    } catch {
      dernier.current = null;
    }
    vusAppareils.current = null;
    const lire = async () => {
      if (activites) {
        const { data, error } = await supabase.rpc('activites_commandes', { p_org: org, p_apres: dernier.current });
        if (!arret && !error && data) {
          const r = data as { dernier: number; evenements: Evenement[] };
          const evts = r.evenements ?? [];
          const encaissees = new Set(evts.filter((e) => e.action === 'commande_web.encaissee').map((e) => e.objet_id));
          let autrui = false;
          for (const e of evts) {
            // La nouvelle commande a déjà sa fenêtre ; « remise » + « encaissée » ne font qu'un.
            if (e.action === 'commande_web.recue') continue;
            if (e.action === 'commande_web.livree' && encaissees.has(e.objet_id)) continue;
            const t = texteActivite(e);
            ajouter({ cle: `a${e.id}`, ...t, lien: `/boutique/commandes/${e.objet_id}` });
            if (!e.moi) {
              autrui = true;
              if (document.hidden) pontAndroid()?.notifier?.(t.titre, t.detail, 0);
            }
          }
          if (autrui) son();
          dernier.current = Number(r.dernier) || dernier.current || 0;
          try {
            localStorage.setItem(cle, String(dernier.current));
          } catch {
            /* rien */
          }
        }
      }
      if (appareils) {
        const { data } = await supabase.rpc('commandes_caisse_attente', { p_org: org });
        if (arret || !data) return;
        const liste = ((data as { appareils_liste?: AppareilEnAttente[] }).appareils_liste ?? []) as AppareilEnAttente[];
        setConnexions(((data as { connexions_en_attente?: { id: string; nom: string | null; envoye_le: string }[] }).connexions_en_attente ?? []));
        const nouveaux = vusAppareils.current ? liste.filter((a) => !vusAppareils.current!.has(a.id)) : liste;
        if (nouveaux.length) {
          son();
          navigator.vibrate?.([160, 80, 160]);
          pontAndroid()?.notifier?.('Appareil à approuver', `${nouveaux[0]!.nom} demande à ouvrir DF Gestion sur un nouvel appareil.`, liste.length);
        }
        vusAppareils.current = new Set(liste.map((a) => a.id));
        setEnAttente(liste);
      }
    };
    void lire();
    const id = window.setInterval(() => void lire(), 12000);
    const tout = () => void lire();
    window.addEventListener('dfg-activite', tout);
    return () => {
      arret = true;
      window.clearInterval(id);
      window.removeEventListener('dfg-activite', tout);
    };
  }, [org, activites, appareils, ajouter]);

  async function decider(a: AppareilEnAttente, d: 'approuve' | 'refuse') {
    const { error } = await supabase.rpc('appareil_decider', { p_id: a.id, p_decision: d });
    if (error) {
      ajouter({ cle: `e${a.id}`, icone: '⚠️', titre: 'Décision non enregistrée', detail: error.message });
      return;
    }
    setEnAttente((l) => l.filter((x) => x.id !== a.id));
    ajouter({ cle: `d${a.id}`, icone: d === 'approuve' ? '✅' : '⛔', titre: d === 'approuve' ? `Appareil de ${a.nom} approuvé` : `Appareil de ${a.nom} refusé`, detail: a.libelle ?? '' });
  }

  async function autoriser(k: { id: string; nom: string | null }) {
    if (!window.confirm(`Autoriser la connexion de ${k.nom} sans son code Telegram ? Faites-le seulement si vous êtes sûre que c’est bien elle (par exemple au téléphone).`)) return;
    const { error } = await supabase.rpc('otp_autoriser', { p_code_id: k.id });
    if (error) return ajouter({ cle: `ek${k.id}`, icone: '⚠️', titre: 'Autorisation non enregistrée', detail: error.message });
    setConnexions((l) => l.filter((x) => x.id !== k.id));
    ajouter({ cle: `k${k.id}`, icone: '🔓', titre: `Connexion de ${k.nom} autorisée`, detail: 'inscrit au journal d’audit' });
  }

  const appareilsVisibles = enAttente.filter((a) => !masques.includes(a.id));
  const connexionsVisibles = connexions.filter((k) => !masques.includes(k.id));
  if (!toasts.length && !appareilsVisibles.length && !connexionsVisibles.length) return null;
  return (
    <div className="fil-suivi" aria-live="polite">
      {appareilsVisibles.slice(0, 2).map((a) => (
        <div key={a.id} className="suivi-toast suivi-appareil" role="alert">
          <span className="suivi-icone" aria-hidden>📱</span>
          <span className="suivi-texte">
            <strong>Nouvel appareil à approuver</strong>
            <span>{a.nom} — {a.libelle ?? 'appareil inconnu'}</span>
            <span className="suivi-actions">
              <button type="button" onClick={() => setMasques((m) => [...m, a.id])}>Plus tard</button>
              <button type="button" onClick={() => void decider(a, 'refuse')}>Refuser</button>
              <button type="button" className="suivi-ok" onClick={() => void decider(a, 'approuve')}>✅ Approuver</button>
            </span>
          </span>
        </div>
      ))}
      {connexionsVisibles.slice(0, 2).map((k) => (
        <div key={k.id} className="suivi-toast suivi-appareil" role="status">
          <span className="suivi-icone" aria-hidden>🔐</span>
          <span className="suivi-texte">
            <strong>{k.nom} attend son code Telegram</strong>
            <span>Si elle ne le reçoit pas, vous pouvez autoriser sa connexion.</span>
            <span className="suivi-actions">
              <button type="button" onClick={() => setMasques((m) => [...m, k.id])}>Masquer</button>
              <button type="button" className="suivi-ok" onClick={() => void autoriser(k)}>🔓 Autoriser</button>
            </span>
          </span>
        </div>
      ))}
      {toasts.map((t) => (
        <button
          key={t.cle}
          type="button"
          className="suivi-toast"
          onClick={() => {
            setToasts((l) => l.filter((x) => x.cle !== t.cle));
            if (t.lien) naviguer(t.lien);
          }}
        >
          <span className="suivi-icone" aria-hidden>{t.icone}</span>
          <span className="suivi-texte">
            <strong>{t.titre}</strong>
            <span>{t.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

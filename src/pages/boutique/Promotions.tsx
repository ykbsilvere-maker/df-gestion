import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../../lib/supabase';
import { useSession } from '../../lib/session';
import { messageErreur } from '../../lib/format';
import { clavierMontant, lireMontant, montant } from '../../lib/argent';
import { Alerte, Champ, EnTetePage, Fenetre, Pastille, Vide } from '../../components/ui';
import { marcheUrl } from './commun';
import { QrOffre } from './QrOffre';

/* ------------------------------------------------------------------------------------------
 * Codes promo de DF Marché : pour tout le monde ou réservés à un compte client, partageables.
 * ---------------------------------------------------------------------------------------- */

interface CodePromo {
  id: string;
  code: string;
  libelle: string | null;
  type: 'pourcent' | 'montant';
  valeur: number;
  minimum: number;
  debut: string | null;
  fin: string | null;
  max_utilisations: number | null;
  utilisations: number;
  compte_id: string | null;
  visible: boolean;
  actif: boolean;
  valable: boolean;
  remises: number;
  client: { nom: string; telephone: string | null; email: string } | null;
}

const vide = { id: '', code: '', libelle: '', type: 'pourcent' as 'pourcent' | 'montant', valeur: '10', minimum: '', fin: '', max: '', pour: 'tous' as 'tous' | 'client', client: '', visible: true };

function genererCode(prefixe = 'PROMO') {
  const lettres = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += lettres[Math.floor(Math.random() * lettres.length)];
  return `${prefixe.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'PROMO'}-${s}`;
}

export const texteRemise = (k: Pick<CodePromo, 'type' | 'valeur'>) => (k.type === 'pourcent' ? `−${k.valeur} %` : `−${montant(k.valeur)}`);

export function CodesPromo() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const modifier = peut('boutique.modifier');
  const [liste, setListe] = useState<CodePromo[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [nomBoutique, setNomBoutique] = useState(organisation?.nom ?? '');
  const [qr, setQr] = useState<CodePromo | null>(null);
  const [f, setF] = useState<typeof vide | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');

  const charger = useCallback(async () => {
    const [a, b] = await Promise.all([supabase.rpc('codes_promo_liste', { p_org: org }), supabase.rpc('vitrine_lire', { p_org: org })]);
    if (a.error) return setErreur(messageErreur(a.error));
    setListe(a.data as CodePromo[]);
    const v = (b.data as { vitrine: { slug: string; nom: string } | null } | null)?.vitrine;
    setSlug(v?.slug ?? null);
    if (v?.nom) setNomBoutique(v.nom);
  }, [org]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const lien = (k: CodePromo) => (slug ? marcheUrl(`/offre/${slug}/${k.code}`) : '');

  async function partager(k: CodePromo) {
    const url = lien(k);
    const texte = `🎁 ${k.libelle || 'Offre spéciale'} : ${texteRemise(k)} avec le code ${k.code}${k.minimum ? ` dès ${montant(k.minimum)} d’achats` : ''}. Commandez ici : ${url}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Offre DF Marché', text: texte });
      else {
        await navigator.clipboard?.writeText(texte);
        setInfo('Message de l’offre copié : collez-le dans WhatsApp.');
      }
    } catch {
      /* partage annulé */
    }
  }

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!f) return;
    setErreur('');
    const valeur = f.type === 'pourcent' ? Number(f.valeur) : lireMontant(f.valeur);
    if (!valeur || valeur <= 0) return setErreur('Indiquez la remise.');
    if (f.type === 'pourcent' && valeur > 90) return setErreur('90 % au plus.');
    const { error } = await supabase.rpc('code_promo_enregistrer', {
      p_org: org,
      p: {
        id: f.id || null, code: f.code, libelle: f.libelle || null, type: f.type, valeur,
        minimum: f.minimum ? lireMontant(f.minimum) ?? 0 : 0, fin: f.fin || null, max_utilisations: f.max || null,
        client: f.pour === 'client' ? f.client : null, visible: f.pour === 'tous' && f.visible, actif: true,
      },
    });
    if (error) return setErreur(messageErreur(error));
    setInfo(`Code ${f.code.toUpperCase()} enregistré.`);
    setF(null);
    await charger();
  }

  async function basculer(k: CodePromo) {
    const { error } = await supabase.rpc('code_promo_enregistrer', {
      p_org: org,
      p: { ...k, client: k.client?.email ?? null, actif: !k.actif, max_utilisations: k.max_utilisations ?? null },
    });
    if (error) return setErreur(messageErreur(error));
    await charger();
  }

  return (
    <>
      <EnTetePage
        titre="🎟️ Codes promo"
        sousTitre="Des réductions pour tous vos clients ou pour un compte précis, à partager par WhatsApp. La remise s’applique au panier et la caisse l’encaisse sans droit de remise."
        actions={modifier && <button className="bouton bouton-principal" onClick={() => setF({ ...vide, code: genererCode() })}>+ Nouveau code</button>}
      />
      {erreur && <Alerte>{erreur}</Alerte>}
      {info && <Alerte type="succes">{info}</Alerte>}
      <section className="carte">
        {!liste ? <p className="secondaire">Chargement…</p> : !liste.length ? (
          <Vide>Aucun code pour l’instant. Créez « BIENVENUE » (−10 % pour tous) ou un bon pour un client fidèle.</Vide>
        ) : (
          <div className="codes-grille">
            {liste.map((k) => (
              <article key={k.id} className={`code-carte ${k.actif ? '' : 'code-eteint'}`}>
                <div className="code-carte-haut">
                  <strong className="code-carte-remise">{texteRemise(k)}</strong>
                  {!k.actif ? <Pastille ton="gris">arrêté</Pastille> : !k.valable ? <Pastille ton="or">expiré</Pastille> : <Pastille ton="vert">actif</Pastille>}
                </div>
                <div className="code-carte-code">{k.code}</div>
                {k.libelle && <div className="code-carte-libelle">{k.libelle}</div>}
                <div className="code-carte-infos">
                  <span>{k.client ? `👤 ${k.client.nom}` : `👥 Tout le monde${k.visible ? ' · affiché' : ''}`}</span>
                  {k.minimum > 0 && <span>dès {montant(k.minimum)}</span>}
                  <span>🔁 {k.utilisations}{k.max_utilisations ? ` / ${k.max_utilisations}` : ''}</span>
                  {k.fin && <span>⏳ {new Date(k.fin).toLocaleDateString('fr-FR')}</span>}
                  {Number(k.remises) > 0 && <span>💸 {montant(k.remises)} accordés</span>}
                </div>
                <div className="code-carte-actions">
                  {slug && k.actif && (
                    <>
                      <button className="bouton bouton-principal" onClick={() => setQr(k)}>▦ QR code</button>
                      <button className="bouton bouton-discret" onClick={() => void partager(k)}>📤 Partager</button>
                    </>
                  )}
                  {modifier && (
                    <>
                      <button className="bouton-lien" onClick={() => setF({ id: k.id, code: k.code, libelle: k.libelle ?? '', type: k.type, valeur: String(k.valeur), minimum: k.minimum ? String(k.minimum) : '', fin: k.fin ?? '', max: k.max_utilisations ? String(k.max_utilisations) : '', pour: k.client ? 'client' : 'tous', client: k.client?.email ?? '', visible: k.visible })}>Modifier</button>
                      <button className="bouton-lien" onClick={() => void basculer(k)}>{k.actif ? 'Arrêter' : 'Réactiver'}</button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <Fenetre titre={qr ? `QR code · ${qr.code}` : 'QR code'} ouverte={!!qr} onFermer={() => setQr(null)}>
        {qr && slug && <QrOffre offre={qr} slug={slug} boutique={nomBoutique} client={qr.client?.nom} />}
      </Fenetre>
      <Fenetre titre={f?.id ? `Modifier ${f.code}` : 'Nouveau code promo'} ouverte={!!f} onFermer={() => setF(null)}>
        {f && (
          <form className="formulaire" onSubmit={enregistrer}>
            <div className="grille-2">
              <Champ label="Code" aide="Ce que le client saisit au panier">
                <span className="champ-avec-bouton">
                  <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} required minLength={3} maxLength={20} />
                  <button type="button" className="bouton bouton-discret" onClick={() => setF({ ...f, code: genererCode(f.libelle.split(' ')[0]) })}>🎲 Générer</button>
                </span>
              </Champ>
              <Champ label="Nom de l’offre (facultatif)"><input value={f.libelle} maxLength={80} onChange={(e) => setF({ ...f, libelle: e.target.value })} placeholder="Ex. Bienvenue, Fête des mères…" /></Champ>
            </div>
            <div className="choix-segment">
              <button type="button" className={f.type === 'pourcent' ? 'actif' : ''} onClick={() => setF({ ...f, type: 'pourcent', valeur: '10' })}>Pourcentage</button>
              <button type="button" className={f.type === 'montant' ? 'actif' : ''} onClick={() => setF({ ...f, type: 'montant', valeur: '1000' })}>Montant fixe</button>
            </div>
            <div className="grille-2">
              <Champ label={f.type === 'pourcent' ? 'Remise (%)' : 'Remise (FCFA)'}>
                <input value={f.valeur} onChange={(e) => setF({ ...f, valeur: e.target.value })} required inputMode={f.type === 'montant' ? clavierMontant() : 'numeric'} />
              </Champ>
              <Champ label="Achat minimum (FCFA)"><input value={f.minimum} onChange={(e) => setF({ ...f, minimum: e.target.value })} inputMode={clavierMontant()} placeholder="Aucun" /></Champ>
              <Champ label="Valable jusqu’au"><input type="date" value={f.fin} onChange={(e) => setF({ ...f, fin: e.target.value })} /></Champ>
              <Champ label="Nombre d’utilisations"><input value={f.max} onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="Illimité" /></Champ>
            </div>
            <p className="etiquette-form">Pour qui ?</p>
            <div className="choix-segment">
              <button type="button" className={f.pour === 'tous' ? 'actif' : ''} onClick={() => setF({ ...f, pour: 'tous' })}>👥 Tout le monde</button>
              <button type="button" className={f.pour === 'client' ? 'actif' : ''} onClick={() => setF({ ...f, pour: 'client' })}>👤 Un client (compte)</button>
            </div>
            {f.pour === 'client' ? (
              <Champ label="E-mail du compte DF Marché du client" aide="Le client doit avoir créé son compte sur le site (ou choisissez-le dans « Clients du site »). En ligne, le code n’est valable que connecté à ce compte ; en caisse, son QR code suffit.">
                <input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} required placeholder="client@mail.com" />
              </Champ>
            ) : (
              <label className="case"><input type="checkbox" checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} /> Afficher l’offre sur le site (« Bons d’achat » des clients). Sinon, seuls ceux qui ont le code ou le lien en profitent.</label>
            )}
            <button className="bouton bouton-principal">Enregistrer</button>
          </form>
        )}
      </Fenetre>
    </>
  );
}

/* ------------------------------------------------------------------------------------------
 * Mettre un produit en solde depuis « Produits en ligne » (même solde que le module Soldes).
 * ---------------------------------------------------------------------------------------- */

const aujourdhui = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dans = (j: number) => new Date(Date.now() + j * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export function MettreEnSolde({ org, produit, onFait, onFermer }: {
  org: string;
  produit: { id: string; designation: string; prix_vente: number } | null;
  onFait: (message: string) => void;
  onFermer: () => void;
}) {
  const [pct, setPct] = useState(15);
  const [prix, setPrix] = useState('');
  const [fin, setFin] = useState(dans(7));
  const [erreur, setErreur] = useState('');
  useEffect(() => {
    if (produit) {
      setPct(15);
      setPrix(String(Math.round((Number(produit.prix_vente) * 0.85) / 25) * 25));
      setFin(dans(7));
      setErreur('');
    }
  }, [produit]);
  if (!produit) return null;
  const normal = Number(produit.prix_vente);
  const choisirPct = (p: number) => {
    setPct(p);
    setPrix(String(Math.max(0, Math.round((normal * (100 - p)) / 100 / 25) * 25)));
  };
  async function valider(e: FormEvent) {
    e.preventDefault();
    const p = lireMontant(prix);
    if (p === null || p >= normal) return setErreur('Le prix de solde doit être inférieur au prix normal.');
    const { data, error } = await supabase.rpc('creer_promotion', { p_org: org, p_produit: produit!.id, p_prix: p, p_debut: aujourdhui(), p_fin: fin, p_motif: 'Solde DF Marché' });
    if (error) return setErreur(messageErreur(error));
    onFait((data as { statut: string }).statut === 'active'
      ? `« ${produit!.designation} » est en solde à ${montant(p)} jusqu’au ${new Date(fin).toLocaleDateString('fr-FR')} : bannière et compte à rebours sur le site, prix appliqué en caisse.`
      : 'Solde proposé : il s’appliquera dès que le propriétaire le valide (module Soldes).');
  }
  return (
    <Fenetre titre={`🔥 Mettre en solde — ${produit.designation}`} ouverte onFermer={onFermer}>
      <form className="formulaire" onSubmit={valider}>
        {erreur && <Alerte>{erreur}</Alerte>}
        <p>Prix normal : <strong>{montant(normal)}</strong></p>
        <div className="choix-segment">
          {[10, 15, 20, 25, 30, 50].map((p) => (
            <button type="button" key={p} className={pct === p ? 'actif' : ''} onClick={() => choisirPct(p)}>−{p} %</button>
          ))}
        </div>
        <div className="grille-2">
          <Champ label="Prix de solde (FCFA)"><input value={prix} onChange={(e) => { setPrix(e.target.value); setPct(0); }} inputMode={clavierMontant()} required /></Champ>
          <Champ label="Jusqu’au">
            <input type="date" value={fin} min={aujourdhui()} onChange={(e) => setFin(e.target.value)} required />
          </Champ>
        </div>
        <div className="choix-segment">
          {[[3, '3 jours'], [7, '1 semaine'], [14, '2 semaines'], [30, '1 mois']].map(([j, t]) => (
            <button type="button" key={t} className={fin === dans(Number(j)) ? 'actif' : ''} onClick={() => setFin(dans(Number(j)))}>{t}</button>
          ))}
        </div>
        <button className="bouton bouton-principal">Mettre en solde</button>
      </form>
    </Fenetre>
  );
}

/* ------------------------------------------------------------------------------------------
 * Alerte de la caisse : nouvelle commande en ligne à valider / remettre (son + vibration).
 * ---------------------------------------------------------------------------------------- */


/** Nombre de commandes en ligne qui attendent à la caisse ; sonne quand il augmente. */
export function useAlerteCommandes(org: string, actif: boolean): { nombre: number; enAttente: number; nouvelle: boolean; vu: () => void } {
  const [nombre, setNombre] = useState(0);
  const [enAttente, setEnAttente] = useState(0);
  const [nouvelle, setNouvelle] = useState(false);
  const precedent = useRef<number | null>(null);
  useEffect(() => {
    if (!actif) return;
    let arret = false;
    const verifier = async () => {
      const { data } = await supabase.rpc('commandes_caisse_attente', { p_org: org });
      if (arret || !data) return;
      const d = data as { nombre: number; a_affecter?: number; en_attente?: number; gerante?: boolean };
      // Mes commandes affectées + celles qui attendent (à affecter pour la gérante, en attente pour la caissière).
      const attente = Number(d.gerante ? d.a_affecter : d.en_attente) || 0;
      const n = (Number(d.nombre) || 0) + attente;
      setEnAttente(attente);
      if (precedent.current !== null && n > precedent.current) {
        // Le son et la notification viennent de la fenêtre globale (LucarneCommandes).
        setNouvelle(true);
      }
      precedent.current = n;
      setNombre(n);
    };
    void verifier();
    const t = window.setInterval(() => void verifier(), 20000);
    return () => {
      arret = true;
      window.clearInterval(t);
    };
  }, [org, actif]);
  return { nombre, enAttente, nouvelle, vu: () => setNouvelle(false) };
}

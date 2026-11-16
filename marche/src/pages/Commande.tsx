import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { appeler, supabase, erreurLisible, type FicheBoutique, type Paiement } from '../api';
import { Chargement, Erreur, ImageProduit, LogoBoutique, fcfa, usePhotos } from '../composants';
import { changerQuantite, clientMemorise, memoriserClient, memoriserCommande, usePanier, viderBoutique } from '../panier';

export const LIBELLES_PAIEMENT: Record<Paiement, { libelle: string; couleur: string; champ?: 'numero_wave' | 'numero_orange' | 'numero_mtn' | 'numero_moov' }> = {
  livraison: { libelle: 'À la livraison', couleur: '#555' },
  wave: { libelle: 'Wave', couleur: '#1dc8f2', champ: 'numero_wave' },
  orange_money: { libelle: 'Orange Money', couleur: '#ff7900', champ: 'numero_orange' },
  mtn: { libelle: 'MTN MoMo', couleur: '#ffcb05', champ: 'numero_mtn' },
  moov: { libelle: 'Moov Money', couleur: '#0066b3', champ: 'numero_moov' },
};

/** Envoie la capture du paiement (image réduite) puis la rattache à la commande. */
export async function envoyerJustificatif(commandeId: string, code: string, f: File): Promise<void> {
  let corps: Blob = f;
  let ext = f.type === 'application/pdf' ? 'pdf' : 'jpg';
  if (f.type.startsWith('image/')) {
    const img = await createImageBitmap(f);
    const r = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * r);
    c.height = Math.round(img.height * r);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    corps = await new Promise<Blob>((ok, ko) => c.toBlob((b) => (b ? ok(b) : ko(new Error('Image illisible'))), 'image/jpeg', 0.85));
    ext = 'jpg';
  }
  const chemin = `${commandeId}/paiement-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('justificatifs').upload(chemin, corps, { contentType: ext === 'pdf' ? 'application/pdf' : 'image/jpeg' });
  if (error) throw new Error(erreurLisible(error));
  await appeler('joindre_justificatif', { p_code: code, p_chemin: chemin });
}

export function Panier() {
  const panier = usePanier();
  const boutiques = Object.values(panier);
  const urls = usePhotos(boutiques.flatMap((b) => b.articles.map((a) => a.photo)));
  useEffect(() => {
    document.title = 'Mon panier — DF Marché';
  }, []);
  if (!boutiques.length)
    return (
      <section className="bloc vide-panier">
        <p aria-hidden className="grand-emoji">🛒</p>
        <h1>Votre panier est vide</h1>
        <p><Link className="bouton bouton-principal" to="/boutiques">Choisir une boutique</Link></p>
      </section>
    );
  return (
    <section className="rayon">
      <div className="rayon-titre"><h1>Mon panier</h1></div>
      {boutiques.length > 1 && <p className="secondaire">Vos articles viennent de {boutiques.length} boutiques : chaque boutique prépare et livre sa commande.</p>}
      {boutiques.map((b) => {
        const total = b.articles.reduce((s, a) => s + a.prix * a.quantite, 0);
        return (
          <div key={b.slug} className="bloc panier-boutique">
            <h2><Link to={`/boutique/${b.slug}`}>🏪 {b.nom}</Link></h2>
            <ul className="lignes-panier">
              {b.articles.map((a) => (
                <li key={a.id}>
                  <ImageProduit url={a.photo ? urls[a.photo] : undefined} alt="" />
                  <div>
                    <Link to={`/produit/${a.id}`}>{a.designation}</Link>
                    <small>{fcfa(a.prix)}{a.prix < a.prix_normal && <s> {fcfa(a.prix_normal)}</s>}</small>
                  </div>
                  <div className="quantite petite">
                    <button onClick={() => changerQuantite(b.slug, a.id, a.quantite - 1)} aria-label="Moins">−</button>
                    <span>{a.quantite}</span>
                    <button onClick={() => changerQuantite(b.slug, a.id, a.quantite + 1)} aria-label="Plus" disabled={a.quantite >= a.disponible}>+</button>
                  </div>
                  <strong>{fcfa(a.prix * a.quantite)}</strong>
                </li>
              ))}
            </ul>
            <div className="panier-pied">
              <button className="bouton-lien" onClick={() => viderBoutique(b.slug)}>Vider</button>
              <span>Articles : <strong>{fcfa(total)}</strong></span>
              <Link className="bouton bouton-principal" to={`/commander/${b.slug}`}>Commander chez {b.nom} →</Link>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** Format attendu par <input type="datetime-local"> (heure locale). */
const versSaisie = (d: Date) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 16);
};

export function Commander() {
  const { slug } = useParams();
  const naviguer = useNavigate();
  const panier = usePanier();
  const b = slug ? panier[slug] : undefined;
  const [v, setV] = useState<FicheBoutique | null>(null);
  const memo = useMemo(() => clientMemorise(), []);
  const [f, setF] = useState({
    nom: memo.nom ?? '', telephone: memo.telephone ?? '', email: memo.email ?? '', mode: '' as '' | 'livraison' | 'retrait', zone: '',
    adresse: memo.adresse ?? '', repere: memo.repere ?? '', quand: 'vite' as 'vite' | 'choisir', souhaite: '', note: '',
    paiement: '' as '' | Paiement, payeur: '', reference: '',
  });
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [fichier, setFichier] = useState<File | null>(null);
  const [erreur, setErreur] = useState('');
  const [enCours, setEnCours] = useState(false);
  const urls = usePhotos(b?.articles.map((a) => a.photo) ?? []);

  useEffect(() => {
    if (!slug) return;
    appeler<FicheBoutique>('marche_boutique', { p_slug: slug })
      .then((x) => {
        setV(x);
        setF((y) => ({
          ...y,
          mode: y.mode || (x.livraison ? 'livraison' : 'retrait'),
          paiement: y.paiement || (x.paiement_livraison ? 'livraison' : x.numero_wave ? 'wave' : x.numero_orange ? 'orange_money' : x.numero_mtn ? 'mtn' : 'moov'),
        }));
      })
      .catch((e: Error) => setErreur(e.message));
    document.title = 'Finaliser la commande — DF Marché';
  }, [slug]);

  if (!b) return <section className="bloc"><p>Ce panier est vide.</p><Link to="/panier">← Retour au panier</Link></section>;
  if (!v) return erreur ? <Erreur>{erreur}</Erreur> : <Chargement />;

  const zone = v.zones?.find((z) => z.id === f.zone);
  const sousTotal = b.articles.reduce((s, a) => s + a.prix * a.quantite, 0);
  const frais = f.mode === 'livraison' ? Number(zone?.frais ?? 0) : 0;
  const total = sousTotal + frais;
  const moyens = (Object.keys(LIBELLES_PAIEMENT) as Paiement[]).filter((k) => (k === 'livraison' ? v.paiement_livraison : !!v[LIBELLES_PAIEMENT[k].champ!]));
  const numero = f.paiement && f.paiement !== 'livraison' ? (v[LIBELLES_PAIEMENT[f.paiement].champ!] as string | null) : null;
  const minimum = new Date(Date.now() + Math.max(1, v.delai_preparation) * 3600000);
  const maj = (x: Partial<typeof f>) => setF((y) => ({ ...y, ...x }));

  function localiser() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setPosition({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }),
      () => setErreur('Position refusée : décrivez simplement l’adresse et un repère.'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  async function valider(e: FormEvent) {
    e.preventDefault();
    setErreur('');
    if (f.mode === 'livraison' && !f.zone) return setErreur('Choisissez votre zone de livraison.');
    if (f.paiement && f.paiement !== 'livraison' && !fichier && !f.reference.trim())
      return setErreur('Joignez la capture du paiement (ou au moins la référence de la transaction).');
    setEnCours(true);
    try {
      const r = await appeler<{ id: string; numero: string; code_suivi: string; total: number }>('passer_commande', {
        p: {
          boutique: slug, client_nom: f.nom, client_telephone: f.telephone, client_email: f.email || null, mode: f.mode,
          zone_id: f.mode === 'livraison' ? f.zone : null, adresse: f.mode === 'livraison' ? f.adresse : null, repere: f.repere || null,
          latitude: position?.lat ?? null, longitude: position?.lng ?? null,
          souhaite_le: f.quand === 'choisir' && f.souhaite ? new Date(f.souhaite).toISOString() : null,
          note: f.note || null, paiement: f.paiement, numero_payeur: f.paiement === 'livraison' ? null : f.payeur,
          reference_paiement: f.reference || null,
          lignes: b!.articles.map((a) => ({ produit_id: a.id, quantite: a.quantite })),
        },
      });
      memoriserClient({ nom: f.nom, telephone: f.telephone, email: f.email, adresse: f.adresse, repere: f.repere });
      memoriserCommande({ code: r.code_suivi, numero: r.numero, boutique: v!.nom, total: r.total, date: new Date().toISOString() });
      let suite = '?nouvelle=1';
      if (fichier) {
        try {
          await envoyerJustificatif(r.id, r.code_suivi, fichier);
        } catch {
          suite += '&justificatif=echec';
        }
      }
      viderBoutique(slug!);
      naviguer(`/suivi/${r.code_suivi}${suite}`);
    } catch (x) {
      setErreur((x as Error).message);
      setEnCours(false);
    }
  }

  return (
    <form className="commande" onSubmit={valider}>
      <div className="commande-etapes">
        <h1>Finaliser la commande</h1>
        <div className="bloc">
          <h2>1. Vos coordonnées</h2>
          <div className="champs-2">
            <label>Nom et prénoms<input value={f.nom} onChange={(e) => maj({ nom: e.target.value })} required minLength={2} maxLength={80} autoComplete="name" /></label>
            <label>Téléphone (WhatsApp de préférence)<input value={f.telephone} onChange={(e) => maj({ telephone: e.target.value })} required inputMode="tel" autoComplete="tel" placeholder="07 00 00 00 00" /></label>
          </div>
          <label>E-mail (facultatif)<input type="email" value={f.email} onChange={(e) => maj({ email: e.target.value })} autoComplete="email" /></label>
        </div>

        <div className="bloc">
          <h2>2. Livraison ou retrait</h2>
          <div className="choix-cartes">
            {v.livraison && (
              <button type="button" className={f.mode === 'livraison' ? 'actif' : ''} onClick={() => maj({ mode: 'livraison' })}>
                <span aria-hidden>🛵</span><strong>Livraison</strong><small>{v.zones?.length ? `dès ${fcfa(Math.min(...v.zones.map((z) => Number(z.frais))))}` : ''}</small>
              </button>
            )}
            {v.retrait && (
              <button type="button" className={f.mode === 'retrait' ? 'actif' : ''} onClick={() => maj({ mode: 'retrait' })}>
                <span aria-hidden>🏪</span><strong>Retrait en boutique</strong><small>Gratuit · {v.commune ?? v.adresse ?? ''}</small>
              </button>
            )}
          </div>
          {f.mode === 'livraison' && (
            <>
              <label>Zone de livraison
                <select value={f.zone} onChange={(e) => maj({ zone: e.target.value })} required>
                  <option value="">Choisir votre commune ou quartier…</option>
                  {v.zones?.map((z) => <option key={z.id} value={z.id}>{z.nom} — {fcfa(z.frais)}{z.delai ? ` · ${z.delai}` : ''}</option>)}
                </select>
              </label>
              <div className="champs-2">
                <label>Adresse<input value={f.adresse} onChange={(e) => maj({ adresse: e.target.value })} required minLength={3} maxLength={200} placeholder="Rue, résidence, n° de porte" /></label>
                <label>Repère<input value={f.repere} onChange={(e) => maj({ repere: e.target.value })} maxLength={200} placeholder="Derrière la pharmacie, portail bleu…" /></label>
              </div>
              <button type="button" className="bouton" onClick={localiser}>{position ? '📍 Position partagée ✓' : '📍 Partager ma position (aide le livreur)'}</button>
            </>
          )}
          {f.mode === 'retrait' && <p className="secondaire">À récupérer : {[v.adresse, v.commune, v.ville].filter(Boolean).join(', ')}{v.horaires ? ` · ${v.horaires}` : ''}</p>}
          <h3>Quand ?</h3>
          <div className="choix-cartes petites">
            <button type="button" className={f.quand === 'vite' ? 'actif' : ''} onClick={() => maj({ quand: 'vite' })}>Dès que possible <small>prêt en {v.delai_preparation} h environ</small></button>
            <button type="button" className={f.quand === 'choisir' ? 'actif' : ''} onClick={() => maj({ quand: 'choisir', souhaite: f.souhaite || versSaisie(minimum) })}>Choisir le jour et l’heure</button>
          </div>
          {f.quand === 'choisir' && (
            <label>{f.mode === 'livraison' ? 'Livraison souhaitée le' : 'Retrait prévu le'}
              <input type="datetime-local" value={f.souhaite} min={versSaisie(minimum)} onChange={(e) => maj({ souhaite: e.target.value })} required />
            </label>
          )}
          <label>Note pour la boutique (facultatif)<textarea rows={2} value={f.note} onChange={(e) => maj({ note: e.target.value })} maxLength={500} /></label>
        </div>

        <div className="bloc">
          <h2>3. Paiement</h2>
          <div className="choix-cartes paiements">
            {moyens.map((k) => (
              <button type="button" key={k} className={f.paiement === k ? 'actif' : ''} style={{ borderLeftColor: LIBELLES_PAIEMENT[k].couleur }} onClick={() => maj({ paiement: k })}>
                <strong>{LIBELLES_PAIEMENT[k].libelle}</strong>
                <small>{k === 'livraison' ? (f.mode === 'retrait' ? 'Vous payez au retrait' : 'Vous payez au livreur') : 'Transfert direct à la boutique'}</small>
              </button>
            ))}
          </div>
          {f.paiement && f.paiement !== 'livraison' && numero && (
            <div className="instructions-paiement">
              <p>
                Envoyez <strong>{fcfa(total)}</strong> par <strong>{LIBELLES_PAIEMENT[f.paiement].libelle}</strong> au{' '}
                <strong className="numero">{numero}</strong> ({v.beneficiaire}).
              </p>
              <p className="secondaire">Ne communiquez jamais votre code secret : la boutique n’en a pas besoin. La commande est confirmée dès que la boutique voit le paiement.</p>
              <div className="champs-2">
                <label>Numéro qui a payé<input value={f.payeur} onChange={(e) => maj({ payeur: e.target.value })} required inputMode="tel" placeholder="07 00 00 00 00" /></label>
                <label>Référence de la transaction (facultatif)<input value={f.reference} onChange={(e) => maj({ reference: e.target.value })} maxLength={60} /></label>
              </div>
              <label className="depot">
                <input type="file" accept="image/*,application/pdf" onChange={(e) => setFichier(e.target.files?.[0] ?? null)} />
                <span>{fichier ? `📎 ${fichier.name}` : '📎 Joindre la capture du paiement'}</span>
              </label>
            </div>
          )}
        </div>
      </div>

      <aside className="recap">
        <div className="bloc">
          <div className="recap-boutique"><LogoBoutique v={v} /><strong>{v.nom}</strong></div>
          <ul className="recap-lignes">
            {b.articles.map((a) => (
              <li key={a.id}>
                <ImageProduit url={a.photo ? urls[a.photo] : undefined} alt="" />
                <span>{a.quantite} × {a.designation}</span>
                <strong>{fcfa(a.prix * a.quantite)}</strong>
              </li>
            ))}
          </ul>
          <dl className="recap-totaux">
            <dt>Articles</dt><dd>{fcfa(sousTotal)}</dd>
            {f.mode === 'livraison' && <><dt>Livraison {zone ? `(${zone.nom})` : ''}</dt><dd>{zone ? fcfa(frais) : '—'}</dd></>}
            <dt className="total">Total</dt><dd className="total">{fcfa(total)}</dd>
          </dl>
          {sousTotal < v.commande_minimum && <p className="alerte">Commande minimum : {fcfa(v.commande_minimum)}.</p>}
          {erreur && <p className="alerte" role="alert">{erreur}</p>}
          <button className="bouton bouton-principal large" disabled={enCours || sousTotal < v.commande_minimum}>
            {enCours ? 'Envoi…' : `Commander · ${fcfa(total)}`}
          </button>
          <p className="secondaire petit">En commandant, vous acceptez d’être contacté par la boutique au sujet de cette commande.</p>
        </div>
        <p><Link to="/panier">← Modifier le panier</Link></p>
      </aside>
    </form>
  );
}

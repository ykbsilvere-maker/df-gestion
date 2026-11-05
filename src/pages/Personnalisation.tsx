import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { appliquerCouleur, COULEURS, urlPublique, useIdentite, type Identite } from '../lib/identite';
import { deposerImage, reduireImage, supprimerImage } from '../lib/images';
import { messageErreur } from '../lib/format';
import { REGIMES, type FormatRecu, type Organisation, type ParametresImpression } from '../lib/types';
import { Alerte, Champ, EnTetePage } from '../components/ui';
import { ChoixCase, FeuilleA4Six, Recu, venteExemple } from '../impression/Recu';
import { caseSuivante, memoriserCaseSuivante, useImpression } from '../impression/impression';
import { MoyensReglement } from '../caisse/MoyensReglement';
import { ChoixDevise } from '../components/ChoixDevise';

const FORMATS: { code: FormatRecu; libelle: string; aide: string }[] = [
  { code: 'a4_6', libelle: 'A4 divisé en 6', aide: 'Imprimante de bureau. 6 reçus de 105 × 99 mm par feuille.' },
  { code: 'thermique_80', libelle: 'Ticket 80 mm', aide: 'Imprimante thermique, rouleau de 80 mm.' },
  { code: 'thermique_58', libelle: 'Ticket 58 mm', aide: 'Petite imprimante thermique, rouleau de 58 mm.' },
];

export function Personnalisation() {
  const { organisation: membre, peut, rechargerOrganisations, session } = useSession();
  const { identite, recharger } = useIdentite();
  const { imprimer } = useImpression();
  const modifiable = peut('administration.modifier');
  const [o, setO] = useState<Organisation | null>(null);
  const [p, setP] = useState<ParametresImpression | null>(null);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [logoEnvoi, setLogoEnvoi] = useState(false);
  const [caseTest, setCaseTest] = useState(1);
  const fichierRef = useRef<HTMLInputElement>(null);
  const [deviseLibre, setDeviseLibre] = useState<boolean | null>(null);

  useEffect(() => {
    if (identite) {
      setO(identite.organisation);
      setP(identite.parametres);
      setCaseTest(caseSuivante(identite.organisation.id));
    }
  }, [identite]);

  // La monnaie n'est modifiable que tant qu'aucun article ni aucune opération n'existe.
  const orgId = identite?.organisation.id;
  useEffect(() => {
    if (!orgId) return;
    void supabase.rpc('devise_modifiable', { p_org: orgId }).then(({ data, error }) => setDeviseLibre(error ? false : !!data));
  }, [orgId]);

  // Aperçu en direct : les changements non enregistrés sont visibles immédiatement.
  const apercu: Identite | null = useMemo(
    () => (o && p ? { organisation: o, parametres: p, logoUrl: urlPublique('logos', o.logo_path) } : null),
    [o, p],
  );
  const vente = useMemo(
    () => venteExemple('Magasin principal', session?.user.user_metadata?.nom_complet ?? 'Caissier'),
    [session],
  );

  if (!o || !p || !apercu || !membre) return <EnTetePage icone="🎨" titre="Personnalisation" sousTitre="Chargement…" />;

  const majO = (cle: keyof Organisation) => (e: { target: { value: string } }) => setO({ ...o, [cle]: e.target.value });
  const majP = <K extends keyof ParametresImpression>(cle: K, v: ParametresImpression[K]) => setP({ ...p, [cle]: v });

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (!o || !p || envoi) return;
    setEnvoi(true);
    setErreur('');
    setInfo('');
    const r1 = await supabase
      .from('organisations')
      .update({
        nom: o.nom.trim(),
        ncc: o.ncc?.trim() || null,
        rccm: o.rccm?.trim() || null,
        regime_fiscal: o.regime_fiscal,
        telephone: o.telephone?.trim() || null,
        email: o.email?.trim() || null,
        adresse: o.adresse?.trim() || null,
        ville: o.ville?.trim() || null,
        couleur: o.couleur,
        ...(deviseLibre ? { devise: o.devise } : {}),
      })
      .eq('id', o.id);
    const r2 = r1.error
      ? r1
      : await supabase
          .from('parametres_impression')
          .update({
            format: p.format,
            afficher_logo: p.afficher_logo,
            entete: p.entete?.trim() || null,
            pied: p.pied?.trim() || null,
            mention_legale: p.mention_legale?.trim() || null,
            afficher_caissier: p.afficher_caissier,
            afficher_ncc: p.afficher_ncc,
            decalage_x_mm: Number(p.decalage_x_mm) || 0,
            decalage_y_mm: Number(p.decalage_y_mm) || 0,
          })
          .eq('organisation_id', o.id);
    setEnvoi(false);
    if (r2.error) return setErreur(messageErreur(r2.error));
    setInfo('Personnalisation enregistrée.');
    await Promise.all([recharger(), rechargerOrganisations()]);
  }

  async function changerLogo(fichier: File | undefined) {
    if (!fichier || !o) return;
    setErreur('');
    setInfo('');
    setLogoEnvoi(true);
    try {
      const blob = await reduireImage(fichier, 600, 'image/png');
      const chemin = await deposerImage('logos', o.id, 'logo', blob);
      const { error } = await supabase.from('organisations').update({ logo_path: chemin }).eq('id', o.id);
      if (error) throw error;
      await supprimerImage('logos', o.logo_path);
      setO({ ...o, logo_path: chemin });
      await recharger();
      setInfo('Logo mis à jour.');
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setLogoEnvoi(false);
      if (fichierRef.current) fichierRef.current.value = '';
    }
  }

  async function retirerLogo() {
    if (!o?.logo_path) return;
    const { error } = await supabase.from('organisations').update({ logo_path: null }).eq('id', o.id);
    if (error) return setErreur(messageErreur(error));
    await supprimerImage('logos', o.logo_path);
    setO({ ...o, logo_path: null });
    await recharger();
  }

  async function imprimerTest() {
    if (!apercu || !o || !p) return;
    if (p.format === 'a4_6') {
      let double = false;
      await imprimer(
        <FeuilleA4Six
          caseNumero={caseTest}
          decalageX={Number(p.decalage_x_mm) || 0}
          decalageY={Number(p.decalage_y_mm) || 0}
          onMesure={(m) => (double = m.double)}
        >
          <Recu identite={apercu} vente={vente} format="a4_6" />
        </FeuilleA4Six>,
        'a4',
      );
      memoriserCaseSuivante(o.id, caseTest, double);
      setCaseTest(caseSuivante(o.id));
    } else {
      await imprimer(<Recu identite={apercu} vente={vente} format={p.format} />, 'thermique');
    }
  }

  return (
    <>
      <EnTetePage
        titre="Personnalisation"
        sousTitre="Votre logo, vos informations et votre modèle de reçu. Chaque entreprise configure le logiciel à son image."
      />
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>

      <div className="grille-personnalisation">
        <form className="colonne-formulaire" onSubmit={enregistrer}>
          <fieldset disabled={!modifiable} className="sans-bordure">
            <section className="carte formulaire">
              <h2>Logo</h2>
              <div className="logo-zone">
                <div className="logo-apercu">
                  {apercu.logoUrl ? <img src={apercu.logoUrl} alt="Logo actuel" /> : <span>Aucun logo</span>}
                </div>
                <div className="logo-actions">
                  <input
                    ref={fichierRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(e) => void changerLogo(e.target.files?.[0])}
                    hidden
                    id="fichier-logo"
                  />
                  <button type="button" className="bouton bouton-discret" disabled={logoEnvoi} onClick={() => fichierRef.current?.click()}>
                    {logoEnvoi ? 'Envoi…' : apercu.logoUrl ? 'Changer le logo' : 'Téléverser un logo'}
                  </button>
                  {apercu.logoUrl && (
                    <button type="button" className="bouton-lien lien-danger" onClick={() => void retirerLogo()}>
                      Retirer
                    </button>
                  )}
                  <span className="champ-aide">PNG, JPEG ou WebP. Fond transparent conseillé. Réduit automatiquement.</span>
                </div>
              </div>
            </section>

            <section className="carte formulaire">
              <h2>Informations de l’entreprise</h2>
              <Champ label="Nom commercial">
                <input value={o.nom} onChange={majO('nom')} required minLength={2} maxLength={120} />
              </Champ>
              <div className="grille-2">
                <Champ label="NCC">
                  <input value={o.ncc ?? ''} onChange={majO('ncc')} maxLength={20} />
                </Champ>
                <Champ label="RCCM">
                  <input value={o.rccm ?? ''} onChange={majO('rccm')} maxLength={40} placeholder="CI-ABJ-…" />
                </Champ>
                <Champ label="Régime d’imposition">
                  <select value={o.regime_fiscal} onChange={majO('regime_fiscal')}>
                    {REGIMES.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.libelle}
                      </option>
                    ))}
                  </select>
                </Champ>
                <Champ label="Téléphone">
                  <input value={o.telephone ?? ''} onChange={majO('telephone')} inputMode="tel" />
                </Champ>
                <Champ label="E-mail">
                  <input type="email" value={o.email ?? ''} onChange={majO('email')} />
                </Champ>
                <Champ label="Ville">
                  <input value={o.ville ?? ''} onChange={majO('ville')} />
                </Champ>
              </div>
              <Champ label="Adresse">
                <input value={o.adresse ?? ''} onChange={majO('adresse')} placeholder="Quartier, rue, repère" />
              </Champ>
              <Champ
                label="💱 Monnaie"
                aide={
                  deviseLibre
                    ? 'Tous les prix, tickets et rapports seront dans cette monnaie. Choix possible tant qu’aucun article n’est créé.'
                    : 'Monnaie fixée : des articles ou des opérations sont déjà enregistrés dans cette monnaie.'
                }
              >
                <ChoixDevise valeur={o.devise} onChange={(d) => setO({ ...o, devise: d })} disabled={!deviseLibre} />
              </Champ>
            </section>

            <section className="carte formulaire">
              <h2>Couleur de l’application</h2>
              <div className="choix-couleurs" role="radiogroup" aria-label="Couleur">
                {Object.entries(COULEURS).map(([code, c]) => (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={o.couleur === code}
                    className={`pastille-couleur ${o.couleur === code ? 'actif' : ''}`}
                    style={{ background: c.fonce }}
                    onClick={() => {
                      setO({ ...o, couleur: code });
                      appliquerCouleur(code);
                    }}
                  >
                    <span>{c.libelle}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="carte formulaire">
              <h2>Reçu</h2>
              <div className="choix-format" role="radiogroup" aria-label="Format du reçu">
                {FORMATS.map((f) => (
                  <label key={f.code} className={`option-format ${p.format === f.code ? 'actif' : ''}`}>
                    <input type="radio" name="format" checked={p.format === f.code} onChange={() => majP('format', f.code)} />
                    <strong>{f.libelle}</strong>
                    <span className="secondaire">{f.aide}</span>
                  </label>
                ))}
              </div>
              <Champ label="Phrase sous le nom" aide="Ex. « Le meilleur prix du quartier »">
                <input value={p.entete ?? ''} onChange={(e) => majP('entete', e.target.value)} maxLength={160} />
              </Champ>
              <Champ label="Message de bas de reçu">
                <input value={p.pied ?? ''} onChange={(e) => majP('pied', e.target.value)} maxLength={300} />
              </Champ>
              <Champ label="Mention complémentaire" aide="Ex. conditions de retour. Formulation légale à valider par votre fiscaliste.">
                <input value={p.mention_legale ?? ''} onChange={(e) => majP('mention_legale', e.target.value)} maxLength={200} />
              </Champ>
              <div className="cases-options">
                <label className="case">
                  <input type="checkbox" checked={p.afficher_logo} onChange={(e) => majP('afficher_logo', e.target.checked)} />
                  Afficher le logo
                </label>
                <label className="case">
                  <input type="checkbox" checked={p.afficher_ncc} onChange={(e) => majP('afficher_ncc', e.target.checked)} />
                  Afficher le NCC
                </label>
                <label className="case">
                  <input
                    type="checkbox"
                    checked={p.afficher_caissier}
                    onChange={(e) => majP('afficher_caissier', e.target.checked)}
                  />
                  Afficher le nom du caissier
                </label>
              </div>
              {p.format === 'a4_6' && (
                <div className="grille-2">
                  <Champ label="Décalage horizontal (mm)" aide="Si l’impression est décalée sur la feuille">
                    <input
                      type="number"
                      step="0.5"
                      min={-10}
                      max={10}
                      value={p.decalage_x_mm}
                      onChange={(e) => majP('decalage_x_mm', e.target.value)}
                    />
                  </Champ>
                  <Champ label="Décalage vertical (mm)">
                    <input
                      type="number"
                      step="0.5"
                      min={-10}
                      max={10}
                      value={p.decalage_y_mm}
                      onChange={(e) => majP('decalage_y_mm', e.target.value)}
                    />
                  </Champ>
                </div>
              )}
            </section>
          </fieldset>
          {modifiable && (
            <div className="barre-enregistrer">
              <button className="bouton bouton-principal" disabled={envoi}>
                {envoi ? 'Enregistrement…' : 'Enregistrer la personnalisation'}
              </button>
            </div>
          )}
        </form>

        <aside className="colonne-apercu">
          <section className="carte">
            <div className="carte-entete">
              <h2>Aperçu du reçu</h2>
              <span className="secondaire">Exemple fictif</span>
            </div>
            <div className={`cadre-apercu cadre-${p.format}`}>
              <Recu identite={apercu} vente={vente} format={p.format} />
            </div>
            {p.format === 'a4_6' && (
              <div className="impression-a4">
                <span className="champ-label">Case à imprimer</span>
                <ChoixCase valeur={caseTest} onChange={setCaseTest} />
                <span className="champ-aide">
                  La case suivante est retenue sur cet appareil : remettez la même feuille dans l’imprimante pour la
                  remplir.
                </span>
              </div>
            )}
            <button type="button" className="bouton bouton-discret bouton-plein" onClick={() => void imprimerTest()}>
              Imprimer un reçu test
            </button>
          </section>
        </aside>
      </div>

      {identite && (
        <div className="section-moyens">
          <MoyensReglement org={identite.organisation.id} modifiable={peut('administration.modifier') || peut('caisse.administrer')} />
        </div>
      )}
    </>
  );
}

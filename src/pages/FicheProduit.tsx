import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { clavierMontant, deviseCourante, lireMontant, montant } from '../lib/argent';
import { UNITES, type Categorie, type CodeBarres, type Produit, type StatutProduit } from '../lib/types';
import { Alerte, Champ } from '../components/ui';
import { CodeBarre, cleValide } from '../components/CodeBarre';
import { Scanner } from '../components/Scanner';
import { PhotoProduit } from '../components/PhotoProduit';

interface Props {
  produit?: Produit;
  codeInitial?: string;
  categories: Categorie[];
  onCategorieCreee: () => Promise<void>;
  onEnregistre: (p: Produit) => void;
}

const entier = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))));

/** Création et modification d'un produit, avec ses codes-barres. */
export function FicheProduit({ produit, codeInitial, categories, onCategorieCreee, onEnregistre }: Props) {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const nouveau = !produit;
  const modifiable = nouveau ? peut('catalogue.creer') : peut('catalogue.modifier');
  // Le prix d'achat n'est jamais montré au caissier (catalogue en lecture seule).
  const voitCouts = peut('catalogue.modifier') || peut('fournisseurs.consulter') || peut('stock.valider') || peut('rapports.valider');
  // Changer le prix de vente d'un produit existant : niveau « Valider » du catalogue.
  const prixModifiable = nouveau || peut('catalogue.valider');
  const [courant, setCourant] = useState<Produit | undefined>(produit);
  const [f, setF] = useState({
    designation: produit?.designation ?? '',
    code: produit?.code ?? '',
    categorie_id: produit?.categorie_id ?? '',
    marque: produit?.marque ?? '',
    unite: produit?.unite ?? 'pièce',
    prix_vente: produit ? montant(produit.prix_vente, '') : '',
    prix_achat: produit?.prix_achat != null ? montant(produit.prix_achat, '') : '',
    taux_tva: String(Number(produit?.taux_tva ?? 0)),
    seuil_min: produit?.seuil_min?.toString() ?? '',
    seuil_max: produit?.seuil_max?.toString() ?? '',
    gere_peremption: produit?.gere_peremption ?? false,
    statut: (produit?.statut ?? 'actif') as StatutProduit,
  });
  const [codes, setCodes] = useState<CodeBarres[]>([]);
  const [nouveauCode, setNouveauCode] = useState(codeInitial ?? '');
  const [scan, setScan] = useState(false);
  const [erreur, setErreur] = useState('');
  const [info, setInfo] = useState('');
  const [envoi, setEnvoi] = useState(false);

  const chargerCodes = useCallback(async (id: string) => {
    const { data } = await supabase.from('codes_barres').select('*').eq('produit_id', id).order('created_at');
    setCodes((data ?? []) as CodeBarres[]);
  }, []);

  useEffect(() => {
    if (courant) void chargerCodes(courant.id);
  }, [courant, chargerCodes]);

  const maj = (cle: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [cle]: e.target.value });

  async function nouvelleCategorie() {
    const nom = window.prompt('Nom de la nouvelle catégorie');
    if (!nom?.trim()) return;
    const { data, error } = await supabase
      .from('categories')
      .insert({ organisation_id: org, nom: nom.trim() })
      .select('id')
      .single();
    if (error) return setErreur(messageErreur(error));
    await onCategorieCreee();
    setF({ ...f, categorie_id: data.id as string });
  }

  async function enregistrer(e: FormEvent) {
    e.preventDefault();
    if (envoi) return;
    setErreur('');
    setInfo('');
    const prixVente = lireMontant(f.prix_vente);
    if (prixVente === null) return setErreur('Indiquez le prix de vente.');
    const valeurs = {
      designation: f.designation.trim(),
      code: f.code.trim() || null,
      categorie_id: f.categorie_id || null,
      marque: f.marque.trim() || null,
      unite: f.unite,
      prix_vente: prixVente,
      prix_achat: lireMontant(f.prix_achat),
      taux_tva: Number(f.taux_tva),
      seuil_min: entier(f.seuil_min),
      seuil_max: entier(f.seuil_max),
      gere_peremption: f.gere_peremption,
    };
    setEnvoi(true);
    const r = courant
      ? await supabase
          .from('produits')
          .update({ ...valeurs, code: valeurs.code ?? courant.code, statut: f.statut })
          .eq('id', courant.id)
          .select('*')
          .single()
      : await supabase.from('produits').insert({ ...valeurs, organisation_id: org }).select('*').single();
    if (r.error) {
      setEnvoi(false);
      return setErreur(messageErreur(r.error));
    }
    const enregistre = r.data as Produit;
    // Nouveau produit créé depuis un scan : le code lu lui est attribué.
    if (!courant && nouveauCode.trim()) {
      const { error } = await supabase
        .from('codes_barres')
        .insert({ organisation_id: org, produit_id: enregistre.id, code: nouveauCode.trim() });
      if (error) setErreur(`Produit créé, mais code-barres refusé : ${messageErreur(error)}`);
      else setNouveauCode('');
    }
    setEnvoi(false);
    setCourant(enregistre);
    setF((x) => ({ ...x, code: enregistre.code }));
    setInfo(nouveau ? `Produit créé (code ${enregistre.code}).` : 'Modifications enregistrées.');
    onEnregistre(enregistre);
  }

  async function ajouterCode(code: string) {
    if (!courant) return;
    const propre = code.replace(/\s/g, '');
    if (!propre) return;
    setErreur('');
    const { error } = await supabase
      .from('codes_barres')
      .insert({ organisation_id: org, produit_id: courant.id, code: propre });
    if (error) {
      setErreur(
        /duplicate key/.test(error.message)
          ? `Le code ${propre} est déjà attribué à un autre produit.`
          : messageErreur(error),
      );
      return;
    }
    setNouveauCode('');
    await chargerCodes(courant.id);
  }

  async function genererCode() {
    if (!courant) return;
    setErreur('');
    const { error } = await supabase.rpc('generer_code_barres', { p_produit: courant.id });
    if (error) return setErreur(messageErreur(error));
    await chargerCodes(courant.id);
  }

  async function retirerCode(c: CodeBarres) {
    if (!window.confirm(`Retirer le code ${c.code} de ce produit ?`)) return;
    const { error } = await supabase.from('codes_barres').delete().eq('id', c.id);
    if (error) return setErreur(messageErreur(error));
    if (courant) await chargerCodes(courant.id);
  }

  const codeSaisi = nouveauCode.replace(/\s/g, '');
  const avertissementCle =
    /^\d{8}$|^\d{13}$/.test(codeSaisi) && !cleValide(codeSaisi)
      ? 'Ce code ne respecte pas la clé de contrôle EAN : vérifiez la saisie.'
      : '';

  return (
    <div className="fiche-produit">
      <Alerte>{erreur}</Alerte>
      <Alerte type="succes">{info}</Alerte>
      <form className="formulaire" onSubmit={enregistrer}>
        <fieldset disabled={!modifiable} className="sans-bordure">
          <Champ label="Désignation">
            <input value={f.designation} onChange={maj('designation')} required minLength={2} maxLength={160} autoFocus />
          </Champ>
          <div className="grille-2">
            <Champ label={`Prix de vente (${deviseCourante().symbole})`}>
              <input value={f.prix_vente} onChange={maj('prix_vente')} inputMode={clavierMontant()} required placeholder="0"
                disabled={!prixModifiable} title={prixModifiable ? undefined : 'Changer un prix demande le niveau « Valider » du catalogue'} />
            </Champ>
            {voitCouts && (
              <Champ label={`Prix d’achat de référence (${deviseCourante().symbole})`} aide="Facultatif">
                <input value={f.prix_achat} onChange={maj('prix_achat')} inputMode={clavierMontant()} />
              </Champ>
            )}
            <Champ label="Catégorie">
              <div className="champ-avec-bouton">
                <select value={f.categorie_id} onChange={maj('categorie_id')}>
                  <option value="">Sans catégorie</option>
                  {categories
                    .filter((c) => c.actif || c.id === f.categorie_id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parent_id ? `${categories.find((x) => x.id === c.parent_id)?.nom ?? ''} › ` : ''}
                        {c.nom}
                      </option>
                    ))}
                </select>
                {peut('catalogue.creer') && (
                  <button type="button" className="bouton bouton-discret" onClick={() => void nouvelleCategorie()} title="Nouvelle catégorie">
                    +
                  </button>
                )}
              </div>
            </Champ>
            <Champ label="Unité de vente">
              <select value={f.unite} onChange={maj('unite')}>
                {[...new Set([...UNITES, f.unite])].map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </Champ>
            <Champ label="Marque">
              <input value={f.marque} onChange={maj('marque')} maxLength={80} />
            </Champ>
            <Champ label="Code interne" aide={nouveau ? 'Laissez vide : P00001, P00002…' : undefined}>
              <input value={f.code} onChange={maj('code')} maxLength={30} pattern="[A-Za-z0-9_.\-]{1,30}" />
            </Champ>
            <Champ label="TVA">
              <select value={f.taux_tva} onChange={maj('taux_tva')}>
                <option value="0">Sans TVA</option>
                <option value="9">9 %</option>
                <option value="18">18 %</option>
              </select>
            </Champ>
            {!nouveau && (
              <Champ label="Statut">
                <select value={f.statut} onChange={maj('statut')}>
                  <option value="actif">Actif</option>
                  <option value="suspendu">Suspendu (temporairement non vendu)</option>
                  <option value="arrete">Arrêté (plus vendu)</option>
                </select>
              </Champ>
            )}
            <Champ label="Stock minimum" aide="Alerte de réapprovisionnement">
              <input value={f.seuil_min} onChange={maj('seuil_min')} inputMode="numeric" />
            </Champ>
            <Champ label="Stock maximum">
              <input value={f.seuil_max} onChange={maj('seuil_max')} inputMode="numeric" />
            </Champ>
          </div>
          <label className="case">
            <input
              type="checkbox"
              checked={f.gere_peremption}
              onChange={(e) => setF({ ...f, gere_peremption: e.target.checked })}
            />
            Produit périssable (suivi des dates de péremption)
          </label>
          {nouveau && (
            <Champ label="Code-barres" aide="Scannez ou saisissez le code imprimé sur l’article ; laissez vide pour en créer un ensuite.">
              <div className="champ-avec-bouton">
                <input value={nouveauCode} onChange={(e) => setNouveauCode(e.target.value)} inputMode="numeric" />
                <button type="button" className="bouton bouton-discret" onClick={() => setScan(true)}>
                  Scanner
                </button>
              </div>
            </Champ>
          )}
          {nouveau && avertissementCle && <Alerte type="info">{avertissementCle}</Alerte>}
        </fieldset>
        {modifiable && (
          <button className="bouton bouton-principal" disabled={envoi}>
            {envoi ? 'Enregistrement…' : nouveau && !courant ? 'Créer le produit' : 'Enregistrer'}
          </button>
        )}
      </form>

      {courant && (
        <PhotoProduit
          org={org}
          produitId={courant.id}
          chemin={courant.photo_path}
          modifiable={peut('catalogue.modifier')}
          onChange={(chemin) => setCourant({ ...courant, photo_path: chemin })}
        />
      )}

      {courant && (
        <section className="codes-produit">
          <h3>Codes-barres</h3>
          {codes.length === 0 && <p className="secondaire">Aucun code-barres : scannez celui de l’article ou créez-en un.</p>}
          <ul className="liste-codes">
            {codes.map((c) => (
              <li key={c.id}>
                <CodeBarre code={c.code} hauteur={36} />
                <span className="secondaire">{c.genere ? 'Créé par le logiciel' : 'Code fabricant'}</span>
                {peut('catalogue.modifier') && (
                  <button type="button" className="bouton-lien lien-danger" onClick={() => void retirerCode(c)}>
                    Retirer
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(peut('catalogue.modifier') || peut('catalogue.creer')) && (
            <>
              <div className="champ-avec-bouton">
                <input
                  value={nouveauCode}
                  onChange={(e) => setNouveauCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void ajouterCode(nouveauCode);
                    }
                  }}
                  placeholder="Scanner ou saisir un code"
                  inputMode="numeric"
                  aria-label="Nouveau code-barres"
                />
                <button type="button" className="bouton bouton-discret" onClick={() => setScan(true)}>
                  Scanner
                </button>
                <button type="button" className="bouton bouton-discret" onClick={() => void ajouterCode(nouveauCode)} disabled={!codeSaisi}>
                  Ajouter
                </button>
              </div>
              {avertissementCle && <Alerte type="info">{avertissementCle}</Alerte>}
              <button type="button" className="bouton bouton-discret" onClick={() => void genererCode()}>
                Créer un code-barres pour ce produit
              </button>
            </>
          )}
        </section>
      )}

      {scan && (
        <div className="calque-scanner">
          <Scanner
            onCode={(c) => {
              setScan(false);
              if (courant) void ajouterCode(c);
              else setNouveauCode(c);
            }}
            onFermer={() => setScan(false)}
          />
        </div>
      )}
    </div>
  );
}

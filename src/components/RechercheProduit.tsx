import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { montant } from '../lib/argent';
import { Fenetre } from './ui';
import { Scanner } from './Scanner';

export interface ProduitTrouve {
  id: string;
  code: string;
  designation: string;
  unite: string;
  prix_vente: number | string;
  codes_barres: string[];
  pertinence: number;
}

/**
 * Champ unique pour trouver un produit : saisie de mots, code interne, code-barres tapé,
 * lecteur USB/Bluetooth (code + Entrée) ou caméra. Un code-barres exact est choisi
 * immédiatement, sans clic, pour enchaîner les scans.
 */
export function RechercheProduit({
  org,
  onChoisir,
  placeholder = 'Scanner ou chercher un produit…',
  autoFocus,
}: {
  org: string;
  onChoisir: (p: ProduitTrouve) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [terme, setTerme] = useState('');
  const [resultats, setResultats] = useState<ProduitTrouve[]>([]);
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(0);
  const [navigue, setNavigue] = useState(false); // l'utilisateur a choisi une ligne aux flèches
  const [scan, setScan] = useState(false);
  const [message, setMessage] = useState('');
  const champ = useRef<HTMLInputElement>(null);
  const requete = useRef(0);

  async function chercher(t: string): Promise<ProduitTrouve[]> {
    const numero = ++requete.current;
    if (!t.trim()) {
      setResultats([]);
      return [];
    }
    const { data } = await supabase.rpc('rechercher_produits', { p_org: org, p_terme: t, p_limite: 8 });
    const r = (data ?? []) as ProduitTrouve[];
    if (numero === requete.current) {
      setResultats(r);
      setActif(0);
    }
    return r;
  }

  useEffect(() => {
    const t = setTimeout(() => void chercher(terme), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terme]);

  function choisir(p: ProduitTrouve) {
    onChoisir(p);
    setNavigue(false);
    setTerme('');
    setResultats([]);
    setOuvert(false);
    setMessage('');
    champ.current?.focus();
  }

  async function valider(t: string) {
    const r = await chercher(t);
    const exacts = r.filter((x) => x.pertinence === 0);
    if (exacts.length === 1) return choisir(exacts[0]!);
    if (r.length === 1) return choisir(r[0]!);
    if (r.length === 0) setMessage(`Aucun produit pour « ${t.trim()} ».`);
    else setOuvert(true);
  }

  return (
    <div className="recherche-produit">
      <div className="champ-avec-bouton">
        <input
          ref={champ}
          type="search"
          value={terme}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-label="Produit"
          onChange={(e) => {
            setTerme(e.target.value);
            setOuvert(true);
            setNavigue(false);
            setMessage('');
          }}
          onFocus={() => setOuvert(true)}
          onBlur={() => setTimeout(() => setOuvert(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setNavigue(true);
              setActif((a) => Math.min(a + 1, resultats.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setNavigue(true);
              setActif((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (navigue && resultats[actif]) choisir(resultats[actif]!);
              else void valider(terme);
            }
          }}
        />
        <button type="button" className="bouton bouton-discret" onClick={() => setScan(true)}>
          Scanner
        </button>
      </div>
      {message && <p className="recherche-message">{message}</p>}
      {ouvert && resultats.length > 0 && (
        <ul className="recherche-resultats" role="listbox">
          {resultats.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === actif}>
              <button type="button" className={i === actif ? 'actif' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choisir(p)}>
                <span>
                  <strong>{p.designation}</strong>
                  <span className="secondaire"> · {p.code}</span>
                </span>
                <span className="secondaire">{montant(p.prix_vente)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Fenetre titre="Scanner un code-barres" ouverte={scan} onFermer={() => setScan(false)}>
        {scan && (
          <Scanner
            onCode={(code) => {
              setScan(false);
              setTerme(code);
              void valider(code);
            }}
            onFermer={() => setScan(false)}
          />
        )}
      </Fenetre>
    </div>
  );
}

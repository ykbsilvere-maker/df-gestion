# Le Décodeur Financier — Gestion commerciale

Application web installable (PWA) de caisse, stock et pilotage pour boutiques et supérettes.
React + TypeScript côté interface, Supabase (PostgreSQL) côté serveur.

**Version 2.2.** **Classeur complet** : un seul fichier Excel avec trois onglets, *Fournisseurs*, *Catalogue* et
*Approvisionnement*, importé d'un coup (Catalogue › 📥 › « Classeur complet » › Tout importer), dans l'ordre
fournisseurs → articles et photos → livraisons. Les **photos se collent directement dans le classeur**, sur la ligne de
l'article : image placée dans la cellule (Excel 365), image WPS Office (DISPIMG) ou image posée sur la ligne. Elles sont
réduites puis rattachées à l'article. Onglets reconnus par leur nom, sinon par leurs colonnes ; dans l'approvisionnement,
les lignes sans quantité sont laissées de côté (bon de livraison réutilisable). Même import sur l'application et le site.

**Version 2.1.** **Import depuis Excel** (menu Catalogue 📥, Réceptions et Fournisseurs « Importer Excel ») : deux
façons de remplir l'application, la saisie une par une ou le fichier. Modèles Excel téléchargeables (avec mode
d'emploi) pour le **catalogue** (code, code-barres, désignation, catégorie, prix d'achat et de vente, TVA, unité,
seuil, stock initial, photo), les **fournisseurs** et l'**approvisionnement** (articles reçus, quantités, prix,
fournisseur par ligne). Votre propre fichier .xlsx ou .csv convient aussi : les colonnes sont reconnues par leur nom.
Aperçu avant import, articles retrouvés par code, code-barres ou désignation (pas de doublon en réimportant), erreurs
indiquées avec le numéro de ligne Excel. L'approvisionnement et le stock initial créent des réceptions en brouillon à
vérifier puis valider. **Photos en lot** : choisissez plusieurs images nommées comme les articles (code, code-barres ou
désignation), elles sont réduites et rattachées automatiquement.

**Version 2.0.** **Ouverture et clôture de la journée** : la date est celle du serveur (Abidjan). Le gérant ouvre la
journée (proposé dès l'accueil : « Ouvrir la journée du samedi 7 novembre ? »), puis les caisses ; une fois toutes les
caisses clôturées, il clôture la journée (bilan : ventes, tickets, caisses, écart, règlements). Ensuite plus aucune
opération n'est acceptée par le serveur (ouverture de caisse, stock, dépenses, encaissements, paiements, virements,
réceptions, inventaires, annulations) jusqu'à la prochaine ouverture ; les ventes faites hors ligne pendant la journée
restent synchronisables. Le gérant principal peut rouvrir la journée du jour. La règle s'applique dès la première
journée ouverte. Alerte si l'horloge de l'appareil est fausse.

Version 1.9 : **Demandes d'ouverture en libre-service** : sur le site ou l'application, « Créer mes accès »
(nom, e-mail, mot de passe confirmé, sans attendre d'e-mail), puis fiche de l'entreprise (nom, activité, logo, RCCM,
NCC, date de création, régime, gérant principal, téléphone, modules souhaités). L'administrateur général reçoit la
demande (pastille sur « Administration »), appelle le demandeur, puis **valide** (entreprise créée, le demandeur en
devient gérant principal, logo repris), **ajourne** (correction demandée, le demandeur corrige et renvoie) ou
**refuse** (motif visible). Fonction serveur `inscription` (sans « Verify JWT »), quota de 40 créations par heure.

Version 1.8 : **Le gérant principal se connecte partout comme sur Wave** : code établissement + matricule
**0000** + son code d'entrée (créé dans « Mon compte »), sur n'importe quelle tablette ou ordinateur, avec tous ses
accès. 0000 est réservé et ne peut pas être donné à un employé. La connexion par e-mail reste possible.

Version 1.7 : **Suivi des ventes par le gérant principal** : sur « Caisses du jour », solde des ventes en cours
de chaque caisse ouverte, nombre de tickets et part de chaque caissier, et **rapport X provisoire** (règlements, espèces
attendues, produits vendus, imprimable) sans clôturer. Les rapports X et Z listent désormais les produits vendus ; un
caissier ne lit que le rapport de sa propre session. **Caisse plus compacte** : article trouvé sur une ligne (nom, prix,
stock, quantité), barre « Total + Encaisser » fine en bas, fenêtres en feuille qui monte du bas au-dessus du clavier ;
options de la caisse réservées aux responsables. **Catalogue** sans en-tête, recherche figée en haut, liste compacte.
APK : la taille de police du téléphone n'agrandit plus l'application.

Version 1.6 : **Le gérant principal ne tient pas de caisse** : il ouvre (après comptage du fond) et clôture les
caisses de ses caissiers, mais ne vend pas et ne saisit aucune opération de caisse ; personne ne s'ouvre sa propre
caisse (celui qui ouvre n'est jamais celui qui vend). Le caissier se connecte et entre directement dans la caisse
ouverte pour lui. **Écrans figés** : le clavier passe par-dessus le contenu (APK et navigateur) au lieu de le pousser ;
connexion sur téléphone tenant sur un écran (bandeau de marque, carte, pavé de code compact).

Version 1.5 : **La caisse est ouverte par un responsable, pour une personne** : le gérant (droit « caisse.valider »)
ouvre chaque caisse pour celui qui la tiendra, après **comptage du fond ensemble, billet par billet** (10 000, 5 000,
2 000, 1 000… et pièces), qu'ils valident ensemble ; un caissier ne peut pas ouvrir sa caisse seul (« rendez-vous auprès
du gérant principal »). **Chacun ne vend que dans sa caisse** (le gérant ouvre et clôture les autres caisses, sans y
vendre ni les transférer) et **un caissier ne voit que ses ventes et ses sessions** ; le responsable voit toutes les
ventes dans les rapports. Design affiné : textes plus petits, bordures fines, en-tête dégradé, icônes sans cadre,
barre du bas flottante.

Version 1.4 : **Caisse pensée pour l'application** : écran « 🔓 Ouvrir une caisse » (on touche sa caisse, on choisit
le fond avec des montants rapides, on ouvre) qui ne propose que les caisses que la personne peut réellement ouvrir, indique
celles déjà ouvertes (par qui, depuis quand) et explique quoi faire si aucune caisse n'est attribuée. Écran de vente :
**liste des articles toujours visible**, filtrée en direct pendant la frappe (nom, code, code-barres), avec pour chaque
article un sélecteur **− quantité +** (saisie directe possible) ; panier avec le même sélecteur ; total et « Encaisser »
toujours visibles. Sur téléphone, Caisse et Stock sont en premier dans les onglets.

Version 1.3.1 : Correctif des **pages blanches** à l'ouverture d'un module : la remise en haut de page renvoyait une
promesse (navigateurs récents) qu'un effet React prenait pour son nettoyage, ce qui faisait planter l'affichage. Ajout
d'un **filet de sécurité** : une erreur dans un module n'efface plus l'application (le menu reste, message « Réessayer /
Accueil / Recharger ») et elle est **signalée automatiquement** au serveur (page, version, appareil ; aucune donnée de
vente), visible dans la console d'administration. Test automatique interdisant les effets mal formés.

Version 1.3 : **Code d'entrée de 4 chiffres, comme Wave** : un employé se connecte avec le code établissement,
son matricule et son code d'entrée sur un pavé numérique (validation automatique au 4e chiffre). Le gérant donne un code
provisoire ; l'employé choisit le sien à la première connexion. 5 erreurs bloquent 5 minutes, 15 erreurs bloquent jusqu'à
un nouveau code du gérant. La session est ouverte par la fonction serveur « connexion » (la clé secrète reste sur le
serveur). **Après 5 minutes sans activité**, l'application revient à l'écran du code (aussi au retour sur l'application),
sans perdre la vente en cours ; déverrouillage possible sans réseau (empreinte du code gardée sur l'appareil). Le code de
caisse séparé est supprimé. **Nouveau design « application »** : en-tête et menu fixes, seul le contenu défile ; sur
téléphone, barre du haut, onglets du bas et feuille « Plus » en tuiles ; accueil avec carte des ventes du jour et
**actions rapides** (+ Produit, + Arrivage, + Dépense, + Devis, + Créance, + Client, + Employé) qui ouvrent directement
le formulaire, sur l'APK comme sur le web.

Version 1.2 : **Connexion des employés par matricule** : chaque entreprise a un **code entreprise** fixe (ex. BOUT78) ;
un employé se connecte avec ce code (retenu sur l'appareil), son **matricule** et son **code secret** (6 chiffres au moins,
choisi à la première connexion) ; seul le gérant principal garde son adresse e-mail. Le gérant crée l'accès dans
Utilisateurs (matricule proposé, code provisoire de 6 chiffres, message prêt pour WhatsApp) et redonne un code oublié.
**Caisse en écran fixe** : la page ne défile plus ; recherche en haut, panier qui défile seul, total et « Encaisser »
toujours visibles (barre compacte sur téléphone), messages par-dessus le panier sans décaler l'écran, « Vider le panier »
confirmé. Stabilité générale : en-têtes de page fixes sur PC, molette sans effet sur les quantités, fond bloqué sous les fenêtres.

Version 1.1 : **Comptabilité SYSCOHADA** générée automatiquement à partir des opérations : ventes du jour
par magasin (TVA séparée pour les régimes RSI et RNI), achats et frais (601, 6015, 401), règlements fournisseurs,
dépenses du budget au compte de leur poste, virements internes (585) et frais bancaires (631), créances et encaissements
clients, écarts de rapprochement, variation de stock (31 / 6031), à-nouveaux. Écrans : **journal** (filtre par journal
VT, AC, TR, OD, AN), **grand livre**, **balance**, **bilan simplifié** (actif = passif vérifié), **clôture mensuelle**
(un mois clôturé est figé ; une correction passe par une **extourne**), **écritures manuelles** équilibrées avec pièce
justificative, **plan comptable** ajustable ; exports Excel du journal, du grand livre et de la balance.
**Modules au choix** : à la création, l'entreprise coche les modules qu'elle utilise (stock, fournisseurs, budget,
trésorerie, rentabilité, soldes, comptabilité ; caisse, catalogue, ventes, devis et clients toujours inclus) ;
l'**administrateur général** fixe les modules **souscrits** de chaque entreprise, le propriétaire choisit parmi eux
(Personnalisation). Un module retiré disparaît des menus et des droits de tous, données conservées.
**Budget prévu / réalisé** : date de réalisation prévue par poste, dépenses réelles rattachées, statut par poste
(réalisé, dépassé avec montant et %, en cours, en retard, non réalisé, à venir), date effective et décalage en jours,
détail des dépenses, **bilan de l'année** (histogramme prévu / réalisé par mois, dépassements cumulés, mois réalisés,
dépassés ou non réalisés par poste).

Version 1.0 : **Rentabilité** : compte d'exploitation du mois (chiffre d'affaires, coût d'achat des ventes, marge,
charges réelles ou à défaut budget validé, résultat net), seuil de rentabilité, point mort et vente à faire par jour,
évolution sur 12 mois avec les causes d'un mauvais mois, soldes intermédiaires de gestion SYSCOHADA XA à XI, export Excel.
**Surstock et soldes** : couverture, âge moyen du stock, jours sans vente, péremption proche, coût de stockage mensuel,
proposition de remise avec prix plancher au coût de revient, période de vente conseillée, promotions datées appliquées
automatiquement par la caisse (et acceptées par le serveur), bilan des ventes gagnées, réglages des seuils.
Version 0.10 : **Tableau de bord** (chiffre d'affaires par jour, semaine, mois ou année avec évolution, histogramme,
répartition des paiements, meilleurs produits, dernières ventes, alertes), **caisse** : code personnel (PIN) de la caissière,
montant figé au total avec un seul moyen de paiement, alerte de stock non bloquante, **Ma caisse** (espèces au tiroir,
encaissements, paiements du jour, remboursements, journal, sorties et apports, dépenses du tiroir, historique des clôtures),
**arrivages annoncés** par le gérant puis **comptés** par le chargé du stock avec écarts et **fiche de stockage** imprimable,
**créances clients** (balance âgée, relances en 3 niveaux, encaissements vers la trésorerie, relevé), **proposition
d'approvisionnement** selon le rythme des ventes et la trésorerie, **devis et proformas** transformables en vente,
**photos des produits** privées, nouvel écran de connexion avec comptes récents.
Version 0.9 : **Fournisseurs et coût de revient** (frais détaillés par achat — transport, manutention, douane, taxes —,
répartition selon la valeur, la quantité ou le poids, achat comptant ou à crédit avec échéance, paiements partiels et reste dû,
historique des prix, prix de vente conseillé pour une marge visée), **budget du mois** (11 postes SYSCOHADA proposés,
reprise du mois précédent, validation puis révision avec motif, dépenses rattachées à un poste et à un compte, alertes 80 % / 100 %),
**trésorerie** (caisse, Mobile Money, banque alimentés automatiquement par les ventes, dépenses, frais et paiements ;
virements avec frais ; rapprochement avec justification d'écart ; liquidité disponible), **grille des droits identique au cahier
des charges** (12 modules, profils Caissier, Gestionnaire de stock, Comptable, Gérant de magasin), changement de prix réservé
au niveau « Valider » du catalogue, montants jamais coupés sur deux lignes.
Version 0.8 : **Extraction des ventes** (période libre, par ticket, par produit, par jour / semaine / mois,
par moyen de paiement ; export **Excel .xlsx** et **PDF** ; coût et marge réservés au droit « Comptabilité — consulter »),
**droits par module** (Aucun / Voir / Saisir / Valider, profils Caissier TPE, Gestionnaire de stock, Comptable, Gérant)
appliqués sur l'appareil de la personne **en moins de 30 secondes**, **reçu A4 réservé au gérant principal**
(les autres postes impriment sur rouleau), prix d'achat masqué aux postes de caisse.
Construction automatique (GitHub Actions) du site et de l'APK.
Version 0.7 : **Monnaies** (XOF par défaut, euro, dollar et 6 autres monnaies, une par entreprise),
**monnaie rendue en partie par Wave / Orange Money** avec le net à reverser par moyen dans les rapports X et Z,
**police Barlow** et **icônes** dans toute l'interface.
Version 0.6 : **administration générale** (vous créez les entreprises clientes et l'accès de
leurs gérants, vous consultez tout, vous suspendez un client), **application Android (APK)** et
**installation sans Node.js**. Socle (entreprises, magasins, caisses, utilisateurs, rôles, droits, journal d'audit),
**personnalisation** par chaque commerçant (logo, informations, couleur, modèle de reçu),
**catalogue et codes-barres** (scan, recherche, création, étiquettes), **gestion du stock**
(réceptions, transferts, sorties, inventaires, alertes, coût moyen pondéré) et **caisse**
(vente au scan, règlements multiples, ticket A4 ÷ 6 ou thermique, ouverture et clôture avec
billetage, rapports X et Z, **vente hors connexion** avec synchronisation sans doublon).

---

## Ce que fait cette version

| Fonction | Détail |
|---|---|
| Comptes | Inscription, connexion, mot de passe oublié, changement de mot de passe |
| Entreprise | Création (le créateur devient propriétaire), premier magasin et première caisse créés automatiquement, NCC et régime d'imposition |
| Magasins et caisses | Ajout, modification, désactivation (rien n'est supprimé) |
| Utilisateurs | Invitation par e-mail avec rôle, magasins et caisses ; modification ; désactivation avec motif obligatoire ; réactivation ; lien de réinitialisation du mot de passe |
| Rôles | Propriétaire, gérant de magasin, responsable de caisse, caissier, vendeur, gestionnaire de stock, responsable des achats, comptable, auditeur |
| Droits individuels | 17 modules × 9 actions ; ajout ou retrait par personne par rapport à son rôle |
| Journal d'audit | Connexions, déconnexions, toute création ou modification d'entreprise, magasin, caisse, utilisateur, périmètre, droit, invitation — avec valeurs avant/après et motif |
| Personnalisation | Logo (réduit automatiquement), nom, NCC, RCCM, régime, téléphone, e-mail, adresse ; couleur de l'application parmi 7 (noir « Décodeur » par défaut, aux couleurs de la marque) ; logo et nom du client dans l'application |
| Modèle de reçu | Format A4 divisé en 6 (105 × 99 mm, choix de la case, case suivante retenue, réglage du décalage), ticket 80 mm, ticket 58 mm ; logo, phrase d'accroche, message de bas, mention, NCC et caissier affichables ; aperçu en direct et impression test |
| Monnaie | XOF par défaut ; XAF, EUR, USD, GBP, GNF, MAD, GHS, NGN au choix (à la création, ou dans Personnalisation tant qu'aucun article n'existe) ; centimes pour l'euro et le dollar ; billets et pièces de la monnaie à la clôture ; console de l'administrateur : chaque entreprise dans sa monnaie, totaux séparés |
| Règlements | Plusieurs moyens sur une même vente ; monnaie rendue en partie par un autre moyen (ex. 50 en espèces + 1 500 par Wave, avec référence de l'envoi) ; rapports X et Z : net à reverser par moyen (encaissé − monnaie rendue) |
| Interface | Police Barlow embarquée (identique sur PC, téléphone et APK, même hors ligne) ; icônes dans les menus, tuiles, onglets, moyens de paiement et alertes ; tickets imprimés sobres (sans émojis) |
| Catalogue | Produits avec code interne automatique (P00001…), catégories et sous-catégories, marque, unité, prix de vente et d'achat dans la monnaie de l'entreprise, TVA 0/9/18 %, seuils de stock, statut actif/suspendu/arrêté ; historique des prix et journal des changements |
| Codes-barres | Plusieurs codes par produit, uniques dans l'entreprise ; scan par caméra ou lecteur USB/Bluetooth ; code inconnu → création du produit avec ce code ; création d'EAN-13 internes (préfixe 20, réservé à l'usage interne) ; contrôle de la clé EAN |
| Recherche | Par code-barres, code interne ou mots de la désignation, sans tenir compte des accents ni de l'ordre des mots |
| Étiquettes | Planches A4 autocollantes de 24, 21 ou 40 étiquettes : nom de la boutique, désignation, prix, code-barres ; début à n'importe quelle étiquette d'une planche entamée |
| Réceptions | Brouillon complété au scan (un second scan ajoute une unité), fournisseur, n° de BL, prix d'achat, lot et date de péremption, frais d'approche répartis au prorata de la valeur ; validation unique (double clic sans effet) ; dernier prix d'achat mis à jour |
| Stock | Registre des mouvements non modifiable ; solde par magasin = somme des mouvements ; valorisation au coût moyen pondéré (CMP) frais d'approche inclus ; état par magasin ou consolidé ; export Excel |
| Transferts | Entre deux magasins, au même coût, contrôle du stock disponible, protection contre le double envoi |
| Sorties et ajustements | Perte, casse, vol, avarie, péremption, consommation interne (droit « stock.modifier ») ; ajustements en plus ou en moins (droit « stock.valider ») ; motif obligatoire, inscrit au journal d'audit ; refus si stock insuffisant, y compris pour deux sorties simultanées |
| Inventaires | Complet ou par catégorie ; comptage au scan (1 article par scan) ou par saisie ; comptage à l'aveugle possible ; écarts calculés sur le stock au moment de la validation, valorisés et enregistrés comme mouvements |
| Alertes | Rupture, sous le minimum, surstock, stock négatif, lot périmé ou périmant sous 30 jours, produit sans sortie depuis 60 jours |
| Fournisseurs | Fiche (coordonnées, NCC, note), création rapide depuis une réception |
| Ouverture de caisse | Choix de la caisse (selon les caisses attribuées), fond de caisse ; une seule session ouverte par caisse |
| Vente | Scan (lecteur USB/Bluetooth ou caméra), recherche par nom ou code, `3*code` pour 3 unités, quantités décimales (kg, litre) ; modification du prix (droit « ventes.modifier ») et remise par ligne (droit « ventes.valider ») ; alerte si le stock théorique est épuisé, la vente reste possible |
| Règlements | Un ou plusieurs moyens par vente : espèces (somme reçue, monnaie à rendre, montants rapides), Wave, Orange Money, MTN MoMo, Moov Money, carte, virement, chèque ; référence de transaction (obligatoire ou non, moyen par moyen, dans Personnalisation ; un moyen peut aussi être retiré de la caisse) ; **aucun paiement n'est déclenché, il est seulement tracé** |
| Ticket | Imprimé automatiquement après la vente au format choisi (A4 ÷ 6 dans la case suivante, ou 80/58 mm) ; réimpression depuis la liste des ventes ; « Reçu provisoire » numéroté par la caisse pour une vente faite sans réseau |
| Stock | Chaque vente sort le stock (lots à péremption la plus proche d'abord) au coût moyen du moment ; une annulation le remet |
| Annulation | Droit « ventes.annuler », motif obligatoire, inscrite au journal ; possible tant que la session est ouverte |
| Rapport X | Lecture à tout moment : ventes, chiffre d'affaires, remises, panier moyen, annulations, ventes hors connexion, total par moyen de règlement, espèces attendues |
| Clôture et rapport Z | Comptage des espèces par coupure (billets et pièces FCFA) ou en total ; écart calculé, justification obligatoire s'il y en a un ; numéro Z séquentiel par caisse ; rapport figé et imprimé ; clôture par la personne qui a ouvert ou par un responsable (droit « caisse.cloturer ») |
| Hors connexion | Catalogue, prix, moyens de règlement et session gardés sur l'appareil ; l'application redémarre sans réseau ; chaque vente est d'abord enregistrée sur l'appareil puis envoyée dès que le serveur répond (au retour du réseau, toutes les 30 s, ou sur demande) ; identifiant unique par vente : un renvoi ne crée jamais de doublon ; la clôture est bloquée tant que des ventes restent à envoyer |
| Accueil | Ventes du jour (montant et nombre de tickets) |
| Administrateur général | Le premier compte de l'installation le devient ; il voit toutes les entreprises en **consultation** (ventes du jour et du mois, caisses ouvertes, stock, utilisateurs, journal) mais n'écrit rien chez elles ; il crée chaque entreprise cliente avec son premier magasin, sa première caisse et l'accès de son **gérant principal** ; il ajoute un gérant, réinitialise son mot de passe, **suspend** ou réactive une entreprise (motif obligatoire, accès coupé immédiatement) |
| Création d'entreprise | Fermée par défaut une fois l'administrateur désigné ; l'administrateur peut ouvrir l'« inscription libre » |
| Accès avec mot de passe provisoire | L'administrateur (pour les gérants) et les gérants (pour leurs employés) créent l'accès directement : identifiant + mot de passe provisoire, sans e-mail ; message prêt à envoyer par WhatsApp ; la personne choisit son mot de passe à la première connexion ; réinitialisation de la même façon ; tout est inscrit au journal (jamais le mot de passe) |
| Configuration sans recompiler | Adresse du serveur et clé publique lues dans `config.js` (modifiable au Bloc-notes) ou saisies une fois par appareil : QR code ou code « DFG1… » affiché dans la console d'administration |
| Application Android | APK signé (Android 6 et plus) : application embarquée, fonctionne sans réseau, impression par le service d'impression d'Android, caméra pour le scan, exports dans « Téléchargements » |
| PWA | Installable sur Android, iPhone et PC ; fonctionne sans réseau pour la caisse (voir ci-dessus) |

### Règles de sécurité appliquées par la base (pas seulement par l'interface)

- **Isolation** : une entreprise ne voit jamais les données d'une autre (politiques RLS sur chaque table).
- **Périmètre** : un utilisateur ne voit que les magasins qui lui sont attribués.
- **Écritures sensibles** uniquement par fonctions contrôlées : personne, pas même le propriétaire, ne modifie directement la table des membres.
- **Désactivation** : l'accès aux données est coupé à la requête suivante, sur tous les appareils ; l'historique est conservé.
- **Garde-fous** : on ne modifie pas ses propres droits ; seul un propriétaire agit sur un propriétaire ; un gérant ne délègue que les droits et magasins qu'il possède ; l'entreprise garde toujours un propriétaire actif.
- **Journal d'audit en insertion seule** : ni modification, ni suppression, ni vidage, même par l'administrateur de la base.
- **Administrateur général en lecture seule** chez ses clients : la base lui accorde la consultation et l'export, jamais la création, la modification ou la vente.
- **Création d'accès** : la fonction serveur `comptes` n'agit qu'après l'accord de la base, interrogée avec le jeton de la personne qui agit (gérant pour ses employés, administrateur pour les gérants).

---

## Installation

Le guide détaillé (avec captures, liste de contrôle et dépannage) est livré à part. En résumé :

### Sans Node.js (recommandé) — avec le « kit d'installation »

1. **Supabase** : créez un projet (région Paris), puis dans **SQL Editor** exécutez dans l'ordre les 8 fichiers
   du dossier `1-base-de-donnees` (001 socle … 008 rendu de monnaie).
   **Mise à jour d'une installation v0.6** : exécutez seulement `20261104000007_monnaies.sql` puis
   `20261104000008_rendu_monnaie.sql` (les données existantes restent en XOF), republiez le site et installez le nouvel APK.
2. **Fonction « comptes »** : **Edge Functions → Deploy a new function → Via Editor**, nom `comptes`,
   collez `2-fonction-comptes/index.ts`, **Deploy**. (Sans elle, tout fonctionne, mais les personnes
   créent elles-mêmes leur compte avec l'adresse invitée au lieu de recevoir un mot de passe provisoire.)
3. **Authentication** : *Site URL* et *Redirect URLs* = l'adresse de votre site ; « Confirm email » au choix
   (les accès créés par mot de passe provisoire n'envoient aucun e-mail).
4. **Site web** (PC) : ouvrez `3-site-web/config.js` au Bloc-notes, collez l'URL du projet et la clé
   publique (*anon* / *publishable*), enregistrez, puis glissez le dossier `3-site-web` sur
   [app.netlify.com/drop](https://app.netlify.com/drop). Laissé vide, chaque appareil demandera sa configuration.
5. **Téléphones** : installez `DF-Gestion.apk (page « Releases » du dépôt)` (autoriser l'installation depuis cette source).
   Au premier lancement : collez le code ou scannez le QR code de la console d'administration.
6. Ouvrez l'application : sur une installation neuve, **le premier compte créé devient administrateur général**.

> Ne mettez jamais la clé `service_role` / *secret* dans `config.js` ni dans un téléphone.

### Avec Node.js (développement)

```bash
npm install
cp .env.example .env.local      # facultatif : VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm run dev                      # http://localhost:5173
npm run build                    # site web dans dist/
npx vite build --mode apk        # version embarquée dans l'APK (dist-apk/)
```

APK : `android/build-apk.sh` (outils Android d'Ubuntu, sans Gradle) — voir l'en-tête du script ; la clé de
signature doit rester la même d'une version à l'autre, sinon les téléphones refusent la mise à jour.

---

## Premier usage

0. **Administrateur général** : créez le premier compte, puis **Administration → Nouvelle entreprise**
   pour chaque client (avec l'accès de son gérant principal) ; envoyez-lui le message d'identifiants.
   Le gérant suit ensuite les étapes ci-dessous pour son entreprise.
1. Le gérant se connecte avec son mot de passe provisoire et en choisit un.
2. **Personnalisation** : téléversez votre logo, complétez vos informations, choisissez la couleur
   et le format de reçu, puis faites une **impression test**.
3. **Stock de départ** : faites une réception (ou un inventaire) par magasin pour enregistrer les
   quantités et les coûts actuels. Indiquez un stock minimum sur les produits à surveiller.
4. **Catalogue** : scannez chaque article (ou cherchez-le) ; s'il est inconnu, créez-le avec ce code.
   Pour un article sans code-barres, créez-en un puis imprimez ses étiquettes.
5. **Magasins** : vérifiez le magasin et la caisse créés, ajoutez-en si besoin.
6. **Utilisateurs → Inviter un utilisateur** : nom, e-mail, rôle, magasins et caisses ; cochez « Créer son
   accès maintenant » pour lui donner un mot de passe provisoire (sinon il crée son compte avec cette adresse).
7. **Caisse** : sur chaque appareil de caisse, ouvrez la caisse **une première fois connecté** (le
   catalogue et la session sont alors gardés sur l'appareil pour travailler sans réseau). Chaque
   soir : Rapport X si besoin, puis **Clôturer** (comptage des espèces) et rangez le rapport Z.

## Imprimantes et lecteurs

- **Reçu A4 divisé en 6** : n'importe quelle imprimante de bureau. Dans la fenêtre d'impression,
  choisissez A4, **marges : aucune**, **échelle : 100 %**. Si le reçu est décalé, corrigez-le avec
  les décalages horizontal et vertical (Personnalisation). Remettez la même feuille dans le bac :
  le logiciel imprime dans la case suivante. Un reçu trop long est réduit, puis étendu sur deux cases.
- **Ticket 80 / 58 mm** : réglez le format de papier du pilote de l'imprimante thermique
  (80 × 297 mm ou rouleau), marges aucune. Pour imprimer sans fenêtre de confirmation sur un PC de
  caisse, Chrome peut être lancé avec l'option `--kiosk-printing`.
- **Étiquettes** : planches autocollantes A4 (24 × 70 × 37 mm, 21 × 70 × 42,4 mm ou 40 × 52,5 × 29,7 mm),
  échelle 100 %, marges aucune.
- **Lecteur de codes-barres USB ou Bluetooth** : il fonctionne comme un clavier. Cliquez dans le champ
  de recherche (catalogue, réception, inventaire ou caisse) et scannez : le code est suivi d'« Entrée »
  et traité directement. À la caisse : **F2** revient au champ de scan, **F9** ouvre l'encaissement.
- **Caméra du téléphone** : bouton « Scanner ». Nécessite HTTPS (c'est le cas sur Netlify) et
  l'autorisation d'accès à la caméra.

---

## Tests

### Base de données (101 tests : isolation, droits, invitations, désactivation, audit, catalogue, codes-barres, recherche, personnalisation, stockage des logos, stock, caisse, administration générale) et 5 tests unitaires (recherche hors connexion)

Ils s'exécutent sur un PostgreSQL **jetable** : la base de test est supprimée et recréée à chaque lancement.

```bash
# Avec la CLI Supabase (supabase start), ou tout PostgreSQL 15+ local :
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres npm test
```

### Fumée de l'API (`tests/api/fumee.mjs`)

Rejoue avec `@supabase/supabase-js` les appels exacts de l'application contre PostgREST
(voir l'en-tête du fichier pour les variables d'environnement).

### Résultats obtenus pour la v0.7 (4 novembre 2026)

| Vérification | Résultat |
|---|---|
| Tests base de données + unitaires (dont monnaies, rendu de monnaie partagé) | 132 / 132 |
| Fumée API via PostgREST + supabase-js ; fonction « comptes » | 35 / 35 ; 9 / 9 |
| Parcours Chrome v0.2 à v0.6 (régression) | 12 / 12, 9 / 9, 10 / 10, 13 / 13, 12 / 12 |
| Parcours euro (centimes, raccourcis de billets, remise, clôture en euros, Z, monnaie verrouillée, console multi-monnaies, Barlow chargée) | 20 / 20 |
| Parcours rendu de monnaie (50 en espèces + 1 500 par Wave, ticket, paiement mixte, rapport X net par moyen) | 10 / 10 |
| Version APK, pont Android simulé | 4 / 4 |
| Toutes les pages sur téléphones de 360 et 375 points de large | Aucun débordement |

### Résultats obtenus pour la v0.6 (25 octobre 2026)

| Vérification | Résultat |
|---|---|
| Tests base de données (PostgreSQL 16) + tests unitaires | 101 / 101 + 5 / 5 |
| Contrôles de mutation : RLS retirée sur `magasins` ; verrou retiré sur les sorties simultanées ; idempotence des ventes ; administrateur autorisé à écrire ; administrateur privé de la lecture des entreprises | Les tests concernés échouent comme attendu |
| Fumée API via PostgREST 12.2 + supabase-js | 35 / 35 |
| Fonction « comptes » (Deno 2.9, supabase-js) : création d'accès, refus, réinitialisation, journal | 9 / 9 |
| Parcours Chrome v0.2, v0.3, v0.4, v0.5 (régression) | 12 / 12, 9 / 9, 10 / 10, 13 / 13 |
| Parcours Chrome v0.6 (configuration sans build, premier administrateur, entreprise + accès gérant, mot de passe provisoire, caisse créée par la gérante, accès caissier, consultation sur téléphone, réinitialisation, suspension/réactivation, nouvel appareil configuré par code) | 12 / 12 |
| Version embarquée dans l'APK, pont Android simulé (configuration, aucun service worker, ticket envoyé à l'impression Android, export vers Téléchargements) | 4 / 4 |
| APK : `aapt dump badging`, `apksigner verify` (signatures v1, v2, v3) | OK |
| Erreurs dans la console du navigateur | Aucune, hors échecs réseau volontaires |
| `tsc` + build de production | OK |

Les parcours Chrome utilisaient un service d'authentification et de stockage simulés (les règles
de sécurité de la base étaient bien appliquées). Le vrai Supabase Auth (e-mails), le scan par
caméra et vos imprimantes sont à vérifier sur votre projet et votre matériel. **L'APK n'a pas pu être
lancé sur un vrai téléphone ni sur un émulateur** dans l'environnement de construction : son installation,
la caméra, l'impression Android et l'enregistrement des exports sont à essayer sur vos appareils. La coupure testée
dure quelques minutes : une coupure de plusieurs heures (jeton de connexion expiré pendant la
coupure) est à essayer sur votre projet avant la mise en service.

---

## Structure

```
supabase/migrations/     Schéma, rôles, RLS, fonctions RPC (à appliquer dans l'ordre)
src/lib/                 Client Supabase, session et droits, types, formats
src/components/          Coquille (menu), composants d'interface
src/pages/               Connexion, création d'entreprise, accueil, catalogue, fiche produit,
                         étiquettes, magasins, utilisateurs, journal, personnalisation, mon compte
src/pages/stock/         État, alertes, réceptions, transferts, sorties, inventaires, mouvements, fournisseurs
src/pages/Administration.tsx  Console de l'administrateur général
src/pages/Configuration.tsx   Configuration du serveur (code, QR code, adresse et clé)
supabase/functions/comptes/   Fonction serveur de création d'accès (Deno)
android/                 Application Android (Java, sans Gradle) et script de construction de l'APK
src/caisse/              Point de vente, encaissement, clôture, stockage local (IndexedDB) et synchronisation
src/impression/          Reçu (A4 ÷ 6, 80 mm, 58 mm), rapports X et Z, étiquettes, mécanisme d'impression
tests/db/                Tests SQL (vitest + pg) et simulation minimale de Supabase
tests/api/               Test de fumée de l'API
tests/unit/              Tests sans base (recherche hors connexion, erreurs réseau)
tests/api/fonction-comptes.mjs  Test de la fonction « comptes »
```

## Règles pour les prochaines migrations

Supabase accorde par défaut tous les droits sur les nouvelles tables aux rôles `anon` et
`authenticated`. Chaque migration doit donc, pour chaque nouvelle table :
activer RLS, retirer les droits (`revoke all … from anon, authenticated`), puis n'accorder que
la lecture et les colonnes réellement modifiables. Les montants sont stockés en entiers, dans la plus petite unité de la monnaie de l'entreprise (1 XOF, 1 centime d'euro).

## Limites connues de cette version

- **Pas d'e-mail d'invitation automatique** : la personne invitée doit créer son compte avec
  l'adresse indiquée. L'envoi automatique demande une fonction serveur avec la clé `service_role`
  (prévu plus tard).
- **Déconnexion forcée** : désactiver un compte coupe l'accès aux données immédiatement ; le jeton de
  session déjà émis expire de lui-même (1 h par défaut) sans donner accès à rien. La déconnexion
  à distance d'un appareil d'un compte resté actif viendra avec la même fonction serveur.
- **Hors connexion** : on vend sans réseau, mais l'**ouverture**, la **clôture**, le **rapport X** et
  l'**annulation** demandent le réseau (ils s'appuient sur les totaux du serveur). Une vente faite
  sans réseau garde le prix connu par l'appareil ; elle est marquée « hors connexion » dans les
  rapports. Si la caisse a été clôturée entre-temps, la vente est acceptée et marquée « après clôture ».
- **Ventes refusées** : une vente hors connexion refusée au retour du réseau (droit retiré entre-temps,
  par exemple) reste sur l'appareil, visible dans « refusées », réimprimable et renvoyable ; elle
  n'entre pas dans les totaux tant qu'elle n'est pas acceptée.
- **Clients, crédit et retours après clôture** : viennent avec le module tiers (v0.6).
- **Photos de produits** : la base et le stockage sont prêts, l'écran d'ajout viendra plus tard.
- **Impression** : passe par la fenêtre d'impression du navigateur (pas de pilotage direct ESC/POS).
- **Stock** : les commandes fournisseurs, factures, dettes et retours fournisseurs viendront avec
  le module tiers ; l'inventaire se fait par produit (pas encore par lot) ; un ajustement exige le
  droit « stock.valider » mais pas encore la validation par une seconde personne.
- **Codes-barres internes** (préfixe 20) : valables dans votre boutique uniquement, pas chez un
  distributeur. Pour vendre vos produits ailleurs, il faut des codes GS1 officiels.
- Les mentions des tickets, la conformité FNE/RNE (gérée hors du logiciel) et la protection des
  données personnelles restent à valider par des professionnels avant commercialisation.
- **Administrateur général** : un seul niveau (pas encore de rôles plateforme distincts, ni de facturation
  des abonnements) ; pour ajouter un second administrateur, exécutez dans l'éditeur SQL :
  `select public.promouvoir_admin_general('adresse@exemple.ci');`.
- **Première installation** : tant qu'aucun administrateur n'est désigné, le premier compte créé le devient.
  Créez-le juste après la mise en place, avant de diffuser l'adresse ou l'APK.
- **APK** : installé hors Play Store (« sources inconnues ») ; pas de mise à jour automatique : chaque nouvelle
  version s'installe par-dessus, avec la même clé de signature. L'impression passe par le service
  d'impression d'Android (imprimantes Wi-Fi/Bluetooth compatibles ou PDF) ; une imprimante thermique
  Bluetooth sans service d'impression Android demandera un pilote direct (ESC/POS), non inclus.

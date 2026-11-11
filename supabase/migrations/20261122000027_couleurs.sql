-- 2.10 — Plus de couleurs pour la barre de menu : la base accepte tout code de palette
-- (lettres minuscules et tiret bas) ; la liste des palettes vit dans l'application.
alter table public.organisations drop constraint organisations_couleur_check;
alter table public.organisations add constraint organisations_couleur_check check (couleur ~ '^[a-z_]{2,20}$');

# Protanopia Goggles

Site web mobile qui ouvre la caméra du téléphone et affiche **en direct** l'image telle que la perçoit une personne atteinte de **protanopie** (absence de cônes L, sensibles au rouge).

## Fonctionnalités

- Flux caméra filtré en temps réel (WebGL, tout est calculé sur le téléphone, aucune image n'est envoyée).
- Trois vues : *Normal*, *Comparer* (écran partagé avec séparateur déplaçable) et *Protanopie*.
- Curseur de sévérité (protanomalie → protanopie complète).
- Deux algorithmes : **Brettel, Viénot & Mollon 1997** (par défaut, le plus précis) et **Viénot, Brettel & Mollon 1999**.
- Bascule caméra avant / arrière, capture de photo.

## Algorithme

Les matrices proviennent de [libDaltonLens](https://github.com/DaltonLens/libDaltonLens) (domaine public), le code utilisé par le simulateur [daltonlens.org](https://daltonlens.org/colorblindness-simulator). Pour chaque pixel :

1. sRGB → RGB linéaire ;
2. choix du demi-plan de projection (Brettel) selon le signe du produit scalaire avec la normale du plan de séparation ;
3. multiplication par la matrice 3×3 qui combine RGB→LMS (Smith & Pokorny), la projection sur le plan de confusion protan et LMS→RGB ;
4. interpolation linéaire avec l'original selon la sévérité, puis retour en sRGB.

## Lancer en local

```bash
npx serve public
```

`localhost` est considéré comme sécurisé, la caméra fonctionne donc sans HTTPS en local. Pour tester sur un téléphone, il faut une URL HTTPS (le déploiement Cloud Run ci-dessous).

## Déploiement (Google Cloud Run)

```bash
gcloud run deploy protanopia-goggles --source . --project qualified-acre-513710-m0 --region europe-west1 --allow-unauthenticated
```

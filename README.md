# Chloé · Price Consistency Check v2

Application de vérification de cohérence des prix entre **SAP** et **SFCC** (Salesforce Commerce Cloud).

## Stack

- React 18 + Vite
- xlsx (parsing Excel + export CSV/XLSX)
- Zéro backend — 100% client-side

---

## Installation & lancement

```bash
npm install
npm run dev
```

Build production :
```bash
npm run build
```

---

## Déploiement Vercel

1. Push sur GitHub
2. Vercel → New Project → importer le repo
3. Framework : **Vite** (auto-détecté)
4. Deploy → chaque `git push` redéploie automatiquement

---

## Structure des fichiers

```
src/
├── main.jsx              # Entry point React
└── PriceCheckerV2.jsx    # Tout-en-un : parsers, logique, UI
```

Tout le code métier est dans `PriceCheckerV2.jsx`, organisé en sections :

| Section | Description |
|---|---|
| `COLUMN_MAP` | Mapping noms colonnes SAP → champs internes (ajouter synonymes ici) |
| `parseSAP()` | Parse Excel SAP, filtre PLC15 + dates + SKU PLC25 non-CW |
| `parseSFCC()` | Parse XML SFCC, stocke tous les price-table avec dates optionnelles |
| `resolveSFCCPrices()` | Résout le prix effectif à une date donnée (daté > continu) |
| `runChecks()` | Applique les règles métier par PLC et catégorie |
| Composants UI | KpiCard, ExportMenu, StatusTag, ColReport, etc. |

---

## Format des fichiers attendus

### SAP (.xlsx)
Colonnes détectées **par nom** (pas par position) — résistant aux réorganisations.

| Champ interne | Noms acceptés |
|---|---|
| salesOrg | "Sales Organization", "Sales Org.", "Sales Org" |
| article | "Article", "Article ID", "SKU", "Material" |
| pricingRef | "Pricing Ref. Artl", "Pricing Ref", "Generic" |
| plc | "Prod.Life Cycle", "Prod.Life", "PLC" |
| category | "Mdse Catgry Desc.", "Mdse Catgry Desc", "Category" |
| validFrom | "Valid From", "ValidFrom" |
| validTo | "Valid To", "ValidTo" |
| price | "ZRSP Rate", "Price", "Amount", "Rate" |
| currency | "Currency ZRSP", "Currency Z", "Currency" |

### SFCC (.xml)
Pricebook Demandware standard. Supporte :
- Prix continu (sans dates) — fallback permanent
- Prix daté (`<online-from>` / `<online-to>`) — priorité si actif à la date de check

```xml
<price-table product-id="CHC22AS383I26">
  <amount quantity="1">1090.00</amount>           <!-- continu -->
</price-table>
<price-table product-id="CHC22AS383I26">
  <online-from>2026-02-19T00:00:00.000Z</online-from>
  <online-to>2026-04-30T23:59:59.000Z</online-to>
  <amount quantity="1">1050.00</amount>           <!-- daté -->
</price-table>
```

Multi-pricebooks dans un seul fichier XML : supporté.

---

## Règles de check

| PLC | Catégorie | Règle |
|---|---|---|
| PLC 15 | — | Ignoré — aucun check |
| PLC 25 | non-Childrenwear | Check **Generic** SAP = Generic SFCC · ligne SKU ignorée |
| PLC 25 | Childrenwear | Check **SKU** SAP = SKU SFCC · KO si absent |
| PLC 57+ | — | Check **SKU** SAP = SKU SFCC · KO si absent |

**Absent SFCC = KO** dans tous les cas.

### Résolution du prix SFCC à une date donnée
1. Prix daté actif à la date de check → utilisé en priorité
2. Sinon → prix continu (sans dates)
3. Plusieurs prix datés actifs simultanément → DQ flag (data quality)

---

## KPIs

| KPI | Description |
|---|---|
| Total vérifiés | Lignes SAP actives à la date de check, hors PLC15 et SKU PLC25 non-CW |
| PASS | SAP = SFCC à la date de check |
| KO — prix différent | Prix présent dans SFCC mais valeur incorrecte |
| KO — absent SFCC | Produit absent du pricebook SFCC |
| ⚠ DQ chevauchements | Produits avec plusieurs prix datés actifs simultanément dans SFCC |

### Panel de couverture
Après analyse, un panneau récapitule :
- ✓ **Pricebook chargé** — Sales Orgs incluses dans les KPIs
- ✗ **Pricebook manquant** — Sales Orgs SAP sans pricebook SFCC uploadé (exclues des KPIs)
- ⚠ **Pricebook sans données SAP** — pricebooks uploadés sans lignes SAP correspondantes

---

## Ajouter un nouveau synonyme de colonne SAP

Dans `PriceCheckerV2.jsx`, modifier `COLUMN_MAP` :

```js
const COLUMN_MAP = {
  salesOrg: ["Sales Organization", "Sales Org.", "Mon Nouveau Nom", ...],
  // ...
}
```

## Ajouter une règle PLC

Dans la fonction `runChecks()`, ajouter un cas dans le `if/else` selon le PLC ou la catégorie.

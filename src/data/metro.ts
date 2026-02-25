/**
 * Athens Metro lines — hardcoded station coordinates.
 * Shared between all map screens.
 */

export const METRO_LINES = {
  line1: {
    color: '#4CAF50',
    label: 'Line 1',
    stations: [
      {n:'Piraeus',c:[37.948108,23.643249]},{n:'Faliro',c:[37.945079,23.665239]},
      {n:'Moschato',c:[37.955311,23.680467]},{n:'Kallithea',c:[37.960313,23.696562]},
      {n:'Tavros',c:[37.962346,23.703007]},{n:'Petralona',c:[37.968041,23.708850]},
      {n:'Thiseio',c:[37.976990,23.719675]},{n:'Monastiraki',c:[37.975888,23.724931]},
      {n:'Omonia',c:[37.983945,23.727922]},{n:'Victoria',c:[37.992658,23.730138]},
      {n:'Attiki',c:[37.999529,23.722823]},{n:'Ag. Nikolaos',c:[38.006995,23.727682]},
      {n:'Kato Patisia',c:[38.011925,23.728624]},{n:'Ag. Eleftherios',c:[38.019452,23.731382]},
      {n:'Ano Patisia',c:[38.023549,23.735545]},{n:'Perissos',c:[38.032510,23.744440]},
      {n:'Pefkakia',c:[38.036838,23.749727]},{n:'Nea Ionia',c:[38.041400,23.754306]},
      {n:'Iraklio',c:[38.046550,23.765543]},{n:'Irini',c:[38.043680,23.782898]},
      {n:'Neratziotissa',c:[38.044749,23.792512]},{n:'Maroussi',c:[38.055999,23.804387]},
      {n:'KAT',c:[38.065546,23.803970]},{n:'Kifissia',c:[38.073391,23.808119]},
    ],
  },
  line2: {
    color: '#F44336',
    label: 'Line 2',
    stations: [
      {n:'Anthoupoli',c:[38.017109,23.690876]},{n:'Peristeri',c:[38.012886,23.695760]},
      {n:'Ag. Antonios',c:[38.006093,23.699716]},{n:'Sepolia',c:[38.002595,23.714036]},
      {n:'Attiki',c:[37.999534,23.722692]},{n:'Larissa Stn',c:[37.992286,23.720701]},
      {n:'Metaxourghio',c:[37.985845,23.721362]},{n:'Omonia',c:[37.984054,23.727983]},
      {n:'Panepistimio',c:[37.980346,23.733004]},{n:'Syntagma',c:[37.975501,23.735647]},
      {n:'Akropoli',c:[37.968859,23.729555]},{n:'Sygrou-Fix',c:[37.964637,23.726804]},
      {n:'Neos Kosmos',c:[37.957655,23.728368]},{n:'Ag. Ioannis',c:[37.956416,23.734677]},
      {n:'Dafni',c:[37.949553,23.737211]},{n:'Ag. Dimitrios',c:[37.939843,23.740727]},
      {n:'Ilioupoli',c:[37.929064,23.744755]},{n:'Alimos',c:[37.917870,23.744062]},
      {n:'Argyroupoli',c:[37.902057,23.745616]},{n:'Elliniko',c:[37.892586,23.747095]},
    ],
  },
  line3: {
    color: '#2196F3',
    label: 'Line 3',
    stations: [
      {n:'Dim. Theatro',c:[37.942903,23.647586]},{n:'Maniatika',c:[37.959048,23.639782]},
      {n:'Piraeus',c:[37.947609,23.642286]},{n:'Nikaia',c:[37.965437,23.646839]},
      {n:'Korydallos',c:[37.977060,23.650392]},{n:'Ag. Varvara',c:[37.989968,23.659313]},
      {n:'Ag. Marina',c:[37.997004,23.666478]},{n:'Egaleo',c:[37.991495,23.681844]},
      {n:'Eleonas',c:[37.987779,23.693372]},{n:'Kerameikos',c:[37.978961,23.710383]},
      {n:'Monastiraki',c:[37.976873,23.725068]},{n:'Syntagma',c:[37.974884,23.735713]},
      {n:'Evangelismos',c:[37.976141,23.747098]},{n:'Megaro Moussikis',c:[37.979042,23.752994]},
      {n:'Ambelokipi',c:[37.987197,23.757661]},{n:'Panormou',c:[37.993227,23.763572]},
      {n:'Katehaki',c:[37.993761,23.776734]},{n:'Ethniki Amyna',c:[37.999195,23.784461]},
      {n:'Holargos',c:[38.004921,23.794695]},{n:'Nomismatokopio',c:[38.009113,23.805765]},
      {n:'Ag. Paraskevi',c:[38.017139,23.812468]},{n:'Halandri',c:[38.021727,23.820750]},
      {n:'D. Plakentias',c:[38.024006,23.832542]},{n:'Pallini',c:[38.004607,23.870075]},
      {n:'Paiania-Kantza',c:[37.984919,23.870201]},{n:'Koropi',c:[37.912609,23.896225]},
      {n:'Airport',c:[37.936478,23.944467]},
    ],
  },
} as const;

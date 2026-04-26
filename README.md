# TDS Sampler

**The Downward Spiral Sampling Machine**

App de sampling automatisé inspirée par l'album *The Downward Spiral* de Nine Inch Nails. Elle va chercher des sons sur YouTube, les télécharge, les découpe et les charge dans des pads — prêts à être exportés vers ton MPC ou ton DAW.

---

## Fonctionnalités

### 🎯 Auto Hunt
- Donne un thème (ex: "dark industrial metal", "church organ minor key", "horror movie dialogue")
- L'app cherche sur YouTube, télécharge l'audio, découpe un segment aléatoire et le charge dans tes pads
- 18 presets curés façon TDS : orchestrations, machines industrielles, breakbeats, dialogues de films, drones, etc.
- Réglage du nombre de samples, durée min/max par sample

### ⊞ Sample Pads
- 6 catégories : Industrial, Orchestral, Drums, Film/Dialog, Texture, Vocal/Noise
- Lecture play/stop par clic sur le pad
- Waveform avec trim start/end
- Chaîne d'effets temps réel : distortion, filtre (LP/HP/BP/Notch), speed/pitch
- Export en WAV

### ◉ Manual Rec
- Capture audio système (enregistre directement le son d'un onglet Chrome)
- Capture micro
- VU-mètre en temps réel

### 💾 Persistence
- Les samples sont sauvegardés sur disque entre les sessions
- Métadonnées (nom, catégorie, source YouTube) conservées dans `metadata.json`
- Les fichiers WAV sont nommés de manière lisible : `industrial_factory_machine_ambient_01.wav`

---

## Prérequis

- **Node.js** (v18+) → [nodejs.org](https://nodejs.org)
- **Python** (Anaconda ou autre) → pour yt-dlp
- **yt-dlp** → `pip install yt-dlp`
- **ffmpeg** → `brew install ffmpeg` ou `conda install -c conda-forge ffmpeg`
- **Chrome** (recommandé pour la capture audio système)

---

## Installation

```bash
# 1. Clone ou copie le projet
cd ~/Desktop/IA_APP/app_samples_for_mpc

# 2. Installe les dépendances frontend
npm install

# 3. Installe les dépendances backend
cd server && npm install && cd ..

# 4. Installe yt-dlp et ffmpeg si pas déjà fait
pip install yt-dlp
brew install ffmpeg
```

---

## Lancement

Ouvre **deux terminaux** :

**Terminal 1 — Backend :**
```bash
export PATH="/usr/local/bin:$PATH"
cd ~/Desktop/IA_APP/app_samples_for_mpc/server
npm start
```

Tu dois voir :
```
⚙️  TDS Sampler Backend running on http://localhost:3001
✅ yt-dlp found
✅ ffmpeg found
```

**Terminal 2 — Frontend :**
```bash
cd ~/Desktop/IA_APP/app_samples_for_mpc
npm run dev
```

Ouvre **http://localhost:5173** dans Chrome.

---

## Utilisation

### Chasse automatique
1. Va sur l'onglet **Auto Hunt**
2. Vérifie que le point vert "backend connected" est visible dans le header
3. Tape un thème ou clique un preset
4. Les samples arrivent dans tes pads automatiquement

### Capture manuelle
1. Ouvre une vidéo YouTube dans un autre onglet
2. Va sur l'onglet **Manual Rec**
3. Sélectionne "System / Tab audio"
4. Clique le bouton rouge ●
5. Dans le popup du navigateur, sélectionne l'onglet YouTube et coche **"Share tab audio"**
6. Clique ■ pour arrêter
7. Le sample apparaît dans tes pads

### Édition
1. Clique **Edit** sur un pad
2. Ajuste le trim avec les sliders
3. Applique des effets (distortion, filtre, speed)
4. Clique **▶ Preview** pour écouter le résultat
5. Clique **↓** pour exporter le WAV

---

## Structure du projet

```
app_samples_for_mpc/
├── index.html              # Point d'entrée HTML
├── package.json            # Dépendances frontend (Vite + React)
├── vite.config.js          # Config Vite
├── src/
│   ├── App.jsx             # Application React principale
│   └── main.jsx            # Point d'entrée React
├── server/
│   ├── index.js            # Backend Express + yt-dlp
│   ├── package.json        # Dépendances backend
│   └── samples/            # Samples téléchargés (WAV + metadata.json)
└── README.md
```

---

## Dépannage

| Problème | Solution |
|----------|----------|
| `ffmpeg: Symbol not found` | Conflit conda/brew. Faire `conda deactivate` puis `export PATH="/usr/local/bin:$PATH"` |
| Backend offline (point rouge) | Vérifier que le terminal backend tourne sur le port 3001 |
| Hunt ne capture rien | Vérifier `ffmpeg -version` et `yt-dlp --version` dans le terminal du backend |
| Capture audio ne marche pas | Utiliser Chrome, cocher "Share tab audio" dans le popup |
| Samples disparus après relance | Vérifier que le backend tourne — les samples sont chargés depuis `server/samples/` |

---

## Stack technique

- **Frontend** : React + Vite, Web Audio API, MediaRecorder API
- **Backend** : Express.js, yt-dlp, ffmpeg
- **Audio** : WAV 44.1kHz mono

---

*Inspiré par le processus de Trent Reznor sur The Downward Spiral (1994) — sampler tout ce qui existe, le détruire, et en faire quelque chose de nouveau.*

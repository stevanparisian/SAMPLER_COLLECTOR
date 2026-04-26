#!/bin/bash
# =============================================
# TDS SAMPLER — Setup complet
# =============================================

set -e

echo ""
echo "  ⚙️  TDS SAMPLER — Installation"
echo "  ================================"
echo ""

# 1. Install yt-dlp
echo "  📦 Installing yt-dlp..."
pip install yt-dlp --quiet 2>/dev/null || pip install yt-dlp --break-system-packages --quiet 2>/dev/null
echo "  ✅ yt-dlp installed"

# 2. Check/install ffmpeg
if command -v ffmpeg &> /dev/null; then
    echo "  ✅ ffmpeg already installed"
else
    echo "  📦 Installing ffmpeg..."
    if command -v brew &> /dev/null; then
        brew install ffmpeg
    elif command -v conda &> /dev/null; then
        conda install -y -c conda-forge ffmpeg
    else
        echo "  ❌ Please install ffmpeg manually:"
        echo "     brew install ffmpeg"
        echo "     or: conda install -c conda-forge ffmpeg"
        exit 1
    fi
    echo "  ✅ ffmpeg installed"
fi

# 3. Install backend dependencies
echo "  📦 Installing backend (Express server)..."
cd server
npm install --silent
cd ..
echo "  ✅ Backend ready"

# 4. Verify
echo ""
echo "  ================================"
echo "  ✅ Setup complete!"
echo ""
echo "  To run the app, open TWO terminals:"
echo ""
echo "  Terminal 1 (backend):"
echo "    cd server && npm start"
echo ""
echo "  Terminal 2 (frontend):"
echo "    npm run dev"
echo ""
echo "  Then open http://localhost:5173 in Chrome"
echo "  ================================"
echo ""

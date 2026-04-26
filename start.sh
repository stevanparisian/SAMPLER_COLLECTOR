#!/bin/bash
# Launches both the backend and frontend together
# Press Ctrl+C to stop both

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Always run from the script's own directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "  ⚙️  SAMPLER — Starting..."
echo ""

# Backend in a subshell so it doesn't affect our cwd
( cd server && npm start ) &
BACKEND_PID=$!

sleep 2

# Frontend from project root
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  🎯 Backend:  http://localhost:3001"
echo "  🖥️  Frontend: http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop both servers"
echo ""

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM
wait

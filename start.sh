#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Starting F-Stop Comparison Tool..."
echo "Open http://127.0.0.1:5050 in your browser"
echo ""

# Open browser after a short delay
(sleep 1.5 && open http://127.0.0.1:5050) &

python3 app.py

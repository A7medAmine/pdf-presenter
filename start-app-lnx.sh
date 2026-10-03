#!/bin/bash

# PDF Presenter - App Starter
# This script launches the PDF Presenter application

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="PDF Presenter"

echo "=========================================="
echo "  Starting $APP_NAME..."
echo "=========================================="
echo ""

# Colors for output
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${BLUE}[INFO]${NC} Dependencies not found. Please run ./linux-install.sh first."
    exit 1
fi

echo "The server prints its local and network URLs below."
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

cd "$SCRIPT_DIR"
npm start

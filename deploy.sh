#!/bin/bash
# Deploy Starbot API
# Usage: ./deploy.sh
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo -e "${YELLOW}Deploying Starbot API from $REPO_DIR${NC}"

# Step 1: Install dependencies and build
echo -e "\n${GREEN}1. Building API...${NC}"
cd "$REPO_DIR"
sudo -u stella bash -lc "
  cd '$REPO_DIR'
  if [ -f .env ]; then set -a; source ./.env; set +a; fi
  npm ci
  npm run build
"

if [ ! -f "$REPO_DIR/dist/index.js" ]; then
    echo -e "${RED}Build failed - dist/index.js not found${NC}"
    exit 1
fi
echo -e "${GREEN}Build successful${NC}"

# Step 2: Push database schema
echo -e "\n${GREEN}2. Syncing database schema...${NC}"
sudo -u stella bash -lc "
  cd '$REPO_DIR'
  if [ -f .env ]; then set -a; source ./.env; set +a; fi
  npx prisma db push
"
echo -e "${GREEN}Schema synced${NC}"

# Step 3: Install systemd service
echo -e "\n${GREEN}3. Installing systemd service...${NC}"
sudo cp "$REPO_DIR/deploy/starbot-api.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable starbot-api
echo -e "${GREEN}Service installed${NC}"

# Step 4: Restart
echo -e "\n${GREEN}4. Restarting starbot-api...${NC}"
sudo systemctl restart starbot-api
sleep 2

if sudo systemctl is-active --quiet starbot-api; then
    echo -e "${GREEN}starbot-api is running${NC}"
else
    echo -e "${RED}starbot-api failed to start${NC}"
    echo -e "${YELLOW}View logs: sudo journalctl -u starbot-api -n 50${NC}"
    exit 1
fi

# Step 5: Verify
echo -e "\n${GREEN}5. Verifying...${NC}"
if curl -sf http://localhost:3737/v1/health > /dev/null; then
    echo -e "${GREEN}API health check passed${NC}"
else
    echo -e "${RED}API health check failed${NC}"
fi

echo -e "\n${GREEN}API deployment complete!${NC}"

#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Custom name is required
CUSTOM_NAME=$1

if [ -z "$CUSTOM_NAME" ]; then
    echo -e "${RED}ERROR: Custom name is required!${NC}"
    echo -e "${YELLOW}Usage: $0 <custom-name>${NC}"
    echo -e "${YELLOW}Example: $0 issue38${NC}"
    echo -e "${YELLOW}  This will create tags like: 0.3.1-dev-issue38${NC}"
    exit 1
fi

# Configuration
DOCKER_USERNAME="zimengxiong"
IMAGE_NAME="excalidash"
BASE_VERSION=$(node -e "try { console.log(require('fs').readFileSync('VERSION', 'utf8').trim()) } catch { console.log('0.0.0') }")
VERSION="${BASE_VERSION}-dev-${CUSTOM_NAME}"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo -e "${BLUE}===========================================${NC}"
echo -e "${BLUE}ExcaliDash Custom Dev Release${NC}"
echo -e "${BLUE}===========================================${NC}"
echo ""
echo -e "${YELLOW}Branch:       ${CURRENT_BRANCH}${NC}"
echo -e "${YELLOW}Base version: ${BASE_VERSION}${NC}"
echo -e "${YELLOW}Custom name:  ${CUSTOM_NAME}${NC}"
echo -e "${YELLOW}Full tag:     ${VERSION}${NC}"
echo ""
echo -e "${YELLOW}This will publish images with tag: ${VERSION}${NC}"
echo -e "${YELLOW}Dev images will NOT update 'latest' or 'dev' tags${NC}"
echo ""

# Confirm before proceeding
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Aborted.${NC}"
    exit 1
fi

# Check if logged in to Docker Hub
echo -e "${YELLOW}Checking Docker Hub authentication...${NC}"
if ! docker info | grep -q "Username: $DOCKER_USERNAME"; then
    echo -e "${YELLOW}Not logged in. Please login to Docker Hub:${NC}"
    docker login
else
    echo -e "${GREEN}✓ Already logged in as $DOCKER_USERNAME${NC}"
fi

# Create buildx builder if it doesn't exist
echo -e "${YELLOW}Setting up buildx builder...${NC}"
if ! docker buildx inspect excalidash-builder > /dev/null 2>&1; then
    echo -e "${YELLOW}Creating new buildx builder...${NC}"
    docker buildx create --name excalidash-builder --use --bootstrap
else
    echo -e "${GREEN}✓ Using existing buildx builder${NC}"
    docker buildx use excalidash-builder
fi

# Build and push backend image
echo ""
echo -e "${BLUE}Building and pushing backend image...${NC}"
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag $DOCKER_USERNAME/$IMAGE_NAME-backend:$VERSION \
    --file backend/Dockerfile \
    --push \
    backend/

echo -e "${GREEN}✓ Backend image pushed successfully${NC}"

# Build and push frontend image
echo ""
echo -e "${BLUE}Building and pushing frontend image...${NC}"
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag $DOCKER_USERNAME/$IMAGE_NAME-frontend:$VERSION \
    --build-arg VITE_APP_VERSION=$VERSION \
    --file frontend/Dockerfile \
    --push \
    .

echo -e "${GREEN}✓ Frontend image pushed successfully${NC}"

echo ""
echo -e "${BLUE}===========================================${NC}"
echo -e "${GREEN}✓ Custom dev images published!${NC}"
echo -e "${BLUE}===========================================${NC}"
echo ""
echo -e "${YELLOW}Images published:${NC}"
echo -e "  • $DOCKER_USERNAME/$IMAGE_NAME-backend:$VERSION"
echo -e "  • $DOCKER_USERNAME/$IMAGE_NAME-frontend:$VERSION"
echo ""
echo -e "${YELLOW}To use these images in docker-compose:${NC}"
echo -e "${BLUE}  services:"
echo -e "    backend:"
echo -e "      image: $DOCKER_USERNAME/$IMAGE_NAME-backend:$VERSION"
echo -e "    frontend:"
echo -e "      image: $DOCKER_USERNAME/$IMAGE_NAME-frontend:$VERSION${NC}"
echo ""

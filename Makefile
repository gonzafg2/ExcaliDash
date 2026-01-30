# ExcaliDash Makefile
# Comprehensive development, testing, and release automation

.PHONY: help install dev build test test-frontend test-backend test-e2e test-e2e-docker \
        lint lint-frontend lint-backend clean docker-build docker-run docker-down docker-logs \
        release pre-release version-bump changelog db-migrate db-reset

# Colors
GREEN  := \033[0;32m
YELLOW := \033[1;33m
BLUE   := \033[0;34m
RED    := \033[0;31m
NC     := \033[0m

# Configuration
DOCKER_USERNAME := zimengxiong
IMAGE_NAME := excalidash
VERSION := $(shell cat VERSION 2>/dev/null || echo "0.0.0")

# Default target
.DEFAULT_GOAL := help

#===============================================================================
# HELP
#===============================================================================

help: ## Show this help message
	@echo ""
	@echo "$(GREEN)ExcaliDash Makefile$(NC)"
	@echo "$(GREEN)==================$(NC)"
	@echo ""
	@echo "$(YELLOW)Usage:$(NC) make [target]"
	@echo ""
	@echo "$(BLUE)Development:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | grep -E '(install|dev|build|lint|clean)' | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(BLUE)Testing:$(NC)"
	@grep -E '^test[-a-zA-Z0-9_]*:.*## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(BLUE)Docker:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | grep -E '(docker)' | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(BLUE)Release:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | grep -E '(release|version|changelog)' | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(BLUE)Database:$(NC)"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | grep -E '(db-)' | awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-20s$(NC) %s\n", $$1, $$2}'
	@echo ""
	@echo "$(YELLOW)Current version:$(NC) $(VERSION)"
	@echo ""

#===============================================================================
# DEVELOPMENT
#===============================================================================

install: ## Install all dependencies (frontend, backend, e2e)
	@echo "$(YELLOW)Installing frontend dependencies...$(NC)"
	cd frontend && npm install
	@echo "$(YELLOW)Installing backend dependencies...$(NC)"
	cd backend && npm install
	@echo "$(YELLOW)Installing e2e dependencies...$(NC)"
	cd e2e && npm install
	@echo "$(GREEN)All dependencies installed!$(NC)"

dev: ## Start development servers (frontend + backend)
	@echo "$(YELLOW)Starting development servers...$(NC)"
	@echo "$(BLUE)Backend will run on port 8000, Frontend on port 5173$(NC)"
	@trap 'kill 0' INT; \
		(cd backend && npm run dev) & \
		(cd frontend && npm run dev) & \
		wait

dev-frontend: ## Start frontend dev server only
	cd frontend && npm run dev

dev-backend: ## Start backend dev server only
	cd backend && npm run dev

build: ## Build frontend and backend for production
	@echo "$(YELLOW)Building frontend...$(NC)"
	cd frontend && npm run build
	@echo "$(GREEN)Build complete!$(NC)"

lint: lint-frontend lint-backend ## Run linters for frontend and backend

lint-frontend: ## Run frontend linter
	@echo "$(YELLOW)Linting frontend...$(NC)"
	cd frontend && npm run lint

lint-backend: ## Run backend linter (if available)
	@echo "$(YELLOW)Backend linting not configured$(NC)"

clean: ## Clean build artifacts and node_modules
	@echo "$(YELLOW)Cleaning build artifacts...$(NC)"
	rm -rf frontend/dist
	rm -rf frontend/node_modules/.vite
	@echo "$(GREEN)Clean complete!$(NC)"

clean-all: clean ## Clean everything including node_modules
	@echo "$(RED)Removing all node_modules...$(NC)"
	rm -rf frontend/node_modules
	rm -rf backend/node_modules
	rm -rf e2e/node_modules
	@echo "$(GREEN)Full clean complete!$(NC)"

#===============================================================================
# TESTING
#===============================================================================

test: test-frontend test-backend ## Run all tests (frontend + backend unit tests)
	@echo "$(GREEN)All unit tests passed!$(NC)"

test-all: test test-e2e ## Run ALL tests (unit + e2e)
	@echo "$(GREEN)All tests passed!$(NC)"

test-frontend: ## Run frontend unit tests
	@echo "$(YELLOW)Running frontend tests...$(NC)"
	cd frontend && npm test

test-backend: ## Run backend unit tests
	@echo "$(YELLOW)Running backend tests...$(NC)"
	cd backend && npm test

test-coverage: ## Run all unit tests with coverage
	@echo "$(YELLOW)Running tests with coverage...$(NC)"
	cd frontend && npm run test:coverage
	cd backend && npm run test:coverage

test-e2e: ## Run e2e tests (starts servers automatically)
	@echo "$(YELLOW)Running e2e tests...$(NC)"
	cd e2e && ./run-e2e.sh

test-e2e-headed: ## Run e2e tests with visible browser
	@echo "$(YELLOW)Running e2e tests (headed)...$(NC)"
	cd e2e && ./run-e2e.sh --headed

test-e2e-docker: ## Run e2e tests in Docker containers
	@echo "$(YELLOW)Running e2e tests in Docker...$(NC)"
	cd e2e && ./run-e2e.sh --docker

test-watch: ## Run tests in watch mode
	@trap 'kill 0' INT; \
		(cd frontend && npm run test:watch) & \
		(cd backend && npm run test:watch) & \
		wait

#===============================================================================
# DOCKER
#===============================================================================

docker-build: ## Build Docker images locally
	@echo "$(YELLOW)Building Docker images...$(NC)"
	docker-compose build
	@echo "$(GREEN)Docker images built!$(NC)"

docker-run: ## Start Docker containers (docker-compose up)
	@echo "$(YELLOW)Starting Docker containers...$(NC)"
	docker-compose up

docker-up: docker-run ## Alias for docker-run

docker-run-detached: ## Start Docker containers in background
	@echo "$(YELLOW)Starting Docker containers (detached)...$(NC)"
	docker-compose up -d
	@echo "$(GREEN)Containers started! Access at http://localhost:6767$(NC)"

docker-down: ## Stop and remove Docker containers
	@echo "$(YELLOW)Stopping Docker containers...$(NC)"
	docker-compose down
	@echo "$(GREEN)Containers stopped!$(NC)"

docker-down-volumes: ## Stop containers and remove volumes
	@echo "$(RED)Stopping containers and removing volumes...$(NC)"
	docker-compose down -v

docker-logs: ## Show Docker container logs
	docker-compose logs -f

docker-ps: ## Show running Docker containers
	docker-compose ps

docker-restart: docker-down docker-run ## Restart Docker containers

docker-rebuild: docker-down docker-build docker-run ## Rebuild and restart containers

#===============================================================================
# VERSION MANAGEMENT
#===============================================================================

version: ## Show current version
	@echo "$(YELLOW)Current version:$(NC) $(VERSION)"

version-bump: ## Interactive version bump
	@echo "$(YELLOW)Current version:$(NC) $(VERSION)"
	@echo ""
	@echo "$(BLUE)Select version bump type:$(NC)"
	@echo "  1) patch ($(VERSION) -> $$(echo $(VERSION) | awk -F. '{print $$1"."$$2"."$$3+1}'))"
	@echo "  2) minor ($(VERSION) -> $$(echo $(VERSION) | awk -F. '{print $$1"."$$2+1".0"}'))"
	@echo "  3) major ($(VERSION) -> $$(echo $(VERSION) | awk -F. '{print $$1+1".0.0"}'))"
	@echo "  4) custom"
	@echo ""
	@read -p "Enter choice [1-4]: " choice; \
	case $$choice in \
		1) NEW_VERSION=$$(echo $(VERSION) | awk -F. '{print $$1"."$$2"."$$3+1}') ;; \
		2) NEW_VERSION=$$(echo $(VERSION) | awk -F. '{print $$1"."$$2+1".0"}') ;; \
		3) NEW_VERSION=$$(echo $(VERSION) | awk -F. '{print $$1+1".0.0"}') ;; \
		4) read -p "Enter new version: " NEW_VERSION ;; \
		*) echo "$(RED)Invalid choice$(NC)"; exit 1 ;; \
	esac; \
	echo "$(YELLOW)Bumping version to $$NEW_VERSION...$(NC)"; \
	echo "$$NEW_VERSION" > VERSION; \
	sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json 2>/dev/null || \
		sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json; \
	sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json 2>/dev/null || \
		sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json; \
	echo "$(GREEN)Version bumped to $$NEW_VERSION$(NC)"

#===============================================================================
# RELEASE
#===============================================================================

changelog: ## Edit release notes (RELEASE.md)
	@echo "$(YELLOW)Opening RELEASE.md for editing...$(NC)"
	@if [ -z "$$EDITOR" ]; then \
		echo "$(RED)No EDITOR set. Using vim.$(NC)"; \
		vim RELEASE.md; \
	else \
		$$EDITOR RELEASE.md; \
	fi

release: ## Full release workflow (main branch only)
	@echo "$(GREEN)===========================================$(NC)"
	@echo "$(GREEN)     ExcaliDash Release Workflow$(NC)"
	@echo "$(GREEN)===========================================$(NC)"
	@echo ""
	@# Branch check
	@CURRENT_BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$CURRENT_BRANCH" != "main" ]; then \
		echo "$(RED)ERROR: Releases must be made from 'main' branch!$(NC)"; \
		echo "$(RED)Current branch: $$CURRENT_BRANCH$(NC)"; \
		echo "$(YELLOW)Please switch to main and try again.$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)✓ On main branch$(NC)"
	@echo ""
	@# Pull latest
	@echo "$(YELLOW)Pulling latest changes...$(NC)"
	@git pull origin main
	@echo "$(GREEN)✓ Up to date with remote$(NC)"
	@echo ""
	@# Show current status
	@echo "$(YELLOW)Current status:$(NC)"
	@git status --short || true
	@echo ""
	@# Run tests
	@echo "$(YELLOW)Running tests...$(NC)"
	@$(MAKE) test
	@echo "$(GREEN)✓ All tests passed$(NC)"
	@echo ""
	@# Version bump - inline with clear options
	@CURRENT=$$(cat VERSION); \
	PATCH=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2"."$$3+1}'); \
	MINOR=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2+1".0"}'); \
	MAJOR=$$(echo $$CURRENT | awk -F. '{print $$1+1".0.0"}'); \
	echo "$(YELLOW)Current version: $$CURRENT$(NC)"; \
	echo ""; \
	echo "$(BLUE)Select version bump:$(NC)"; \
	echo "  1) patch  → $$PATCH"; \
	echo "  2) minor  → $$MINOR"; \
	echo "  3) major  → $$MAJOR"; \
	echo "  4) custom"; \
	echo "  5) skip (keep $$CURRENT)"; \
	echo ""; \
	read -p "Enter choice [1-5]: " choice; \
	case $$choice in \
		1) NEW_VERSION=$$PATCH ;; \
		2) NEW_VERSION=$$MINOR ;; \
		3) NEW_VERSION=$$MAJOR ;; \
		4) read -p "Enter new version: " NEW_VERSION ;; \
		5) NEW_VERSION=$$CURRENT ;; \
		*) echo "$(RED)Invalid choice, using current$(NC)"; NEW_VERSION=$$CURRENT ;; \
	esac; \
	if [ "$$NEW_VERSION" != "$$CURRENT" ]; then \
		echo "$(YELLOW)Bumping version to $$NEW_VERSION...$(NC)"; \
		echo "$$NEW_VERSION" > VERSION; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json; \
		echo "$(GREEN)✓ Version bumped to $$NEW_VERSION$(NC)"; \
	else \
		echo "$(YELLOW)Keeping version $$CURRENT$(NC)"; \
	fi
	@echo ""
	@# Release notes
	@echo "$(YELLOW)Release notes (RELEASE.md):$(NC)"
	@read -p "Edit RELEASE.md now? [Y/n]: " edit; \
	if [ "$$edit" != "n" ] && [ "$$edit" != "N" ]; then \
		$(MAKE) changelog; \
	fi
	@echo ""
	@# Show summary before commit
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(BLUE)===========================================$(NC)"; \
	echo "$(BLUE)Release Summary$(NC)"; \
	echo "$(BLUE)===========================================$(NC)"; \
	echo "  Version:  v$$NEW_VERSION"; \
	echo "  Branch:   main"; \
	echo "  Tag:      v$$NEW_VERSION"; \
	echo ""; \
	echo "$(YELLOW)Changes to be committed:$(NC)"; \
	git status --short; \
	echo ""
	@read -p "$(YELLOW)Proceed with release? [y/N]: $(NC)" confirm; \
	if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then \
		echo "$(RED)Release aborted.$(NC)"; \
		exit 1; \
	fi
	@echo ""
	@# Commit changes
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(YELLOW)Committing release...$(NC)"; \
	git add -A; \
	git commit -m "chore: release v$$NEW_VERSION" || echo "$(YELLOW)Nothing to commit$(NC)"
	@echo "$(GREEN)✓ Changes committed$(NC)"
	@echo ""
	@# Push to remote
	@echo "$(YELLOW)Pushing to remote...$(NC)"
	@git push origin main
	@echo "$(GREEN)✓ Pushed to origin/main$(NC)"
	@echo ""
	@# Create git tag
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(YELLOW)Creating tag v$$NEW_VERSION...$(NC)"; \
	git tag -a "v$$NEW_VERSION" -m "Release v$$NEW_VERSION"; \
	git push origin "v$$NEW_VERSION"
	@echo "$(GREEN)✓ Tag v$$NEW_VERSION created and pushed$(NC)"
	@echo ""
	@# Create GitHub release
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(YELLOW)Creating GitHub release...$(NC)"; \
	if command -v gh &> /dev/null; then \
		gh release create "v$$NEW_VERSION" \
			--title "ExcaliDash v$$NEW_VERSION" \
			--notes-file RELEASE.md; \
		echo "$(GREEN)✓ GitHub release created$(NC)"; \
	else \
		echo "$(RED)gh CLI not installed!$(NC)"; \
		echo "$(YELLOW)Install with: brew install gh$(NC)"; \
		echo "$(YELLOW)Then run: gh auth login$(NC)"; \
		exit 1; \
	fi
	@echo ""
	@# Build and push Docker images
	@echo "$(YELLOW)Building and pushing Docker images...$(NC)"
	@./publish-docker.sh
	@echo ""
	@echo "$(GREEN)===========================================$(NC)"
	@echo "$(GREEN)     Release Complete!$(NC)"
	@echo "$(GREEN)===========================================$(NC)"
	@NEW_VERSION=$$(cat VERSION); \
	echo ""; \
	echo "$(GREEN)✓ Version: v$$NEW_VERSION$(NC)"; \
	echo "$(GREEN)✓ Git tag pushed$(NC)"; \
	echo "$(GREEN)✓ GitHub release created$(NC)"; \
	echo "$(GREEN)✓ Docker images published$(NC)"

pre-release: ## Pre-release workflow (pre-release branch only)
	@echo "$(BLUE)===========================================$(NC)"
	@echo "$(BLUE)   ExcaliDash Pre-Release Workflow$(NC)"
	@echo "$(BLUE)===========================================$(NC)"
	@echo ""
	@# Branch check
	@CURRENT_BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$CURRENT_BRANCH" != "pre-release" ]; then \
		echo "$(RED)ERROR: Pre-releases must be made from 'pre-release' branch!$(NC)"; \
		echo "$(RED)Current branch: $$CURRENT_BRANCH$(NC)"; \
		echo "$(YELLOW)Please switch to pre-release and try again.$(NC)"; \
		exit 1; \
	fi
	@echo "$(GREEN)✓ On pre-release branch$(NC)"
	@echo ""
	@# Pull latest
	@echo "$(YELLOW)Pulling latest changes...$(NC)"
	@git pull origin pre-release
	@echo "$(GREEN)✓ Up to date with remote$(NC)"
	@echo ""
	@# Show current status
	@echo "$(YELLOW)Current status:$(NC)"
	@git status --short || true
	@echo ""
	@# Run tests
	@echo "$(YELLOW)Running tests...$(NC)"
	@$(MAKE) test
	@echo "$(GREEN)✓ All tests passed$(NC)"
	@echo ""
	@# Version bump - inline with clear options
	@CURRENT=$$(cat VERSION); \
	PATCH=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2"."$$3+1}'); \
	MINOR=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2+1".0"}'); \
	MAJOR=$$(echo $$CURRENT | awk -F. '{print $$1+1".0.0"}'); \
	echo "$(YELLOW)Current version: $$CURRENT$(NC)"; \
	echo ""; \
	echo "$(BLUE)Select version bump:$(NC)"; \
	echo "  1) patch  → $$PATCH-dev"; \
	echo "  2) minor  → $$MINOR-dev"; \
	echo "  3) major  → $$MAJOR-dev"; \
	echo "  4) custom"; \
	echo "  5) skip (keep $$CURRENT-dev)"; \
	echo ""; \
	read -p "Enter choice [1-5]: " choice; \
	case $$choice in \
		1) NEW_VERSION=$$PATCH ;; \
		2) NEW_VERSION=$$MINOR ;; \
		3) NEW_VERSION=$$MAJOR ;; \
		4) read -p "Enter new version (without -dev suffix): " NEW_VERSION ;; \
		5) NEW_VERSION=$$CURRENT ;; \
		*) echo "$(RED)Invalid choice, using current$(NC)"; NEW_VERSION=$$CURRENT ;; \
	esac; \
	if [ "$$NEW_VERSION" != "$$CURRENT" ]; then \
		echo "$(YELLOW)Bumping version to $$NEW_VERSION...$(NC)"; \
		echo "$$NEW_VERSION" > VERSION; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json; \
		echo "$(GREEN)✓ Version bumped to $$NEW_VERSION$(NC)"; \
	else \
		echo "$(YELLOW)Keeping version $$CURRENT$(NC)"; \
	fi
	@echo ""
	@# Release notes
	@echo "$(YELLOW)Release notes (RELEASE.md):$(NC)"
	@read -p "Edit RELEASE.md now? [Y/n]: " edit; \
	if [ "$$edit" != "n" ] && [ "$$edit" != "N" ]; then \
		$(MAKE) changelog; \
	fi
	@echo ""
	@# Show summary before commit
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(BLUE)===========================================$(NC)"; \
	echo "$(BLUE)Pre-Release Summary$(NC)"; \
	echo "$(BLUE)===========================================$(NC)"; \
	echo "  Version:  v$$NEW_VERSION-dev"; \
	echo "  Branch:   pre-release"; \
	echo "  Tag:      v$$NEW_VERSION-dev (pre-release)"; \
	echo ""; \
	echo "$(YELLOW)Changes to be committed:$(NC)"; \
	git status --short; \
	echo ""
	@read -p "$(YELLOW)Proceed with pre-release? [y/N]: $(NC)" confirm; \
	if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then \
		echo "$(RED)Pre-release aborted.$(NC)"; \
		exit 1; \
	fi
	@echo ""
	@# Commit changes
	@NEW_VERSION=$$(cat VERSION); \
	echo "$(YELLOW)Committing pre-release...$(NC)"; \
	git add -A; \
	git commit -m "chore: pre-release v$$NEW_VERSION-dev" || echo "$(YELLOW)Nothing to commit$(NC)"
	@echo "$(GREEN)✓ Changes committed$(NC)"
	@echo ""
	@# Push to remote
	@echo "$(YELLOW)Pushing to remote...$(NC)"
	@git push origin pre-release
	@echo "$(GREEN)✓ Pushed to origin/pre-release$(NC)"
	@echo ""
	@# Create git tag
	@NEW_VERSION=$$(cat VERSION); \
	PRE_TAG="v$$NEW_VERSION-dev"; \
	echo "$(YELLOW)Creating tag $$PRE_TAG...$(NC)"; \
	git tag -a "$$PRE_TAG" -m "Pre-release $$PRE_TAG"; \
	git push origin "$$PRE_TAG"
	@echo "$(GREEN)✓ Tag $$PRE_TAG created and pushed$(NC)"
	@echo ""
	@# Create GitHub pre-release
	@NEW_VERSION=$$(cat VERSION); \
	PRE_TAG="v$$NEW_VERSION-dev"; \
	echo "$(YELLOW)Creating GitHub pre-release...$(NC)"; \
	if command -v gh &> /dev/null; then \
		gh release create "$$PRE_TAG" \
			--title "ExcaliDash $$PRE_TAG (Pre-release)" \
			--notes-file RELEASE.md \
			--prerelease; \
		echo "$(GREEN)✓ GitHub pre-release created$(NC)"; \
	else \
		echo "$(RED)gh CLI not installed!$(NC)"; \
		echo "$(YELLOW)Install with: brew install gh$(NC)"; \
		echo "$(YELLOW)Then run: gh auth login$(NC)"; \
		exit 1; \
	fi
	@echo ""
	@# Build and push Docker images
	@echo "$(YELLOW)Building and pushing Docker images...$(NC)"
	@./publish-docker-prerelease.sh
	@echo ""
	@echo "$(BLUE)===========================================$(NC)"
	@echo "$(GREEN)     Pre-Release Complete!$(NC)"
	@echo "$(BLUE)===========================================$(NC)"
	@NEW_VERSION=$$(cat VERSION); \
	echo ""; \
	echo "$(GREEN)✓ Version: v$$NEW_VERSION-dev$(NC)"; \
	echo "$(GREEN)✓ Git tag pushed$(NC)"; \
	echo "$(GREEN)✓ GitHub pre-release created$(NC)"; \
	echo "$(GREEN)✓ Docker images published$(NC)"

release-docker: ## Build and push release Docker images
	./publish-docker.sh

pre-release-docker: ## Build and push pre-release Docker images
	./publish-docker-prerelease.sh

dev-release: ## Build and push custom dev release (usage: make dev-release NAME=issue38)
	@if [ -z "$(NAME)" ]; then \
		echo "$(RED)ERROR: NAME parameter is required!$(NC)"; \
		echo "$(YELLOW)Usage: make dev-release NAME=<custom-name>$(NC)"; \
		echo "$(YELLOW)Example: make dev-release NAME=issue38$(NC)"; \
		echo "$(YELLOW)  This will create tags like: 0.3.1-dev-issue38$(NC)"; \
		exit 1; \
	fi
	@echo "$(BLUE)Building custom dev release: $(NAME)$(NC)"
	@./publish-docker-dev.sh $(NAME)

#===============================================================================
# DATABASE
#===============================================================================

db-migrate: ## Run database migrations
	@echo "$(YELLOW)Running database migrations...$(NC)"
	cd backend && npx prisma migrate dev
	@echo "$(GREEN)Migrations complete!$(NC)"

db-generate: ## Generate Prisma client
	@echo "$(YELLOW)Generating Prisma client...$(NC)"
	cd backend && npx prisma generate
	@echo "$(GREEN)Client generated!$(NC)"

db-reset: ## Reset database (WARNING: destroys all data)
	@echo "$(RED)WARNING: This will destroy all data!$(NC)"
	@read -p "Are you sure? [y/N]: " confirm; \
	if [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ]; then \
		cd backend && npx prisma migrate reset --force; \
		echo "$(GREEN)Database reset complete!$(NC)"; \
	else \
		echo "$(YELLOW)Cancelled$(NC)"; \
	fi

db-studio: ## Open Prisma Studio (database GUI)
	@echo "$(YELLOW)Opening Prisma Studio...$(NC)"
	cd backend && npx prisma studio

#===============================================================================
# QUICK ALIASES
#===============================================================================

up: docker-run ## Alias: Start Docker containers
down: docker-down ## Alias: Stop Docker containers
logs: docker-logs ## Alias: Show Docker logs
t: test ## Alias: Run unit tests
ta: test-all ## Alias: Run all tests

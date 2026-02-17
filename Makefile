.PHONY: help install dev build test test-frontend test-backend test-e2e test-e2e-docker \
        lint lint-frontend lint-backend clean docker-build docker-run docker-down docker-logs \
        release pre-release version-bump changelog changelog-open changelog-keep db-migrate db-reset

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

dev: ## Start backend+frontend in a tmux split screen
	@command -v tmux >/dev/null 2>&1 || { \
		echo "$(RED)tmux is required for 'make dev'$(NC)"; \
		echo "$(YELLOW)Install tmux and try again.$(NC)"; \
		exit 1; \
	}
	@SESSION="excalidash-dev"; \
	if tmux has-session -t $$SESSION 2>/dev/null; then \
		echo "$(YELLOW)Using existing tmux session: $$SESSION$(NC)"; \
	else \
		echo "$(YELLOW)Creating tmux session: $$SESSION$(NC)"; \
		tmux new-session -d -s $$SESSION -c "$(CURDIR)" "cd backend && npm run dev"; \
		tmux split-window -h -t $$SESSION:0 -c "$(CURDIR)" "cd frontend && npm run dev"; \
		tmux select-layout -t $$SESSION:0 even-horizontal; \
		tmux select-pane -t $$SESSION:0.0; \
	fi; \
	if [ -n "$$TMUX" ]; then \
		tmux switch-client -t $$SESSION; \
	else \
		tmux attach -t $$SESSION; \
	fi

dev-stop: ## Stop the tmux dev session
	@SESSION="excalidash-dev"; \
	if tmux has-session -t $$SESSION 2>/dev/null; then \
		tmux kill-session -t $$SESSION; \
		echo "$(GREEN)Stopped tmux session: $$SESSION$(NC)"; \
	else \
		echo "$(YELLOW)No tmux session named $$SESSION is running$(NC)"; \
	fi

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
	@echo "All unit tests passed."

test-all: test test-e2e ## Run ALL tests (unit + e2e)
	@echo "All tests passed."

test-frontend: ## Run frontend unit tests
	@echo "Running frontend tests..."
	cd frontend && npm test

test-backend: ## Run backend unit tests
	@echo "Running backend tests..."
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

changelog: ## Reset RELEASE.md from template and open it for editing
	@echo "Generating fresh RELEASE.md..."
	@if [ "$(PRERELEASE)" = "1" ]; then \
		node scripts/reset-release-notes.cjs --prerelease; \
	else \
		node scripts/reset-release-notes.cjs; \
	fi
	@$(MAKE) changelog-open

changelog-open: ## Open current RELEASE.md without resetting
	@echo "Opening RELEASE.md for editing..."
	@if [ -n "$$EDITOR" ]; then \
		$$EDITOR RELEASE.md; \
	elif command -v code >/dev/null 2>&1; then \
		code --wait RELEASE.md; \
	elif command -v open >/dev/null 2>&1; then \
		open RELEASE.md; \
		echo "Edit RELEASE.md in your GUI editor, then press Enter to continue..."; \
		read _; \
	elif command -v xdg-open >/dev/null 2>&1; then \
		xdg-open RELEASE.md; \
		echo "Edit RELEASE.md in your GUI editor, then press Enter to continue..."; \
		read _; \
	else \
		echo "No GUI opener found. Falling back to vi."; \
		vi RELEASE.md; \
	fi

changelog-keep: ## Alias: open current RELEASE.md without resetting
	@$(MAKE) changelog-open

release: ## Full release workflow (main branch only)
	@# Branch check
	@CURRENT_BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$CURRENT_BRANCH" != "main" ]; then \
		echo "ERROR: Releases must be made from 'main' branch!"; \
		echo "Current branch: $$CURRENT_BRANCH"; \
		echo "Please switch to main and try again."; \
		exit 1; \
	fi
	@echo "On main branch."
	@echo ""
	@# Pull latest
	@echo "Pulling latest changes..."
	@git pull origin main
	@echo "Up to date with remote."
	@echo ""
	@# Show current status
	@echo "Current status:"
	@git status --short || true
	@echo ""
	@# Run tests
	@echo "Running tests..."
	@$(MAKE) test
	@echo "All tests passed."
	@echo ""
	@# Version bump - inline with clear options
	@CURRENT=$$(cat VERSION); \
	PATCH=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2"."$$3+1}'); \
	MINOR=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2+1".0"}'); \
	MAJOR=$$(echo $$CURRENT | awk -F. '{print $$1+1".0.0"}'); \
	echo "Current version: $$CURRENT"; \
	echo ""; \
	echo "Select version bump:"; \
	echo "  1) patch -> $$PATCH"; \
	echo "  2) minor -> $$MINOR"; \
	echo "  3) major -> $$MAJOR"; \
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
		*) echo "Invalid choice, using current."; NEW_VERSION=$$CURRENT ;; \
	esac; \
	if [ "$$NEW_VERSION" != "$$CURRENT" ]; then \
		echo "Bumping version to $$NEW_VERSION..."; \
		echo "$$NEW_VERSION" > VERSION; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json; \
		echo "Version bumped to $$NEW_VERSION."; \
	else \
		echo "Keeping version $$CURRENT."; \
	fi
	@echo ""
	@# Release notes
	@echo "Preparing fresh release notes (RELEASE.md)..."
	@$(MAKE) changelog
	@echo ""
	@# Show summary before commit
	@NEW_VERSION=$$(cat VERSION); \
	echo "Release summary:"; \
	echo "  Version: v$$NEW_VERSION"; \
	echo "  Branch: main"; \
	echo "  Tag: v$$NEW_VERSION"; \
	echo ""; \
	echo "Changes to be committed:"; \
	git status --short; \
	echo ""
	@read -p "Proceed with release? [y/N]: " confirm; \
	if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then \
		echo "Release aborted."; \
		exit 1; \
	fi
	@echo ""
	@# Commit changes
	@NEW_VERSION=$$(cat VERSION); \
	echo "Committing release..."; \
	git add -A; \
	git commit -m "chore: release v$$NEW_VERSION" || echo "Nothing to commit."
	@echo "Changes committed."
	@echo ""
	@# Push to remote
	@echo "Pushing to remote..."
	@git push origin main
	@echo "Pushed to origin/main."
	@echo ""
	@# Create git tag
	@NEW_VERSION=$$(cat VERSION); \
	echo "Creating tag v$$NEW_VERSION..."; \
	git tag -a "v$$NEW_VERSION" -m "Release v$$NEW_VERSION"; \
	git push origin "v$$NEW_VERSION"
	@echo "Tag v$$NEW_VERSION created and pushed."
	@echo ""
	@# Create GitHub release
	@NEW_VERSION=$$(cat VERSION); \
	echo "Creating GitHub release..."; \
	if command -v gh &> /dev/null; then \
		gh release create "v$$NEW_VERSION" \
			--title "ExcaliDash v$$NEW_VERSION" \
			--notes-file RELEASE.md; \
		echo "GitHub release created."; \
	else \
		echo "gh CLI not installed!"; \
		echo "Install with: brew install gh"; \
		echo "Then run: gh auth login"; \
		exit 1; \
	fi
	@echo ""
	@# Build and push Docker images
	@echo "Building and pushing Docker images..."
	@./scripts/publish-docker.sh
	@echo ""
	@NEW_VERSION=$$(cat VERSION); \
	echo "Release complete."; \
	echo "Version: v$$NEW_VERSION"; \
	echo "Git tag pushed."; \
	echo "GitHub release created."; \
	echo "Docker images published."

pre-release: ## Pre-release workflow (pre-release branch only)
	@# Branch check
	@CURRENT_BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	if [ "$$CURRENT_BRANCH" != "pre-release" ]; then \
		echo "ERROR: Pre-releases must be made from 'pre-release' branch!"; \
		echo "Current branch: $$CURRENT_BRANCH"; \
		echo "Please switch to pre-release and try again."; \
		exit 1; \
	fi
	@echo "On pre-release branch."
	@echo ""
	@# Pull latest
	@echo "Pulling latest changes..."
	@git pull origin pre-release
	@echo "Up to date with remote."
	@echo ""
	@# Show current status
	@echo "Current status:"
	@git status --short || true
	@echo ""
	@# Run tests
	@echo "Running tests..."
	@$(MAKE) test
	@echo "All tests passed."
	@echo ""
	@# Version bump - inline with clear options
	@CURRENT=$$(cat VERSION); \
	PATCH=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2"."$$3+1}'); \
	MINOR=$$(echo $$CURRENT | awk -F. '{print $$1"."$$2+1".0"}'); \
	MAJOR=$$(echo $$CURRENT | awk -F. '{print $$1+1".0.0"}'); \
	echo "Current version: $$CURRENT"; \
	echo ""; \
	echo "Select version bump:"; \
	echo "  1) patch -> $$PATCH-dev"; \
	echo "  2) minor -> $$MINOR-dev"; \
	echo "  3) major -> $$MAJOR-dev"; \
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
		*) echo "Invalid choice, using current."; NEW_VERSION=$$CURRENT ;; \
	esac; \
	if [ "$$NEW_VERSION" != "$$CURRENT" ]; then \
		echo "Bumping version to $$NEW_VERSION..."; \
		echo "$$NEW_VERSION" > VERSION; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" frontend/package.json; \
		sed -i '' "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json 2>/dev/null || \
			sed -i "s/\"version\": \".*\"/\"version\": \"$$NEW_VERSION\"/" backend/package.json; \
		echo "Version bumped to $$NEW_VERSION."; \
	else \
		echo "Keeping version $$CURRENT."; \
	fi
	@echo ""
	@# Release notes
	@echo "Preparing fresh pre-release notes (RELEASE.md)..."
	@$(MAKE) changelog PRERELEASE=1
	@echo ""
	@# Show summary before commit
	@NEW_VERSION=$$(cat VERSION); \
	echo "Pre-release summary:"; \
	echo "  Version: v$$NEW_VERSION-dev"; \
	echo "  Branch: pre-release"; \
	echo "  Tag: v$$NEW_VERSION-dev (pre-release)"; \
	echo ""; \
	echo "Changes to be committed:"; \
	git status --short; \
	echo ""
	@read -p "Proceed with pre-release? [y/N]: " confirm; \
	if [ "$$confirm" != "y" ] && [ "$$confirm" != "Y" ]; then \
		echo "Pre-release aborted."; \
		exit 1; \
	fi
	@echo ""
	@# Commit changes
	@NEW_VERSION=$$(cat VERSION); \
	echo "Committing pre-release..."; \
	git add -A; \
	git commit -m "chore: pre-release v$$NEW_VERSION-dev" || echo "Nothing to commit."
	@echo "Changes committed."
	@echo ""
	@# Push to remote
	@echo "Pushing to remote..."
	@git push origin pre-release
	@echo "Pushed to origin/pre-release."
	@echo ""
	@# Create git tag
	@NEW_VERSION=$$(cat VERSION); \
	PRE_TAG="v$$NEW_VERSION-dev"; \
	echo "Creating tag $$PRE_TAG..."; \
	git tag -a "$$PRE_TAG" -m "Pre-release $$PRE_TAG"; \
	git push origin "$$PRE_TAG"
	@echo "Tag $$PRE_TAG created and pushed."
	@echo ""
	@# Create GitHub pre-release
	@NEW_VERSION=$$(cat VERSION); \
	PRE_TAG="v$$NEW_VERSION-dev"; \
	echo "Creating GitHub pre-release..."; \
	if command -v gh &> /dev/null; then \
		gh release create "$$PRE_TAG" \
			--title "ExcaliDash $$PRE_TAG (Pre-release)" \
			--notes-file RELEASE.md \
			--prerelease; \
		echo "GitHub pre-release created."; \
	else \
		echo "gh CLI not installed!"; \
		echo "Install with: brew install gh"; \
		echo "Then run: gh auth login"; \
		exit 1; \
	fi
	@echo ""
	@# Build and push Docker images
	@echo "Building and pushing Docker images..."
	@./scripts/publish-docker-prerelease.sh
	@echo ""
	@NEW_VERSION=$$(cat VERSION); \
	echo "Pre-release complete."; \
	echo "Version: v$$NEW_VERSION-dev"; \
	echo "Git tag pushed."; \
	echo "GitHub pre-release created."; \
	echo "Docker images published."

release-docker: ## Build and push release Docker images
	./scripts/publish-docker.sh

pre-release-docker: ## Build and push pre-release Docker images
	./scripts/publish-docker-prerelease.sh

dev-release: ## Build and push custom dev release (usage: make dev-release NAME=issue38)
	@if [ -z "$(NAME)" ]; then \
		echo "$(RED)ERROR: NAME parameter is required!$(NC)"; \
		echo "$(YELLOW)Usage: make dev-release NAME=<custom-name>$(NC)"; \
		echo "$(YELLOW)Example: make dev-release NAME=issue38$(NC)"; \
		echo "$(YELLOW)  This will create tags like: 0.3.1-dev-issue38$(NC)"; \
		exit 1; \
	fi
	@echo "$(BLUE)Building custom dev release: $(NAME)$(NC)"
	@./scripts/publish-docker-dev.sh $(NAME)

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

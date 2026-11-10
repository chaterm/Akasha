ifeq ($(OS),Windows_NT)
SHELL := pwsh.exe
.SHELLFLAGS := -NoProfile -Command
endif

.DEFAULT_GOAL := dev

.PHONY: db install migrate migrate-dry-run prod prod-dry-run dev

#   make migrate DATABASE_URL="postgresql://akasha:STRONG_DB_PASSWORD@localhost:5432/akasha?schema=public"
#   make dev DATABASE_URL="postgresql://akasha:STRONG_DB_PASSWORD@localhost:5432/akasha?schema=public"

# 部署
db:
	docker compose up -d db

# 开发
install:
	pnpm install

migrate:
	pnpm --filter ./apps/server run migration:latest

migrate-dry-run:
	pnpm --filter ./apps/server run migration:latest -- --dry-run

dev:
	pnpm run dev

# 生产
prod:
	cd apps/server && pnpm run build && node dist/database/migrate.js latest && pnpm exec cross-env DOTENV_CONFIG_PATH=../../.env DOTENV_CONFIG_QUIET=true NODE_OPTIONS=--require=dotenv/config pnpm run start:prod

prod-migrate-dry-run:
	cd apps/server && pnpm run build && node dist/database/migrate.js latest --dry-run



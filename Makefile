BINARY := bai
VERSION ?= dev

.PHONY: build run test vet tidy clean web-build release

build: ## build the bai single executable (bun --compile, SPA embedded)
	BAI_VERSION=$(VERSION) bun run scripts/compile.ts
	@if [ -f packages/web/dist/index.html ]; then \
		rm -rf dist/web && cp -R packages/web/dist dist/web; \
		echo "web SPA staged → dist/web (served by the binary on bun < 1.4)"; \
	fi
	@if [ -d packages/core/skills ]; then \
		rm -rf dist/skills && cp -R packages/core/skills dist/skills; \
		echo "bundled skills staged → dist/skills (seeded on boot on bun < 1.4)"; \
	fi

run: build ## build and start the TUI
	./dist/$(BINARY)

test: ## run all tests
	bun test

vet: ## typecheck every workspace package (tsc --noEmit)
	bun run typecheck

tidy: ## install/refresh workspace dependencies
	bun install

clean: ## remove build artifacts
	rm -rf dist

web-build: ## build the React SPA into packages/web/dist (embedded at compile time)
	bun run --filter '@bai/web' build

release: ## cross-compile release binaries for all 8 targets into dist/
	BAI_VERSION=$(VERSION) bun run scripts/compile.ts --release

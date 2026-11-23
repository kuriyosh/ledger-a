.PHONY: setup keys lint fmt test test-integration

setup:
	pnpm install --frozen-lockfile

keys:
	node --env-file-if-exists=.env chain/scripts/derive-accounts.ts

lint:
	pnpm lint

fmt:
	pnpm fmt

test:
	pnpm test

test-integration:
	pnpm test:integration

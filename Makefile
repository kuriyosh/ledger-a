.PHONY: setup generate-abis keys audit-keys lint fmt test test-contracts test-integration

setup:
	pnpm install --frozen-lockfile
	git submodule update --init --depth 1
	$(MAKE) generate-abis

generate-abis:
	forge build --root contracts src lib/safe-contracts/contracts/GnosisSafeL2.sol lib/safe-contracts/contracts/proxies/GnosisSafeProxy.sol
	pnpm --filter @ledgera/abis generate

keys:
	node --env-file-if-exists=.env chain/scripts/derive-accounts.ts

audit-keys:
	node chain/scripts/derive-accounts.ts --auditor-token

lint:
	pnpm lint
	forge fmt --check --root contracts

fmt:
	pnpm fmt
	forge fmt --root contracts

test:
	pnpm test

test-contracts:
	forge test --root contracts

test-integration:
	pnpm test:integration

CHAIN_COMPOSE = docker compose --env-file chain/versions.env --env-file .env --env-file .env.generated -f chain/compose/docker-compose.chain.yml
CHAIN_NODE = node --env-file-if-exists=.env --env-file=.env.generated

HA_COMPOSE = $(CHAIN_COMPOSE) --env-file chain/runtime/ha/peers.env -f chain/compose/docker-compose.ha.yml
HA_CONTROL = $(HA_COMPOSE) run -T --rm --no-deps ha-control node --input-type=module -

REPLICA_COMPOSE = docker compose --env-file chain/versions.env --env-file .env -f chain/compose/docker-compose.replica.yml
CONTROL_COMPOSE = $(REPLICA_COMPOSE) --project-name ledgera-control --profile control

.PHONY: chain-image replica-up replica-down replica-reset replica-compare control-up control-down control-compare

chain-image:
	bash chain/scripts/build-op-reth.sh

replica-up:
	bash chain/scripts/check-op-reth-image.sh op-reth-replica $(REPLICA_COMPOSE) --project-name ledgera-replica
	$(REPLICA_COMPOSE) --project-name ledgera-replica up -d --wait op-node-replica

replica-down:
	$(REPLICA_COMPOSE) --project-name ledgera-replica down

replica-reset:
	$(REPLICA_COMPOSE) --project-name ledgera-replica down --volumes

replica-compare:
	bash chain/scripts/compare-heads.sh

control-up: replica-up
	$(CONTROL_COMPOSE) up -d --wait op-node-control

control-down:
	$(CONTROL_COMPOSE) down --volumes

control-compare:
	bash chain/scripts/compare-deposit.sh "$(DEPOSIT_HASH)"

.PHONY: chain-deploy chain-up chain-down chain-logs chain-shell status fund-l1

chain-deploy:
	bash chain/scripts/deploy-l1.sh

chain-up:
	@running=$$($(CHAIN_COMPOSE) ps --status running --services) && \
		if printf '%s\n' "$$running" | rg -q '^op-node-[123]$$'; then \
			echo "Run make ha-down before starting the single sequencer" >&2; exit 1; \
		fi
	test -s chain/runtime/genesis.json
	test -s chain/runtime/rollup.json
	test -s chain/runtime/jwt.txt
	bash chain/scripts/check-op-reth-image.sh op-reth $(CHAIN_COMPOSE)
	$(CHAIN_COMPOSE) up -d --build --wait

.PHONY: ha-up ha-down ha-kill-leader ha-restore
ha-up:
	test -s chain/runtime/genesis.json
	test -s chain/runtime/rollup.json
	test -s chain/runtime/jwt.txt
	@running=$$($(CHAIN_COMPOSE) ps --status running --services) && \
		if printf '%s\n' "$$running" | rg -qx 'op-node'; then \
			echo "Run make chain-down before starting the sequencer cluster" >&2; exit 1; \
		fi
	bash chain/scripts/ha-peers.sh
	bash chain/scripts/check-op-reth-image.sh op-reth-1 $(HA_COMPOSE)
	$(HA_COMPOSE) up -d --build rpc-proxy op-conductor-1 op-conductor-2 op-conductor-3
	$(HA_CONTROL) init < chain/scripts/ha-control.mjs
	$(HA_COMPOSE) up -d --wait op-batcher
	rm -f chain/runtime/ha/stopped-sequencer

ha-down:
	$(HA_COMPOSE) down

ha-kill-leader:
	@test ! -e chain/runtime/ha/stopped-sequencer || { echo "Run make ha-restore first" >&2; exit 1; }
	@leader=$$($(HA_CONTROL) leader < chain/scripts/ha-control.mjs) && \
		case "$$leader" in 1|2|3) ;; *) exit 1 ;; esac && \
		printf '%s\n' "$$leader" > chain/runtime/ha/stopped-sequencer && \
		$(HA_COMPOSE) stop "op-node-$$leader" && \
		$(HA_COMPOSE) stop "op-reth-$$leader"

ha-restore:
	@leader=$$(cat chain/runtime/ha/stopped-sequencer) && \
		case "$$leader" in 1|2|3) ;; *) exit 1 ;; esac && \
		$(HA_COMPOSE) up -d "op-reth-$$leader" "op-node-$$leader" "op-conductor-$$leader" && \
		$(HA_CONTROL) restore "$$leader" < chain/scripts/ha-control.mjs && \
		rm chain/runtime/ha/stopped-sequencer

chain-down:
	$(CHAIN_COMPOSE) down

chain-logs:
	$(CHAIN_COMPOSE) logs --follow

chain-shell:
	$(CHAIN_COMPOSE) run --rm --no-deps chain-shell

status:
	$(CHAIN_COMPOSE) ps --all
	$(CHAIN_NODE) chain/scripts/status.ts

fund-l1:
	$(CHAIN_NODE) chain/scripts/fund-l1.ts

APP_MODE ?= devnet
APP_COMPOSE = bash chain/scripts/app-compose.sh $(APP_MODE)

.PHONY: app-up app-down app-logs audit demo-seed e2e

app-up:
	$(APP_COMPOSE) up -d --build --wait

app-down:
	$(APP_COMPOSE) down

app-logs:
	$(APP_COMPOSE) logs --follow

demo-seed:
	$(APP_COMPOSE) exec -T demo-tools node src/seed.ts

e2e: demo-seed
	LEDGERA_E2E=1 APP_MODE=$(APP_MODE) pnpm exec vitest run --no-file-parallelism e2e/scenes
	$(APP_COMPOSE) exec -T postgres psql -v ON_ERROR_STOP=1 -U ledgera -d ledgera < e2e/check-privacy.sql

audit:
	@pnpm --silent --filter @ledgera/auditor fifo --from 1 --json

ANVIL_COMPOSE = docker compose --env-file chain/versions.env -f docker-compose.anvil.yml

.PHONY: anvil-up anvil-down l2-bootstrap e2e-anvil-finalize

anvil-up:
	$(ANVIL_COMPOSE) up -d --build --wait
	BOOTSTRAP_MODE=anvil bash chain/scripts/bootstrap-l2.sh
	$(MAKE) app-up APP_MODE=anvil

e2e-anvil-finalize:
	$(ANVIL_COMPOSE) exec -T anvil cast rpc --rpc-url http://127.0.0.1:8545 anvil_mine 0x80 0x0

anvil-down:
	$(MAKE) app-down APP_MODE=anvil
	$(ANVIL_COMPOSE) down

l2-bootstrap:
	BOOTSTRAP_MODE=devnet bash chain/scripts/bootstrap-l2.sh

.PHONY: l2-bootstrap-ha
l2-bootstrap-ha:
	@leader=$$($(HA_CONTROL) leader < chain/scripts/ha-control.mjs) && \
		case "$$leader" in 1|2|3) ;; *) exit 1 ;; esac && \
		BOOTSTRAP_MODE=devnet BOOTSTRAP_SEQUENCER_RPC="http://op-reth-$$leader:8545" bash chain/scripts/bootstrap-l2.sh
